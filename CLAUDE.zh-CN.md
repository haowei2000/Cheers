# Claude Code 工作笔记

> **语言**：中文 | [English](CLAUDE.md)

面向在本仓库工作的 AI 编码助手的指引。

英文版是为开源文档集准备的默认公开版本，本文件是其中文镜像。

## 关键主题

- 项目概览
- 常用命令
- 架构
- 测试与迁移
- 仓库约定

## 当前指引

- 优先以英文 `.md` 文件作为默认公开入口。
- `.zh-CN.md` 文件作为中文镜像。
- 涉及实现细节时，先以当前代码和用户/运维文档为准进行核实。
- 历史设计笔记可能描述的是规划中的功能；存疑时，以 README、`docs/help/` 和当前代码为权威。
- 前端 UI 工作必须遵循 [frontend/DESIGN.zh-CN.md](frontend/DESIGN.zh-CN.md)：优先使用 `frontend/src/components/ui/` 下的共享组件，复制文档里的标准写法，不要发明新样式。

## 问题优先修复（强制）

- **不要**用临时兼容占位来掩盖真实的 API/领域不一致
  （例如添加 `_after`、`_after_limit` 这类未使用的参数，或仅为了不破坏旧调用方而返回
  fallback 字段）。
- 当契约不一致时（分页、响应形状、状态格式等），先修复事实源，让两端遵循同一协议。
- 优先采用明确的迁移计划（弃用 + 移除窗口），而不是无声的垫片。

## 技术栈与测试

平台是**外部智能体优先**的（没有 Python 服务）：**Rust 网关**（`server/`）是唯一后端，
**React 前端**（`frontend/`）保留，智能体从外部接入（`packages/cheers-mcp-server` 是
标准桥接）。参见 [docs/arch/ARCHITECTURE_OVERVIEW.md](docs/arch/ARCHITECTURE_OVERVIEW.md)。

```bash
# 网关单元/构建检查（无需集群）
cd server && cargo build && cargo test
```

### 本地运行：Kubernetes（规范路径）

本地服务栈通过 `deploy/helm/cheers` 的 **Helm chart** 运行在 **kind** 集群上 ——
gateway + frontend + postgres + rustfs（redis 可选启用）。
这是受支持的「启动服务栈」路径；`docker-compose.*` 文件是遗留后备方案（gitignore 的
本地 `docker-compose.yml` 可能已过期 —— 如需使用请从 `docker-compose.yml.template`
重新复制）。完整 chart 文档：[deploy/helm/cheers/README.md](deploy/helm/cheers/README.md)。

集群：kind 集群 `cheers`（kube context `kind-cheers`），命名空间 `cheers`。
UI：前端 NodePort → <http://localhost:30080>（登录 `admin` / `admin12345`）。

```bash
# 首次安装：构建镜像 → 加载进 kind → 安装 release
docker build -t cheers/gateway:dev -f server/Dockerfile .   # 根上下文：server 依赖 packages/.../bridge-protocol
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend
kind load docker-image cheers/gateway:dev cheers/frontend:dev --name cheers
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/jwt_priv.pem
openssl rsa -in /tmp/jwt_priv.pem -pubout -out /tmp/jwt_pub.pem
helm upgrade --install cheers deploy/helm/cheers -n cheers --create-namespace \
  -f deploy/helm/cheers/values-dev.yaml \
  --set-file secrets.jwtPrivateKey=/tmp/jwt_priv.pem \
  --set-file secrets.jwtPublicKey=/tmp/jwt_pub.pem   # 网关在启动时执行 sqlx 迁移
```

```bash
# 代码变更后重新部署：重建 → 重新加载进 kind → 滚动重启 pod。
# 以下步骤的快捷方式：./scripts/redeploy.sh [gateway|frontend|both]
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend  # gateway 用：docker build -t cheers/gateway:dev -f server/Dockerfile .
kind load docker-image cheers/frontend:dev --name cheers
kubectl -n cheers rollout restart deployment/cheers-frontend   # 或 deployment/cheers-gateway
kubectl -n cheers rollout status  deployment/cheers-frontend

# 不重建只重启服务（仅弹跳 pod）
kubectl -n cheers rollout restart deployment/cheers-gateway

# 状态 / 日志 / 卸载
kubectl get pods -n cheers
kubectl -n cheers logs deploy/cheers-gateway -f
helm uninstall cheers -n cheers           # 移除 release（保留 kind 集群）
```

> 前端专用的快速内循环：可以让 Vite（`npm --prefix frontend run dev`）指向集群内的
> 网关，但规范、可复现的服务栈是上面的 Helm/kind 路径 —— 用 k8s 启动。

> 针对运行中服务栈的集成测试正在 Rust 网关上重建（旧的 `pytest -m integration` 套件
> 随 Python 后端一起移除）。新增时必须从 `INTEGRATION_BASE_URL` 读取目标 URL（绝不
> 硬编码端口），以便通过唯一的 `COMPOSE_PROJECT_NAME` + 不同宿主机端口并行运行多套
> 服务栈。

## 相关文档

- [文档主页](docs/help/README.zh-CN.md)
- [使用说明书](docs/help/使用说明书.zh-CN.md)
- [路线图](docs/ROADMAP.zh-CN.md)
