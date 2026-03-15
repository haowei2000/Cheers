"""ChatCore 请求/响应模型."""
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


# ==================== AI Model Schemas ====================

class AIModelCreate(BaseModel):
    """创建 AI 模型."""
    name: str = Field(..., min_length=1, max_length=64, description="显示名称，如 GPT-4o")
    provider: str = Field(..., min_length=1, max_length=32, description="提供商: openai, ollama, anthropic")
    model_name: str = Field(..., min_length=1, max_length=64, description="API 模型名，如 gpt-4o")
    base_url: str = Field(..., min_length=1, max_length=512, description="API Base URL")
    api_key: str | None = Field(default=None, description="API Key")
    description: str | None = Field(default=None, description="模型描述")
    is_enabled: bool = Field(default=True)
    config: dict[str, Any] | None = Field(default=None, description="额外配置如 temperature, max_tokens")


class AIModelUpdate(BaseModel):
    """更新 AI 模型."""
    name: str | None = Field(default=None, min_length=1, max_length=64)
    provider: str | None = Field(default=None, min_length=1, max_length=32)
    model_name: str | None = Field(default=None, min_length=1, max_length=64)
    base_url: str | None = Field(default=None, min_length=1, max_length=512)
    api_key: str | None = Field(default=None)
    description: str | None = Field(default=None)
    is_enabled: bool | None = Field(default=None)
    config: dict[str, Any] | None = Field(default=None)


class AIModelInResponse(BaseModel):
    """AI 模型响应."""
    model_config = ConfigDict(from_attributes=True)
    
    model_id: str
    name: str
    provider: str
    model_name: str
    base_url: str
    description: str | None = None
    is_enabled: bool
    is_builtin: bool
    config: dict[str, Any] | None = None
    created_at: datetime | None = None
    # API Key 掩码显示
    api_key_masked: str | None = None


# ==================== Prompt Template Schemas ====================

class PromptTemplateCreate(BaseModel):
    """创建提示词模板."""
    name: str = Field(..., min_length=1, max_length=64, description="模板名称，如 代码审查")
    description: str | None = Field(default=None, description="模板描述")
    system_prompt: str = Field(..., min_length=1, description="系统提示词")
    user_template: str = Field(default="{{message}}", description="用户消息模板，使用 {{变量}} 占位")
    variables: list[str] = Field(default=["message"], description="模板变量列表")


class PromptTemplateUpdate(BaseModel):
    """更新提示词模板."""
    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None)
    system_prompt: str | None = Field(default=None, min_length=1)
    user_template: str | None = Field(default=None)
    variables: list[str] | None = Field(default=None)


class PromptTemplateInResponse(BaseModel):
    """提示词模板响应."""
    model_config = ConfigDict(from_attributes=True)
    
    template_id: str
    name: str
    description: str | None = None
    system_prompt: str
    user_template: str
    variables: list[str]
    is_builtin: bool
    created_at: datetime | None = None


# ==================== Bot Schemas ====================

class BotCreate(BaseModel):
    """创建 Bot：选择模型 + 选择模板."""
    bot_id: str | None = None
    username: str = Field(..., min_length=1, max_length=64, description="@ 用的名字")
    display_name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, description="Bot 描述")
    model_id: str = Field(..., description="关联的 AI 模型 ID")
    template_id: str = Field(..., description="关联的提示词模板 ID")
    custom_system_prompt: str | None = Field(default=None, description="可选：覆盖模板的系统提示词")
    status: str = Field(default="online", pattern="^(online|offline|busy)$")
    intro: str | None = Field(default=None, description='JSON: {"capabilities": [...], "description": "..."}')
    avatar_url: str | None = Field(default=None)


class BotUpdate(BaseModel):
    """更新 Bot."""
    username: str | None = Field(default=None, min_length=1, max_length=64)
    display_name: str | None = Field(default=None)
    description: str | None = Field(default=None)
    model_id: str | None = Field(default=None)
    template_id: str | None = Field(default=None)
    custom_system_prompt: str | None = Field(default=None)
    status: str | None = Field(default=None, pattern="^(online|offline|busy)$")
    intro: str | None = Field(default=None)
    avatar_url: str | None = Field(default=None)


class BotInResponse(BaseModel):
    """Bot 响应（包含关联的模型和模板信息）."""
    model_config = ConfigDict(from_attributes=True)
    
    bot_id: str
    username: str
    display_name: str | None = None
    description: str | None = None
    avatar_url: str | None = None
    status: str
    intro: str | None = None
    custom_system_prompt: str | None = None
    created_at: datetime | None = None
    
    # 关联信息
    model_id: str
    template_id: str
    model_name: str | None = None  # AIModel.name
    template_name: str | None = None  # PromptTemplate.name


class BotSimpleInResponse(BaseModel):
    """简化版 Bot 响应（用于列表）."""
    model_config = ConfigDict(from_attributes=True)
    
    bot_id: str
    username: str
    display_name: str | None = None
    description: str | None = None
    status: str
    model_name: str | None = None
    template_name: str | None = None
    created_at: datetime | None = None


# ==================== Channel & Message Schemas ====================

class ChannelCreate(BaseModel):
    """创建频道."""
    workspace_id: str
    name: str
    type: str = "public"
    purpose: str | None = None


class ChannelInResponse(BaseModel):
    """频道响应."""
    model_config = ConfigDict(from_attributes=True)
    channel_id: str
    workspace_id: str
    name: str
    type: str
    purpose: str | None = None


class MemberAdd(BaseModel):
    """添加成员."""
    member_id: str
    member_type: str


class MemberInResponse(BaseModel):
    """成员响应."""
    model_config = ConfigDict(from_attributes=True)
    channel_id: str
    member_id: str
    member_type: str


class MemberWithUsernameInResponse(BaseModel):
    """成员响应（含 Bot 的 username）."""
    channel_id: str
    member_id: str
    member_type: str
    username: str | None = None


class MessageCreate(BaseModel):
    """发送消息."""
    content: str
    sender_id: str
    sender_type: str = "user"
    file_ids: list[str] = []
    mention_bot_ids: list[str] = []


class MessageInResponse(BaseModel):
    """消息响应."""
    model_config = ConfigDict(from_attributes=True)
    msg_id: str
    channel_id: str
    sender_id: str
    sender_type: str
    content: str
    file_ids: list[str] | None = None
    mention_bot_ids: list[str] | None = None
    task_id: str | None = None
    in_reply_to_msg_id: str | None = None
    created_at: datetime | None = None


# ==================== Legacy Schemas (for compatibility) ====================

class BotRegisterRequest(BaseModel):
    """外部 OpenClaw 提交的注册申请（遗留兼容）."""
    username: str
    display_name: str | None = None
    openclaw_endpoint: str
    intro: str | None = None


class BotRegistrationRequestInResponse(BaseModel):
    """注册申请单条响应."""
    model_config = ConfigDict(from_attributes=True)
    request_id: str
    username: str
    display_name: str | None = None
    openclaw_endpoint: str
    intro: str | None = None
    status: str
    requested_at: datetime | None = None
    decided_at: datetime | None = None
    created_bot_id: str | None = None
