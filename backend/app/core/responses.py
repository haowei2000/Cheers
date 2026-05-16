"""Responses module."""
from __future__ import annotations

from typing import Generic, Literal, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class APIResponse(BaseModel, Generic[T]):
    """A P I Response schema or model."""

    status: Literal["success", "error"] = "success"
    data: T | None = None
    message: str = ""
    request_id: str = ""
    meta: dict | None = None

    @classmethod
    def ok(cls, data: T, message: str = "", request_id: str = "", meta: dict | None = None) -> "APIResponse[T]":
        return cls(status="success", data=data, message=message, request_id=request_id, meta=meta)

    @classmethod
    def error(cls, message: str, request_id: str = "") -> "APIResponse[None]":
        return APIResponse[None](status="error", data=None, message=message, request_id=request_id)
