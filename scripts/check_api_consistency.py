#!/usr/bin/env python3
"""
前后端 API 一致性检查脚本。

用法:
    cd backend && uv run python ../scripts/check_api_consistency.py

原理:
    1. 导入 FastAPI app，调用 app.openapi() 获取全部后端路由
    2. 正则扫描 frontend/src/*.tsx 提取全部 fetch/authFetch 调用
    3. 路径规范化后交叉比对，输出不一致项

退出码: 0 = 全部通过, 1 = 存在问题
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ── 路径常量 ──────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
FRONTEND_SRC = PROJECT_ROOT / "frontend" / "src"


# ── 路径规范化 ────────────────────────────────────────────────────────────────

def normalize_path(path: str) -> str:
    """将路径规范化，用于前后端比对。

    - 去掉 query string
    - 去掉尾部 /
    - 将所有参数占位符统一为 {_}
      (后端: {channel_id}  前端: ${channelId} / ${todo.todo_id})
    """
    path = path.split("?")[0]
    path = path.rstrip("/")
    # JS 模板变量 ${...}
    path = re.sub(r"\$\{[^}]+\}", "{_}", path)
    # OpenAPI 路径参数 {param}
    path = re.sub(r"\{[^}]+\}", "{_}", path)
    return path


# ══════════════════════════════════════════════════════════════════════════════
# 后端路由提取
# ══════════════════════════════════════════════════════════════════════════════

def extract_backend_routes() -> set[tuple[str, str]]:
    """从 FastAPI app.openapi() + app.routes 提取全部后端路由。

    返回 set of (METHOD, path)，如 ("GET", "/api/v1/channels/{channel_id}/members")
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

    # 2) WebSocket 路由（OpenAPI 不包含）
    from starlette.routing import WebSocketRoute  # type: ignore[import-untyped]

    def _walk_routes(route_list):
        for route in route_list:
            if isinstance(route, WebSocketRoute):
                routes.add(("WEBSOCKET", route.path))
            # Mount / Router 嵌套
            if hasattr(route, "routes"):
                _walk_routes(route.routes)

    _walk_routes(app.routes)

    return routes


# ══════════════════════════════════════════════════════════════════════════════
# 前端 API 调用提取
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FrontendCall:
    file: str       # 相对于项目根的路径
    line: int
    method: str     # GET / POST / PUT / PATCH / DELETE / WEBSOCKET
    raw_url: str
    normalized: str
    is_dynamic: bool = False


# 提取 fetch/authFetch 的模板字面量 URL
_RE_FETCH_TEMPLATE = re.compile(
    r"(?:auth)?[Ff]etch\(\s*`([^`]*)`", re.DOTALL
)
# 提取 fetch/authFetch 的普通字符串 URL
_RE_FETCH_STRING = re.compile(
    r'(?:auth)?[Ff]etch\(\s*"([^"]*)"'
)
# 提取 new WebSocket 的模板字面量 URL
_RE_WS = re.compile(
    r"new\s+WebSocket\(\s*`([^`]*)`"
)
# 提取 HTTP 方法
_RE_METHOD = re.compile(
    r'method:\s*["\'](\w+)["\']'
)
# 提取文件级 API 常量
_RE_API_CONST = re.compile(
    r'const\s+API\s*=\s*["\']([^"\']+)["\']'
)


def _resolve_api_const(content: str) -> str:
    """解析文件中 const API = "..." 的值，默认 /api/v1。"""
    m = _RE_API_CONST.search(content)
    return m.group(1) if m else "/api/v1"


def _resolve_url(raw: str, api_base: str) -> tuple[str, bool]:
    """将原始 URL 字符串解析为 (resolved_url, is_dynamic)。"""
    # 替换 ${API} / ${WS_BASE} 等已知前缀
    resolved = raw.replace("${API}", api_base)
    # WS_BASE 替换为空（我们只关心路径部分）
    resolved = re.sub(r"\$\{WS_BASE\}", "", resolved)

    # 先去掉 query string（query 中的模板变量不影响路由匹配）
    path_part = resolved.split("?")[0]

    # 将路径中的 JS 模板变量替换为占位符
    remaining = re.sub(r"\$\{[^}]+\}", "{_}", path_part)

    # 如果路径不以 / 开头 → 纯动态
    if not remaining.startswith("/"):
        return raw, True

    # 检测路径段中混合了静态和动态的模式（如 /api/v1{_}）→ 纯动态
    for part in remaining.split("/"):
        if part and "{_}" in part and part != "{_}":
            return raw, True

    return remaining, False


def _extract_method_from_context(content: str, match_start: int) -> str:
    """在 fetch 调用附近查找 method 声明。

    从 match_start 往后搜索不超过 300 个字符（一般足够覆盖 options 对象）。
    """
    window = content[match_start : match_start + 400]
    # 确保在同一个 fetch 调用内（找到下一个同级 fetch 或语句结尾之前）
    m = _RE_METHOD.search(window)
    if m:
        return m.group(1).upper()
    return "GET"


def extract_frontend_calls() -> list[FrontendCall]:
    """扫描前端 .tsx 文件，提取全部 API 调用。"""
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
# 比对逻辑
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

    # 构建后端路由索引: normalized_path -> set of methods
    backend_index: dict[str, set[str]] = {}
    for method, path in backend_routes:
        normed = normalize_path(path)
        backend_index.setdefault(normed, set()).add(method)

    seen: set[tuple[str, str, int]] = set()  # 去重 (file, normalized, line)

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
            # 路径存在但方法不匹配
            backend_methods = ", ".join(sorted(backend_index[call.normalized]))
            result.method_mismatch.append((call, backend_methods))

    return result


# ══════════════════════════════════════════════════════════════════════════════
# 报告输出
# ══════════════════════════════════════════════════════════════════════════════

_RED = "\033[91m"
_YELLOW = "\033[93m"
_GREEN = "\033[92m"
_DIM = "\033[2m"
_RESET = "\033[0m"


def print_report(result: CheckResult) -> int:
    """输出检查报告，返回退出码。"""
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
