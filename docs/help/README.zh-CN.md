# Cheers 帮助文档

> **语言**：中文 | [English](README.md)

本目录面向开源用户、部署运维、系统管理员和日常使用者。第一次接触项目时，建议从本文档或 [使用说明书](使用说明书.md) 进入，架构背景请参考 [文档索引](../INDEX.zh-CN.md) 中的架构文档；如有冲突以帮助文档、README 和当前代码为准。

## 按角色阅读

| 读者 | 推荐文档 | 解决的问题 |
|------|----------|------------|
| 想快速跑起来 | [安装部署说明](安装部署说明.md) | Docker Compose、本地开发、数据库迁移、首次初始化 |
| 普通用户 | [普通用户使用说明](普通用户使用说明.md) | 进入项目、发消息、@ Bot、上传文件、常见问题 |
| 系统管理员 | [系统管理说明书](系统管理说明书.md) | 创建工作空间/项目、添加成员、创建 Bot、接入 Agent Bridge |
| 提示词配置人员 | [提示词模板操作文档](prompt-template-operations.zh-CN.md) | 提示词模板变量、生效优先级、Bot 绑定、覆盖与排障 |
| ACP Agent 接入方 | [AgentBridge接入指南](AgentBridge接入指南.md) | 注册 Agent Bridge Bot、配置 WebSocket、连接支持 ACP 的本地 Agent；OpenClaw 链接已标记为废弃/遗留 |
| 文件预览部署者 | [kkFileView 文件预览配置说明](kkFileView配置说明.md) | Office/PDF 等复杂文档在线预览 |
| 对象存储部署者 | [RustFS 对象存储部署说明](RustFS对象存储部署说明.md) | S3 兼容存储、桶和访问密钥配置 |
| 排查问题 | [技术排查Q&A](技术排查Q&A.md) | 健康检查、日志、数据库、Bot 无回复、文件预览失败 |

## 当前默认口径

- Docker 默认前端入口：`http://localhost`
- Docker 默认后端 API：`http://localhost:8000`
- 主业务库与 Context Store 默认使用 PostgreSQL。
- Redis、RustFS、kkFileView 由 Docker Compose 一并启动。
- 生产环境必须替换 `.env` 中所有 `change-me` 和本地开发密钥。
- 生产部署建议使用 `docker-compose.production.tls.yml`（Caddy + HTTPS + 限定 CORS）并在 `.env` 中配置 `APP_DOMAIN`、`CORS_ALLOWED_ORIGINS` 和 `TLS_*`。

## 相关入口

- [使用说明书](使用说明书.md)：帮助文档总索引
- [文档索引](../INDEX.zh-CN.md)：帮助文档与架构文档总入口
- [发布说明](../release_note/README.zh-CN.md)：封版与版本变更记录
