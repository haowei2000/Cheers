"""密钥引用解析与注入。"""
import re
from typing import Dict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import KeychainItem
from app.utils.crypto import decrypt_value

# 匹配 $secret{name} 语法
_SECRET_REF_PATTERN = re.compile(r'\$secret\{([^}]+)\}')


def extract_secret_refs(text: str) -> list[str]:
    """从文本中提取所有密钥引用名称。"""
    return _SECRET_REF_PATTERN.findall(text)


def replace_secret_refs(text: str, secrets: Dict[str, str]) -> str:
    """将文本中的密钥引用替换为实际值。"""
    def _replacer(match):
        name = match.group(1)
        if name in secrets:
            return secrets[name]
        return match.group(0)  # 如果密钥不存在，保留原样

    return _SECRET_REF_PATTERN.sub(_replacer, text)


async def load_user_secrets(
    session: AsyncSession,
    user_id: str,
    secret_names: list[str]
) -> Dict[str, str]:
    """从数据库加载用户指定的密钥（已解密）。"""
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
