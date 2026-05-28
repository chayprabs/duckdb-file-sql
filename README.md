# FileSQL

FileSQL runs DuckDB SQL on CSV, JSON, JSONL, Parquet, Arrow, and SQLite files with a browser-first flow and transparent worker fallback for larger jobs. The app is structured as a hybrid monorepo with a TypeScript core, a Vite/React web UI, and a FastAPI worker for native DuckDB execution.

## Workspace

- `packages/core`: shared engine contracts and browser/worker routing logic.
- `packages/web`: FileSQL playground UI.
- `apps/worker`: FastAPI worker with native DuckDB.

## Development

```bash
pnpm install
pnpm dev:web
```

Worker:

```bash
cd apps/worker
python -m venv .venv
. .venv/Scripts/activate
pip install -e .[dev]
uvicorn app.main:app --reload
```

## License

- Root repo and browser packages: MIT.
- `apps/worker`: AGPL-3.0-or-later.
