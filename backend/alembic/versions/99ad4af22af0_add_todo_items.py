"""add_todo_items

Revision ID: 99ad4af22af0
Revises: 023
Create Date: 2026-04-08 16:52:20.870417

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '99ad4af22af0'
down_revision: Union[str, Sequence[str], None] = '023'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'todo_items',
        sa.Column('todo_id', sa.String(36), primary_key=True),
        sa.Column('channel_id', sa.String(36), sa.ForeignKey('channels.channel_id'), nullable=False, index=True),
        sa.Column('creator_id', sa.String(36), nullable=False),
        sa.Column('creator_type', sa.String(16), nullable=False),
        sa.Column('assignee_id', sa.String(36), nullable=True),
        sa.Column('assignee_type', sa.String(16), nullable=True),
        sa.Column('content', sa.Text, nullable=False),
        sa.Column('status', sa.String(32), nullable=False, server_default='pending'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table('todo_items')
