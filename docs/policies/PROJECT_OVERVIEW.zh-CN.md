# Cheers（智枢协作平台）

> **语言**：中文 | [English](PROJECT_OVERVIEW.md)

Slack 风格的多智能体 + 人类协作 Chat Hub。把 LLM Bot 当作团队成员拉进频道，由编排器解析 `@mention` 实时分发，多 Bot、多用户在同一频道协同完成任务。

**核心 Features**：可插拔 Adapter 体系（HTTP / Channel / WebSocket Bot）、四层频道记忆（anchor / decisions / files_index / recent）、ChannelBot 内置 12 个 function calling 工具（call_bot / web_search / generate_image …）、四种消息形态（普通 / 加密 / 公告 / 主题）、文件即对话（docx/pdf/xlsx 自动转 Markdown）、WebSocket 实时推送、Workspace 管理后台、SkillHub 社区扩展。

技术栈：FastAPI + PostgreSQL + React + Vite，Docker Compose 一键起。
