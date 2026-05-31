# Contributing to AgentNexus

> **语言**：中文 | [English](CONTRIBUTING.md)

感谢你愿意参与 AgentNexus。项目主要使用中文维护文档和讨论，英文 Issue / PR 也可以接受。

## 分支规则

- 所有功能、修复和文档分支的 PR 只能合并到 `develop`。
- `main` 只接受来自 `develop` 的合并。
- 建议分支命名：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`。

## 开发环境

后端：

```bash
cd backend
uv venv
source .venv/bin/activate
uv sync --extra dev
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

前端：

```bash
cd frontend
npm install
npm run dev
```

Docker Compose：

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
docker compose up -d
```

首次运行前请修改 `.env` 中的默认密码和密钥。生产环境不要使用示例密钥。

## 提交前检查

根据变更范围运行：

```bash
cd backend && uv run ruff check app/
cd backend && uv run pytest ../tests -v
cd frontend && npm run build
```

npm 包变更还需要运行对应包目录下的 `npm run lint`、`npm test`、`npm run build`。

## npm 包发布说明

`packages/openclaw-channel-agentnexus` 和 `packages/agentnexus-acp-connector` 在源码中使用 monorepo 本地依赖：

```json
"@haowei0520/bridge-client": "file:../agentnexus-bridge-client"
```

发布工作流会在发布前把该依赖重写为已发布的 npm 版本。日常开发不要手动把它改成 registry 版本，否则本地联调会变慢且更容易遗漏跨包修改。

## PR 要求

- 说明变更动机、核心方案和测试结果。
- 涉及 API、配置、部署或用户流程时，同步更新文档。
- 涉及数据库结构时，提交 Alembic 迁移并验证 upgrade。
- 不要提交 `.env`、数据库、日志、上传文件、私钥、token 或生产配置。

## 安全问题

请不要在公开 Issue 中披露漏洞细节。按 [SECURITY.md](SECURITY.md) 报告安全问题。
