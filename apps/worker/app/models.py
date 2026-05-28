from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


FileKind = Literal["csv", "tsv", "json", "jsonl", "parquet", "arrow", "sqlite"]


class TableSource(BaseModel):
    name: str | None = None
    source: str
    kind: FileKind


class QueryRequest(BaseModel):
    sql: str
    tables: list[TableSource] = Field(default_factory=list)
    page: int = 0
    page_size: int = Field(default=500, ge=1, le=5_000)
    read_only: bool = True


class QueryColumn(BaseModel):
    name: str
    type: str


class QueryResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    jobId: str
    columns: list[QueryColumn] = Field(alias="schema", serialization_alias="schema")
    rows: list[list[object]]
    truncated: bool
    rowsScanned: int
    bytesScanned: int
    durationMs: float
    ranOn: Literal["worker"] = "worker"
    page: int
    pageSize: int
    tables: list[str]
