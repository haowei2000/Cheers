"""add document sets

Revision ID: 061
Revises: 060
Create Date: 2026-05-25
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "061"
down_revision = "060"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "document_sets",
        sa.Column("set_id", sa.String(36), primary_key=True, nullable=False),
        sa.Column(
            "channel_id",
            sa.String(36),
            sa.ForeignKey("channels.channel_id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("owner_id", sa.String(36), nullable=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("auto_rule", sa.String(64), nullable=False, server_default="title_without_digits"),
        sa.Column("similarity_threshold", sa.Float(), nullable=False, server_default="0.9"),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_document_sets_channel_id", "document_sets", ["channel_id"])
    op.create_index("ix_document_sets_owner_id", "document_sets", ["owner_id"])
    op.create_index(
        "ix_document_sets_channel_created_at",
        "document_sets",
        ["channel_id", "created_at"],
    )
    op.create_index(
        "ix_document_sets_owner_created_at",
        "document_sets",
        ["owner_id", "created_at"],
    )

    op.create_table(
        "document_set_items",
        sa.Column("item_id", sa.String(36), primary_key=True, nullable=False),
        sa.Column(
            "set_id",
            sa.String(36),
            sa.ForeignKey("document_sets.set_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "file_id",
            sa.String(36),
            sa.ForeignKey("file_records.file_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("added_by", sa.String(36), nullable=True),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("is_manual", sa.Boolean(), nullable=False, server_default="0"),
        sa.UniqueConstraint("set_id", "file_id", name="uq_document_set_items_set_file"),
    )
    op.create_index("ix_document_set_items_set_id", "document_set_items", ["set_id"])
    op.create_index("ix_document_set_items_file_id", "document_set_items", ["file_id"])

    op.create_table(
        "document_set_exclusions",
        sa.Column("exclusion_id", sa.String(36), primary_key=True, nullable=False),
        sa.Column(
            "channel_id",
            sa.String(36),
            sa.ForeignKey("channels.channel_id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("owner_id", sa.String(36), nullable=True),
        sa.Column(
            "file_id",
            sa.String(36),
            sa.ForeignKey("file_records.file_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("channel_id", "file_id", name="uq_document_set_exclusions_channel_file"),
        sa.UniqueConstraint("owner_id", "file_id", name="uq_document_set_exclusions_owner_file"),
    )
    op.create_index("ix_document_set_exclusions_channel_id", "document_set_exclusions", ["channel_id"])
    op.create_index("ix_document_set_exclusions_owner_id", "document_set_exclusions", ["owner_id"])
    op.create_index("ix_document_set_exclusions_file_id", "document_set_exclusions", ["file_id"])


def downgrade() -> None:
    op.drop_index("ix_document_set_exclusions_file_id", table_name="document_set_exclusions")
    op.drop_index("ix_document_set_exclusions_owner_id", table_name="document_set_exclusions")
    op.drop_index("ix_document_set_exclusions_channel_id", table_name="document_set_exclusions")
    op.drop_table("document_set_exclusions")
    op.drop_index("ix_document_set_items_file_id", table_name="document_set_items")
    op.drop_index("ix_document_set_items_set_id", table_name="document_set_items")
    op.drop_table("document_set_items")
    op.drop_index("ix_document_sets_channel_created_at", table_name="document_sets")
    op.drop_index("ix_document_sets_owner_created_at", table_name="document_sets")
    op.drop_index("ix_document_sets_owner_id", table_name="document_sets")
    op.drop_index("ix_document_sets_channel_id", table_name="document_sets")
    op.drop_table("document_sets")
