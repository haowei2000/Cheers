"""extend file retention to one year

Revision ID: 052
Revises: 051
Create Date: 2026-05-16
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "052"
down_revision = "051"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    columns = {c["name"] for c in sa.inspect(conn).get_columns("file_records")}
    if "expires_at" not in columns:
        return

    dialect = conn.dialect.name
    if dialect == "postgresql":
        conn.execute(sa.text(
            """
            UPDATE file_records
            SET expires_at = CASE
                WHEN COALESCE(uploaded_at, created_at, NOW()) + INTERVAL '365 days' > expires_at
                THEN COALESCE(uploaded_at, created_at, NOW()) + INTERVAL '365 days'
                ELSE expires_at
            END
            WHERE expires_at IS NOT NULL
            """
        ))
    elif dialect == "sqlite":
        conn.execute(sa.text(
            """
            UPDATE file_records
            SET expires_at = CASE
                WHEN datetime(COALESCE(uploaded_at, created_at, CURRENT_TIMESTAMP), '+365 days') > expires_at
                THEN datetime(COALESCE(uploaded_at, created_at, CURRENT_TIMESTAMP), '+365 days')
                ELSE expires_at
            END
            WHERE expires_at IS NOT NULL
            """
        ))


def downgrade() -> None:
    # No-op: avoid shortening existing file retention during code rollback.
    pass
