"""API Key 加密工具：使用 Fernet 对称加密存储敏感凭据。"""
import logging
from pathlib import Path

logger = logging.getLogger("app.utils.crypto")

# Fernet prefix marker used to distinguish ciphertext from legacy plaintext.
_CIPHER_PREFIX = "enc:"

# Global Fernet instance, initialized lazily.
_fernet = None


def _get_fernet():
    """返回全局 Fernet 实例，首次调用时初始化。"""
    global _fernet
    if _fernet is not None:
        return _fernet

    from cryptography.fernet import Fernet

    from app.config import settings

    key_str = (settings.api_key_encryption_key or "").strip()

    if key_str:
        try:
            _fernet = Fernet(key_str.encode())
            return _fernet
        except Exception:
            logger.warning("API_KEY_ENCRYPTION_KEY 格式无效，将自动生成新密钥")

    # Missing or invalid config: read from the persisted key file or generate a new key.
    _BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
    key_file = _BACKEND_ROOT / settings.data_dir / ".encryption_key"
    if not key_file.is_absolute():
        key_file = (_BACKEND_ROOT / settings.data_dir / ".encryption_key").resolve()

    if key_file.exists():
        try:
            stored = key_file.read_text().strip()
            _fernet = Fernet(stored.encode())
            return _fernet
        except Exception:
            logger.warning("加密密钥文件损坏，将重新生成")

    # Generate and persist a new key.
    new_key = Fernet.generate_key()
    try:
        key_file.parent.mkdir(parents=True, exist_ok=True)
        key_file.write_bytes(new_key)
        key_file.chmod(0o600)
        logger.warning(
            "已自动生成 API Key 加密密钥并保存至 %s。"
            "建议将此密钥设置到 .env 的 API_KEY_ENCRYPTION_KEY 变量中。",
            key_file,
        )
    except Exception as e:
        logger.error("无法持久化加密密钥：%s，密钥仅在本次进程内有效", e)

    _fernet = Fernet(new_key)
    return _fernet


def encrypt_value(plaintext: str) -> str:
    """加密字符串，返回带前缀的密文。空字符串原样返回。"""
    if not plaintext:
        return plaintext
    fernet = _get_fernet()
    ciphertext = fernet.encrypt(plaintext.encode()).decode()
    return _CIPHER_PREFIX + ciphertext


def decrypt_value(value: str) -> str:
    """解密字符串。若值不含加密前缀（旧版明文），原样返回。"""
    if not value:
        return value
    if not value.startswith(_CIPHER_PREFIX):
        # Legacy plaintext is returned as-is; callers are responsible for writing back encrypted data.
        return value
    ciphertext = value[len(_CIPHER_PREFIX):]
    fernet = _get_fernet()
    try:
        return fernet.decrypt(ciphertext.encode()).decode()
    except Exception:
        logger.error("API Key 解密失败，可能密钥已更换或数据损坏")
        return ""
