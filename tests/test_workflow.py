"""Unified workflow planning tests."""
from __future__ import annotations

import logging

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Channel, ChannelMembership, Message, PromptTemplate, User, Workspace
from app.features.bot_runtime.pipeline.bot import BotRunContext, run_bot_pipeline
from app.features.bot_runtime.pipeline.bus import NullEventBus
from app.features.bot_runtime.pipeline.ingest.context import IngestContext
from app.features.bot_runtime.pipeline.workflow import build_bot_workflow, build_message_workflow


async def _unused_adapter_factory(bot_id: str):  # pragma: no cover - planning-only tests
    raise AssertionError(f"adapter factory should not be called: {bot_id}")


def test_pipeline_bot_public_entrypoints_are_exported() -> None:
    from app.features.bot_runtime.pipeline import bot

    expected = {
        "build_bot_workflow",
        "enqueue_bot_pipeline_job",
        "get_adapter_for_bot",
        "run_bot_pipeline",
        "start_bot_pipeline_workers",
        "stop_bot_pipeline_workers",
    }

    assert expected.issubset(set(bot.__all__))
    for name in expected:
        assert getattr(bot, name) is not None


def test_normal_message_builds_unified_write_workflow() -> None:
    ctx = IngestContext(
        channel_id="workflow-normal-ch",
        bus=NullEventBus(),
        session=None,
        sender_id="user-1",
        sender_type="user",
        content="plain message",
    )

    plan = build_message_workflow(ctx, bot_trigger="enqueue")

    assert ctx.workflow is plan
    assert plan.message_kind == "normal"
    assert plan.bot_trigger == "enqueue"
    assert plan.secret_mode == "plain"
    assert plan.stage_names == [
        "ValidateStage",
        "SecretEnvelopeStage",
        "PersistStage",
        "SerializeStage",
        "CommitStage",
        "EmitStage",
        "FanoutUnreadStage",
    ]


def test_secret_reply_message_builds_unified_write_workflow() -> None:
    ctx = IngestContext(
        channel_id="workflow-secret-ch",
        bus=NullEventBus(),
        session=None,
        sender_id="user-1",
        sender_type="user",
        content="secret",
        in_reply_to_msg_id="parent-1",
        is_secret=True,
        skip_commit=True,
        skip_fanout=True,
    )

    plan = build_message_workflow(ctx, bot_trigger="inline")

    assert plan.message_kind == "reply"
    assert plan.bot_trigger == "inline"
    assert plan.secret_mode == "sealed"
    assert plan.commit is False
    assert plan.fanout is False
    assert plan.stage_names == [
        "ValidateStage",
        "SecretEnvelopeStage",
        "PersistStage",
        "SerializeStage",
        "EmitStage",
    ]


async def _seed_workflow_case(
    session: AsyncSession,
    suffix: str,
    *,
    content: str,
    bot_username: str = "workflow_bot",
    channel_type: str = "public",
    auto_assist: bool = False,
    mention_bot_ids: list[str] | None = None,
    msg_type: str = "normal",
    user_template: str = "{{memory}}\n{{message}}",
) -> tuple[Channel, Message, BotAccount]:
    workspace = Workspace(workspace_id=f"workflow-ws-{suffix}", name=f"Workflow {suffix}")
    user = User(
        user_id=f"workflow-user-{suffix}",
        username=f"workflow_user_{suffix}",
        password_hash="x",
    )
    template = PromptTemplate(
        template_id=f"workflow-tpl-{suffix}",
        name=f"Workflow Template {suffix}",
        system_prompt="test",
        user_template=user_template,
        variables=["message"],
        is_builtin=False,
    )
    bot = BotAccount(
        bot_id=f"workflow-bot-{suffix}",
        username=bot_username,
        status="online",
        template_id=template.template_id,
    )
    channel = Channel(
        channel_id=f"workflow-ch-{suffix}",
        workspace_id=workspace.workspace_id,
        name=f"workflow-{suffix}",
        type=channel_type,
        auto_assist=auto_assist,
    )
    message = Message(
        msg_id=f"workflow-msg-{suffix}",
        channel_id=channel.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content=content,
        mention_bot_ids=mention_bot_ids or [],
        msg_type=msg_type,
    )
    session.add_all(
        [
            workspace,
            user,
            template,
            bot,
            channel,
            ChannelMembership(channel_id=channel.channel_id, member_id=user.user_id, member_type="user"),
            ChannelMembership(channel_id=channel.channel_id, member_id=bot.bot_id, member_type="bot"),
            message,
        ]
    )
    await session.flush()
    return channel, message, bot


async def _build(session: AsyncSession, channel: Channel, message: Message) -> BotRunContext:
    ctx = BotRunContext(
        channel_id=channel.channel_id,
        bus=NullEventBus(),
        session=session,
        trigger_msg=message,
        adapter_factory=_unused_adapter_factory,
    )
    await build_bot_workflow(ctx)
    return ctx


@pytest.mark.asyncio
async def test_explicit_mention_bot_ids_build_regular_dispatch_workflow(db_session: AsyncSession) -> None:
    channel, message, bot = await _seed_workflow_case(
        db_session,
        "explicit",
        content="front-end selected bot",
        mention_bot_ids=["workflow-bot-explicit"],
    )

    ctx = await _build(db_session, channel, message)

    assert ctx.workflow is not None
    assert ctx.workflow.route_mode == "regular"
    assert ctx.workflow.reason == "explicit_mention_bot_ids"
    assert ctx.workflow.target_usernames == [bot.username]
    assert ctx.workflow.stage_names == ["ContextLoadStage", "DispatchStage"]


@pytest.mark.asyncio
async def test_text_mention_builds_regular_dispatch_workflow(db_session: AsyncSession) -> None:
    channel, message, bot = await _seed_workflow_case(
        db_session,
        "text",
        content="@workflow_bot please help",
    )

    ctx = await _build(db_session, channel, message)

    assert ctx.workflow is not None
    assert ctx.workflow.route_mode == "regular"
    assert ctx.workflow.reason == "text_mentions"
    assert ctx.workflow.target_usernames == [bot.username]
    assert ctx.workflow.stage_names == ["ContextLoadStage", "DispatchStage"]


@pytest.mark.asyncio
async def test_dm_channel_builds_dm_bot_workflow(db_session: AsyncSession) -> None:
    channel, message, bot = await _seed_workflow_case(
        db_session,
        "dm",
        content="hello without mention",
        channel_type="dm",
    )

    ctx = await _build(db_session, channel, message)

    assert ctx.workflow is not None
    assert ctx.workflow.route_mode == "dm"
    assert ctx.workflow.reason == "dm_counterparty_bot"
    assert ctx.workflow.target_usernames == [bot.username]
    assert ctx.workflow.stage_names == ["ContextLoadStage", "DispatchStage"]


@pytest.mark.asyncio
async def test_auto_assist_builds_coordinator_workflow(db_session: AsyncSession) -> None:
    channel, message, _bot = await _seed_workflow_case(
        db_session,
        "assist",
        content="please route this",
        bot_username="Coordinator",
        auto_assist=True,
    )

    ctx = await _build(db_session, channel, message)

    assert ctx.workflow is not None
    assert ctx.workflow.route_mode == "auto_assist"
    assert ctx.workflow.reason == "channel_auto_assist"
    assert ctx.direct_answer_mode is True
    assert ctx.workflow.target_usernames == ["Coordinator"]
    assert ctx.workflow.stage_names == ["ContextLoadStage", "AutoTakeoverStage"]


@pytest.mark.asyncio
async def test_no_target_message_builds_empty_workflow(db_session: AsyncSession) -> None:
    channel, message, _bot = await _seed_workflow_case(
        db_session,
        "none",
        content="plain public message",
    )

    ctx = await _build(db_session, channel, message)

    assert ctx.workflow is not None
    assert ctx.workflow.route_mode == "none"
    assert ctx.workflow.reason == "no_targets"
    assert ctx.workflow.target_usernames == []
    assert ctx.workflow.stages == ()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("msg_type", "expected_layers"),
    [
        ("routing", frozenset({"anchor", "decisions"})),
        ("permission", frozenset({"anchor"})),
    ],
)
async def test_workflow_plan_records_narrow_memory_layers(
    db_session: AsyncSession,
    msg_type: str,
    expected_layers: frozenset[str],
) -> None:
    channel, message, _bot = await _seed_workflow_case(
        db_session,
        f"layers-{msg_type}",
        content="@workflow_bot inspect",
        msg_type=msg_type,
    )

    ctx = await _build(db_session, channel, message)

    assert ctx.workflow is not None
    assert ctx.workflow.memory_layers == expected_layers


@pytest.mark.asyncio
async def test_template_without_memory_marks_memory_unrequested(db_session: AsyncSession) -> None:
    channel, message, _bot = await _seed_workflow_case(
        db_session,
        "nomem",
        content="@workflow_bot inspect",
        user_template="{{message}}",
    )

    ctx = await _build(db_session, channel, message)

    assert ctx.workflow is not None
    assert ctx.workflow.memory_requested is False


@pytest.mark.asyncio
async def test_run_bot_pipeline_logs_built_workflow(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    channel, message, _bot = await _seed_workflow_case(
        db_session,
        "log",
        content="plain public message",
    )

    caplog.set_level(logging.INFO, logger="app.features.bot_runtime.pipeline.bot.service")
    await run_bot_pipeline(
        channel.channel_id,
        message,
        db_session,
        _unused_adapter_factory,
        event_bus=NullEventBus(),
    )

    messages = [record.getMessage() for record in caplog.records]
    assert any("bot_pipeline.workflow.built" in item for item in messages)
    assert any("'route_mode': 'none'" in item for item in messages)
    assert any("'stages': []" in item for item in messages)
