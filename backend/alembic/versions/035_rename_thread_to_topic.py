"""035 rename thread to topic module."""
from typing import Sequence, Union

from alembic import op

revision: str = "035"
down_revision: Union[str, Sequence[str], None] = "034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE messages SET msg_type = 'topic' WHERE msg_type = 'thread'",
    )


def downgrade() -> None:
    op.execute(
        "UPDATE messages SET msg_type = 'thread' WHERE msg_type = 'topic'",
    )
