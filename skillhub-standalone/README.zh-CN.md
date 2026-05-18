# SkillHub 独立站点

> **语言**：中文 | [English](README.md)

> Skill 管理平台，支持从 GitFox 仓库同步 Skills、管理和下载。

---

## 快速启动（推荐）

### 一键启动

```bash
# 双击运行此脚本，自动创建虚拟环境并启动
scripts/启动.bat
```

启动后访问：
- 前端：http://localhost:5173（或 5174）
- 后端：http://localhost:8002
- API 文档：http://localhost:8002/docs

---

## 环境说明

| 项目 | 说明 |
|------|------|
| 端口 | 后端 8002，前端 5173（与主项目 AgentNexus 的 8000 端口互不冲突） |
| 虚拟环境 | 位于 `backend/.venv`，**独立于主项目 AgentNexus 的虚拟环境** |
| Skills 存储 | 本地缓存 `backend/data/skills-local/`，Git 仓库 `skills-repo/`（与主项目共用） |
| 数据目录 | `data/` 已被 .gitignore 忽略，不会上传到仓库 |

**不会与主项目 AgentNexus 冲突**，两者完全独立运行。

---

## 首次运行

如果首次运行，脚本会自动：
1. 创建 Python 虚拟环境 `backend/.venv`
2. 安装依赖 `requirements.txt`
3. 启动后端和前端

后续运行直接启动，无需重复安装。

---

## 手动启动（可选）

### 后端
```bash
cd backend
.venv\Scripts\activate     # Windows
# source .venv/bin/activate  # Linux/Mac
uvicorn app.main:app --reload --host 0.0.0.0 --port 8002
```

### 前端
```bash
cd frontend
npm install
npm run dev
```

---

## 配置说明

### 首次配置

复制配置文件示例：
```bash
cd backend
copy .env.example .env
```

然后编辑 `.env` 填入实际值：

| 配置项 | 说明 |
|--------|------|
| `GITFOX_REPO_URL` | GitFox 仓库地址（内网） |
| `GITFOX_BRANCH` | Git 分支，默认 main |
| `OPENCLAW_API_KEY` | API Key（不配置则拒绝所有 OpenClaw 接口） |
| `MAX_UPLOAD_SIZE` | 最大上传大小（字节） |

> **安全说明**：`.env` 文件已被 .gitignore 忽略，不会提交到仓库。

---

## 项目结构

```
skillhub-standalone/
├── backend/              # 后端 (FastAPI)
│   ├── app/
│   │   ├── main.py       # FastAPI 入口
│   │   ├── config.py     # 配置（端口、路径等）
│   │   ├── api/v1/       # API 路由
│   │   └── services/     # 业务逻辑（同步、管理）
│   ├── requirements.txt  # Python 依赖
│   └── data/skills-local/ # 本地 Skill 缓存
├── frontend/             # 前端 (React + Vite)
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   └── pages/skillhub/
│   └── vite.config.ts    # 代理配置（API -> localhost:8002）
└── scripts/              # 启动脚本
    └── 启动.bat           # 一键启动脚本
```

---

## 功能说明

### 同步 Skills

点击前端"更新"按钮，从 GitFox 仓库同步 Skills 到本地：
- 仓库地址：`http://10.1.1.32:3000/git/openclaw/kk-claw.git`
- 同步方式：`git fetch + rebase`
- 本地缓存：`backend/data/skills-local/`

### API 接口

| 接口 | 说明 |
|------|------|
| `GET /api/v1/skillhub/skills` | 获取所有 Skills 列表 |
| `GET /api/v1/skillhub/skills/{id}` | 获取 Skill 详情 |
| `GET /api/v1/skillhub/skills/{id}/download` | 下载 Skill (ZIP) |
| `POST /api/v1/skillhub/sync` | 手动触发 Git 同步 |
| `GET /api/v1/skillhub/status` | 获取同步状态 |
