"""Localized built-in account, seed, onboarding, and prompt-template text."""
from __future__ import annotations

import json
from dataclasses import dataclass

from app.core.localization import localized, normalize_locale
from app.core.prompt_templates import DEFAULT_TEMPLATE_VARIABLES, DEFAULT_USER_TEMPLATE

TEMPLATE_GENERAL_ID = "template-general-001"
RETIRED_BUILTIN_TEMPLATE_IDS = (
    "template-codereview-001",
    "template-creative-001",
)


@dataclass(frozen=True)
class BuiltinPromptTemplateText:
    template_id: str
    name: str
    description: str
    system_prompt: str
    user_template: str
    variables: list[str]


def coordinator_bot_defaults(locale: str | None = None) -> dict[str, str]:
    locale = normalize_locale(locale)
    capabilities = (
        ["系统帮助", "分组问答", "记忆读写", "澄清弹窗", "Bot路由建议"]
        if locale == "zh-CN"
        else ["System help", "Group Q&A", "Memory read/write", "Clarification dialog", "Bot routing suggestions"]
    )
    description = localized(
        locale,
        en=(
            "AgentNexus built-in Coordinator assistant for system help, group Q&A, and memory management. "
            "It can answer product usage questions, use group memory for business context, read and write "
            "four group memory layers, and suggest routing to specialist Bots when needed."
        ),
        zh=(
            "系统内置协作助手（Coordinator），集使用帮助、分组助手、记忆管理三合一。"
            "可回答系统使用问题、结合分组记忆回答业务问题、"
            "读写四层分组记忆、并在需要时建议路由到专业 Bot。"
        ),
    )
    return {
        "display_name": localized(locale, en="Collaboration Assistant", zh="协作助手"),
        "description": description,
        "intro": json.dumps(
            {
                "capabilities": capabilities,
                "description": localized(
                    locale,
                    en="Built-in Coordinator assistant. Mention @Coordinator to use it.",
                    zh="内置协作助手，@Coordinator 即可使用",
                ),
            },
            ensure_ascii=False,
        ),
    }


def seed_workspace_defaults(locale: str | None = None) -> dict[str, str]:
    return {
        "workspace_name": localized(locale, en="Default Workspace", zh="默认空间"),
        "channel_name": localized(locale, en="General", zh="通用"),
        "channel_purpose": localized(locale, en="Default channel", zh="默认频道"),
        "admin_display_name": localized(locale, en="System Administrator", zh="系统管理员"),
    }


def helper_onboarding_message(locale: str | None = None) -> str:
    return localized(
        locale,
        en=(
            "Hi, I am AgentNexus's built-in collaboration assistant @Coordinator.\n\n"
            "You can ask me product questions in natural language, such as how to create a workspace, "
            "invite members, upload files, mention Bots, inspect group memory, read Docs, "
            "or connect Agent Bridge / OpenClaw.\n\n"
            "If you are unsure what to do next, tell me your goal and I will break it into concrete steps."
        ),
        zh=(
            "你好，我是 AgentNexus 内置协作助手 @Coordinator。\n\n"
            "你可以直接用自然语言问我如何使用系统，例如：如何创建工作空间、"
            "邀请成员、上传文件、@ Bot、查看分组记忆、阅读 Docs，"
            "或接入 Agent Bridge / OpenClaw。\n\n"
            "如果你不确定下一步怎么做，可以直接告诉我你的目标，我会把操作步骤拆给你。"
        ),
    )


def all_helper_onboarding_messages() -> tuple[str, str]:
    return helper_onboarding_message("en"), helper_onboarding_message("zh-CN")


def _general_template(locale: str | None) -> BuiltinPromptTemplateText:
    return BuiltinPromptTemplateText(
        template_id=TEMPLATE_GENERAL_ID,
        name=localized(locale, en="General assistant", zh="通用助手"),
        description=localized(
            locale,
            en="A general AI assistant for answering a wide range of questions",
            zh="通用的 AI 助手，适合回答各种问题",
        ),
        system_prompt=localized(
            locale,
            en="You are a helpful AI assistant. Answer user questions concisely and professionally.",
            zh="你是一个有用的 AI 助手。请简洁、专业地回答用户问题。",
        ),
        user_template=DEFAULT_USER_TEMPLATE,
        variables=list(DEFAULT_TEMPLATE_VARIABLES),
    )


def builtin_prompt_templates(locale: str | None = None) -> tuple[BuiltinPromptTemplateText, ...]:
    locale = normalize_locale(locale)
    return (
        _general_template(locale),
    )


def builtin_prompt_template(template_id: str, locale: str | None = None) -> BuiltinPromptTemplateText | None:
    for template in builtin_prompt_templates(locale):
        if template.template_id == template_id:
            return template
    return None
