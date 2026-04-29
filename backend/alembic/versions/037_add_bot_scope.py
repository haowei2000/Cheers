"""add bot scope

Revision ID: 037
Revises: 036
Create Date: 2026-04-29 00:00:00.000000

Bot scope replaces the old boolean public/private visibility model for bot
usage. Existing data is migrated conservatively:
  - is_public=false -> private
  - is_public=true  -> friend
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


def downgrade() -> None:
    op.drop_column("bot_accounts", "scope")
