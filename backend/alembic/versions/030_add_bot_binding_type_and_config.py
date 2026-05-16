"""030 add bot binding type and config module."""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "030"
down_revision: Union[str, Sequence[str], None] = "029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bot_accounts",
        sa.Column("binding_type", sa.String(32), nullable=False, server_default="http"),
    )
    op.add_column(
        "bot_accounts",
        sa.Column("binding_config", sa.JSON, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("bot_accounts", "binding_config")
    op.drop_column("bot_accounts", "binding_type")
