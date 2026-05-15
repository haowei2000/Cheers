"""Unit tests for MemoryManager / Context Store."""
from unittest.mock import patch
from xml.etree import ElementTree as ET

import pytest

from app.features.memory.context_store import (
    get_all_layers,
    get_layer,
    init_context_db,
    set_layer,
)
from app.features.memory.manager import build_system_prompt_prefix


@pytest.mark.asyncio
async def test_context_store_init_and_read_write() -> None:
    # Force-reset global state to keep the test isolated.
    with (
        patch("app.config.settings.context_db_url", new="sqlite+aiosqlite:///:memory:"),
        patch("app.features.memory.context_store._engine", new=None),
        patch("app.features.memory.context_store._session_factory", new=None),
        patch("app.features.memory.context_store._context_db_initialized", new=False),
    ):
        await init_context_db()
        assert await get_layer("ch1", "ANCHOR") == ""
        await set_layer("ch1", "ANCHOR", "项目目标：完成 M1。")
        assert await get_layer("ch1", "ANCHOR") == "项目目标：完成 M1。"
        all_layers = await get_all_layers("ch1")
        assert all_layers["anchor"] == "项目目标：完成 M1。"
        assert all_layers["decisions"] == ""
        assert all_layers["recent"] == ""


def test_build_system_prompt_prefix_uses_xml_memory_context() -> None:
    rendered = build_system_prompt_prefix(
        "研发频道",
        "测试 Bot",
        {
            "anchor": "项目目标",
            "decisions": "已决定使用 XML",
        },
    )

    assert "==" not in rendered
    assert "##" not in rendered
    root = ET.fromstring(rendered)
    assert root.tag == "agentnexus_context"
    assert root.find("./identity").attrib["bot_role"] == "测试 Bot"
    assert root.find("./identity").attrib["channel_name"] == "研发频道"
    assert root.find("./channel_memory/layer[@name='anchor']/content").text == "项目目标"
    assert root.find("./channel_memory/layer[@name='decisions']/content").text == "已决定使用 XML"
