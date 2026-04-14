"""add_history_pages

Revision ID: 024
Revises: 08cfb319750a
Create Date: 2026-04-09 17:09:17.710721

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '024'
down_revision: Union[str, Sequence[str], None] = '08cfb319750a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('history_pages',
    sa.Column('page_id', sa.String(length=36), nullable=False),
    sa.Column('channel_id', sa.String(length=36), nullable=False),
    sa.Column('page_number', sa.Integer(), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('ended_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('first_msg_id', sa.String(length=36), nullable=False),
    sa.Column('last_msg_id', sa.String(length=36), nullable=False),
    sa.Column('summary', sa.Text(), nullable=False),
    sa.Column('raw_content', sa.Text(), nullable=False),
    sa.Column('message_count', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.channel_id'], ),
    sa.PrimaryKeyConstraint('page_id'),
    sa.UniqueConstraint('channel_id', 'page_number', name='uq_history_pages_channel_page')
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('history_pages')
