"""Canonical IDs for built-in Bot Runtime assistants."""

HELPER_BOT_ID = "bot-helper-001"
OPENCODE_BOT_ID = "bot-opencode-001"
BUILTIN_BOT_IDS = (HELPER_BOT_ID,)


def configured_builtin_bot_ids() -> tuple[str, ...]:
    """Return built-in Bot IDs enabled by the current deployment config."""
    from app.config import settings

    bot_ids = [HELPER_BOT_ID]
    if settings.opencode_bot_enabled:
        opencode_bot_id = (settings.opencode_bot_id or OPENCODE_BOT_ID).strip() or OPENCODE_BOT_ID
        bot_ids.append(opencode_bot_id)
    return tuple(dict.fromkeys(bot_ids))
