import pytest

from app.config import settings
from app.core.exceptions import BadRequestError
from app.services.auth_service import _prepare_registration_email


def test_registration_email_policy_is_disabled_by_default(monkeypatch) -> None:
    monkeypatch.setattr(settings, "registration_email_pattern", "")

    assert _prepare_registration_email(None) is None
    assert _prepare_registration_email(" User@Example.COM ") == "user@example.com"


def test_registration_email_policy_allows_matching_email(monkeypatch) -> None:
    monkeypatch.setattr(settings, "registration_email_pattern", r"[^@]+@example\.com")

    assert _prepare_registration_email("alice@example.com") == "alice@example.com"


def test_registration_email_policy_rejects_non_matching_email(monkeypatch) -> None:
    monkeypatch.setattr(settings, "registration_email_pattern", r"[^@]+@example\.com")

    with pytest.raises(BadRequestError, match="注册邮箱不符合要求"):
        _prepare_registration_email("alice@other.com")


def test_registration_email_policy_requires_email_when_configured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "registration_email_pattern", r"[^@]+@example\.com")

    with pytest.raises(BadRequestError, match="注册邮箱不能为空"):
        _prepare_registration_email(None)
