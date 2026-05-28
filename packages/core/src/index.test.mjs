import test from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_FILE_BUDGET_BYTES,
  chooseExecutionMode,
  chooseExecutionModeForFiles,
  deriveTableName,
  detectFileKind,
} from "./index.ts";

test("detectFileKind resolves supported extensions", () => {
  assert.equal(detectFileKind("people.csv"), "csv");
  assert.equal(detectFileKind("events.JSONL"), "jsonl");
  assert.equal(detectFileKind("warehouse.sqlite3"), "sqlite");
  assert.equal(detectFileKind("notes.txt"), null);
});

test("deriveTableName normalizes table identifiers", () => {
  assert.equal(deriveTableName("NYC Taxi Sample.parquet"), "nyc_taxi_sample");
  assert.equal(deriveTableName("2026-report.csv"), "t_2026_report");
  assert.equal(deriveTableName("###.json"), "table");
});

test("chooseExecutionMode routes oversized files to the worker", () => {
  assert.deepEqual(
    chooseExecutionMode({
      id: "1",
      name: "large.parquet",
      bytes: BROWSER_FILE_BUDGET_BYTES + 1,
      kind: "parquet",
    }),
    {
      mode: "worker",
      reason: "File exceeds in-browser budget and requires native DuckDB.",
    },
  );
});

test("chooseExecutionModeForFiles only escalates when needed", () => {
  assert.equal(
    chooseExecutionModeForFiles([
      { id: "1", name: "small.csv", bytes: 1024, kind: "csv" },
      { id: "2", name: "small.jsonl", bytes: 2048, kind: "jsonl" },
    ]).mode,
    "browser",
  );

  assert.equal(
    chooseExecutionModeForFiles([
      { id: "1", name: "small.csv", bytes: 1024, kind: "csv" },
      {
        id: "2",
        name: "big.parquet",
        bytes: BROWSER_FILE_BUDGET_BYTES + 10,
        kind: "parquet",
      },
    ]).mode,
    "worker",
  );
});
