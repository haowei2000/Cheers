"""Compatibility alias for the Helper adapter module."""

from __future__ import annotations

import sys

from app.features.bot_runtime.adapters import helper as _helper

sys.modules[__name__] = _helper
