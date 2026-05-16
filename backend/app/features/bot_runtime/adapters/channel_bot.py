"""Compatibility alias for the Coordinator adapter module."""

from __future__ import annotations

import sys

from app.features.bot_runtime.adapters import coordinator as _coordinator

sys.modules[__name__] = _coordinator
