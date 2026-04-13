"""add_memory_entries

Revision ID: 025
Revises: 024
Create Date: 2026-04-13

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '025'
down_revision: Union[str, Sequence[str], None] = '024'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 需要从 context_store 迁移到 memory_entries 的层
_MIGRATE_LAYERS = ("ANCHOR", "DECISIONS", "PROGRESS")


def upgrade() -> None:
    """Upgrade schema."""
    # 1. 建表
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
        sa.PrimaryKeyConstraint('entry_id'),
        sa.UniqueConstraint('channel_id', 'layer', 'sort_order', name='uq_memory_entries_channel_layer_order'),
    )
    op.create_index('ix_memory_entries_channel_id', 'memory_entries', ['channel_id'])

    # 2. 从 context_store 迁移 ANCHOR/DECISIONS/PROGRESS 数据
    conn = op.get_bind()

    # 检查 context_store 表是否存在（可能在同库或不存在）
    inspector = sa.inspect(conn)
    if 'context_store' not in inspector.get_table_names():
        return

    rows = conn.execute(
        sa.text(
            "SELECT channel_id, layer, content, updated_at "
            "FROM context_store "
            "WHERE layer IN ('ANCHOR', 'DECISIONS', 'PROGRESS') AND content != ''"
        ),
    ).fetchall()

    if not rows:
        return

    for row in rows:
        channel_id, layer, content, updated_at = row
        conn.execute(
            sa.text(
                "INSERT INTO memory_entries "
                "(entry_id, channel_id, layer, title, content, sort_order, creator_type, created_at, updated_at) "
                "VALUES (:eid, :cid, :layer, NULL, :content, 1, 'system', :ts, :ts)"
            ),
            {
                "eid": str(uuid.uuid4()),
                "cid": channel_id,
                "layer": layer.upper(),
                "content": content,
                "ts": updated_at,
            },
        )


def downgrade() -> None:
    """Downgrade schema."""
    # 将 memory_entries 数据写回 context_store（尽力而为）
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if 'context_store' in inspector.get_table_names():
        rows = conn.execute(
            sa.text(
                "SELECT channel_id, layer, string_agg(content, E'\\n\\n' ORDER BY sort_order) "
                "FROM memory_entries "
                "WHERE layer IN ('ANCHOR', 'DECISIONS', 'PROGRESS') "
                "GROUP BY channel_id, layer"
            ),
        ).fetchall()
        for channel_id, layer, content in rows:
            conn.execute(
                sa.text(
                    "INSERT INTO context_store (channel_id, layer, content, updated_at) "
                    "VALUES (:cid, :layer, :content, NOW()) "
                    "ON CONFLICT (channel_id, layer) DO UPDATE SET content = :content, updated_at = NOW()"
                ),
                {"cid": channel_id, "layer": layer, "content": content},
            )

    op.drop_index('ix_memory_entries_channel_id', table_name='memory_entries')
    op.drop_table('memory_entries')
