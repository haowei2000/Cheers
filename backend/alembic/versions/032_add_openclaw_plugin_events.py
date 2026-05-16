"""032 add openclaw plugin events module."""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "032"
down_revision: Union[str, Sequence[str], None] = "031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "openclaw_plugin_events",
        sa.Column("event_id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("bot_id", sa.String(36), nullable=False),
        sa.Column("stream", sa.String(16), nullable=False),
        sa.Column("seq", sa.BigInteger, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("bot_id", "stream", "seq", name="uq_openclaw_event_bot_stream_seq"),
    )
    op.create_index(
        "ix_openclaw_events_bot_stream_seq",
        "openclaw_plugin_events",
        ["bot_id", "stream", "seq"],
    )
    op.create_index(
        "ix_openclaw_events_created_at",
        "openclaw_plugin_events",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_openclaw_events_created_at", table_name="openclaw_plugin_events")
    op.drop_index("ix_openclaw_events_bot_stream_seq", table_name="openclaw_plugin_events")
    op.drop_table("openclaw_plugin_events")
