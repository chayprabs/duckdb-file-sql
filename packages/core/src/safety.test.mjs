import test from "node:test";
import assert from "node:assert/strict";

import {
  ReadOnlySqlError,
  isPaginatableStatement,
  splitSqlStatements,
  validateReadOnlySql,
} from "./safety.ts";

test("validateReadOnlySql allows select and temp view statements", () => {
  assert.doesNotThrow(() => validateReadOnlySql("SELECT * FROM trips"));
  assert.doesNotThrow(() =>
    validateReadOnlySql("CREATE TEMP VIEW recent AS SELECT * FROM trips; SELECT * FROM recent"),
  );
  assert.doesNotThrow(() =>
    validateReadOnlySql("WITH latest AS (SELECT * FROM trips) SELECT * FROM latest"),
  );
  assert.doesNotThrow(() => validateReadOnlySql("EXPLAIN ANALYZE SELECT * FROM trips"));
});

test("validateReadOnlySql rejects mutating statements", () => {
  for (const sql of [
    "DROP TABLE trips",
    "ATTACH 'other.db' AS other",
    "INSERT INTO trips VALUES (1)",
    "DELETE FROM trips",
    "UPDATE trips SET id = 1",
    "CREATE TABLE demo AS SELECT 1",
  ]) {
    assert.throws(() => validateReadOnlySql(sql), ReadOnlySqlError);
  }
});

test("splitSqlStatements respects semicolons inside strings", () => {
  assert.deepEqual(splitSqlStatements("SELECT ';'; SELECT 1;"), ["SELECT ';'", "SELECT 1"]);
});

test("isPaginatableStatement recognizes select-like statements", () => {
  assert.equal(isPaginatableStatement("SELECT * FROM trips"), true);
  assert.equal(isPaginatableStatement("WITH t AS (SELECT * FROM trips) SELECT * FROM t"), true);
  assert.equal(isPaginatableStatement("PRAGMA table_info('trips')"), false);
});
