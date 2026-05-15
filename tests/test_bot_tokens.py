"""Agent Bridge Bot token 生成 / 前缀 / 验证（纯单元测试）."""
from __future__ import annotations

from types import SimpleNamespace

from app.features.agent_bridge.tokens import (
    apply_token_to_bot,
    generate_bot_token,
    token_prefix_of,
)


def test_generate_token_has_expected_prefix_and_length() -> None:
    t = generate_bot_token()
    assert t.startswith("agb_")
    # base64url 32 bytes ≈ 43 chars + 4 prefix
    assert len(t) >= 40
    assert token_prefix_of(t) == t[:8]


def test_generate_tokens_are_unique() -> None:
    seen = {generate_bot_token() for _ in range(50)}
    assert len(seen) == 50


def test_apply_token_to_bot_populates_fields() -> None:
    bot = SimpleNamespace(
        bot_id="b1",
        bot_token_hash=None,
        bot_token_prefix=None,
        bot_token_rotated_at=None,
    )
    plaintext = apply_token_to_bot(bot)
    assert plaintext.startswith("agb_")
    assert bot.bot_token_prefix == plaintext[:8]
    assert bot.bot_token_hash is not None
    # The hash must not be plaintext.
    assert plaintext not in bot.bot_token_hash
    assert bot.bot_token_rotated_at is not None


def test_apply_token_rotates_hash() -> None:
    bot = SimpleNamespace(
        bot_id="b1", bot_token_hash=None, bot_token_prefix=None, bot_token_rotated_at=None,
    )
    t1 = apply_token_to_bot(bot)
    hash1 = bot.bot_token_hash
    rotated1 = bot.bot_token_rotated_at

    t2 = apply_token_to_bot(bot)
    assert t2 != t1
    assert bot.bot_token_hash != hash1
    assert bot.bot_token_rotated_at >= rotated1
