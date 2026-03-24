# AgentNexus（智枢协作平台）

多智能体与人类协作的聊天枢纽：类 Slack 体验 + OpenClaw Bot + 四层记忆，Python 全栈自研。

## 文档

- [使用说明书](docs/使用说明书.md)（总索引）  
  - [普通用户使用说明](docs/普通用户使用说明.md) · [系统管理说明书](docs/系统管理说明书.md) · [安装部署说明](docs/安装部署说明.md) · [技术排查Q&A](docs/技术排查Q&A.md) · [功能测试清单](docs/功能测试清单.md)（M1 验收）
- [易用性设计](docs/易用性设计.md)（交互、用语与扩展点）
- [需求汇总](docs/需求汇总.md)
- [总体架构设计](docs/总体架构设计.md)
- [详细设计](docs/详细设计.md)
- [关键技术文档](docs/关键技术文档.md)
- [开发计划与里程碑](docs/开发计划与里程碑.md)
- [TodoList](docs/TodoList.md)
- [RustFS 对象存储部署说明](docs/RustFS对象存储部署说明.md)

## 技术栈

- **后端**：Python 3.13+ / FastAPI / WebSocket / SQLite（主库 + Context Store）/ Redis（可选）
- **前端**：React / Tailwind CSS
- **Agent**：OpenClaw（通过 OpenClawAdapter 隔离）
- **部署**：Docker Compose

## 本地开发

### 环境要求

- Python 3.13+
- Node.js 18+
- SQLite 3
- Redis 7+（可选，用于异步队列）

### 后端

cd backend
# 推荐使用 uv（基于 astral uv）进行包管理和虚拟环境管理
uv venv          # 创建虚拟环境（首次）
source .venv/bin/activate   # Windows: .venv\Scripts\activate
uv sync          # 安装依赖（包括 dev 依赖）
cp ../.env.example ../.env  # 编辑 .env 填写数据库等
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

### 前端

```bash
cd frontend
npm install
npm run dev
```

### 一键部署（推荐）

```bash
cp docker-compose.yml.template docker-compose.yml
docker compose up -d
# 前端: http://localhost:80   API: http://localhost:8000
# 默认会写入种子数据：默认工作空间、测试项目、引导 Bot（@引导）、Orchestrator（@coordinator）。打开前端进入「测试项目」，输入 @引导 怎么用 即可获取使用引导。
# 若需手动初始化，可设环境变量 SEED_DATA=0 并见 docs/安装部署说明.md。
```

## 验收（里程碑 1）

- 频道内 @bot 能正确回复
- 上传 docx 后 Bot 能读取内容
- 前端可登录、发消息、看历史

## Roadmap

- [x] 里程碑 1：核心链路（ChatCore + 单 Bot + 文件转 MD + 前端基础版）
- [x] 里程碑 2：多 Agent 协作（多 Bot 串行 + MemoryManager + 管理后台）
- [x] 里程碑 3：智能调度（Coordinator + 质量监控看板）
- [ ] 门户阶段一：门户基础（Orchestrator 内置 + 自动接手 + Bot 澄清）
- [ ] 门户阶段二：公共平台（公共知识/数据平台 + 访问申请 API）
- [ ] 门户阶段三：能力发现与编排增强（skills/MCP + A2A 握手）

详细里程碑规划与当前进度见 [ROADMAP.md](ROADMAP.md)。

## 许可证

见项目仓库说明。
