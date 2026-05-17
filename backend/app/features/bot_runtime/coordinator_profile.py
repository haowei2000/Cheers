"""Lightweight context policy for the built-in Coordinator Bot."""
from __future__ import annotations

from dataclasses import dataclass

ALL_COORDINATOR_TOOLS = frozenset({
    "update_anchor",
    "update_progress",
    "update_decision",
    "call_bot",
    "call_user",
    "create_file",
    "read_file",
    "create_todo",
    "list_todos",
    "update_todo",
    "delete_todo",
    "web_fetch",
    "web_search",
})


@dataclass(frozen=True)
class CoordinatorContextProfile:
    """Prompt/context budget chosen before the Coordinator adapter runs."""

    intent: str
    include_help: bool
    help_limit: int
    memory_layers: frozenset[str]
    history_limit: int
    history_msg_max_chars: int
    enabled_tools: frozenset[str]
    include_bot_roster: bool = False
    memory_char_budget: int = 5000


HELP_KEYWORDS = (
    "帮助", "怎么用", "不会用", "说明书", "文档", "入口", "功能入口",
    "创建项目", "建项目", "新建项目", "怎么建", "加入项目", "加入频道",
    "拉bot", "邀请bot", "加bot", "bot不在", "@没反应", "没反应",
    "安装", "部署", "环境", "报错", "排查", "agent bridge", "openclaw",
    "connect agent bridge", "how to use", "how to create", "how to join",
)
FILE_KEYWORDS = (
    "文件", "附件", "上传", "读取", "预览", "总结文件", "概括文件",
    "图片", "图像", "pdf", "docx", "xlsx", "pptx", "file", "attachment",
)
MEMORY_KEYWORDS = (
    "记忆", "记住", "记录", "更新项目", "项目锚点", "锚点", "决策",
    "进度", "里程碑", "待办", "todo", "任务", "结论",
)
DELEGATION_KEYWORDS = (
    "调用", "分派", "转给", "交给", "让@", "让 @", "协作", "协调",
    "哪个bot", "哪个 bot", "专业 bot", "call bot",
)
WEB_KEYWORDS = (
    "搜索", "网页", "网址", "链接", "最新", "现在", "今天", "新闻",
    "http://", "https://", "search", "website", "web",
)


def _contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in text for keyword in keywords)


def build_coordinator_profile(
    user_text: str,
    *,
    has_attachments: bool = False,
    has_peer_bots: bool = False,
    is_clarify_reply: bool = False,
) -> CoordinatorContextProfile:
    """Classify a Coordinator request into a conservative context policy."""

    text = (user_text or "").strip().lower()
    has_bot_mention = "@" in text
    is_operation_question = any(marker in text for marker in ("怎么", "如何", "where", "how to"))
    file_operation_help = is_operation_question and _contains_any(text, FILE_KEYWORDS)

    if is_clarify_reply:
        return CoordinatorContextProfile(
            intent="clarify",
            include_help=False,
            help_limit=0,
            memory_layers=frozenset({"anchor", "progress", "decisions", "history"}),
            history_limit=0,
            history_msg_max_chars=360,
            enabled_tools=frozenset({
                "update_anchor",
                "update_progress",
                "update_decision",
                "call_bot",
                "call_user",
            }),
            include_bot_roster=has_peer_bots,
            memory_char_budget=4500,
        )

    if (not has_attachments) and (_contains_any(text, HELP_KEYWORDS) or file_operation_help):
        return CoordinatorContextProfile(
            intent="help",
            include_help=True,
            help_limit=2,
            memory_layers=frozenset(),
            history_limit=0,
            history_msg_max_chars=240,
            enabled_tools=frozenset(),
            include_bot_roster=False,
            memory_char_budget=0,
        )

    if has_attachments or _contains_any(text, FILE_KEYWORDS):
        return CoordinatorContextProfile(
            intent="file",
            include_help=False,
            help_limit=0,
            memory_layers=frozenset({"anchor", "files_index", "history"}),
            history_limit=0,
            history_msg_max_chars=360,
            enabled_tools=frozenset({"read_file", "create_file", "call_user"}),
            include_bot_roster=False,
            memory_char_budget=5000,
        )

    if _contains_any(text, WEB_KEYWORDS):
        return CoordinatorContextProfile(
            intent="web",
            include_help=False,
            help_limit=0,
            memory_layers=frozenset({"anchor", "history"}),
            history_limit=0,
            history_msg_max_chars=320,
            enabled_tools=frozenset({"web_fetch", "web_search", "call_user"}),
            include_bot_roster=False,
            memory_char_budget=3000,
        )

    if _contains_any(text, MEMORY_KEYWORDS):
        return CoordinatorContextProfile(
            intent="memory",
            include_help=False,
            help_limit=0,
            memory_layers=frozenset({"anchor", "progress", "decisions", "todos"}),
            history_limit=0,
            history_msg_max_chars=420,
            enabled_tools=frozenset({
                "update_anchor",
                "update_progress",
                "update_decision",
                "create_todo",
                "list_todos",
                "update_todo",
                "delete_todo",
                "call_user",
            }),
            include_bot_roster=False,
            memory_char_budget=5500,
        )

    if has_peer_bots and (has_bot_mention or _contains_any(text, DELEGATION_KEYWORDS)):
        return CoordinatorContextProfile(
            intent="delegation",
            include_help=False,
            help_limit=0,
            memory_layers=frozenset({"anchor", "progress", "history"}),
            history_limit=0,
            history_msg_max_chars=420,
            enabled_tools=frozenset({"call_bot", "call_user"}),
            include_bot_roster=True,
            memory_char_budget=4500,
        )

    return CoordinatorContextProfile(
        intent="project",
        include_help=False,
        help_limit=0,
        memory_layers=frozenset({"anchor", "history", "todos"}),
        history_limit=0,
        history_msg_max_chars=360,
        enabled_tools=frozenset({"call_user", "call_bot"} if has_peer_bots else {"call_user"}),
        include_bot_roster=has_peer_bots,
        memory_char_budget=4200,
    )
