import sqlite3
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

import duckdb
import pyarrow.ipc as pa_ipc
from sqlglot import expressions as exp
from sqlglot import parse

from app.models import QueryColumn, QueryRequest, QueryResponse, TableSource


DUCKDB_EXTENSIONS = ("httpfs", "sqlite_scanner", "json")


class DuckDbEngine:
    def __init__(self) -> None:
        self.loaded_extensions = self._load_extensions()

    def health(self) -> dict[str, object]:
        return {"status": "ok", "extensions": self.loaded_extensions}

    def run_query(self, request: QueryRequest) -> QueryResponse:
        connection = duckdb.connect()
        self._prepare_connection(connection)
        cleanup_paths: list[Path] = []
        try:
            registered_tables, cleanup_paths = self._register_sources(connection, request.tables)
            executable_sql = self._prepare_sql(connection, request)

            started = time.perf_counter()
            result = connection.execute(executable_sql)
            rows = result.fetchall()
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            columns = [QueryColumn(name=column[0], type=str(column[1])) for column in result.description]

            visible_rows = rows[: request.page_size]
            row_count = len(visible_rows)

            return QueryResponse(
                jobId=str(uuid.uuid4()),
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
        finally:
            connection.close()
            for cleanup_path in cleanup_paths:
                try:
                    cleanup_path.unlink(missing_ok=True)
                except PermissionError:
                    pass

    def _prepare_connection(self, connection: duckdb.DuckDBPyConnection) -> None:
        for extension in DUCKDB_EXTENSIONS:
            connection.execute(f"LOAD {extension}")

    def _register_sources(
        self, connection: duckdb.DuckDBPyConnection, sources: list[TableSource]
    ) -> tuple[list[str], list[Path]]:
        registered: list[str] = []
        cleanup_paths: list[Path] = []
        for source in sources:
            if source.kind == "sqlite":
                sqlite_tables, sqlite_cleanup = self._register_sqlite_database(connection, source)
                registered.extend(sqlite_tables)
                if sqlite_cleanup is not None:
                    cleanup_paths.append(sqlite_cleanup)
                continue

            table_name = _normalize_identifier(source.name or Path(urlparse(source.source).path).stem or source.kind)
            if source.kind == "arrow":
                self._register_arrow_file(connection, table_name, source.source)
            else:
                self._register_tabular_file(connection, table_name, source)
            registered.append(table_name)
        return registered, cleanup_paths

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
        self, connection: duckdb.DuckDBPyConnection, source: TableSource
    ) -> tuple[list[str], Path | None]:
        table_names: list[str] = []
        sqlite_path, cleanup_path = self._materialize_sqlite_source(source.source)
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
        return table_names, cleanup_path

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

    def _materialize_sqlite_source(self, source: str) -> tuple[str, Path | None]:
        parsed = urlparse(source)
        if parsed.scheme not in {"http", "https"}:
          return source, None

        with urlopen(source) as response:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".sqlite") as temp_file:
                temp_file.write(response.read())
                return temp_file.name, Path(temp_file.name)


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
