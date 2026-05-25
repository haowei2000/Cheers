"""Business data models for the primary SQLite database."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.core.prompt_templates import DEFAULT_USER_TEMPLATE


def gen_uuid() -> str:
    return str(uuid.uuid4())


def friendship_pair_key_default(context) -> str:
    params = context.get_current_parameters()
    left, right = sorted([params.get("user_id") or "", params.get("friend_id") or ""])
    return f"{left}:{right}"


class Base(DeclarativeBase):
    """Base schema or model."""
    pass


class AIModel(Base):
    """AI model configuration for available LLM models."""
    __tablename__ = "ai_models"

    model_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    name: Mapped[str] = mapped_column(String(64), nullable=False)  # Display name, for example "GPT-4o".
    provider: Mapped[str] = mapped_column(String(32), nullable=False)  # openai, ollama, anthropic, etc.
    model_name: Mapped[str] = mapped_column(String(64), nullable=False)  # API model name, for example "gpt-4o".
    base_url: Mapped[str] = mapped_column(String(512), nullable=False)  # API Base URL
    api_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)  # Optional API key; local models may leave it empty.
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Model description.
    is_enabled: Mapped[bool] = mapped_column(default=True)  # Whether the model is enabled.
    is_builtin: Mapped[bool] = mapped_column(default=False)  # Built-in models cannot be deleted.
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="1", default=True)  # Public or private visibility.
    config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, default=dict)  # Extra config such as temperature.
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)  # Creator user_id.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class PromptTemplate(Base):
    """Reusable prompt template made from a system prompt and user template."""
    __tablename__ = "prompt_templates"

    template_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # Template name, for example "General assistant".
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Description.
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)  # System prompt.
    user_template: Mapped[str] = mapped_column(Text, nullable=False, default=DEFAULT_USER_TEMPLATE)  # User-message template.
    variables: Mapped[list] = mapped_column(JSON, nullable=True, default=list)  # Variable list, for example ["message"].
    tags: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # Free-form tags for grouping templates.
    default_bot_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey(
            "bot_accounts.bot_id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_prompt_templates_default_bot_id",
        ),
        nullable=True,
        default=None,
    )
    is_builtin: Mapped[bool] = mapped_column(default=False)  # Built-in templates cannot be deleted.
    scope: Mapped[str] = mapped_column(String(16), nullable=False, server_default="friend", default="friend")
    created_by: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.user_id"), nullable=True, default=None
    )  # Template creator; empty means system/admin-created.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class BotAccount(Base):
    """Bot account composed from a model and prompt template."""
    __tablename__ = "bot_accounts"

    bot_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # Name used for @mentions.
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)  # Display name.
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Bot description.
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    # Associated model and template; built-in bots may leave these empty.
    model_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("ai_models.model_id"), nullable=True)
    template_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("prompt_templates.template_id"), nullable=True)

    # Optional custom overrides.
    custom_system_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Overrides the template system_prompt.

    status: Mapped[str] = mapped_column(String(32), nullable=False, default="online")  # online | offline | busy
    scope: Mapped[str] = mapped_column(String(16), nullable=False, server_default="friend", default="friend")
    intro: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON: capabilities, description
    # Binding type: 'http'=OpenAI-compatible HTTP via HttpBotAdapter;
    #               'agent_bridge'=async callback through Agent Bridge.
    binding_type: Mapped[str] = mapped_column(String(32), nullable=False, server_default="http", default="http")
    bridge_provider: Mapped[str] = mapped_column(String(32), nullable=False, server_default="generic", default="generic")
    binding_config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # e.g. {"agent_id": "...", "gateway": "..."}
    # Agent Bridge credentials; plaintext tokens are only returned during create/rotate, then only hashes are stored.
    bot_token_hash: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    bot_token_prefix: Mapped[Optional[str]] = mapped_column(String(16), nullable=True, index=True)
    bot_token_rotated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)  # Creator user_id.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    # Relationships
    ai_model: Mapped[Optional["AIModel"]] = relationship("AIModel", lazy="joined")
    prompt_template: Mapped[Optional["PromptTemplate"]] = relationship(
        "PromptTemplate",
        foreign_keys=[template_id],
        lazy="joined",
    )


class Workspace(Base):
    """Workspace as the top-level organization unit."""
    __tablename__ = "workspaces"

    workspace_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    default_bot_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("bot_accounts.bot_id", ondelete="SET NULL"),
        nullable=True,
        default=None,
    )
    # "team" (default, shared workspace with channels) or "personal" (auto-
    # provisioned per user; hosts their DMs).
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="team", default="team"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    channels: Mapped[list["Channel"]] = relationship("Channel", back_populates="workspace", cascade="all, delete-orphan")
    memberships: Mapped[list["WorkspaceMembership"]] = relationship("WorkspaceMembership", cascade="all, delete-orphan")
    default_bot: Mapped[Optional["BotAccount"]] = relationship("BotAccount", lazy="joined")


class Channel(Base):
    """Channel schema or model."""
    __tablename__ = "channels"

    channel_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.workspace_id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False, default="public")
    purpose: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    auto_assist: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0", default=False)
    allow_member_invites: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="1", default=True
    )
    allow_bot_adds: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="1", default=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    workspace: Mapped["Workspace"] = relationship("Workspace", back_populates="channels")
    messages: Mapped[list["Message"]] = relationship("Message", back_populates="channel", cascade="all, delete-orphan")
    memberships: Mapped[list["ChannelMembership"]] = relationship(
        "ChannelMembership", back_populates="channel", cascade="all, delete-orphan"
    )
    file_records: Mapped[list["FileRecord"]] = relationship("FileRecord", back_populates="channel")
    history_pages: Mapped[list["HistoryPage"]] = relationship("HistoryPage", cascade="all, delete-orphan")


class User(Base):
    """User schema or model."""
    __tablename__ = "users"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    email: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    bio: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="member")
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0", default=False)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class AuthExternalIdentity(Base):
    """External identity linked to an AgentNexus user."""
    __tablename__ = "auth_external_identities"

    identity_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=False)
    corp_id: Mapped[str] = mapped_column(String(128), nullable=False)
    union_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    open_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    mobile: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    profile: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    user: Mapped["User"] = relationship("User", lazy="joined")

    __table_args__ = (
        UniqueConstraint("provider", "subject", name="uq_auth_external_identities_provider_subject"),
        Index("ix_auth_external_identities_user", "user_id"),
        Index("ix_auth_external_identities_provider_corp", "provider", "corp_id"),
    )


class EmailCode(Base):
    """Email Code schema or model."""
    __tablename__ = "email_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)  # register | reset_password | change_password
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0", default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class ChannelMembership(Base):
    """Channel membership relation for users and bots."""
    __tablename__ = "channel_memberships"

    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), primary_key=True
    )
    member_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    member_type: Mapped[str] = mapped_column(String(16), nullable=False)
    role: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="member", default="member"
    )  # "owner" | "admin" | "member"; only user members participate in channel-management permissions.
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    added_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    # Channel-level prompt-template override; valid for bot members only.
    template_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("prompt_templates.template_id"), nullable=True, default=None
    )
    # User read cursor: timestamp for the latest read mark; NULL means never marked.
    # Used to derive unread_count in the /channels list endpoint.
    last_read_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # Per-user rail visibility for DMs. Hidden memberships remain valid so the
    # conversation can reappear when a new message arrives.
    hidden_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )

    channel: Mapped["Channel"] = relationship("Channel", back_populates="memberships")
    prompt_template: Mapped[Optional["PromptTemplate"]] = relationship("PromptTemplate", lazy="joined")

    __table_args__ = (
        Index("ix_channel_memberships_member_type", "member_id", "member_type"),
    )


class ChannelUnreadCount(Base):
    """Per-user unread-count cache for channel and DM lists."""
    __tablename__ = "channel_unread_counts"

    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    unread_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0", default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    __table_args__ = (
        Index("ix_channel_unread_counts_user", "user_id"),
    )


class WorkspaceMembership(Base):
    """Workspace Membership schema or model."""
    __tablename__ = "workspace_memberships"

    workspace_id: Mapped[str] = mapped_column(String(36), ForeignKey("workspaces.workspace_id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(20), default="member")  # "owner" | "admin" | "member"
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Message(Base):
    """Message schema or model."""
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
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0", default=False)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)

    channel: Mapped["Channel"] = relationship("Channel", back_populates="messages")

    __table_args__ = (
        Index("ix_messages_channel_created_at", "channel_id", "created_at"),
        Index("ix_messages_channel_created_msg_id", "channel_id", "created_at", "msg_id"),
        Index("ix_messages_in_reply_created_at", "in_reply_to_msg_id", "created_at"),
    )


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
    """File Record schema or model."""
    __tablename__ = "file_records"

    file_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    # Legacy origin channel. File visibility is now driven by FileScopeLink.
    channel_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), nullable=True
    )
    workspace_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("workspaces.workspace_id"), nullable=True, index=True
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
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    converted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    channel: Mapped["Channel"] = relationship("Channel", back_populates="file_records")

    __table_args__ = (
        Index("ix_file_records_channel_created_at", "channel_id", "created_at"),
        Index("ix_file_records_expires_at", "expires_at"),
    )


class FileScopeLink(Base):
    """Visibility/context link between a file and a product scope."""
    __tablename__ = "file_scope_links"

    link_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("file_records.file_id", ondelete="CASCADE"), nullable=False
    )
    scope_type: Mapped[str] = mapped_column(String(16), nullable=False)
    scope_id: Mapped[str] = mapped_column(String(128), nullable=False)
    workspace_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("workspaces.workspace_id"), nullable=True
    )
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    file: Mapped["FileRecord"] = relationship("FileRecord")

    __table_args__ = (
        UniqueConstraint("file_id", "scope_type", "scope_id", name="uq_file_scope_links_file_scope"),
        Index("ix_file_scope_links_scope", "scope_type", "scope_id"),
        Index("ix_file_scope_links_file", "file_id"),
    )


class DocumentSet(Base):
    """Scoped collection of similar documents."""
    __tablename__ = "document_sets"

    set_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("channels.channel_id", ondelete="CASCADE"), nullable=True, index=True
    )
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    auto_rule: Mapped[str] = mapped_column(String(64), nullable=False, default="title_without_digits")
    similarity_threshold: Mapped[float] = mapped_column(Float, nullable=False, default=0.9)
    created_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow
    )

    items: Mapped[list["DocumentSetItem"]] = relationship(
        "DocumentSetItem", back_populates="document_set", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_document_sets_channel_created_at", "channel_id", "created_at"),
        Index("ix_document_sets_owner_created_at", "owner_id", "created_at"),
    )


class DocumentSetItem(Base):
    """A file membership within a document set."""
    __tablename__ = "document_set_items"

    item_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    set_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("document_sets.set_id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("file_records.file_id", ondelete="CASCADE"), nullable=False, index=True
    )
    added_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    is_manual: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    document_set: Mapped["DocumentSet"] = relationship("DocumentSet", back_populates="items")
    file: Mapped["FileRecord"] = relationship("FileRecord")

    __table_args__ = (
        UniqueConstraint("set_id", "file_id", name="uq_document_set_items_set_file"),
    )


class DocumentSetExclusion(Base):
    """A channel file manually kept outside automatic document grouping."""
    __tablename__ = "document_set_exclusions"

    exclusion_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("channels.channel_id", ondelete="CASCADE"), nullable=True, index=True
    )
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("file_records.file_id", ondelete="CASCADE"), nullable=False, index=True
    )
    updated_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow
    )

    file: Mapped["FileRecord"] = relationship("FileRecord")

    __table_args__ = (
        UniqueConstraint("channel_id", "file_id", name="uq_document_set_exclusions_channel_file"),
        UniqueConstraint("owner_id", "file_id", name="uq_document_set_exclusions_owner_file"),
    )


class AgentTask(Base):
    """Agent Task schema or model."""
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


class BotRun(Base):
    """Bot Run schema or model."""
    __tablename__ = "bot_runs"

    bot_run_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    task_id: Mapped[str] = mapped_column(String(36), nullable=False)
    channel_id: Mapped[str] = mapped_column(String(36), nullable=False)
    trigger_msg_id: Mapped[str] = mapped_column(String(36), nullable=False)
    bot_id: Mapped[str] = mapped_column(String(36), nullable=False)
    placeholder_msg_id: Mapped[str] = mapped_column(String(36), nullable=False)
    binding_type: Mapped[str] = mapped_column(String(32), nullable=False, default="http")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="placeholder_created")
    last_event_type: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow
    )

    __table_args__ = (
        UniqueConstraint("placeholder_msg_id", name="uq_bot_runs_placeholder_msg_id"),
        Index("ix_bot_runs_task_bot", "task_id", "bot_id"),
        Index("ix_bot_runs_channel_status", "channel_id", "status"),
    )


class ChannelProfile(Base):
    """Channel Profile schema or model."""
    __tablename__ = "channel_profiles"

    channel_id: Mapped[str] = mapped_column(String(36), ForeignKey("channels.channel_id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), primary_key=True)
    nickname: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    bio: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class Friendship(Base):
    """Friendship schema or model."""
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
    """System Setting schema or model."""
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class BulletinIssue(Base):
    """Bulletin Issue schema or model."""
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
    """Memory Entry schema or model."""
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
    """User keychain item for personal sensitive credentials."""
    __tablename__ = "keychain_items"

    key_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)  # User-defined key name.
    value: Mapped[str] = mapped_column(Text, nullable=False)  # Encrypted key value.
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Optional description.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    owner: Mapped["User"] = relationship("User", lazy="joined")


class AgentBridgeEvent(Base):
    """Agent Bridge Event schema or model."""
    __tablename__ = "agent_bridge_events"

    event_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bot_id: Mapped[str] = mapped_column(String(36), nullable=False)
    stream: Mapped[str] = mapped_column(String(16), nullable=False)  # 'data'
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("bot_id", "stream", "seq", name="uq_agent_bridge_event_bot_stream_seq"),
    )


class AgentNexusSession(Base):
    """AgentNexus-owned stable session mapped to a provider session key.

    Provider session ids are implementation details of the current transcript.
    This row is the durable product-level session identity.
    """
    __tablename__ = "agentnexus_sessions"

    session_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    bot_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("bot_accounts.bot_id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, server_default="generic", default="generic")
    provider_account_id: Mapped[str] = mapped_column(String(128), nullable=False)
    provider_agent_id: Mapped[str] = mapped_column(String(128), nullable=False, server_default="main", default="main")
    provider_session_key: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    provider_session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    current_scope_type: Mapped[str] = mapped_column(String(16), nullable=False)
    current_scope_id: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, server_default="active", default="active")
    session_metadata: Mapped[Optional[dict]] = mapped_column("metadata", JSON, nullable=True)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow
    )

    bot: Mapped["BotAccount"] = relationship("BotAccount", lazy="joined")
    bindings: Mapped[list["AgentNexusSessionBinding"]] = relationship(
        "AgentNexusSessionBinding",
        back_populates="session",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index(
            "ix_agentnexus_sessions_bot_agent_account",
            "bot_id",
            "provider",
            "provider_agent_id",
            "provider_account_id",
        ),
    )


class AgentNexusSessionBinding(Base):
    """Maps channel / dm / topic / task scopes to a stable AgentNexus session."""
    __tablename__ = "agentnexus_session_bindings"

    binding_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agentnexus_sessions.session_id", ondelete="CASCADE"), nullable=False, index=True
    )
    bot_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("bot_accounts.bot_id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, server_default="generic", default="generic")
    provider_account_id: Mapped[str] = mapped_column(String(128), nullable=False)
    provider_agent_id: Mapped[str] = mapped_column(String(128), nullable=False, server_default="main", default="main")
    scope_type: Mapped[str] = mapped_column(String(16), nullable=False)
    scope_id: Mapped[str] = mapped_column(String(128), nullable=False)
    channel_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("channels.channel_id"), nullable=True)
    topic_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    dm_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    task_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False, server_default="primary", default="primary")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    detached_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    session: Mapped["AgentNexusSession"] = relationship("AgentNexusSession", back_populates="bindings")
    bot: Mapped["BotAccount"] = relationship("BotAccount", lazy="joined")

    __table_args__ = (
        UniqueConstraint(
            "bot_id",
            "provider",
            "provider_agent_id",
            "provider_account_id",
            "scope_type",
            "scope_id",
            name="uq_agentnexus_session_binding_scope",
        ),
        UniqueConstraint(
            "session_id",
            "scope_type",
            "scope_id",
            name="uq_agentnexus_session_binding_session_scope",
        ),
        Index(
            "ix_agentnexus_session_bindings_lookup",
            "bot_id",
            "provider",
            "provider_agent_id",
            "provider_account_id",
            "scope_type",
            "scope_id",
        ),
    )
