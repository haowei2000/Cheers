FROM docker.m.daocloud.io/library/rust:1-bookworm AS agent-builder

WORKDIR /build
COPY packages/agentnexus-acp-connector-rs ./packages/agentnexus-acp-connector-rs
COPY packages/agentnexus-mcp-server ./packages/agentnexus-mcp-server
RUN cargo build --release --manifest-path packages/agentnexus-acp-connector-rs/Cargo.toml \
    && cargo build --release --manifest-path packages/agentnexus-mcp-server/Cargo.toml

FROM docker.m.daocloud.io/library/node:20-bookworm-slim

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG OPENCODE_VERSION=1.15.6

ENV NODE_ENV=production
ENV OPENCODE_HOME=/app/state/opencode

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY --from=agent-builder /build/packages/agentnexus-acp-connector-rs/target/release/cce-acp-connector /usr/local/bin/cce-acp-connector
COPY --from=agent-builder /build/packages/agentnexus-mcp-server/target/release/agentnexus-mcp-server /usr/local/bin/agentnexus-mcp-server
RUN npm config set registry "${NPM_REGISTRY}" \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

COPY docker/opencode-bot/entrypoint.sh /usr/local/bin/agentnexus-opencode-bot
RUN chmod +x /usr/local/bin/agentnexus-opencode-bot \
    && mkdir -p /app/config /app/state /app/state/opencode /workspace

WORKDIR /workspace
ENTRYPOINT ["agentnexus-opencode-bot"]
