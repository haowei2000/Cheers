FROM docker.m.daocloud.io/library/node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
# Using taobao npm mirror for acceleration
# Update npm and install dependencies with more tolerance for failures
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --include=dev --legacy-peer-deps || npm install --include=dev
COPY . .
RUN npm run build

FROM docker.m.daocloud.io/library/nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
