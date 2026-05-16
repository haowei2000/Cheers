"""rename OpenClaw bridge storage to Agent Bridge

Revision ID: 046
Revises: 045
Create Date: 2026-05-06
"""
import sqlalchemy as sa

from alembic import op

revision = "046"
down_revision = "045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bot_accounts",
        sa.Column("bridge_provider", sa.String(32), nullable=False, server_default="generic"),
    )
    op.execute(
        "UPDATE bot_accounts "
        "SET binding_type = 'agent_bridge', bridge_provider = 'openclaw' "
        "WHERE binding_type = 'websocket'"
    )
    op.execute("UPDATE bot_runs SET binding_type = 'agent_bridge' WHERE binding_type = 'websocket'")
    op.execute(
        "UPDATE messages "
        "SET content_data = jsonb_set(content_data::jsonb, '{kind}', '\"agent_bridge_background_task\"', false)::json "
        "WHERE content_data ->> 'kind' = 'websocket_background_task'"
    )
    op.drop_table("bot_registration_requests")

    op.rename_table("openclaw_plugin_events", "agent_bridge_events")
    op.drop_index("ix_openclaw_events_bot_stream_seq", table_name="agent_bridge_events")
    op.drop_index("ix_openclaw_events_created_at", table_name="agent_bridge_events")
    op.drop_constraint(
        "uq_openclaw_event_bot_stream_seq",
        "agent_bridge_events",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_agent_bridge_event_bot_stream_seq",
        "agent_bridge_events",
        ["bot_id", "stream", "seq"],
    )
    op.create_index(
        "ix_agent_bridge_events_bot_stream_seq",
        "agent_bridge_events",
        ["bot_id", "stream", "seq"],
    )
    op.create_index(
        "ix_agent_bridge_events_created_at",
        "agent_bridge_events",
        ["created_at"],
    )

    op.drop_index("ix_agentnexus_sessions_bot_agent_account", table_name="agentnexus_sessions")
    op.drop_constraint(
        "uq_agentnexus_sessions_openclaw_session_key",
        "agentnexus_sessions",
        type_="unique",
    )
    op.add_column(
        "agentnexus_sessions",
        sa.Column("provider", sa.String(32), nullable=False, server_default="openclaw"),
    )
    op.alter_column("agentnexus_sessions", "openclaw_account_id", new_column_name="provider_account_id")
    op.alter_column("agentnexus_sessions", "openclaw_agent_id", new_column_name="provider_agent_id")
    op.alter_column("agentnexus_sessions", "openclaw_session_key", new_column_name="provider_session_key")
    op.alter_column("agentnexus_sessions", "openclaw_session_id", new_column_name="provider_session_id")
    op.create_unique_constraint(
        "uq_agentnexus_sessions_provider_session_key",
        "agentnexus_sessions",
        ["provider_session_key"],
    )
    op.create_index(
        "ix_agentnexus_sessions_bot_agent_account",
        "agentnexus_sessions",
        ["bot_id", "provider", "provider_agent_id", "provider_account_id"],
    )

    op.drop_index("ix_agentnexus_session_bindings_lookup", table_name="agentnexus_session_bindings")
    op.drop_constraint(
        "uq_agentnexus_session_binding_scope",
        "agentnexus_session_bindings",
        type_="unique",
    )
    op.add_column(
        "agentnexus_session_bindings",
        sa.Column("provider", sa.String(32), nullable=False, server_default="openclaw"),
    )
    op.alter_column(
        "agentnexus_session_bindings",
        "openclaw_account_id",
        new_column_name="provider_account_id",
    )
    op.alter_column(
        "agentnexus_session_bindings",
        "openclaw_agent_id",
        new_column_name="provider_agent_id",
    )
    op.create_unique_constraint(
        "uq_agentnexus_session_binding_scope",
        "agentnexus_session_bindings",
        ["bot_id", "provider", "provider_agent_id", "provider_account_id", "scope_type", "scope_id"],
    )
    op.create_index(
        "ix_agentnexus_session_bindings_lookup",
        "agentnexus_session_bindings",
        ["bot_id", "provider", "provider_agent_id", "provider_account_id", "scope_type", "scope_id"],
    )


def downgrade() -> None:
    op.create_table(
        "bot_registration_requests",
        sa.Column("request_id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=True),
        sa.Column("openclaw_endpoint", sa.String(512), nullable=False),
        sa.Column("intro", sa.Text(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_bot_id", sa.String(36), nullable=True),
    )
    op.execute(
        "UPDATE messages "
        "SET content_data = jsonb_set(content_data::jsonb, '{kind}', '\"websocket_background_task\"', false)::json "
        "WHERE content_data ->> 'kind' = 'agent_bridge_background_task'"
    )
    op.execute("UPDATE bot_runs SET binding_type = 'websocket' WHERE binding_type = 'agent_bridge'")
    op.drop_index("ix_agentnexus_session_bindings_lookup", table_name="agentnexus_session_bindings")
    op.drop_constraint(
        "uq_agentnexus_session_binding_scope",
        "agentnexus_session_bindings",
        type_="unique",
    )
    op.alter_column(
        "agentnexus_session_bindings",
        "provider_account_id",
        new_column_name="openclaw_account_id",
    )
    op.alter_column(
        "agentnexus_session_bindings",
        "provider_agent_id",
        new_column_name="openclaw_agent_id",
    )
    op.drop_column("agentnexus_session_bindings", "provider")
    op.create_unique_constraint(
        "uq_agentnexus_session_binding_scope",
        "agentnexus_session_bindings",
        ["bot_id", "openclaw_agent_id", "openclaw_account_id", "scope_type", "scope_id"],
    )
    op.create_index(
        "ix_agentnexus_session_bindings_lookup",
        "agentnexus_session_bindings",
        ["bot_id", "openclaw_agent_id", "openclaw_account_id", "scope_type", "scope_id"],
    )

    op.drop_index("ix_agentnexus_sessions_bot_agent_account", table_name="agentnexus_sessions")
    op.drop_constraint(
        "uq_agentnexus_sessions_provider_session_key",
        "agentnexus_sessions",
        type_="unique",
    )
    op.alter_column("agentnexus_sessions", "provider_account_id", new_column_name="openclaw_account_id")
    op.alter_column("agentnexus_sessions", "provider_agent_id", new_column_name="openclaw_agent_id")
    op.alter_column("agentnexus_sessions", "provider_session_key", new_column_name="openclaw_session_key")
    op.alter_column("agentnexus_sessions", "provider_session_id", new_column_name="openclaw_session_id")
    op.drop_column("agentnexus_sessions", "provider")
    op.create_unique_constraint(
        "uq_agentnexus_sessions_openclaw_session_key",
        "agentnexus_sessions",
        ["openclaw_session_key"],
    )
    op.create_index(
        "ix_agentnexus_sessions_bot_agent_account",
        "agentnexus_sessions",
        ["bot_id", "openclaw_agent_id", "openclaw_account_id"],
    )

    op.drop_index("ix_agent_bridge_events_created_at", table_name="agent_bridge_events")
    op.drop_index("ix_agent_bridge_events_bot_stream_seq", table_name="agent_bridge_events")
    op.drop_constraint(
        "uq_agent_bridge_event_bot_stream_seq",
        "agent_bridge_events",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_openclaw_event_bot_stream_seq",
        "agent_bridge_events",
        ["bot_id", "stream", "seq"],
    )
    op.create_index(
        "ix_openclaw_events_bot_stream_seq",
        "agent_bridge_events",
        ["bot_id", "stream", "seq"],
    )
    op.create_index(
        "ix_openclaw_events_created_at",
        "agent_bridge_events",
        ["created_at"],
    )
    op.rename_table("agent_bridge_events", "openclaw_plugin_events")

    op.execute(
        "UPDATE bot_accounts "
        "SET binding_type = 'websocket' "
        "WHERE binding_type = 'agent_bridge' AND bridge_provider = 'openclaw'"
    )
    op.drop_column("bot_accounts", "bridge_provider")
