"""Small built-in help catalog used by Helper and Agent Bridge docs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from app.core.localization import is_zh, normalize_locale


@dataclass(frozen=True)
class HelpEntry:
    """One help topic matched by keyword."""

    keywords: tuple[str, ...]
    title: str
    content: str


HELP_ENTRIES_ZH: Sequence[HelpEntry] = (
    HelpEntry(
        ("创建项目", "建项目", "新建项目", "怎么建", "如何创建项目"),
        "如何创建项目",
        "【前端入口】左侧点击「管理」或频道列表的创建入口，选择工作空间、填写项目/频道名称后点击「创建」。\n\n"
        "若还没有工作空间，需要先创建或由管理员初始化一个工作空间。也可用 API：POST /api/channels，"
        "body 含 workspace_id、name、type。详见《系统管理说明书》。",
    ),
    HelpEntry(
        ("加入项目", "怎么加入", "加入频道", "被加进项目"),
        "如何加入项目",
        "「加入项目」通常指被加入某个频道/项目的成员列表。请频道管理员在成员管理中添加你，"
        "或在允许邀请的频道中通过邀请入口加入。加入后左侧频道列表会显示该项目。",
    ),
    HelpEntry(
        ("拉bot进群", "拉bot", "邀请bot", "加bot到频道", "聊天加bot", "bot不在群里"),
        "如何把 Bot 加入频道",
        "在频道内输入 @ 会弹出 Bot 列表。选择未加入的 Bot 时，系统会提示是否邀请加入；确认后 Bot 会加入频道，"
        "输入框会自动插入 @Bot 名称。管理员也可以在频道成员管理里添加 Bot。",
    ),
    HelpEntry(
        ("agent bridge", "openclaw", "接入", "接入bot", "接入 bot", "怎么接", "注册bot", "添加bot", "自动注册"),
        "如何接入外部 Agent",
        "外部 Agent 可通过 `/docs/agent-bridge/discovery` 获取发现信息，通过 `/docs/agent-bridge/register` 注册为 Agent Bridge Bot。"
        "注册成功后会返回 bot_token、controlUrl、dataUrl 和 provider 配置片段。OpenClaw provider 插件包可从 "
        "`/release/openclaw-channel-agentnexus.tgz` 下载。",
    ),
    HelpEntry(
        ("发消息", "聊天", "怎么发", "怎么@", "如何@", "at bot", "@"),
        "在项目里怎么用",
        "在底部输入框输入文字，点击发送或使用快捷键发送。输入 @ 可选择频道内 Bot 或用户；"
        "上传文件后可随下一条消息一起发送给频道或被 @ 的 Bot。",
    ),
    HelpEntry(
        ("没有项目", "左边没", "看不到项目", "列表空"),
        "左侧没有项目",
        "通常说明还没有频道，或你没有被加入任何频道。请管理员创建工作空间/频道并把你加入成员列表。",
    ),
    HelpEntry(
        ("@没反应", "没反应", "bot 不回复", "不回复"),
        "@ Bot 没反应",
        "请检查：Bot 是否已加入当前频道；@ 的用户名是否完全一致；HTTP/LLM Bot 的模型和模板是否可用；"
        "Agent Bridge Bot 的 provider 插件是否在线并连接 control/data WS。",
    ),
    HelpEntry(
        ("安装", "部署", "怎么装", "环境"),
        "安装与部署",
        "推荐 Docker 部署：在项目根目录执行 `docker compose up -d`。启动后访问前端和 `/health`，"
        "并确认数据库迁移已完成。详见《安装部署说明》。",
    ),
    HelpEntry(
        ("报错", "连不上", "503", "404", "排查", "故障"),
        "技术排查",
        "优先检查后端日志、数据库连接、迁移状态、前端反向代理、对象存储配置，以及 Agent Bridge Bot 的 token 和在线状态。",
    ),
    HelpEntry(
        ("帮助", "怎么用", "不会用", "说明书", "文档", "入口", "功能入口"),
        "使用说明总览",
        "可以询问：怎么创建项目、怎么加入项目、怎么把 Bot 拉进群、怎么接入外部 Agent、怎么发消息、"
        "@ Bot 没反应怎么办、怎么安装部署、报错怎么排查。",
    ),
)

HELP_ENTRIES_EN: Sequence[HelpEntry] = (
    HelpEntry(
        ("create workspace", "create project", "create a project", "new workspace", "new project", "create channel"),
        "How to Create a Project",
        "Frontend entry: click the create entry in the workspace or channel list, choose the workspace, enter the project/channel name, then click Create.\n\n"
        "If there is no workspace yet, create one first or ask an administrator to initialize one. API option: POST /api/channels with workspace_id, name, and type in the body. See the system administration guide for details.",
    ),
    HelpEntry(
        ("join project", "join channel", "added to project", "add me"),
        "How to Join a Project",
        "Joining a project usually means being added to a channel/project member list. Ask a channel administrator to add you in member management, or use the invite entry if that channel allows invitations. The project appears in the left channel list after you are added.",
    ),
    HelpEntry(
        ("add bot", "invite bot", "bot to channel", "bot not in channel"),
        "How to Add a Bot to a Channel",
        "Type @ in a channel to open the Bot list. If you select a Bot that is not in the channel, AgentNexus asks whether to invite it; after confirmation, the Bot joins the channel and the composer inserts the @Bot mention. Administrators can also add Bots from channel member management.",
    ),
    HelpEntry(
        ("agent bridge", "openclaw", "connect agent", "register bot", "external agent"),
        "How to Connect an External Agent",
        "External Agents can read `/docs/agent-bridge/discovery`, then register through `/docs/agent-bridge/register` as Agent Bridge Bots. Registration returns bot_token, controlUrl, dataUrl, and a provider config snippet. The OpenClaw provider package is available at `/release/openclaw-channel-agentnexus.tgz`.",
    ),
    HelpEntry(
        ("send message", "chat", "mention", "at bot", "@"),
        "How to Use a Project",
        "Type text in the bottom composer, then click Send or use the send shortcut. Type @ to choose a Bot or user in the channel. Uploaded files can be sent with the next message to the channel or to mentioned Bots.",
    ),
    HelpEntry(
        ("no project", "empty list", "cannot see project", "left sidebar empty"),
        "No Projects in the Sidebar",
        "This usually means no channels exist yet, or you have not been added to any channel. Ask an administrator to create a workspace/channel and add you to the member list.",
    ),
    HelpEntry(
        ("bot no response", "bot not responding", "@ not working", "mention not working"),
        "@Bot Does Not Respond",
        "Check whether the Bot has joined the current channel, whether the @ username exactly matches, whether the HTTP/LLM Bot has an available model and template, and whether the Agent Bridge provider is online and connected to the control/data WebSocket.",
    ),
    HelpEntry(
        ("install", "deploy", "setup", "environment"),
        "Installation and Deployment",
        "Docker is recommended: run `docker compose up -d` from the project root. After startup, open the frontend and `/health`, and confirm database migrations completed. See the installation guide for details.",
    ),
    HelpEntry(
        ("error", "cannot connect", "503", "404", "troubleshoot", "debug"),
        "Troubleshooting",
        "First check backend logs, database connectivity, migration state, frontend reverse proxy settings, object storage configuration, and Agent Bridge Bot token/online status.",
    ),
    HelpEntry(
        ("help", "how to use", "manual", "docs", "entry", "feature entry"),
        "Usage Overview",
        "You can ask how to create a project, join a project, add Bots to a channel, connect an external Agent, send messages, troubleshoot @Bot responses, install/deploy, or diagnose errors.",
    ),
)

# Backward-compatible Chinese default used by the docs routes.
HELP_ENTRIES = HELP_ENTRIES_ZH


def _contains_cjk(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in text)


def _entries_for(user_text: str | None = None, locale: str | None = None) -> Sequence[HelpEntry]:
    if locale:
        return HELP_ENTRIES_ZH if is_zh(locale) else HELP_ENTRIES_EN
    if user_text and _contains_cjk(user_text):
        return HELP_ENTRIES_ZH
    return HELP_ENTRIES_EN


def find_help(user_text: str, locale: str | None = None) -> str | None:
    """Return the best matching help content for user text."""

    entries = find_help_entries(user_text, limit=1, locale=locale)
    return entries[0].content if entries else None


def find_help_entries(user_text: str, limit: int = 3, locale: str | None = None) -> list[HelpEntry]:
    """Return the best matching help entries for user text."""

    if not user_text or not user_text.strip():
        return []
    text = user_text.strip().lower()
    scored: list[tuple[int, int, HelpEntry]] = []
    for entry in _entries_for(user_text, locale):
        score = 0
        longest_keyword = 0
        for keyword in entry.keywords:
            if keyword in text:
                score += len(keyword)
                longest_keyword = max(longest_keyword, len(keyword))
        if score > 0:
            scored.append((score, longest_keyword, entry))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [entry for _, _, entry in scored[: max(0, limit)]]


def build_help_content_with_form(user_text: str, locale: str | None = None) -> str:
    """Historical form emission is gone; return compact rule-based help."""

    return find_help(user_text, locale=locale) or ""


def get_help_context_for_llm(user_text: str | None = None, limit: int = 3, locale: str | None = None) -> str:
    """Return compact help context for LLM prompts."""

    if limit <= 0:
        return ""
    locale = normalize_locale(locale) if locale else None
    entries = find_help_entries(user_text or "", limit=limit, locale=locale) if user_text else list(_entries_for(locale=locale))
    if not entries and user_text:
        entries = find_help_entries("帮助" if is_zh(locale) else "help", limit=1, locale=locale)
    return "\n\n---\n\n".join(
        f"## {entry.title}\n{entry.content}" for entry in entries
    )
