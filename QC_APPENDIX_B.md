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

### Qualification items still requiring fresh evidence

- Lighthouse >= 95.
- Browser 100 MB Parquet p95 <= 1 s.
- Worker 5 GB Parquet p95 <= 20 s.
- Full Section 7.4 format walk across every sample and remote URL scenario.
- Acceptance A2 three-file join correctness.
- Acceptance A3 > 1 GB escalation prompt evidence.
- Hosted URL, npm publish, ghcr image, and PR qualification evidence.

## Section 7 Tracking

### 7.2 Build & install

- [x] Standard checks green locally.
- [x] Bundle budget formally recorded against the 200 KB gz requirement.
- [ ] DuckDB-WASM lazy-load evidence captured in a reproducible report.

### 7.4 Functional - Format support

- [ ] CSV
- [ ] TSV
- [ ] JSON
- [ ] JSONL
- [ ] Parquet
- [ ] Arrow IPC
- [ ] SQLite
- [ ] Remote URL via `httpfs`

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
- [ ] Acceptance fixture evidence

## Notes

- This file is intentionally incremental. Each qualification pass should replace placeholders with exact command output, timings, screenshots, or route checks.
- Docker-specific verification remains separate from host-only issues per the handoff verification resilience policy.
