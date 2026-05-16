"""Secrets module."""
import re
from typing import Dict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import KeychainItem
from app.utils.crypto import decrypt_value

# Match $secret{name} syntax.
_SECRET_REF_PATTERN = re.compile(r'\$secret\{([^}]+)\}')


def extract_secret_refs(text: str) -> list[str]:
    """Extract secret refs."""
    return _SECRET_REF_PATTERN.findall(text)


def replace_secret_refs(text: str, secrets: Dict[str, str]) -> str:
    """Replace secret refs."""
    def _replacer(match):
        name = match.group(1)
        if name in secrets:
            return secrets[name]
        return match.group(0)  # Preserve the original text when the key does not exist.

    return _SECRET_REF_PATTERN.sub(_replacer, text)


async def load_user_secrets(
    session: AsyncSession,
    user_id: str,
    secret_names: list[str]
) -> Dict[str, str]:
    """Load user secrets."""
    if not secret_names:
        return {}

    stmt = select(KeychainItem).where(
        KeychainItem.owner_id == user_id,
        KeychainItem.name.in_(secret_names)
    )
    result = await session.execute(stmt)
    items = result.scalars().all()

    secrets = {}
    for item in items:
        decrypted = decrypt_value(item.value)
        if decrypted:
            secrets[item.name] = decrypted

    return secrets
