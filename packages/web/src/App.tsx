import { useEffect, useRef, useState } from "react";
import {
  BROWSER_FILE_BUDGET_BYTES,
  type BrowserColumn,
  chooseExecutionModeForFiles,
  createBrowserSession,
  type BrowserExplainResult,
  createShareUrl,
  deriveTableName,
  detectFileKind,
  type ExportFormat,
  FILESQL_DIALECT,
  type BrowserQueryResult,
  type BrowserSession,
  type BrowserTableInfo,
  type FileDescriptor,
  parseShareState,
  type SupportedFileKind,
} from "@filesql/core";
import "./App.css";
import { SqlEditor } from "./components/SqlEditor";

type SampleManifestItem = {
  id: string;
  label: string;
  path: string;
  kind: SupportedFileKind;
  description: string;
};

const budgetInGb = `${Math.round(BROWSER_FILE_BUDGET_BYTES / 1024 / 1024 / 1024)} GB`;
const defaultQuery = `SELECT COUNT(*) AS total_rows\nFROM nyc_taxi_sample;`;
const RESULT_PAGE_SIZE = 25;
const workerBaseUrl = import.meta.env.VITE_FILESQL_WORKER_URL ?? "/api";

type RemoteTableSource = {
  kind: SupportedFileKind;
  name: string;
  source: string;
};

type WorkerQueryResponse = {
  durationMs: number;
  page: number;
  pageSize: number;
  ranOn: "worker";
  rows: unknown[][];
  schema: BrowserColumn[];
  tables: string[];
  truncated: boolean;
};

type AppQueryResult = {
  durationMs: number;
  pageSize?: number;
  ranOn: "browser" | "worker";
  rowCount: number;
  rows: unknown[][];
  schema: BrowserColumn[];
  tableNames: string[];
  truncated: boolean;
  truncationReason: string | null;
};

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionRef = useRef<BrowserSession | null>(null);
  const sessionPromiseRef = useRef<Promise<BrowserSession> | null>(null);

  const [samples, setSamples] = useState<SampleManifestItem[]>([]);
  const [query, setQuery] = useState(defaultQuery);
  const [tables, setTables] = useState<BrowserTableInfo[]>([]);
  const [remoteSources, setRemoteSources] = useState<RemoteTableSource[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteKind, setRemoteKind] = useState<SupportedFileKind>("parquet");
  const [result, setResult] = useState<AppQueryResult | null>(null);
  const [plan, setPlan] = useState<BrowserExplainResult | null>(null);
  const [engineVersion, setEngineVersion] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [engineMode, setEngineMode] = useState<"browser" | "worker">("browser");
  const [status, setStatus] = useState("Load a sample or local file to start querying.");
  const [error, setError] = useState<string | null>(null);
  const [showEscalationPrompt, setShowEscalationPrompt] = useState(false);
  const [schemaCollapsed, setSchemaCollapsed] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [page, setPage] = useState(0);
  const [sortState, setSortState] = useState<{ columnIndex: number; direction: "asc" | "desc" } | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<"result" | "plan" | "logs">("result");
  const [runLog, setRunLog] = useState<string[]>([]);

  useEffect(() => {
    let ignore = false;
    const sharedState = parseShareState(window.location.search);
    if (sharedState.sql) {
      setQuery(sharedState.sql);
      setStatus(
        sharedState.dialect === FILESQL_DIALECT
          ? "Loaded SQL from a shared FileSQL link."
          : "Loaded SQL from the current URL.",
      );
    }

    void fetch("/samples/manifest.json")
      .then((response) => response.json() as Promise<SampleManifestItem[]>)
      .then((payload) => {
        if (!ignore) {
          setSamples(payload);
        }
      })
      .catch(() => {
        if (!ignore) {
          setError("Unable to load the sample manifest.");
        }
      });

    return () => {
      ignore = true;
      void sessionRef.current?.close();
    };
  }, []);

  async function ensureBrowserSession() {
    if (sessionRef.current) {
      return sessionRef.current;
    }

    if (!sessionPromiseRef.current) {
      sessionPromiseRef.current = createBrowserSession().then(async (session) => {
        sessionRef.current = session;
        setEngineVersion(await session.getVersion());
        return session;
      });
    }

    return sessionPromiseRef.current;
  }

  async function handleSampleLoad(sample: SampleManifestItem) {
    await runBusyTask(async () => {
      const response = await fetch(sample.path);
      if (!response.ok) {
        throw new Error(`Unable to fetch ${sample.label}.`);
      }

      const blob = await response.blob();
      const fileName = sample.path.split("/").pop() ?? `${sample.id}.${sample.kind}`;
      const file = new File([blob], fileName);

      const loadedTables = await registerBrowserFiles([file]);
      setStatus(`Loaded ${sample.label} in the browser.`);
      setRunLog((current) => [
        `Loaded sample ${sample.label} in browser mode.`,
        ...current,
      ].slice(0, 10));
      setQuery(defaultQueryForTable(loadedTables[0]?.name ?? tablesFromFileName(fileName)));
    });
  }

  async function handleFileSelection(files: FileList | null) {
    if (!files?.length) {
      return;
    }

    const selectedFiles = Array.from(files);
    const descriptors = selectedFiles
      .map<FileDescriptor | null>((file, index) => {
        const kind = detectFileKind(file.name);
        if (!kind) {
          return null;
        }

        return {
          id: `${index}-${file.name}`,
          name: file.name,
          bytes: file.size,
          kind,
        };
      })
      .filter((file): file is FileDescriptor => Boolean(file));

    if (descriptors.length !== selectedFiles.length) {
      setError("One or more selected files use an unsupported extension.");
      return;
    }

    const routeDecision = chooseExecutionModeForFiles(descriptors);
    setEngineMode(routeDecision.mode);
    setStatus(routeDecision.reason);

    if (routeDecision.mode === "worker") {
      setShowEscalationPrompt(true);
      return;
    }

    await runBusyTask(async () => {
      const loadedTables = await registerBrowserFiles(selectedFiles);
      setStatus(`Loaded ${selectedFiles.length} file${selectedFiles.length > 1 ? "s" : ""} locally.`);
      setRunLog((current) => [
        `Loaded ${selectedFiles.length} local file${selectedFiles.length > 1 ? "s" : ""} in browser mode.`,
        ...current,
      ].slice(0, 10));
      const firstTable = loadedTables[0]?.name ?? tablesFromFileName(selectedFiles[0].name);
      setQuery(defaultQueryForTable(firstTable));
    });
  }

  async function registerBrowserFiles(files: File[]) {
    const session = await ensureBrowserSession();
    const loadedTables = (await Promise.all(files.map((file) => session.loadFile(file)))).flat();
    setTables(await session.listTables());
    if (loadedTables[0]) {
      setResult(null);
      setPlan(null);
      setActiveTab("result");
    }
    return loadedTables;
  }

  async function handleRunQuery() {
    await runBusyTask(async () => {
      const queryResult =
        engineMode === "worker" && remoteSources.length
          ? await runWorkerQuery(query, remoteSources)
          : await (await ensureBrowserSession()).query(query);
      setResult(queryResult);
      setPlan(null);
      setActiveTab("result");
      setFilterText("");
      setPage(0);
      setSortState(null);
      setStatus(
        `Executed in ${queryResult.ranOn} mode with ${queryResult.rowCount} row${queryResult.rowCount === 1 ? "" : "s"} returned.`,
      );
      setRunLog((current) => [
        `Executed query against ${queryResult.tableNames.join(", ") || "current session"} in ${queryResult.durationMs} ms on ${queryResult.ranOn}.`,
        ...current,
      ].slice(0, 10));
      const truncationReason = queryResult.truncationReason;
      if (queryResult.truncated && truncationReason) {
        setRunLog((current) => [truncationReason, ...current].slice(0, 10));
      }
      if (queryResult.ranOn === "browser") {
        const session = await ensureBrowserSession();
        setTables(await session.listTables());
      }
    });
  }

  async function handleExplain(analyze: boolean) {
    await runBusyTask(async () => {
      const session = await ensureBrowserSession();
      const explainResult = await session.explain(query, analyze);
      setPlan(explainResult);
      setActiveTab("plan");
      setStatus(`${analyze ? "EXPLAIN ANALYZE" : "EXPLAIN"} completed in ${explainResult.durationMs} ms.`);
      setRunLog((current) => [
        `Ran ${analyze ? "EXPLAIN ANALYZE" : "EXPLAIN"} in ${explainResult.durationMs} ms.`,
        ...current,
      ].slice(0, 10));
    });
  }

  async function handleRenameTable(tableName: string) {
    const nextName = window.prompt("Rename table", tableName)?.trim();
    if (!nextName || nextName === tableName) {
      return;
    }

    await runBusyTask(async () => {
      const session = await ensureBrowserSession();
      const updatedTable = await session.renameTable(tableName, nextName);
      const nextTables = await session.listTables();
      setTables(nextTables);
      setStatus(`Renamed ${tableName} to ${updatedTable.name}.`);
      setQuery((currentQuery) => currentQuery.replaceAll(tableName, updatedTable.name));
    });
  }

  async function handleDropTable(tableName: string) {
    if (!window.confirm(`Drop ${tableName} from the current session?`)) {
      return;
    }

    await runBusyTask(async () => {
      const session = await ensureBrowserSession();
      await session.dropTable(tableName);
      const nextTables = await session.listTables();
      setTables(nextTables);
      setStatus(`Dropped ${tableName} from the current browser session.`);
      setResult(null);
    });
  }

  async function handleCopyShareLink() {
    const shareUrl = createShareUrl(query, `${window.location.origin}${window.location.pathname}`);
    await runBusyTask(async () => {
      window.history.replaceState(null, "", shareUrl);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        window.prompt("Copy FileSQL share link", shareUrl);
      }
      setStatus("Copied a share link with the current SQL.");
      setRunLog((current) => ["Copied share link for current SQL.", ...current].slice(0, 10));
    });
  }

  async function handleExport(format: ExportFormat) {
    if (!result || result.ranOn !== "browser") {
      return;
    }

    await runBusyTask(async () => {
      const session = await ensureBrowserSession();
      const artifact = await session.exportResult(result as BrowserQueryResult, format);
      const blobBytes = artifact.bytes.slice();
      const blob = new Blob(
        [blobBytes.buffer.slice(blobBytes.byteOffset, blobBytes.byteOffset + blobBytes.byteLength)],
        { type: artifact.mimeType },
      );
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = artifact.fileName;
        anchor.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      setStatus(`Downloaded the current result as ${format.toUpperCase()}.`);
      setRunLog((current) => [`Downloaded result as ${artifact.fileName}.`, ...current].slice(0, 10));
    });
  }

  function handleAddRemoteUrl() {
    const trimmedUrl = remoteUrl.trim();
    if (!trimmedUrl) {
      setError("Enter a remote URL first.");
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      setError("Remote URL must be a valid absolute URL.");
      return;
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      setError("Remote URLs must use http:// or https://.");
      return;
    }

    const fileName = parsedUrl.pathname.split("/").pop() || remoteKind;
    const baseTableName = deriveTableName(fileName);
    const nextTableName = uniqueRemoteTableName(baseTableName, remoteSources);
    const nextSource = { kind: remoteKind, name: nextTableName, source: trimmedUrl };
    setRemoteSources((current) => [...current, nextSource]);
    setEngineMode("worker");
    setShowEscalationPrompt(false);
    setRemoteUrl("");
    setStatus("Remote URLs route to the worker because browser mode cannot rely on cross-origin fetches.");
    setRunLog((current) => [`Added remote ${remoteKind.toUpperCase()} source ${trimmedUrl}.`, ...current].slice(0, 10));
    setQuery(defaultQueryForTable(nextTableName));
  }

  function handleRemoveRemoteUrl(tableName: string) {
    setRemoteSources((current) => current.filter((source) => source.name !== tableName));
    setStatus(`Removed worker URL source ${tableName}.`);
  }

  async function runBusyTask(task: () => Promise<void>) {
    setIsBusy(true);
    setError(null);

    try {
      await task();
    } catch (taskError) {
      const nextError = taskError instanceof Error ? taskError.message : "Unexpected error.";
      setError(nextError);
      setRunLog((current) => [`Error: ${nextError}`, ...current].slice(0, 10));
    } finally {
      setIsBusy(false);
    }
  }

  const filteredRows = result
    ? result.rows.filter((row) =>
        filterText
          ? row.some((cell) => formatCell(cell).toLowerCase().includes(filterText.trim().toLowerCase()))
          : true,
      )
    : [];

  const sortedRows =
    result && sortState
      ? [...filteredRows].sort((left, right) => {
          const leftValue = formatCell(left[sortState.columnIndex] ?? "");
          const rightValue = formatCell(right[sortState.columnIndex] ?? "");
          const comparison = leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" });
          return sortState.direction === "asc" ? comparison : -comparison;
        })
      : filteredRows;

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / RESULT_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedRows = sortedRows.slice(
    currentPage * RESULT_PAGE_SIZE,
    currentPage * RESULT_PAGE_SIZE + RESULT_PAGE_SIZE,
  );
  const hasQueryableInput = tables.length > 0 || remoteSources.length > 0;
  const visibleTables = [
    ...tables,
    ...remoteSources.map<BrowserTableInfo>((source) => ({
      columns: [],
      fileName: source.source,
      kind: source.kind,
      name: source.name,
      rowCount: 0,
      sample: null,
      sampleValues: {},
    })),
  ];

  function toggleSort(columnIndex: number) {
    setPage(0);
    setSortState((currentSort) => {
      if (!currentSort || currentSort.columnIndex !== columnIndex) {
        return { columnIndex, direction: "asc" };
      }

      return {
        columnIndex,
        direction: currentSort.direction === "asc" ? "desc" : "asc",
      };
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Hybrid DuckDB playground</p>
          <h1>FileSQL</h1>
          <p className="topbar-copy">
            Query CSV, JSON, JSONL, Parquet, Arrow, and SQLite files with DuckDB in the browser
            first and a worker fallback for oversized inputs.
          </p>
        </div>
        <div className="status-cluster">
          <span className="status-badge">Running on {engineMode}</span>
          {engineVersion ? <span className="status-badge">DuckDB {engineVersion}</span> : null}
          <a href="https://github.com/chayprabs/duckdb-file-sql" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
      </header>

      {showEscalationPrompt ? (
        <section className="escalation-banner" role="alert">
          <div>
            <p className="panel-label">Escalation required</p>
            <strong>Selected files exceed the {budgetInGb} browser budget.</strong>
            <p>
              Worker execution is required for these files. The UI now stops before upload so you
              can cancel.
            </p>
          </div>
          <button type="button" className="ghost" onClick={() => setShowEscalationPrompt(false)}>
            Cancel
          </button>
        </section>
      ) : null}

      <main className="workspace">
        <aside className="panel panel-left">
          <section className="dropzone">
            <p className="panel-label">Inputs</p>
            <h2>Drop files, pick a local file, or load a sample fixture.</h2>
            <p>
              Files up to {budgetInGb} stay local in the browser. Larger files trigger an
              escalation prompt before any upload path exists.
            </p>
            <div className="dropzone-actions">
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                Choose files
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const sample = samples.find((item) => item.id === "nyc-taxi-sample");
                  if (sample) {
                    void handleSampleLoad(sample);
                  }
                }}
              >
                Load NYC taxi sample
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              accept=".csv,.tsv,.json,.jsonl,.parquet,.arrow,.sqlite,.sqlite3"
              onChange={(event) => void handleFileSelection(event.target.files)}
            />
            <div className="remote-url-form">
              <label className="filter-field">
                <span>Remote URL (worker only)</span>
                <input
                  placeholder="https://example.com/data.parquet"
                  type="url"
                  value={remoteUrl}
                  onChange={(event) => setRemoteUrl(event.target.value)}
                />
              </label>
              <div className="remote-url-actions">
                <select value={remoteKind} onChange={(event) => setRemoteKind(event.target.value as SupportedFileKind)}>
                  <option value="csv">CSV</option>
                  <option value="tsv">TSV</option>
                  <option value="json">JSON</option>
                  <option value="jsonl">JSONL</option>
                  <option value="parquet">Parquet</option>
                  <option value="arrow">Arrow</option>
                  <option value="sqlite">SQLite</option>
                </select>
                <button type="button" className="ghost" onClick={handleAddRemoteUrl}>
                  Add remote URL
                </button>
              </div>
              <small className="remote-url-note">
                Remote URLs always use the worker. Browser mode does not rely on cross-origin fetches for file processing.
              </small>
            </div>
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <div>
                <p className="panel-label">Sample picker</p>
                <h2>Fixture pack</h2>
              </div>
            </div>
            <ul className="sample-list">
              {samples.map((sample) => (
                <li key={sample.id}>
                  <button type="button" className="sample-button" onClick={() => void handleSampleLoad(sample)}>
                    <strong>{sample.label}</strong>
                    <span>{sample.kind.toUpperCase()}</span>
                    <small>{sample.description}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <p className="panel-label">Schema</p>
              <div className="schema-toolbar">
                <span className="table-count">{visibleTables.length} tables</span>
                <button type="button" className="ghost-inline" onClick={() => setSchemaCollapsed((value) => !value)}>
                  {schemaCollapsed ? "Expand" : "Collapse"}
                </button>
              </div>
            </div>
            {!schemaCollapsed ? (
              <ul className="table-list">
                {visibleTables.length ? (
                  visibleTables.map((table) => (
                    <li key={table.name}>
                      <div className="table-card-header">
                        <div>
                          <strong>{table.name}</strong>
                          <span>{table.kind.toUpperCase()}</span>
                        </div>
                        <small>
                          {table.columns.length} cols - {table.rowCount} rows
                        </small>
                      </div>
                      {remoteSources.some((source) => source.name === table.name) ? (
                        <div className="table-actions">
                          <button type="button" className="ghost-inline danger-inline" onClick={() => handleRemoveRemoteUrl(table.name)}>
                            Remove URL
                          </button>
                        </div>
                      ) : (
                        <div className="table-actions">
                          <button type="button" className="ghost-inline" onClick={() => void handleRenameTable(table.name)}>
                            Rename
                          </button>
                          <button type="button" className="ghost-inline danger-inline" onClick={() => void handleDropTable(table.name)}>
                            Drop
                          </button>
                        </div>
                      )}
                      <p className="table-meta">{table.fileName}</p>
                      {table.columns.length ? (
                        <>
                          <div className="column-list">
                            {table.columns.map((column) => (
                              <span key={`${table.name}-${column.name}`}>
                                {column.name}: {column.type}
                              </span>
                            ))}
                          </div>
                          <div className="sample-values">
                            {table.columns.map((column) => (
                              <div key={`${table.name}-sample-${column.name}`} className="sample-value-card">
                                <strong>{column.name}</strong>
                                <span>{formatCell(table.sampleValues[column.name])}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <div className="empty-state remote-table-note">
                          Worker URL source. Columns will populate after a query runs against this remote file.
                        </div>
                      )}
                      {table.sample ? (
                        <pre className="sample-preview">
                          {JSON.stringify(table.sample, null, 2)}
                        </pre>
                      ) : null}
                    </li>
                  ))
                ) : (
                  <li className="empty-state">No tables loaded yet.</li>
                )}
              </ul>
            ) : (
              <div className="empty-state collapsed-note">Schema panel collapsed.</div>
            )}
          </section>
        </aside>

        <section className="panel panel-center">
          <div className="editor-toolbar">
            <div>
              <p className="panel-label">SQL editor</p>
              <h2>Write SQL against the current browser session.</h2>
            </div>
            <div className="toolbar-actions">
              <button type="button" className="ghost" disabled={isBusy} onClick={() => void handleCopyShareLink()}>
                Copy share link
              </button>
              <button type="button" className="ghost" disabled={isBusy || !tables.length} onClick={() => void handleExplain(false)}>
                Explain
              </button>
              <button type="button" className="ghost" disabled={isBusy || !tables.length} onClick={() => void handleExplain(true)}>
                Explain Analyze
              </button>
              <button type="button" disabled={isBusy || !hasQueryableInput} onClick={() => void handleRunQuery()}>
                {isBusy ? "Running..." : "Run query"}
              </button>
            </div>
          </div>

          <SqlEditor onRun={() => void handleRunQuery()} onValueChange={setQuery} tables={tables} value={query} />

          <div className="hint-strip">
            <span>Cmd+Enter or Ctrl+Enter to run</span>
            <span>DuckDB-WASM loads lazily on first queryable file</span>
            <span>{status}</span>
          </div>
          {error ? <p className="error-banner">{error}</p> : null}
        </section>

        <aside className="panel panel-right">
          <div className="section-heading">
            <div>
              <p className="panel-label">Results</p>
              <h2>Preview</h2>
            </div>
            <div className="tab-strip">
              <button type="button" className={`tab ${activeTab === "result" ? "active" : ""}`} onClick={() => setActiveTab("result")}>
                Result
              </button>
              <button type="button" className={`tab ${activeTab === "plan" ? "active" : ""}`} disabled={!plan} onClick={() => setActiveTab("plan")}>
                Plan
              </button>
              <button type="button" className={`tab ${activeTab === "logs" ? "active" : ""}`} onClick={() => setActiveTab("logs")}>
                Logs
              </button>
            </div>
          </div>

          <div className="result-card">
            {activeTab === "result" && result ? (
              <>
                <div className="result-header">
                  <span>
                    {sortedRows.length} visible row{sortedRows.length === 1 ? "" : "s"}
                  </span>
                  <div className="result-header-actions">
                    <span>{result.durationMs} ms</span>
                    {result.ranOn === "browser" ? (
                      <>
                        <button type="button" className="ghost" disabled={isBusy} onClick={() => void handleExport("csv")}>
                          CSV
                        </button>
                        <button type="button" className="ghost" disabled={isBusy} onClick={() => void handleExport("json")}>
                          JSON
                        </button>
                        <button type="button" className="ghost" disabled={isBusy} onClick={() => void handleExport("parquet")}>
                          Parquet
                        </button>
                        <button type="button" className="ghost" disabled={isBusy} onClick={() => void handleExport("arrow")}>
                          Arrow
                        </button>
                      </>
                    ) : (
                      <span className="table-meta">Worker result</span>
                    )}
                  </div>
                </div>
                {result.truncated && result.truncationReason ? (
                  <p className="truncation-banner">{result.truncationReason}</p>
                ) : null}
                <div className="result-controls">
                  <label className="filter-field">
                    <span>Filter visible rows</span>
                    <input
                      value={filterText}
                      onChange={(event) => {
                        setFilterText(event.target.value);
                        setPage(0);
                      }}
                      placeholder="Search current result page"
                      type="search"
                    />
                  </label>
                  <div className="pagination-controls">
                    <button type="button" className="ghost" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
                      Previous
                    </button>
                    <span>
                      Page {currentPage + 1} / {pageCount}
                    </span>
                    <button
                      type="button"
                      className="ghost"
                      disabled={currentPage >= pageCount - 1}
                      onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                    >
                      Next
                    </button>
                  </div>
                </div>
                <div className="result-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {result.schema.map((column, columnIndex) => (
                          <th key={column.name}>
                            <button type="button" className="column-sort-button" onClick={() => toggleSort(columnIndex)}>
                              {column.name}
                              {sortState?.columnIndex === columnIndex
                                ? sortState.direction === "asc"
                                  ? " ^"
                                  : " v"
                                : ""}
                            </button>
                            <span className="type-badge">{column.type}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pagedRows.map((row, rowIndex) => (
                        <tr key={`row-${rowIndex}`}>
                          {row.map((cell, cellIndex) => (
                            <td key={`cell-${rowIndex}-${cellIndex}`}>{formatCell(cell)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="query-meta">
                  Tables referenced: {result.tableNames.length ? result.tableNames.join(", ") : "unknown"}
                </div>
              </>
            ) : activeTab === "plan" && plan ? (
              <div className="plan-pane">
                <div className="result-header">
                  <span>{plan.analyze ? "EXPLAIN ANALYZE" : "EXPLAIN"}</span>
                  <span>{plan.durationMs} ms</span>
                </div>
                <pre className="plan-output">{plan.rows.join("\n\n")}</pre>
              </div>
            ) : activeTab === "logs" ? (
              <div className="log-pane">
                {runLog.length ? (
                  <ul className="log-list">
                    {runLog.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="empty-state empty-state-card">Run activity will appear here.</div>
                )}
              </div>
            ) : (
              <div className="empty-state empty-state-card">
                {activeTab === "plan"
                  ? "Run EXPLAIN to inspect a plan tree."
                  : "Query results will appear here after you load a file and run SQL."}
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function tablesFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "table";
}

function defaultQueryForTable(tableName: string): string {
  return `SELECT COUNT(*) AS total_rows\nFROM ${tableName};`;
}

async function runWorkerQuery(sql: string, tables: RemoteTableSource[]): Promise<AppQueryResult> {
  const response = await fetch(`${workerBaseUrl}/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sql,
      tables,
    }),
  });

  const payload: unknown = await response.json();
  if (!response.ok) {
    const errorDetail =
      payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string"
        ? payload.detail
        : "Worker query failed.";
    throw new Error(errorDetail);
  }

  const workerPayload = payload as WorkerQueryResponse;

  return {
    durationMs: workerPayload.durationMs,
    pageSize: workerPayload.pageSize,
    ranOn: "worker",
    rowCount: workerPayload.rows.length,
    rows: workerPayload.rows,
    schema: workerPayload.schema,
    tableNames: workerPayload.tables,
    truncated: workerPayload.truncated,
    truncationReason: workerPayload.truncated
      ? `Worker results were truncated to the first ${workerPayload.pageSize} rows for this page.`
      : null,
  };
}

function uniqueRemoteTableName(baseName: string, sources: RemoteTableSource[]): string {
  const existingNames = new Set(sources.map((source) => source.name));
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let suffix = 2;
  while (existingNames.has(`${baseName}_${suffix}`)) {
    suffix += 1;
  }
  return `${baseName}_${suffix}`;
}

export default App;
