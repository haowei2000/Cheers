# Override for regional mirrors, e.g.
#   --build-arg BASE_REGISTRY=docker.m.daocloud.io
#   --build-arg PNPM_REGISTRY=https://registry.npmmirror.com
ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/library/node:20-alpine AS builder
ARG PNPM_REGISTRY=https://registry.npmjs.org
WORKDIR /repo/frontend
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm config set registry "${PNPM_REGISTRY}" && \
    pnpm install --frozen-lockfile
ARG VITE_API_PROXY_TARGET=http://gateway:8000
ARG VITE_WS_PROXY_TARGET=ws://gateway:8000
ARG VITE_PUBLIC_BASE_PATH=/
ARG VITE_API_BASE_URL=/api/v1
ARG VITE_ENABLE_MERMAID=1
ENV VITE_API_PROXY_TARGET=${VITE_API_PROXY_TARGET}
ENV VITE_WS_PROXY_TARGET=${VITE_WS_PROXY_TARGET}
ENV VITE_PUBLIC_BASE_PATH=${VITE_PUBLIC_BASE_PATH}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_ENABLE_MERMAID=${VITE_ENABLE_MERMAID}
COPY frontend/ ./
# The App Store policy/support pages live in website/ as their single source of
# truth. Vite copies the selected public pages into dist during closeBundle.
COPY website/ ../website/
RUN pnpm run build

FROM ${BASE_REGISTRY}/library/nginx:alpine
COPY --from=builder /repo/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/security-headers.conf /etc/nginx/security-headers.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
