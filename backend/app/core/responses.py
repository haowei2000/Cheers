"""统一 API 响应模型."""
from __future__ import annotations

from typing import Generic, Literal, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class APIResponse(BaseModel, Generic[T]):
    """标准 API 响应封装.

    所有 v1 路由统一使用此格式返回：
        {"status": "success", "data": ..., "message": "", "request_id": "..."}
    """

    status: Literal["success", "error"] = "success"
    data: T | None = None
    message: str = ""
    request_id: str = ""

    @classmethod
    def ok(cls, data: T, message: str = "", request_id: str = "") -> "APIResponse[T]":
        return cls(status="success", data=data, message=message, request_id=request_id)

    @classmethod
    def error(cls, message: str, request_id: str = "") -> "APIResponse[None]":
        return cls(status="error", data=None, message=message, request_id=request_id)
