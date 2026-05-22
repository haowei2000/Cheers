FROM docker.m.daocloud.io/library/node:20-bookworm-slim AS connector-builder

WORKDIR /build/packages/agentnexus-bridge-client

ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "${NPM_REGISTRY}"

COPY packages/agentnexus-bridge-client/package*.json ./
RUN npm ci

COPY packages/agentnexus-bridge-client/ ./
RUN npm run build

WORKDIR /build/packages/agentnexus-acp-connector

COPY packages/agentnexus-acp-connector/package*.json ./
RUN npm ci

COPY packages/agentnexus-acp-connector/ ./
RUN npm run build

FROM docker.m.daocloud.io/library/node:20-bookworm-slim

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG OPENCODE_VERSION=1.15.6

ENV NODE_ENV=production
ENV OPENCODE_HOME=/app/state/opencode

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY --from=connector-builder /build/packages/agentnexus-bridge-client /opt/agentnexus-bridge-client
COPY --from=connector-builder /build/packages/agentnexus-acp-connector /opt/agentnexus-acp-connector
RUN npm config set registry "${NPM_REGISTRY}" \
    && npm install -g /opt/agentnexus-bridge-client /opt/agentnexus-acp-connector "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

COPY docker/opencode-bot/entrypoint.sh /usr/local/bin/agentnexus-opencode-bot
RUN chmod +x /usr/local/bin/agentnexus-opencode-bot \
    && mkdir -p /app/config /app/state /app/state/opencode /workspace

WORKDIR /workspace
ENTRYPOINT ["agentnexus-opencode-bot"]
