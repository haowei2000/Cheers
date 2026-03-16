"""业务模型；主库为 SQLite，ID 使用 String(36) 存 UUID."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.types import JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def gen_uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    """声明式基类."""
    pass


class AIModel(Base):
    """AI 模型配置：管理可用的 LLM 模型。"""
    __tablename__ = "ai_models"

    model_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # 显示名称，如 "GPT-4o"
    provider: Mapped[str] = mapped_column(String(32), nullable=False)  # openai, ollama, anthropic, etc.
    model_name: Mapped[str] = mapped_column(String(64), nullable=False)  # API 使用的模型名，如 "gpt-4o"
    base_url: Mapped[str] = mapped_column(String(512), nullable=False)  # API Base URL
    api_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)  # API Key（可选，本地模型可为空）
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 模型描述
    is_enabled: Mapped[bool] = mapped_column(default=True)  # 是否启用
    is_builtin: Mapped[bool] = mapped_column(default=False)  # 是否内置（不可删除）
    config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, default=dict)  # 额外配置（temperature 等）
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class BotAccount(Base):
    """Bot 账户：由模型 + 提示词模板组成。"""
    __tablename__ = "bot_accounts"

    bot_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # @ 用的名字
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)  # 显示名称
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Bot 描述
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    
    # 关联模型和模板
    model_id: Mapped[str] = mapped_column(String(36), ForeignKey("ai_models.model_id"), nullable=False)
    template_id: Mapped[str] = mapped_column(String(36), ForeignKey("prompt_templates.template_id"), nullable=False)
    
    # 可选：自定义覆盖
    custom_system_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 覆盖模板的 system_prompt
    
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="online")  # online | offline | busy
    intro: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON: capabilities, description
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    # Relationships
    ai_model: Mapped["AIModel"] = relationship("AIModel", lazy="joined")
    prompt_template: Mapped["PromptTemplate"] = relationship("PromptTemplate", lazy="joined")


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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    channels: Mapped[list["Channel"]] = relationship("Channel", back_populates="workspace")


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
    messages: Mapped[list["Message"]] = relationship("Message", back_populates="channel")
    memberships: Mapped[list["ChannelMembership"]] = relationship(
        "ChannelMembership", back_populates="channel"
    )
    file_records: Mapped[list["FileRecord"]] = relationship("FileRecord", back_populates="channel")


class User(Base):
    """人类用户."""
    __tablename__ = "users"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="member")
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class ChannelMembership(Base):
    """频道成员关系（用户或 Bot）."""
    __tablename__ = "channel_memberships"

    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), primary_key=True
    )
    member_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    member_type: Mapped[str] = mapped_column(String(16), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    added_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)

    channel: Mapped["Channel"] = relationship("Channel", back_populates="memberships")


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
    in_reply_to_msg_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    channel: Mapped["Channel"] = relationship("Channel", back_populates="messages")


class FileRecord(Base):
    """文件记录与处理状态."""
    __tablename__ = "file_records"

    file_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), nullable=False
    )
    uploader_id: Mapped[str] = mapped_column(String(36), nullable=False)
    original_path: Mapped[str] = mapped_column(String(512), nullable=False)
    md_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    summary_3lines: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    converted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

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


class Friendship(Base):
    """好友关系表：记录用户之间的好友关系."""
    __tablename__ = "friendships"

    friendship_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=False)
    friend_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="accepted")  # pending, accepted, blocked
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    # Relationships
    user: Mapped["User"] = relationship("User", foreign_keys=[user_id], lazy="joined")
    friend: Mapped["User"] = relationship("User", foreign_keys=[friend_id], lazy="joined")
