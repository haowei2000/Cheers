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
    with op.batch_alter_table("bot_accounts", schema=None) as batch_op:
        batch_op.alter_column("model_id", nullable=True)
        batch_op.alter_column("template_id", nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("bot_accounts", schema=None) as batch_op:
        batch_op.alter_column("model_id", nullable=False)
        batch_op.alter_column("template_id", nullable=False)
