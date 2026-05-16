"""Public routes module."""
from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/agentnexus-discovery")
async def agentnexus_discovery(request: Request) -> dict:
    """Agentnexus discovery."""
    base = str(request.base_url).rstrip("/")
    return {
        "name": "AgentNexus",
        "description": "智枢人机协作平台；外部 Agent 通过 Agent Bridge 注册为 Bot 后接入频道。",
        "base_url": base,
        "agent_bridge_docs": {
            "url": f"{base}/docs/agent-bridge/discovery",
            "help_url": f"{base}/docs/agent-bridge/help",
            "register_url": f"{base}/docs/agent-bridge/register",
            "note": (
                "provider 应优先读取 /docs/agent-bridge/discovery；"
                "登录用户可直接注册 Agent Bridge Bot。"
            ),
        },
        "bridge": {
            "control_ws": f"{base.replace('http://', 'ws://').replace('https://', 'wss://')}/ws/agent-bridge/control",
            "data_ws": f"{base.replace('http://', 'ws://').replace('https://', 'wss://')}/ws/agent-bridge/data",
            "token_header": "Authorization: Bearer <bot_token>",
            "admin_header": "X-Agent-Bridge-Token",
        },
    }
