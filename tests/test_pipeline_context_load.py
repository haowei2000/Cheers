"""ContextLoadStage layer-selection unit tests (no DB).

Locks the msg_type → layer-set mapping documented in the plan
(sharded-petting-swing.md): routing cards and permission approvals
load fewer layers than normal/reply/topic messages, with a safe
all-layers fallback for unknown types.
"""
from __future__ import annotations

from app.services.memory.channel_memory import ChannelMemory
from app.services.pipeline.bot.stages.context_load import (
    build_memory_load_detail,
    select_memory_layers,
    should_build_memory,
)


def test_normal_msg_loads_all_layers() -> None:
    assert select_memory_layers("normal") == ChannelMemory.ALL_LAYERS


def test_reply_msg_loads_all_layers() -> None:
    assert select_memory_layers("reply") == ChannelMemory.ALL_LAYERS


def test_topic_msg_loads_all_layers() -> None:
    assert select_memory_layers("topic") == ChannelMemory.ALL_LAYERS


def test_routing_card_loads_anchor_and_decisions_only() -> None:
    layers = select_memory_layers("routing")
    assert layers == frozenset({"anchor", "decisions"})
    # routing cards skip the heavy renders
    assert "files_index" not in layers
    assert "recent" not in layers
    assert "todos" not in layers
    assert "progress" not in layers


def test_permission_card_loads_anchor_only() -> None:
    layers = select_memory_layers("permission")
    assert layers == frozenset({"anchor"})


def test_unknown_msg_type_falls_back_to_all_layers() -> None:
    """Conservative default: any future msg_type that isn't in the
    explicit narrow-set list still gets the full memory context."""
    assert select_memory_layers("future_unknown_type") == ChannelMemory.ALL_LAYERS


def test_none_msg_type_falls_back_to_all_layers() -> None:
    assert select_memory_layers(None) == ChannelMemory.ALL_LAYERS


def test_all_layers_constant_covers_six_known_layers() -> None:
    """If ALL_LAYERS ever drifts, the strategy matrix needs revisiting."""
    assert ChannelMemory.ALL_LAYERS == frozenset({
        "anchor", "decisions", "progress", "files_index", "recent", "todos",
    })


def test_memory_load_detail_records_requested_layers_and_previews() -> None:
    detail = build_memory_load_detail(
        trigger_msg_id="msg-1",
        trigger_msg_type="routing",
        requested_layers=frozenset({"anchor", "decisions"}),
        memory_context={
            "anchor": "项目目标",
            "decisions": "重要决策",
            "recent": "不应被请求但可见",
        },
    )

    assert detail["kind"] == "bot_memory_load"
    assert detail["trigger_msg_id"] == "msg-1"
    assert detail["requested_layers"] == ["anchor", "decisions"]
    anchor = next(layer for layer in detail["layers"] if layer["source"] == "anchor")
    recent = next(layer for layer in detail["layers"] if layer["source"] == "recent")
    assert anchor["requested"] is True
    assert anchor["preview"] == "项目目标"
    assert recent["requested"] is False
    assert recent["chars"] == len("不应被请求但可见")
    assert recent["loader"] == "current_page + message_page summaries"


class _Ctx:
    def __init__(self, templates: dict[str, str], targets: list[str] | None = None) -> None:
        self.target_usernames = targets or list(templates.keys())
        self.bot_user_templates_by_username = templates


def test_template_with_memory_triggers_memory_build() -> None:
    ctx = _Ctx({"bot": "{{memory}}\n\n{{message}}"})
    assert should_build_memory(ctx) is True


def test_template_without_memory_skips_memory_build() -> None:
    ctx = _Ctx({"bot": "{{message}}"})
    assert should_build_memory(ctx) is False


def test_missing_template_uses_conservative_memory_build() -> None:
    ctx = _Ctx({}, targets=["builtin"])
    assert should_build_memory(ctx) is True


def test_memory_load_detail_records_skipped_memory() -> None:
    detail = build_memory_load_detail(
        trigger_msg_id="msg-2",
        trigger_msg_type="normal",
        requested_layers=frozenset(),
        memory_context={},
        memory_requested=False,
    )

    assert detail["memory_requested"] is False
    assert detail["requested_layers"] == []
