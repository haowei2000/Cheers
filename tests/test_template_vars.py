"""验证 LLMBotAdapter 模板变量在直接调用和 call_bot 子调用场景下均能正确渲染。"""
from __future__ import annotations

import ast
import re
import textwrap
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.adapters.base import AgentPayload, AgentResponse
from app.services.adapters.llm_bot import LLMBotAdapter


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
    """构建一个供 LLMBotAdapter 使用的最小 bot 桩对象。"""
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


# ── _apply_user_template 单元测试 ────────────────────────────────────────────

class TestApplyUserTemplate:
    """直接测试 _apply_user_template 渲染逻辑。"""

    def _adapter(self, user_template: str = "{{message}}") -> LLMBotAdapter:
        bot = _make_bot(user_template=user_template)
        return LLMBotAdapter(bot)  # type: ignore[arg-type]

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


# ── LLMBotAdapter.execute 集成测试（模拟 HTTP） ──────────────────────────────

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
    adapter = LLMBotAdapter(bot)  # type: ignore[arg-type]

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
        process_config={
            "_sender_name": "王五",
            "_channel_name": "测试频道",
        },
    )

    captured_body: dict = {}

    # 非流式路径：client.post() 返回普通 Response
    # httpx Response 的 .json() / .raise_for_status() / .headers 均为同步
    fake_resp = MagicMock()
    fake_resp.raise_for_status = MagicMock()
    fake_resp.headers = {"content-type": "application/json"}
    fake_resp.json.return_value = {
        "choices": [{"message": {"content": "ok"}}],
    }

    async def _fake_post(url, *, json, headers, timeout):
        captured_body.update(json)
        return fake_resp

    mock_client = MagicMock()
    mock_client.post = _fake_post

    with patch("app.services.adapters.llm_bot.get_http_client", return_value=mock_client):
        resp = await adapter.execute(payload)

    assert resp.success is True

    # 检查捕获的 messages
    messages = captured_body.get("messages", [])
    assert len(messages) == 2

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
    from app.services.adapters.unified_builtin import _make_tools

    captured_payload: list[AgentPayload] = []

    async def _fake_adapter_factory(bot_id: str):
        """返回一个捕获 payload 的假 adapter。"""
        class _CapturingAdapter:
            async def execute(self, payload: AgentPayload) -> AgentResponse:
                captured_payload.append(payload)
                return AgentResponse(content="子bot回复", task_id=payload.task_id, success=True)
        return _CapturingAdapter()

    async def _fake_broadcast(bot_id: str, content: str) -> None:
        pass

    ctx = {
        "channel_id": "ch-call",
        "bot_id_by_username": {"child_bot": "bot-child-001"},
        "adapter_factory": _fake_adapter_factory,
        "create_and_broadcast": _fake_broadcast,
        "memory": {"anchor": "锚点内容", "progress": "进度内容"},
        "task_id": "task-parent",
        "sender_id": "user-parent",
        "sender_name": "赵六",
        "channel_name": "协作频道",
        "attachments": [],
        "original_question_text": "原始问题",
        "_db_session": None,
        "_bot_id": "bot-parent",
    }

    tools = _make_tools(ctx)
    call_bot_tool = next(t for t in tools if t.name == "call_bot")

    result = await call_bot_tool.ainvoke({"username": "child_bot", "message": "帮我分析一下"})
    assert "子bot回复" in result

    # 验证子 payload
    assert len(captured_payload) == 1
    sub = captured_payload[0]

    # process_config 应包含 _channel_name 和 _sender_name
    pc = sub.process_config or {}
    assert pc.get("_channel_name") == "协作频道", f"_channel_name 缺失或不正确: {pc}"
    assert pc.get("_sender_name") == "赵六", f"_sender_name 缺失或不正确: {pc}"

    # trigger_message 应包含 sender_name 和非空 timestamp
    tm = sub.trigger_message or {}
    assert tm.get("sender_name") == "赵六", f"trigger_message.sender_name 缺失: {tm}"
    assert tm.get("timestamp"), f"trigger_message.timestamp 为空: {tm}"

    # memory 应透传
    assert sub.memory_context.get("anchor") == "锚点内容"
    assert sub.memory_context.get("progress") == "进度内容"


# ── orchestrator process_config 一致性测试 ──────────────────────────────────

# 必须出现在每条路径的 process_config 中的模板相关 key
_REQUIRED_TEMPLATE_KEYS = {"_sender_name", "_channel_name"}


def _extract_process_config_blocks(source: str) -> list[tuple[int, str]]:
    """从 orchestrator/service.py 源码中提取所有 process_config={...} 字典字面量。

    返回 [(行号, 源码片段), ...]。使用简单的大括号匹配而非 AST，
    因为 process_config 值中包含运行时变量，无法用 ast.literal_eval 解析。
    """
    blocks: list[tuple[int, str]] = []
    lines = source.splitlines()
    i = 0
    while i < len(lines):
        stripped = lines[i].lstrip()
        if stripped.startswith("process_config={") or stripped.startswith("process_config= {"):
            start_line = i + 1  # 1-indexed
            # 收集到匹配的 } 为止
            depth = 0
            buf: list[str] = []
            for j in range(i, len(lines)):
                buf.append(lines[j])
                depth += lines[j].count("{") - lines[j].count("}")
                if depth == 0:
                    break
            blocks.append((start_line, "\n".join(buf)))
            i = j + 1
        else:
            i += 1
    return blocks


def test_orchestrator_process_config_has_template_keys() -> None:
    """验证 orchestrator/service.py 中所有 process_config 都包含 _sender_name 和 _channel_name。"""
    import pathlib
    src = (
        pathlib.Path(__file__).resolve().parent.parent
        / "backend" / "app" / "services" / "orchestrator" / "service.py"
    ).read_text()

    blocks = _extract_process_config_blocks(src)
    assert len(blocks) >= 3, f"预期至少 3 个 process_config 块，实际找到 {len(blocks)}"

    for line_no, block_src in blocks:
        for key in _REQUIRED_TEMPLATE_KEYS:
            assert f'"{key}"' in block_src or f"'{key}'" in block_src, (
                f"service.py 第 {line_no} 行附近的 process_config 缺少 {key}:\n{block_src}"
            )


# ── call_bot → LLMBotAdapter 端到端模板渲染 ──────────────────────────────────

@pytest.mark.asyncio
async def test_call_bot_end_to_end_renders_all_vars() -> None:
    """call_bot 调用 LLMBotAdapter 子 bot 时，模板中所有变量均被正确渲染。"""
    from app.services.adapters.unified_builtin import _make_tools

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

    fake_resp = MagicMock()
    fake_resp.raise_for_status = MagicMock()
    fake_resp.headers = {"content-type": "application/json"}
    fake_resp.json.return_value = {
        "choices": [{"message": {"content": "子bot执行成功"}}],
    }

    async def _fake_post(url, *, json, headers, timeout):
        captured_body.update(json)
        return fake_resp

    mock_client = MagicMock()
    mock_client.post = _fake_post

    async def _fake_adapter_factory(bot_id: str):
        adapter = LLMBotAdapter(child_bot)  # type: ignore[arg-type]
        return adapter

    async def _fake_broadcast(bot_id: str, content: str) -> None:
        pass

    ctx = {
        "channel_id": "ch-e2e",
        "bot_id_by_username": {"child_bot": "bot-child-e2e"},
        "adapter_factory": _fake_adapter_factory,
        "create_and_broadcast": _fake_broadcast,
        "memory": {
            "anchor": "E2E锚点",
            "progress": "E2E进度",
            "decisions": "E2E决策",
            "files_index": "E2E索引",
            "recent": "E2E近况",
            "todos": "E2E待办",
        },
        "task_id": "task-e2e",
        "sender_id": "user-e2e",
        "sender_name": "端到端用户",
        "channel_name": "端到端频道",
        "attachments": [],
        "original_question_text": None,
        "_db_session": None,
        "_bot_id": "bot-parent-e2e",
    }

    tools = _make_tools(ctx)
    call_bot_tool = next(t for t in tools if t.name == "call_bot")

    with patch("app.services.adapters.llm_bot.get_http_client", return_value=mock_client):
        result = await call_bot_tool.ainvoke({"username": "child_bot", "message": "端到端测试"})

    assert "子bot执行成功" in result

    # 验证发给 LLM 的 user message 中所有变量已渲染
    messages = captured_body.get("messages", [])
    assert len(messages) == 2, f"预期 2 条消息，实际 {len(messages)}"

    user_content = messages[1]["content"]
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
