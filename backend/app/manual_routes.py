"""说明书文档路由：将 docs/*.md 以 HTML 形式提供，标题带 id 便于锚点链接."""
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["manual"])

# 项目根上一级为 backend，docs 在项目根
DOCS_DIR = Path(__file__).resolve().parent.parent.parent / "docs"


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
