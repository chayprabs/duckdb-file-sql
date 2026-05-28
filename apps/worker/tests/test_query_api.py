import json
import sqlite3

import duckdb
import pyarrow as pa
import pyarrow.ipc as pa_ipc
from fastapi.testclient import TestClient

from app.main import app


def test_healthcheck_reports_extensions() -> None:
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["extensions"] == ["httpfs", "sqlite_scanner", "json"]


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
