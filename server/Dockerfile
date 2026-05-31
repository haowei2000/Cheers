# ── build ────────────────────────────────────────────────────────────────────
FROM rust:1-bookworm AS builder
WORKDIR /app

# 依赖与源码（sqlx 用运行时查询，编译无需连库；migrations 由 migrate! 宏编译期内嵌）
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release

# ── runtime ──────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/server /usr/local/bin/gateway
EXPOSE 8000
# 启动即跑 sqlx 迁移（main.rs: sqlx::migrate!），无需独立 migrate 步骤。
CMD ["server"]
