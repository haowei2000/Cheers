"""Small built-in help catalog used by Helper and Agent Bridge docs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class HelpEntry:
    """One help topic matched by keyword."""

    keywords: tuple[str, ...]
    title: str
    content: str


HELP_ENTRIES: Sequence[HelpEntry] = (
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
        "`/docs/agent-bridge/release/openclaw-channel-agentnexus.tgz` 下载。",
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


def find_help(user_text: str) -> str | None:
    """Return the best matching help content for user text."""

    entries = find_help_entries(user_text, limit=1)
    return entries[0].content if entries else None


def find_help_entries(user_text: str, limit: int = 3) -> list[HelpEntry]:
    """Return the best matching help entries for user text."""

    if not user_text or not user_text.strip():
        return []
    text = user_text.strip().lower()
    scored: list[tuple[int, int, HelpEntry]] = []
    for entry in HELP_ENTRIES:
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


def build_help_content_with_form(user_text: str) -> str:
    """Historical form emission is gone; return compact rule-based help."""

    return find_help(user_text) or ""


def get_help_context_for_llm(user_text: str | None = None, limit: int = 3) -> str:
    """Return compact help context for LLM prompts."""

    if limit <= 0:
        return ""
    entries = find_help_entries(user_text or "", limit=limit) if user_text else list(HELP_ENTRIES)
    if not entries and user_text:
        entries = find_help_entries("帮助", limit=1)
    return "\n\n---\n\n".join(
        f"## {entry.title}\n{entry.content}" for entry in entries
    )
