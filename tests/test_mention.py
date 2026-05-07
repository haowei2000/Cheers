"""@mention 解析与路由单测。

语义：extract_mentions 只识别消息【开头】连续的 @mention，
遇到非 @ 内容即停止；中间/末尾的 @ 不再被识别。
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
    """@ 出现在中间/末尾不再被识别。"""
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
    """支持中文 Bot 名。"""
    assert extract_mentions("@引导 怎么创建项目") == ["引导"]
    assert extract_mentions("@助手 你好") == ["助手"]


def test_extract_mentions_space_name_at_start() -> None:
    """含空格的 Bot 名（需传入 known_space_names 以优先长匹配）。"""
    assert extract_mentions("@channel bot 你好", ["channel bot"]) == ["channel bot"]
    assert extract_mentions("@channel bot @other 你好", ["channel bot"]) == ["channel bot", "other"]
    # 空格名 Bot 出现在中间/末尾也不再识别
    assert extract_mentions("hi @channel bot", ["channel bot"]) == []
    # 未传入 known_space_names 时退化为按正则匹配，"channel" 将被当作名字
    assert extract_mentions("@channel bot 你好") == ["channel"]


def test_extract_mentions_skips_leading_quote_block() -> None:
    """线程回复前端会在消息前置 `> [RefLabel]: ...\\n\\n` 引用块，
    mention 解析需跳过该块再识别正文开头的 @mention。"""
    # 单行引用 + 空行 + @mention
    text = "> [OldBot]: 原消息文本\n\n@newbot 请看看"
    assert extract_mentions(text, ["newbot"]) == ["newbot"]

    # 引用块后直接跟多个 @mention
    text = "> [用户]: quoted text\n\n@a @b 继续"
    assert extract_mentions(text, ["a", "b"]) == ["a", "b"]

    # 引用块中 @something 不应被识别
    text = "> [Bot]: @codebot 原本的提及\n\n普通内容"
    assert extract_mentions(text, ["codebot"]) == []

    # 含空格 Bot 名
    text = "> [Old]: quote\n\n@channel bot 你好"
    assert extract_mentions(text, ["channel bot"]) == ["channel bot"]

    # 多行引用块
    text = "> line1\n> line2\n\n@bot hi"
    assert extract_mentions(text, ["bot"]) == ["bot"]

    # 仅有引用块、无后续正文
    text = "> [Old]: quote only"
    assert extract_mentions(text, ["bot"]) == []

    # 无 @mention 的线程回复
    text = "> [Old]: quote\n\n没有提及"
    assert extract_mentions(text, ["bot"]) == []


def test_filter_mentioned_bots() -> None:
    channel_bots = ["codebot", "docbot"]
    assert filter_mentioned_bots(["codebot"], channel_bots) == ["codebot"]
    assert filter_mentioned_bots(["codebot", "docbot"], channel_bots) == ["codebot", "docbot"]
    assert filter_mentioned_bots(["codebot", "unknown"], channel_bots) == ["codebot"]
    assert filter_mentioned_bots(["unknown"], channel_bots) == []
    assert filter_mentioned_bots([], channel_bots) == []
