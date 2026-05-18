import pytest

from app.db import seed


@pytest.mark.parametrize(
    "password",
    ["", "   ", "change-me-admin-password", "admin#Nexus2024"],
)
def test_seed_rejects_empty_or_default_admin_password(monkeypatch, password):
    monkeypatch.setattr(seed.settings, "admin_password", password)

    with pytest.raises(RuntimeError, match="ADMIN_PASSWORD must be set"):
        seed._validate_seed_admin_password()


def test_seed_accepts_explicit_strong_admin_password(monkeypatch):
    monkeypatch.setattr(seed.settings, "admin_password", "A-real-admin-password-2026!")

    seed._validate_seed_admin_password()
