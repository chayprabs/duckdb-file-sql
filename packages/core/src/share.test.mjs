import test from "node:test";
import assert from "node:assert/strict";

import { FILESQL_DIALECT, createShareUrl, parseShareState } from "./share.ts";

test("createShareUrl encodes sql and dialect", () => {
  const url = createShareUrl("SELECT * FROM trips", "https://filesql.dev/");
  assert.equal(
    url,
    "https://filesql.dev/?sql=SELECT+*+FROM+trips&dialect=duckdb",
  );
});

test("parseShareState reads sql and dialect from search params", () => {
  assert.deepEqual(parseShareState("sql=SELECT+1&dialect=duckdb"), {
    sql: "SELECT 1",
    dialect: FILESQL_DIALECT,
  });
});
