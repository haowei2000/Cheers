# AGENTS.md

Project-specific instructions for AI coding agents working on AgentNexus.

## Project Overview

**AgentNexus（智枢协作平台）** 是一个多智能体与人类协作的聊天枢纽平台，提供类 Slack 的聊天体验，支持 LLM Bot 和四层记忆体系。

**新架构**：Bot = AIModel + PromptTemplate，创建 Bot 只需选择模型和提示词模板。

- **Repository**: AgentNexus
- **Purpose**: 人机协作聊天平台，支持多 Agent 在频道中协同工作
- **Primary Languages/Frameworks**:
  - **后端**: Python 3.13+ / FastAPI / SQLAlchemy / WebSocket
  - **前端**: React 18 / TypeScript / Tailwind CSS / Vite
  - **数据库**: SQLite（主库 + Context Store）/ Redis（可选）
  - **Agent 框架**: 内置 HttpBotAdapter（直接调用 LLM）
  - **部署**: Docker Compose

## Branch Strategy

- 所有工作分支的 PR 只能合并到 `develop` 分支。
- `main` 分支只接受来自 `develop` 分支的合并。
- 禁止将功能分支、修复分支或其他工作分支的 PR 直接合并到 `main`。

## Architecture

### 六层架构

| 层次 | 组件 | 核心职责 |
|------|------|----------|
| ① 用户交互层 | React 前端 | 消息收发、文件上传、Bot 标识、Markdown 预览、@提及补全 |
| ② 实时通信层 | FastAPI WebSocket + REST API | 消息广播、连接管理、消息持久化、文件上传接口 |
| ③ Agent 编排层 | AgentOrchestrator | @提及路由、任务分配、多 Bot 协调、进程控制 |
| ④ 记忆管理层 | MemoryManager | 四层记忆读写、上下文拼接注入、记忆摘要压缩 |
| ⑤ Agent 执行层 | HttpBotAdapter | 根据 Bot 的模型+模板配置直接调用 LLM |
| ⑥ 数据持久层 | SQLite + 文件存储 | 主库存消息历史；Context Store 独立 SQLite；文件存储 |

### 核心模块（backend/app/）

```
app/
├── main.py                 # FastAPI 入口，WebSocket，全局中间件
├── config.py               # 环境变量配置（pydantic-settings）
├── logging_config.py       # 日志配置（控制台+文件+内存缓冲）
├── chat_core/              # 聊天核心模块
│   ├── workspaces.py       # 工作区 API
│   ├── channels.py         # 频道 API
│   ├── messages.py         # 消息 API
│   ├── bots.py             # Bot 账户 API（新架构：model+template）
│   ├── ws_manager.py       # WebSocket 连接管理
│   └── schemas.py          # Pydantic 模型
├── auth/                   # 认证模块
│   └── routes.py           # 登录/注册 API
├── admin/                  # 管理后台 API
│   ├── routes.py           # 管理接口
│   ├── models.py           # AI 模型管理 API
│   ├── templates.py        # 提示词模板管理 API
│   ├── settings_store.py   # LLM 提供商配置（遗留）
│   └── log_buffer.py       # 内存日志缓冲
├── orchestrator/           # Agent 编排
│   ├── service.py          # 编排核心服务
│   ├── mention.py          # @提及解析
│   └── adapter_resolver.py # Bot 适配器解析（统一使用 HttpBotAdapter）
├── adapters/               # Bot 适配器
│   ├── base.py             # 抽象接口（AgentPayload/AgentResponse）
│   ├── mock_bot.py         # Mock 适配器（测试用）
│   ├── http_bot.py         # HTTP Bot 适配器（模型+提示词模板）
│   ├── channel_bot.py      # @channel bot 内置适配器（LangChain Agent + 工具集）
│   ├── help_bot.py         # @guide-helper 内置适配器（加载帮助文档）
│   ├── websocket_bot.py    # WebSocket Bot 适配器（OpenClaw channel plugin）
│   └── builtin_registry.py # 内置 Bot 路由表（bot_id → adapter 工厂）
├── memory/                 # 四层记忆管理
│   ├── manager.py          # 记忆读写接口
│   ├── context_store.py    # SQLite Context Store
│   └── recent_update.py    # RECENT 层更新
├── file_processor/         # 文件处理
│   ├── convert.py          # 文件格式转换（docx/pdf/xlsx）
│   └── routes.py           # 上传接口
├── guide/                  # 引导 Bot（遗留兼容）
│   ├── adapter.py          # guide:// 适配器
│   ├── help_index.py       # 帮助索引
│   └── llm_client.py       # LLM 客户端
└── db/                     # 数据库
    ├── models.py           # SQLAlchemy 模型（Bot=Model+Template）
    ├── session.py          # 异步会话管理
    └── seed.py             # 种子数据（内置模型、模板、Bot）
```

### 前端结构（frontend/src/）

```
frontend/src/
├── main.tsx        # React 入口，路由配置
├── App.tsx         # 主聊天界面
├── AdminPage.tsx   # 管理后台界面
└── index.css       # Tailwind 导入
```

### 四层记忆体系

每个频道拥有独立的四层记忆结构，存储于 SQLite Context Store：

| 记忆层 | 键名 | 存储 | 内容描述 |
|--------|------|------|----------|
| 项目锚点 | `anchor` | SQLite + ANCHOR.md | 核心目标、关键约定、成员职责 |
| 决策记录 | `decisions` | SQLite + DECISIONS.md | 重要决策（时间戳、决策人、依据、结论）|
| 资料索引 | `files_index` | SQLite + FILES_INDEX.md | 已上传文件摘要索引 |
| 近期动态 | `recent` | SQLite + RECENT.md | 最近消息压缩摘要 |

记忆注入格式见 `app/memory/manager.py:build_system_prompt_prefix()`

## Setup

### 环境要求

- Python 3.13+
- Node.js 18+
- SQLite 3
- Redis 7+（可选）

### 后端开发启动

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt  # 或使用 uv sync

# 配置环境变量
cp ../.env.example ../.env
# 编辑 .env 填写数据库等配置

# 启动服务
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 或使用 PowerShell 脚本（从项目根）
.\run_backend.ps1
```

### 前端开发启动

```bash
cd frontend
npm install
npm run dev  # Vite dev server on http://localhost:5173
```

### Docker Compose 一键部署（推荐）

```bash
# 复制模板配置文件
cp docker-compose.yml.template docker-compose.yml

# 启动所有服务
docker compose up -d

# 访问地址：
# 前端: http://localhost:80
# API: http://localhost:8000
```

默认会写入种子数据：
- 内置模型：Ollama (Llama 3.2)、OpenAI GPT-4o
- 内置模板：通用助手、代码审查、创意写作
- 内置 Bot：@助手、@代码审查

如需关闭自动种子数据，设置环境变量 `SEED_DATA=0`。

## Build & Test Commands

### 后端测试

```bash
# 运行所有测试（从项目根）
cd backend && pytest ../tests -v

# 带覆盖率
cd backend && pytest ../tests --cov=app --cov-report=html

# 单文件测试
cd backend && pytest ../tests/test_orchestrator_integration.py -v
```

测试配置位于 `pyproject.toml`:
- `asyncio_mode = "auto"`
- 测试路径: `../tests`（相对 backend 目录）

### 前端构建

```bash
cd frontend
npm run build    # 生产构建（输出到 dist/）
npm run preview  # 预览生产构建
```

### 数据库迁移（Alembic）

```bash
cd backend

# 创建迁移
alembic revision --autogenerate -m "描述"

# 执行迁移
alembic upgrade head

# 回滚
alembic downgrade -1
```

## Code Style Guidelines

### Python

- **代码风格**: PEP 8，使用 flake8 检查
- **最大行长度**: 120 字符（`pyproject.toml` 中配置）
- **类型注解**: 推荐使用，特别是函数参数和返回值
- **异步**: 大量使用 `async/await`，数据库操作为异步 SQLAlchemy
- **字符串格式**:
  - 日志消息使用 `%` 格式化（延迟求值）
  - 其他使用 f-string

### 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 模块/包 | 小写 + 下划线 | `chat_core`, `file_processor` |
| 类 | PascalCase | `AgentPayload`, `HttpBotAdapter` |
| 函数/变量 | 小写 + 下划线 | `get_logger`, `channel_id` |
| 常量 | 大写 + 下划线 | `TEST_DATABASE_URL` |
| 私有 | 下划线前缀 | `_resolve_log_dir` |

### TypeScript/React

- 使用函数组件 + Hooks
- 类型定义优先使用接口（interface）
- 组件文件使用 PascalCase（如 `AdminPage.tsx`）

## Testing Instructions

### 测试结构

```
tests/
├── conftest.py                 # pytest fixtures
├── test_orchestrator_integration.py  # 编排层集成测试
├── test_adapters.py            # 适配器测试
├── test_memory.py              # 记忆管理测试
├── test_mention.py             # @提及解析测试
├── test_guide.py               # 引导 Bot 测试
├── test_channels_api.py        # 频道 API 测试
├── test_messages_api.py        # 消息 API 测试
├── test_workspaces_api.py      # 工作区 API 测试
├── test_channel_members_api.py # 频道成员 API 测试
└── __init__.py
```

### 关键 Fixtures（conftest.py）

- `db_engine`: 内存 SQLite 引擎
- `db_session`: 每个测试独立的异步会话
- `client`: 覆盖依赖的 FastAPI 测试客户端

### 编写测试的注意事项

1. **使用异步测试**: 所有测试函数使用 `async def`
2. **数据库隔离**: 每个测试使用独立的事务，结束后回滚
3. **Mock 外部服务**: Bot 测试使用 Mock，避免真实调用
4. **UUID 固定**: 测试中使用固定 UUID 便于断言

## Configuration

### 环境变量（.env）

```bash
# 数据库（主业务库 SQLite）
DATABASE_URL=sqlite+aiosqlite:///data/main.db

# Context Store 用 SQLite（四层记忆）
SQLITE_CONTEXT_PATH=data/context_store/context.db

# Redis（可选）
REDIS_URL=redis://localhost:6379/0

# 数据根目录
DATA_DIR=data

# 调试模式
DEBUG=false

# 系统 LLM（RECENT 压缩等，遗留兼容）
SYSTEM_LLM_API_KEY=
SYSTEM_LLM_BASE_URL=https://api.openai.com/v1
SYSTEM_LLM_MODEL=gpt-4o-mini

# 引导 Bot LLM（遗留兼容）
GUIDE_LLM_BASE_URL=http://localhost:11434/v1
GUIDE_LLM_MODEL=llama3.2
```

### 配置类（app/config.py）

使用 `pydantic-settings`，从环境变量加载，支持 `.env` 文件。

关键配置项：
- `database_url`: 主数据库 URL
- `sqlite_context_path`: Context Store 路径
- `redis_url`: Redis 连接
- `data_dir`: 数据根目录
- `log_dir`: 日志目录
- `debug`: 调试模式

## Key Development Conventions

### 前端统一组件约定

#### 统一搜索框

- 所有成员搜索、好友搜索、Bot 搜索、文件搜索、聊天记录搜索、频道/工作区搜索等入口，优先复用 `frontend/src/components/SearchPicker.tsx`。
- 后端搜索入口统一走 `GET /api/v1/search`，通过 `context` 表达业务场景，通过 `types` 限定返回分组，通过 `workspace_id` / `channel_id` 限定范围。
- 不要为新场景另写独立搜索框、独立下拉结果样式或独立搜索 API；确有差异时先扩展 `SearchPicker` 和 `/api/v1/search` 的通用能力。
- 搜索结果展示应保持统一分组与交互：加载态、空状态、筛选条件、结果高亮、结果点击行为、文件预览、消息跳转等都应沿用统一组件。
- 搜索框、scope、筛选 chips、弹层、结果行和 action 样式统一走 `design-tokens.css` 中的 `.an-search-*`，不要在业务组件内复制 Tailwind 样式。
- 旧接口或旧组件只作为兼容保留，新 UI 不再新增对 `friends/search` 这类专用搜索入口的依赖。

#### 统一 Members Item

- 成员、好友、Bot、邀请候选人、频道成员列表、好友列表、成员管理弹窗等场景中的人员条目，应复用统一 members item 组件或同一渲染封装。
- members item 应统一头像/首字母、显示名、`@username`、Bot 标识、关系/权限/在线状态、主操作和危险操作的布局，不要在各页面重复手写一套 row/card。
- 新增成员类列表时，先抽象或复用现有统一 members item；只有业务字段明显不同，才通过 props 扩展，不要复制 Tailwind/inline style 片段。
- 统一 members item 的交互状态必须一致：hover、focus、disabled、loading、selected、danger action、移动端换行和长文本截断都要统一处理。
- 成员项样式统一走 `.an-member-*` / `.an-row-card`；成员操作按钮走 `.an-btn`，危险操作走 `.an-btn-danger`，成员行内 select 走 `.an-select`。

### Bot 架构（新）

**核心理念：Bot = AIModel + PromptTemplate**

创建 Bot 只需两步：
1. 选择一个 **AI 模型**（如 GPT-4o、Llama 3.2）
2. 选择一个 **提示词模板**（定义 system_prompt 和 user_template）

#### 数据模型

**AIModel** (`ai_models` 表) - 管理可用的 LLM：
| 字段 | 说明 |
|------|------|
| `model_id` | UUID |
| `name` | 显示名称（如 "GPT-4o"） |
| `provider` | 提供商（openai, ollama, anthropic） |
| `model_name` | API 模型名（如 "gpt-4o"） |
| `base_url` | API Base URL |
| `api_key` | API Key（可选） |
| `config` | 额外配置（temperature, max_tokens 等） |

**PromptTemplate** (`prompt_templates` 表) - 可复用的提示词：
| 字段 | 说明 |
|------|------|
| `template_id` | UUID |
| `name` | 模板名称（如 "代码审查"） |
| `system_prompt` | 系统提示词 |
| `user_template` | 用户消息模板，支持 `{{变量}}` 占位符 |
| `variables` | 变量列表 |

**BotAccount** (`bot_accounts` 表) - 引用模型和模板：
| 字段 | 说明 |
|------|------|
| `bot_id` | UUID |
| `username` | @ 用的名字 |
| `model_id` | 关联的 AI 模型 |
| `template_id` | 关联的提示词模板 |
| `custom_system_prompt` | 可选：覆盖模板的 system_prompt |

#### API 接口

**AI 模型管理**：
- `GET /api/admin/models` - 列表
- `POST /api/admin/models` - 创建
- `PUT /api/admin/models/{id}` - 更新
- `DELETE /api/admin/models/{id}` - 删除

**提示词模板管理**：
- `GET /api/admin/templates` - 列表
- `POST /api/admin/templates` - 创建
- `PUT /api/admin/templates/{id}` - 更新
- `DELETE /api/admin/templates/{id}` - 删除

**Bot 管理**：
- `GET /api/bots` - 列表
- `POST /api/bots` - 创建（指定 model_id + template_id）
- `PUT /api/bots/{id}` - 更新

#### 创建 Bot 示例

```bash
# 1. 先创建模型（如果还没有）
POST /api/admin/models
{
  "name": "Ollama Llama 3.2",
  "provider": "ollama",
  "model_name": "llama3.2",
  "base_url": "http://localhost:11434/v1"
}

# 2. 先创建模板（如果还没有）
POST /api/admin/templates
{
  "name": "代码审查",
  "system_prompt": "你是一个专业的代码审查助手...",
  "user_template": "请审查以下代码：\n```\n{{message}}\n```"
}

# 3. 创建 Bot
POST /api/bots
{
  "username": "代码助手",
  "model_id": "xxx",
  "template_id": "yyy"
}
```

#### 适配器实现

- `app/adapters/http_bot.py` - `HttpBotAdapter`
- `app/orchestrator/adapter_resolver.py` - 统一使用 HttpBotAdapter

### 新增 API 路由

1. 在对应模块创建 `router = APIRouter()`
2. 在 `main.py` 中使用 `app.include_router()` 注册
3. 添加对应的测试文件

### WebSocket 消息格式

```typescript
// 广播消息格式
{
  type: "message" | "bot_processing" | "system" | "echo",
  data: any,
  channel_id?: string,
  timestamp?: string
}
```

### 日志规范

- 使用 `app.logging_config.get_logger(name)` 获取 logger
- API 请求自动记录（在 `main.py` 中间件中）
- 错误写入 `error.log`
- 内存缓冲用于管理端拉取

## Deployment

### Docker 构建

```bash
# 构建镜像
docker compose build

# 启动
docker compose up -d

# 查看日志
docker compose logs -f backend
```

### 数据持久化

- SQLite 数据存储在 Docker Volume `agentnexus_data`
- 挂载路径: `/app/data`
- 包含: 主数据库、Context Store、上传文件、日志

## Security Considerations

1. **环境变量**: 敏感信息（API Key、密码）必须写入 `.env`，不提交到 Git
2. **CORS**: 生产环境修改 `allow_origins`，不要允许 `*`
3. **密码存储**: 使用 `passlib` 哈希存储
4. **文件上传**: 限制上传大小和类型，存储在安全目录
5. **API Key 保护**: API 响应中隐藏 model_api_key，只显示掩码版本

## Documentation

详细文档位于 `docs/` 目录，按受众分为两类：

- `docs/help/` — 面向最终用户与运维管理员
- `docs/develop/` — 面向开发与设计

| 文档 | 内容 |
|------|------|
| `docs/help/使用说明书.md` | 总索引，包含所有用户文档链接 |
| `docs/help/安装部署说明.md` | 部署步骤和环境配置 |
| `docs/develop/总体架构设计.md` | 技术选型、六层架构、数据流 |
| `docs/develop/详细设计.md` | 模块设计、数据模型、接口规范 |
| `docs/develop/关键技术文档.md` | 关键技术实现细节 |
| `docs/develop/易用性设计.md` | 交互、用语与扩展点 |

## Notes

- 项目使用 **中文** 作为主要文档和注释语言
- 代码中保持英文命名，注释使用中文
- 设计决策参考 Mattermost/Slack，但不依赖其实现
- Python 全栈自研，聚焦频道管理、实时消息、Bot 接入三大核心
