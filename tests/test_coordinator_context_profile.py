"""Coordinator context-budget policy tests."""
from __future__ import annotations

from app.features.bot_runtime.coordinator_profile import ALL_COORDINATOR_TOOLS, build_coordinator_profile
from app.features.bot_runtime.adapters.coordinator import _make_tools, _trim_memory_for_profile


_ALL_MEMORY_LAYERS = frozenset({"anchor", "progress", "decisions", "files_index", "history", "todos"})


def test_universal_profile_includes_all_tools_and_layers() -> None:
    profile = build_coordinator_profile("怎么创建项目")

    assert profile.intent == "general"
    assert profile.include_help is True
    assert profile.memory_layers == _ALL_MEMORY_LAYERS
    assert profile.enabled_tools == ALL_COORDINATOR_TOOLS
    assert profile.help_limit == 3


def test_universal_profile_with_attachments_still_all_tools() -> None:
    profile = build_coordinator_profile("帮我总结这个附件", has_attachments=True)

    assert profile.intent == "general"
    assert "read_file" in profile.enabled_tools
    assert "web_search" in profile.enabled_tools
    assert "files_index" in profile.memory_layers


def test_universal_profile_file_operation() -> None:
    profile = build_coordinator_profile("怎么上传文件")

    assert profile.intent == "general"
    assert profile.include_help is True
    assert "read_file" in profile.enabled_tools


def test_universal_profile_memory_keywords_still_all_tools() -> None:
    profile = build_coordinator_profile("请记录这个决策")

    assert profile.intent == "general"
    assert {"update_anchor", "update_progress", "update_decision"} & profile.enabled_tools
    assert {"anchor", "progress", "decisions"}.issubset(profile.memory_layers)


def test_dynamic_tool_binding_filters_tool_set() -> None:
    tools = _make_tools({"channel_id": "ch"}, enabled_tool_names=frozenset({"call_user"}))

    assert [tool.name for tool in tools] == ["call_user"]


def test_trim_memory_profile_includes_all_layers_and_clips() -> None:
    profile = build_coordinator_profile("怎么创建项目")
    memory = {
        "anchor": "A" * 100,
        "history": "H" * 100,
    }

    trimmed = _trim_memory_for_profile(memory, profile)
    assert "anchor" in trimmed
    assert "history" in trimmed

    large_memory = {
        "anchor": "A" * 3000,
        "decisions": "D" * 3000,
        "history": "H" * 3000,
    }
    trimmed = _trim_memory_for_profile(large_memory, profile)
    assert "decisions" in trimmed
    assert len(trimmed["anchor"]) < len(large_memory["anchor"])
    assert "history" in trimmed
