"""公共留言板请求/响应模型."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class IssueCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    content: str | None = None
    priority: str = Field(default="medium", pattern="^(low|medium|high)$")
    tags: list[str] = []


class IssueUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    content: str | None = None
    status: str | None = Field(default=None, pattern="^(open|closed|resolved)$")
    priority: str | None = Field(default=None, pattern="^(low|medium|high)$")
    tags: list[str] | None = None


class IssueInResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    issue_id: str
    title: str
    content: str | None = None
    status: str
    priority: str
    tags: list = []
    creator_id: str | None = None
    creator_name: str | None = None
    created_at: datetime
    updated_at: datetime
