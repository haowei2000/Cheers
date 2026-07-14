# ── build ────────────────────────────────────────────────────────────────────
# Build context is the REPO ROOT (docker build -f server/Dockerfile .) because
# Cargo.toml has a path dependency on the shared bridge-protocol crate under
# packages/ — a server/-only context can't see it.
FROM rust:1-bookworm AS builder
WORKDIR /app/server

# 依赖与源码（sqlx 用运行时查询，编译无需连库；migrations 由 migrate! 宏编译期内嵌）
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY server/migrations ./migrations
# assets/ holds files embedded via include_str! (e.g. the mode-2 install.sh).
COPY server/assets ./assets
# The shared Agent Bridge frame-types crate (path dep ../packages/...).
COPY packages/cheers-acp-connector-rs/bridge-protocol /app/packages/cheers-acp-connector-rs/bridge-protocol
RUN cargo build --release

# ── runtime ──────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/server/target/release/server /usr/local/bin/gateway
EXPOSE 8000
# 启动即跑 sqlx 迁移（main.rs: sqlx::migrate!），无需独立 migrate 步骤。
# The binary is installed as `gateway` (renamed on COPY above), so run that.
CMD ["gateway"]
