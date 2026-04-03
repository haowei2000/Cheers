"""MCP v1 路由（Model Context Protocol 配置导入）."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.responses import APIResponse
from app.services.mcp_service import MCPService

router = APIRouter(prefix="/mcp", tags=["mcp"])


class MCPImportBody(BaseModel):
    config_json: str
    server_name: str | None = None


@router.post("/preview", response_model=APIResponse[dict])
async def preview_mcp_import(body: MCPImportBody) -> APIResponse:
    result = MCPService.preview_import(body.config_json, body.server_name)
    return APIResponse.ok(result)


@router.post("/parse-claude-config", response_model=APIResponse[dict])
async def parse_claude_desktop_config(config_json: str) -> APIResponse:
    result = MCPService.parse_claude_desktop_config(config_json)
    return APIResponse.ok(result)
