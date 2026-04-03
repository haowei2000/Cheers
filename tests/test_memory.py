"""MemoryManager / Context Store 单测."""
from unittest.mock import patch

import pytest

from app.services.memory.context_store import (
    get_all_layers,
    get_layer,
    init_context_db,
    set_layer,
)


@pytest.mark.asyncio
async def test_context_store_init_and_read_write() -> None:
    # 强制重置全局状态以确保测试隔离
    with (
        patch("app.config.settings.context_db_url", new="sqlite+aiosqlite:///:memory:"),
        patch("app.services.memory.context_store._engine", new=None),
        patch("app.services.memory.context_store._session_factory", new=None),
        patch("app.services.memory.context_store._context_db_initialized", new=False),
    ):
        await init_context_db()
        assert await get_layer("ch1", "ANCHOR") == ""
        await set_layer("ch1", "ANCHOR", "项目目标：完成 M1。")
        assert await get_layer("ch1", "ANCHOR") == "项目目标：完成 M1。"
        all_layers = await get_all_layers("ch1")
        assert all_layers["anchor"] == "项目目标：完成 M1。"
        assert all_layers["decisions"] == ""
        assert all_layers["recent"] == ""
