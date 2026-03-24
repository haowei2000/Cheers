"""引导 Bot：根据说明书内容回答用户问题."""
from app.guide.adapter import GuideBotAdapter
from app.guide.help_index import find_help

__all__ = ["GuideBotAdapter", "find_help"]
