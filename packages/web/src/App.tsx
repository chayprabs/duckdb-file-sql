import { useEffect, useRef, useState } from "react";
import {
  BROWSER_FILE_BUDGET_BYTES,
  chooseExecutionModeForFiles,
  createBrowserSession,
  detectFileKind,
  type BrowserQueryResult,
  type BrowserSession,
  type BrowserTableInfo,
  type FileDescriptor,
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

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionRef = useRef<BrowserSession | null>(null);
  const sessionPromiseRef = useRef<Promise<BrowserSession> | null>(null);

  const [samples, setSamples] = useState<SampleManifestItem[]>([]);
  const [query, setQuery] = useState(defaultQuery);
  const [tables, setTables] = useState<BrowserTableInfo[]>([]);
  const [result, setResult] = useState<BrowserQueryResult | null>(null);
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

  useEffect(() => {
    let ignore = false;

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
    }
    return loadedTables;
  }

  async function handleRunQuery() {
    await runBusyTask(async () => {
      const session = await ensureBrowserSession();
      const queryResult = await session.query(query);
      setResult(queryResult);
      setFilterText("");
      setPage(0);
      setSortState(null);
      setStatus(
        `Executed in browser with ${queryResult.rowCount} row${queryResult.rowCount === 1 ? "" : "s"} returned.`,
      );
      setTables(await session.listTables());
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

  async function runBusyTask(task: () => Promise<void>) {
    setIsBusy(true);
    setError(null);

    try {
      await task();
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : "Unexpected error.");
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
                <span className="table-count">{tables.length} tables</span>
                <button type="button" className="ghost-inline" onClick={() => setSchemaCollapsed((value) => !value)}>
                  {schemaCollapsed ? "Expand" : "Collapse"}
                </button>
              </div>
            </div>
            {!schemaCollapsed ? (
              <ul className="table-list">
                {tables.length ? (
                  tables.map((table) => (
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
                      <div className="table-actions">
                        <button type="button" className="ghost-inline" onClick={() => void handleRenameTable(table.name)}>
                          Rename
                        </button>
                        <button type="button" className="ghost-inline danger-inline" onClick={() => void handleDropTable(table.name)}>
                          Drop
                        </button>
                      </div>
                      <p className="table-meta">{table.fileName}</p>
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
              <button type="button" className="ghost" disabled>
                Explain
              </button>
              <button type="button" disabled={isBusy || !tables.length} onClick={() => void handleRunQuery()}>
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
              <button type="button" className="tab active">
                Result
              </button>
              <button type="button" className="tab" disabled>
                Plan
              </button>
              <button type="button" className="tab">
                Logs
              </button>
            </div>
          </div>

          <div className="result-card">
            {result ? (
              <>
                <div className="result-header">
                  <span>
                    {sortedRows.length} visible row{sortedRows.length === 1 ? "" : "s"}
                  </span>
                  <span>{result.durationMs} ms</span>
                </div>
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
                                  ? " ↑"
                                  : " ↓"
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
            ) : (
              <div className="empty-state empty-state-card">
                Query results will appear here after you load a file and run SQL.
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

export default App;
