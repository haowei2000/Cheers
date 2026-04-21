"""OpenClaw channel plugin bridge 路由。

- POST /api/v1/openclaw/bridge/messages — plugin 回推 Bot 回复
- WS   /ws/openclaw/bridge                — plugin 订阅派发事件
- GET  /api/v1/openclaw/bridge/status     — 在线 plugin 数 + pending 数
- GET  /api/v1/openclaw/bridge/channels/{channel_id}/bots — 该频道下的 WebSocket Bot 清单

鉴权：共享密钥 `OPENCLAW_BRIDGE_TOKEN`（.env 配置）
  - POST/GET：Header `X-OpenClaw-Token`
  - WS：连接 URL 查询参数 `?token=...`
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.dependencies import get_session
from app.core.responses import APIResponse
from app.db.models import BotAccount, ChannelMembership
from app.services.openclaw_bridge.dispatcher import bridge_dispatcher
from app.services.openclaw_bridge.pending import pending_replies
from app.services.openclaw_bridge.service import finalize_bot_reply

logger = logging.getLogger("app.api.v1.openclaw_bridge")

router = APIRouter(prefix="/openclaw/bridge", tags=["openclaw-bridge"])


# ============================================================================
# 鉴权
# ============================================================================

def _require_bridge_enabled_and_token(token: str | None) -> None:
    if not settings.openclaw_bridge_enabled:
        raise HTTPException(status_code=503, detail="OpenClaw bridge 已禁用")
    expected = settings.openclaw_bridge_token.strip()
    if not expected:
        raise HTTPException(status_code=503, detail="OpenClaw bridge token 未配置")
    if not token or token.strip() != expected:
        raise HTTPException(status_code=401, detail="OpenClaw bridge token 无效")


async def verify_bridge_token(x_openclaw_token: str | None = Header(default=None)) -> None:
    _require_bridge_enabled_and_token(x_openclaw_token)


# ============================================================================
# Schemas
# ============================================================================

class BridgeReplyIn(BaseModel):
    bot_id: str = Field(..., description="回复的 Bot id")
    channel_id: str = Field(..., description="目标频道 id")
    content: str = Field(..., description="Bot 回复的文本内容")
    task_id: str | None = Field(default=None, description="派发事件里的 task_id，用于匹配占位消息")
    reply_to_msg_id: str | None = Field(default=None, description="明确指定要 finalize 的占位消息 id")
    in_reply_to_msg_id: str | None = Field(default=None, description="仅新建消息时使用：指向触发消息 id")
    file_ids: list[str] | None = Field(default=None, description="附件 file_ids")


# ============================================================================
# HTTP 路由
# ============================================================================

@router.get("/status", response_model=APIResponse[dict])
async def bridge_status(_: None = Depends(verify_bridge_token)) -> APIResponse:
    return APIResponse.ok({
        "enabled": settings.openclaw_bridge_enabled,
        "subscribers": bridge_dispatcher.subscriber_count(),
        "pending": pending_replies.count(),
    })


@router.post("/messages", response_model=APIResponse[dict])
async def bridge_post_reply(
    body: BridgeReplyIn,
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_bridge_token),
) -> APIResponse:
    # 校验 Bot 存在、且绑定为 websocket 类型
    bot = (await session.execute(
        select(BotAccount).where(BotAccount.bot_id == body.bot_id)
    )).scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail=f"Bot {body.bot_id} 不存在")
    if (bot.binding_type or "http") != "websocket":
        raise HTTPException(
            status_code=400,
            detail=f"Bot {body.bot_id} 不是 WebSocket Bot（binding_type={bot.binding_type}）",
        )

    msg, finalized = await finalize_bot_reply(
        session,
        bot_id=body.bot_id,
        channel_id=body.channel_id,
        content=body.content,
        task_id=body.task_id,
        reply_to_msg_id=body.reply_to_msg_id,
        in_reply_to_msg_id=body.in_reply_to_msg_id,
        file_ids=body.file_ids,
    )
    await session.commit()
    return APIResponse.ok({
        "message_id": msg.msg_id,
        "finalized_placeholder": finalized,
    })


@router.get("/channels/{channel_id}/bots", response_model=APIResponse[list[dict]])
async def bridge_list_channel_ws_bots(
    channel_id: str,
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_bridge_token),
) -> APIResponse:
    """列出该频道下所有绑定为 WebSocket 的 Bot，供 plugin 初始化时建立映射。"""
    rows = (await session.execute(
        select(BotAccount)
        .join(ChannelMembership, ChannelMembership.member_id == BotAccount.bot_id)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_type == "bot",
            BotAccount.binding_type == "websocket",
        )
    )).scalars().all()
    return APIResponse.ok([
        {
            "bot_id": b.bot_id,
            "username": b.username,
            "display_name": b.display_name,
            "binding_config": b.binding_config or {},
            "status": b.status,
        }
        for b in rows
    ])


# ============================================================================
# WebSocket 路由（由 ws_router 注册，prefix 为 /ws/openclaw/bridge）
# ============================================================================

ws_router = APIRouter()


@ws_router.websocket("/ws/openclaw/bridge")
async def bridge_websocket(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    try:
        _require_bridge_enabled_and_token(token)
    except HTTPException as exc:
        await websocket.close(code=1008, reason=exc.detail)
        return

    await websocket.accept()
    queue = await bridge_dispatcher.subscribe()
    await websocket.send_json({"type": "hello", "subscribers": bridge_dispatcher.subscriber_count()})
    logger.info("openclaw bridge ws: connected; subscribers=%d", bridge_dispatcher.subscriber_count())

    consumer_task: asyncio.Task | None = None
    try:
        async def _consume() -> None:
            while True:
                event = await queue.get()
                await websocket.send_json(event)

        consumer_task = asyncio.create_task(_consume())

        while True:
            # 允许 plugin 心跳或回 ack；目前仅消费入站以维持连接
            msg = await websocket.receive_text()
            logger.debug("openclaw bridge ws: inbound msg len=%d", len(msg or ""))
    except WebSocketDisconnect:
        logger.info("openclaw bridge ws: disconnected")
    except Exception as exc:  # noqa: BLE001
        logger.warning("openclaw bridge ws: error: %s", exc)
    finally:
        if consumer_task and not consumer_task.done():
            consumer_task.cancel()
        await bridge_dispatcher.unsubscribe(queue)
