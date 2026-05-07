"""cascade AgentNexus session rows when deleting bots

Revision ID: 047
Revises: 046
Create Date: 2026-05-07 16:40:00.000000
"""
from typing import Sequence, Union

from alembic import op

revision: str = "047"
down_revision: Union[str, Sequence[str], None] = "046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("agentnexus_session_bindings_session_id_fkey", "agentnexus_session_bindings", type_="foreignkey")
    op.drop_constraint("agentnexus_session_bindings_bot_id_fkey", "agentnexus_session_bindings", type_="foreignkey")
    op.drop_constraint("agentnexus_sessions_bot_id_fkey", "agentnexus_sessions", type_="foreignkey")

    op.create_foreign_key(
        "agentnexus_sessions_bot_id_fkey",
        "agentnexus_sessions",
        "bot_accounts",
        ["bot_id"],
        ["bot_id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "agentnexus_session_bindings_bot_id_fkey",
        "agentnexus_session_bindings",
        "bot_accounts",
        ["bot_id"],
        ["bot_id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "agentnexus_session_bindings_session_id_fkey",
        "agentnexus_session_bindings",
        "agentnexus_sessions",
        ["session_id"],
        ["session_id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("agentnexus_session_bindings_session_id_fkey", "agentnexus_session_bindings", type_="foreignkey")
    op.drop_constraint("agentnexus_session_bindings_bot_id_fkey", "agentnexus_session_bindings", type_="foreignkey")
    op.drop_constraint("agentnexus_sessions_bot_id_fkey", "agentnexus_sessions", type_="foreignkey")

    op.create_foreign_key(
        "agentnexus_sessions_bot_id_fkey",
        "agentnexus_sessions",
        "bot_accounts",
        ["bot_id"],
        ["bot_id"],
    )
    op.create_foreign_key(
        "agentnexus_session_bindings_bot_id_fkey",
        "agentnexus_session_bindings",
        "bot_accounts",
        ["bot_id"],
        ["bot_id"],
    )
    op.create_foreign_key(
        "agentnexus_session_bindings_session_id_fkey",
        "agentnexus_session_bindings",
        "agentnexus_sessions",
        ["session_id"],
        ["session_id"],
    )
