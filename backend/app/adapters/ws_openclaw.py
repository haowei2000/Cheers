"""通过 WebSocket JSON-RPC 调用 OpenClaw Gateway 的适配器.

协议：
  连接: ws://<host>  发送 {type:"req", id, method:"connect", params:{minProtocol:3, ...}}
  发消息: {type:"req", id, method:"chat.send", params:{sessionKey, message, deliver:false}}
  响应: {type:"res", id, result:...} 或 {type:"err", id, error:{code, message}}
"""
import asyncio
import json
import logging
import uuid

import websockets

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter

logger = logging.getLogger("app.adapters.ws_openclaw")

CONNECT_TIMEOUT = 10.0
SEND_TIMEOUT = 30.0


class WsOpenClawAdapter(OpenClawAdapter):
    """将消息通过 WebSocket JSON-RPC 发送给 OpenClaw Gateway."""

    def __init__(self, ws_url: str, session_key: str, token: str | None = None) -> None:
        # 统一成 ws:// 或 wss://
        self.ws_url = ws_url if ws_url.startswith("ws") else ws_url.replace("http://", "ws://").replace("https://", "wss://")
        self.session_key = session_key
        self.token = token or ""
        # Origin header：将 ws:// 替换为 http://，只取 scheme://host:port 部分
        scheme = "https" if self.ws_url.startswith("wss://") else "http"
        host_part = self.ws_url.split("//", 1)[1].split("/")[0]
        self.origin = f"{scheme}://{host_part}"

    async def _rpc(self, ws, method: str, params: dict) -> dict:
        req_id = str(uuid.uuid4())
        await ws.send(json.dumps({"type": "req", "id": req_id, "method": method, "params": params}))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=SEND_TIMEOUT)
            msg = json.loads(raw)
            if msg.get("id") == req_id:
                if msg.get("type") == "err":
                    raise RuntimeError(msg.get("error", {}).get("message", "rpc error"))
                return msg.get("result") or {}

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        text = payload.trigger_message.get("text", "")
        logger.info("ws_openclaw: execute start session=%s url=%s", self.session_key, self.ws_url)
        try:
            async with websockets.connect(
                self.ws_url,
                origin=self.origin,
                open_timeout=CONNECT_TIMEOUT,
            ) as ws:
                logger.info("ws_openclaw: connected, sending connect rpc")
                # 握手
                await self._rpc(ws, "connect", {
                    "minProtocol": 3,
                    "maxProtocol": 3,
                    "client": {"id": "cli", "version": "1.0", "platform": "server", "mode": "webchat"},
                    "role": "operator",
                    "scopes": ["operator.admin"],
                    "auth": {"token": self.token},
                    "caps": [],
                })
                logger.info("ws_openclaw: connect rpc ok, sending chat.send")
                # 发消息
                idempotency_key = payload.task_id or str(uuid.uuid4())
                send_result = await self._rpc(ws, "chat.send", {
                    "sessionKey": self.session_key,
                    "message": text,
                    "deliver": False,
                    "idempotencyKey": idempotency_key,
                })
                logger.info("ws_openclaw: chat.send ok result=%s, waiting for events", send_result)

                # 等待回复事件：stream=assistant 累积文本，stream=lifecycle phase=end 结束
                last_text = ""
                event_count = 0
                try:
                    while True:
                        raw = await asyncio.wait_for(ws.recv(), timeout=SEND_TIMEOUT)
                        msg = json.loads(raw)
                        logger.debug("ws_openclaw: recv type=%s", msg.get("type"))
                        if msg.get("type") != "event":
                            continue
                        p = msg.get("payload", {})
                        stream = p.get("stream")
                        data = p.get("data", {})
                        event_count += 1
                        logger.info("ws_openclaw: event #%d stream=%s data_keys=%s", event_count, stream, list(data.keys()))
                        if stream == "assistant" and "text" in data:
                            last_text = data["text"]
                        elif stream == "lifecycle" and data.get("phase") in ("end", "done", "error", "abort"):
                            logger.info("ws_openclaw: lifecycle phase=%s, done", data.get("phase"))
                            break
                except asyncio.TimeoutError:
                    logger.warning("ws_openclaw: timeout waiting for reply session=%s events_received=%d", self.session_key, event_count)

            logger.info("ws_openclaw: got reply session=%s len=%d", self.session_key, len(last_text))
            return AgentResponse(
                content=last_text or "（OpenClaw 未返回内容）",
                task_id=payload.task_id,
                success=True,
                error_message=None,
            )
        except Exception as e:
            logger.warning("ws_openclaw: failed session=%s error=%s", self.session_key, e, exc_info=True)
            return AgentResponse(
                content="",
                task_id=payload.task_id,
                success=False,
                error_message=f"WebSocket 调用失败: {e!s}",
            )

    async def health_check(self) -> bool:
        try:
            async with websockets.connect(self.ws_url, open_timeout=5.0):
                return True
        except Exception:
            return False
