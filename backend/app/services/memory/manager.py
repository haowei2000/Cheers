"""MemoryManager：四层记忆读写、上下文拼接（供 Orchestrator 注入）."""
from pathlib import Path

from app.config import settings
from app.services.memory.context_store import LAYERS, get_all_layers, get_layer, init_context_db, set_layer


def _md_dir(channel_id: str) -> Path:
    base = Path(settings.data_dir)
    if not base.is_absolute():
        base = Path(__file__).resolve().parent.parent.parent.parent / base
    return base / "context_store" / channel_id


async def load(channel_id: str) -> dict[str, str]:
    """加载频道四层记忆，键为 anchor/decisions/files_index/recent."""
    await init_context_db()
    return await get_all_layers(channel_id)


async def save_layer(channel_id: str, layer: str, content: str) -> None:
    """写入一层。layer 统一大写以与 get_all_layers 保持一致。"""
    await init_context_db()
    await set_layer(channel_id, layer.upper(), content)


async def sync_channel_to_md(channel_id: str) -> None:
    """将 DB 中该频道四层内容同步到 MD 文件（管理员可编辑）."""
    md_dir = _md_dir(channel_id)
    md_dir.mkdir(parents=True, exist_ok=True)
    for layer in LAYERS:
        content = await get_layer(channel_id, layer)
        (md_dir / f"{layer}.md").write_text(content or "", encoding="utf-8")


def build_system_prompt_prefix(channel_name: str, bot_role: str, memory: dict[str, str]) -> str:
    """拼接四层记忆为 System Prompt 前缀（详细设计 §4.3.1）."""
    return f"""你是 {bot_role}，正在参与频道「{channel_name}」的协作工作。
== 项目锚点（最高优先级，务必遵守）==
{memory.get('anchor', '')}
== 重要决策记录 ==
{memory.get('decisions', '')}
== 已上传资料索引 ==
{memory.get('files_index', '')}
== 近期频道动态 ==
{memory.get('recent', '')}
"""
