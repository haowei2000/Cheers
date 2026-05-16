"""Initial schema: workspaces, channels, users, bot_accounts, channel_memberships, messages, file_records, agent_tasks.

Primary and foreign keys use String(36), JSON uses sa.JSON, and timestamps default to NOW().
Revision ID: 001
Revises:
Create Date: 2026-03-07

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# SQLite timestamp default.
TS_DEFAULT = sa.text("NOW()")


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("workspace_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True),
        sa.PrimaryKeyConstraint("workspace_id"),
    )
    op.create_table(
        "users",
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("role", sa.String(length=32), nullable=False, server_default="member"),
        sa.Column("avatar_url", sa.String(length=512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True),
        sa.PrimaryKeyConstraint("user_id"),
        sa.UniqueConstraint("username"),
    )
    op.create_table(
        "bot_accounts",
        sa.Column("bot_id", sa.String(36), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("specialty_label", sa.String(length=255), nullable=True),
        sa.Column("soul_config_path", sa.String(length=512), nullable=True),
        sa.Column("openclaw_endpoint", sa.String(length=512), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="offline"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True),
        sa.PrimaryKeyConstraint("bot_id"),
        sa.UniqueConstraint("username"),
    )
    op.create_table(
        "channels",
        sa.Column("channel_id", sa.String(36), nullable=False),
        sa.Column("workspace_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False, server_default="public"),
        sa.Column("purpose", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.workspace_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("channel_id"),
    )
    op.create_table(
        "channel_memberships",
        sa.Column("channel_id", sa.String(36), nullable=False),
        sa.Column("member_id", sa.String(36), nullable=False),
        sa.Column("member_type", sa.String(length=16), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True),
        sa.Column("added_by", sa.String(36), nullable=True),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.channel_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("channel_id", "member_id"),
    )
    op.create_table(
        "messages",
        sa.Column("msg_id", sa.String(36), nullable=False),
        sa.Column("channel_id", sa.String(36), nullable=False),
        sa.Column("sender_id", sa.String(36), nullable=False),
        sa.Column("sender_type", sa.String(length=16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("file_ids", sa.JSON(), nullable=True),
        sa.Column("mention_bot_ids", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.channel_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("msg_id"),
    )
    op.create_table(
        "file_records",
        sa.Column("file_id", sa.String(36), nullable=False),
        sa.Column("channel_id", sa.String(36), nullable=False),
        sa.Column("uploader_id", sa.String(36), nullable=False),
        sa.Column("original_path", sa.String(length=512), nullable=False),
        sa.Column("md_path", sa.String(length=512), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("summary_3lines", sa.Text(), nullable=True),
        sa.Column("converted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.channel_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("file_id"),
    )
    op.create_table(
        "agent_tasks",
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("channel_id", sa.String(36), nullable=False),
        sa.Column("bot_id", sa.String(36), nullable=False),
        sa.Column("trigger_msg_id", sa.String(36), nullable=False),
        sa.Column("response_msg_id", sa.String(36), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("token_count", sa.Integer(), nullable=True),
        sa.Column("feedback", sa.String(length=32), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True),
        sa.PrimaryKeyConstraint("task_id"),
    )


def downgrade() -> None:
    op.drop_table("agent_tasks")
    op.drop_table("file_records")
    op.drop_table("messages")
    op.drop_table("channel_memberships")
    op.drop_table("channels")
    op.drop_table("bot_accounts")
    op.drop_table("users")
    op.drop_table("workspaces")
