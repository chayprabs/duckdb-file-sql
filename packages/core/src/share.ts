const SQL_PARAM = "sql";
const DIALECT_PARAM = "dialect";

export const FILESQL_DIALECT = "duckdb";

export interface ShareState {
  dialect: string | null;
  sql: string | null;
}

export function createShareUrl(sql: string, baseUrl: string, dialect = FILESQL_DIALECT): string {
  const url = new URL(baseUrl);
  url.searchParams.set(SQL_PARAM, sql);
  url.searchParams.set(DIALECT_PARAM, dialect);
  return url.toString();
}

export function parseShareState(input: string | URLSearchParams): ShareState {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  return {
    dialect: params.get(DIALECT_PARAM),
    sql: params.get(SQL_PARAM),
  };
}
