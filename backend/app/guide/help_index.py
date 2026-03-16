"""引导 Bot 帮助索引：根据用户问题匹配说明书摘要，引导完成操作；支持动态表单与澄清问答."""
import json
from dataclasses import dataclass
from typing import Any, Sequence


@dataclass
class HelpEntry:
    """一条帮助：关键词 + 标题 + 回复内容（说明书摘要）."""
    keywords: tuple[str, ...]
    title: str
    content: str


# 关键词（小写匹配） -> 回复内容，与四类说明书对应
HELP_ENTRIES: Sequence[HelpEntry] = (
    HelpEntry(
        ("创建项目", "建项目", "新建项目", "怎么建", "如何创建项目"),
        "如何创建项目",
        "【前端入口】左侧点击「管理」→ 创建项目：选择工作空间、填写项目名称后点击「创建」。\n\n"
        "若无工作空间，需先建一个（只需做一次）：\n"
        "Docker：docker compose exec backend sqlite3 /app/data/main.db "
        "\"INSERT INTO workspaces (workspace_id, name, created_at) "
        "VALUES ('ws-default-001', '默认空间', datetime('now'));\"\n"
        "本地：cd backend && sqlite3 ../data/main.db 同上。\n\n"
        "也可用 API：POST /api/channels，body 含 workspace_id、name、type。"
        "详见《系统管理说明书》§二。",
    ),
    HelpEntry(
        ("加入项目", "怎么加入", "加入频道", "被加进项目"),
        "如何加入项目",
        "「加入项目」= 被加进该项目的成员列表。\n\n"
        "【前端入口】左侧「管理」→ 添加成员：选择项目、填写成员 ID、选择用户/Bot 后点击「添加」。移除成员同理。\n\n"
        "你想自己加入：联系管理员在「管理」里把你加进项目。详见《系统管理说明书》§三。",
    ),
    HelpEntry(
        ("拉bot进群", "拉bot", "邀请bot", "加bot到频道", "聊天加bot", "@ 没在群里", "bot不在群里"),
        "如何在聊天里把 Bot 拉进频道（Slack 风格）",
        "在频道内输入 @ 时，会显示全部 Bot 列表：已在频道的排前面，未加入的排后面（灰色「未加入」）。\n\n"
        "若你选择了一个未加入的 Bot，系统会提示「是否邀请加入？」；点击「加入并 @ta」后，该 Bot 会加入本频道，"
        "输入框会自动插入 @Bot名，你可继续输入问题并发送，不打断提问流程。\n\n"
        "此方式无需去「管理」→「添加成员」填 ID，适合快速邀请 Bot 进群。详见《普通用户使用说明》§3.2。",
    ),
    HelpEntry(
        ("openclaw", "接入", "接入bot", "接入 bot", "怎么接", "注册bot", "添加bot"),
        "如何让 OpenClaw 接入",
        "接入 = 把你的 OpenClaw 变成系统里的一个 Bot，别人 @ 它就会由你的 OpenClaw 回复。\n\n"
        "【前端填表创建】在左侧「管理」→「创建 Bot」中按表格填写 "
        "bot_id（可选）、username（@ 用的名字）、openclaw_endpoint 等后点击"
        "「创建」，再将该 Bot 加入具体项目即可。\n\n"
        "或手动三步：\n"
        "1）准备好已运行的服务及访问地址（如 http://主机:端口）。\n"
        "2）在系统里「注册」Bot：在 bot_accounts 表插入一条记录，填 "
        "bot_id、username（@ 用的名字）、openclaw_endpoint（填 http 或 https 地址）。\n"
        "3）把该 Bot「加入」到具体项目：调用 "
        "POST /api/channels/{项目ID}/members，body 里 member_id=bot_id，"
        "member_type=bot。\n\n"
        "当 openclaw_endpoint 为 http(s) 地址时，系统会向该地址 "
        "POST /execute 发送请求（请求/响应格式见《系统管理说明书》§四）。"
        "若未配置为 http 或服务不可用，@ 该 Bot 会收到占位或错误提示。\n\n"
        "详见 [系统管理说明书 §四](/manual/系统管理说明书#四如何让-openclaw-接入注册-bot-并加入项目)。",
    ),
    HelpEntry(
        ("发现", "自动注册", "openclaw 发现", "让openclaw发现", "机器可读", "注册指南"),
        "如何让外部 OpenClaw 发现并自动注册",
        "外部 OpenClaw 可通过「发现接口」获取本系统提供的注册指南（机器可读 JSON），并自动提交注册申请；"
        "管理员在「管理」→「待审核 Bot 申请」中审核通过后，该 Bot 才会被创建并可被加入项目 @。\n\n"
        "• 发现与注册指南（GET）：后端地址/api/public/agentnexus-discovery（如 http://localhost:8000/api/public/agentnexus-discovery）\n"
        "• 提交注册申请（POST）：后端地址/api/bots/register-request，body 含 username、openclaw_endpoint、intro（必填，JSON 格式自我介绍），及选填 display_name。\n"
        "• 管理员入口：左侧「管理」→「待审核 Bot 申请」→ 通过/拒绝。\n\n"
        "详见 [系统管理说明书 §五](/manual/系统管理说明书#五如何让外部-openclaw-发现并自动注册需管理员审核)。",
    ),
    HelpEntry(
        ("发消息", "聊天", "怎么发", "怎么@", "如何@", "at bot", "@"),
        "在项目里怎么用",
        "• 发消息：底部输入框输入文字，点「发送」或按 Enter。\n"
        "• @ Bot：输入 @ 会弹出 Bot 列表（频道内排前、未加入的灰色排后）；选已在频道的 Bot 直接插入，选未加入的会提示「是否邀请加入？」确认后 Bot 进群并插入 @名。\n"
        "• 上传文件：【入口】输入框旁「上传」按钮，支持 .txt、.md、.docx；上传后可随下一条消息一起发送。\n\n"
        "详见《普通用户使用说明》§三。",
    ),
    HelpEntry(
        ("没有项目", "左边没", "看不到项目", "列表空"),
        "左侧没有项目",
        "说明还没有任何项目，或你还没被加入任何项目。\n\n"
        "请联系管理员：先按《系统管理说明书》建工作空间和项目，再把你加进项目。详见《普通用户使用说明》§二、§四。",
    ),
    HelpEntry(
        ("@没反应", "没反应", "bot 不回复", "不回复"),
        "@ Bot 没反应",
        "可检查：\n"
        "1）该 Bot 是否已加入当前项目；若未加入，可在输入 @ 时从列表选该 Bot，系统会提示「是否邀请加入？」确认即可拉进群。\n"
        "2）你 @ 的名字是否和 Bot 的 username 完全一致。\n"
        "3）若接的是真实服务，确认 openclaw_endpoint 为 http(s) 地址且"
        "该服务已实现 POST /execute 约定格式并已启动。\n\n"
        "详见《技术排查Q&A》或《普通用户使用说明》§四。",
    ),
    HelpEntry(
        ("安装", "部署", "怎么装", "环境"),
        "安装与部署",
        "推荐用 Docker：在项目根执行 docker compose up -d。\n\n"
        "本地安装：后端 cd backend && pip install -r requirements.txt && "
        "uvicorn app.main:app --reload；"
        "前端 cd frontend && npm install && npm run dev。\n"
        "首次需执行 alembic upgrade head，并建工作空间与项目。详见《安装部署说明》。",
    ),
    HelpEntry(
        ("报错", "连不上", "503", "404", "排查", "故障"),
        "技术排查",
        "常见现象：前端打不开、503（数据库不可用）、列表为空、@ 无反应、文件上传失败等。\n\n"
        "处理思路：检查 DATABASE_URL、执行 alembic upgrade head、确认项目与成员已创建、查看后端日志。\n"
        "详见《技术排查Q&A》。",
    ),
    HelpEntry(
        ("入口", "功能入口", "哪里可以"),
        "功能入口一览",
        "【前端入口】\n"
        "• 创建项目、添加/移除成员：左侧「管理」。\n"
        "• 添加 Bot 到频道：在频道内输入 @ 选择 Bot，未加入的会提示「是否邀请加入？」；或底部「添加 Bot」弹窗。\n"
        "• 上传文件：选中频道后，输入框旁「上传」（.txt/.md/.docx）。\n"
        "• 频道上下文（四层记忆）：选中频道后，底部「频道上下文」。\n"
        "• API 文档：左侧「管理」内「打开 API 文档」或帮助中的 /docs 链接。\n"
        "• 使用帮助：左侧「帮助」或频道内 @channel bot 提问。\n\n"
        "更多可问 @channel bot 怎么创建项目、怎么加入项目、怎么把 Bot 拉进群、怎么用 等。",
    ),
    HelpEntry(
        ("orchestrator", "coordinator", "主控", "直接回答", "自动接手"),
        "Orchestrator 是什么、怎么用",
        "Orchestrator 是系统内置的业务问答 Bot（@coordinator）。\n\n"
        "• 直接回答：管理员开启「直接回答未 @ 的问题」后，你发消息不 @ 任何人时，Orchestrator 会优先回答业务问题；系统使用类问题会建议你 @channel bot。\n"
        "• 显式 @：写 @coordinator 可让 Orchestrator 聚合频道内其他 Bot 的回复，或根据问题建议你 @ 某个部门 Bot。\n"
        "• 自动接手：管理员开启后，Orchestrator 回复中含「建议 @xxx」时，被建议的 Bot 会自动接手回答，你会看到「正在处理...」提示。\n\n"
        "Orchestrator 需管理员加入频道后才能用；配置在「管理」→「LLM 设置」→「Orchestrator 配置」。",
    ),
    HelpEntry(
        ("帮助", "怎么用", "不会用", "说明书", "文档"),
        "使用说明总览",
        "我是 channel bot，根据说明书帮你完成操作。你可以这样问我：\n\n"
        "• 入口 / 功能入口 → 查看所有前端入口\n"
        "• 怎么创建项目\n"
        "• 怎么加入项目\n"
        "• 怎么把 Bot 拉进群（聊天内 @ 邀请）\n"
        "• 怎么让 OpenClaw 接入\n"
        "• 怎么让外部 OpenClaw 发现并自动注册\n"
        "• Orchestrator 是什么、怎么用\n"
        "• 怎么发消息 / 怎么 @ Bot\n"
        "• 左边没有项目怎么办\n"
        "• @ Bot 没反应怎么办\n"
        "• 怎么安装部署\n"
        "• 报错 / 连不上怎么排查\n\n"
        "完整文档见 docs/使用说明书.md（总索引）。",
    ),
)


def find_help(user_text: str) -> str | None:
    """根据用户输入匹配帮助条目，返回最匹配的 content；无匹配返回 None."""
    if not user_text or not user_text.strip():
        return None
    text = user_text.strip().lower()
    best: HelpEntry | None = None
    best_score = 0
    for entry in HELP_ENTRIES:
        for kw in entry.keywords:
            if kw in text:
                # 取关键词最长匹配，避免「怎么用」同时命中多条
                if len(kw) > best_score:
                    best_score = len(kw)
                    best = entry
                break
    if best:
        return best.content
    return None


# 动态表单：意图关键词 -> (action, fields)
_FORM_CREATE_CHANNEL = {
    "action": "create_channel",
    "fields": [
        {
            "name": "workspace_id",
            "type": "select",
            "label": "工作空间",
            "options_url": "/api/workspaces",
            "option_value": "workspace_id",
            "option_label": "name",
        },
        {
            "name": "name",
            "type": "text",
            "label": "项目名称",
            "placeholder": "输入项目名称",
        },
    ],
}
_FORM_INTENT_KEYWORDS: list[tuple[tuple[str, ...], dict[str, Any]]] = [
    (("帮我创建项目", "帮我建项目", "创建项目", "建项目", "新建项目"), _FORM_CREATE_CHANNEL),
]


def get_form_for_intent(user_text: str) -> dict[str, Any] | None:
    """若用户意图需要动态表单，返回表单 schema；否则返回 None."""
    if not user_text or not user_text.strip():
        return None
    text = user_text.strip().lower()
    for keywords, form in _FORM_INTENT_KEYWORDS:
        for kw in keywords:
            if kw in text:
                return form
    return None


def build_guide_content_with_form(user_text: str) -> str:
    """返回引导回复正文；若匹配到表单意图则附带 guide-form 块供前端解析."""
    content = find_help(user_text)
    if not content:
        return ""
    form = get_form_for_intent(user_text)
    if form:
        blob = json.dumps(form, ensure_ascii=False)
        content += "\n\n```guide-form\n" + blob + "\n```"
    return content


def get_help_context_for_llm() -> str:
    """返回供 LLM 使用的帮助文档上下文（标题 + 内容拼接）。"""
    parts = []
    for entry in HELP_ENTRIES:
        parts.append(f"## {entry.title}\n{entry.content}")
    return "\n\n---\n\n".join(parts)


def _clarify_template_for_create_project() -> dict[str, Any]:
    return {
        "title": "创建项目前先确认几个信息",
        "skip_policy": "forbid",
        "questions": [
            {
                "id": "workspace_scope",
                "prompt": "这个项目要建在哪个工作空间？",
                "allow_multiple": False,
                "other_enabled": True,
                "other_label": "其他工作空间",
                "other_placeholder": "请输入工作空间名或说明",
                "options": [
                    {"id": "ws_default", "label": "默认空间"},
                    {"id": "ws_existing", "label": "已有指定空间"},
                    {"id": "ws_new", "label": "先创建新空间"},
                ],
            },
            {
                "id": "project_type",
                "prompt": "项目类型偏向哪种？",
                "allow_multiple": False,
                "other_enabled": True,
                "other_label": "其他类型",
                "other_placeholder": "请输入项目类型偏好",
                "options": [
                    {"id": "public", "label": "公开协作项目（public）"},
                    {"id": "private", "label": "私有项目（private）"},
                ],
            },
        ],
    }


def _clarify_template_for_generic() -> dict[str, Any]:
    return {
        "title": "为避免误解，请先补充以下信息",
        "skip_policy": "allow",
        "questions": [
            {
                "id": "goal",
                "prompt": "你本次最主要目标是？",
                "allow_multiple": False,
                "other_enabled": True,
                "other_label": "其他目标",
                "other_placeholder": "请输入你的目标",
                "options": [
                    {"id": "create", "label": "创建/配置"},
                    {"id": "troubleshoot", "label": "故障排查"},
                    {"id": "usage", "label": "日常使用指导"},
                    {"id": "other", "label": "其他"},
                ],
            },
            {
                "id": "expectation",
                "prompt": "你希望我输出的形式是？",
                "allow_multiple": True,
                "other_enabled": True,
                "other_label": "其他输出形式",
                "other_placeholder": "请输入你期望的输出形式",
                "options": [
                    {"id": "steps", "label": "分步骤操作指南"},
                    {"id": "api", "label": "直接给 API/命令"},
                    {"id": "ui", "label": "告诉我前端入口怎么点"},
                    {"id": "checklist", "label": "给我排查清单"},
                ],
            },
        ],
    }


def _clarify_template_for_api_integration() -> dict[str, Any]:
    """接入外部系统（禅道等）时，需确认是否已有 API 及地址。"""
    return {
        "title": "确认需求",
        "skip_policy": "allow",
        "questions": [
            {
                "id": "has_api",
                "prompt": "你已经有该系统的 API 接口了吗？（需要系统开放 API 并提供接口地址）",
                "allow_multiple": False,
                "options": [
                    {
                        "id": "yes",
                        "label": "有",
                        "requires_text": True,
                        "text_placeholder": "请输入 API 地址（如 https://xxx.com/api）",
                    },
                    {"id": "no", "label": "没有/不清楚"},
                ],
            },
        ],
    }


def get_rule_based_clarify_schema(user_text: str) -> dict[str, Any] | None:
    """
    规则触发的澄清题（LLM 不可用或 LLM 未触发时兜底）。
    返回 schema；无需澄清时返回 None。
    """
    if not user_text or not user_text.strip():
        return None
    text = user_text.strip().lower()

    # 显式意图：创建项目但缺关键信息时，强制澄清，不允许 skip
    create_kw = ("创建项目", "建项目", "新建项目", "帮我创建项目", "帮我建项目")
    if any(k in text for k in create_kw):
        # 语义较明确但仍存在必要参数缺失（如 workspace、type），统一先澄清
        return _clarify_template_for_create_project()

    # 接入外部系统（禅道、Jira 等）：需确认 API 地址
    api_kw = ("禅道", "zentao", "jira", "接入", "加入需求", "同步需求")
    if any(k in text for k in api_kw):
        return _clarify_template_for_api_integration()

    # 过于笼统/短句：给一组通用澄清题
    generic_kw = ("怎么弄", "怎么做", "帮我做", "搞一下", "处理一下", "看看这个")
    if any(k in text for k in generic_kw) or len(text) <= 8:
        return _clarify_template_for_generic()

    return None
