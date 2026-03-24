"""Add storage columns to file_records and created_by to bot_accounts.

Revision ID: 014
Revises: 013
Create Date: 2026-03-21

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "014"
down_revision: str | None = "013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS_DEFAULT = sa.text("(datetime('now'))")


def upgrade() -> None:
    conn = op.get_bind()

    # bot_accounts.created_by
    bot_cols = [c["name"] for c in sa.inspect(conn).get_columns("bot_accounts")]
    if "created_by" not in bot_cols:
        op.add_column("bot_accounts", sa.Column("created_by", sa.String(36), nullable=True))

    # file_records — storage / metadata columns
    file_cols = [c["name"] for c in sa.inspect(conn).get_columns("file_records")]
    new_file_cols = [
        ("object_key", sa.Column("object_key", sa.String(512), nullable=True)),
        ("storage_bucket", sa.Column("storage_bucket", sa.String(255), nullable=True)),
        ("original_filename", sa.Column("original_filename", sa.String(255), nullable=True)),
        ("content_type", sa.Column("content_type", sa.String(255), nullable=True)),
        ("size_bytes", sa.Column("size_bytes", sa.Integer(), nullable=True)),
        ("last_error", sa.Column("last_error", sa.Text(), nullable=True)),
        ("uploaded_at", sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=True)),
        ("created_at", sa.Column("created_at", sa.DateTime(timezone=True), server_default=TS_DEFAULT, nullable=True)),
    ]
    for col_name, col_def in new_file_cols:
        if col_name not in file_cols:
            op.add_column("file_records", col_def)


def downgrade() -> None:
    op.drop_column("bot_accounts", "created_by")
    for col in ("created_at", "uploaded_at", "last_error", "size_bytes",
                "content_type", "original_filename", "storage_bucket", "object_key"):
        op.drop_column("file_records", col)
