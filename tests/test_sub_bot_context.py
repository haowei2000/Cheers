"""测试子 Bot 上下文传递优化。"""
from types import SimpleNamespace

import pytest

from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.pipeline.bot.context import BotRunContext


class _FakeWriter:
    async def pre_create(self, bot_id: str, task_id: str):
        return SimpleNamespace(msg_id="msg-001")

    async def finalize(self, msg, content: str, *, file_ids=None) -> None:
        pass

    async def record_task(self, bot_id: str, msg_id: str) -> None:
        pass


class _CapturingAdapter(OpenClawAdapter):
    def __init__(self) -> None:
        self.payloads: list[AgentPayload] = []

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        self.payloads.append(payload)
        return AgentResponse(
            content="基于项目锚点，这是一个协作平台...",
            task_id=payload.task_id,
            success=True,
        )

    async def health_check(self) -> bool:
        return True


def _make_run_ctx(*, memory_context: dict[str, str], adapter: OpenClawAdapter) -> BotRunContext:
    async def adapter_factory(bot_id: str):
        return adapter

    trigger_msg = SimpleNamespace(
        msg_id="trigger-msg-001",
        sender_id="user-001",
        in_reply_to_msg_id=None,
        msg_type="normal",
        created_at=None,
    )
    ctx = BotRunContext(
        channel_id="test-channel-001",
        bus=SimpleNamespace(publish=lambda event: None),
        session=SimpleNamespace(),
        trigger_msg=trigger_msg,
        adapter_factory=adapter_factory,
        root_task_id="test-task-001",
    )
    ctx.writer = _FakeWriter()
    ctx.channel_bot_usernames = ["codebot"]
    ctx.bot_id_by_username = {"codebot": "bot-code-001"}
    ctx.bot_details_by_username = {"codebot": {"display_name": "Code Bot"}}
    ctx.trigger_content = "请帮我分析这个项目"
    ctx.sender_name = "测试用户"
    ctx.channel_name = "测试频道"
    ctx.memory_context = memory_context
    ctx.attachments = []
    return ctx


@pytest.mark.asyncio
async def test_call_bot_passes_memory_context():
    """验证 call_bot 工具正确传递四层记忆给子 Bot。"""
    # 模拟完整的四层记忆上下文
    memory_context = {
        "anchor": "项目目标：构建协作平台",
        "decisions": "决策 1: 使用 SQLite\n决策 2: 采用四层记忆架构",
        "files_index": "file-001: 需求文档.md - 系统需求规格说明",
        "recent": "用户 A: 怎么创建项目？\nBot: 点击左上角 + 号...",
    }

    sub_adapter = _CapturingAdapter()
    run_ctx = _make_run_ctx(memory_context=memory_context, adapter=sub_adapter)
    tool_ctx = {
        "channel_id": "test-channel-001",
        "memory": memory_context,
        "_run_ctx": run_ctx,
    }

    from app.services.adapters.channel_bot import _make_tools

    tools = _make_tools(tool_ctx)
    call_bot_tool = next(t for t in tools if t.name == "call_bot")

    result = await call_bot_tool.ainvoke({"username": "codebot", "message": "请审查代码"})

    assert len(sub_adapter.payloads) == 1
    call_args = sub_adapter.payloads[0]

    # 验证四层记忆被正确传递给子 Bot
    assert isinstance(call_args, AgentPayload)
    assert call_args.memory_context == memory_context
    assert call_args.memory_context["anchor"] == "项目目标：构建协作平台"
    assert call_args.memory_context["decisions"] == "决策 1: 使用 SQLite\n决策 2: 采用四层记忆架构"
    assert call_args.memory_context["files_index"] == "file-001: 需求文档.md - 系统需求规格说明"
    assert call_args.memory_context["recent"] == "用户 A: 怎么创建项目？\nBot: 点击左上角 + 号..."

    # 验证返回结果包含子 Bot 的回复
    assert "@codebot 回复：" in result
    assert "基于项目锚点" in result


@pytest.mark.asyncio
async def test_call_bot_sub_bot_receives_decrypted_secret_parent_text():
    """加密父消息解密后，Coordinator 通过 call_bot 委托子 Bot 时，
    子 Bot payload 中应是明文任务，而不是入库占位符。"""
    memory_context = {
        "anchor": "",
        "decisions": "",
        "files_index": "",
        "recent": "",
    }
    sub_adapter = _CapturingAdapter()
    run_ctx = _make_run_ctx(memory_context=memory_context, adapter=sub_adapter)
    plaintext = "@Coordinator 请让 @codebot 处理这条加密任务"
    run_ctx.trigger_content = plaintext
    run_ctx.trigger_msg.content = "🔒 [加密消息]"
    run_ctx.trigger_msg.is_secret = True
    run_ctx.trigger_msg.secret_encrypted = "enc:test-ciphertext"

    tool_ctx = {
        "channel_id": "test-channel-001",
        "memory": memory_context,
        "_run_ctx": run_ctx,
    }

    from app.services.adapters.channel_bot import _make_tools

    tools = _make_tools(tool_ctx)
    call_bot_tool = next(t for t in tools if t.name == "call_bot")

    await call_bot_tool.ainvoke({"username": "codebot", "message": plaintext})

    assert len(sub_adapter.payloads) == 1
    trigger_message = sub_adapter.payloads[0].trigger_message
    assert trigger_message["text"] == plaintext
    assert trigger_message["text"] != "🔒 [加密消息]"


@pytest.mark.asyncio
async def test_http_bot_receives_memory_as_template_vars():
    """验证 HTTP Bot 将记忆上下文注入为模板变量。"""
    from app.db.models import AIModel, BotAccount, PromptTemplate
    from app.services.adapters.http_bot import HttpBotAdapter

    # 创建测试 Bot（使用记忆变量的模板）
    model = AIModel(
        model_id="model-test",
        name="Test Model",
        provider="openai",
        model_name="gpt-4o",
        base_url="https://api.openai.com/v1",
        api_key="test-key",
    )

    template = PromptTemplate(
        template_id="template-test",
        name="Test Template",
        system_prompt="你是一个专业的助手",
        user_template="{{memory}}\n\n用户问题：{{message}}",
        variables=["memory", "message"],
    )

    bot = BotAccount(
        bot_id="bot-test",
        username="testbot",
        ai_model=model,
        prompt_template=template,
    )

    adapter = HttpBotAdapter(bot)

    # 准备带四层记忆的 payload
    memory_context = {
        "anchor": "锚点内容",
        "decisions": "决策内容",
        "files_index": "文件索引内容",
        "recent": "近期动态内容",
    }

    # 验证_build_messages 会通过 {{memory}} 渲染记忆
    from app.services.adapters.prompt_template import render_memory_context

    messages = adapter._build_messages("你好", {"memory": render_memory_context(memory_context)})

    assert len(messages) == 2
    assert messages[0]["role"] == "system"
    assert messages[0]["content"].endswith("你是一个专业的助手")

    user_content = messages[1]["content"]
    assert "锚点内容" in user_content
    assert "决策内容" in user_content
    assert "文件索引内容" in user_content
    assert "近期动态内容" in user_content
    assert "用户问题：你好" in user_content
