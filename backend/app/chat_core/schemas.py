"""ChatCore 请求/响应模型."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ChannelCreate(BaseModel):
    """创建频道."""
    workspace_id: str
    name: str
    type: str = "public"
    purpose: str | None = None


class ChannelInResponse(BaseModel):
    """频道响应."""
    model_config = ConfigDict(from_attributes=True)
    channel_id: str
    workspace_id: str
    name: str
    type: str
    purpose: str | None = None


class MemberAdd(BaseModel):
    """添加成员."""
    member_id: str
    member_type: str  # user | bot


class MemberInResponse(BaseModel):
    """成员响应."""
    model_config = ConfigDict(from_attributes=True)
    channel_id: str
    member_id: str
    member_type: str


class MemberWithUsernameInResponse(BaseModel):
    """成员响应（含 Bot 的 username，便于 @ 选择列表）."""
    channel_id: str
    member_id: str
    member_type: str
    username: str | None = None  # bot 时为 @ 用的名字


class MessageCreate(BaseModel):
    """发送消息."""
    content: str
    sender_id: str
    sender_type: str = "user"  # user | bot
    file_ids: list[str] = []
    mention_bot_ids: list[str] = []


class MessageInResponse(BaseModel):
    """消息响应."""
    model_config = ConfigDict(from_attributes=True)
    msg_id: str
    channel_id: str
    sender_id: str
    sender_type: str
    content: str
    file_ids: list[str] | None = None
    mention_bot_ids: list[str] | None = None
    # 顶层任务线程 id：同一条「用户问题 + 多 Bot 串行协作」共用一个 task_id
    task_id: str | None = None
    # 问答精确指针：本条消息回复的是哪一条消息，用于前端构建问答卡片与折叠
    in_reply_to_msg_id: str | None = None
    created_at: datetime | None = None


class BotCreate(BaseModel):
    """创建 Bot（注册 OpenClaw 等）."""
    bot_id: str | None = None  # 不填则自动生成 UUID
    username: str  # @ 用的名字，唯一
    display_name: str | None = None
    openclaw_endpoint: str  # http(s) 或 guide://、mock://
    status: str = "online"
    intro: str | None = None  # JSON: {"capabilities": [...], "description": "..."}
    prompt_template: str | None = None  # 默认提示词模板，{{}} 表示用户消息


class BotUpdate(BaseModel):
    """更新 Bot（部分字段可选）."""
    username: str | None = None
    display_name: str | None = None
    openclaw_endpoint: str | None = None
    openclaw_session: str | None = None
    openclaw_token: str | None = None
    status: str | None = None
    intro: str | None = None
    prompt_template: str | None = None


class BotInResponse(BaseModel):
    """Bot 响应."""
    model_config = ConfigDict(from_attributes=True)
    bot_id: str
    username: str
    display_name: str | None = None
    openclaw_endpoint: str
    status: str
    intro: str | None = None
    prompt_template: str | None = None
    created_at: datetime | None = None


class BotRegisterRequest(BaseModel):
    """外部 OpenClaw 提交的注册申请（无需鉴权）."""
    username: str  # @ 用的名字
    display_name: str | None = None
    openclaw_endpoint: str  # http(s) 地址
    intro: str | None = None  # JSON: {"capabilities": [...], "description": "..."}


class BotRegistrationRequestInResponse(BaseModel):
    """注册申请单条响应."""
    model_config = ConfigDict(from_attributes=True)
    request_id: str
    username: str
    display_name: str | None = None
    openclaw_endpoint: str
    intro: str | None = None
    status: str  # pending | approved | rejected
    requested_at: datetime | None = None
    decided_at: datetime | None = None
    created_bot_id: str | None = None
