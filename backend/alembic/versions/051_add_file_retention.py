"""add file retention metadata

Revision ID: 051
Revises: 050
Create Date: 2026-05-15
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "051"
down_revision = "050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    cols = [c["name"] for c in sa.inspect(conn).get_columns("file_records")]
    if "expires_at" not in cols:
        op.add_column(
            "file_records",
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        )
    indexes = {ix["name"] for ix in sa.inspect(conn).get_indexes("file_records")}
    if "ix_file_records_expires_at" not in indexes:
        op.create_index("ix_file_records_expires_at", "file_records", ["expires_at"])

    dialect = conn.dialect.name
    if dialect == "postgresql":
        conn.execute(sa.text(
            """
            UPDATE file_records
            SET expires_at = COALESCE(uploaded_at, created_at, NOW()) + INTERVAL '90 days'
            WHERE expires_at IS NULL
            """
        ))
    elif dialect == "sqlite":
        conn.execute(sa.text(
            """
            UPDATE file_records
            SET expires_at = datetime(COALESCE(uploaded_at, created_at, CURRENT_TIMESTAMP), '+90 days')
            WHERE expires_at IS NULL
            """
        ))


def downgrade() -> None:
    op.drop_index("ix_file_records_expires_at", table_name="file_records")
    op.drop_column("file_records", "expires_at")
