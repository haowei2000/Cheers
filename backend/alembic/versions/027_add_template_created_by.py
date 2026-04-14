"""add created_by to prompt_templates

Revision ID: 027
Revises: 026
Create Date: 2026-04-14

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "027"
down_revision: Union[str, None] = "026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "prompt_templates",
        sa.Column("created_by", sa.String(36), sa.ForeignKey("users.user_id"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("prompt_templates", "created_by")
