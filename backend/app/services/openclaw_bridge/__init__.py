"""OpenClaw channel plugin bridge：桥接 AgentNexus 与 OpenClaw channel plugin 的内部服务。

职责：
  - WebSocket Bot 被 @mention 时，通过 bridge_dispatcher 把 payload 广播到所有订阅的
    OpenClaw channel plugin 连接（`/ws/openclaw/bridge`）。
  - OpenClaw agent 回复后，plugin 调用 `POST /api/v1/openclaw/bridge/messages`，
    bridge 找到对应的占位 Bot 消息并原地 finalize + 广播到 AgentNexus 频道。
  - pending_replies 记录「已派发、等待回推」的占位消息，用于回推时的匹配与超时兜底。
"""
