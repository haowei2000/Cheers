"""Small locale helpers for AgentNexus built-in defaults.

The product currently has a curated Chinese/English UI layer. Backend data that
is generated without a user request still needs a stable default, while request
driven flows should follow the current frontend language.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

DEFAULT_LOCALE = "en"
ZH_LOCALE = "zh-CN"
SUPPORTED_LOCALES = (DEFAULT_LOCALE, ZH_LOCALE)
CONTENT_LOCALE_KEY = "locale"
LANGUAGE_HEADER = "x-agentnexus-language"


def normalize_locale(value: str | None) -> str:
    """Normalize app language/header values to the backend-supported set."""
    if not value:
        return DEFAULT_LOCALE

    # Accept both plain values ("zh-CN") and Accept-Language style headers.
    for raw_part in str(value).split(","):
        part = raw_part.split(";", 1)[0].strip().replace("_", "-").lower()
        if not part:
            continue
        if part.startswith("zh"):
            return ZH_LOCALE
        if part == "en" or part.startswith("en-"):
            return DEFAULT_LOCALE
        # Frontend auto-* languages are browser-translated from English today.
        if part.startswith("auto-"):
            return DEFAULT_LOCALE
    return DEFAULT_LOCALE


def locale_from_headers(headers: Mapping[str, str] | None) -> str:
    if not headers:
        return DEFAULT_LOCALE
    explicit = headers.get(LANGUAGE_HEADER) or headers.get("X-AgentNexus-Language")
    if explicit:
        return normalize_locale(explicit)
    return normalize_locale(headers.get("accept-language") or headers.get("Accept-Language"))


def locale_from_content_data(content_data: Any) -> str:
    if isinstance(content_data, dict):
        raw = content_data.get(CONTENT_LOCALE_KEY) or content_data.get("language")
        if isinstance(raw, str):
            return normalize_locale(raw)
    return DEFAULT_LOCALE


def with_content_locale(content_data: Any, locale: str | None) -> dict[str, Any]:
    if hasattr(content_data, "model_dump"):
        content_data = content_data.model_dump(exclude_none=True)
    data = dict(content_data or {})
    data[CONTENT_LOCALE_KEY] = normalize_locale(locale)
    return data


def localized(locale: str | None, *, en: str, zh: str) -> str:
    return zh if normalize_locale(locale) == ZH_LOCALE else en


def is_zh(locale: str | None) -> bool:
    return normalize_locale(locale) == ZH_LOCALE
