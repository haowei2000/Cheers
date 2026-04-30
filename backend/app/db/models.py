"""业务模型；主库为 SQLite，ID 使用 String(36) 存 UUID."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import JSON


def gen_uuid() -> str:
    return str(uuid.uuid4())


def friendship_pair_key_default(context) -> str:
    params = context.get_current_parameters()
    left, right = sorted([params.get("user_id") or "", params.get("friend_id") or ""])
    return f"{left}:{right}"


class Base(DeclarativeBase):
    """声明式基类."""
    pass


class AIModel(Base):
    """AI 模型配置：管理可用的 LLM 模型。"""
    __tablename__ = "ai_models"

    model_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    name: Mapped[str] = mapped_column(String(64), nullable=False)  # 显示名称，如 "GPT-4o"
    provider: Mapped[str] = mapped_column(String(32), nullable=False)  # openai, ollama, anthropic, etc.
    model_name: Mapped[str] = mapped_column(String(64), nullable=False)  # API 使用的模型名，如 "gpt-4o"
    base_url: Mapped[str] = mapped_column(String(512), nullable=False)  # API Base URL
    api_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)  # API Key（可选，本地模型可为空）
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 模型描述
    is_enabled: Mapped[bool] = mapped_column(default=True)  # 是否启用
    is_builtin: Mapped[bool] = mapped_column(default=False)  # 是否内置（不可删除）
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="1", default=True)  # 公开/私有
    config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, default=dict)  # 额外配置（temperature 等）
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)  # 创建者 user_id
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class PromptTemplate(Base):
    """提示词模板：可复用的 System Prompt + User Template。"""
    __tablename__ = "prompt_templates"

    template_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # 模板名称，如 "代码审查"
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 描述
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)  # 系统提示词
    user_template: Mapped[str] = mapped_column(Text, nullable=False, default="{{message}}")  # 用户消息模板
    variables: Mapped[list] = mapped_column(JSON, nullable=True, default=list)  # 变量列表，如 ["message"]
    is_builtin: Mapped[bool] = mapped_column(default=False)  # 是否内置模板（不可删除）
    created_by: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.user_id"), nullable=True, default=None
    )  # 模板创建者，为空表示系统/管理员创建
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class BotAccount(Base):
    """Bot 账户：由模型 + 提示词模板组成。"""
    __tablename__ = "bot_accounts"

    bot_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # @ 用的名字
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)  # 显示名称
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Bot 描述
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    # 关联模型和模板（内置 Bot 可为 None）
    model_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("ai_models.model_id"), nullable=True)
    template_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("prompt_templates.template_id"), nullable=True)

    # 可选：自定义覆盖
    custom_system_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 覆盖模板的 system_prompt

    status: Mapped[str] = mapped_column(String(32), nullable=False, default="online")  # online | offline | busy
    scope: Mapped[str] = mapped_column(String(16), nullable=False, server_default="friend", default="friend")
    intro: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON: capabilities, description
    # 绑定类型：'http'=OpenAI 兼容 HTTP（默认，HttpBotAdapter）；
    #           'websocket'=经 OpenClaw bridge 异步回推（新接入形式，对应 OpenClaw channel plugin）
    binding_type: Mapped[str] = mapped_column(String(32), nullable=False, server_default="http", default="http")
    binding_config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # e.g. {"agent_id": "...", "gateway": "..."}
    # WebSocket Bot 凭证：明文 token 仅在创建/轮换时返回一次，此后只存哈希
    bot_token_hash: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    bot_token_prefix: Mapped[Optional[str]] = mapped_column(String(16), nullable=True, index=True)
    bot_token_rotated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)  # 创建者 user_id
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    # Relationships
    ai_model: Mapped[Optional["AIModel"]] = relationship("AIModel", lazy="joined")
    prompt_template: Mapped[Optional["PromptTemplate"]] = relationship("PromptTemplate", lazy="joined")


class BotRegistrationRequest(Base):
    """外部 OpenClaw 注册申请（待管理员审核）- 保留兼容旧版。"""
    __tablename__ = "bot_registration_requests"

    request_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    openclaw_endpoint: Mapped[str] = mapped_column(String(512), nullable=False)
    intro: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_bot_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)


class Workspace(Base):
    """工作区（顶层组织单元）."""
    __tablename__ = "workspaces"

    workspace_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # "team" (default, shared workspace with channels) or "personal" (auto-
    # provisioned per user; hosts their DMs).
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="team", default="team"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    channels: Mapped[list["Channel"]] = relationship("Channel", back_populates="workspace", cascade="all, delete-orphan")
    memberships: Mapped[list["WorkspaceMembership"]] = relationship("WorkspaceMembership", cascade="all, delete-orphan")


class Channel(Base):
    """频道/协作群."""
    __tablename__ = "channels"

    channel_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.workspace_id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False, default="public")
    purpose: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    auto_assist: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0", default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    workspace: Mapped["Workspace"] = relationship("Workspace", back_populates="channels")
    messages: Mapped[list["Message"]] = relationship("Message", back_populates="channel", cascade="all, delete-orphan")
    memberships: Mapped[list["ChannelMembership"]] = relationship(
        "ChannelMembership", back_populates="channel", cascade="all, delete-orphan"
    )
    file_records: Mapped[list["FileRecord"]] = relationship("FileRecord", back_populates="channel", cascade="all, delete-orphan")
    history_pages: Mapped[list["HistoryPage"]] = relationship("HistoryPage", cascade="all, delete-orphan")


class User(Base):
    """人类用户."""
    __tablename__ = "users"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    email: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    bio: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="member")
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class EmailCode(Base):
    """邮件验证码（注册/找回密码/修改密码）."""
    __tablename__ = "email_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)  # register | reset_password | change_password
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0", default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class ChannelMembership(Base):
    """频道成员关系（用户或 Bot）."""
    __tablename__ = "channel_memberships"

    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), primary_key=True
    )
    member_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    member_type: Mapped[str] = mapped_column(String(16), nullable=False)
    role: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="member", default="member"
    )  # "owner" | "admin" | "member"；仅用户成员参与频道管理权限
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    added_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    # 频道级提示词模板覆盖（仅 bot 成员有效，为空时使用 BotAccount 默认模板）
    template_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("prompt_templates.template_id"), nullable=True, default=None
    )
    # 用户阅读游标：最近一次点开频道并标记已读的时间戳；NULL 表示从未标记。
    # 用于在 /channels 列表接口里派生 unread_count。
    last_read_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )

    channel: Mapped["Channel"] = relationship("Channel", back_populates="memberships")
    prompt_template: Mapped[Optional["PromptTemplate"]] = relationship("PromptTemplate", lazy="joined")


class WorkspaceMembership(Base):
    """工作空间成员关系."""
    __tablename__ = "workspace_memberships"

    workspace_id: Mapped[str] = mapped_column(String(36), ForeignKey("workspaces.workspace_id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(20), default="member")  # "owner" | "admin" | "member"
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Message(Base):
    """消息."""
    __tablename__ = "messages"

    msg_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    task_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), nullable=False
    )
    sender_id: Mapped[str] = mapped_column(String(36), nullable=False)
    sender_type: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    file_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
    mention_bot_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
    mention_user_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
    in_reply_to_msg_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    msg_type: Mapped[str] = mapped_column(String(16), nullable=False, server_default="normal", default="normal")
    content_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    is_secret: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0", default=False)
    secret_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    secret_token: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    is_partial: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0", default=False)

    channel: Mapped["Channel"] = relationship("Channel", back_populates="messages")


class HistoryPage(Base):
    __tablename__ = "history_pages"

    page_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[str] = mapped_column(String(36), ForeignKey("channels.channel_id"), nullable=False)
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    first_msg_id: Mapped[str] = mapped_column(String(36), nullable=False)
    last_msg_id: Mapped[str] = mapped_column(String(36), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    raw_content: Mapped[str] = mapped_column(Text, nullable=False)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("channel_id", "page_number", name="uq_history_pages_channel_page"),
    )


class FileRecord(Base):
    """文件记录与处理状态."""
    __tablename__ = "file_records"

    file_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), nullable=False
    )
    uploader_id: Mapped[str] = mapped_column(String(36), nullable=False)
    original_path: Mapped[str] = mapped_column(String(512), nullable=False)
    object_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    storage_bucket: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    original_filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    content_type: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    size_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    md_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    summary_3lines: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    uploaded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    converted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    channel: Mapped["Channel"] = relationship("Channel", back_populates="file_records")


class AgentTask(Base):
    """Agent 任务日志（质量监控）."""
    __tablename__ = "agent_tasks"

    task_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[str] = mapped_column(String(36), nullable=False)
    bot_id: Mapped[str] = mapped_column(String(36), nullable=False)
    trigger_msg_id: Mapped[str] = mapped_column(String(36), nullable=False)
    response_msg_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    latency_ms: Mapped[Optional[int]] = mapped_column(nullable=True)
    token_count: Mapped[Optional[int]] = mapped_column(nullable=True)
    feedback: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class ChannelProfile(Base):
    """用户在频道内的个性化资料（昵称、简介）."""
    __tablename__ = "channel_profiles"

    channel_id: Mapped[str] = mapped_column(String(36), ForeignKey("channels.channel_id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), primary_key=True)
    nickname: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    bio: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class Friendship(Base):
    """好友关系表：记录用户之间的好友申请与关系状态.

    user_id 是关系的发起/控制方：
    - pending / rejected: user_id 为申请人，friend_id 为接收人
    - accepted: user_id 保留最初申请人，friend_id 为同意人
    - blocked: user_id 为拉黑人，friend_id 为被拉黑人

    pair_key 是两个用户 ID 排序后的稳定键，用来保证任意两人之间只有一条关系记录。
    """
    __tablename__ = "friendships"

    friendship_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=False)
    friend_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=False)
    pair_key: Mapped[str] = mapped_column(String(80), nullable=False, default=friendship_pair_key_default)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")  # pending, accepted, rejected, blocked
    notice_msg_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow
    )
    responded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # Relationships
    user: Mapped["User"] = relationship("User", foreign_keys=[user_id], lazy="joined")
    friend: Mapped["User"] = relationship("User", foreign_keys=[friend_id], lazy="joined")

    __table_args__ = (
        UniqueConstraint("pair_key", name="uq_friendships_pair_key"),
    )


class SystemSetting(Base):
    """系统配置键值表（替代 admin_settings.json）。"""
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class BulletinIssue(Base):
    """公共留言板 Issue。"""
    __tablename__ = "bulletin_issues"

    issue_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="open")    # open | closed
    priority: Mapped[str] = mapped_column(String(32), nullable=False, default="medium")  # low | medium | high
    tags: Mapped[list] = mapped_column(JSON, nullable=True, default=list)
    creator_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    creator_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class TodoItem(Base):
    """Channel Todo List Items."""
    __tablename__ = "todo_items"

    todo_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[str] = mapped_column(String(36), ForeignKey("channels.channel_id"), nullable=False, index=True)
    creator_id: Mapped[str] = mapped_column(String(36), nullable=False)
    creator_type: Mapped[str] = mapped_column(String(16), nullable=False) # "user" or "bot"
    assignee_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    assignee_type: Mapped[Optional[str]] = mapped_column(String(16), nullable=True) # "user" or "bot"
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending") # pending, completed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    channel: Mapped["Channel"] = relationship("Channel")


class MemoryEntry(Base):
    """频道记忆条目：ANCHOR / DECISIONS / PROGRESS 层的结构化单条记录。"""
    __tablename__ = "memory_entries"

    entry_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    layer: Mapped[str] = mapped_column(String(50), nullable=False)  # ANCHOR / DECISIONS / PROGRESS
    title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    creator_type: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)  # "user" / "bot"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("channel_id", "layer", "sort_order", name="uq_memory_entries_channel_layer_order"),
    )


class KeychainItem(Base):
    """用户密钥链：存储个人敏感凭据。"""
    __tablename__ = "keychain_items"

    key_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)  # 用户定义的密钥名称
    value: Mapped[str] = mapped_column(Text, nullable=False)  # 加密存储的密钥值
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 可选描述
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    owner: Mapped["User"] = relationship("User", lazy="joined")


class OpenClawPluginEvent(Base):
    """per-bot WS 派发事件日志，用于 plugin 重连时按 last_event_seq 回放。"""
    __tablename__ = "openclaw_plugin_events"

    event_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    bot_id: Mapped[str] = mapped_column(String(36), nullable=False)
    stream: Mapped[str] = mapped_column(String(16), nullable=False)  # 'data'
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("bot_id", "stream", "seq", name="uq_openclaw_event_bot_stream_seq"),
    )
