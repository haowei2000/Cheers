"""Manual routes module."""
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

router = APIRouter(tags=["manual"])

# The backend directory sits below the project root; docs live at the project root.
DOCS_DIR = Path(__file__).resolve().parent.parent.parent / "docs"


# ── JSON API for docs dashboard ───────────────────────────────────────────────

def _safe_doc_path(name: str) -> Path | None:
    """Resolve and validate that the path stays inside DOCS_DIR.

    If the input is a bare filename (no subfolder) and does not exist at the
    docs root, fall back to looking in help/ then develop/ so that legacy
    flat-structure links keep working after the help/develop split.
    """
    base = name.strip("/")
    if not base or ".." in base or base.startswith("/"):
        return None
    if not base.endswith(".md"):
        base = base + ".md"
    path = (DOCS_DIR / base).resolve()
    if not path.is_relative_to(DOCS_DIR.resolve()):
        return None
    if not path.is_file() and "/" not in base:
        for sub in ("help", "develop"):
            candidate = (DOCS_DIR / sub / base).resolve()
            if candidate.is_relative_to(DOCS_DIR.resolve()) and candidate.is_file():
                return candidate
    return path


@router.get("/api/docs")
async def list_docs() -> dict:
    """List all .md files recursively under the docs directory.

    The `stem` field carries the path relative to docs/ (without .md), so the
    frontend can round-trip it back through `/api/docs/raw/{stem}` regardless
    of whether the doc sits at the root or inside help/ / develop/.
    """
    if not DOCS_DIR.is_dir():
        return {"files": []}
    base = DOCS_DIR.resolve()
    files = sorted(DOCS_DIR.rglob("*.md"), key=lambda p: p.relative_to(base).as_posix())
    return {
        "files": [
            {
                "name": f.name,
                "stem": f.relative_to(base).with_suffix("").as_posix(),
                "size": f.stat().st_size,
                "category": f.relative_to(base).parts[0] if len(f.relative_to(base).parts) > 1 else "",
            }
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
    """Heading to id."""
    slug = text.strip().lower()
    slug = re.sub(r"\s+", "-", slug)
    # Keep Chinese characters, lowercase English letters, digits, and hyphens.
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff-]", "", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug or "section"


def _md_to_html_with_heading_ids(md_text: str) -> str:
    """Md to html with heading ids."""
    try:
        import markdown
    except ImportError:
        # Fallback when markdown is not installed: basic escaping while preserving newlines.
        html = "<pre>" + _escape_html(md_text) + "</pre>"
        return html
    html = markdown.markdown(md_text, extensions=["extra"])

    used_ids: dict[str, int] = {}

    def add_id(match: re.Match) -> str:
        tag, content = match.group(1), match.group(2)
        frag = re.sub(r"<[^>]+>", "", content)  # Strip inline tags.
        frag = frag.strip()
        base_id = _heading_to_id(frag)
        count = used_ids.get(base_id, 0) + 1
        used_ids[base_id] = count
        hid = base_id if count == 1 else f"{base_id}-{count}"
        return f'<{tag} id="{hid}">{content}</{tag}>'
    html = re.sub(r"<(h[23])>(.*?)</\1>", add_id, html, flags=re.S)
    return html


def _escape_html(text: str) -> str:
    """Escape html."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


@router.get("/manual", response_class=HTMLResponse)
async def manual_index() -> HTMLResponse:
    """Manual index."""
    help_items: list[tuple[str, str, str]] = [
        ("帮助文档总索引", "/manual/help/README", "总索引，按角色分流到其它说明书。"),
        (
            "普通用户使用说明",
            "/manual/help/普通用户使用说明",
            "日常在项目里聊天、@ Bot、上传文件的使用指南。",
        ),
        (
            "AgentNexus 前端操作手册",
            "/manual/help/AgentNexus 前端操作手册",
            "前端界面入口、主要控件和常用操作说明。",
        ),
        (
            "AgentNexus 界面交互指南",
            "/manual/help/AgentNexus 界面交互指南",
            "界面布局、交互规则和使用建议。",
        ),
        (
            "系统管理说明书",
            "/manual/help/系统管理说明书",
            "系统管理员：工作空间与项目、成员管理、OpenClaw 接入与审核、"
            "Orchestrator 配置。",
        ),
        (
            "AgentBridge 接入指南",
            "/manual/help/AgentBridge接入指南",
            "Agent 开发者：发现 AgentNexus、提交注册申请、常见错误排查。",
        ),
        (
            "安装部署说明",
            "/manual/help/安装部署说明",
            "部署与运维：环境要求、Docker / 本地安装、数据库迁移、种子数据。",
        ),
        (
            "RustFS 对象存储部署说明",
            "/manual/help/RustFS对象存储部署说明",
            "对象存储安装、配置和联调说明。",
        ),
        (
            "kkFileView 配置说明",
            "/manual/help/kkFileView配置说明",
            "文档在线预览服务配置和排查。",
        ),
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
    """Get manual."""
    # Only allow .md files or bare filenames; reject path traversal.
    base = name.rstrip("/")
    if not base or ".." in base or base.startswith("/"):
        raise HTTPException(status_code=404, detail="not found")
    if not base.endswith(".md"):
        base = base + ".md"
    path = DOCS_DIR / base
    resolved = path.resolve()
    if not resolved.is_relative_to(DOCS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="not found")
    # Support legacy links without subdirectory prefixes by checking help/ and develop/.
    if not path.is_file() and "/" not in base:
        for sub in ("help", "develop"):
            candidate = DOCS_DIR / sub / base
            if candidate.is_file() and candidate.resolve().is_relative_to(DOCS_DIR.resolve()):
                path = candidate
                break
    if not path.is_file():
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
