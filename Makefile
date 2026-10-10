.DEFAULT_GOAL := help
.PHONY: help lint fix test test-integration docs-pages design-system-check dev-gateway dev-frontend dev-ports dev-deps dev-deps-down dev-infra-up dev-infra-down dev-worktree-env dev-worktree-export dev-worktree-db dev-worktree-gateway dev-worktree-frontend

# Mirrors the CI clippy step exactly: same feature set, same deny-warnings gate.
# Without `--features integration` the integration suites aren't linted at all,
# and without `-D warnings` this target can't fail — CI would, so run both.
help: ## 显示所有 Make 命令
	@awk 'BEGIN { FS = ":.*##"; printf "Cheers 开发命令：\n\n" } /^[a-zA-Z0-9_.-]+:.*##/ { printf "  %-26s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

lint: ## 运行 Rust clippy 检查
	cd server && cargo clippy --all-targets --features integration -- -D warnings

fix: ## 自动格式化并修复 Rust clippy 问题
	cd server && cargo fmt && cargo clippy --fix --allow-dirty --allow-staged

# Unit tests only. The 65 Postgres-backed integration tests are gated behind the
# non-default `integration` feature, so this target passing does NOT imply CI
# will pass — use `make test-integration` (needs DATABASE_URL) for that.
test: ## 运行 Rust 单元测试
	cd server && cargo test

# The suites CI runs in the `gateway-integration` job. Needs a reachable
# Postgres that can CREATE DATABASE; #[sqlx::test] builds and drops one per test.
test-integration: ## 运行 Gateway Postgres 集成测试
	cd server && cargo test --features integration

docs-pages: ## 生成架构状态页面
	node scripts/generate-architecture-status-page.mjs

design-system-check: ## 检查前端设计系统约束
	node scripts/check-design-system.mjs

# ===== 本地开发：用 Infisical 注入密钥 =====
# 仓库根目录的 .infisical.json 固定了 workspace；环境由 INFISICAL_ENV 决定
# （默认 dev），所以 `make dev-gateway INFISICAL_ENV=staging` 也能用。
# 注入的变量优先于 .env：gateway 走的是 dotenvy::dotenv()，它不会覆盖进程里
# 已经存在的变量（server/src/config.rs:313）。首次使用前先 `infisical login`，
# CI 里则导出 INFISICAL_TOKEN（machine identity）。
INFISICAL_ENV ?= dev
INFISICAL_RUN = infisical run --env=$(INFISICAL_ENV) --
K8S_NAMESPACE ?= cheers

dev-gateway: ## 通过 Infisical 启动 Gateway
	$(INFISICAL_RUN) cargo run --manifest-path server/Cargo.toml

dev-frontend: ## 通过 Infisical 启动前端
	$(INFISICAL_RUN) pnpm --dir frontend dev

# Infisical 的 dev 值指向 localhost:5432 / :9000，但本地 Postgres 和 rustfs 只作为
# ClusterIP 跑在 kind 里（deploy/kind-config.yaml 只映射了 NodePort 30080）。没有
# 这层转发，dev-gateway 会以 "pool timed out while waiting for an open connection"
# 失败——那是 sqlx 连不上、重试到超时的说法，不是数据库慢。
# 单开一个终端跑它，Ctrl-C 同时停掉两条转发。
# Ctrl-C 必须靠 trap，不能靠信号自己传播：make 的 recipe 跑在非交互 shell 里，没有
# job control，而 POSIX 规定这种 shell 用 `&` 起的后台进程会把 SIGINT/SIGQUIT 设成
# 忽略。所以 Ctrl-C 只杀得掉 make 和这层 sh，两条 kubectl 会变成孤儿继续占着 5432/
# 9000——下次 make dev-ports 报 "bind: address already in use"，而你以为没有转发在跑。
dev-ports: ## 转发 kind 中 PostgreSQL 和 RustFS 端口
	@echo "▸ cheers-postgres → localhost:5432, cheers-rustfs → localhost:9000（Ctrl-C 停止）"
	@kubectl -n $(K8S_NAMESPACE) port-forward svc/cheers-postgres 5432:5432 & pg=$$!; \
	kubectl -n $(K8S_NAMESPACE) port-forward svc/cheers-rustfs 9000:9000 & fs=$$!; \
	trap 'kill $$pg $$fs 2>/dev/null || true' INT TERM EXIT; \
	wait

# 依赖组件也能"用 Infisical 启动"，但要说清分工：Infisical 只注入环境变量，编排
# 是 compose 做的。compose 的 ${VAR} 插值直接读进程环境，而进程环境的优先级高于
# .env 文件——所以 infisical run 注入的值会赢过本地那份可能过期的 .env。
# 真正的好处是凭据由构造保证一致：rustfs 的 root 凭据写的就是
# RUSTFS_ACCESS_KEY=${STORAGE_S3_ACCESS_KEY}，和 gateway 读的是同一对变量、同一个
# 来源，不会再出现 InvalidAccessKeyId。
# 用已入库的 .template，而不是本地那份 gitignore 的 docker-compose.yml（可能过期）。
# 与 dev-ports 二选一：两者都占 5432/9000，而且背后是两个不同的数据库。
DEV_DEPS ?= postgres rustfs
COMPOSE = docker compose -f docker-compose.yml.template

dev-deps: ## 启动旧 Compose 开发依赖
	$(INFISICAL_RUN) $(COMPOSE) up -d $(DEV_DEPS)

dev-deps-down: ## 停止旧 Compose 开发依赖
	$(INFISICAL_RUN) $(COMPOSE) stop $(DEV_DEPS)

# Shared, long-lived backing services for host-run development processes across
# worktrees. Data is persisted in named Docker volumes; per-worktree isolation
# is provided by separate PostgreSQL databases and S3 buckets.
DEV_INFRA_COMPOSE = docker compose -p cheers-dev-infra -f docker-compose.dev-infra.yml

dev-infra-up: ## 启动 worktree 共享的 PostgreSQL、Redis 和 RustFS
	$(DEV_INFRA_COMPOSE) up -d --wait

dev-infra-down: ## 停止共享开发依赖并保留数据卷
	$(DEV_INFRA_COMPOSE) down

# Print isolated local gateway settings for this checkout. The database and S3
# bucket are provisioned idempotently by Postgres/S3 helpers when the gateway starts.
dev-worktree-env: ## 显示当前 worktree 的隔离环境设置
	@sh scripts/dev-worktree-env.sh env

dev-worktree-export: ## 输出当前 worktree 环境变量的 export 命令
	@sh scripts/dev-worktree-env.sh export

# Provision this checkout's database in the shared local PostgreSQL instance.
dev-worktree-db: ## 在共享 PostgreSQL 中创建当前 worktree 的数据库
	@sh scripts/dev-worktree-env.sh db

# Run the Gateway with Infisical secrets and this worktree's isolated resources.
dev-worktree-gateway: ## 通过 Infisical 启动当前 worktree 的 Gateway
	@test -n "$$DATABASE_URL" -a -n "$$GATEWAY_PORT" || { echo "Enter a direnv-enabled worktree first (run direnv allow once)." >&2; exit 1; }
	$(INFISICAL_RUN) env \
		DATABASE_URL="$$DATABASE_URL" REDIS_URL="$$REDIS_URL" \
		S3_ENDPOINT="$$S3_ENDPOINT" S3_BUCKET="$$S3_BUCKET" \
		S3_ACCESS_KEY="$$STORAGE_S3_ACCESS_KEY" \
		S3_SECRET_KEY="$$STORAGE_S3_SECRET_KEY" \
		CORS_ALLOWED_ORIGINS="$$CORS_ALLOWED_ORIGINS" PORT="$$GATEWAY_PORT" \
		cargo run --manifest-path server/Cargo.toml

# Launch Vite on the worktree's generated port and proxy to its Gateway.
dev-worktree-frontend: ## 启动当前 worktree 的 Vite 前端
	@test -n "$$VITE_PORT" -a -n "$$VITE_API_PROXY_TARGET" || { echo "Enter a direnv-enabled worktree first (run direnv allow once)." >&2; exit 1; }
	PORT="$$VITE_PORT" pnpm --dir frontend dev
