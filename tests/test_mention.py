"""@mention 解析与路由单测."""
import pytest

from app.orchestrator.mention import extract_mentions, filter_mentioned_bots


def test_extract_mentions_empty() -> None:
    assert extract_mentions("") == []
    assert extract_mentions("   ") == []
    assert extract_mentions("hello without at") == []


def test_extract_mentions_single() -> None:
    assert extract_mentions("@codebot 审查代码") == ["codebot"]
    assert extract_mentions("请 @docbot 写文档") == ["docbot"]


def test_extract_mentions_multiple_dedup() -> None:
    assert extract_mentions("@codebot 和 @docbot 一起 @codebot") == ["codebot", "docbot"]


def test_extract_mentions_underscore() -> None:
    assert extract_mentions("@my_bot_1 测试") == ["my_bot_1"]


def test_extract_mentions_chinese() -> None:
    """支持中文 Bot 名（如引导 Bot）。"""
    assert extract_mentions("@引导 怎么创建项目") == ["引导"]
    assert extract_mentions("@助手 你好") == ["助手"]


def test_filter_mentioned_bots() -> None:
    channel_bots = ["codebot", "docbot"]
    assert filter_mentioned_bots(["codebot"], channel_bots) == ["codebot"]
    assert filter_mentioned_bots(["codebot", "docbot"], channel_bots) == ["codebot", "docbot"]
    assert filter_mentioned_bots(["codebot", "unknown"], channel_bots) == ["codebot"]
    assert filter_mentioned_bots(["unknown"], channel_bots) == []
    assert filter_mentioned_bots([], channel_bots) == []
