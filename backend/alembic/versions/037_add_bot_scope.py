"""add bot scope

Revision ID: 037
Revises: 036
Create Date: 2026-04-29 00:00:00.000000

Bot scope replaces the old boolean public/private visibility model for bot
usage. Existing data is migrated once:
  - is_public=false -> private
  - is_public=true  -> friend
The old bot_accounts.is_public column is removed after the backfill.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "037"
down_revision: Union[str, Sequence[str], None] = "036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bot_accounts",
        sa.Column("scope", sa.String(16), nullable=False, server_default="friend"),
    )
    op.execute(
        "UPDATE bot_accounts "
        "SET scope = CASE WHEN is_public THEN 'friend' ELSE 'private' END"
    )
    op.drop_column("bot_accounts", "is_public")


def downgrade() -> None:
    op.add_column(
        "bot_accounts",
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="1"),
    )
    op.execute(
        "UPDATE bot_accounts "
        "SET is_public = CASE WHEN scope = 'private' THEN FALSE ELSE TRUE END"
    )
    op.drop_column("bot_accounts", "scope")
