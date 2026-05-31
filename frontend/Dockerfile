FROM docker.m.daocloud.io/library/node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --legacy-peer-deps
ARG VITE_API_PROXY_TARGET
ARG VITE_WS_PROXY_TARGET
ARG VITE_PUBLIC_BASE_PATH
ARG VITE_API_BASE_URL
ARG VITE_ENABLE_MERMAID
ENV VITE_API_PROXY_TARGET=${VITE_API_PROXY_TARGET}
ENV VITE_WS_PROXY_TARGET=${VITE_WS_PROXY_TARGET}
ENV VITE_PUBLIC_BASE_PATH=${VITE_PUBLIC_BASE_PATH}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_ENABLE_MERMAID=${VITE_ENABLE_MERMAID}
COPY . .
RUN npm run build

FROM docker.m.daocloud.io/library/nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
