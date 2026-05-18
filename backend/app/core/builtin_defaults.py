"""Localized built-in account, seed, onboarding, and prompt-template text."""
from __future__ import annotations

import json
from dataclasses import dataclass

from app.core.localization import localized, normalize_locale
from app.core.prompt_templates import DEFAULT_TEMPLATE_VARIABLES, DEFAULT_USER_TEMPLATE

TEMPLATE_GENERAL_ID = "template-general-001"
TEMPLATE_CODE_REVIEW_ID = "template-codereview-001"
TEMPLATE_CREATIVE_ID = "template-creative-001"


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
        ["系统帮助", "项目问答", "记忆读写", "澄清弹窗", "Bot路由建议"]
        if locale == "zh-CN"
        else ["System help", "Project Q&A", "Memory read/write", "Clarification dialog", "Bot routing suggestions"]
    )
    description = localized(
        locale,
        en=(
            "AgentNexus built-in Coordinator assistant for system help, project Q&A, and memory management. "
            "It can answer product usage questions, use project memory for business context, read and write "
            "four project memory layers, and suggest routing to specialist Bots when needed."
        ),
        zh=(
            "系统内置协作助手（Coordinator），集使用帮助、项目助手、记忆管理三合一。"
            "可回答系统使用问题、结合项目记忆回答业务问题、"
            "读写四层项目记忆、并在需要时建议路由到专业 Bot。"
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
            "invite members, upload files, mention Bots, inspect project memory, read Docs, "
            "or connect Agent Bridge / OpenClaw.\n\n"
            "If you are unsure what to do next, tell me your goal and I will break it into concrete steps."
        ),
        zh=(
            "你好，我是 AgentNexus 内置协作助手 @Coordinator。\n\n"
            "你可以直接用自然语言问我如何使用系统，例如：如何创建工作空间、"
            "邀请成员、上传文件、@ Bot、查看项目记忆、阅读 Docs，"
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


def _code_review_template(locale: str | None) -> BuiltinPromptTemplateText:
    return BuiltinPromptTemplateText(
        template_id=TEMPLATE_CODE_REVIEW_ID,
        name=localized(locale, en="Code review", zh="代码审查"),
        description=localized(
            locale,
            en="A code review assistant that finds potential issues and improvements",
            zh="专业的代码审查助手，发现潜在问题和优化点",
        ),
        system_prompt=localized(
            locale,
            en="""You are a professional code review assistant. Review the user's code with attention to:
1. Potential bugs and error handling
2. Code style and readability
3. Performance improvements
4. Security vulnerabilities
5. Best practices

Reply in the user's language by default, use Markdown, and keep the structure clear.""",
            zh="""你是一个专业的代码审查助手。请审查用户提供的代码，关注以下方面：
1. 潜在的 Bug 和错误处理
2. 代码风格和可读性
3. 性能优化建议
4. 安全漏洞
5. 最佳实践

请默认使用用户的语言回复，使用 Markdown 格式，结构清晰。""",
        ),
        user_template=localized(
            locale,
            en="Please review the following code:\n\n```\n{{message}}\n```\n\nGive detailed review feedback, including issues and improvement suggestions.",
            zh="请审查以下代码：\n\n```\n{{message}}\n```\n\n请给出详细的审查意见，包括问题和改进建议。",
        ),
        variables=["message"],
    )


def _creative_template(locale: str | None) -> BuiltinPromptTemplateText:
    return BuiltinPromptTemplateText(
        template_id=TEMPLATE_CREATIVE_ID,
        name=localized(locale, en="Creative writing", zh="创意写作"),
        description=localized(
            locale,
            en="A creative writing assistant that helps draft and polish text",
            zh="富有创意的写作助手，帮助撰写和润色文字",
        ),
        system_prompt=localized(
            locale,
            en="You are a creative writing assistant. Help users draft and polish text with vivid, engaging language.",
            zh="你是一个富有创意的写作助手。请用生动、有趣的语言帮助用户撰写和润色文字。",
        ),
        user_template=localized(
            locale,
            en="Please improve the following content:\n\n{{message}}",
            zh="请帮我完善以下内容：\n\n{{message}}",
        ),
        variables=["message"],
    )


def builtin_prompt_templates(locale: str | None = None) -> tuple[BuiltinPromptTemplateText, ...]:
    locale = normalize_locale(locale)
    return (
        _general_template(locale),
        _code_review_template(locale),
        _creative_template(locale),
    )


def builtin_prompt_template(template_id: str, locale: str | None = None) -> BuiltinPromptTemplateText | None:
    for template in builtin_prompt_templates(locale):
        if template.template_id == template_id:
            return template
    return None
