import { BROWSER_FILE_BUDGET_BYTES } from "@filesql/core";
import "./App.css";

const budgetInGb = `${Math.round(BROWSER_FILE_BUDGET_BYTES / 1024 / 1024 / 1024)} GB`;

const tables = [
  { name: "nyc_taxi_sample", columns: 6, rows: "1.2M", source: "Parquet" },
  { name: "weather", columns: 4, rows: "18K", source: "JSONL" },
  { name: "chinook", columns: 11, rows: "68K", source: "SQLite" },
];

function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Hybrid DuckDB playground</p>
          <h1>FileSQL</h1>
        </div>
        <div className="status-cluster">
          <span className="status-badge">Running on browser</span>
          <a href="https://github.com/chayprabs/duckdb-file-sql" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
      </header>

      <main className="workspace">
        <aside className="panel panel-left">
          <section className="dropzone">
            <p className="panel-label">Inputs</p>
            <h2>Drop files, paste a URL, or load a sample.</h2>
            <p>
              Files up to {budgetInGb} stay local in the browser. Larger files escalate to the
              worker with an explicit confirmation step.
            </p>
            <div className="dropzone-actions">
              <button type="button">Choose files</button>
              <button type="button" className="ghost">
                Load NYC taxi sample
              </button>
            </div>
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <p className="panel-label">Schema</p>
              <button type="button" className="ghost-inline">
                Collapse
              </button>
            </div>
            <ul className="table-list">
              {tables.map((table) => (
                <li key={table.name}>
                  <div>
                    <strong>{table.name}</strong>
                    <span>{table.source}</span>
                  </div>
                  <small>
                    {table.columns} columns · {table.rows} rows
                  </small>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <section className="panel panel-center">
          <div className="editor-toolbar">
            <div>
              <p className="panel-label">SQL editor</p>
              <h2>Write against local files or escalated worker tables.</h2>
            </div>
            <div className="toolbar-actions">
              <button type="button" className="ghost">
                Explain
              </button>
              <button type="button">Run query</button>
            </div>
          </div>

          <div className="editor-surface" role="textbox" aria-label="SQL editor">
            <pre>{`SELECT pickup_zone, COUNT(*) AS rides
FROM nyc_taxi_sample
GROUP BY 1
ORDER BY rides DESC
LIMIT 25;`}</pre>
          </div>

          <div className="hint-strip">
            <span>Cmd+Enter to run</span>
            <span>Autocomplete and Monaco integration next</span>
            <span>Read-only mode enforced before execution</span>
          </div>
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
              <button type="button" className="tab">
                Plan
              </button>
              <button type="button" className="tab">
                Logs
              </button>
            </div>
          </div>

          <div className="result-card">
            <div className="result-header">
              <span>25 rows</span>
              <span>0.42s</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>pickup_zone</th>
                  <th>
                    rides <span className="type-badge">BIGINT</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Midtown Center</td>
                  <td>93214</td>
                </tr>
                <tr>
                  <td>Upper East Side North</td>
                  <td>84577</td>
                </tr>
                <tr>
                  <td>JFK Airport</td>
                  <td>81120</td>
                </tr>
              </tbody>
            </table>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
