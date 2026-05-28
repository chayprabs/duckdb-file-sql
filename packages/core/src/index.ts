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

export const BROWSER_FILE_BUDGET_BYTES = 1024 * 1024 * 1024;

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
