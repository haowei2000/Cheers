# AgentNexus 技术排查 Q&A

> 面向**运维与开发**：故障现象、排查步骤、日志与诊断接口、常见技术问题。日常使用类问题见 [普通用户使用说明](普通用户使用说明.md)。  
> **LLM 使用说明**：回答报错、连不上、503、日志位置、如何排查时，应引用本文档对应章节（§二 日志与诊断、§三 故障现象与处理、§四 常见 Q&A）。

---

## 一、文档内术语与范围

- **项目**：即频道（Channel），用户在其中聊天、@ Bot。API 中称为 channel，channel_id 即项目 ID。
- **工作空间**：创建项目前必须先有工作空间；API 为 workspace_id。
- **Bot**：可被 @ 的 AI 助手；须先注册再「加入」到具体项目后，用户 @ 才会生效。
- 本文档仅覆盖**技术侧**故障（接口、日志、部署、数据库）；「怎么建项目」「怎么加人」等操作步骤见 [系统管理说明书](系统管理说明书.md)。

---

## 二、日志与诊断

### 2.1 日志文件位置与含义

后端将日志写入**文件**（需配置 `LOG_DIR`，默认 `data/logs`，路径相对 **backend** 目录）：

| 文件 | 内容 | 何时查看 |
|------|------|----------|
| **agentnexus.log** | 通用运行日志（INFO 及以上）；含启动、请求、部分警告 | 查看请求是否到达、启动是否成功、一般警告 |
| **error.log** | 仅 ERROR、CRITICAL 及异常堆栈 | **排查错误时优先查看此文件** |

- **路径**：本地为 `backend/data/logs/`（若未改 LOG_DIR）；Docker 为容器内 `/app/data/logs/`，对应宿主机卷挂载点。
- **未配置或不可写**：日志仅输出到控制台。Docker 下可用 `docker compose logs backend` 查看 stdout/stderr。
- **环境变量**：`LOG_DIR`、`LOG_MAX_BYTES`（单文件最大字节，默认 5MB）、`LOG_BACKUP_COUNT`（保留份数，默认 3）。详见 [系统管理说明书 - 日志文件](/manual/系统管理说明书#日志文件便于排查错误)。

### 2.2 日志中常见关键词与含义

| 日志中出现 | 含义 | 建议动作 |
|------------|------|----------|
| `database unavailable` / `ConnectionRefusedError` | 数据库不可达 | 检查 DATABASE_URL、数据目录权限、是否执行过迁移；见 §三 503 |
| `unhandled exception` + 堆栈 | 未捕获异常，已记录完整堆栈 | 查看 error.log 中该条下方的 Traceback；根据堆栈定位代码或依赖 |
| `orchestrator failed` | 消息 @ Bot 后编排器执行失败 | 查看同条日志中的 channel_id、异常类型；检查 Bot 配置、记忆/数据库 |
| `guide llm request failed` | 引导 Bot 调用的 LLM 请求失败 | 检查 GUIDE_LLM_BASE_URL、GUIDE_LLM_MODEL、网络；系统会退回关键词匹配 |
| `no mentioned bots in channel` / `channel_bots=[]` | 当前频道没有对应 Bot 成员 | 在「管理」中将该 Bot 加入该项目（member_id=bot_id, member_type=bot） |

### 2.3 健康检查与诊断接口

| 接口 | 方法 | 用途 |
|------|------|------|
| **健康检查** | `GET http://localhost:8000/health` | 后端是否存活；正常返回 `{"status":"ok"}`。若 503 或连不上，说明后端未启动或端口/网络错误。 |
| **API 文档** | 浏览器打开 `http://localhost:8000/docs` | 查看所有 API 路径、参数、响应格式；可用于确认接口是否可用。 |

**建议排查顺序**：先访问 `/health` 确认后端可达；再根据现象查 §三 表格；需要细节时查 **error.log** 与 **agentnexus.log**。

---

## 三、故障现象与处理

下表按「现象 → 可能原因 → 排查步骤 → 解决方案」组织，便于按步骤执行。

| 现象 | 可能原因 | 排查步骤 | 解决方案 |
|------|----------|----------|----------|
| **前端打不开 / 白屏** | 前端未启动、端口错误、静态资源 404 | 1）确认访问地址（Docker 80，本地 5173）；2）看浏览器控制台 Network/Console 报错 | 启动前端服务或对应容器；修正端口与代理配置 |
| **接口返回 503** | 主库不可达、DATABASE_URL 错误、迁移未执行 | 1）访问 `GET /health`，若 503 看响应 body；2）查 error.log 是否有数据库连接错误 | 检查 DATABASE_URL、数据目录存在且可写；在 backend 目录执行 `alembic upgrade head`；重启后端 |
| **接口返回 404** | 资源不存在（频道/成员/文件等） | 1）确认 URL 中的 ID（channel_id、member_id、file_id）；2）用 GET 列表接口核对是否存在 | 修正 ID 或先创建对应资源（见 [系统管理说明书](系统管理说明书.md)） |
| **接口返回 400** | 参数错误、请求体格式或类型不符 | 查看响应 body 中的 `message` / `detail` | 按 API 文档修正参数；文件上传仅支持 .txt、.md、.docx |
| **频道列表为空 / 之前建的频道消失** | 未建工作空间与项目；或**数据库路径不一致**导致连到空库 | 1）确认主库路径（见 §四 Q：频道消失）；2）确认已执行迁移并建过工作空间与项目 | 统一数据库路径；或从旧路径复制 main.db 到当前使用的路径后重启；重建工作空间与项目 |
| **发送消息无反应** | 网络异常、后端报错、WebSocket 未连上 | 1）浏览器开发者工具看发送消息的接口是否 4xx/5xx；2）看 error.log 是否有异常 | 根据接口错误码与日志修正；刷新页面重试 |
| **WebSocket 断开、消息不实时** | 网络抖动、服务重启、代理超时 | 1）刷新页面重建连接；2）检查 Nginx/反向代理的 WebSocket 超时与 upgrade 配置 | 调整代理超时；保证后端稳定运行 |
| **文件上传 400** | 非支持格式或缺少参数 | 确认请求含 channel_id、uploader_id、filename 及 body；格式为 .txt/.md/.docx | 按 [系统管理说明书](系统管理说明书.md) 或 API 文档修正 |
| **文件状态为 failed** | 转换失败（格式异常、mammoth 等报错） | 查看 agentnexus.log / error.log 中与 file、convert、mammoth 相关的错误 | 确认文件未损坏、扩展名与内容一致；必要时查依赖版本 |
| **@ Bot 无回复** | Bot 未加入该频道、username 不匹配、或真实服务不可达 | 1）GET `/api/channels/{项目ID}/members?with_username=1` 看是否有该 Bot；2）确认 @ 的名字与 bot 的 username 完全一致；3）若 endpoint 为 http(s)，确认该服务已实现 POST /execute 且可访问 | 在「管理」中将 Bot 加入该项目；或修正 @ 的名字；或检查 OpenClaw 服务与 [系统管理说明书 §4.4](/manual/系统管理说明书#44-真实调用的请求响应约定openclawendpoint-为-https-时) 约定 |
| **@引导 无回复** | 引导 Bot 未加入当前项目、或未创建 | 1）确认是否执行过种子数据或手动创建过引导 Bot；2）GET 当前项目 members 是否含 bot-guide-001；3）查日志是否有 orchestrator/guide 相关错误 | 执行种子数据或手动添加成员（member_id=bot-guide-001, member_type=bot）；详见 [系统管理说明书 - @引导 无反应时如何排查](/manual/系统管理说明书#引导-无反应时如何排查) |

---

## 四、常见技术 Q&A

**Q：必须安装 Redis 吗？**  
A：当前阶段可选；不装也能运行，部分异步能力可能受限。Docker Compose 默认带 Redis。

**Q：频道/测试频道消失，之前建的频道看不到了？**  
A：多半是**同一台机上用了不同的数据库文件**。主库为 SQLite，默认路径会随**进程当前工作目录**变化（如从项目根启动 vs 从 backend 启动），导致连到不同文件。  
**处理**：  
1. 确认代码中主库路径已统一为相对 **backend** 的绝对路径（本地即 `backend/data/main.db`），重启后端后固定使用该库。  
2. 若数据曾在项目根下 `data/main.db`，可将该文件复制到 `backend/data/main.db`（先停服务），再重启。  
3. Docker 下数据在卷 **agentnexus_data**；若执行过 `docker compose down -v`，卷被删会清空数据，需避免带 `-v` 或提前备份。

**Q：如何修改主库或 Context Store 路径？**  
A：修改 .env 中 **DATABASE_URL**、**SQLITE_CONTEXT_PATH**（可为相对或绝对路径）；主库变更后需执行 `alembic upgrade head` 并重启服务。

**Q：Docker 下数据存在哪？**  
A：使用命名卷 **agentnexus_data**，默认挂载到 backend 容器内（如 /app/data）；具体见 docker-compose.yml 的 volumes。

**Q：如何确认 OpenClaw 是否被调用？**  
A：当 Bot 的 openclaw_endpoint 为 **http://** 或 **https://** 时，系统会向该地址 **POST /execute** 发起请求；可在后端日志或对方服务日志中确认。若 endpoint 为 guide:// 或非 http，则不会发起真实 HTTP 调用。

**Q：支持多少用户/频道？**  
A：当前按 SQLite 单机设计，适合小团队与原型；规模扩大可考虑将主库迁移至 PostgreSQL（见 [关键技术文档](关键技术文档.md) 等）。

**Q：完整 API 文档在哪？**  
A：后端启动后访问 **http://localhost:8000/docs**（Swagger）。

**Q：日志里不能出现敏感信息有什么约定？**  
A：应用层不应在日志中打印密码、API Key、完整 token；错误信息可包含请求方法、路径、异常类型，但不记录请求体中的敏感字段。

---

## 五、相关文档

- [00-文档索引与LLM使用说明](00-文档索引与LLM使用说明.md)（文档地图与术语，供 LLM 检索）
- [使用说明书](使用说明书.md)（总索引）
- [普通用户使用说明](普通用户使用说明.md)（用户侧常见问题）
- [系统管理说明书](系统管理说明书.md)（建项目、加人、加 Bot、日志配置）
- [安装部署说明](安装部署说明.md)（环境与部署）
