# AgentNexus（智枢协作平台）

> **语言**：中文 | [English](README.md)

[![CI](https://github.com/Grant-Huang/AgentNexus/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Grant-Huang/AgentNexus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

多智能体与人类协作的聊天枢纽：类 Slack 体验 + Agent Bridge Bot + 四层记忆，Python 全栈自研。

> 项目状态：早期公开预览。核心聊天、Bot 接入、文件预览和四层记忆链路可用；部署、权限边界和 Agent 生态集成仍在快速迭代。

## 文档

文档按受众分为两类：`docs/help/` 面向最终用户与运维管理员，`docs/develop/` 面向开发与设计。

**用户 / 运维（`docs/help/`）**

- [使用说明书](docs/help/使用说明书.md)（总索引）
  - [普通用户使用说明](docs/help/普通用户使用说明.md) · [系统管理说明书](docs/help/系统管理说明书.md) · [安装部署说明](docs/help/安装部署说明.md) · [技术排查Q&A](docs/help/技术排查Q&A.md)
- [RustFS 对象存储部署说明](docs/help/RustFS对象存储部署说明.md)
- [Agent Bridge 接入指南](docs/help/AgentBridge接入指南.md)（OpenClaw 与 ACP / Codex ACP）

**开发 / 设计（`docs/develop/`）**

- [总体架构设计](docs/develop/总体架构设计.md) · [详细设计](docs/develop/详细设计.md) · [关键技术文档](docs/develop/关键技术文档.md)
- [易用性设计](docs/develop/易用性设计.md)（交互、用语与扩展点）
- [需求汇总](docs/develop/需求汇总.md)
- [开发计划与里程碑](docs/develop/开发计划与里程碑.md) · [TodoList](docs/develop/TodoList.md) · [功能测试清单](docs/develop/功能测试清单.md)
- [开源发布检查清单](docs/develop/开源发布检查清单.md)

## 技术栈

- **后端**：Python 3.13+ / FastAPI / WebSocket / PostgreSQL（主库 + Context Store）/ Redis（可选）
- **前端**：React / Tailwind CSS
- **Agent**：Agent Bridge（OpenClaw / ACP provider）与 HTTP Bot
- **部署**：Docker Compose

## 快速启动

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env

# 首次启动前请至少修改 .env 中的 ADMIN_PASSWORD、JWT_SECRET_KEY、
# POSTGRES_PASSWORD、RUSTFS_ACCESS_KEY 和 RUSTFS_SECRET_KEY。
docker compose up -d
```

默认访问地址：

- 前端：http://localhost
- API：http://localhost:8000
- API 文档：http://localhost:8000/docs

若需要文档预览服务，确保 `PUBLIC_BASE_URL` 是 kkFileView 容器可访问的 AgentNexus 地址。生产部署不要使用 `.env.example` 中的本地开发密钥。

## 本地开发

### 环境要求

- Python 3.13+
- Node.js 18+
- PostgreSQL 16+
- Redis 7+（可选，用于异步队列）

### 后端

```bash
cd backend
# 推荐使用 uv（基于 astral uv）进行包管理和虚拟环境管理
uv venv          # 创建虚拟环境（首次）
source .venv/bin/activate   # Windows: .venv\Scripts\activate
uv sync          # 安装依赖（包括 dev 依赖）
cp ../.env.example ../.env  # 编辑 .env 填写数据库等
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

### 一键部署（推荐）

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
docker compose up -d

# 前端: http://localhost:80   API: http://localhost:8000
# 默认会写入种子数据：默认工作空间、测试项目、内置协作助手（@Coordinator）。打开前端进入「测试项目」，输入 @Coordinator 怎么用 即可获取使用引导。
# 若需手动初始化，可设环境变量 SEED_DATA=0 并见 docs/help/安装部署说明.md。
```

## 验收（里程碑 1）

- 频道内 @bot 能正确回复
- 上传 docx 后 Bot 能读取内容
- 前端可登录、发消息、看历史

## Roadmap

- [x] 里程碑 1：核心链路（ChatCore + 单 Bot + 文件转 MD + 前端基础版）
- [x] 里程碑 2：多 Agent 协作（多 Bot 串行 + MemoryManager + 管理后台）
- [x] 里程碑 3：智能调度（Coordinator + 质量监控看板）
- [ ] 门户阶段一：门户基础（统一协作助手 + 自动接手 + Bot 澄清）
- [ ] 门户阶段二：公共平台（公共知识/数据平台 + 访问申请 API）
- [ ] 门户阶段三：能力发现与编排增强（skills/MCP + A2A 握手）

详细里程碑规划与当前进度见 [ROADMAP.md](docs/ROADMAP.md)。

## 贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)：

- 工作分支的 PR 只合并到 `develop`。
- `main` 只接受来自 `develop` 的合并。
- 提交 PR 前至少运行相关后端测试和前端构建。
- 安全漏洞不要发公开 Issue，请按 [SECURITY.md](SECURITY.md) 报告。

## 开源发布注意事项

公开部署前请确认：

- 已替换 `.env` 中所有 `change-me` 和本地开发密钥。
- 已设置强随机 `JWT_SECRET_KEY` 与对象存储密钥。
- 已收紧生产 CORS、文件上传限制、外部访问域名和反向代理配置。
- 没有提交本地数据库、上传文件、日志、`.env`、私钥或生产 token。
- CI 中的后端测试、前端构建和 npm 包构建均通过。

## 许可证

本项目采用 [MIT License](LICENSE)。
