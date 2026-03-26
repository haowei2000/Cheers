"""Make bot_accounts.model_id and template_id nullable (builtin bots need no LLM FK).

Revision ID: 017
Revises: 016
Create Date: 2026-03-26

"""
from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "017"
down_revision: Union[str, Sequence[str], None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("bot_accounts", "model_id", nullable=True)
    op.alter_column("bot_accounts", "template_id", nullable=True)


def downgrade() -> None:
    op.alter_column("bot_accounts", "model_id", nullable=False)
    op.alter_column("bot_accounts", "template_id", nullable=False)
