# FileSQL QC Appendix B

Repo: `duckdb-file-sql`  
Branch: `main`  
Purpose: working qualification ledger for `RELEASE_QUALIFICATION_CHECKLIST.md` Section 7.

## Current Evidence Snapshot

### Build and test

- `pnpm typecheck` - passing as of the latest qualification slice.
- `pnpm test` - passing for workspace packages.
- `pnpm build` - passing for workspace packages.
- `python -m pytest` in `apps/worker` - passing, including remote `httpfs` coverage.
- Main-branch CI is green on current commits:
  - `26606693263` for `ac79cee test(web): stabilize smoke service startup`
  - `26606937351` for `4dac375 feat(web): polish the first-run FileSQL interface`
  - `26607419253` for `3e7f545 fix(release): avoid secret checks in workflow expressions`
  - `26607641818` for `e4e9d54 test(worker): harden log redaction coverage`
  - `26607707854` for `be9ae36 chore(security): add security baseline artifacts`
  - `26609922492` for `522c0f0 fix(ci): disable premature pnpm cache setup`
  - `26610008157` for `ef9077e docs(qc): record workflow runtime evidence`
  - `26610232867` for `ae0ac14 ci(actions): align workflow actions with green dependency bumps`
  - `26610387668` for `8cf8586 ci(actions): upgrade docker workflow runtimes`
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
  - Hosted `/.well-known/security.txt` returns `200` with `Contact`, `Expires`, `Canonical`, `Policy`, and `Preferred-Languages`.
  - `Release` workflow run `26607031972` rebuilt and redeployed Pages from `main`.
- UI polish on `main` now tightens first-run guidance:
  - Hero explicitly states local-first execution, read-only SQL, and supported formats.
  - Hero now includes direct onboarding actions plus a session summary and recommended next step.
  - Empty-state guidance now tells the user exactly how to start: load a file or sample, then run the query.
  - Panel hierarchy is shorter and more direct: `1. Add data`, `2. Query`, `3. Results`.
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
  - Local `/.well-known/security.txt` returned `200` with `Contact`, `Policy`, and `Canonical` fields present.
  - Format counts: CSV `4`, JSONL `3`, JSON `3`, TSV `3`, Parquet `4`, Arrow `3`, SQLite `3`.
  - Remote worker URL count: `4` with worker badge present.
  - A1 NYC taxi `SELECT COUNT(*)`: `4` in `136 ms`.
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
- GHCR evidence:
  - `Worker Image` workflow run `26605723557` completed successfully on `main`-aligned workflow configuration.
  - `Release` workflow run `26607031972` also completed a successful `worker-image` publish job on `main`.
  - `Worker Image` workflow run `26610387663` completed successfully after upgrading the Docker marketplace actions to Node 24-capable majors.
- npm package release readiness:
  - `packages/core` now has a package-local `README.md`, repository metadata, and a `publish-core` job in `.github/workflows/release.yml`.
  - `npm pack --dry-run` in `packages/core` produced `chayprabs-duckdb-file-sql-0.1.0.tgz` with the expected README, declarations, source files, and package metadata.
  - `Release` workflow run `26607446202` completed successfully with `publish-core`, `pages`, `deploy-pages`, and `worker-image`.
  - `publish-core` logged `NPM_TOKEN is not configured; skipping npm publish.` and still completed successfully, so the remaining npm gap is credential + live publish evidence rather than workflow configuration.
- PRD-aligned worker deployment config:
  - `apps/worker/fly.toml` is now checked in for the Fly.io worker target, with `internal_port = 8000`, `/health` checks, HTTPS, zero-idle-machine autostart/autostop, `FILESQL_RETENTION_MINUTES = 10`, and an `8gb` shared VM profile.
  - `flyctl.exe v0.4.57` is now present on this Windows machine, but `flyctl auth whoami` still reports no access token, so the remaining Fly deployment gap is auth/provider state rather than missing tooling.
- Security baseline artifacts:
  - `packages/web/public/.well-known/security.txt` is now checked in for the hosted site.
  - `.github/dependabot.yml` now covers npm, pip, Docker, and GitHub Actions.
  - `.github/workflows/codeql.yml` now scans `javascript-typescript` and `python` on `main`, PRs, and a weekly schedule.
  - `CodeQL` workflow run `26607707851` completed successfully for both `javascript-typescript` and `python`.
  - `CodeQL` workflow run `26609922455` completed successfully after the GitHub Actions runtime upgrade follow-up.
  - `CodeQL` workflow run `26610008138` completed successfully for the qualification-evidence refresh commit.
  - `CodeQL` workflow run `26610232846` completed successfully after aligning workflow actions with the green Dependabot bumps.
  - `CodeQL` workflow run `26610387651` completed successfully after upgrading the remaining Docker marketplace actions.
  - Current GitHub Actions Node 20 deprecation annotations are cleared from the worker-image path after upgrading `docker/build-push-action` to `v7`, `docker/metadata-action` to `v6`, and `docker/setup-buildx-action` to `v4`.

### Qualification items still requiring fresh evidence

- npm publish evidence for `@chayprabs/duckdb-file-sql`.
- Durable hosted worker/public production-domain evidence beyond the current tunnel-based proof.
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
- [x] Remaining privacy and security evidence
- [x] Coverage and additional test evidence
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
- [x] Worker logs redact SQL bodies and source locations
- [x] Hosted security.txt artifact checked in

### Additional test evidence

- `python -m pytest` now covers:
  - worker retention TTL cleanup of expired job artifacts
  - worker query logging without SQL body leakage
  - worker success/failure logging with source-kind summaries only, excluding SQL text, filenames, table aliases, and remote URLs
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
- Root `render.yaml` is now checked in for a reproducible Render Blueprint deployment of the public FastAPI worker from `apps/worker`.
- `apps/worker/fly.toml` is now checked in for a PRD-aligned Fly.io deployment path for the worker.
- README screenshots are now checked in at `docs/screenshots/filesql-home.png` and `docs/screenshots/filesql-results.png`.
- The release workflow now exists on `main` and includes GitHub Pages and GHCR publishing jobs via `workflow_dispatch`.
- `Release` workflow run `26607031972` succeeded end-to-end on `main`:
  - `pages` job succeeded
  - `deploy-pages` job succeeded
  - `worker-image` job succeeded
- `Release` workflow run `26607446202` also succeeded end-to-end after the npm publish job was added:
  - `publish-core` job succeeded and skipped publish cleanly when `NPM_TOKEN` was absent
  - `pages` job succeeded
  - `deploy-pages` job succeeded
  - `worker-image` job succeeded
- `Release` workflow run `26607942192` also succeeded end-to-end on the latest `main` state:
  - `publish-core` job succeeded and skipped publish cleanly when `NPM_TOKEN` was absent
  - `pages` job succeeded
  - `deploy-pages` job succeeded
  - `worker-image` job succeeded
- The npm package metadata is now aligned to the required name `@chayprabs/duckdb-file-sql`, but the registry currently returns `404` and this machine is not authenticated to npm for publish.
- The release workflow now includes a `publish-core` job that publishes `@chayprabs/duckdb-file-sql` when `NPM_TOKEN` is configured, and otherwise skips cleanly.
- Local GHCR publication attempts are currently blocked by a Docker Desktop engine API `500` on `docker login ghcr.io`, so GHCR verification remains external-state dependent.

## Notes

- This file is intentionally incremental. Each qualification pass should replace placeholders with exact command output, timings, screenshots, or route checks.
- Docker-specific verification remains separate from host-only issues per the handoff verification resilience policy.
