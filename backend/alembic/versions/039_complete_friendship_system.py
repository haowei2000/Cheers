"""complete friendship system

Revision ID: 039
Revises: 038
Create Date: 2026-04-30 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

revision: str = "039"
down_revision: str | Sequence[str] | None = "038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _pair_key(a: str, b: str) -> str:
    left, right = sorted([a, b])
    return f"{left}:{right}"


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("friendships")}

    if "pair_key" not in columns:
        op.add_column("friendships", sa.Column("pair_key", sa.String(80), nullable=True))
    if "notice_msg_id" not in columns:
        op.add_column("friendships", sa.Column("notice_msg_id", sa.String(36), nullable=True))
    if "updated_at" not in columns:
        op.add_column("friendships", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
    if "responded_at" not in columns:
        op.add_column("friendships", sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True))

    rows = conn.execute(sa.text(
        "SELECT friendship_id, user_id, friend_id, status, created_at FROM friendships"
    )).mappings().all()

    seen: dict[str, dict] = {}
    duplicate_ids: list[str] = []
    rank = {"blocked": 4, "accepted": 3, "pending": 2, "rejected": 1}
    now = datetime.utcnow()
    for row in rows:
        key = _pair_key(row["user_id"], row["friend_id"])
        current = seen.get(key)
        if current is None:
            seen[key] = dict(row) | {"pair_key": key}
            continue
        current_rank = rank.get(current.get("status") or "", 0)
        row_rank = rank.get(row.get("status") or "", 0)
        if row_rank > current_rank:
            duplicate_ids.append(current["friendship_id"])
            seen[key] = dict(row) | {"pair_key": key}
        else:
            duplicate_ids.append(row["friendship_id"])

    for fid in duplicate_ids:
        conn.execute(sa.text("DELETE FROM friendships WHERE friendship_id = :fid"), {"fid": fid})

    for row in seen.values():
        status = row.get("status") or "accepted"
        if status not in {"pending", "accepted", "rejected", "blocked"}:
            status = "accepted"
        responded_at = None
        if status in {"accepted", "rejected", "blocked"}:
            responded_at = row.get("created_at") or now
        conn.execute(
            sa.text(
                """
                UPDATE friendships
                SET pair_key = :pair_key,
                    status = :status,
                    updated_at = COALESCE(updated_at, created_at, :now),
                    responded_at = COALESCE(responded_at, :responded_at)
                WHERE friendship_id = :fid
                """
            ),
            {
                "pair_key": row["pair_key"],
                "status": status,
                "now": now,
                "responded_at": responded_at,
                "fid": row["friendship_id"],
            },
        )

    indexes = {idx["name"] for idx in inspector.get_indexes("friendships")}
    if "uq_friendships_pair_key" not in indexes:
        op.create_index("uq_friendships_pair_key", "friendships", ["pair_key"], unique=True)


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    indexes = {idx["name"] for idx in inspector.get_indexes("friendships")}
    if "uq_friendships_pair_key" in indexes:
        op.drop_index("uq_friendships_pair_key", table_name="friendships")

    columns = {c["name"] for c in inspector.get_columns("friendships")}
    for column in ("responded_at", "updated_at", "notice_msg_id", "pair_key"):
        if column in columns:
            op.drop_column("friendships", column)
