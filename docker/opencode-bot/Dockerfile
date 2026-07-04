# Override for a regional mirror, e.g. --build-arg BASE_REGISTRY=docker.m.daocloud.io
ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/library/rust:1-bookworm AS agent-builder

WORKDIR /build
COPY packages/cheers-acp-connector-rs ./packages/cheers-acp-connector-rs
COPY packages/cheers-mcp-server ./packages/cheers-mcp-server
RUN cargo build --release --manifest-path packages/cheers-acp-connector-rs/Cargo.toml \
    && cargo build --release --manifest-path packages/cheers-mcp-server/Cargo.toml

FROM ${BASE_REGISTRY}/library/node:20-bookworm-slim

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG OPENCODE_VERSION=1.15.6

ENV NODE_ENV=production
ENV OPENCODE_HOME=/app/state/opencode

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY --from=agent-builder /build/packages/cheers-acp-connector-rs/target/release/cce-acp-connector /usr/local/bin/cce-acp-connector
COPY --from=agent-builder /build/packages/cheers-mcp-server/target/release/cheers-mcp-server /usr/local/bin/cheers-mcp-server
RUN npm config set registry "${NPM_REGISTRY}" \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

COPY docker/opencode-bot/entrypoint.sh /usr/local/bin/cheers-opencode-bot
RUN chmod +x /usr/local/bin/cheers-opencode-bot \
    && mkdir -p /app/config /app/state /app/state/opencode /workspace

WORKDIR /workspace
ENTRYPOINT ["cheers-opencode-bot"]
