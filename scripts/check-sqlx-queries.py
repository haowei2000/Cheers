#!/usr/bin/env python3
"""Reject unchecked SQLx query APIs in gateway application code.

Tests may deliberately execute invalid SQL to assert database constraints. The
application must use fully qualified, checked query macros and typed results.
"""
from pathlib import Path
import re
import sys

# Hide literals and comments so examples and SQL contents cannot affect the check.
# Block comments are nested in Rust, so handle them separately from strings.
LITERAL = re.compile(r'(?:br|r)(?P<hashes>\#*)"[\s\S]*?"(?P=hashes)|b?"(?:\\[\s\S]|[^"\\])*"')
API = re.compile(r'\bsqlx\s*::\s*(query\w*|raw_sql|QueryBuilder)\b')
CHECKED = {"query", "query_as", "query_scalar", "query_file", "query_file_as", "query_file_scalar"}


def code_only(source: str) -> str:
    result = list(source)
    index = 0
    while index < len(source):
        literal = LITERAL.match(source, index)
        if literal:
            end = literal.end()
        elif source.startswith("//", index):
            end = source.find("\n", index)
            if end < 0:
                end = len(source)
        elif source.startswith("/*", index):
            end, depth = index + 2, 1
            while end < len(source) and depth:
                if source.startswith("/*", end):
                    depth += 1
                    end += 2
                elif source.startswith("*/", end):
                    depth -= 1
                    end += 2
                else:
                    end += 1
        else:
            index += 1
            continue
        for position in range(index, end):
            if result[position] != "\n":
                result[position] = " "
        index = end
    return "".join(result)


def violations(source: str) -> list[tuple[int, str]]:
    code = code_only(source)
    errors = []
    for match in API.finditer(code):
        name = match.group(1)
        if name in CHECKED and code[match.end():].lstrip().startswith("!"):
            opening = code.find("(", match.end())
            if opening >= 0:
                end, depth = opening + 1, 1
                while end < len(code) and depth:
                    depth += (code[end] == "(") - (code[end] == ")")
                    end += 1
                if re.search(r'\bas\s+_\b', code[opening:end]):
                    errors.append((code.count("\n", 0, match.start()) + 1, "parameter as _ override"))
            continue
        errors.append((code.count("\n", 0, match.start()) + 1, name))
    # Imports would hide the call from the fully-qualified API check above.
    for match in re.finditer(r'\buse\s+sqlx\s*::\s*\{([^;]+)\}\s*;', code):
        for name in re.findall(r'\b(?:query\w*|raw_sql|QueryBuilder)\b', match.group(1)):
            errors.append((code.count("\n", 0, match.start()) + 1, name))
    # A checked SQL statement must also retain its typed result mapping.
    for pattern, label in [
        (r'\bPgRow\b', "PgRow runtime decoding"),
        (r'\bsqlx\s*::\s*Row\s*::', "Row runtime decoding"),
        (r'\b(?:sqlx\s*::\s*)?Executor\s*::\s*fetch\w*\b', "Executor raw fetch"),
        (r'\buse\s+sqlx\s*::\s*(?:Row\b|\{[^;]*\bRow\b)', "Row runtime decoding"),
    ]:
        for match in re.finditer(pattern, code):
            errors.append((code.count("\n", 0, match.start()) + 1, label))
    return errors


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    errors = []
    for path in sorted((root / "server/src").rglob("*.rs")):
        for line, api in violations(path.read_text()):
            errors.append(f"{path.relative_to(root)}:{line}: SQLx query bypass {api}; use a checked macro with typed results")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Gateway SQL queries use checked SQLx macros.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
