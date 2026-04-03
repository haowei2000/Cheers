"""MCP 业务逻辑层."""
from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.exceptions import BadRequestError, NotFoundError


class MCPServerConfig(BaseModel):
    model_config = ConfigDict(extra="allow")
    command: str | None = None
    args: list[str] | None = None
    url: str | None = None
    env: dict[str, str] | None = None
    description: str | None = None


class MCPConfig(BaseModel):
    model_config = ConfigDict(extra="allow")
    mcpServers: dict[str, MCPServerConfig] = Field(default_factory=dict)


class MCPBotSuggestion(BaseModel):
    suggested_username: str
    suggested_display_name: str
    suggested_endpoint: str
    suggested_intro: dict[str, Any]
    server_name: str
    transport_type: str


class MCPService:
    @staticmethod
    def _extract_bot_from_mcp_server(server_name: str, config: MCPServerConfig) -> MCPBotSuggestion | None:
        if config.url:
            transport_type = "sse" if config.url.startswith("http") else "http"
            endpoint = config.url
        elif config.command:
            transport_type = "stdio"
            endpoint = f"mock://mcp-{server_name}"
        else:
            return None
        
        username = server_name.lower().replace(" ", "-").replace("_", "-")
        if not username.startswith("mcp-"):
            username = f"mcp-{username}"
        
        display_name = server_name.replace("-", " ").replace("_", " ").title()
        
        intro = {
            "description": config.description or f"MCP Server: {server_name}",
            "capabilities": ["mcp"],
            "mcp_config": {
                "server_name": server_name,
                "transport": transport_type,
                "command": config.command,
                "args": config.args,
                "env_keys": list(config.env.keys()) if config.env else [],
            },
        }
        return MCPBotSuggestion(
            suggested_username=username,
            suggested_display_name=display_name,
            suggested_endpoint=endpoint,
            suggested_intro=intro,
            server_name=server_name,
            transport_type=transport_type,
        )

    @staticmethod
    def preview_import(config_json: str, server_name: str | None = None) -> dict:
        """预览 MCP 配置导入，提取 Bot 建议."""
        try:
            config_data = json.loads(config_json)
        except json.JSONDecodeError as e:
            raise BadRequestError(f"无效的 JSON: {e}")
        
        try:
            mcp_config = MCPConfig.model_validate(config_data)
        except Exception as e:
            raise BadRequestError(f"无效的 MCP 配置格式: {e}")
        
        if not mcp_config.mcpServers:
            raise BadRequestError("未找到 mcpServers 配置")
        
        servers_found = list(mcp_config.mcpServers.keys())
        suggestions = []
        
        if server_name:
            if server_name not in mcp_config.mcpServers:
                raise NotFoundError(f"未找到 server: {server_name}")
            suggestion = MCPService._extract_bot_from_mcp_server(server_name, mcp_config.mcpServers[server_name])
            if suggestion:
                suggestions.append(suggestion)
        else:
            for name, server_config in mcp_config.mcpServers.items():
                suggestion = MCPService._extract_bot_from_mcp_server(name, server_config)
                if suggestion:
                    suggestions.append(suggestion)
        
        return {
            "servers_found": servers_found,
            "suggestions": [s.model_dump() for s in suggestions],
        }

    @staticmethod
    def parse_claude_desktop_config(config_json: str) -> dict:
        """解析 Claude Desktop 配置文件."""
        try:
            config_data = json.loads(config_json)
        except json.JSONDecodeError as e:
            raise BadRequestError(f"无效的 JSON: {e}")
        
        mcp_servers = config_data.get("mcpServers") or config_data.get("servers")
        if not mcp_servers:
            raise BadRequestError("未找到 MCP 服务器配置")
        
        suggestions = []
        for name, server_data in mcp_servers.items():
            if not isinstance(server_data, dict):
                continue
            config = MCPServerConfig.model_validate(server_data)
            suggestion = MCPService._extract_bot_from_mcp_server(name, config)
            if suggestion:
                suggestions.append(suggestion.model_dump())
        
        return {
            "servers_found": list(mcp_servers.keys()),
            "suggestions": suggestions,
            "total": len(suggestions),
        }
