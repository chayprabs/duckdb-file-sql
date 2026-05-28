import functools
import http.server
import json
import logging
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import duckdb
import pyarrow as pa
import pyarrow.ipc as pa_ipc
from fastapi.testclient import TestClient

from app.duckdb_engine import DuckDbEngine
from app.main import app
from app.models import QueryRequest


def test_healthcheck_reports_extensions() -> None:
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["extensions"] == ["httpfs", "sqlite_scanner", "json"]
    assert response.json()["retentionTtlSeconds"] == 600


def test_query_supports_core_formats(tmp_path) -> None:
    csv_path = tmp_path / "people.csv"
    csv_path.write_text("id,name\n1,Ada\n2,Grace\n", encoding="utf-8")

    tsv_path = tmp_path / "people.tsv"
    tsv_path.write_text("id\tname\n1\tAda\n2\tGrace\n", encoding="utf-8")

    json_path = tmp_path / "people.json"
    json_path.write_text(json.dumps([{"id": 1, "name": "Ada"}, {"id": 2, "name": "Grace"}]), encoding="utf-8")

    jsonl_path = tmp_path / "people.jsonl"
    jsonl_path.write_text('{"id":1,"name":"Ada"}\n{"id":2,"name":"Grace"}\n', encoding="utf-8")

    parquet_path = tmp_path / "people.parquet"
    parquet_con = duckdb.connect()
    parquet_con.execute("CREATE TABLE people AS SELECT 1 AS id, 'Ada' AS name UNION ALL SELECT 2, 'Grace'")
    parquet_con.execute(f"COPY people TO '{parquet_path.as_posix()}' (FORMAT PARQUET)")

    arrow_path = tmp_path / "people.arrow"
    arrow_table = pa.table({"id": [1, 2], "name": ["Ada", "Grace"]})
    with pa_ipc.new_file(arrow_path, arrow_table.schema) as writer:
      writer.write_table(arrow_table)

    sqlite_path = tmp_path / "people.sqlite"
    with sqlite3.connect(sqlite_path) as sqlite_connection:
        sqlite_connection.execute("CREATE TABLE customers (id INTEGER, name TEXT)")
        sqlite_connection.executemany(
            "INSERT INTO customers VALUES (?, ?)",
            [(1, "Ada"), (2, "Grace")],
        )
        sqlite_connection.commit()

    request_body = {
        "sql": """
            SELECT
                (SELECT COUNT(*) FROM csv_people) AS csv_count,
                (SELECT COUNT(*) FROM tsv_people) AS tsv_count,
                (SELECT COUNT(*) FROM json_people) AS json_count,
                (SELECT COUNT(*) FROM jsonl_people) AS jsonl_count,
                (SELECT COUNT(*) FROM parquet_people) AS parquet_count,
                (SELECT COUNT(*) FROM arrow_people) AS arrow_count,
                (SELECT COUNT(*) FROM customers) AS sqlite_count
        """,
        "tables": [
            {"name": "csv_people", "source": csv_path.as_posix(), "kind": "csv"},
            {"name": "tsv_people", "source": tsv_path.as_posix(), "kind": "tsv"},
            {"name": "json_people", "source": json_path.as_posix(), "kind": "json"},
            {"name": "jsonl_people", "source": jsonl_path.as_posix(), "kind": "jsonl"},
            {"name": "parquet_people", "source": parquet_path.as_posix(), "kind": "parquet"},
            {"name": "arrow_people", "source": arrow_path.as_posix(), "kind": "arrow"},
            {"source": sqlite_path.as_posix(), "kind": "sqlite"},
        ],
    }

    with TestClient(app) as client:
        response = client.post("/v1/query", json=request_body)

    assert response.status_code == 200
    assert response.json()["rows"] == [[2, 2, 2, 2, 2, 2, 2]]


def test_query_rejects_mutating_sql() -> None:
    with TestClient(app) as client:
        response = client.post("/v1/query", json={"sql": "DROP TABLE anything"})

    assert response.status_code == 403
    assert "not allowed" in response.json()["detail"]


def test_query_allows_create_temp_view() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/query",
            json={
                "sql": "CREATE TEMP VIEW demo AS SELECT 1 AS id; SELECT COUNT(*) AS total FROM demo",
            },
        )

    assert response.status_code == 200
    assert response.json()["rows"] == [[1]]


def test_query_supports_remote_httpfs_sources(tmp_path) -> None:
    csv_path = tmp_path / "remote.csv"
    csv_path.write_text("id,name\n1,Ada\n2,Grace\n", encoding="utf-8")

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp_path.as_posix())
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        remote_url = f"http://127.0.0.1:{server.server_port}/remote.csv"

        with TestClient(app) as client:
            response = client.post(
                "/v1/query",
                json={
                    "sql": "SELECT COUNT(*) AS total_rows FROM remote_csv",
                    "tables": [{"name": "remote_csv", "source": remote_url, "kind": "csv"}],
                },
            )

        server.shutdown()
        thread.join(timeout=5)

    assert response.status_code == 200
    assert response.json()["rows"] == [[2]]


def test_worker_retention_ttl_cleans_expired_artifacts(tmp_path) -> None:
    storage_root = tmp_path / "artifacts"
    engine = DuckDbEngine(storage_root=storage_root, retention_ttl_seconds=1)

    response = engine.run_query(QueryRequest(sql="SELECT 1 AS total_rows"))
    artifact_dir = storage_root / response.jobId

    assert artifact_dir.exists()

    metadata_path = artifact_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["expiresAt"] = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    removed = engine.cleanup_expired_artifacts()

    assert removed == 1
    assert not artifact_dir.exists()


def test_worker_logs_query_metadata_without_sql_body(tmp_path, caplog) -> None:
    logger = logging.getLogger("filesql.worker.test")
    engine = DuckDbEngine(storage_root=tmp_path / "artifacts", retention_ttl_seconds=600, logger=logger)

    with caplog.at_level(logging.INFO, logger=logger.name):
        response = engine.run_query(QueryRequest(sql="SELECT 42 AS answer"))

    joined_logs = "\n".join(record.getMessage() for record in caplog.records)

    assert response.jobId in joined_logs
    assert "Query completed" in joined_logs
    assert "SELECT 42 AS answer" not in joined_logs


def test_worker_accepts_retention_minutes_env(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("FILESQL_RETENTION_TTL_SECONDS", raising=False)
    monkeypatch.setenv("FILESQL_RETENTION_MINUTES", "12")

    engine = DuckDbEngine(storage_root=tmp_path / "artifacts")

    assert engine.retention_ttl_seconds == 720
