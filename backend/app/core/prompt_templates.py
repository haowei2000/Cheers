"""Prompt template defaults shared across API, DB models, and adapters."""
from __future__ import annotations

DEFAULT_USER_TEMPLATE = "{{memory}}\n\n{{message}}"
DEFAULT_TEMPLATE_VARIABLES = ["memory", "message"]
