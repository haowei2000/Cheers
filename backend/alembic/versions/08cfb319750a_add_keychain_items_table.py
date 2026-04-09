"""add keychain_items table

Revision ID: 08cfb319750a
Revises: 99ad4af22af0
Create Date: 2026-04-09 14:27:06.684817

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '08cfb319750a'
down_revision: Union[str, Sequence[str], None] = '99ad4af22af0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'keychain_items',
        sa.Column('key_id', sa.String(36), nullable=False),
        sa.Column('owner_id', sa.String(36), nullable=False),
        sa.Column('name', sa.String(128), nullable=False),
        sa.Column('value', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('key_id'),
        sa.ForeignKeyConstraint(['owner_id'], ['users.user_id'], ),
    )
    op.create_index('ix_keychain_items_owner_id', 'keychain_items', ['owner_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_keychain_items_owner_id', table_name='keychain_items')
    op.drop_table('keychain_items')
