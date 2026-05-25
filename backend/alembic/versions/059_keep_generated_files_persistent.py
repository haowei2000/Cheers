"""keep generated files persistent

Revision ID: 059
Revises: 058
Create Date: 2026-05-22
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "059"
down_revision = "058"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    columns = {c["name"] for c in sa.inspect(conn).get_columns("file_records")}
    if "expires_at" not in columns:
        return

    conn.execute(sa.text(
        """
        UPDATE file_records
        SET expires_at = NULL
        WHERE expires_at IS NOT NULL
          AND (
            COALESCE(object_key, '') LIKE 'generated/%'
            OR COALESCE(original_path, '') LIKE 'generated/%'
            OR COALESCE(original_path, '') LIKE '%/generated/%'
            OR COALESCE(original_path, '') LIKE '%\\generated\\%'
            OR COALESCE(md_path, '') LIKE 'generated/%'
            OR COALESCE(md_path, '') LIKE '%/generated/%'
            OR COALESCE(md_path, '') LIKE '%\\generated\\%'
          )
        """
    ))


def downgrade() -> None:
    # No-op: avoid reintroducing expiry for bot-generated files on rollback.
    pass
