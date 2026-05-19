"""Canonical message wire contracts.

These DTOs are the single shape used by HTTP responses, WebSocket frames, and
SSE events. Application and feature code may hold ORM rows internally, but the
transport boundary should only see these contracts.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


class MessageFileDTO(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    file_id: str
    original_filename: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    status: str = "ready"
    expires_at: datetime | None = None


class MessageDTO(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    msg_id: str
    channel_id: str
    sender_id: str
    sender_type: str
    sender_name: str | None = None
    content: str
    msg_type: str = "normal"
    content_data: dict[str, Any] | None = None
    file_ids: list[str] = Field(default_factory=list)
    files: list[MessageFileDTO] = Field(default_factory=list)
    mention_bot_ids: list[str] = Field(default_factory=list)
    mention_user_ids: list[str] = Field(default_factory=list)
    task_id: str | None = None
    in_reply_to_msg_id: str | None = None
    created_at: str | None = None
    is_secret: bool = False
    is_partial: bool = False
    is_deleted: bool = False
    deleted_at: str | None = None
    deleted_by: str | None = None

    @field_validator("file_ids", "mention_bot_ids", "mention_user_ids", mode="before")
    @classmethod
    def _normalize_lists(cls, value: Any) -> list[str]:
        return _string_list(value)

    @field_validator("created_at", "deleted_at", mode="before")
    @classmethod
    def _normalize_created_at(cls, value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, str):
            return value
        return str(value)

    def to_wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class MessageUpdateDTO(BaseModel):
    msg_id: str
    content: str
    file_ids: list[str] | None = None
    files: list[MessageFileDTO] | None = None
    is_partial: bool | None = None
    is_deleted: bool | None = None
    deleted_at: str | None = None
    deleted_by: str | None = None
    error: str | None = None
    content_data: dict[str, Any] | None = None
    clear_content_data: bool = False

    @field_validator("file_ids", mode="before")
    @classmethod
    def _normalize_file_ids(cls, value: Any) -> list[str] | None:
        if value is None:
            return None
        return _string_list(value)

    def to_wire(self) -> dict[str, Any]:
        data = self.model_dump(mode="json", exclude_none=True, exclude={"clear_content_data"})
        if self.content_data is None and self.clear_content_data:
            data["content_data"] = None
        return data
