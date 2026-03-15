"""说明书文档路由：将 docs/*.md 以 HTML 形式提供，标题带 id 便于锚点链接."""
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from pydantic import BaseModel

router = APIRouter(tags=["manual"])

# 项目根上一级为 backend，docs 在项目根
DOCS_DIR = Path(__file__).resolve().parent.parent.parent / "docs"


# ── JSON API for docs dashboard ───────────────────────────────────────────────

def _safe_doc_path(name: str) -> Path | None:
    """Resolve and validate that the path stays inside DOCS_DIR."""
    base = name.strip("/")
    if not base or ".." in base or base.startswith("/"):
        return None
    if not base.endswith(".md"):
        base = base + ".md"
    path = (DOCS_DIR / base).resolve()
    if not path.is_relative_to(DOCS_DIR.resolve()):
        return None
    return path


@router.get("/api/docs")
async def list_docs() -> dict:
    """List all .md files in the docs directory."""
    if not DOCS_DIR.is_dir():
        return {"files": []}
    files = sorted(DOCS_DIR.glob("*.md"), key=lambda p: p.name)
    return {
        "files": [
            {"name": f.name, "stem": f.stem, "size": f.stat().st_size}
            for f in files
        ]
    }


@router.get("/api/docs/raw/{name:path}")
async def get_doc_raw(name: str) -> dict:
    """Return raw markdown content of a doc file."""
    path = _safe_doc_path(name)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        raise HTTPException(status_code=404, detail="not found")
    return {"name": path.name, "stem": path.stem, "content": content}


class DocSaveBody(BaseModel):
    content: str


@router.put("/api/docs/raw/{name:path}")
async def save_doc(name: str, body: DocSaveBody) -> dict:
    """Overwrite a doc file with new markdown content."""
    path = _safe_doc_path(name)
    if path is None:
        raise HTTPException(status_code=400, detail="invalid path")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        path.write_text(body.content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "ok", "name": path.name}


def _heading_to_id(text: str) -> str:
    """按统一 slug 规则生成锚点 id：小写、空白转-、去特殊字符."""
    slug = text.strip().lower()
    slug = re.sub(r"\s+", "-", slug)
    # 保留：中文、英文小写、数字、连字符
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff-]", "", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug or "section"


def _md_to_html_with_heading_ids(md_text: str) -> str:
    """将 Markdown 转为 HTML，并为 h2/h3 添加 id 属性。无 markdown 库时做最小转义兜底。"""
    try:
        import markdown
    except ImportError:
        # 未安装 markdown 时兜底：仅做基本转义，保留换行
        html = "<pre>" + _escape_html(md_text) + "</pre>"
        return html
    html = markdown.markdown(md_text, extensions=["extra"])

    used_ids: dict[str, int] = {}

    def add_id(match: re.Match) -> str:
        tag, content = match.group(1), match.group(2)
        frag = re.sub(r"<[^>]+>", "", content)  # 去掉内联标签
        frag = frag.strip()
        base_id = _heading_to_id(frag)
        count = used_ids.get(base_id, 0) + 1
        used_ids[base_id] = count
        hid = base_id if count == 1 else f"{base_id}-{count}"
        return f'<{tag} id="{hid}">{content}</{tag}>'
    html = re.sub(r"<(h[23])>(.*?)</\1>", add_id, html, flags=re.S)
    return html


def _escape_html(text: str) -> str:
    """最小 HTML 转义."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


@router.get("/manual", response_class=HTMLResponse)
async def manual_index() -> HTMLResponse:
    """说明书首页：只展示面向用户/管理员的帮助文档入口，不暴露设计说明书。"""
    help_items: list[tuple[str, str, str]] = [
        ("使用说明书", "/manual/使用说明书", "总索引，按角色分流到其它说明书。"),
        ("普通用户使用说明", "/manual/普通用户使用说明", "日常在项目里聊天、@ Bot、上传文件的使用指南。"),
        ("系统管理说明书", "/manual/系统管理说明书", "系统管理员：工作空间与项目、成员管理、OpenClaw 接入与审核、Orchestrator 配置。"),
        ("OpenClaw接入指南", "/manual/OpenClaw接入指南", "OpenClaw 开发者：发现 AgentNexus、提交注册申请、常见错误排查。"),
        ("OpenClaw接入AgentNexus指南", "/manual/OpenClaw接入AgentNexus指南", "结合 AgentNexus 视角的 OpenClaw 接入流程与 hook 配置说明。"),
        ("安装部署说明", "/manual/安装部署说明", "部署与运维：环境要求、Docker / 本地安装、数据库迁移、种子数据。"),
        ("技术排查Q&A", "/manual/技术排查Q&A", "故障现象 → 原因 → 处理步骤，包含日志说明与接口排查。"),
    ]
    body_parts = [
        "<h1>AgentNexus 使用与管理说明</h1>",
        "<p>以下为面向终端用户、系统管理员、OpenClaw 开发者的帮助文档入口。</p>",
        "<ul>",
    ]
    for title, href, desc in help_items:
        body_parts.append(f'<li><a href="{href}">{title}</a> - {desc}</li>')
    body_parts.append("</ul>")
    style = (
        "body{font-family:system-ui,sans-serif;max-width:800px;"
        "margin:1rem auto;padding:0 1rem;} "
        "a{color:#2563eb;} ul{line-height:1.6;}"
    )
    html = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'/>"
        "<title>AgentNexus 说明书索引</title>"
        f"<style>{style}</style></head><body>"
        + "".join(body_parts)
        + "</body></html>"
    )
    return HTMLResponse(html)


@router.get("/manual/{name:path}", response_class=HTMLResponse)
async def get_manual(name: str) -> HTMLResponse:
    """返回说明书 HTML 页，支持锚点（如 /manual/系统管理说明书#四如何让-openclaw-接入注册-bot-并加入项目）。"""
    # 只允许 .md 或纯文件名，禁止 .. 等
    base = name.rstrip("/")
    if not base or ".." in base or base.startswith("/"):
        raise HTTPException(status_code=404, detail="not found")
    if not base.endswith(".md"):
        base = base + ".md"
    path = DOCS_DIR / base
    resolved = path.resolve()
    if not path.is_file() or not resolved.is_relative_to(DOCS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="not found")
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        raise HTTPException(status_code=404, detail="not found")
    body = _md_to_html_with_heading_ids(raw)
    title = path.stem
    style = (
        "body{font-family:system-ui,sans-serif;max-width:800px;"
        "margin:1rem auto;padding:0 1rem;} "
        "pre{background:#f5f5f5;padding:0.5rem;} "
        "code{background:#f5f5f5;} a{color:#2563eb;}"
    )
    html = (
        f'<!DOCTYPE html><html><head><meta charset="utf-8"/>'
        f"<title>{title}</title><style>{style}</style></head>"
        f"<body>{body}</body></html>"
    )
    return HTMLResponse(html)
