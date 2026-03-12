# AGENTS.md

Project-specific instructions for AI coding agents working on AgentNexus.

## Project Overview

**AgentNexus（智枢协作平台）** 是一个多智能体与人类协作的聊天枢纽平台，提供类 Slack 的聊天体验，支持 OpenClaw Bot 接入和四层记忆体系。

- **Repository**: AgentNexus
- **Purpose**: 人机协作聊天平台，支持多 Agent 在频道中协同工作
- **Primary Languages/Frameworks**:
  - **后端**: Python 3.13+ / FastAPI / SQLAlchemy / WebSocket
  - **前端**: React 18 / TypeScript / Tailwind CSS / Vite
  - **数据库**: SQLite（主库 + Context Store）/ Redis（可选，用于 Bot 响应队列）
  - **Agent 框架**: OpenClaw（通过 Adapter 隔离）
  - **部署**: Docker Compose

## Architecture

### 六层架构

| 层次 | 组件 | 核心职责 |
|------|------|----------|
| ① 用户交互层 | React 前端 | 消息收发、文件上传、Bot 标识、Markdown 预览、@提及补全 |
| ② 实时通信层 | FastAPI WebSocket + REST API | 消息广播、连接管理、消息持久化、文件上传接口 |
| ③ Agent 编排层 | AgentOrchestrator | @提及路由、任务分配、多 Bot 协调、进程控制 |
| ④ 记忆管理层 | MemoryManager | 四层记忆读写、上下文拼接注入、记忆摘要压缩 |
| ⑤ Agent 执行层 | OpenClaw 实例 | 对接 LLM、执行专业任务、返回结构化响应 |
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
│   ├── bots.py             # Bot 账户 API
│   ├── ws_manager.py       # WebSocket 连接管理
│   └── schemas.py          # Pydantic 模型
├── auth/                   # 认证模块
│   └── routes.py           # 登录/注册 API
├── admin/                  # 管理后台 API
│   ├── routes.py           # 管理接口
│   ├── settings_store.py   # LLM 提供商配置
│   └── log_buffer.py       # 内存日志缓冲
├── orchestrator/           # Agent 编排
│   ├── service.py          # 编排核心服务
│   ├── mention.py          # @提及解析
│   └── adapter_resolver.py # Bot 适配器解析
├── adapters/               # OpenClaw 适配器
│   ├── base.py             # 抽象接口（AgentPayload/AgentResponse）
│   ├── mock.py             # Mock 适配器（测试用）
│   └── http_openclaw.py    # HTTP 适配器
├── memory/                 # 四层记忆管理
│   ├── manager.py          # 记忆读写接口
│   ├── context_store.py    # SQLite Context Store
│   └── recent_update.py    # RECENT 层更新
├── file_processor/         # 文件处理
│   ├── convert.py          # 文件格式转换（docx/pdf/xlsx）
│   └── routes.py           # 上传接口
├── guide/                  # 引导 Bot
│   ├── adapter.py          # guide:// 适配器
│   ├── help_index.py       # 帮助索引
│   └── llm_client.py       # LLM 客户端
└── db/                     # 数据库
    ├── models.py           # SQLAlchemy 模型
    ├── session.py          # 异步会话管理
    └── seed.py             # 种子数据初始化
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
| 决策记录 | `decisions` | SQLite + DECISIONS.md | 重要决策（时间戳、决策人、依据、结论） |
| 资料索引 | `files_index` | SQLite + FILES_INDEX.md | 已上传文件摘要索引 |
| 近期动态 | `recent` | SQLite + RECENT.md | 最近消息压缩摘要 |

记忆注入格式见 `app/memory/manager.py:build_system_prompt_prefix()`

## Setup

### 环境要求

- Python 3.13+
- Node.js 18+
- SQLite 3
- Redis 7+（可选，用于异步队列）

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

默认会写入种子数据：默认工作空间、测试项目、引导 Bot（@引导）、Orchestrator（@coordinator）。

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
| 类 | PascalCase | `AgentPayload`, `OpenClawAdapter` |
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
3. **Mock 外部服务**: Bot 测试使用 `mock://` 适配器，避免真实调用
4. **UUID 固定**: 测试中使用固定 UUID 便于断言

## Configuration

### 环境变量（.env）

```bash
# 数据库（主业务库 SQLite）
DATABASE_URL=sqlite+aiosqlite:///data/main.db

# Context Store 用 SQLite（四层记忆）
SQLITE_CONTEXT_PATH=data/context_store/context.db

# Redis（Bot 响应队列等）
REDIS_URL=redis://localhost:6379/0

# 数据根目录
DATA_DIR=data

# 调试模式
DEBUG=false

# 系统 LLM（RECENT 压缩等）
SYSTEM_LLM_API_KEY=
SYSTEM_LLM_BASE_URL=https://api.openai.com/v1
SYSTEM_LLM_MODEL=gpt-4o-mini

# 引导 Bot LLM（默认连本地 Ollama）
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

### Bot 适配器开发

1. **继承基类**: 所有适配器继承 `OpenClawAdapter`
2. **实现接口**: `execute()` 和 `health_check()`
3. **协议前缀**: 
   - `mock://` - Mock 适配器（测试）
   - `http://` / `https://` - HTTP 适配器
   - `guide://` - 引导 Bot
   - `coordinator://` - Orchestrator

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
5. **Bot Hook Token**: `openclaw_hook_token` 用于验证外部调用

## Documentation

详细文档位于 `docs/` 目录：

| 文档 | 内容 |
|------|------|
| `使用说明书.md` | 总索引，包含所有用户文档链接 |
| `总体架构设计.md` | 技术选型、六层架构、数据流 |
| `详细设计.md` | 模块设计、数据模型、接口规范 |
| `关键技术文档.md` | 关键技术实现细节 |
| `安装部署说明.md` | 部署步骤和环境配置 |
| `易用性设计.md` | 交互、用语与扩展点 |

## Notes

- 项目使用 **中文** 作为主要文档和注释语言
- 代码中保持英文命名，注释使用中文
- 设计决策参考 Mattermost/Slack，但不依赖其实现
- Python 全栈自研，聚焦频道管理、实时消息、Bot 接入三大核心
