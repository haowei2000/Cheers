"""OpenClaw channel plugin bridge 路由。

- POST /api/v1/openclaw/bridge/messages — plugin 回推 Bot 回复
- WS   /ws/openclaw/bridge                — plugin 订阅派发事件（需 subscribe 握手）
- GET  /api/v1/openclaw/bridge/status     — 在线 plugin 数 + pending 数
- GET  /api/v1/openclaw/bridge/channels/{channel_id}/bots — 该频道下的 WebSocket Bot 清单（精简字段）

鉴权：共享密钥 `OPENCLAW_BRIDGE_TOKEN`（.env 配置）
  - POST/GET：Header `X-OpenClaw-Token`
  - WS：连接 URL 查询参数 `?token=...`

写入校验（第一阶段最小安全补丁）：
  - POST /messages：目标 Bot 必须是频道成员、状态 online；file_ids 必须在同频道；
    in_reply_to_msg_id 必须指向同频道内消息。
  - GET /channels/{id}/bots：不回 binding_config，只暴露公共字段。
  - WS 订阅必须在握手时声明 bot_ids，dispatcher 定向推送，未声明前不收事件。
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.dependencies import get_session
from app.core.responses import APIResponse
from app.db.models import BotAccount, ChannelMembership, FileRecord, Message
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
    file_ids: list[str] | None = Field(default=None, description="附件 file_ids（必须在目标频道内）")


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


async def _assert_bot_in_channel(
    session: AsyncSession, *, bot_id: str, channel_id: str,
) -> None:
    row = (await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_id == bot_id,
            ChannelMembership.member_type == "bot",
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=403,
            detail=f"Bot {bot_id} 不在频道 {channel_id} 的成员中",
        )


async def _assert_files_in_channel(
    session: AsyncSession, *, file_ids: list[str], channel_id: str,
) -> None:
    if not file_ids:
        return
    rows = (await session.execute(
        select(FileRecord.file_id, FileRecord.channel_id).where(FileRecord.file_id.in_(file_ids))
    )).all()
    found = {fid: cid for fid, cid in rows}
    missing = [f for f in file_ids if f not in found]
    if missing:
        raise HTTPException(status_code=404, detail=f"file_ids 不存在: {missing}")
    cross = [f for f in file_ids if found[f] != channel_id]
    if cross:
        raise HTTPException(
            status_code=403,
            detail=f"file_ids 不属于目标频道 {channel_id}: {cross}",
        )


async def _assert_in_reply_same_channel(
    session: AsyncSession, *, msg_id: str, channel_id: str,
) -> None:
    parent = (await session.execute(
        select(Message.channel_id).where(Message.msg_id == msg_id)
    )).scalar_one_or_none()
    if parent is None:
        raise HTTPException(status_code=404, detail=f"in_reply_to_msg_id 不存在: {msg_id}")
    if parent != channel_id:
        raise HTTPException(
            status_code=403,
            detail="in_reply_to_msg_id 指向的消息不在目标频道内",
        )


@router.post("/messages", response_model=APIResponse[dict])
async def bridge_post_reply(
    body: BridgeReplyIn,
    session: AsyncSession = Depends(get_session),
    _: None = Depends(verify_bridge_token),
) -> APIResponse:
    # 1) Bot 存在 + 类型 websocket + 在线
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
    if bot.status != "online":
        raise HTTPException(
            status_code=409,
            detail=f"Bot {body.bot_id} 状态为 {bot.status}，不接受消息",
        )

    # 2) Bot 必须是目标频道成员
    await _assert_bot_in_channel(session, bot_id=body.bot_id, channel_id=body.channel_id)

    # 3) 附件必须在目标频道
    if body.file_ids:
        await _assert_files_in_channel(session, file_ids=body.file_ids, channel_id=body.channel_id)

    # 4) in_reply_to_msg_id 必须指向同频道消息（仅新建消息路径相关，
    #    finalize 占位消息时 in_reply_to 已在 pre_create 时设好，此字段被忽略）
    if body.in_reply_to_msg_id:
        await _assert_in_reply_same_channel(
            session, msg_id=body.in_reply_to_msg_id, channel_id=body.channel_id,
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
    """列出该频道下绑定为 WebSocket 的 Bot。

    精简字段：仅暴露 bot_id / username / display_name / status。
    敏感 binding_config 不回显（留待 per-plugin 凭证上线后按配额回拉）。
    """
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
            "status": b.status,
        }
        for b in rows
    ])


# ============================================================================
# WebSocket 路由
# ============================================================================

ws_router = APIRouter()

_SUBSCRIBE_TIMEOUT_SECONDS = 10


async def _resolve_subscribable_bot_ids(
    session: AsyncSession, requested: list[str],
) -> tuple[list[str], list[str]]:
    """过滤 plugin 声明的 bot_ids：只保留确实存在且 binding_type='websocket' 的。

    Returns: (accepted, rejected)
    """
    if not requested:
        return [], []
    rows = (await session.execute(
        select(BotAccount.bot_id).where(
            BotAccount.bot_id.in_(requested),
            BotAccount.binding_type == "websocket",
        )
    )).all()
    accepted = {r[0] for r in rows}
    rejected = [b for b in requested if b not in accepted]
    return sorted(accepted), rejected


@ws_router.websocket("/ws/openclaw/bridge")
async def bridge_websocket(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    try:
        _require_bridge_enabled_and_token(token)
    except HTTPException as exc:
        await websocket.close(code=1008, reason=exc.detail)
        return

    await websocket.accept()
    # 初始订阅为空集合：plugin 在发出 subscribe 之前不会收到任何事件（默认拒绝）。
    sub = await bridge_dispatcher.subscribe(bot_ids=[])
    await websocket.send_json({
        "type": "hello",
        "subscribers": bridge_dispatcher.subscriber_count(),
        "subscribe_required": True,
        "subscribe_timeout_seconds": _SUBSCRIBE_TIMEOUT_SECONDS,
    })
    logger.info("openclaw bridge ws: connected; awaiting subscribe frame")

    consumer_task: asyncio.Task | None = None
    try:
        # 第一步：握手 —— 要求 plugin 在 N 秒内发 subscribe 帧
        try:
            raw = await asyncio.wait_for(
                websocket.receive_text(), timeout=_SUBSCRIBE_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            await websocket.close(code=1008, reason="subscribe frame timeout")
            return

        try:
            first = json.loads(raw)
        except json.JSONDecodeError:
            await websocket.close(code=1003, reason="invalid JSON in subscribe frame")
            return

        if not isinstance(first, dict) or first.get("type") != "subscribe":
            await websocket.close(code=1003, reason="first frame must be {type:'subscribe'}")
            return

        requested = first.get("bot_ids") or []
        if not isinstance(requested, list) or not all(isinstance(x, str) for x in requested):
            await websocket.close(code=1003, reason="subscribe.bot_ids must be string[]")
            return

        # 校验 bot_ids 存在且 binding_type=websocket
        from app.db.session import async_session_factory
        async with async_session_factory() as session:
            accepted, rejected = await _resolve_subscribable_bot_ids(session, requested)
        await bridge_dispatcher.update_subscription(sub, bot_ids=accepted)

        await websocket.send_json({
            "type": "subscribed",
            "accepted_bot_ids": accepted,
            "rejected_bot_ids": rejected,
        })
        logger.info(
            "openclaw bridge ws: subscribed accepted=%d rejected=%d",
            len(accepted), len(rejected),
        )

        # 第二步：后台消费派发事件 → 发给 WS；主循环消费 plugin 的后续消息（如 re-subscribe、ping）
        async def _consume() -> None:
            while True:
                event = await sub.queue.get()
                await websocket.send_json(event)

        consumer_task = asyncio.create_task(_consume())

        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "invalid JSON"})
                continue
            if not isinstance(frame, dict):
                continue
            ftype = frame.get("type")
            if ftype == "subscribe":
                new_requested = frame.get("bot_ids") or []
                if isinstance(new_requested, list) and all(isinstance(x, str) for x in new_requested):
                    async with async_session_factory() as s2:
                        new_accepted, new_rejected = await _resolve_subscribable_bot_ids(s2, new_requested)
                    await bridge_dispatcher.update_subscription(sub, bot_ids=new_accepted)
                    await websocket.send_json({
                        "type": "subscribed",
                        "accepted_bot_ids": new_accepted,
                        "rejected_bot_ids": new_rejected,
                    })
            elif ftype == "ping":
                await websocket.send_json({"type": "pong"})
            # 其他类型暂不处理
    except WebSocketDisconnect:
        logger.info("openclaw bridge ws: disconnected")
    except Exception as exc:  # noqa: BLE001
        logger.warning("openclaw bridge ws: error: %s", exc)
    finally:
        if consumer_task and not consumer_task.done():
            consumer_task.cancel()
        await bridge_dispatcher.unsubscribe(sub)
