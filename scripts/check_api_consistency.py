#!/usr/bin/env python3
"""
Frontend/backend API consistency checker.

Usage:
    cd backend && uv run python ../scripts/check_api_consistency.py

Approach:
    1. Import the FastAPI app and call app.openapi() to collect backend routes.
    2. Scan frontend/src/*.tsx with regexes to extract fetch/authFetch calls.
    3. Normalize paths, compare both sides, and report inconsistencies.

Exit code: 0 = all checks passed, 1 = issues found.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ── Path constants ───────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
FRONTEND_SRC = PROJECT_ROOT / "frontend" / "src"


# ── Path normalization ───────────────────────────────────────────────────────

def normalize_path(path: str) -> str:
    """Normalize a path for frontend/backend comparisons.

    - Remove query strings.
    - Remove trailing slashes.
    - Normalize all parameter placeholders to {_}
      (backend: {channel_id}; frontend: ${channelId} / ${todo.todo_id}).
    """
    path = path.split("?")[0]
    path = path.rstrip("/")
    # JS template variables: ${...}
    path = re.sub(r"\$\{[^}]+\}", "{_}", path)
    # OpenAPI path parameters: {param}
    path = re.sub(r"\{[^}]+\}", "{_}", path)
    return path


# ══════════════════════════════════════════════════════════════════════════════
# Backend route extraction
# ══════════════════════════════════════════════════════════════════════════════

def extract_backend_routes() -> set[tuple[str, str]]:
    """Extract all backend routes from FastAPI app.openapi() and app.routes.

    Return a set of (METHOD, path), such as
    ("GET", "/api/v1/channels/{channel_id}/members").
    """
    sys.path.insert(0, str(BACKEND_DIR))

    from app.main import app  # type: ignore[import-untyped]

    routes: set[tuple[str, str]] = set()

    # 1) OpenAPI schema
    schema = app.openapi()
    for path, methods in schema.get("paths", {}).items():
        for method in methods:
            m = method.upper()
            if m in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
                routes.add((m, path))

    # 2) WebSocket routes, which OpenAPI does not include.
    from starlette.routing import WebSocketRoute  # type: ignore[import-untyped]

    def _walk_routes(route_list):
        for route in route_list:
            if isinstance(route, WebSocketRoute):
                routes.add(("WEBSOCKET", route.path))
            # Nested Mount / Router entries.
            if hasattr(route, "routes"):
                _walk_routes(route.routes)

    _walk_routes(app.routes)

    return routes


# ══════════════════════════════════════════════════════════════════════════════
# Frontend API call extraction
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FrontendCall:
    file: str       # Path relative to the project root.
    line: int
    method: str     # GET / POST / PUT / PATCH / DELETE / WEBSOCKET
    raw_url: str
    normalized: str
    is_dynamic: bool = False


# Extract template literal URLs from fetch/authFetch calls.
_RE_FETCH_TEMPLATE = re.compile(
    r"(?:auth)?[Ff]etch\(\s*`([^`]*)`", re.DOTALL
)
# Extract regular string URLs from fetch/authFetch calls.
_RE_FETCH_STRING = re.compile(
    r'(?:auth)?[Ff]etch\(\s*"([^"]*)"'
)
# Extract template literal URLs from new WebSocket calls.
_RE_WS = re.compile(
    r"new\s+WebSocket\(\s*`([^`]*)`"
)
# Extract HTTP methods.
_RE_METHOD = re.compile(
    r'method:\s*["\'](\w+)["\']'
)
# Extract file-level API constants.
_RE_API_CONST = re.compile(
    r'const\s+API\s*=\s*["\']([^"\']+)["\']'
)


def _resolve_api_const(content: str) -> str:
    """Resolve const API = "..." from the file; default to /api/v1."""
    m = _RE_API_CONST.search(content)
    return m.group(1) if m else "/api/v1"


def _resolve_url(raw: str, api_base: str) -> tuple[str, bool]:
    """Resolve a raw URL string into (resolved_url, is_dynamic)."""
    # Replace known prefixes such as ${API} / ${WS_BASE}.
    resolved = raw.replace("${API}", api_base)
    # Replace WS_BASE with an empty prefix because only the path matters here.
    resolved = re.sub(r"\$\{WS_BASE\}", "", resolved)

    # Drop the query string first; query template variables do not affect routing.
    path_part = resolved.split("?")[0]

    # Replace JS template variables in the path with placeholders.
    remaining = re.sub(r"\$\{[^}]+\}", "{_}", path_part)

    # Paths that do not start with / are fully dynamic.
    if not remaining.startswith("/"):
        return raw, True

    # Mixed static/dynamic path segments, such as /api/v1{_}, are fully dynamic.
    for part in remaining.split("/"):
        if part and "{_}" in part and part != "{_}":
            return raw, True

    return remaining, False


def _extract_method_from_context(content: str, match_start: int) -> str:
    """Look for a method declaration near a fetch call.

    Search a small window after match_start, which is usually enough to cover
    the options object.
    """
    window = content[match_start : match_start + 400]
    # Keep this within the same fetch call window.
    m = _RE_METHOD.search(window)
    if m:
        return m.group(1).upper()
    return "GET"


def extract_frontend_calls() -> list[FrontendCall]:
    """Scan frontend .tsx files and extract all API calls."""
    calls: list[FrontendCall] = []

    for tsx_path in sorted(FRONTEND_SRC.glob("*.tsx")):
        content = tsx_path.read_text(encoding="utf-8")
        api_base = _resolve_api_const(content)
        rel_path = str(tsx_path.relative_to(PROJECT_ROOT))
        lines = content.split("\n")

        def _line_of(pos: int) -> int:
            return content[:pos].count("\n") + 1

        # fetch / authFetch with template literal
        for m in _RE_FETCH_TEMPLATE.finditer(content):
            raw_url = m.group(1)
            resolved, is_dynamic = _resolve_url(raw_url, api_base)
            if is_dynamic:
                calls.append(FrontendCall(
                    file=rel_path,
                    line=_line_of(m.start()),
                    method="?",
                    raw_url=raw_url,
                    normalized="",
                    is_dynamic=True,
                ))
                continue
            method = _extract_method_from_context(content, m.start())
            calls.append(FrontendCall(
                file=rel_path,
                line=_line_of(m.start()),
                method=method,
                raw_url=raw_url,
                normalized=normalize_path(resolved),
            ))

        # fetch / authFetch with string literal
        for m in _RE_FETCH_STRING.finditer(content):
            raw_url = m.group(1)
            resolved, is_dynamic = _resolve_url(raw_url, api_base)
            if is_dynamic:
                calls.append(FrontendCall(
                    file=rel_path,
                    line=_line_of(m.start()),
                    method="?",
                    raw_url=raw_url,
                    normalized="",
                    is_dynamic=True,
                ))
                continue
            method = _extract_method_from_context(content, m.start())
            calls.append(FrontendCall(
                file=rel_path,
                line=_line_of(m.start()),
                method=method,
                raw_url=raw_url,
                normalized=normalize_path(resolved),
            ))

        # new WebSocket(...)
        for m in _RE_WS.finditer(content):
            raw_url = m.group(1)
            resolved = raw_url.replace("${WS_BASE}", "")
            resolved = re.sub(r"\$\{[^}]+\}", "{_}", resolved)
            calls.append(FrontendCall(
                file=rel_path,
                line=_line_of(m.start()),
                method="WEBSOCKET",
                raw_url=raw_url,
                normalized=normalize_path(resolved),
            ))

    return calls


# ══════════════════════════════════════════════════════════════════════════════
# Comparison logic
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class CheckResult:
    backend_count: int = 0
    frontend_count: int = 0
    dynamic_count: int = 0
    missing: list[FrontendCall] = field(default_factory=list)
    method_mismatch: list[tuple[FrontendCall, str]] = field(default_factory=list)  # (call, backend_method)
    dynamic: list[FrontendCall] = field(default_factory=list)


def check_consistency(
    backend_routes: set[tuple[str, str]],
    frontend_calls: list[FrontendCall],
) -> CheckResult:
    result = CheckResult()
    result.backend_count = len(backend_routes)
    result.frontend_count = len(frontend_calls)

    # Build backend route index: normalized_path -> set of methods.
    backend_index: dict[str, set[str]] = {}
    for method, path in backend_routes:
        normed = normalize_path(path)
        backend_index.setdefault(normed, set()).add(method)

    seen: set[tuple[str, str, int]] = set()  # Deduplicate by (file, normalized, line).

    for call in frontend_calls:
        if call.is_dynamic:
            result.dynamic.append(call)
            result.dynamic_count += 1
            continue

        key = (call.file, call.normalized, call.line)
        if key in seen:
            continue
        seen.add(key)

        if call.normalized not in backend_index:
            result.missing.append(call)
        elif call.method not in backend_index[call.normalized]:
            # The path exists, but the method does not match.
            backend_methods = ", ".join(sorted(backend_index[call.normalized]))
            result.method_mismatch.append((call, backend_methods))

    return result


# ══════════════════════════════════════════════════════════════════════════════
# Report output
# ══════════════════════════════════════════════════════════════════════════════

_RED = "\033[91m"
_YELLOW = "\033[93m"
_GREEN = "\033[92m"
_DIM = "\033[2m"
_RESET = "\033[0m"


def print_report(result: CheckResult) -> int:
    """Print the check report and return the exit code."""
    print()
    print("=" * 60)
    print("  API Consistency Report")
    print("=" * 60)

    has_issues = False

    # Missing endpoints
    if result.missing:
        has_issues = True
        print(f"\n{_RED}MISSING ENDPOINTS (backend route not found):{_RESET}")
        for call in result.missing:
            print(f"  [!] {call.method} {call.normalized}")
            print(f"      {_DIM}{call.file}:{call.line}{_RESET}")
    else:
        print(f"\n{_GREEN}MISSING ENDPOINTS: none{_RESET}")

    # Method mismatches
    if result.method_mismatch:
        has_issues = True
        print(f"\n{_RED}METHOD MISMATCHES:{_RESET}")
        for call, backend_methods in result.method_mismatch:
            print(f"  [!] Frontend: {call.method} {call.normalized}")
            print(f"      Backend:  {backend_methods} {call.normalized}")
            print(f"      {_DIM}{call.file}:{call.line}{_RESET}")
    else:
        print(f"\n{_GREEN}METHOD MISMATCHES: none{_RESET}")

    # Dynamic
    if result.dynamic:
        print(f"\n{_YELLOW}DYNAMIC (cannot verify statically):{_RESET}")
        for call in result.dynamic:
            short = call.raw_url[:60] + ("..." if len(call.raw_url) > 60 else "")
            print(f"  [?] {short}")
            print(f"      {_DIM}{call.file}:{call.line}{_RESET}")

    # Summary
    static_count = result.frontend_count - result.dynamic_count
    print(f"\n{'─' * 60}")
    print(
        f"  Backend routes:    {result.backend_count}\n"
        f"  Frontend calls:    {result.frontend_count} "
        f"({static_count} static, {result.dynamic_count} dynamic)\n"
        f"  Missing endpoints: {len(result.missing)}\n"
        f"  Method mismatches: {len(result.method_mismatch)}"
    )
    print("─" * 60)

    if has_issues:
        print(f"\n{_RED}FAIL{_RESET} — found {len(result.missing) + len(result.method_mismatch)} issue(s)")
        return 1
    else:
        print(f"\n{_GREEN}PASS{_RESET} — all frontend calls match backend routes")
        return 0


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main() -> int:
    print("Extracting backend routes (via OpenAPI schema)...")
    backend_routes = extract_backend_routes()
    print(f"  Found {len(backend_routes)} backend routes")

    print("Extracting frontend API calls (via regex)...")
    frontend_calls = extract_frontend_calls()
    static = sum(1 for c in frontend_calls if not c.is_dynamic)
    dynamic = sum(1 for c in frontend_calls if c.is_dynamic)
    print(f"  Found {len(frontend_calls)} frontend calls ({static} static, {dynamic} dynamic)")

    result = check_consistency(backend_routes, frontend_calls)
    return print_report(result)


if __name__ == "__main__":
    sys.exit(main())
