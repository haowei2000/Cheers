"""add AgentNexus session mappings for OpenClaw

Revision ID: 043
Revises: 041
Create Date: 2026-04-30 00:00:00.000000

AgentNexus owns the durable session id. Channel / DM / topic / task scopes are
bound to that session and the OpenClaw plugin receives the mapped sessionKey.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "043"
down_revision: Union[str, Sequence[str], None] = "041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agentnexus_sessions",
        sa.Column("session_id", sa.String(36), primary_key=True),
        sa.Column("bot_id", sa.String(36), nullable=False),
        sa.Column("openclaw_account_id", sa.String(128), nullable=False),
        sa.Column("openclaw_agent_id", sa.String(128), nullable=False, server_default="main"),
        sa.Column("openclaw_session_key", sa.String(512), nullable=False),
        sa.Column("openclaw_session_id", sa.String(128), nullable=True),
        sa.Column("current_scope_type", sa.String(16), nullable=False),
        sa.Column("current_scope_id", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="active"),
        sa.Column("metadata", sa.JSON(), nullable=True),
        sa.Column(
            "last_used_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["bot_id"], ["bot_accounts.bot_id"]),
        sa.UniqueConstraint("openclaw_session_key", name="uq_agentnexus_sessions_openclaw_session_key"),
    )
    op.create_index("ix_agentnexus_sessions_bot_id", "agentnexus_sessions", ["bot_id"])
    op.create_index(
        "ix_agentnexus_sessions_bot_agent_account",
        "agentnexus_sessions",
        ["bot_id", "openclaw_agent_id", "openclaw_account_id"],
    )

    op.create_table(
        "agentnexus_session_bindings",
        sa.Column("binding_id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("bot_id", sa.String(36), nullable=False),
        sa.Column("openclaw_account_id", sa.String(128), nullable=False),
        sa.Column("openclaw_agent_id", sa.String(128), nullable=False, server_default="main"),
        sa.Column("scope_type", sa.String(16), nullable=False),
        sa.Column("scope_id", sa.String(128), nullable=False),
        sa.Column("channel_id", sa.String(36), nullable=True),
        sa.Column("topic_id", sa.String(36), nullable=True),
        sa.Column("dm_id", sa.String(36), nullable=True),
        sa.Column("task_id", sa.String(36), nullable=True),
        sa.Column("role", sa.String(16), nullable=False, server_default="primary"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("detached_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["bot_id"], ["bot_accounts.bot_id"]),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.channel_id"]),
        sa.ForeignKeyConstraint(["session_id"], ["agentnexus_sessions.session_id"]),
        sa.UniqueConstraint(
            "bot_id",
            "openclaw_agent_id",
            "openclaw_account_id",
            "scope_type",
            "scope_id",
            name="uq_agentnexus_session_binding_scope",
        ),
        sa.UniqueConstraint(
            "session_id",
            "scope_type",
            "scope_id",
            name="uq_agentnexus_session_binding_session_scope",
        ),
    )
    op.create_index(
        "ix_agentnexus_session_bindings_session_id",
        "agentnexus_session_bindings",
        ["session_id"],
    )
    op.create_index(
        "ix_agentnexus_session_bindings_bot_id",
        "agentnexus_session_bindings",
        ["bot_id"],
    )
    op.create_index(
        "ix_agentnexus_session_bindings_lookup",
        "agentnexus_session_bindings",
        ["bot_id", "openclaw_agent_id", "openclaw_account_id", "scope_type", "scope_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_agentnexus_session_bindings_lookup", table_name="agentnexus_session_bindings")
    op.drop_index("ix_agentnexus_session_bindings_bot_id", table_name="agentnexus_session_bindings")
    op.drop_index("ix_agentnexus_session_bindings_session_id", table_name="agentnexus_session_bindings")
    op.drop_table("agentnexus_session_bindings")
    op.drop_index("ix_agentnexus_sessions_bot_agent_account", table_name="agentnexus_sessions")
    op.drop_index("ix_agentnexus_sessions_bot_id", table_name="agentnexus_sessions")
    op.drop_table("agentnexus_sessions")
