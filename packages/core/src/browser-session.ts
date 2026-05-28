import duckdb_wasm_eh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import eh_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvp_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { tableFromIPC } from "apache-arrow";

import type { AsyncDuckDB, AsyncDuckDBConnection, DuckDBBundles } from "@duckdb/duckdb-wasm";

import {
  deriveTableName,
  detectFileKind,
  type BrowserColumn,
  type BrowserQueryResult,
  type BrowserSession,
  type BrowserSourceFile,
  type BrowserTableInfo,
} from "./contracts";

const MANUAL_BUNDLES: DuckDBBundles = {
  mvp: {
    mainModule: duckdb_wasm,
    mainWorker: mvp_worker,
  },
  eh: {
    mainModule: duckdb_wasm_eh,
    mainWorker: eh_worker,
  },
};

type DuckDbModule = typeof import("@duckdb/duckdb-wasm");

export async function createBrowserSession(): Promise<BrowserSession> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);

  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const connection = await db.connect();

  return new DuckDbBrowserSession(duckdb, db, connection);
}

class DuckDbBrowserSession implements BrowserSession {
  private readonly registeredTables = new Map<string, BrowserTableInfo>();
  private readonly attachmentNames = new Set<string>();
  private readonly db: AsyncDuckDB;
  private readonly connection: AsyncDuckDBConnection;
  private fileCounter = 0;

  constructor(_: DuckDbModule, db: AsyncDuckDB, connection: AsyncDuckDBConnection) {
    this.db = db;
    this.connection = connection;
  }

  async getVersion(): Promise<string> {
    return this.db.getVersion();
  }

  async listTables(): Promise<BrowserTableInfo[]> {
    return Array.from(this.registeredTables.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async loadFile(file: BrowserSourceFile): Promise<BrowserTableInfo[]> {
    const kind = detectFileKind(file.name);
    if (!kind) {
      throw new Error(`Unsupported file type for ${file.name}.`);
    }

    const path = this.buildRegisteredPath(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.db.registerFileBuffer(path, bytes);

    const loadedTables =
      kind === "arrow"
        ? await this.loadArrowFile(path, bytes, file.name, kind)
        : kind === "sqlite"
          ? await this.loadSqliteFile(path, file.name)
          : await this.loadTabularFile(path, file.name, kind);

    for (const table of loadedTables) {
      this.registeredTables.set(table.name, table);
    }

    return loadedTables;
  }

  async query(sql: string): Promise<BrowserQueryResult> {
    const startedAt = performance.now();
    const [arrowTable, tableNames] = await Promise.all([
      this.connection.query(sql),
      this.connection.getTableNames(sql).catch(() => []),
    ]);
    const rows = arrowTableToRows(arrowTable);
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;

    return {
      schema: arrowTable.schema.fields.map((field) => ({
        name: field.name,
        type: field.type.toString(),
      })),
      rows,
      durationMs,
      rowCount: rows.length,
      ranOn: "browser",
      tableNames,
    };
  }

  async close(): Promise<void> {
    await this.connection.close();
    await this.db.terminate();
  }

  private async loadTabularFile(
    path: string,
    fileName: string,
    kind: Exclude<ReturnType<typeof detectFileKind>, null | "arrow" | "sqlite">,
  ): Promise<BrowserTableInfo[]> {
    const tableName = deriveTableName(fileName);
    await this.dropExistingTable(tableName);

    const readerSql = {
      csv: `read_csv_auto(${quoteLiteral(path)}, sample_size=-1, header=true)`,
      tsv: `read_csv_auto(${quoteLiteral(path)}, delim='\t', sample_size=-1, header=true)`,
      json: `read_json_auto(${quoteLiteral(path)})`,
      jsonl: `read_json_auto(${quoteLiteral(path)})`,
      parquet: `read_parquet(${quoteLiteral(path)})`,
    }[kind];

    await this.connection.query(
      `CREATE TABLE ${quoteIdentifier(tableName)} AS SELECT * FROM ${readerSql}`,
    );

    return [await this.describeTable(tableName, fileName, kind)];
  }

  private async loadArrowFile(
    _: string,
    bytes: Uint8Array,
    fileName: string,
    kind: "arrow",
  ): Promise<BrowserTableInfo[]> {
    const tableName = deriveTableName(fileName);
    await this.dropExistingTable(tableName);
    await this.connection.insertArrowTable(tableFromIPC(bytes), { name: tableName, create: true });
    return [await this.describeTable(tableName, fileName, kind)];
  }

  private async loadSqliteFile(path: string, fileName: string): Promise<BrowserTableInfo[]> {
    const baseName = deriveTableName(fileName);
    const attachmentName = `${baseName}_${this.fileCounter}`;
    this.attachmentNames.add(attachmentName);

    try {
      await this.connection.query("INSTALL sqlite_scanner");
    } catch {
      // DuckDB-WASM may already have the extension available.
    }

    await this.connection.query("LOAD sqlite_scanner");
    await this.connection.query(
      `ATTACH ${quoteLiteral(path)} AS ${quoteIdentifier(attachmentName)} (TYPE SQLITE)`,
    );

    const attachedTables = await this.queryObjects<{ table_name: string }>(
      [
        "SELECT table_name",
        "FROM information_schema.tables",
        `WHERE table_schema = ${quoteLiteral(attachmentName)}`,
        "AND table_type = 'BASE TABLE'",
        "ORDER BY table_name",
      ].join(" "),
    );

    if (!attachedTables.length) {
      throw new Error(`No SQLite tables were found in ${fileName}.`);
    }

    const describedTables: BrowserTableInfo[] = [];
    for (const row of attachedTables) {
      const tableName =
        attachedTables.length === 1
          ? baseName
          : deriveTableName(`${baseName}_${String(row.table_name)}`);
      await this.dropExistingTable(tableName);
      await this.connection.query(
        [
          `CREATE VIEW ${quoteIdentifier(tableName)} AS`,
          `SELECT * FROM ${quoteIdentifier(attachmentName)}.${quoteIdentifier(String(row.table_name))}`,
        ].join(" "),
      );
      describedTables.push(await this.describeTable(tableName, fileName, "sqlite"));
    }

    return describedTables;
  }

  private async describeTable(
    tableName: string,
    fileName: string,
    kind: BrowserTableInfo["kind"],
  ): Promise<BrowserTableInfo> {
    const [columnRows, countRows, sampleRows] = await Promise.all([
      this.queryObjects<{ name: string; type: string }>(`PRAGMA table_info(${quoteLiteral(tableName)})`),
      this.queryObjects<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${quoteIdentifier(tableName)}`,
      ),
      this.queryObjects<Record<string, unknown>>(
        `SELECT * FROM ${quoteIdentifier(tableName)} LIMIT 1`,
      ),
    ]);

    const columns: BrowserColumn[] = columnRows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
    }));

    return {
      name: tableName,
      fileName,
      kind,
      rowCount: Number(countRows[0]?.total ?? 0),
      columns,
      sample: sampleRows[0] ?? null,
    };
  }

  private async dropExistingTable(tableName: string): Promise<void> {
    await this.connection.query(`DROP VIEW IF EXISTS ${quoteIdentifier(tableName)}`);
    await this.connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
  }

  private async queryObjects<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    return arrowTableToObjects<T>(await this.connection.query(sql));
  }

  private buildRegisteredPath(fileName: string): string {
    this.fileCounter += 1;
    return `filesql/${this.fileCounter}/${fileName}`;
  }
}

function arrowTableToRows(table: Awaited<ReturnType<AsyncDuckDBConnection["query"]>>): unknown[][] {
  return arrowTableToObjects<Record<string, unknown>>(table).map((row) =>
    table.schema.fields.map((field) => row[field.name] ?? null),
  );
}

function arrowTableToObjects<T extends Record<string, unknown>>(
  table: Awaited<ReturnType<AsyncDuckDBConnection["query"]>>,
): T[] {
  return table.toArray().map((row) => {
    const serialized =
      row && typeof row === "object" && "toJSON" in row && typeof row.toJSON === "function"
        ? row.toJSON()
        : row;

    return Object.fromEntries(
      table.schema.fields.map((field) => [
        field.name,
        normalizeValue((serialized as Record<string, unknown>)[field.name]),
      ]),
    ) as T;
  });
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value ?? null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
