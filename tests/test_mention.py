"""Unit tests for @mention parsing and routing.

Semantics: extract_mentions only recognizes consecutive @mentions at the
beginning of a message. It stops when it reaches non-@ content, so @mentions in
the middle or at the end are ignored.
"""

from app.features.bot_runtime.pipeline.bot.mention import extract_mentions, filter_mentioned_bots


def test_extract_mentions_empty() -> None:
    assert extract_mentions("") == []
    assert extract_mentions("   ") == []
    assert extract_mentions("hello without at") == []


def test_extract_mentions_single_at_start() -> None:
    assert extract_mentions("@codebot 审查代码") == ["codebot"]
    assert extract_mentions("   @codebot 审查代码") == ["codebot"]


def test_extract_mentions_only_at_start() -> None:
    """@mentions in the middle or at the end are ignored."""
    assert extract_mentions("请 @docbot 写文档") == []
    assert extract_mentions("hello @bot") == []
    assert extract_mentions("结尾 at 符号 @") == []


def test_extract_mentions_multiple_at_start() -> None:
    assert extract_mentions("@a @b 你好") == ["a", "b"]
    assert extract_mentions("@a@b 你好") == ["a", "b"]
    assert extract_mentions("@codebot @docbot 一起 @codebot") == ["codebot", "docbot"]


def test_extract_mentions_dedup() -> None:
    assert extract_mentions("@a @b @a @c 你好") == ["a", "b", "c"]


def test_extract_mentions_underscore() -> None:
    assert extract_mentions("@my_bot_1 测试") == ["my_bot_1"]


def test_extract_mentions_chinese() -> None:
    """Chinese bot names are supported."""
    assert extract_mentions("@引导 怎么创建项目") == ["引导"]
    assert extract_mentions("@助手 你好") == ["助手"]


def test_extract_mentions_space_name_at_start() -> None:
    """Bot names with spaces require known_space_names for longest matching."""
    assert extract_mentions("@channel bot 你好", ["channel bot"]) == ["channel bot"]
    assert extract_mentions("@channel bot @other 你好", ["channel bot"]) == ["channel bot", "other"]
    # Bot names with spaces are still ignored in the middle or at the end.
    assert extract_mentions("hi @channel bot", ["channel bot"]) == []
    # Without known_space_names, regex fallback treats "channel" as the name.
    assert extract_mentions("@channel bot 你好") == ["channel"]


def test_extract_mentions_skips_leading_quote_block() -> None:
    """Thread replies prepend a quote block before the message body.

    Mention parsing should skip that block before reading leading @mentions.
    """
    # One-line quote + blank line + @mention.
    text = "> [OldBot]: 原消息文本\n\n@newbot 请看看"
    assert extract_mentions(text, ["newbot"]) == ["newbot"]

    # Multiple @mentions immediately after a quote block.
    text = "> [用户]: quoted text\n\n@a @b 继续"
    assert extract_mentions(text, ["a", "b"]) == ["a", "b"]

    # @something inside the quote block must not be recognized.
    text = "> [Bot]: @codebot 原本的提及\n\n普通内容"
    assert extract_mentions(text, ["codebot"]) == []

    # Bot name with spaces.
    text = "> [Old]: quote\n\n@channel bot 你好"
    assert extract_mentions(text, ["channel bot"]) == ["channel bot"]

    # Multi-line quote block.
    text = "> line1\n> line2\n\n@bot hi"
    assert extract_mentions(text, ["bot"]) == ["bot"]

    # Quote block only, with no following body.
    text = "> [Old]: quote only"
    assert extract_mentions(text, ["bot"]) == []

    # Thread reply without @mention.
    text = "> [Old]: quote\n\n没有提及"
    assert extract_mentions(text, ["bot"]) == []


def test_filter_mentioned_bots() -> None:
    channel_bots = ["codebot", "docbot"]
    assert filter_mentioned_bots(["codebot"], channel_bots) == ["codebot"]
    assert filter_mentioned_bots(["codebot", "docbot"], channel_bots) == ["codebot", "docbot"]
    assert filter_mentioned_bots(["codebot", "unknown"], channel_bots) == ["codebot"]
    assert filter_mentioned_bots(["unknown"], channel_bots) == []
    assert filter_mentioned_bots([], channel_bots) == []
