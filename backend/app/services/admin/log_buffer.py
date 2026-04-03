"""内存日志缓冲：保留最近 N 条记录，格式面向 LLM 排查（结构化、含上下文与堆栈）。"""
import logging
import traceback
from collections import deque
from datetime import datetime, timezone
from typing import Any

# 单条记录最大长度，避免单条过大
MAX_MESSAGE_LEN = 8000
# 默认保留条数
DEFAULT_CAPACITY = 500

_buffer: deque[dict[str, Any]] = deque(maxlen=DEFAULT_CAPACITY)


def _format_record_for_llm(record: logging.LogRecord) -> str:
    """
    将一条 LogRecord 格式化为面向 LLM 的文本：便于理解与排查。
    结构：时间 | 级别 | 模块 | [可选 context] | 消息 | [可选 Traceback]。
    """
    ts = datetime.fromtimestamp(record.created, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    level = record.levelname
    logger_name = record.name
    msg = (record.getMessage() or "").strip()
    if len(msg) > MAX_MESSAGE_LEN:
        msg = msg[:MAX_MESSAGE_LEN] + "\n... (truncated)"

    parts = [f"timestamp={ts}", f"level={level}", f"logger={logger_name}"]
    if getattr(record, "request_id", None):
        parts.append(f"request_id={record.request_id}")
    if getattr(record, "channel_id", None):
        parts.append(f"channel_id={record.channel_id}")
    if getattr(record, "bot_id", None):
        parts.append(f"bot_id={record.bot_id}")
    header = " | ".join(parts)
    block = f"{header}\nmessage: {msg}"

    if record.exc_info:
        block += "\ntraceback:\n" + "".join(traceback.format_exception(*record.exc_info))
    return block


class LLMFriendlyBufferHandler(logging.Handler):
    """将日志写入内存缓冲，格式面向 LLM 分析。"""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            text = _format_record_for_llm(record)
            _buffer.append({
                "ts": record.created,
                "level": record.levelname,
                "logger": record.name,
                "message": record.getMessage(),
                "formatted": text,
                "exc_text": record.exc_text if record.exc_info else None,
            })
        except Exception:
            self.handleError(record)


def get_recent_logs(
    level: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """返回最近日志，可选按级别过滤。level 如 DEBUG/INFO/WARNING/ERROR。"""
    level_order = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}
    min_level = level_order.get((level or "").upper(), 0)
    out = []
    for i in range(len(_buffer) - 1, -1, -1):
        if len(out) >= limit:
            break
        entry = _buffer[i]
        if level_order.get(entry["level"], 99) >= min_level:
            out.append({
                "ts": entry["ts"],
                "level": entry["level"],
                "logger": entry["logger"],
                "message": entry["message"],
                "formatted": entry["formatted"],
            })
    out.reverse()
    return out


def get_formatted_log_excerpt(level: str | None = None, limit: int = 100) -> str:
    """返回面向 LLM 的整段日志摘要（用于发给 LLM 分析）。"""
    entries = get_recent_logs(level=level, limit=limit)
    return "\n\n---\n\n".join(e["formatted"] for e in entries)
