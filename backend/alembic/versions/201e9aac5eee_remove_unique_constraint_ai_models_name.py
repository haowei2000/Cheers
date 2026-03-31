"""remove_unique_constraint_ai_models_name

Revision ID: 201e9aac5eee
Revises: 021
Create Date: 2026-03-31 11:19:12.964656

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '201e9aac5eee'
down_revision: Union[str, Sequence[str], None] = '021'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Remove unique constraint on ai_models.name."""
    op.drop_index('ix_ai_models_name', table_name='ai_models', if_exists=True)
    op.drop_constraint('ai_models_name_key', 'ai_models', type_='unique')


def downgrade() -> None:
    """Restore unique constraint on ai_models.name."""
    op.create_unique_constraint('ai_models_name_key', 'ai_models', ['name'])
