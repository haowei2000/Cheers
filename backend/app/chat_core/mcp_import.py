"""MCP (Model Context Protocol) 配置导入功能.

支持从 MCP 服务器配置文件中导入 Bot 配置。
MCP 配置格式参考: https://modelcontextprotocol.io
"""
import json
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class MCPServerConfig(BaseModel):
    """单个 MCP 服务器配置."""
    model_config = ConfigDict(extra="allow")
    
    command: str | None = None
    args: list[str] | None = None
    url: str | None = None  # 用于 SSE 传输
    env: dict[str, str] | None = None
    description: str | None = None


class MCPConfig(BaseModel):
    """MCP 配置文件结构 (如 claude_desktop_config.json)."""
    model_config = ConfigDict(extra="allow")
    
    mcpServers: dict[str, MCPServerConfig] = Field(default_factory=dict)


class MCPImportRequest(BaseModel):
    """MCP 导入请求."""
    config_json: str  # MCP 配置的 JSON 字符串
    server_name: str | None = None  # 指定导入某个 server，不填则导入第一个


class MCPBotSuggestion(BaseModel):
    """从 MCP 配置提取的 Bot 建议配置."""
    suggested_username: str
    suggested_display_name: str
    suggested_endpoint: str
    suggested_intro: dict[str, Any]
    server_name: str
    transport_type: str  # "stdio" | "sse" | "http"


class MCPImportPreviewResponse(BaseModel):
    """MCP 导入预览响应."""
    servers_found: list[str]
    suggestions: list[MCPBotSuggestion]


def _extract_bot_from_mcp_server(
    server_name: str, 
    config: MCPServerConfig
) -> MCPBotSuggestion | None:
    """从单个 MCP 服务器配置中提取 Bot 建议配置.
    
    Args:
        server_name: MCP 服务器名称
        config: MCP 服务器配置
        
    Returns:
        Bot 建议配置，如果无法提取则返回 None
    """
    # 确定传输类型和 endpoint
    if config.url:
        # SSE 或 HTTP 传输
        transport_type = "sse" if config.url.startswith("http") else "http"
        endpoint = config.url
    elif config.command:
        # stdio 传输 - 转换为 mock:// 或需要用户手动配置 HTTP 代理
        transport_type = "stdio"
        # stdio 类型需要外部代理，建议使用 mock:// 占位，用户后续修改
        endpoint = f"mock://mcp-{server_name}"
    else:
        return None
    
    # 生成建议的用户名 (小写，去除特殊字符)
    username = server_name.lower().replace(" ", "-").replace("_", "-")
    if not username.startswith("mcp-"):
        username = f"mcp-{username}"
    
    # 生成显示名
    display_name = server_name.replace("-", " ").replace("_", " ").title()
    
    # 构建 intro
    intro = {
        "description": config.description or f"MCP Server: {server_name}",
        "capabilities": ["mcp"],
        "mcp_config": {
            "server_name": server_name,
            "transport": transport_type,
            "command": config.command,
            "args": config.args,
            "env_keys": list(config.env.keys()) if config.env else [],
        }
    }
    
    return MCPBotSuggestion(
        suggested_username=username,
        suggested_display_name=display_name,
        suggested_endpoint=endpoint,
        suggested_intro=intro,
        server_name=server_name,
        transport_type=transport_type,
    )


@router.post("/preview")
async def preview_mcp_import(request: MCPImportRequest) -> dict:
    """预览 MCP 配置导入 - 解析但不创建 Bot.
    
    Args:
        request: MCP 导入请求，包含 config_json
        
    Returns:
        预览信息，包含找到的服务器和 Bot 建议配置
    """
    try:
        config_data = json.loads(request.config_json)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"无效的 JSON: {e}")
    
    try:
        mcp_config = MCPConfig.model_validate(config_data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"无效的 MCP 配置格式: {e}")
    
    if not mcp_config.mcpServers:
        raise HTTPException(status_code=400, detail="未找到 mcpServers 配置")
    
    servers_found = list(mcp_config.mcpServers.keys())
    suggestions = []
    
    # 如果指定了 server_name，只处理该 server
    if request.server_name:
        if request.server_name not in mcp_config.mcpServers:
            raise HTTPException(
                status_code=400, 
                detail=f"未找到 server: {request.server_name}"
            )
        server_config = mcp_config.mcpServers[request.server_name]
        suggestion = _extract_bot_from_mcp_server(
            request.server_name, 
            server_config
        )
        if suggestion:
            suggestions.append(suggestion)
    else:
        # 处理所有 servers
        for name, server_config in mcp_config.mcpServers.items():
            suggestion = _extract_bot_from_mcp_server(name, server_config)
            if suggestion:
                suggestions.append(suggestion)
    
    return {
        "status": "success",
        "data": MCPImportPreviewResponse(
            servers_found=servers_found,
            suggestions=suggestions,
        ).model_dump()
    }


@router.post("/parse-claude-config")
async def parse_claude_desktop_config(config_json: str) -> dict:
    """解析 Claude Desktop 的 MCP 配置文件.
    
    Args:
        config_json: Claude Desktop 配置文件内容 (claude_desktop_config.json)
        
    Returns:
        解析后的 Bot 建议配置列表
    """
    try:
        config_data = json.loads(config_json)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"无效的 JSON: {e}")
    
    # Claude Desktop 配置可能有不同的结构
    # 尝试多种可能的配置路径
    mcp_servers = None
    
    if "mcpServers" in config_data:
        mcp_servers = config_data["mcpServers"]
    elif "servers" in config_data:
        mcp_servers = config_data["servers"]
    
    if not mcp_servers:
        raise HTTPException(status_code=400, detail="未找到 MCP 服务器配置")
    
    suggestions = []
    for name, server_data in mcp_servers.items():
        if not isinstance(server_data, dict):
            continue
            
        config = MCPServerConfig.model_validate(server_data)
        suggestion = _extract_bot_from_mcp_server(name, config)
        if suggestion:
            suggestions.append(suggestion.model_dump())
    
    return {
        "status": "success",
        "data": {
            "servers_found": list(mcp_servers.keys()),
            "suggestions": suggestions,
            "total": len(suggestions),
        }
    }
