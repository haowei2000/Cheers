"""add_memory_entries

Revision ID: 025
Revises: 024
Create Date: 2026-04-13

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '025'
down_revision: Union[str, Sequence[str], None] = '024'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('memory_entries',
        sa.Column('entry_id', sa.String(length=36), nullable=False),
        sa.Column('channel_id', sa.String(length=36), nullable=False),
        sa.Column('layer', sa.String(length=50), nullable=False),
        sa.Column('title', sa.String(length=255), nullable=True),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_by', sa.String(length=36), nullable=True),
        sa.Column('creator_type', sa.String(length=16), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['channel_id'], ['channels.channel_id']),
        sa.PrimaryKeyConstraint('entry_id'),
        sa.UniqueConstraint('channel_id', 'layer', 'sort_order', name='uq_memory_entries_channel_layer_order'),
    )
    op.create_index('ix_memory_entries_channel_id', 'memory_entries', ['channel_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_memory_entries_channel_id', table_name='memory_entries')
    op.drop_table('memory_entries')
