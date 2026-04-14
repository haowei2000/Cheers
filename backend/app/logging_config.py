"""配置应用日志：写入文件（含错误单独文件）、内存缓冲（面向 LLM 排查）。"""
import logging
import sys
from pathlib import Path

from app.config import settings
from app.core.log_context import LogContextFilter
from app.services.admin.log_buffer import LLMFriendlyBufferHandler

_CONTEXT_FIELDS = ("request_id", "channel_id", "bot_id", "user_id", "trace_id")


def _resolve_log_dir() -> Path | None:
    if not settings.log_dir or not settings.log_dir.strip():
        return None
    p = Path(settings.log_dir.strip())
    if not p.is_absolute():
        # 相对路径：相对于 backend 目录
        base = Path(__file__).resolve().parent.parent
        p = (base / p).resolve()
    return p


class _PlainFormatter(logging.Formatter):
    """Human-readable formatter that appends non-empty context fields."""

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        ctx_parts = []
        for key in _CONTEXT_FIELDS:
            val = getattr(record, key, "")
            if val:
                ctx_parts.append(f"{key}={val}")
        if hasattr(record, "duration_ms") and record.duration_ms is not None:
            ctx_parts.append(f"duration_ms={record.duration_ms:.0f}")
        if ctx_parts:
            return f"{base} [{' '.join(ctx_parts)}]"
        return base


class _JsonFormatter(logging.Formatter):
    """结构化 JSON 日志格式化器（LOG_JSON=true 时启用）."""

    def format(self, record: logging.LogRecord) -> str:
        import json as _json
        import traceback as _tb

        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = _tb.format_exception(*record.exc_info)
        for key in _CONTEXT_FIELDS:
            val = getattr(record, key, "")
            if val:
                payload[key] = val
        if hasattr(record, "duration_ms") and record.duration_ms is not None:
            payload["duration_ms"] = record.duration_ms
        return _json.dumps(payload, ensure_ascii=False)


def _attach_context_filter(handler: logging.Handler) -> None:
    """Attach LogContextFilter if not already present."""
    if not any(isinstance(f, LogContextFilter) for f in handler.filters):
        handler.addFilter(LogContextFilter())


def setup_logging() -> None:
    """
    配置根与 app 日志：控制台 + 文件（通用 + 仅错误）。
    log_dir 为空则只输出到控制台。
    LOG_JSON=true 时使用结构化 JSON 格式。
    """
    log_dir = _resolve_log_dir()
    if settings.log_json:
        fmt: logging.Formatter = _JsonFormatter()
    else:
        fmt = _PlainFormatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    root = logging.getLogger()
    root.setLevel(logging.DEBUG if settings.debug else logging.INFO)

    # 控制台
    has_console = any(
        getattr(h, "stream", None) == sys.stderr for h in root.handlers
    )
    if not has_console:
        console = logging.StreamHandler(sys.stderr)
        console.setLevel(logging.DEBUG if settings.debug else logging.INFO)
        console.setFormatter(fmt)
        root.addHandler(console)

    # 内存缓冲（管理端拉取、面向 LLM 的格式）
    if not any(isinstance(h, LLMFriendlyBufferHandler) for h in root.handlers):
        buf = LLMFriendlyBufferHandler()
        buf.setLevel(logging.DEBUG)
        root.addHandler(buf)

    # Attach context filter to all handlers (including pre-existing ones)
    for h in root.handlers:
        _attach_context_filter(h)

    if not log_dir:
        return

    log_dir = Path(log_dir)
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return

    max_bytes = settings.log_max_bytes or 0
    backup_count = max(0, settings.log_backup_count)

    # 通用日志（INFO 及以上）
    try:
        if max_bytes > 0 and backup_count > 0:
            from logging.handlers import RotatingFileHandler
            file_handler = RotatingFileHandler(
                log_dir / "agentnexus.log",
                maxBytes=max_bytes,
                backupCount=backup_count,
                encoding="utf-8",
            )
        else:
            file_handler = logging.FileHandler(
                log_dir / "agentnexus.log",
                encoding="utf-8",
            )
        file_handler.setLevel(logging.INFO)
        file_handler.setFormatter(fmt)
        _attach_context_filter(file_handler)
        root.addHandler(file_handler)
    except OSError:
        pass

    # 错误专用日志（ERROR 及以上，便于排查）
    try:
        if max_bytes > 0 and backup_count > 0:
            from logging.handlers import RotatingFileHandler
            err_handler = RotatingFileHandler(
                log_dir / "error.log",
                maxBytes=max_bytes,
                backupCount=backup_count,
                encoding="utf-8",
            )
        else:
            err_handler = logging.FileHandler(
                log_dir / "error.log",
                encoding="utf-8",
            )
        err_handler.setLevel(logging.ERROR)
        err_handler.setFormatter(fmt)
        _attach_context_filter(err_handler)
        root.addHandler(err_handler)
    except OSError:
        pass


def get_logger(name: str) -> logging.Logger:
    """获取带命名空间的 logger，便于在模块内使用."""
    return logging.getLogger(name)
