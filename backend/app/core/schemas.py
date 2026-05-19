"""ChatCore request and response schemas."""
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.prompt_templates import DEFAULT_TEMPLATE_VARIABLES, DEFAULT_USER_TEMPLATE

# ==================== AI Model Schemas ====================

class AIModelCreate(BaseModel):
    """AI model creation schema."""
    name: str = Field(..., min_length=1, max_length=64, description="Display name, for example GPT-4o")
    provider: str = Field(..., min_length=1, max_length=32, description="Provider: openai, ollama, anthropic")
    model_name: str = Field(..., min_length=1, max_length=64, description="API model name, for example gpt-4o")
    base_url: str = Field(..., min_length=1, max_length=512, description="API Base URL")
    api_key: str | None = Field(default=None, description="API Key")
    description: str | None = Field(default=None, description="Model description")
    is_enabled: bool = Field(default=True)
    is_public: bool = Field(default=False, description="Reserved field; user-created models are only visible to their creator")
    config: dict[str, Any] | None = Field(default=None, description="Extra configuration such as temperature and max_tokens")


class AIModelUpdate(BaseModel):
    """AI model update schema."""
    name: str | None = Field(default=None, min_length=1, max_length=64)
    provider: str | None = Field(default=None, min_length=1, max_length=32)
    model_name: str | None = Field(default=None, min_length=1, max_length=64)
    base_url: str | None = Field(default=None, min_length=1, max_length=512)
    api_key: str | None = Field(default=None)
    description: str | None = Field(default=None)
    is_enabled: bool | None = Field(default=None)
    is_public: bool | None = Field(default=None, description="Reserved field; user-created models are only visible to their creator")
    config: dict[str, Any] | None = Field(default=None)


class AIModelInResponse(BaseModel):
    """AI model response schema."""
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
    # Masked API-key display.
    api_key_masked: str | None = None


# ==================== Prompt Template Schemas ====================

class PromptTemplateCreate(BaseModel):
    """Prompt template creation schema."""
    name: str = Field(..., min_length=1, max_length=64, description="Template name, for example Code Review")
    description: str | None = Field(default=None, description="Template description")
    system_prompt: str = Field(..., min_length=1, description="System prompt")
    user_template: str = Field(default=DEFAULT_USER_TEMPLATE, description="User message template using {{variable}} placeholders")
    variables: list[str] = Field(default=DEFAULT_TEMPLATE_VARIABLES, description="Template variable list")
    scope: Literal["private", "friend", "everyone"] = Field(
        default="friend",
        description="Template visibility: private=self only, friend=self and friends, everyone=all signed-in users",
    )


class PromptTemplateUpdate(BaseModel):
    """Prompt template update schema."""
    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None)
    system_prompt: str | None = Field(default=None, min_length=1)
    user_template: str | None = Field(default=None)
    variables: list[str] | None = Field(default=None)
    scope: Literal["private", "friend", "everyone"] | None = Field(default=None)


class PromptTemplateOwnerInResponse(BaseModel):
    user_id: str
    username: str
    display_name: str | None = None


class PromptTemplateInResponse(BaseModel):
    """Prompt template response schema."""
    model_config = ConfigDict(from_attributes=True)

    template_id: str
    name: str
    description: str | None = None
    system_prompt: str
    user_template: str
    variables: list[str]
    is_builtin: bool
    scope: Literal["private", "friend", "everyone"] = "friend"
    created_by: str | None = None
    owner: PromptTemplateOwnerInResponse | None = None
    can_manage: bool = False
    created_at: datetime | None = None


# ==================== Bot Schemas ====================

class BotCreate(BaseModel):
    """Bot creation schema."""
    bot_id: str | None = None
    username: str = Field(..., min_length=1, max_length=64, description="Username used for @mentions")
    display_name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, description="Bot description")
    # Required for HTTP bots; Agent Bridge bots do not use a model, but may use a template for plugin tasks.
    model_id: str | None = Field(default=None, description="Associated AI model ID, required for HTTP bots")
    template_id: str | None = Field(default=None, description="Associated prompt template ID")
    custom_system_prompt: str | None = Field(default=None, description="Optional system prompt override for the template")
    status: str = Field(default="online", pattern="^(online|offline|busy)$")
    scope: Literal["private", "friend", "everyone"] = Field(
        default="friend",
        description="Bot visibility: private=self only, friend=self and friends, everyone=all signed-in users",
    )
    intro: str | None = Field(default=None, description='JSON: {"capabilities": [...], "description": "..."}')
    avatar_url: str | None = Field(default=None)
    binding_type: str = Field(
        default="http",
        pattern="^(http|agent_bridge)$",
        description="Binding type: 'http'=OpenAI-compatible HTTP by default; 'agent_bridge'=external provider callback",
    )
    bridge_provider: str = Field(default="generic", description="Agent Bridge provider, for example generic/openclaw")
    binding_config: dict | None = Field(
        default=None,
        description="Binding-specific configuration, for example {agent_id, gateway} for Agent Bridge bots",
    )


class BotUpdate(BaseModel):
    """Bot update schema."""
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
    """Bot response schema with model and template metadata."""
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
    # Agent Bridge token metadata; regular responses only include prefix/rotation data.
    # The plaintext bot_token is returned once by create/rotate endpoints.
    bot_token_prefix: str | None = None
    bot_token_rotated_at: datetime | None = None
    bot_token: str | None = None  # Only create/rotate responses include a value.
    connection_status: str = "not_required"
    is_online: bool = True
    control_connected: bool | None = None
    data_connected: bool | None = None

    # Associated metadata; Agent Bridge bots may omit it.
    model_id: str | None = None
    template_id: str | None = None
    model_name: str | None = None  # AIModel.name
    template_name: str | None = None  # PromptTemplate.name
    created_by: str | None = None  # Creator user_id.
    owner: BotOwnerInResponse | None = None
    can_manage: bool = False


class BotSimpleInResponse(BaseModel):
    """Compact Bot response schema."""
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
    """OpenClaw quick-connect request schema."""
    url: str = Field(..., description="OpenClaw gateway URL, for example http://host:port or http://host:port/v1")
    token: str = Field(..., description="Bearer authentication token")
    agent_id: str = Field(default="main", description="Agent ID, usually the model name such as main")
    bot_username: str | None = Field(default=None, description="Bot username; generated automatically when empty")
    display_name: str | None = Field(default=None, description="Bot display name; generated automatically when empty")
    channel_id: str | None = Field(default=None, description="Channel to join automatically after creation")
    scope: Literal["private", "friend", "everyone"] | None = Field(
        default=None,
        description="Bot visibility; OpenClaw quick connect defaults to private",
    )


# ==================== Channel & Message Schemas ====================

class ChannelCreate(BaseModel):
    """Channel Create schema or model."""
    workspace_id: str
    name: str
    type: str = "public"
    purpose: str | None = None
    allow_member_invites: bool | None = None
    allow_bot_adds: bool | None = None


class ChannelInResponse(BaseModel):
    """Channel In Response schema or model."""
    model_config = ConfigDict(from_attributes=True)
    channel_id: str
    workspace_id: str
    name: str
    type: str
    purpose: str | None = None
    auto_assist: bool = False
    allow_member_invites: bool = True
    allow_bot_adds: bool = True
    project_id: str | None = None
    project_title: str | None = None
    task_title: str | None = None
    project_task_type: str | None = None
    my_role: str | None = None
    can_manage: bool = False
    can_invite_members: bool = False
    can_add_bots: bool = False
    # Number of unread messages for the user in this channel, derived from channel_memberships.last_read_at.
    # Remains None for anonymous users or non-members.
    unread_count: int | None = None


class DMCounterparty(BaseModel):
    """Direct-message counterparty profile."""
    member_id: str
    member_type: str  # "user" | "bot"
    username: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None


class DMInResponse(BaseModel):
    """D M In Response schema or model."""
    channel_id: str
    workspace_id: str
    counterparty: DMCounterparty
    title: str | None = None
    project_id: str | None = None
    project_title: str | None = None
    chat_title: str | None = None
    session_scope_id: str | None = None
    created_at: datetime | None = None
    unread_count: int | None = None


class DMCreateRequest(BaseModel):
    """D M Create Request schema or model."""
    workspace_id: str
    member_id: str
    member_type: str  # "user" | "bot"
    create_new: bool = False
    title: str | None = Field(default=None, max_length=80)
    project_id: str | None = Field(default=None, max_length=80)
    project_title: str | None = Field(default=None, max_length=80)
    chat_title: str | None = Field(default=None, max_length=80)


# ==================== Global search ====================


class SearchChannelHit(BaseModel):
    channel_id: str
    name: str
    workspace_id: str
    workspace_name: str | None = None
    type: str  # Actual values exclude "dm"; DMs are entered through people/bot search.


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
    sender_label: str                 # Display name, @username, or "me".
    snippet: str                      # Truncated body snippet; clients may add highlighting.
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
    """Member Add schema or model."""
    member_id: str
    member_type: str


class MemberInResponse(BaseModel):
    """Member In Response schema or model."""
    model_config = ConfigDict(from_attributes=True)
    channel_id: str
    member_id: str
    member_type: str


class MemberWithUsernameInResponse(BaseModel):
    """Member With Username In Response schema or model."""
    channel_id: str
    member_id: str
    member_type: str
    username: str | None = None


class MessageFileInResponse(BaseModel):
    """Message File In Response schema or model."""
    model_config = ConfigDict(from_attributes=True)

    file_id: str
    original_filename: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    status: str
    expires_at: datetime | None = None


# ==================== content_data schemas (per msg_type) ====================

class TopicContentData(BaseModel):
    """Topic Content Data schema or model."""
    title: str | None = None


class AnnouncementContentData(BaseModel):
    """Announcement Content Data schema or model."""
    title: str | None = None
    pinned_by: str | None = None  # user_id of whoever pinned it (display-only)


class RoutingPick(BaseModel):
    """Routing Pick schema or model."""
    agent: str                    # bot username
    score: str | None = None      # Freeform values such as "0.92" or "high".
    why: str | None = None
    picked: bool | None = None    # True means this candidate was selected.
    secondary: bool | None = None  # True means this was a secondary candidate.


class RoutingContentData(BaseModel):
    """Routing Content Data schema or model."""
    q: str | None = None          # Routed request, usually a summary of the user's original message.
    picks: list[RoutingPick] = Field(default_factory=list)
    plan: str | None = None       # One-sentence execution plan.


class PermissionContentData(BaseModel):
    """Permission Content Data schema or model."""
    tool: str | None = None
    body: str | None = None
    resolved: bool = False
    resolution: Literal["allow", "deny"] | None = None
    resolved_by: str | None = None
    resolved_at: datetime | None = None


# ==================== Message Create Schemas (discriminated union) ====================

class _MessageCreateBase(BaseModel):
    """Message Create Base schema or model."""
    content: str
    sender_id: str
    sender_type: str = "user"
    file_ids: list[str] = Field(default_factory=list)
    mention_bot_ids: list[str] = Field(default_factory=list)
    is_secret: bool = False


class NormalMessageCreate(_MessageCreateBase):
    """Normal Message Create schema or model."""
    msg_type: Literal["normal"] = "normal"
    content_data: dict[str, Any] | None = None


class ReplyMessageCreate(_MessageCreateBase):
    """Reply Message Create schema or model."""
    msg_type: Literal["reply"] = "reply"
    in_reply_to_msg_id: str
    content_data: dict[str, Any] | None = None


class TopicMessageCreate(_MessageCreateBase):
    """Topic Message Create schema or model."""
    msg_type: Literal["topic"] = "topic"
    content_data: TopicContentData | None = None


class AnnouncementMessageCreate(_MessageCreateBase):
    """Announcement Message Create schema or model."""
    msg_type: Literal["announcement"] = "announcement"
    content_data: AnnouncementContentData | None = None


class RoutingMessageCreate(_MessageCreateBase):
    """Routing Message Create schema or model."""
    msg_type: Literal["routing"] = "routing"
    content_data: RoutingContentData | None = None


class PermissionMessageCreate(_MessageCreateBase):
    """Permission Message Create schema or model."""
    msg_type: Literal["permission"] = "permission"
    content_data: PermissionContentData | None = None


# Unified entry point for legacy clients; msg_type is inferred from in_reply_to_msg_id when omitted.
class MessageCreate(BaseModel):
    """Message Create schema or model."""
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
    """Forward Message Request schema or model."""

    source_message_ids: list[str] = Field(default_factory=list)
    source_file_ids: list[str] = Field(default_factory=list)
    mode: Literal["single", "topic"] = "single"


class ForwardMessageResponse(BaseModel):
    """Forward Message Response schema or model."""

    messages: list[dict[str, Any]] = Field(default_factory=list)


# Discriminated union for newer clients.
AnyMessageCreate = Annotated[
    NormalMessageCreate | ReplyMessageCreate | TopicMessageCreate | AnnouncementMessageCreate | RoutingMessageCreate | PermissionMessageCreate,
    Field(discriminator="msg_type"),
]


class MessageStreamCreate(BaseModel):
    """Message Stream Create schema or model."""
    content: str
    sender_id: str
    sender_type: str = "user"
    file_id: str | None = None
    file_ids: list[str] = Field(default_factory=list)
    mention_bot_ids: list[str] = Field(default_factory=list)


# ==================== Message Response Schemas ====================

class _MessageResponseBase(BaseModel):
    """Message Response Base schema or model."""
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
    """Normal Message In Response schema or model."""
    msg_type: Literal["normal"] = "normal"


class ReplyMessageInResponse(_MessageResponseBase):
    """Reply Message In Response schema or model."""
    msg_type: Literal["reply"] = "reply"
    in_reply_to_msg_id: str


class TopicMessageInResponse(_MessageResponseBase):
    """Topic Message In Response schema or model."""
    msg_type: Literal["topic"] = "topic"


class AnnouncementMessageInResponse(_MessageResponseBase):
    """Announcement Message In Response schema or model."""
    msg_type: Literal["announcement"] = "announcement"


class RoutingMessageInResponse(_MessageResponseBase):
    """Routing Message In Response schema or model."""
    msg_type: Literal["routing"] = "routing"


class PermissionMessageInResponse(_MessageResponseBase):
    """Permission Message In Response schema or model."""
    msg_type: Literal["permission"] = "permission"


AnyMessageInResponse = Annotated[
    NormalMessageInResponse | ReplyMessageInResponse | TopicMessageInResponse | AnnouncementMessageInResponse | RoutingMessageInResponse | PermissionMessageInResponse,
    Field(discriminator="msg_type"),
]


# ==================== Permission resolve endpoint ========================

class PermissionResolveRequest(BaseModel):
    """Permission Resolve Request schema or model."""
    resolution: Literal["allow", "deny"]


# Backward-compatible unified response type with all fields.
class MessageInResponse(_MessageResponseBase):
    """Message In Response schema or model."""
    msg_type: str = "normal"


# ==================== Keychain Schemas ====================

class KeychainItemCreate(BaseModel):
    """Keychain Item Create schema or model."""
    name: str = Field(..., min_length=1, max_length=128, description="Secret name used for references")
    value: str = Field(..., min_length=1, description="Secret value")
    description: str | None = Field(default=None, description="Secret description")


class KeychainItemUpdate(BaseModel):
    """Keychain Item Update schema or model."""
    name: str | None = Field(default=None, min_length=1, max_length=128)
    value: str | None = Field(default=None, min_length=1)
    description: str | None = Field(default=None)


class KeychainItemInResponse(BaseModel):
    """Keychain Item In Response schema or model."""
    model_config = ConfigDict(from_attributes=True)

    key_id: str
    owner_id: str
    name: str
    description: str | None = None
    value_masked: str | None = None  # Masked display value, for example "****abcd".
    created_at: datetime | None = None
    updated_at: datetime | None = None
