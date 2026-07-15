# ── build ────────────────────────────────────────────────────────────────────
# Build context is the REPO ROOT (docker build -f server/Dockerfile .) because
# Cargo.toml has a path dependency on the shared bridge-protocol crate under
# packages/ — a server/-only context can't see it.
FROM rust:1-bookworm AS builder
WORKDIR /app/server

# ── 1) Dependency cache layer ────────────────────────────────────────────────
# Copy ONLY the manifests (server's + the path-dep crate's) and stub out both
# crates' sources, then build. This compiles the whole ~500-crate dependency
# tree into a layer cached and invalidated ONLY when Cargo.toml/Cargo.lock change
# — NOT on every source edit. Without it, any code change rebuilt every dependency
# from scratch (~50 min); with it, a redeploy recompiles only the two workspace
# crates below (~1–2 min).
COPY server/Cargo.toml server/Cargo.lock ./
COPY packages/cheers-acp-connector-rs/bridge-protocol/Cargo.toml \
     /app/packages/cheers-acp-connector-rs/bridge-protocol/Cargo.toml
RUN mkdir -p src /app/packages/cheers-acp-connector-rs/bridge-protocol/src \
    && echo 'fn main() {}' > src/main.rs \
    && : > src/lib.rs \
    && : > /app/packages/cheers-acp-connector-rs/bridge-protocol/src/lib.rs \
    && cargo build --release \
    && rm -rf src /app/packages/cheers-acp-connector-rs/bridge-protocol/src

# ── 2) Real build ────────────────────────────────────────────────────────────
# Copy the actual sources; only `server` + `cheers-bridge-protocol` recompile
# (their dependencies are already built and cached in the layer above).
# sqlx uses offline query data (no DB at build); migrations are embedded via the
# migrate! macro at compile time, so migrations/ must be present here.
COPY packages/cheers-acp-connector-rs/bridge-protocol \
     /app/packages/cheers-acp-connector-rs/bridge-protocol
COPY server/src ./src
COPY server/migrations ./migrations
# assets/ holds files embedded via include_str! (e.g. the mode-2 install.sh).
COPY server/assets ./assets
# CRITICAL: `docker COPY` preserves the source files' original mtimes, which are
# OLDER than the stub artifacts built in the cache layer above. Without bumping
# them, cargo sees "source older than artifact" and SKIPS the rebuild — shipping
# the empty stub binary (exits 0 immediately → CrashLoopBackOff). Touch the real
# sources so their mtime beats the stubs and both crates actually recompile.
RUN find src /app/packages/cheers-acp-connector-rs/bridge-protocol/src -name '*.rs' -exec touch {} + \
    && cargo build --release

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
