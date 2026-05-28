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
- Current gz bundle readings from the latest `pnpm build`:
  - `index-fHJpapCH.js`: `66.98 kB`
  - `serialization-BaUKPmn5.js`: `43.44 kB`
  - `browser-session-DydVubPC.js`: `3.96 kB`
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
- Section 7 local harness evidence from `artifacts/section7-report.json`:
  - Browser lazy-load: no DuckDB-WASM requests before first sample load; DuckDB-WASM assets requested after first sample load.
  - Format counts: CSV `4`, JSONL `3`, JSON `3`, TSV `3`, Parquet `4`, Arrow `3`, SQLite `3`.
  - Remote worker URL count: `4` with worker badge present.
  - A1 NYC taxi `SELECT COUNT(*)`: `4` in `205 ms`.
  - A2 three-file join rows:
    - `east | 2 | 3`
    - `midwest | 1 | 1`
    - `west | 1 | 3`
  - A3 oversized file prompt: escalation banner and cancel button both visible.

### Qualification items still requiring fresh evidence

- Lighthouse >= 95.
- Browser 100 MB Parquet p95 <= 1 s.
- Worker 5 GB Parquet p95 <= 20 s.
- Privacy evidence for browser query network silence beyond DuckDB-WASM bootstrap.
- Hosted URL, npm publish, ghcr image, and PR qualification evidence.

## Section 7 Tracking

### 7.2 Build & install

- [x] Standard checks green locally.
- [x] Bundle budget formally recorded against the 200 KB gz requirement.
- [x] DuckDB-WASM lazy-load evidence captured in a reproducible report.

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

- [ ] Lighthouse and latency gates
- [ ] Privacy and security evidence
- [ ] Coverage and additional test evidence
- [ ] Deployment evidence
- [x] Docs and qualification ledger added in repo
- [x] SEO route 200 checks
- [x] Acceptance fixture evidence

## Notes

- This file is intentionally incremental. Each qualification pass should replace placeholders with exact command output, timings, screenshots, or route checks.
- Docker-specific verification remains separate from host-only issues per the handoff verification resilience policy.
