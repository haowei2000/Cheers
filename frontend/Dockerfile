# Override for regional mirrors, e.g.
#   --build-arg BASE_REGISTRY=docker.m.daocloud.io
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/library/node:20-alpine AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /repo/frontend
COPY frontend/package*.json ./
RUN npm config set registry "${NPM_REGISTRY}" && \
    npm ci --legacy-peer-deps
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
RUN npm run build

FROM ${BASE_REGISTRY}/library/nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
