"""Manual routes module."""
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app.docs_paths import resolve_docs_dir

router = APIRouter(tags=["manual"])

DOCS_DIR = resolve_docs_dir(Path(__file__))


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
    help_items: list[tuple[str, str, str, str]] = [
        (
            "Documentation Home",
            "/manual/help/README",
            "Role-based entry point for user, administrator, operations, and Agent provider docs.",
            "/manual/help/README.zh-CN",
        ),
        (
            "User Manual",
            "/manual/help/使用说明书",
            "Role-based documentation index.",
            "/manual/help/使用说明书.zh-CN",
        ),
        (
            "End User Guide",
            "/manual/help/普通用户使用说明",
            "Daily chat, bot mentions, file uploads, and channel workflows.",
            "/manual/help/普通用户使用说明.zh-CN",
        ),
        (
            "Frontend Operation Manual",
            "/manual/help/AgentNexus 前端操作手册",
            "Main frontend entry points, controls, and common operations.",
            "/manual/help/AgentNexus 前端操作手册.zh-CN",
        ),
        (
            "Interface Interaction Guide",
            "/manual/help/AgentNexus 界面交互指南",
            "Interface layout, interaction rules, and usage recommendations.",
            "/manual/help/AgentNexus 界面交互指南.zh-CN",
        ),
        (
            "Administrator Guide",
            "/manual/help/系统管理说明书",
            "Workspace, member, ACP local-agent access, and Orchestrator administration. OpenClaw links are legacy/deprecated.",
            "/manual/help/系统管理说明书.zh-CN",
        ),
        (
            "AgentBridge Integration Guide",
            "/manual/help/AgentBridge接入指南",
            "Connect ACP-capable local agents and troubleshoot registration. OpenClaw links are legacy/deprecated.",
            "/manual/help/AgentBridge接入指南.zh-CN",
        ),
        (
            "Deployment Guide",
            "/manual/help/安装部署说明",
            "Environment requirements, Docker/local setup, migrations, and seed data.",
            "/manual/help/安装部署说明.zh-CN",
        ),
        (
            "RustFS Object Storage Guide",
            "/manual/help/RustFS对象存储部署说明",
            "S3-compatible object storage setup, configuration, and integration checks.",
            "/manual/help/RustFS对象存储部署说明.zh-CN",
        ),
        (
            "kkFileView Preview Guide",
            "/manual/help/kkFileView配置说明",
            "Online document preview setup and troubleshooting.",
            "/manual/help/kkFileView配置说明.zh-CN",
        ),
        (
            "Troubleshooting Q&A",
            "/manual/help/技术排查Q&A",
            "Common symptoms, causes, checks, logs, and recovery steps.",
            "/manual/help/技术排查Q&A.zh-CN",
        ),
    ]
    body_parts = [
        "<h1>AgentNexus Documentation</h1>",
        "<p>English is the default documentation language. Each public guide has a Chinese mirror with the <code>.zh-CN.md</code> suffix.</p>",
        "<ul>",
    ]
    for title, href, desc, zh_href in help_items:
        body_parts.append(
            f'<li><a href="{href}">{title}</a> - {desc} '
            f'<a href="{zh_href}">Chinese</a></li>'
        )
    body_parts.append("</ul>")
    style = (
        "body{font-family:system-ui,sans-serif;max-width:800px;"
        "margin:1rem auto;padding:0 1rem;} "
        "a{color:#2563eb;} ul{line-height:1.6;}"
    )
    html = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'/>"
        "<title>AgentNexus Documentation</title>"
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
