.PHONY: lint fix test docs-pages design-system-check dev-gateway dev-frontend dev-ports dev-deps dev-deps-down

lint:
	cd server && cargo clippy --all-targets

fix:
	cd server && cargo fmt && cargo clippy --fix --allow-dirty --allow-staged

test:
	cd server && cargo test

docs-pages:
	node scripts/generate-architecture-status-page.mjs

design-system-check:
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

dev-gateway:
	$(INFISICAL_RUN) cargo run --manifest-path server/Cargo.toml

dev-frontend:
	$(INFISICAL_RUN) npm --prefix frontend run dev

# Infisical 的 dev 值指向 localhost:5432 / :9000，但本地 Postgres 和 rustfs 只作为
# ClusterIP 跑在 kind 里（deploy/kind-config.yaml 只映射了 NodePort 30080）。没有
# 这层转发，dev-gateway 会以 "pool timed out while waiting for an open connection"
# 失败——那是 sqlx 连不上、重试到超时的说法，不是数据库慢。
# 单开一个终端跑它，Ctrl-C 同时停掉两条转发。
# Ctrl-C 必须靠 trap，不能靠信号自己传播：make 的 recipe 跑在非交互 shell 里，没有
# job control，而 POSIX 规定这种 shell 用 `&` 起的后台进程会把 SIGINT/SIGQUIT 设成
# 忽略。所以 Ctrl-C 只杀得掉 make 和这层 sh，两条 kubectl 会变成孤儿继续占着 5432/
# 9000——下次 make dev-ports 报 "bind: address already in use"，而你以为没有转发在跑。
dev-ports:
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

dev-deps:
	$(INFISICAL_RUN) $(COMPOSE) up -d $(DEV_DEPS)

dev-deps-down:
	$(INFISICAL_RUN) $(COMPOSE) stop $(DEV_DEPS)
