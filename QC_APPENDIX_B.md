# FileSQL QC Appendix B

Repo: `duckdb-file-sql`  
Branch: `cursor/file-sql-build`  
Purpose: working qualification ledger for `RELEASE_QUALIFICATION_CHECKLIST.md` Section 7.

## Current Evidence Snapshot

### Build and test

- `pnpm typecheck` - passing as of the latest qualification slice.
- `pnpm test` - passing for workspace packages.
- `pnpm build` - passing for workspace packages.
- `python -m pytest` in `apps/worker` - passing, including remote `httpfs` coverage.
- `pnpm qualify:section7` - passing local harness execution and writing `artifacts/section7-report.json`.
- Lighthouse report written to `artifacts/lighthouse.json`.
- Current gz bundle readings from the latest `pnpm build`:
  - `index-DLEtYb7m.js`: `67.25 kB`
  - `serialization-BaUKPmn5.js`: `43.44 kB`
  - `browser-session-VIhfQVgw.js`: `4.06 kB`
  - `duckdb-browser-C2_XuAsU.js`: `8.17 kB`
  - DuckDB-WASM `.wasm` files remain lazy split artifacts.

### Verified product behaviors

- Browser sample load and `SELECT COUNT(*)` on NYC taxi sample succeeds.
- Browser read-only enforcement blocks `DROP TABLE` and logs the failure.
- Browser result caps surface a truncation notice.
- Browser exports produce CSV, JSON, Parquet, and Arrow downloads.
- Share links round-trip SQL through the URL and reload into Monaco.
- Remote URL input routes through the worker and succeeds via the local `/api` proxy.
- Production-build SEO routes return `200` locally:
  - `/sql-on-csv/`
  - `/sql-on-parquet/`
  - `/sql-on-jsonl/`
  - `/sqlite-online-query/`
  - `/duckdb-online/`
- Hosted GitHub Pages evidence:
  - `https://chayprabs.github.io/duckdb-file-sql/` returns `200`.
  - HTTPS is enforced on the hosted web URL.
  - Hosted SEO routes confirmed `200`: `/sql-on-csv/`, `/sql-on-jsonl/`, `/sqlite-online-query/`.
- Hosted worker/API evidence:
  - Public worker tunnel health URL `https://47f35d758bd3a0.lhr.life/health` returns `200` with DuckDB extensions and retention metadata.
  - Public worker query `POST /v1/query` returns `SELECT 1 AS total_rows -> 1`.
  - Hosted Pages app successfully executed a remote CSV query against the public worker URL and returned `4` with the UI showing worker mode.
- Docker/local-run evidence:
  - `docker compose config` resolves the worker service with `apps/worker/Dockerfile`, port `8000`, and `FILESQL_RETENTION_MINUTES=10`.
  - `docker compose up -d worker` served `http://127.0.0.1:8000/health` with `{"status":"ok","extensions":["httpfs","sqlite_scanner","json"]}` before Docker Desktop returned a host-side API `500` during cleanup.
- GitHub repository topics now include the full Section 7 SEO/discovery set: `duckdb`, `sql`, `csv`, `parquet`, `jsonl`, `sqlite`, `arrow`, `sql-over-files`, `wasm`, `duckdb-wasm`, `data-analysis`, `sql-playground`, `csv-sql`, `parquet-sql`, `browser-sql`, `online-tool`.
- Section 7 local harness evidence from `artifacts/section7-report.json`:
  - Browser lazy-load: no DuckDB-WASM requests before first sample load; DuckDB-WASM assets requested after first sample load.
  - Browser-mode query network silence: no network requests fired while running the NYC taxi browser query after the sample was loaded.
  - Worker retention policy: health endpoint reports `retentionTtlSeconds = 600`.
  - Format counts: CSV `4`, JSONL `3`, JSON `3`, TSV `3`, Parquet `4`, Arrow `3`, SQLite `3`.
  - Remote worker URL count: `4` with worker badge present.
  - A1 NYC taxi `SELECT COUNT(*)`: `4` in `95 ms`.
  - A2 three-file join rows:
    - `east | 2 | 3`
    - `midwest | 1 | 1`
    - `west | 1 | 3`
  - A3 oversized file prompt: escalation banner and cancel button both visible.
- Lighthouse evidence from `artifacts/lighthouse.json` on the production build:
  - Performance `96`
  - Accessibility `100`
  - Best Practices `100`
  - SEO `100`
  - FCP `2.1 s`, LCP `2.3 s`, TTI `2.3 s`, TBT `70 ms`
- Latency harness evidence from `artifacts/latency-report.json`:
  - Browser benchmark fixture size: `106,950,155` bytes (`~102.0 MiB`)
  - Browser p95 over 5 runs: `425 ms`
  - Browser latency gate status: passing
  - Worker benchmark fixture size: `5,476,077,536` bytes (`~5.10 GiB`)
  - Worker p95 over 5 runs: `301 ms`
  - Worker latency gate status: passing

### Qualification items still requiring fresh evidence

- npm publish evidence for `@chayprabs/duckdb-file-sql`.
- ghcr image push evidence.
- Final PR qualification evidence.

## Section 7 Tracking

### 7.2 Build & install

- [x] Standard checks green locally.
- [x] Bundle budget formally recorded against the 200 KB gz requirement.
- [x] DuckDB-WASM lazy-load evidence captured in a reproducible report.

### 7.3 Local run

- [x] Browser mode works on first file drop.
- [x] Worker health endpoint returned `200` locally.
- [x] Worker DuckDB extensions loaded and reported on health/local run.

### 7.4 Functional - Format support

- [x] CSV
- [x] TSV
- [x] JSON
- [x] JSONL
- [x] Parquet
- [x] Arrow IPC
- [x] SQLite
- [x] Remote URL via `httpfs`

### 7.5 to 7.12 Functional/UI

- [x] Monaco editor + `Cmd`/`Ctrl` + `Enter`
- [x] Schema panel with sample values, rename, drop
- [x] Result sorting, paging, type badges, filter
- [x] EXPLAIN and EXPLAIN ANALYZE views
- [x] Read-only enforcement + truncation notice
- [x] Export downloads + share links
- [x] Local file inputs, sample picker, worker URL input, escalation prompt

### 7.13 onward

- [x] Latency gates
- [x] Browser 100 MB latency gate
- [x] Worker 5 GB latency gate
- [ ] Remaining privacy and security evidence
- [ ] Coverage and additional test evidence
- [ ] Deployment evidence
- [x] Hosted web URL + HTTPS evidence
- [x] Hosted worker API evidence
- [x] Docs and qualification ledger added in repo
- [x] SEO route 200 checks
- [x] Repo topics >= 10
- [x] Acceptance fixture evidence
- [x] Lighthouse >= 95
- [x] Browser network-silence evidence
- [x] Worker retention TTL evidence

### Additional test evidence

- `python -m pytest` now covers:
  - worker retention TTL cleanup of expired job artifacts
  - worker query logging without SQL body leakage
- `pnpm test` now covers:
  - DuckDB-WASM/browser smoke counts across the full sample pack via `packages/web/smoke.test.mjs`
  - normalized EXPLAIN snapshot coverage for the NYC taxi query plan
  - worker integration tests with real Parquet and remote `httpfs`

### 7.15 Testing

- [x] DuckDB-WASM smoke tests on each sample
- [x] Worker integration tests with real Parquet
- [x] EXPLAIN plan snapshot tests for known queries

### Release-state notes

- GitHub Pages is now serving the static web build from `gh-pages` at `https://chayprabs.github.io/duckdb-file-sql/`, and the repository homepage has been updated to that URL.
- The release workflow now includes GitHub Pages and GHCR publishing jobs, but GitHub Actions cannot dispatch it yet because `release.yml` exists only on `cursor/file-sql-build` and is not available on the default branch.
- The npm package metadata is now aligned to the required name `@chayprabs/duckdb-file-sql`, but the registry currently returns `404` and this machine is not authenticated to npm for publish.
- Local GHCR publication attempts are currently blocked by a Docker Desktop engine API `500` on `docker login ghcr.io`, so GHCR verification remains external-state dependent.

## Notes

- This file is intentionally incremental. Each qualification pass should replace placeholders with exact command output, timings, screenshots, or route checks.
- Docker-specific verification remains separate from host-only issues per the handoff verification resilience policy.
