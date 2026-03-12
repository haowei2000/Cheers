"""业务模型（详细设计 §6.1）；主库为 SQLite，ID 使用 String(36) 存 UUID."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.types import JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def gen_uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    """声明式基类."""
    pass


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
    type: Mapped[str] = mapped_column(String(32), nullable=False, default="public")  # public | private
    purpose: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
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
    # 角色: system_admin | space_admin | channel_admin | member | guest
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="member")
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class BotAccount(Base):
    """Bot 账户（每个 OpenClaw 实例一条）."""
    __tablename__ = "bot_accounts"

    bot_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    specialty_label: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    soul_config_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    openclaw_endpoint: Mapped[str] = mapped_column(String(512), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="offline")  # offline | online | busy
    intro: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON: capabilities, description
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class BotRegistrationRequest(Base):
    """外部 OpenClaw 注册申请（待管理员审核）。"""
    __tablename__ = "bot_registration_requests"

    request_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    openclaw_endpoint: Mapped[str] = mapped_column(String(512), nullable=False)
    intro: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON: capabilities, description
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")  # pending | approved | rejected
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_bot_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)


class ChannelMembership(Base):
    """频道成员关系（用户或 Bot）."""
    __tablename__ = "channel_memberships"

    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), primary_key=True
    )
    member_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    member_type: Mapped[str] = mapped_column(String(16), nullable=False)  # user | bot
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    added_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)

    channel: Mapped["Channel"] = relationship("Channel", back_populates="memberships")


class Message(Base):
    """消息."""
    __tablename__ = "messages"

    msg_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=gen_uuid)
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.channel_id"), nullable=False
    )
    sender_id: Mapped[str] = mapped_column(String(36), nullable=False)
    sender_type: Mapped[str] = mapped_column(String(16), nullable=False)  # user | bot
    content: Mapped[str] = mapped_column(Text, nullable=False)
    file_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)  # list of file_id
    mention_bot_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
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
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")  # pending | converting | ready | failed
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
    feedback: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)  # like | dislike
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
