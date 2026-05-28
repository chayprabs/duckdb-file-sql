const READ_ONLY_HEADS = new Set([
  "CREATE",
  "DESCRIBE",
  "EXPLAIN",
  "PRAGMA",
  "SELECT",
  "SHOW",
  "VALUES",
  "WITH",
]);
const EXPLAIN_MODIFIERS = new Set(["ANALYZE", "FORMAT", "PIPELINE", "VERBOSE"]);
const TOP_LEVEL_COMMANDS = new Set([
  "ALTER",
  "ATTACH",
  "COPY",
  "CREATE",
  "DELETE",
  "DESCRIBE",
  "DETACH",
  "DROP",
  "EXPLAIN",
  "INSERT",
  "MERGE",
  "PRAGMA",
  "SELECT",
  "SHOW",
  "UPDATE",
  "VALUES",
  "WITH",
]);

export class ReadOnlySqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlySqlError";
  }
}

export function validateReadOnlySql(sql: string): void {
  const statements = splitSqlStatements(sql);
  if (!statements.length) {
    throw new ReadOnlySqlError("Query must contain at least one statement.");
  }

  for (const statement of statements) {
    inspectStatement(statement);
  }
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";

    if (inLineComment) {
      current += char;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (char === "-" && next === "-") {
        current += char + next;
        index += 1;
        inLineComment = true;
        continue;
      }

      if (char === "/" && next === "*") {
        current += char + next;
        index += 1;
        inBlockComment = true;
        continue;
      }
    }

    if (char === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (char === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (char === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      current += char;
      continue;
    }

    if (char === ";" && !inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

export function isPaginatableStatement(sql: string): boolean {
  const tokens = tokenizeSql(sql);
  const info = inspectStatement(sql);
  if (info.head === "SELECT" || info.head === "VALUES") {
    return true;
  }

  if (info.head !== "WITH") {
    return false;
  }

  const mainHead = findMainHeadAfterWith(tokens);
  return mainHead === "SELECT" || mainHead === "VALUES";
}

function inspectStatement(sql: string): { head: string } {
  const tokens = tokenizeSql(sql);
  const head = tokens[0] ?? "";
  if (!head || !READ_ONLY_HEADS.has(head)) {
    throw new ReadOnlySqlError(`Statement \`${head || "UNKNOWN"}\` is not allowed in read-only mode.`);
  }

  if (head === "EXPLAIN") {
    const explainedHead = findHeadAfterExplain(tokens);
    if (!explainedHead || !READ_ONLY_HEADS.has(explainedHead)) {
      throw new ReadOnlySqlError("EXPLAIN is only allowed for read-only statements.");
    }
    if (explainedHead === "CREATE") {
      ensureCreateTempView(tokens.slice(tokens.indexOf(explainedHead)));
      return { head };
    }
    if (!["SELECT", "VALUES", "WITH", "PRAGMA", "DESCRIBE", "SHOW"].includes(explainedHead)) {
      throw new ReadOnlySqlError("EXPLAIN is only allowed for read-only statements.");
    }
    return { head };
  }

  if (head === "CREATE") {
    ensureCreateTempView(tokens);
    return { head };
  }

  if (head === "WITH") {
    const mainHead = findMainHeadAfterWith(tokens);
    if (!mainHead || !["SELECT", "VALUES"].includes(mainHead)) {
      throw new ReadOnlySqlError("WITH statements must resolve to a read-only SELECT or VALUES query.");
    }
    return { head };
  }

  return { head };
}

function ensureCreateTempView(tokens: string[]): void {
  let index = 1;
  if (tokens[index] === "OR" && tokens[index + 1] === "REPLACE") {
    index += 2;
  }

  const tempToken = tokens[index];
  const viewToken = tokens[index + 1];
  if (!["TEMP", "TEMPORARY"].includes(tempToken) || viewToken !== "VIEW") {
    throw new ReadOnlySqlError("Only CREATE TEMP VIEW is allowed in read-only mode.");
  }
}

function findHeadAfterExplain(tokens: string[]): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (EXPLAIN_MODIFIERS.has(token)) {
      continue;
    }
    if (TOP_LEVEL_COMMANDS.has(token)) {
      return token;
    }
  }
  return null;
}

function findMainHeadAfterWith(tokens: string[]): string | null {
  let depth = 0;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "(") {
      depth += 1;
      continue;
    }
    if (token === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && TOP_LEVEL_COMMANDS.has(token) && token !== "WITH") {
      return token;
    }
  }
  return null;
}

function tokenizeSql(sql: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  const pushCurrent = () => {
    if (current) {
      tokens.push(current.toUpperCase());
      current = "";
    }
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (char === "-" && next === "-") {
        pushCurrent();
        index += 1;
        inLineComment = true;
        continue;
      }

      if (char === "/" && next === "*") {
        pushCurrent();
        index += 1;
        inBlockComment = true;
        continue;
      }
    }

    if (char === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      pushCurrent();
      continue;
    }

    if (char === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      pushCurrent();
      continue;
    }

    if (char === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      pushCurrent();
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktick) {
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "(" || char === ")" || char === "," || char === ";") {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}
