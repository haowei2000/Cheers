# AGENTS 说明

> **语言**：中文 | [English](AGENTS.md)

面向在 Cheers 上工作的编码智能体的项目专属说明。

英文版是为开源文档集准备的默认公开版本，本文件是其中文镜像。

## 关键主题

- 项目概览与技术栈
- 分支策略
- 架构总览
- 环境搭建、构建与测试命令
- 编码与测试约定

## 当前指引

- 优先以英文 `.md` 文件作为默认公开入口。
- `.zh-CN.md` 文件作为中文镜像。
- 涉及实现细节时，先以当前代码和用户/运维文档为准进行核实。
- 历史设计笔记可能描述的是规划中的功能；存疑时，以 README、`docs/help/` 和当前代码为权威。

## 问题优先修复（强制）

- **不要**为了通过编译而添加临时兼容占位（例如假参数 `_after`、`_after_limit`、`TODO`
  默认值或硬编码分支），必须先修复真实的契约不一致。
- 当行为契约不一致时（例如 API 与资源响应、分页形状），先在真实的调用方/生产方路径中
  解决根因，再让两端对齐到一个明确的形状。
- 变更必须可追溯：说明根因、选择的方向，以及为什么（若有）兼容垫片不再需要。

## sqlx 迁移纪律（强制）

网关使用 sqlx 迁移（`server/migrations/<NNNN>_<desc>.sql`），在启动时自动执行
（`main.rs: sqlx::migrate!`）。请把它们当作数据库协议变更，而不是普通源码文件。

- **顺序、线性、绝不复用前缀。** 链路是 `0001 -> 0002 -> 0003 …`。两个分支并行新增
  迁移时，先 rebase 并重新编号，确保不存在两个 `0003_*.sql`。
- **绝不修改已应用迁移的内容。** sqlx 会对每个已应用迁移做校验和；改动其内容会让启动
  因校验和不匹配而失败。要改 schema，就新增一个**新的**编号迁移（例如
  `ALTER … ADD COLUMN IF NOT EXISTS …`、`DROP … IF EXISTS …`）。
- **幂等 DDL。** 使用 `IF NOT EXISTS` / `IF EXISTS`，保证部分应用或重复执行的迁移是
  安全的。注意 Postgres **不**支持 `ADD CONSTRAINT IF NOT EXISTS` —— 约束要内联写在
  `CREATE TABLE` 里。
- **id 是 `VARCHAR(36)`**，与基线一致（不是 `UUID`）；外键保持一致。
- 发布前**从空库验证**：`cd server && cargo build` 会内嵌迁移；启动一个干净的 Postgres
  让网关在启动时执行迁移，或对一个临时数据库运行 `sqlx migrate run`。
- 网关代码或迁移变更后，**重建并重新创建**服务（不能只重启）：

```bash
docker compose build --no-cache gateway
docker compose up -d --force-recreate --no-deps gateway
```

## ACP Connector 发布顺序（强制）

TypeScript 版 `packages/cheers-acp-connector` npm 包已经删除。
当前受支持的 connector 是 `packages/cheers-acp-connector-rs` 下的 Rust crate。

当 connector 行为有实质性变化时，必须按以下顺序执行：

1. Rust connector 版本或依赖变化时，更新 `packages/cheers-acp-connector-rs/Cargo.toml` 和 `Cargo.lock`。
2. 对 `packages/cheers-acp-connector-rs` 运行 `cargo fmt --check`、`cargo test` 和 `cargo check`。
3. 从同一个已合并提交重建并推送 `opencode-bot` 镜像，确保容器部署包含新的 Rust connector 和 MCP server 二进制。
4. 对本地运行 connector 的机器，从 repo 或批准的 release artifact 安装 Rust binary，然后重启对应的 connector daemon。
5. 对容器部署，拉取或部署重建后的 `opencode-bot` 镜像并重新创建服务。

不要重新引入旧的 npm connector 包或已退役的 `@haowei0520/acp-connector` 发布 workflow。

## 技术栈与测试

外部智能体优先：**Rust 网关**（`server/`）是唯一后端，**React 前端**（`frontend/`）保留，
智能体从外部接入（`packages/cheers-mcp-server` 是标准桥接）。参见
[docs/arch/ARCHITECTURE_OVERVIEW.md](docs/arch/ARCHITECTURE_OVERVIEW.md)。

```bash
# 网关单元/构建检查
cd server && cargo build && cargo test

# 完整服务栈（gateway + frontend + postgres + redis + rustfs）
cp docker-compose.yml.template docker-compose.yml
docker compose up -d --wait     # 网关在启动时执行 sqlx 迁移
docker compose ps
docker compose port gateway 8000   # 不要假设端口；读取真实映射
docker compose down
```

> 旧的 `pytest -m integration` 测试套件随 Python 后端一起移除。集成测试正在网关上
> 重建；新增时必须从 `INTEGRATION_BASE_URL` 读取目标 URL（绝不硬编码端口），以便
> 通过唯一的 `COMPOSE_PROJECT_NAME` + 不同宿主机端口并行运行多套服务栈。

## 相关文档

- [文档主页](docs/help/README.zh-CN.md)
- [使用说明书](docs/help/使用说明书.zh-CN.md)
- [路线图](docs/ROADMAP.zh-CN.md)
