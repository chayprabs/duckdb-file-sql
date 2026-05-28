import json
import logging
import os
import shutil
import sqlite3
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

import duckdb
import pyarrow.ipc as pa_ipc
from sqlglot import expressions as exp
from sqlglot import parse

from app.models import QueryColumn, QueryRequest, QueryResponse, TableSource


DUCKDB_EXTENSIONS = ("httpfs", "sqlite_scanner", "json")
DEFAULT_RETENTION_TTL_SECONDS = 600
DEFAULT_STORAGE_DIR = Path(tempfile.gettempdir()) / "filesql-worker"


class DuckDbEngine:
    def __init__(
        self,
        storage_root: Path | None = None,
        retention_ttl_seconds: int | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.logger = logger or logging.getLogger("filesql.worker")
        self.storage_root = Path(storage_root or os.environ.get("FILESQL_WORKER_STORAGE_DIR", DEFAULT_STORAGE_DIR))
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self.retention_ttl_seconds = retention_ttl_seconds or int(
            os.environ.get("FILESQL_RETENTION_TTL_SECONDS", DEFAULT_RETENTION_TTL_SECONDS)
        )
        self.loaded_extensions = self._load_extensions()

    def health(self) -> dict[str, object]:
        self.cleanup_expired_artifacts()
        return {
            "status": "ok",
            "extensions": self.loaded_extensions,
            "retentionTtlSeconds": self.retention_ttl_seconds,
            "activeArtifacts": self._count_active_artifacts(),
        }

    def run_query(self, request: QueryRequest) -> QueryResponse:
        self.cleanup_expired_artifacts()
        connection = duckdb.connect()
        self._prepare_connection(connection)
        job_id = str(uuid.uuid4())
        job_dir = self.storage_root / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        self._write_job_metadata(job_dir, job_id, len(request.tables))
        try:
            registered_tables = self._register_sources(connection, request.tables, job_dir)
            executable_sql = self._prepare_sql(connection, request)

            started = time.perf_counter()
            result = connection.execute(executable_sql)
            rows = result.fetchall()
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            columns = [QueryColumn(name=column[0], type=str(column[1])) for column in result.description]

            visible_rows = rows[: request.page_size]
            row_count = len(visible_rows)
            self.logger.info(
                "Query completed job_id=%s table_count=%s duration_ms=%s truncated=%s rows_returned=%s",
                job_id,
                len(registered_tables),
                elapsed_ms,
                len(rows) > request.page_size,
                row_count,
            )

            return QueryResponse(
                jobId=job_id,
                columns=columns,
                rows=[list(row) for row in visible_rows],
                truncated=len(rows) > request.page_size,
                rowsScanned=row_count,
                bytesScanned=sum(len(str(row)) for row in visible_rows),
                durationMs=elapsed_ms,
                page=request.page,
                pageSize=request.page_size,
                tables=registered_tables,
            )
        except Exception:
            self.logger.exception(
                "Query failed job_id=%s table_count=%s read_only=%s",
                job_id,
                len(request.tables),
                request.read_only,
            )
            raise
        finally:
            connection.close()

    def _prepare_connection(self, connection: duckdb.DuckDBPyConnection) -> None:
        for extension in DUCKDB_EXTENSIONS:
            connection.execute(f"LOAD {extension}")

    def _register_sources(
        self, connection: duckdb.DuckDBPyConnection, sources: list[TableSource], job_dir: Path
    ) -> list[str]:
        registered: list[str] = []
        for source in sources:
            if source.kind == "sqlite":
                sqlite_tables = self._register_sqlite_database(connection, source, job_dir)
                registered.extend(sqlite_tables)
                continue

            table_name = _normalize_identifier(source.name or Path(urlparse(source.source).path).stem or source.kind)
            if source.kind == "arrow":
                self._register_arrow_file(connection, table_name, source.source)
            else:
                self._register_tabular_file(connection, table_name, source)
            registered.append(table_name)
        return registered

    def _register_tabular_file(
        self, connection: duckdb.DuckDBPyConnection, table_name: str, source: TableSource
    ) -> None:
        reader_sql = {
            "csv": f"read_csv_auto({_sql_string_literal(source.source)}, sample_size=-1)",
            "tsv": f"read_csv_auto({_sql_string_literal(source.source)}, delim='\t', sample_size=-1)",
            "json": f"read_json_auto({_sql_string_literal(source.source)})",
            "jsonl": f"read_json_auto({_sql_string_literal(source.source)})",
            "parquet": f"read_parquet({_sql_string_literal(source.source)})",
        }[source.kind]

        connection.execute(f"CREATE OR REPLACE TEMP VIEW {table_name} AS SELECT * FROM {reader_sql}")

    def _register_arrow_file(self, connection: duckdb.DuckDBPyConnection, table_name: str, source: str) -> None:
        with pa_ipc.open_file(source) as reader:
            connection.register(table_name, reader.read_all())

    def _register_sqlite_database(
        self, connection: duckdb.DuckDBPyConnection, source: TableSource, job_dir: Path
    ) -> list[str]:
        table_names: list[str] = []
        sqlite_path = self._materialize_sqlite_source(source.source, job_dir)
        with sqlite3.connect(sqlite_path) as sqlite_connection:
            cursor = sqlite_connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
            for row in cursor.fetchall():
                sqlite_table = row[0]
                view_name = _normalize_identifier(sqlite_table)
                connection.execute(
                    " ".join(
                        [
                            f"CREATE OR REPLACE TEMP VIEW {view_name} AS",
                            "SELECT * FROM sqlite_scan(",
                            f"{_sql_string_literal(sqlite_path)},",
                            f"{_sql_string_literal(sqlite_table)})",
                        ]
                    )
                )
                table_names.append(view_name)
        return table_names

    def _prepare_sql(self, connection: duckdb.DuckDBPyConnection, request: QueryRequest) -> str:
        statements = parse(request.sql, read="duckdb")
        if not statements:
            raise duckdb.InvalidInputException("Query must contain at least one statement.")

        for statement in statements[:-1]:
            connection.execute(statement.sql(dialect="duckdb"))

        final_statement = statements[-1]
        final_sql = final_statement.sql(dialect="duckdb")
        if _is_pageable_statement(final_statement):
            offset = request.page * request.page_size
            return f"""
                SELECT *
                FROM ({final_sql}) AS __filesql_query
                LIMIT {request.page_size + 1}
                OFFSET {offset}
            """

        return final_sql

    def _load_extensions(self) -> list[str]:
        connection = duckdb.connect()
        loaded: list[str] = []
        for extension in DUCKDB_EXTENSIONS:
            connection.execute(f"INSTALL {extension}")
            connection.execute(f"LOAD {extension}")
            loaded.append(extension)
        return loaded

    def _materialize_sqlite_source(self, source: str, job_dir: Path) -> str:
        parsed = urlparse(source)
        if parsed.scheme not in {"http", "https"}:
            return source

        with urlopen(source) as response:
            target_name = Path(parsed.path).name or "remote.sqlite"
            target_path = job_dir / target_name
            target_path.write_bytes(response.read())
            return target_path.as_posix()

    def cleanup_expired_artifacts(self, now: datetime | None = None) -> int:
        current_time = now or datetime.now(timezone.utc)
        removed = 0
        for artifact_dir in self.storage_root.iterdir():
            if not artifact_dir.is_dir():
                continue
            if self._artifact_expired(artifact_dir, current_time):
                shutil.rmtree(artifact_dir, ignore_errors=True)
                removed += 1
        return removed

    def _artifact_expired(self, artifact_dir: Path, current_time: datetime) -> bool:
        metadata_path = artifact_dir / "metadata.json"
        if metadata_path.exists():
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                expires_at = metadata.get("expiresAt")
                if expires_at:
                    return current_time >= datetime.fromisoformat(expires_at)
            except (OSError, ValueError, json.JSONDecodeError):
                pass

        modified_at = datetime.fromtimestamp(artifact_dir.stat().st_mtime, tz=timezone.utc)
        return current_time >= modified_at + timedelta(seconds=self.retention_ttl_seconds)

    def _write_job_metadata(self, job_dir: Path, job_id: str, table_count: int) -> None:
        created_at = datetime.now(timezone.utc)
        expires_at = created_at + timedelta(seconds=self.retention_ttl_seconds)
        metadata = {
            "jobId": job_id,
            "createdAt": created_at.isoformat(),
            "expiresAt": expires_at.isoformat(),
            "tableCount": table_count,
        }
        (job_dir / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    def _count_active_artifacts(self) -> int:
        return sum(1 for child in self.storage_root.iterdir() if child.is_dir())


def _normalize_identifier(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char == "_" else "_" for char in value.lower()).strip("_")
    if not cleaned:
        cleaned = "table"
    if cleaned[0].isdigit():
        cleaned = f"t_{cleaned}"
    return cleaned


def _sql_string_literal(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _is_pageable_statement(statement: exp.Expression) -> bool:
    return isinstance(statement, (exp.Select, exp.Union, exp.Intersect, exp.Except, exp.Subquery))
