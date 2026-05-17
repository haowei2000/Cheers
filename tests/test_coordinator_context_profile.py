"""Coordinator context-budget policy tests."""
from __future__ import annotations

from app.features.bot_runtime.coordinator_profile import build_coordinator_profile
from app.features.bot_runtime.adapters.channel_bot import _make_tools, _trim_memory_for_profile


def test_help_profile_skips_memory_and_tools() -> None:
    profile = build_coordinator_profile("怎么创建项目")

    assert profile.intent == "help"
    assert profile.include_help is True
    assert profile.memory_layers == frozenset()
    assert profile.enabled_tools == frozenset()
    assert profile.history_limit <= 4


def test_file_profile_enables_file_tool_only() -> None:
    profile = build_coordinator_profile("帮我总结这个附件", has_attachments=True)

    assert profile.intent == "file"
    assert "read_file" in profile.enabled_tools
    assert "web_search" not in profile.enabled_tools
    assert "files_index" in profile.memory_layers


def test_file_operation_without_attachment_stays_help_intent() -> None:
    profile = build_coordinator_profile("怎么上传文件")

    assert profile.intent == "help"
    assert profile.include_help is True
    assert "read_file" not in profile.enabled_tools


def test_memory_profile_enables_memory_tools() -> None:
    profile = build_coordinator_profile("请记录这个决策")

    assert profile.intent == "memory"
    assert {"update_anchor", "update_progress", "update_decision"} & profile.enabled_tools
    assert {"anchor", "progress", "decisions"}.issubset(profile.memory_layers)


def test_dynamic_tool_binding_filters_tool_set() -> None:
    tools = _make_tools({"channel_id": "ch"}, enabled_tool_names=frozenset({"call_user"}))

    assert [tool.name for tool in tools] == ["call_user"]


def test_trim_memory_profile_drops_unrequested_layers_and_clips() -> None:
    profile = build_coordinator_profile("怎么创建项目")
    memory = {
        "anchor": "A" * 100,
        "history": "H" * 100,
    }

    assert _trim_memory_for_profile(memory, profile) == {}

    project_profile = build_coordinator_profile("项目现在怎么样")
    large_memory = {
        "anchor": "A" * 3000,
        "decisions": "D" * 3000,
        "history": "H" * 3000,
    }
    trimmed = _trim_memory_for_profile(large_memory, project_profile)

    assert "decisions" not in trimmed
    assert len(trimmed["anchor"]) < len(large_memory["anchor"])
    assert "history" in trimmed
