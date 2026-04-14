"""Async-safe logging context propagated via contextvars.

Usage::

    from app.core.log_context import bind_context

    async with bind_context(channel_id=cid, trace_id=tid):
        logger.info("now has channel_id and trace_id on every record")
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar, Token

_VARS: dict[str, ContextVar[str]] = {
    "request_id": ContextVar("request_id", default=""),
    "channel_id": ContextVar("channel_id", default=""),
    "bot_id": ContextVar("bot_id", default=""),
    "user_id": ContextVar("user_id", default=""),
    "trace_id": ContextVar("trace_id", default=""),
}


@contextmanager
def bind_context(**kwargs: str):
    """Set context vars for the duration of the block, then reset."""
    tokens: list[tuple[ContextVar[str], Token[str]]] = []
    for key, value in kwargs.items():
        var = _VARS.get(key)
        if var is not None and value:
            tokens.append((var, var.set(value)))
    try:
        yield
    finally:
        for var, token in tokens:
            var.reset(token)


def get_context() -> dict[str, str]:
    """Return a snapshot of all non-empty context vars."""
    return {k: v.get() for k, v in _VARS.items() if v.get()}


class LogContextFilter(logging.Filter):
    """Inject all context vars as record attributes so formatters can use them."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key, var in _VARS.items():
            setattr(record, key, var.get())
        return True
