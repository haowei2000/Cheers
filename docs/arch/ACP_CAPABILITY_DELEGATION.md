# ACP Frame Capability Delegation（ACP 数据帧能力签名）

> 版本：v1.0
> 日期：2026-05-31
> 目标：把“能力校验”和 `cheers_sessions` 的会话语义对齐，形成“会话关闭即失效”的闭环。

## 1. 目标与边界

- 在 ACP data WS 上，对 `send/delta/done/resource_req/session_update/permission_request` 做能力级鉴权（需签名 envelope）。
- `require_capability=true` 时强制执行；否则保持向后兼容（网关放行，不做能力签名校验）。
- 鉴权目标是：
  - `谁`（delegation 的绑定对象）
  - `可做什么`（action）
  - `在哪个资源范围内`（scope）
  - `哪些资源字段`（resource_allowlist）
  - `是否在有效期和状态下`（时间/次数/撤销）
- `session` 与 `workspace` 的生效条件必须绑定真实运行时会话，不依赖客户端猜测的字符串匹配。

## 2. 配置（`bot_accounts.binding_config.acp_security`）

- `acp_security.require_capability`：是否强制 data frame 附带 `acp_capability`。
- `acp_security.algorithm`：当前固定支持 `ed25519`。
- `acp_security.enabled` 不影响本能力鉴权开关（与 E2EE 为不同层）。

示例（能力签名强制）：

```json
{
  "acp_security": {
    "enabled": false,
    "require_capability": true,
    "algorithm": "ed25519"
  }
}
```

## 3. 签名 envelope（connector → data WS）

`acp_capability` 必须位于每个受保护帧上。

```json
{
  "type": "send",
  "acp_capability": {
    "delegation_id": "uuid",
    "ts": 1719000000,
    "nonce": "base64",
    "request_id": "r-1",
    "signature": "base64(ed25519 signature)"
  }
}
```

- `payload` 使用去除 `acp_capability` 的 frame 做稳定 JSON 序列化（排序键）后构造：
  `anx-cap|v1|type=...|kid=...|ts=...|nonce=...|request=...|payload=...`
- 用 `public_key` 做 Ed25519 验签。
- `nonce` 写 `acp_capability_nonce_log` 做一次性检测。

## 4. 会话语义对齐：`cheers_sessions` / `provider_session_key`

### 4.1 会话上下文来源
scope 检查时必须先从 frame 解析会话上下文，按以下优先级逐个尝试：

1. `provider_session_key`
2. `provider_session_id`
3. `session_id`（可反序列化为 UUID）

若以上任一字段不存在或未查到 active 会话，则鉴权拒绝（`CAPABILITY_DENIED`）。

### 4.2 会话状态闭环
检索到会话后，只有状态为：

- `active`
- `busy`

才允许继续。`idle/revoked/expired/error` 一律拒绝，体现“会话关闭即失效”。

这与现有会话生命周期一致：`done` / `finalize` 后会话被更新为 `idle`，后续能力请求无法复用旧会话继续操作。

### 4.3 scope 的具体规则

- `global`  
  不依赖 session 上下文。任意 `bot` 匹配 delegation 即可进入其他检查。

- `channel`  
  frame 必须包含 channel（或 `params.channel_id`）。`scope_id == channel_id`。

- `session`  
  delegation 需要 `session_id`（平台会话 ID）。frame 提供的会话上下文查询到的 `cheers_sessions.session_id` 必须与其一致。

- `workspace`  
  delegation 需要 `scope_id`（`workspace_id`）。
  - 查询到会话后，要求：
    - `current_scope_type = 'workspace'`
    - `current_scope_id = scope_id`
    - 会话处于 active/busy
  否则拒绝。

- `user`  
  主要用于 `delegated_to` 白名单/用户约束；频道资源权限仍由 Backend 的 resource dispatcher 结合 membership role 判断。

### 4.4 与 `session_update/done` 的关系
- `session_update` 可更新 `provider_session_id`、`metadata`，配合后续 `done`、`delta` 鉴权使用。
- `done` 常触发 session finalize，将会话状态推进为 `idle`，意味着后续再发同一会话上下文的能力帧会被拒绝，形成关闭闭环。

## 5. 校验顺序（网关）

1. `frame_type` 是否受保护（`send|delta|done|resource_req|session_update|permission_request|trace`）。
2. `acp_capability` 解析、时间窗口（±5 min）检查。
3. 加载 delegation（`bot_id + delegation_id`）。
4. `public_key` 与算法验证。
5. Ed25519 验签。
6. scope/action/resource 检查（含会话状态和 `current_scope_*`）。
7. 状态检查（`revoked/revoked_at/expires_at`）。
8. action allowlist。
9. `resource_req` 的 `resource` allowlist（二次校验）。
10. nonce 插入与 `use_count + 1`。

失败直接返回：

```json
{ "type": "error", "code": "CAPABILITY_DENIED", "detail": "..." }
```

拒绝日志（网关 `acp_bridge`）建议落地以下决策字段，便于事后追踪：

- `delegation_id`、`scope_type`、`scope_id`
- `frame_type`、`action`、`resource`
- `request_session_id`（delegation 内声明）
- `resolved_session_id`、`resolved_session_status`
- `resolved_session_scope_type`、`resolved_session_scope_id`
- `session_locator_source`（`provider_session_key` / `provider_session_id` / `session_id`）
- `session_locator_value`

当前实现将上述字段在 `CAPABILITY_DENIED` 的结构化日志中完整输出。

## 6. API（管理端）

- `GET /api/v1/bots/:bot_id/capability-delegations`
- `POST /api/v1/bots/:bot_id/capability-delegations`
- `DELETE /api/v1/bots/:bot_id/capability-delegations/:delegation_id`

权限要求：
- bot owner（`bot_accounts.created_by`）
- 或系统管理员（`admin` / `system_admin`）

## 7. 与 E2EE 的关系

- 本能力鉴权不承担传输机密性。
- 可配合 `binding_config.acp_security` 的 E2EE 参数实现加密通道；能力签名可以先于加密层使用，作为“谁/能做什么”的权限闸门。

## 8. 部署建议（建议项）

- 建议对 connector 下发能力时要求：
  - 每帧都带 `provider_session_key`（或明确的 `session_id` / `provider_session_id`）
  - 让网关总是能在 session/workspace 场景走真实会话闭环。
- 后续如接入任务级审计，可把 `frame_type`、`delegation_id`、`session context` 一并落审计日志，支持回放和异常定位。
