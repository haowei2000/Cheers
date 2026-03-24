"""MemoryManager / Context Store 单测."""
import pytest
from app.memory.context_store import (
    get_all_layers,
    get_layer,
    init_context_db,
    set_layer,
)


@pytest.mark.asyncio
async def test_context_store_init_and_read_write(tmp_path: pytest.TempPathFactory) -> None:
    db_path = str(tmp_path / "context.db")
    await init_context_db(db_path)
    assert await get_layer(db_path, "ch1", "ANCHOR") == ""
    await set_layer(db_path, "ch1", "ANCHOR", "项目目标：完成 M1。")
    assert await get_layer(db_path, "ch1", "ANCHOR") == "项目目标：完成 M1。"
    all_layers = await get_all_layers(db_path, "ch1")
    assert all_layers["anchor"] == "项目目标：完成 M1。"
    assert all_layers["decisions"] == ""
    assert all_layers["recent"] == ""
