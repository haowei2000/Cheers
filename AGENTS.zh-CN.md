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
3. 对本地运行 connector 的机器，从 repo 或批准的 release artifact 安装 Rust binary，然后重启对应的 connector daemon。

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

`frontend/` 前端统一优先使用 **pnpm**：运行 `pnpm install` 和 `pnpm <脚本>`，并以
`frontend/pnpm-lock.yaml` 作为权威锁文件。CI、Docker 构建、Tauri 前端钩子、Make 目标和前端安装文档都应使用 pnpm。其他独立 Node 包可继续使用自己的包管理器和锁文件，除非明确迁移。

## Rust 构建缓存与 Worktree 维护

本机 macOS 多 worktree 配置为每个 worktree 使用独立的 Cargo `target/`，多个 worktree
共享全局 `sccache`，并由 Worktrunk 在 APFS 上通过写时复制（CoW）为新 worktree 复用构建文件。
不要让并行 worktree 共用同一个 `CARGO_TARGET_DIR`：Cargo 会锁定 target 目录，并行 Agent 会等待锁或互相影响产物。

- `.cargo/config.toml` 关闭增量编译，并将 dev/test profile 的调试信息设为仅行号；这是本仓库的本机开发配置，可降低 target 增长。需要 LLDB 变量和类型信息时，再临时覆盖 profile。
- `target/` 保持 git 忽略且位于各自 worktree 中。`.worktreeinclude` 选择要复制的目录，`.config/wt.toml` 在 Worktrunk `pre-start` hook 运行 `wt step copy-ignored --require-include`。优先从已完成构建且没有正在写入的主 worktree 复制。APFS 会共享未变化的数据块，文件改写后才分配独立数据块。
- 在个人 shell 配置中设置 `RUSTC_WRAPPER=sccache`、`CARGO_INCREMENTAL=0`、`SCCACHE_DIR=$HOME/Library/Caches/sccache`、`SCCACHE_CACHE_SIZE=100G`。不要提交个人绝对路径或凭据。使用 `sccache --show-stats` 和 `du -sh "$SCCACHE_DIR"` 检查缓存。
- 开发单个模块时优先运行 `cargo check -p server` 或 `cargo test -p server`；需要集成验证时再运行 workspace 范围命令。独立 Rust package 可以拥有各自的 target 目录。
- 清理前先确认没有 Cargo/rustc 构建使用目标目录。宽范围清理先运行 `cargo clean-all --dry-run --keep-days 21 --keep-size 2GiB <directory>` 并审查候选项；确认后才清理闲置 target。需要局部清理时使用 `cargo clean --release` 或 `cargo clean --doc`。主 worktree 的 target 应尽量保留作为 CoW 来源。不要把 CoW 克隆的 `du` 数值相加来判断物理占用；查看 `df -h /`。
- 清理已合并 worktree 前先运行 `wt step prune --dry-run` 并审查候选项。Worktrunk 会跳过有未提交改动的 worktree。

## 相关文档

- [文档主页](docs/help/README.zh-CN.md)
- [使用说明书](docs/help/使用说明书.zh-CN.md)
- [路线图](docs/ROADMAP.zh-CN.md)
