"""Mention module."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


# Match @username or @botname, allowing letters, digits, underscores, hyphens, apostrophes, CJK chars, and no spaces.
MENTION_PATTERN = re.compile(r"@([a-zA-Z0-9_\-'一-鿿]+)")
_NAME_CHAR = re.compile(r"[a-zA-Z0-9_\-'一-鿿]")
_WS_CHARS = " \t"


def _skip_leading_quote_block(text: str) -> int:
    """Skip leading quote block."""
    n = len(text)
    probe = 0
    while probe < n and text[probe] in _WS_CHARS:
        probe += 1
    if probe >= n or text[probe] != ">":
        return 0

    pos = 0
    saw_quote = False
    while pos < n:
        eol = text.find("\n", pos)
        end = eol if eol != -1 else n
        line = text[pos:end].lstrip(_WS_CHARS)
        if line.startswith(">"):
            saw_quote = True
        elif line == "" and saw_quote:
            pass
        else:
            break
        pos = end + 1 if eol != -1 else n
    return pos if saw_quote else 0


def extract_mentions(text: str, known_space_names: list[str] | None = None) -> list[str]:
    """Extract mentions."""
    if not text or not text.strip():
        return []

    space_names: list[str] = []
    for name in known_space_names or []:
        if " " in name:
            space_names.append(name)
    space_names.sort(key=len, reverse=True)

    seen: set[str] = set()
    result: list[str] = []
    n = len(text)
    pos = _skip_leading_quote_block(text)
    # Skip leading whitespace.
    while pos < n and text[pos] in _WS_CHARS:
        pos += 1

    while pos < n and text[pos] == "@":
        matched_name: str | None = None

        # Prefer bot names that contain spaces, with longer names first.
        for sp in space_names:
            target = f"@{sp}"
            if text.startswith(target, pos):
                end = pos + len(target)
                # Confirm the right boundary: end-of-string or a following non-name character.
                if end == n or not _NAME_CHAR.match(text[end]):
                    matched_name = sp
                    pos = end
                    break

        if matched_name is None:
            m = MENTION_PATTERN.match(text, pos)
            if not m:
                break
            matched_name = m.group(1)
            pos = m.end()

        if matched_name not in seen:
            seen.add(matched_name)
            result.append(matched_name)

        # Consume whitespace after the mention, then continue trying the next @.
        while pos < n and text[pos] in _WS_CHARS:
            pos += 1

    return result


async def resolve_user_mentions(
    content: str,
    session: "AsyncSession",
    channel_id: str,
) -> list[str]:
    """Resolve user mentions."""
    mentioned = extract_mentions(content)
    if not mentioned:
        return []

    from sqlalchemy import select

    from app.db.models import ChannelMembership, User

    result = await session.execute(
        select(User.user_id)
        .join(ChannelMembership, ChannelMembership.member_id == User.user_id)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_type == "user",
            User.username.in_(mentioned),
        )
    )
    return [row[0] for row in result.all()]


def filter_mentioned_bots(
    mentioned_names: list[str],
    channel_bot_usernames: list[str],
) -> list[str]:
    """Filter mentioned bots."""
    channel_set = set(channel_bot_usernames)
    seen: set[str] = set()
    result: list[str] = []
    for name in mentioned_names:
        if name in channel_set and name not in seen:
            result.append(name)
            seen.add(name)
    return result
