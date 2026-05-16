"""031 add bot websocket token module."""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "031"
down_revision: Union[str, Sequence[str], None] = "030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bot_accounts", sa.Column("bot_token_hash", sa.String(256), nullable=True))
    op.add_column("bot_accounts", sa.Column("bot_token_prefix", sa.String(16), nullable=True))
    op.add_column(
        "bot_accounts",
        sa.Column("bot_token_rotated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_bot_accounts_token_prefix",
        "bot_accounts",
        ["bot_token_prefix"],
    )


def downgrade() -> None:
    op.drop_index("ix_bot_accounts_token_prefix", table_name="bot_accounts")
    op.drop_column("bot_accounts", "bot_token_rotated_at")
    op.drop_column("bot_accounts", "bot_token_prefix")
    op.drop_column("bot_accounts", "bot_token_hash")
