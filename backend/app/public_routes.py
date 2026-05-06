"""对外公开接口（无需鉴权）：供外部 OpenClaw 发现并获取注册指南."""
from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/agentnexus-discovery")
async def agentnexus_discovery(request: Request) -> dict:
    """返回 OpenClaw 可读的发现与注册指南（JSON）。

    外部 OpenClaw 可请求此接口获取本系统的注册入口与请求格式，
    据此自动提交注册申请；管理员在「管理」界面审核通过后，
    Bot 方可被加入项目并被 @。
    """
    base = str(request.base_url).rstrip("/")
    body_schema = {
        "username": "string，必填，@ 时使用的名字，唯一",
        "display_name": "string，选填，显示名称",
        "openclaw_endpoint": "string，必填，本 OpenClaw 的 http(s) 根地址，"
        "系统将向 {openclaw_endpoint}/execute 发送 POST 请求",
        "intro": "string，必填，JSON 格式自我介绍，须含 capabilities 或 description，"
        "如 {\"capabilities\": [...], \"description\": \"...\"}",
    }
    execute_contract = (
        "审核通过后，用户 @ 该 Bot 时，AgentNexus 会向 openclaw_endpoint 的 "
        "POST /execute 发送请求，请求/响应格式见《系统管理说明书》§4.4。"
    )
    return {
        "name": "AgentNexus",
        "description": "智枢人机协作平台；Bot 需管理员审核通过后可被加入项目并 @。",
        "base_url": base,
        "openclaw_docs": {
            "url": f"{base}/docs/openclaw/discovery",
            "help_url": f"{base}/docs/openclaw/help",
            "register_url": f"{base}/docs/openclaw/register",
            "note": (
                "推荐 OpenClaw 优先读取 /docs/openclaw/discovery；"
                "登录用户可直接注册 WebSocket Bot。"
            ),
        },
        "register_request": {
            "url": f"{base}/api/v1/bots/register-request",
            "method": "POST",
            "content_type": "application/json",
            "body_schema": body_schema,
        },
        "execute_contract": execute_contract,
    }
