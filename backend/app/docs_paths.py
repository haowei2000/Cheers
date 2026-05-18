"""Helpers for locating repository documentation at runtime."""

from __future__ import annotations

import os
from pathlib import Path


def resolve_docs_dir(anchor: Path | None = None) -> Path:
    """Resolve the docs directory for local source and Docker layouts."""
    configured = os.getenv("AGENTNEXUS_DOCS_DIR") or os.getenv("DOCS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()

    start = (anchor or Path(__file__)).resolve()
    candidates = [parent / "docs" for parent in start.parents]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate.resolve()

    return candidates[0].resolve()
