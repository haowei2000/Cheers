"""add bot run lifecycle table

Revision ID: 045
Revises: 044
Create Date: 2026-05-06
"""
import sqlalchemy as sa

from alembic import op

revision = "045"
down_revision = "044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "bot_runs",
        sa.Column("bot_run_id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("channel_id", sa.String(36), nullable=False),
        sa.Column("trigger_msg_id", sa.String(36), nullable=False),
        sa.Column("bot_id", sa.String(36), nullable=False),
        sa.Column("placeholder_msg_id", sa.String(36), nullable=False),
        sa.Column("binding_type", sa.String(32), nullable=False, server_default="http"),
        sa.Column("status", sa.String(32), nullable=False, server_default="placeholder_created"),
        sa.Column("last_event_type", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
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
        sa.UniqueConstraint("placeholder_msg_id", name="uq_bot_runs_placeholder_msg_id"),
    )
    op.create_index("ix_bot_runs_task_bot", "bot_runs", ["task_id", "bot_id"])
    op.create_index("ix_bot_runs_channel_status", "bot_runs", ["channel_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_bot_runs_channel_status", table_name="bot_runs")
    op.drop_index("ix_bot_runs_task_bot", table_name="bot_runs")
    op.drop_table("bot_runs")

