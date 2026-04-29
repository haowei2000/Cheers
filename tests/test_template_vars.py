"""验证 HttpBotAdapter 模板变量在直接调用和 call_bot 子调用场景下均能正确渲染。"""
from __future__ import annotations

import re
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.adapters.http_bot import HttpBotAdapter
from app.services.pipeline.bot.context import BotRunContext
from app.services.pipeline.process_config import ProcessConfig

# ── helpers ──────────────────────────────────────────────────────────────────

def _make_bot(
    *,
    username: str = "test_bot",
    display_name: str = "测试Bot",
    custom_system_prompt: str | None = None,
    system_prompt: str = "你是助手",
    user_template: str = "{{message}}",
    model_name: str = "test-model",
    base_url: str = "http://fake:1234/v1",
) -> SimpleNamespace:
    """构建一个供 HttpBotAdapter 使用的最小 bot 桩对象。"""
    template = SimpleNamespace(
        system_prompt=system_prompt,
        user_template=user_template,
    )
    model = SimpleNamespace(
        model_name=model_name,
        provider="test",
        base_url=base_url,
        api_key=None,
        config={},
    )
    return SimpleNamespace(
        bot_id="bot-001",
        username=username,
        display_name=display_name,
        custom_system_prompt=custom_system_prompt,
        ai_model=model,
        prompt_template=template,
    )


class _FakeWriter:
    def __init__(self) -> None:
        self.finalized: list[tuple[object, str]] = []

    async def pre_create(self, bot_id: str, task_id: str):
        return SimpleNamespace(msg_id=f"placeholder-{bot_id}")

    async def finalize(self, msg, content: str, *, file_ids=None) -> None:
        self.finalized.append((msg, content))

    async def record_task(self, bot_id: str, msg_id: str) -> None:
        pass


def _make_call_bot_run_ctx(
    *,
    bot_id_by_username: dict[str, str],
    adapter_factory,
    memory: dict[str, str],
    task_id: str,
    channel_id: str,
    sender_id: str,
    sender_name: str,
    channel_name: str,
    attachments: list[dict[str, str]] | None = None,
    original_question_text: str | None = None,
) -> BotRunContext:
    trigger_msg = SimpleNamespace(
        msg_id=f"trigger-{task_id}",
        sender_id=sender_id,
        in_reply_to_msg_id=None,
        msg_type="normal",
        created_at=None,
    )
    ctx = BotRunContext(
        channel_id=channel_id,
        bus=SimpleNamespace(publish=lambda event: None),
        session=SimpleNamespace(),
        trigger_msg=trigger_msg,
        adapter_factory=adapter_factory,
        root_task_id=task_id,
    )
    ctx.writer = _FakeWriter()
    ctx.channel_bot_usernames = list(bot_id_by_username.keys())
    ctx.bot_id_by_username = dict(bot_id_by_username)
    ctx.bot_details_by_username = {
        username: {"display_name": username}
        for username in bot_id_by_username
    }
    ctx.memory_context = dict(memory)
    ctx.attachments = attachments or []
    ctx.original_question = original_question_text
    ctx.trigger_content = original_question_text or ""
    ctx.sender_name = sender_name
    ctx.channel_name = channel_name
    return ctx


# ── _apply_user_template 单元测试 ────────────────────────────────────────────

class TestApplyUserTemplate:
    """直接测试 _apply_user_template 渲染逻辑。"""

    def _adapter(self, user_template: str = "{{message}}") -> HttpBotAdapter:
        bot = _make_bot(user_template=user_template)
        return HttpBotAdapter(bot)  # type: ignore[arg-type]

    def test_basic_message(self) -> None:
        adapter = self._adapter("用户说：{{message}}")
        result = adapter._apply_user_template("你好")
        assert result == "用户说：你好"

    def test_channel_name(self) -> None:
        adapter = self._adapter("频道：{{channel_name}} 消息：{{message}}")
        result = adapter._apply_user_template("hello", {"channel_name": "项目A"})
        assert result == "频道：项目A 消息：hello"

    def test_sender_name(self) -> None:
        adapter = self._adapter("{{sender_name}}说：{{message}}")
        result = adapter._apply_user_template("hello", {"sender_name": "张三"})
        assert result == "张三说：hello"

    def test_bot_name(self) -> None:
        adapter = self._adapter("我是{{bot_name}}，你的消息：{{message}}")
        result = adapter._apply_user_template("hello", {"bot_name": "代码助手"})
        assert result == "我是代码助手，你的消息：hello"

    def test_channel_id(self) -> None:
        adapter = self._adapter("channel={{channel_id}} {{message}}")
        result = adapter._apply_user_template("hi", {"channel_id": "ch-123"})
        assert result == "channel=ch-123 hi"

    def test_timestamp(self) -> None:
        adapter = self._adapter("[{{timestamp}}] {{message}}")
        result = adapter._apply_user_template("hi", {"timestamp": "2026-01-01T00:00:00Z"})
        assert result == "[2026-01-01T00:00:00Z] hi"

    def test_memory_vars(self) -> None:
        tpl = "锚点：{{anchor}}\n进度：{{progress}}\n决策：{{decisions}}\n索引：{{files_index}}\n近况：{{recent}}\n待办：{{todos}}\n问题：{{message}}"
        adapter = self._adapter(tpl)
        ctx = {
            "anchor": "<anchor>项目目标</anchor>",
            "progress": "<progress>已完成50%</progress>",
            "decisions": "<decisions>用React</decisions>",
            "files_index": "<files_index>README.md</files_index>",
            "recent": "<recent>昨天讨论了架构</recent>",
            "todos": "- 写测试",
        }
        result = adapter._apply_user_template("什么进度？", ctx)
        assert "项目目标" in result
        assert "已完成50%" in result
        assert "用React" in result
        assert "README.md" in result
        assert "昨天讨论了架构" in result
        assert "写测试" in result
        assert "什么进度？" in result

    def test_all_vars_combined(self) -> None:
        """模板同时使用所有变量，确保无遗漏。"""
        tpl = (
            "bot={{bot_name}} sender={{sender_name}} channel={{channel_name}} "
            "cid={{channel_id}} ts={{timestamp}} "
            "anchor={{anchor}} progress={{progress}} decisions={{decisions}} "
            "files={{files_index}} recent={{recent}} todos={{todos}} "
            "msg={{message}}"
        )
        adapter = self._adapter(tpl)
        ctx = {
            "bot_name": "助手",
            "sender_name": "李四",
            "channel_name": "频道X",
            "channel_id": "ch-999",
            "timestamp": "T0",
            "anchor": "A",
            "progress": "P",
            "decisions": "D",
            "files_index": "F",
            "recent": "R",
            "todos": "TD",
        }
        result = adapter._apply_user_template("问题", ctx)
        # 不应残留任何 {{xxx}} 占位符
        assert "{{" not in result
        assert "}}" not in result
        assert "bot=助手" in result
        assert "sender=李四" in result
        assert "channel=频道X" in result
        assert "msg=问题" in result

    def test_unknown_var_kept(self) -> None:
        """模板中含未知变量时保留原始占位符。"""
        adapter = self._adapter("{{unknown_var}} {{message}}")
        result = adapter._apply_user_template("hi")
        assert "{{unknown_var}}" in result
        assert "hi" in result


# ── HttpBotAdapter.execute 集成测试（模拟 HTTP） ──────────────────────────────

UNRENDERED_VAR_PATTERN = re.compile(r"\{\{(\w+)\}\}")


@pytest.mark.asyncio
async def test_execute_renders_all_context_vars() -> None:
    """验证 execute() 构建的 messages 中模板变量全部被渲染。"""
    user_template = (
        "频道={{channel_name}} 发送者={{sender_name}} Bot={{bot_name}} "
        "频道ID={{channel_id}} 时间={{timestamp}} "
        "锚点={{anchor}} 进度={{progress}} 决策={{decisions}} "
        "索引={{files_index}} 近况={{recent}} 待办={{todos}} "
        "消息={{message}}"
    )
    bot = _make_bot(user_template=user_template)
    adapter = HttpBotAdapter(bot)  # type: ignore[arg-type]

    payload = AgentPayload(
        task_id="task-tmpl",
        channel_id="ch-tmpl",
        trigger_message={
            "user": "user-001",
            "sender_name": "王五",
            "text": "模板测试消息",
            "timestamp": "2026-04-14T10:00:00Z",
        },
        memory_context={
            "anchor": "项目锚点",
            "progress": "进行中",
            "decisions": "决策A",
            "files_index": "file1.md",
            "recent": "最近活动",
            "todos": "- TODO1",
        },
        process_config=ProcessConfig(
            sender_name="王五",
            channel_name="测试频道",
        ),
    )

    captured_body: dict = {}

    # http_bot now always streams via client.stream("POST", ...) used as
    # an async context manager. Build a fake SSE response that yields a
    # single chunk + [DONE].
    class _FakeStreamResponse:
        headers = {"content-type": "text/event-stream"}

        def raise_for_status(self) -> None:
            return None

        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"ok"}}]}'
            yield "data: [DONE]"

        async def aread(self) -> bytes:
            return b""

    class _FakeStreamCtx:
        def __init__(self, body: dict) -> None:
            self._body = body

        async def __aenter__(self) -> _FakeStreamResponse:
            return _FakeStreamResponse()

        async def __aexit__(self, *exc_info) -> None:
            return None

    def _fake_stream(method, url, *, json, headers, timeout):
        captured_body.update(json)
        return _FakeStreamCtx(json)

    mock_client = MagicMock()
    mock_client.stream = _fake_stream

    with patch("app.services.adapters.http_bot.get_http_client", return_value=mock_client):
        resp = await adapter.execute(payload)

    assert resp.success is True

    # 直接调用（非子 bot）应包含 system prompt
    messages = captured_body.get("messages", [])
    assert len(messages) == 2, f"直接调用应有 system + user 两条消息，实际 {len(messages)}"
    assert messages[0]["role"] == "system"
    assert messages[0]["content"].endswith("你是助手")

    user_content = messages[1]["content"]
    assert isinstance(user_content, str)

    # 所有已知变量都不应残留为 {{xxx}}
    unrendered = UNRENDERED_VAR_PATTERN.findall(user_content)
    assert unrendered == [], f"未渲染的模板变量: {unrendered}"

    # 验证具体值
    assert "测试频道" in user_content, "channel_name 未渲染"
    assert "王五" in user_content, "sender_name 未渲染"
    assert "测试Bot" in user_content, "bot_name 未渲染"
    assert "ch-tmpl" in user_content, "channel_id 未渲染"
    assert "2026-04-14T10:00:00Z" in user_content, "timestamp 未渲染"
    assert "项目锚点" in user_content, "anchor 未渲染"
    assert "进行中" in user_content, "progress 未渲染"
    assert "决策A" in user_content, "decisions 未渲染"
    assert "file1.md" in user_content, "files_index 未渲染"
    assert "最近活动" in user_content, "recent 未渲染"
    assert "TODO1" in user_content, "todos 未渲染"
    assert "模板测试消息" in user_content, "message 未渲染"


@pytest.mark.asyncio
async def test_call_bot_passes_context_to_sub_bot() -> None:
    """验证 call_bot 构建的 sub_payload 包含 channel_name 和 sender_name，
    使子 bot 的模板变量能正确渲染。"""
    from app.services.adapters.channel_bot import _make_tools

    captured_payload: list[AgentPayload] = []

    async def _fake_adapter_factory(bot_id: str):
        """返回一个捕获 payload 的假 adapter。"""
        class _CapturingAdapter(OpenClawAdapter):
            async def execute(self, payload: AgentPayload) -> AgentResponse:
                captured_payload.append(payload)
                return AgentResponse(content="子bot回复", task_id=payload.task_id, success=True)

            async def health_check(self) -> bool:
                return True
        return _CapturingAdapter()

    run_ctx = _make_call_bot_run_ctx(
        channel_id="ch-call",
        bot_id_by_username={"child_bot": "bot-child-001"},
        adapter_factory=_fake_adapter_factory,
        memory={"anchor": "锚点内容", "progress": "进度内容"},
        task_id="task-parent",
        sender_id="user-parent",
        sender_name="赵六",
        channel_name="协作频道",
        original_question_text="原始问题",
    )
    ctx = {
        "channel_id": "ch-call",
        "memory": {"anchor": "锚点内容", "progress": "进度内容"},
        "_run_ctx": run_ctx,
    }

    tools = _make_tools(ctx)
    call_bot_tool = next(t for t in tools if t.name == "call_bot")

    result = await call_bot_tool.ainvoke({"username": "child_bot", "message": "帮我分析一下"})
    assert "子bot回复" in result

    # 验证子 payload
    assert len(captured_payload) == 1
    sub = captured_payload[0]

    # process_config 应包含 channel_name、sender_name 和 skip_system_prompt
    pc = sub.process_config
    assert pc.channel_name == "协作频道", f"channel_name 缺失或不正确: {pc}"
    assert pc.sender_name == "赵六", f"sender_name 缺失或不正确: {pc}"
    assert pc.skip_system_prompt is True, f"skip_system_prompt 应为 True: {pc}"

    # trigger_message 应包含 sender_name 和非空 timestamp
    tm = sub.trigger_message or {}
    assert tm.get("sender_name") == "赵六", f"trigger_message.sender_name 缺失: {tm}"
    assert tm.get("timestamp"), f"trigger_message.timestamp 为空: {tm}"

    # memory 应透传
    assert sub.memory_context.get("anchor") == "锚点内容"
    assert sub.memory_context.get("progress") == "进度内容"


# ── orchestrator process_config 一致性测试 ──────────────────────────────────
#
# Phase 5: process_config is now a typed ProcessConfig dataclass; the
# legacy meta-test that grepped service.py for ``process_config={...}``
# dict literals is obsolete because:
#   1. service.py no longer constructs process_config — the construction
#      moved to pipeline/bot/subagent.py:build_payload.
#   2. ProcessConfig has typed fields, so a typo on sender_name /
#      channel_name is a static type error rather than a runtime miss.
# (Removed test_orchestrator_process_config_has_template_keys.)


# ── call_bot → HttpBotAdapter 端到端模板渲染 ──────────────────────────────────

@pytest.mark.asyncio
async def test_call_bot_end_to_end_renders_all_vars() -> None:
    """call_bot 调用 HttpBotAdapter 子 bot 时，模板中所有变量均被正确渲染。"""
    from app.services.adapters.channel_bot import _make_tools

    all_vars_template = (
        "频道={{channel_name}} 发送者={{sender_name}} Bot={{bot_name}} "
        "频道ID={{channel_id}} 时间={{timestamp}} "
        "锚点={{anchor}} 进度={{progress}} 决策={{decisions}} "
        "索引={{files_index}} 近况={{recent}} 待办={{todos}} "
        "消息={{message}}"
    )
    child_bot = _make_bot(
        username="child_bot",
        display_name="子Bot",
        user_template=all_vars_template,
    )

    captured_body: dict = {}

    class _FakeStreamResponse:
        headers = {"content-type": "application/json"}

        def raise_for_status(self) -> None:
            return None

        async def aread(self) -> bytes:
            return b'{"choices":[{"message":{"content":"\xe5\xad\x90bot\xe6\x89\xa7\xe8\xa1\x8c\xe6\x88\x90\xe5\x8a\x9f"}}]}'

    class _FakeStreamCtx:
        async def __aenter__(self) -> _FakeStreamResponse:
            return _FakeStreamResponse()

        async def __aexit__(self, *exc_info) -> None:
            return None

    def _fake_stream(method, url, *, json, headers, timeout):
        captured_body.update(json)
        return _FakeStreamCtx()

    mock_client = MagicMock()
    mock_client.stream = _fake_stream

    async def _fake_adapter_factory(bot_id: str):
        adapter = HttpBotAdapter(child_bot)  # type: ignore[arg-type]
        return adapter

    memory = {
        "anchor": "E2E锚点",
        "progress": "E2E进度",
        "decisions": "E2E决策",
        "files_index": "E2E索引",
        "recent": "E2E近况",
        "todos": "E2E待办",
    }
    run_ctx = _make_call_bot_run_ctx(
        channel_id="ch-e2e",
        bot_id_by_username={"child_bot": "bot-child-e2e"},
        adapter_factory=_fake_adapter_factory,
        memory=memory,
        task_id="task-e2e",
        sender_id="user-e2e",
        sender_name="端到端用户",
        channel_name="端到端频道",
    )
    ctx = {
        "channel_id": "ch-e2e",
        "memory": memory,
        "_run_ctx": run_ctx,
    }

    tools = _make_tools(ctx)
    call_bot_tool = next(t for t in tools if t.name == "call_bot")

    with patch("app.services.adapters.http_bot.get_http_client", return_value=mock_client):
        result = await call_bot_tool.ainvoke({"username": "child_bot", "message": "端到端测试"})

    assert "子bot执行成功" in result

    # 子 bot 调用不应有 system prompt
    messages = captured_body.get("messages", [])
    assert len(messages) == 1, f"子 bot 调用应只有 user 消息，实际 {len(messages)} 条: {[m['role'] for m in messages]}"
    assert messages[0]["role"] == "user", "子 bot 调用的唯一消息应为 user role"

    user_content = messages[0]["content"]
    unrendered = UNRENDERED_VAR_PATTERN.findall(user_content)
    assert unrendered == [], f"未渲染的模板变量: {unrendered}"

    assert "端到端频道" in user_content, "channel_name 未渲染"
    assert "端到端用户" in user_content, "sender_name 未渲染"
    assert "子Bot" in user_content, "bot_name 未渲染"
    assert "ch-e2e" in user_content, "channel_id 未渲染"
    assert "E2E锚点" in user_content, "anchor 未渲染"
    assert "E2E进度" in user_content, "progress 未渲染"
    assert "E2E决策" in user_content, "decisions 未渲染"
    assert "E2E索引" in user_content, "files_index 未渲染"
    assert "E2E近况" in user_content, "recent 未渲染"
    assert "E2E待办" in user_content, "todos 未渲染"
    assert "端到端测试" in user_content, "message 未渲染"
    # timestamp 由 call_bot 自动生成，只需确认非空
    assert "时间=" in user_content and "时间={{timestamp}}" not in user_content, "timestamp 未渲染"
