from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.duckdb_engine import DuckDbEngine
from app.models import QueryRequest, QueryResponse
from app.safety import ReadOnlyViolation, validate_read_only_sql


@asynccontextmanager
async def lifespan(_: FastAPI):
    _get_engine()
    yield


app = FastAPI(title="FileSQL Worker", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, object]:
    return _get_engine().health()


@app.post("/v1/query", response_model=QueryResponse)
def query(request: QueryRequest) -> QueryResponse:
    try:
        if request.read_only:
            validate_read_only_sql(request.sql)
        return _get_engine().run_query(request)
    except ReadOnlyViolation as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


def _get_engine() -> DuckDbEngine:
    engine = getattr(app.state, "engine", None)
    if engine is None:
        engine = DuckDbEngine()
        app.state.engine = engine
        print(f"FileSQL worker loaded extensions: {', '.join(engine.loaded_extensions)}")
    return engine
