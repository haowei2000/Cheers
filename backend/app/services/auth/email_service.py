"""邮件发送服务（SMTP）。

若 SMTP 未配置，则将验证码打印到日志（开发模式）。
"""
import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage

logger = logging.getLogger("app.services.auth.email")


def _send_sync(host: str, port: int, username: str, password: str, use_tls: bool,
               use_ssl: bool, from_addr: str, to_addr: str, subject: str, body: str) -> None:
    """同步 SMTP 发送（在线程中执行）."""
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(body)

    if use_ssl:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, context=context) as smtp:
            smtp.login(username, password)
            smtp.send_message(msg)
    elif use_tls:
        with smtplib.SMTP(host, port) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            smtp.login(username, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port) as smtp:
            if username:
                smtp.login(username, password)
            smtp.send_message(msg)


async def send_verification_code(to_email: str, code: str, purpose: str) -> None:
    """发送验证码邮件。"""
    from app.config import settings

    purpose_labels = {
        "register": "注册",
        "reset_password": "重置密码",
        "change_password": "修改密码",
    }
    label = purpose_labels.get(purpose, "验证")
    subject = f"【智枢协作】{label}验证码"
    body = (
        f"您的{label}验证码为：{code}\n\n"
        f"验证码有效期 10 分钟，请勿泄露给他人。\n\n"
        f"如非本人操作，请忽略此邮件。\n\n"
        f"—— 智枢协作平台"
    )

    if not settings.smtp_host:
        logger.warning(
            "[DEV] SMTP 未配置，验证码将打印到日志。"
            " 请在 .env 中配置 SMTP_HOST 等参数。\n"
            f"  To: {to_email}  Purpose: {purpose}  Code: {code}"
        )
        return

    from_addr = settings.smtp_from or settings.smtp_username
    try:
        await asyncio.to_thread(
            _send_sync,
            settings.smtp_host,
            settings.smtp_port,
            settings.smtp_username,
            settings.smtp_password,
            settings.smtp_use_tls,
            settings.smtp_ssl,
            from_addr,
            to_email,
            subject,
            body,
        )
        logger.info(f"验证码邮件已发送至 {to_email} (purpose={purpose})")
    except Exception as e:
        logger.error(f"发送验证码邮件失败: {e}")
        raise
