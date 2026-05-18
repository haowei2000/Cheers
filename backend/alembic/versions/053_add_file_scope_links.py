"""add file scope links

Revision ID: 053
Revises: 052
Create Date: 2026-05-18
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "053"
down_revision = "052"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    file_columns = {c["name"] for c in inspector.get_columns("file_records")}

    if "workspace_id" not in file_columns:
        op.add_column("file_records", sa.Column("workspace_id", sa.String(36), nullable=True))
        op.create_index("ix_file_records_workspace_id", "file_records", ["workspace_id"])

    if "channel_id" in file_columns:
        with op.batch_alter_table("file_records") as batch_op:
            batch_op.alter_column(
                "channel_id",
                existing_type=sa.String(length=36),
                nullable=True,
            )

    if "file_scope_links" not in inspector.get_table_names():
        op.create_table(
            "file_scope_links",
            sa.Column("link_id", sa.String(36), primary_key=True, nullable=False),
            sa.Column("file_id", sa.String(36), sa.ForeignKey("file_records.file_id", ondelete="CASCADE"), nullable=False),
            sa.Column("scope_type", sa.String(16), nullable=False),
            sa.Column("scope_id", sa.String(128), nullable=False),
            sa.Column("workspace_id", sa.String(36), sa.ForeignKey("workspaces.workspace_id"), nullable=True),
            sa.Column("created_by", sa.String(36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("file_id", "scope_type", "scope_id", name="uq_file_scope_links_file_scope"),
        )
        op.create_index("ix_file_scope_links_scope", "file_scope_links", ["scope_type", "scope_id"])
        op.create_index("ix_file_scope_links_file", "file_scope_links", ["file_id"])

    conn.execute(sa.text(
        """
        UPDATE file_records
        SET workspace_id = (
            SELECT channels.workspace_id
            FROM channels
            WHERE channels.channel_id = file_records.channel_id
        )
        WHERE workspace_id IS NULL
          AND channel_id IS NOT NULL
        """
    ))

    dialect = conn.dialect.name
    uuid_expr = "md5(random()::text || clock_timestamp()::text)" if dialect == "postgresql" else "lower(hex(randomblob(16)))"
    now_expr = "NOW()" if dialect == "postgresql" else "CURRENT_TIMESTAMP"

    conn.execute(sa.text(
        f"""
        INSERT INTO file_scope_links (
            link_id, file_id, scope_type, scope_id, workspace_id, created_by, created_at
        )
        SELECT
            {uuid_expr},
            fr.file_id,
            'personal',
            fr.uploader_id,
            fr.workspace_id,
            fr.uploader_id,
            COALESCE(fr.created_at, {now_expr})
        FROM file_records fr
        WHERE fr.uploader_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM file_scope_links fsl
              WHERE fsl.file_id = fr.file_id
                AND fsl.scope_type = 'personal'
                AND fsl.scope_id = fr.uploader_id
          )
        """
    ))

    conn.execute(sa.text(
        f"""
        INSERT INTO file_scope_links (
            link_id, file_id, scope_type, scope_id, workspace_id, created_by, created_at
        )
        SELECT
            {uuid_expr},
            fr.file_id,
            CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END,
            fr.channel_id,
            c.workspace_id,
            fr.uploader_id,
            COALESCE(fr.created_at, {now_expr})
        FROM file_records fr
        JOIN channels c ON c.channel_id = fr.channel_id
        WHERE fr.channel_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM file_scope_links fsl
              WHERE fsl.file_id = fr.file_id
                AND fsl.scope_type = CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END
                AND fsl.scope_id = fr.channel_id
          )
        """
    ))


def downgrade() -> None:
    op.drop_index("ix_file_scope_links_file", table_name="file_scope_links")
    op.drop_index("ix_file_scope_links_scope", table_name="file_scope_links")
    op.drop_table("file_scope_links")
    op.drop_index("ix_file_records_workspace_id", table_name="file_records")
    op.drop_column("file_records", "workspace_id")
    # Do not re-tighten file_records.channel_id; rows may have been created as
    # library-only files after this migration.
