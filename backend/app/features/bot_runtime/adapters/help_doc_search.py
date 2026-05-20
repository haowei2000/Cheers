"""Help document search index built from docs/help/*.md files.

Scans the docs/help/ directory at import time and builds an in-memory index
for keyword search.  The Coordinator bot can call search_help_docs and
read_help_doc tools at runtime without re-reading the filesystem.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("app.features.bot_runtime.adapters.help_doc_search")

_MAX_SNIPPET_CHARS = 300
_MAX_CONTEXT_AROUND_MATCH = 60


def _resolve_docs_help_dir() -> Path:
    env = os.getenv("DOCS_HELP_DIR", "").strip()
    if not env:
        env = os.getenv("AGENTNEXUS_DOCS_DIR", "").strip()
        if env:
            env = env.rstrip("/") + "/help"
    if env:
        p = Path(env)
        if p.is_dir():
            return p

    this_file = Path(__file__).resolve()
    for n in range(4, 7):
        candidate = this_file.parents[n] / "docs" / "help"
        if candidate.is_dir():
            return candidate

    return this_file.parents[5] / "docs" / "help"


_DOCS_HELP_DIR = _resolve_docs_help_dir()


@dataclass(frozen=True)
class HelpDoc:
    stem: str
    filename: str
    title: str
    content: str


def _extract_title(md_text: str) -> str:
    for line in md_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            return stripped[2:].strip()
    return ""


def _build_snippet(content: str, keyword: str) -> str:
    """Return a short excerpt around the first occurrence of keyword."""
    lower = content.lower()
    kw = keyword.lower()
    pos = lower.find(kw)
    if pos < 0:
        return content[:_MAX_SNIPPET_CHARS].strip()

    start = max(0, pos - _MAX_CONTEXT_AROUND_MATCH)
    end = min(len(content), pos + len(kw) + _MAX_CONTEXT_AROUND_MATCH)
    snippet = content[start:end].strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(content):
        snippet += "…"
    return snippet


def _load_all_docs() -> list[HelpDoc]:
    if not _DOCS_HELP_DIR.is_dir():
        logger.warning("docs/help/ directory not found at %s", _DOCS_HELP_DIR)
        return []

    docs: list[HelpDoc] = []
    for md_path in sorted(_DOCS_HELP_DIR.glob("*.md")):
        try:
            raw = md_path.read_text(encoding="utf-8")
        except Exception:
            logger.warning("help_doc_search: cannot read %s", md_path.name)
            continue
        title = _extract_title(raw) or md_path.stem
        docs.append(HelpDoc(
            stem=md_path.stem,
            filename=md_path.name,
            title=title,
            content=raw,
        ))
    return docs


# Built once at import time.
_HELP_DOCS: list[HelpDoc] = _load_all_docs()


def reload_help_docs() -> None:
    """Force-reload the help doc index (useful in dev / hot-reload scenarios)."""
    global _HELP_DOCS
    _HELP_DOCS = _load_all_docs()
    logger.info("help_doc_search: reloaded %d docs", len(_HELP_DOCS))


def search_help_docs(keyword: str, top_n: int = 3) -> list[dict]:
    """Search help docs by keyword and return top-N summaries.

    Returns a list of dicts with keys: stem, filename, title, snippet.
    """
    if not keyword or not keyword.strip():
        return []

    kw = keyword.strip().lower()
    scored: list[tuple[int, HelpDoc]] = []

    for doc in _HELP_DOCS:
        score = 0
        if kw in doc.filename.lower():
            score += 50
        if kw in doc.title.lower():
            score += 30
        # Count keyword occurrences in content.
        score += doc.content.lower().count(kw) * 2
        if score > 0:
            scored.append((score, doc))

    scored.sort(key=lambda item: item[0], reverse=True)
    results: list[dict] = []
    for score, doc in scored[:top_n]:
        results.append({
            "stem": doc.stem,
            "filename": doc.filename,
            "title": doc.title,
            "score": score,
            "snippet": _build_snippet(doc.content, kw),
        })
    return results


def read_help_doc(stem: str) -> str | None:
    """Return the full content of a help doc by its stem (filename without .md).

    Returns None if not found.
    """
    for doc in _HELP_DOCS:
        if doc.stem == stem or doc.filename == stem or f"{doc.stem}.md" == stem:
            return doc.content
    return None
