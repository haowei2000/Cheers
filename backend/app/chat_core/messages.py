"""消息 REST 与 WebSocket 路由."""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_core.schemas import MessageCreate, MessageInResponse
from app.chat_core.ws_manager import ws_manager
from app.db.models import Channel, Message
from app.db.session import get_session
from app.guide.constants import GUIDE_BOT_ID
from app.orchestrator.adapter_resolver import get_adapter_for_bot
from app.orchestrator.service import run_orchestrator

logger = logging.getLogger("app.chat_core.messages")
router = APIRouter(prefix="/api/channels", tags=["messages"])


class GuideReplyBody(BaseModel):
    """引导 Bot 跟帖回复（如表单提交后的结果提示）."""
    content: str


@router.get("/{channel_id}/messages")
async def list_messages(
    channel_id: str,
    limit: int = 50,
    before_msg_id: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取频道消息历史（分页：before_msg_id 之前的 limit 条）."""
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    q = select(Message).where(Message.channel_id == channel_id).order_by(Message.created_at.desc())
    if before_msg_id:
        q = q.where(Message.msg_id < before_msg_id)
    q = q.limit(limit)
    result = await session.execute(q)
    messages = list(result.scalars().all())
    messages.reverse()
    items = []
    for m in messages:
        d = MessageInResponse.model_validate(m).model_dump()
        if m.created_at:
            d["created_at"] = m.created_at.isoformat()
        items.append(d)
    return {"status": "success", "data": items}


@router.post("/{channel_id}/messages")
async def create_message(
    channel_id: str,
    body: MessageCreate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """发送消息并持久化，并广播到频道 WebSocket."""
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    msg = Message(
        channel_id=channel_id,
        sender_id=body.sender_id,
        sender_type=body.sender_type,
        content=body.content,
        file_ids=body.file_ids or [],
        mention_bot_ids=body.mention_bot_ids or [],
    )
    session.add(msg)
    await session.flush()
    d = MessageInResponse.model_validate(msg).model_dump()
    if msg.created_at:
        d["created_at"] = msg.created_at.isoformat()
    await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": d})

    # 若消息中有 @Bot 或开启 Orchestrator 直接回答，触发 Orchestrator（串行执行，回写 Bot 消息并广播）
    async def broadcast_bot_processing(ch_id: str, bot_id: str, username: str) -> None:
        await ws_manager.broadcast_to_channel(ch_id, {"type": "bot_processing", "data": {"bot_id": bot_id, "username": username}})

    bot_messages = []
    try:
        bot_messages = await run_orchestrator(
            channel_id, msg, session, lambda bid: get_adapter_for_bot(bid, session), broadcast_processing=broadcast_bot_processing
        )
    except Exception as e:
        logger.exception("orchestrator failed channel_id=%s: %s", channel_id, e)

    bot_message_dicts: list[dict] = []
    for bm in bot_messages:
        bd = MessageInResponse.model_validate(bm).model_dump()
        if bm.created_at:
            bd["created_at"] = bm.created_at.isoformat()
        bot_message_dicts.append(bd)
        await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": bd})

    # RECENT 层异步更新（不阻塞主消息流）
    if bot_messages:
        from app.memory.recent_update import schedule_recent_update
        schedule_recent_update(channel_id)

    return {"status": "success", "data": d, "bot_messages": bot_message_dicts}


@router.post("/{channel_id}/guide-reply")
async def guide_reply(
    channel_id: str,
    body: GuideReplyBody,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """由引导 Bot 在频道内发送一条跟帖（如表单完成后结果）；供前端在对话中展示."""
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    msg = Message(
        channel_id=channel_id,
        sender_id=GUIDE_BOT_ID,
        sender_type="bot",
        content=body.content.strip(),
    )
    session.add(msg)
    await session.flush()
    d = MessageInResponse.model_validate(msg).model_dump()
    if msg.created_at:
        d["created_at"] = msg.created_at.isoformat()
    await ws_manager.broadcast_to_channel(channel_id, {"type": "message", "data": d})
    return {"status": "success", "data": d}
