# AgentNexus (Zhishu collaboration platform)

> **Language**: English | [中文](PROJECT_OVERVIEW.zh-CN.md)

Slack-style multi-agent + human collaboration Chat Hub. Pull LLM Bot into the channel as a team member, and the orchestrator will parse `@mention` and distribute it in real time. Multiple Bots and multiple users can complete tasks collaboratively in the same channel.

**Core Features**: pluggable Adapter system (HTTP / Channel / WebSocket Bot), four-layer channel memory (anchor / decisions / files_index / recent), ChannelBot built-in 12 function calling tools (call_bot / web_search / generate_image...), four message forms (normal / encrypted / announcement / topic), files as conversations (docx/pdf/xlsx automatically converted to Markdown), WebSocket Real-time push, Workspace management backend, SkillHub community extension.

Technology stack: FastAPI + PostgreSQL + React + Vite, Docker Compose can be started with one click.