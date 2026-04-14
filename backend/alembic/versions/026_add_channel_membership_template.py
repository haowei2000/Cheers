"""add template_id to channel_memberships

Revision ID: 026
Revises: 025
Create Date: 2026-04-14

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "026"
down_revision: Union[str, None] = "025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "channel_memberships",
        sa.Column("template_id", sa.String(36), sa.ForeignKey("prompt_templates.template_id"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_memberships", "template_id")
