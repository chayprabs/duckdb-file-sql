from sqlglot import expressions as exp
from sqlglot import parse


class ReadOnlyViolation(ValueError):
    """Raised when a statement violates the read-only policy."""


def validate_read_only_sql(sql: str) -> None:
    for statement in parse(sql, read="duckdb"):
        if _is_explain_statement(statement):
            _validate_explain(statement)
            continue

        if isinstance(statement, exp.Create):
            _validate_create(statement)
            continue

        if not _is_read_statement(statement):
            raise ReadOnlyViolation(f"Statement `{statement.key.upper()}` is not allowed in read-only mode.")


def _validate_explain(statement: exp.Expression) -> None:
    target = statement.args.get("expression")
    if target is None or not _is_read_statement(target):
        raise ReadOnlyViolation("EXPLAIN is only allowed for read-only statements.")


def _validate_create(statement: exp.Create) -> None:
    kind = (statement.args.get("kind") or "").upper()
    properties = statement.args.get("properties")
    temporary = bool(properties and any(isinstance(prop, exp.TemporaryProperty) for prop in properties.expressions))

    if kind == "VIEW" and temporary:
        return

    raise ReadOnlyViolation("Only CREATE TEMP VIEW is allowed in read-only mode.")


def _is_read_statement(statement: exp.Expression) -> bool:
    return isinstance(
        statement,
        (
            exp.Select,
            exp.Union,
            exp.Intersect,
            exp.Except,
            exp.Subquery,
        ),
    )


def _is_explain_statement(statement: exp.Expression) -> bool:
    return isinstance(statement, exp.Command) and str(statement.this).upper() == "EXPLAIN"
