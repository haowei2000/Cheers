"""ChatCore 请求/响应模型."""
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.prompt_templates import DEFAULT_TEMPLATE_VARIABLES, DEFAULT_USER_TEMPLATE

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
    is_public: bool = Field(default=False, description="保留字段；用户创建的模型始终仅创建者可见")
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
    is_public: bool | None = Field(default=None, description="保留字段；用户创建的模型始终仅创建者可见")
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
    is_public: bool = True
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
    user_template: str = Field(default=DEFAULT_USER_TEMPLATE, description="用户消息模板，使用 {{变量}} 占位")
    variables: list[str] = Field(default=DEFAULT_TEMPLATE_VARIABLES, description="模板变量列表")


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
    created_by: str | None = None
    created_at: datetime | None = None


# ==================== Bot Schemas ====================

class BotCreate(BaseModel):
    """创建 Bot：选择模型 + 选择模板（HTTP Bot），或绑定到 Agent Bridge provider。"""
    bot_id: str | None = None
    username: str = Field(..., min_length=1, max_length=64, description="@ 用的名字")
    display_name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, description="Bot 描述")
    # HTTP Bot 必填；Agent Bridge Bot 不使用 model，但可使用 template 渲染发送给 plugin 的任务
    model_id: str | None = Field(default=None, description="关联的 AI 模型 ID（HTTP Bot 必填）")
    template_id: str | None = Field(default=None, description="关联的提示词模板 ID")
    custom_system_prompt: str | None = Field(default=None, description="可选：覆盖模板的系统提示词")
    status: str = Field(default="online", pattern="^(online|offline|busy)$")
    scope: Literal["private", "friend", "everyone"] = Field(
        default="friend",
        description="Bot 使用范围：private=仅自己，friend=自己和好友，everyone=所有登录用户",
    )
    intro: str | None = Field(default=None, description='JSON: {"capabilities": [...], "description": "..."}')
    avatar_url: str | None = Field(default=None)
    binding_type: str = Field(
        default="http",
        pattern="^(http|agent_bridge)$",
        description="绑定类型：'http'=OpenAI 兼容 HTTP（默认）；'agent_bridge'=外部 provider 异步回推",
    )
    bridge_provider: str = Field(default="generic", description="Agent Bridge provider，如 generic/openclaw")
    binding_config: dict | None = Field(
        default=None,
        description="绑定相关配置，例如 Agent Bridge Bot 的 {agent_id, gateway}",
    )


class BotUpdate(BaseModel):
    """更新 Bot."""
    username: str | None = Field(default=None, min_length=1, max_length=64)
    display_name: str | None = Field(default=None)
    description: str | None = Field(default=None)
    model_id: str | None = Field(default=None)
    template_id: str | None = Field(default=None)
    custom_system_prompt: str | None = Field(default=None)
    status: str | None = Field(default=None, pattern="^(online|offline|busy)$")
    scope: Literal["private", "friend", "everyone"] | None = Field(default=None)
    intro: str | None = Field(default=None)
    avatar_url: str | None = Field(default=None)
    binding_type: str | None = Field(default=None, pattern="^(http|agent_bridge)$")
    bridge_provider: str | None = Field(default=None)
    binding_config: dict | None = Field(default=None)


class BotOwnerInResponse(BaseModel):
    user_id: str
    username: str
    display_name: str | None = None


class BotInResponse(BaseModel):
    """Bot 响应（包含关联的模型和模板信息）."""
    model_config = ConfigDict(from_attributes=True)

    bot_id: str
    username: str
    display_name: str | None = None
    description: str | None = None
    avatar_url: str | None = None
    status: str
    scope: Literal["private", "friend", "everyone"] = "friend"
    intro: str | None = None
    custom_system_prompt: str | None = None
    created_at: datetime | None = None
    binding_type: str = "http"
    bridge_provider: str = "generic"
    binding_config: dict | None = None
    is_builtin: bool = False
    # Agent Bridge Bot token 元信息：常规响应只回前缀与轮换时间，明文 bot_token
    # 只在 create / rotate 接口一次性返回
    bot_token_prefix: str | None = None
    bot_token_rotated_at: datetime | None = None
    bot_token: str | None = None  # 仅 create / rotate 响应里有值；其它接口永远为 None
    connection_status: str = "not_required"
    is_online: bool = True
    control_connected: bool | None = None
    data_connected: bool | None = None

    # 关联信息（Agent Bridge Bot 可能没有）
    model_id: str | None = None
    template_id: str | None = None
    model_name: str | None = None  # AIModel.name
    template_name: str | None = None  # PromptTemplate.name
    created_by: str | None = None  # 创建者 user_id
    owner: BotOwnerInResponse | None = None
    can_manage: bool = False


class BotSimpleInResponse(BaseModel):
    """简化版 Bot 响应（用于列表）."""
    model_config = ConfigDict(from_attributes=True)

    bot_id: str
    username: str
    display_name: str | None = None
    description: str | None = None
    avatar_url: str | None = None
    status: str
    scope: Literal["private", "friend", "everyone"] = "friend"
    binding_type: str = "http"
    is_builtin: bool = False
    connection_status: str = "not_required"
    is_online: bool = True
    control_connected: bool | None = None
    data_connected: bool | None = None
    model_id: str | None = None
    template_id: str | None = None
    model_name: str | None = None
    template_name: str | None = None
    created_by: str | None = None
    owner: BotOwnerInResponse | None = None
    can_manage: bool = False
    created_at: datetime | None = None


# ==================== OpenClaw Quick Connect ====================

class OpenClawQuickConnect(BaseModel):
    """快速连接 OpenClaw：输入 URL + Token 一键创建 Bot 并探测能力."""
    url: str = Field(..., description="OpenClaw gateway URL，如 http://host:port 或 http://host:port/v1")
    token: str = Field(..., description="Bearer 鉴权 Token")
    agent_id: str = Field(default="main", description="Agent ID（即模型名，如 main）")
    bot_username: str | None = Field(default=None, description="Bot 用户名（为空则自动生成）")
    display_name: str | None = Field(default=None, description="Bot 显示名称（为空则自动生成）")
    channel_id: str | None = Field(default=None, description="创建后自动加入该频道")
    scope: Literal["private", "friend", "everyone"] | None = Field(
        default=None,
        description="Bot 使用范围；OpenClaw 快速接入默认 private",
    )


# ==================== Channel & Message Schemas ====================

class ChannelCreate(BaseModel):
    """创建频道."""
    workspace_id: str
    name: str
    type: str = "public"
    purpose: str | None = None
    allow_member_invites: bool | None = None
    allow_bot_adds: bool | None = None


class ChannelInResponse(BaseModel):
    """频道响应."""
    model_config = ConfigDict(from_attributes=True)
    channel_id: str
    workspace_id: str
    name: str
    type: str
    purpose: str | None = None
    auto_assist: bool = False
    allow_member_invites: bool = True
    allow_bot_adds: bool = True
    my_role: str | None = None
    can_manage: bool = False
    can_invite_members: bool = False
    can_add_bots: bool = False
    # 用户在该频道未读的消息数（由 channel_memberships.last_read_at 派生）。
    # 未登录或非成员时保持 None。
    unread_count: int | None = None


class DMCounterparty(BaseModel):
    """DM 对方的最小档案。既可以是用户也可以是 bot。"""
    member_id: str
    member_type: str  # "user" | "bot"
    username: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None


class DMInResponse(BaseModel):
    """一条 Direct Message 在列表里展示所需的字段。"""
    channel_id: str
    workspace_id: str
    counterparty: DMCounterparty
    unread_count: int | None = None


class DMCreateRequest(BaseModel):
    """POST /api/v1/dms 请求体：在某 workspace 内与对方开启/复用 DM。"""
    workspace_id: str
    member_id: str
    member_type: str  # "user" | "bot"


# ==================== Global search ====================


class SearchChannelHit(BaseModel):
    channel_id: str
    name: str
    workspace_id: str
    type: str  # 实际值排除了 "dm"（dm 单独通过 people/bot 搜索进入）


class SearchWorkspaceHit(BaseModel):
    workspace_id: str
    name: str
    kind: str = "team"


class SearchUserHit(BaseModel):
    user_id: str
    username: str
    display_name: str | None = None
    avatar_url: str | None = None


class SearchBotHit(BaseModel):
    bot_id: str
    username: str
    display_name: str | None = None
    avatar_url: str | None = None
    scope: Literal["private", "friend", "everyone"] = "friend"
    owner: BotOwnerInResponse | None = None


class SearchFileHit(BaseModel):
    file_id: str
    channel_id: str
    channel_name: str
    original_filename: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    status: str
    snippet: str = ""
    created_at: datetime | None = None


class SearchMessageHit(BaseModel):
    msg_id: str
    channel_id: str
    channel_name: str
    sender_label: str                 # 显示名（或 @username / "me"）
    snippet: str                      # 正文片段（已截断，高亮可客户端处理）
    created_at: datetime | None = None


class SearchTodoHit(BaseModel):
    todo_id: str
    channel_id: str
    channel_name: str
    content: str
    status: str
    assignee_id: str | None = None
    assignee_type: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SearchTaskHit(BaseModel):
    task_id: str
    channel_id: str
    channel_name: str
    bot_id: str
    bot_name: str | None = None
    trigger_msg_id: str
    response_msg_id: str | None = None
    latency_ms: int | None = None
    feedback: str | None = None
    snippet: str = ""
    created_at: datetime | None = None


class SearchResults(BaseModel):
    q: str
    context: str = "global_nav"
    workspaces: list[SearchWorkspaceHit] = Field(default_factory=list)
    channels: list[SearchChannelHit] = Field(default_factory=list)
    users: list[SearchUserHit] = Field(default_factory=list)
    bots: list[SearchBotHit] = Field(default_factory=list)
    files: list[SearchFileHit] = Field(default_factory=list)
    todos: list[SearchTodoHit] = Field(default_factory=list)
    tasks: list[SearchTaskHit] = Field(default_factory=list)
    messages: list[SearchMessageHit] = Field(default_factory=list)


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


class MessageFileInResponse(BaseModel):
    """消息引用的文件元信息。"""
    model_config = ConfigDict(from_attributes=True)

    file_id: str
    original_filename: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    status: str
    expires_at: datetime | None = None


# ==================== content_data schemas (per msg_type) ====================

class TopicContentData(BaseModel):
    """主题的结构化数据。"""
    title: str | None = None


class AnnouncementContentData(BaseModel):
    """公告消息的结构化数据。"""
    title: str | None = None
    pinned_by: str | None = None  # user_id of whoever pinned it (display-only)


class RoutingPick(BaseModel):
    """Coordinator 给出的一个候选 agent 以及评分/理由。"""
    agent: str                    # bot username
    score: str | None = None      # freeform: "0.92" / "high" / 等
    why: str | None = None
    picked: bool | None = None    # True 表示最终选中
    secondary: bool | None = None  # True 表示作为次要候选


class RoutingContentData(BaseModel):
    """路由卡片的结构化数据。由 coordinator 在派发任务时产出。"""
    q: str | None = None          # 被路由的请求（通常是用户的原始消息摘要）
    picks: list[RoutingPick] = Field(default_factory=list)
    plan: str | None = None       # 一句话的执行计划


class PermissionContentData(BaseModel):
    """审批卡片的结构化数据。Bot 在发起需要人工授权的写操作前产出。

    - tool: 请求的工具名（例如 write_file / run_sql）
    - body: 面向人类的摘要（"Apply patch to gateway/src/put.rs (+4/-1)"）
    - resolved / resolution / resolved_by / resolved_at 在 /resolve 端点被填充。
    """
    tool: str | None = None
    body: str | None = None
    resolved: bool = False
    resolution: Literal["allow", "deny"] | None = None
    resolved_by: str | None = None
    resolved_at: datetime | None = None


# ==================== Message Create Schemas (discriminated union) ====================

class _MessageCreateBase(BaseModel):
    """消息创建公共字段。"""
    content: str
    sender_id: str
    sender_type: str = "user"
    file_ids: list[str] = Field(default_factory=list)
    mention_bot_ids: list[str] = Field(default_factory=list)
    is_secret: bool = False


class NormalMessageCreate(_MessageCreateBase):
    """普通消息：频道内的独立消息。"""
    msg_type: Literal["normal"] = "normal"
    content_data: dict[str, Any] | None = None


class ReplyMessageCreate(_MessageCreateBase):
    """回复消息：回复某条具体消息。"""
    msg_type: Literal["reply"] = "reply"
    in_reply_to_msg_id: str
    content_data: dict[str, Any] | None = None


class TopicMessageCreate(_MessageCreateBase):
    """主题：显式创建一个主题。"""
    msg_type: Literal["topic"] = "topic"
    content_data: TopicContentData | None = None


class AnnouncementMessageCreate(_MessageCreateBase):
    """频道公告：顶部置顶展示，带标题和置顶人。"""
    msg_type: Literal["announcement"] = "announcement"
    content_data: AnnouncementContentData | None = None


class RoutingMessageCreate(_MessageCreateBase):
    """路由卡片：coordinator 将请求派发给其他 agents 时的结构化说明。"""
    msg_type: Literal["routing"] = "routing"
    content_data: RoutingContentData | None = None


class PermissionMessageCreate(_MessageCreateBase):
    """审批卡片：bot 发起需要人工授权的写操作时产出。content 为人类可读说明。"""
    msg_type: Literal["permission"] = "permission"
    content_data: PermissionContentData | None = None


# 统一入口：兼容旧客户端（不含 msg_type 时含 in_reply_to_msg_id 自动推断）
class MessageCreate(BaseModel):
    """发送消息（兼容入口，自动推断 msg_type）。"""
    content: str
    sender_id: str
    sender_type: str = "user"
    file_ids: list[str] = Field(default_factory=list)
    mention_bot_ids: list[str] = Field(default_factory=list)
    in_reply_to_msg_id: str | None = None
    content_data: dict[str, Any] | None = None
    msg_type: str | None = None
    is_secret: bool = False

    @model_validator(mode="after")
    def _infer_msg_type(self) -> "MessageCreate":
        if self.msg_type is None:
            self.msg_type = "reply" if self.in_reply_to_msg_id else "normal"
        return self


class ForwardMessageRequest(BaseModel):
    """转发消息或文件到目标频道/DM。"""

    source_message_ids: list[str] = Field(default_factory=list)
    source_file_ids: list[str] = Field(default_factory=list)
    mode: Literal["single", "topic"] = "single"


class ForwardMessageResponse(BaseModel):
    """转发结果。"""

    messages: list[dict[str, Any]] = Field(default_factory=list)


# Discriminated union（供新客户端使用）
AnyMessageCreate = Annotated[
    NormalMessageCreate | ReplyMessageCreate | TopicMessageCreate | AnnouncementMessageCreate | RoutingMessageCreate | PermissionMessageCreate,
    Field(discriminator="msg_type"),
]


class MessageStreamCreate(BaseModel):
    """发送消息并以 SSE 接收 Bot 流式回复。"""
    content: str
    sender_id: str
    sender_type: str = "user"
    file_id: str | None = None
    file_ids: list[str] = Field(default_factory=list)
    mention_bot_ids: list[str] = Field(default_factory=list)


# ==================== Message Response Schemas ====================

class _MessageResponseBase(BaseModel):
    """消息响应公共字段。"""
    model_config = ConfigDict(from_attributes=True)
    msg_id: str
    channel_id: str
    sender_id: str
    sender_type: str
    content: str
    content_data: dict[str, Any] | None = None
    file_ids: list[str] | None = None
    files: list[MessageFileInResponse] | None = None
    mention_bot_ids: list[str] | None = None
    mention_user_ids: list[str] | None = None
    task_id: str | None = None
    in_reply_to_msg_id: str | None = None
    created_at: datetime | None = None
    is_secret: bool = False
    is_partial: bool = False


class NormalMessageInResponse(_MessageResponseBase):
    """普通消息响应。"""
    msg_type: Literal["normal"] = "normal"


class ReplyMessageInResponse(_MessageResponseBase):
    """回复消息响应。"""
    msg_type: Literal["reply"] = "reply"
    in_reply_to_msg_id: str


class TopicMessageInResponse(_MessageResponseBase):
    """主题响应。content_data 包含 { title?: string } 等主题专有字段。"""
    msg_type: Literal["topic"] = "topic"


class AnnouncementMessageInResponse(_MessageResponseBase):
    """公告消息响应。content_data 包含 { title?, pinned_by? }。"""
    msg_type: Literal["announcement"] = "announcement"


class RoutingMessageInResponse(_MessageResponseBase):
    """路由卡片响应。content_data 包含 { q?, picks: [...], plan? }。"""
    msg_type: Literal["routing"] = "routing"


class PermissionMessageInResponse(_MessageResponseBase):
    """审批卡片响应。content_data 包含 { tool?, body?, resolved, resolution?, resolved_by?, resolved_at? }。"""
    msg_type: Literal["permission"] = "permission"


AnyMessageInResponse = Annotated[
    NormalMessageInResponse | ReplyMessageInResponse | TopicMessageInResponse | AnnouncementMessageInResponse | RoutingMessageInResponse | PermissionMessageInResponse,
    Field(discriminator="msg_type"),
]


# ==================== Permission resolve endpoint ========================

class PermissionResolveRequest(BaseModel):
    """POST /messages/{msg_id}/resolve 的请求体。"""
    resolution: Literal["allow", "deny"]


# 保持向后兼容：统一响应类（含全部字段）
class MessageInResponse(_MessageResponseBase):
    """消息响应（统一格式，兼容旧接口）。"""
    msg_type: str = "normal"


# ==================== Keychain Schemas ====================

class KeychainItemCreate(BaseModel):
    """创建密钥项。"""
    name: str = Field(..., min_length=1, max_length=128, description="密钥名称，用于引用")
    value: str = Field(..., min_length=1, description="密钥值")
    description: str | None = Field(default=None, description="密钥描述")


class KeychainItemUpdate(BaseModel):
    """更新密钥项。"""
    name: str | None = Field(default=None, min_length=1, max_length=128)
    value: str | None = Field(default=None, min_length=1)
    description: str | None = Field(default=None)


class KeychainItemInResponse(BaseModel):
    """密钥项响应（不包含实际密钥值）。"""
    model_config = ConfigDict(from_attributes=True)

    key_id: str
    owner_id: str
    name: str
    description: str | None = None
    value_masked: str | None = None  # 掩码显示，如 "****abcd"
    created_at: datetime | None = None
    updated_at: datetime | None = None
