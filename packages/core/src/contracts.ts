export type EngineMode = "browser" | "worker";

export type SupportedFileKind =
  | "csv"
  | "tsv"
  | "json"
  | "jsonl"
  | "parquet"
  | "arrow"
  | "sqlite";

export interface FileDescriptor {
  id: string;
  name: string;
  bytes: number;
  kind: SupportedFileKind;
}

export interface RouteDecision {
  mode: EngineMode;
  reason: string;
}

export interface BrowserSourceFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BrowserColumn {
  name: string;
  type: string;
}

export interface BrowserTableInfo {
  name: string;
  fileName: string;
  kind: SupportedFileKind;
  rowCount: number;
  columns: BrowserColumn[];
  sample: Record<string, unknown> | null;
  sampleValues: Record<string, unknown>;
}

export interface BrowserQueryResult {
  schema: BrowserColumn[];
  rows: unknown[][];
  durationMs: number;
  rowCount: number;
  ranOn: "browser";
  tableNames: string[];
  truncated: boolean;
  truncationReason: string | null;
}

export interface BrowserExplainResult {
  analyze: boolean;
  durationMs: number;
  rows: string[];
  sql: string;
}

export interface BrowserSession {
  getVersion(): Promise<string>;
  listTables(): Promise<BrowserTableInfo[]>;
  loadFile(file: BrowserSourceFile): Promise<BrowserTableInfo[]>;
  query(sql: string): Promise<BrowserQueryResult>;
  explain(sql: string, analyze?: boolean): Promise<BrowserExplainResult>;
  renameTable(currentName: string, nextName: string): Promise<BrowserTableInfo>;
  dropTable(tableName: string): Promise<void>;
  close(): Promise<void>;
}

export const BROWSER_FILE_BUDGET_BYTES = 1024 * 1024 * 1024;

const EXTENSION_TO_KIND: Record<string, SupportedFileKind> = {
  arrow: "arrow",
  csv: "csv",
  json: "json",
  jsonl: "jsonl",
  parquet: "parquet",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  tsv: "tsv",
};

export function chooseExecutionMode(file: FileDescriptor): RouteDecision {
  if (file.bytes > BROWSER_FILE_BUDGET_BYTES) {
    return {
      mode: "worker",
      reason: "File exceeds in-browser budget and requires native DuckDB.",
    };
  }

  return {
    mode: "browser",
    reason: "File fits the in-browser budget.",
  };
}

export function chooseExecutionModeForFiles(files: FileDescriptor[]): RouteDecision {
  const oversizedFile = files.find((file) => file.bytes > BROWSER_FILE_BUDGET_BYTES);
  if (oversizedFile) {
    return {
      mode: "worker",
      reason: `${oversizedFile.name} exceeds the in-browser budget and requires the worker.`,
    };
  }

  return {
    mode: "browser",
    reason: "All files fit the in-browser budget.",
  };
}

export function detectFileKind(fileName: string): SupportedFileKind | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_KIND[extension] ?? null;
}

export function deriveTableName(fileName: string): string {
  const baseName = fileName.replace(/\.[^.]+$/, "").toLowerCase();
  const cleaned = baseName.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  if (!cleaned) {
    return "table";
  }

  return /^[0-9]/.test(cleaned) ? `t_${cleaned}` : cleaned;
}
