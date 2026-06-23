# Bot 权限闭环完善方案：成员同构版

> 状态：实施方案草案
> 日期：2026-06-04
> 适用范围：Rust Gateway、Agent Bridge、ACP Connector、Frontend 审批 UI
> 配套：[AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) · [AGENT_BRIDGE_PROTOCOL](./AGENT_BRIDGE_PROTOCOL.md) · [ACP_CAPABILITY_DELEGATION](./ACP_CAPABILITY_DELEGATION.md) · [MCP_AGENT_SECURITY](./MCP_AGENT_SECURITY.md)

> ⚠️ **本文部分内容描述已被取代的模型（2026-06-23）。** 本文涉及的废弃概念：可写的 `memory` 资源 / 记忆层（`append`/`replace` 动词、role 表中的 “写 memory”、`memory handler`，对应已 DROP 的 `memory_entries`）。**现行模型**：无独立 memory 概念；文件是唯一基质；Context = 插件策展的文件；agent 一律 pull；授权唯 channel-role。权威声明见 [context-and-environment.md](./context-and-environment.md) 顶部的「⚠️ CURRENT MODEL (2026-06-23)」。本文的「不引入 `trust_level`/`bot_grants`、改用 channel-role」这一主张与现行模型一致，保留。

本文按新的设计方向重写 bot 权限闭环：

**bot 不需要独立的复杂 `trust_level` 权限模型。bot 应被当作频道里的普通成员主体，与人类用户共用同一套资源接口、同一套 membership/role/object-rule 权限判断。**

bot 与人的差异只在认证入口和运行期审批：

- 人类用户通过 JWT 进入 REST/WebSocket。
- bot 通过 bot token 进入 Agent Bridge control/data WebSocket。
- ACP connector 可额外使用 capability signature 证明 data frame 来自授权 session。
- 本地 agent 的敏感工具调用仍可通过 `permission_request` 走用户审批。

## 1. 结论

当前文档和部分代码把 bot 写权限设计成 bot 专属 Grant/RBAC：`bot_grants`、`trust_level`、默认 grant seed、按 trust 等级区分资源写。这条路会让 bot 和 user 的资源接口越来越分裂。

新的方向是：

1. **统一主体模型**：资源层只认识 `Principal { type: user | bot, id, role }`。
2. **统一资源接口**：同一个 domain handler 同时服务 user REST 和 bot resource_req。
3. **统一频道权限**：读写资源先看 `channel_memberships`，再看频道角色和对象级规则。
4. **取消 trust_level 默认授权矩阵**：不按 `system/trusted/standard/untrusted` 给 bot 发不同 grants。
5. **保留 Agent Bridge 安全门**：bot token、capability signature、session 状态用于证明“谁在调用”和“调用是否属于有效运行期”，不用于扩大资源权限。
6. **审批只处理运行期需要确认的动作**：审批卡用于本地 agent 工具确认、特殊破坏性操作确认，不是常规资源权限的替代品。

根因：之前的模型把“bot 是一个频道成员”扩展成了“bot 需要一套独立授权体系”。这会导致资源 handler 同时维护 user path 和 bot path，最终出现合同不一致。新的方向把权限根收回到 channel membership 和对象级规则，因此不需要 `trust_level` 兼容 shim。

## 2. 统一主体模型

资源层统一使用：

```rust
pub enum PrincipalType {
    User,
    Bot,
}

pub struct Principal {
    pub principal_type: PrincipalType,
    pub principal_id: Uuid,
    pub platform_role: String,
}
```

来源：

| 来源 | Principal |
|---|---|
| JWT REST 请求 | `Principal { type: User, id: claims.sub }` |
| Browser WS | `Principal { type: User, id: claims.sub }` |
| Agent Bridge data WS | `Principal { type: Bot, id: bot_id }` |
| Agent Bridge loopback/MCP | connector 持有 bot 身份，转成 `Principal::Bot` |

资源 handler 不应该知道“这是 REST 来的还是 Agent Bridge 来的”。它只接收 `Principal` 和参数。

### 2.1 认证凭证与权限分离

JWT 和 bot token 都只做身份认证，不直接表达资源权限：

| 主体 | 凭证 | 认证结果 | 资源权限来源 |
|---|---|---|---|
| user | JWT | `Principal::User(user_id)` | `channel_memberships` + role + 对象级规则 |
| bot | bot token | `Principal::Bot(bot_id)` | `channel_memberships` + role + 对象级规则 |

因此，bot token 应作为 bot 的唯一主身份凭证，但它不应携带或隐含“能读写哪些频道资源”的权限。Backend 验证 bot token 后只得到 `bot_id`，后续所有资源访问仍进入统一授权函数。

实现约束：

- bot token 是 opaque bearer secret，不建议做成可自解释权限 JWT。
- bot token 明文只在创建或 rotate 后显示一次，数据库只存 hash 和 prefix。
- bot token 不放 URL query，避免进入访问日志；control/data WS 第一帧 `auth` 或 `Authorization: Bearer` 均可，但应统一一种规范形态。
- bot token 只认证 bot 身份，不替代 `channel_memberships`。
- 已建立的 WebSocket 连接绑定 `bot_id` 后，后续 data frame 不需要重复携带 bot token。
- capability signature 是可选的运行期帧签名/防重放机制，不是第二套资源权限。
- 如果未来提供 bot-scoped HTTP resource API，也应由 bot token 或短期 bot access token 映射到 `Principal::Bot`，再走同一资源授权层。

## 3. 统一资源授权规则

### 3.1 频道成员检查

所有 channel 作用域资源都先查：

```sql
SELECT role
FROM channel_memberships
WHERE channel_id = $1
  AND member_id = $2
  AND member_type = $3;
```

`member_type` 为 `user` 或 `bot`。这已经是项目里的自然模型。

### 3.2 角色规则

建议统一频道角色：

> ⚠️ 下表中的 “写 ... memory” 是历史设计，已废弃 —— 现无独立 memory 资源，写入只走 `fs.*`（见 CURRENT MODEL）。

| Role | 读频道资源 | 发消息 | 上传文件 | 写 workspace fs / memory | 管理成员 |
|---|---:|---:|---:|---:|---:|
| `owner` | 是 | 是 | 是 | 是 | 是 |
| `admin` | 是 | 是 | 是 | 是 | 是 |
| `member` | 是 | 是 | 是 | 是，受对象级规则约束 | 否 |
| `readonly` | 是 | 否 | 否 | 否 | 否 |

如果需要限制某个 bot，不要引入 `trust_level`，而是把它在频道里的 role 设成 `readonly`，或通过频道级资源策略限制所有成员。

### 3.3 对象级规则

对象级规则对 user 和 bot 一样：

| 操作 | 对象级规则 |
|---|---|
| 读消息 | 必须是频道成员；deleted/secret 规则按消息类型处理 |
| 发消息 | 必须是频道成员且 role 可写 |
| 上传文件 | 必须是频道成员且 role 可写 |
| 删除文件 | 上传者、owner/admin，或资源策略允许 |
| 写 `fs.*` | 频道成员且 role 可写；path 合法；版本乐观锁通过 |
| 写 memory | 频道成员且 role 可写；`replace` 可要求二次确认 ⚠️ 历史设计，已废弃 —— `memory` 资源不存在，统一走 `fs.*`（见 CURRENT MODEL） |
| 管理成员 | owner/admin |
| 管理 bot token / connector | bot owner 或系统 admin，这是账号管理，不是频道资源 |

这样 user 和 bot 的资源接口是同构的：同一资源、同一参数、同一权限函数。

## 4. 资源接口形态

目标是把 REST 和 Agent Bridge resource_req 都收敛到同一 domain service。

```
User REST
  -> JWT auth
  -> Principal::User
  -> resource/domain service

Bot resource_req
  -> Agent Bridge token auth
  -> optional capability signature
  -> Principal::Bot
  -> resource/domain service
```

示例：

```rust
pub async fn create_channel_message(
    db: &PgPool,
    principal: Principal,
    channel_id: Uuid,
    input: CreateMessageInput,
) -> Result<MessageDto, AppError> {
    let membership = authorize_channel_write(db, &principal, channel_id).await?;
    validate_message_input(&input)?;
    insert_message(db, principal, membership, channel_id, input).await
}
```

REST 和 bot 都调用它：

```rust
// REST
create_channel_message(db, Principal::user(claims), channel_id, input).await

// Agent Bridge resource_req
create_channel_message(db, Principal::bot(bot_id), channel_id, input).await
```

## 5. Agent Bridge 仍然需要的安全门

把 bot 当普通成员不等于放弃 Agent Bridge 安全。

Agent Bridge 仍有三道入口门：

| 门 | 作用 | 是否影响资源权限 |
|---|---|---|
| bot token | 证明这条 WS 属于某个 bot | 只映射出 `Principal::Bot(bot_id)` |
| control/data session binding | 防止 control/data token 不一致或连接被替换 | 不扩大权限 |
| capability signature | 证明 data frame 来自授权 connector/session，防重放 | 不扩大权限 |

通过这三道门后，资源权限仍按 `Principal::Bot + channel_memberships` 判断。

```
data frame
  -> bot token 已绑定 bot_id
  -> require_capability=true 时验签、nonce、session 状态
  -> Principal::Bot(bot_id)
  -> 同 user 一样进入 resource/domain service
```

## 6. 审批闭环

审批仍需要，但它不应该替代普通资源权限。

### 6.1 审批适用场景

| 场景 | 是否需要审批 | 说明 |
|---|---:|---|
| 普通发消息 | 否 | 频道 role 可写即可 |
| 普通上传文件 | 否 | 频道 role 可写即可 |
| `fs.write/edit/append` | 可选 | 如果产品上认为 agent workspace 写入需要用户确认 |
| `fs.rm/mv` | 建议 | 破坏性操作建议确认 |
| memory `append` | 可选 | 可由频道策略决定 ⚠️ 历史设计，已废弃 —— 无 memory 动词，见 CURRENT MODEL |
| memory `replace` | 建议 | 替换整个记忆层风险较高 ⚠️ 历史设计，已废弃 —— “记忆层” 概念已取消，文件是唯一基质，见 CURRENT MODEL |
| 本地 agent 读写本机文件/执行命令 | 是 | 这是本地 agent 权限，不是平台资源权限 |
| bot token rotate/revoke | 是账号管理操作 | 走 owner/admin API，不走频道审批 |

### 6.2 审批请求表

建议新增 `agent_permission_requests`，用于持久化运行期审批：

```sql
CREATE TABLE IF NOT EXISTS agent_permission_requests (
    request_id           VARCHAR(36) PRIMARY KEY,
    approval_msg_id      VARCHAR(36) NOT NULL REFERENCES messages(msg_id) ON DELETE CASCADE,
    requester_type       TEXT NOT NULL,       -- user | bot
    requester_id         VARCHAR(36) NOT NULL,
    channel_id           VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    task_id              VARCHAR(36),
    session_id           VARCHAR(36),
    provider_session_key TEXT,
    provider_session_id  TEXT,
    source               TEXT NOT NULL,       -- platform_action | agent_runtime
    resource             TEXT,
    action               TEXT,
    tool                 TEXT,
    title                TEXT NOT NULL,
    body                 TEXT NOT NULL,
    options              JSONB NOT NULL DEFAULT '[]'::jsonb,
    status               TEXT NOT NULL DEFAULT 'pending',
    requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at           TIMESTAMPTZ,
    resolved_by          VARCHAR(36),
    resolved_at          TIMESTAMPTZ,
    resolution           TEXT,
    option_id            TEXT,
    resolution_payload   JSONB,
    delivery_status      TEXT NOT NULL DEFAULT 'pending',
    CONSTRAINT chk_agent_permission_requests_requester_type
        CHECK (requester_type IN ('user', 'bot')),
    CONSTRAINT chk_agent_permission_requests_source
        CHECK (source IN ('platform_action', 'agent_runtime')),
    CONSTRAINT chk_agent_permission_requests_status
        CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
    CONSTRAINT chk_agent_permission_requests_delivery
        CHECK (delivery_status IN ('pending', 'delivered', 'failed'))
);
```

按 sqlx 迁移纪律，应新增 `0009_agent_permission_requests.sql`，不要修改已存在迁移正文。

### 6.3 创建审批请求

Agent runtime 发起：

1. ACP agent 调 `session/request_permission`。
2. connector 转成 Agent Bridge `permission_request`。
3. Backend 以 `Principal::Bot(bot_id)` 校验频道成员关系。
4. 插入 `agent_permission_requests`。
5. 插入 `messages`，`msg_type='permission'`。
6. fanout 给频道。
7. 返回 `send_ack` 给 connector。

平台动作发起：

1. domain service 判断当前操作需要二次确认。
2. 创建 `source='platform_action'` 的审批请求。
3. 当前操作暂停、返回 `PENDING_APPROVAL`，或 bounded wait。
4. 用户批准后，重试或继续执行原动作。

### 6.4 Resolve API

新增：

```http
POST /api/v1/channels/:channel_id/permission-requests/:request_id/resolve
```

请求：

```json
{
  "option_id": "allow",
  "resolution": "allow"
}
```

处理：

1. `SELECT ... FOR UPDATE` 读取 pending request。
2. 校验 resolver 是频道成员，且满足请求所需角色。
3. 更新 request 状态与 approval message 的 `content_data.resolved=true`。
4. 写审计日志。
5. 如果来源是 `agent_runtime`，通过 control stream 下发 `permission_resolution`。
6. fanout 更新后的 permission message。

connector 离线时，`permission_resolution` 不应丢失。保留 `delivery_status='pending'`，重连 hello 时重放，connector ack 后标记 `delivered`。

## 7. 生命周期闭环

### 7.1 Bot 创建

创建 bot 只建立账号和认证材料，不签发资源权限：

1. 插入 `bot_accounts`。
2. 生成并 hash `bot_token`，明文只返回一次。
3. 记录 `created_by`，用于 bot owner 管理 token、connector 配置、capability delegation。
4. 写审计日志 `bot.created`。

不再需要：

- `trust_level`
- `approval_mode`
- `seed_global_bot_grants()`

如果数据库里已存在这些列，可以暂时保留为 deprecated，不参与权限判断。

### 7.2 Bot 加入频道

加入频道与用户加入频道一致：

1. 校验操作者可管理成员。
2. 插入 `channel_memberships`：

```sql
INSERT INTO channel_memberships (
    channel_id, member_id, member_type, role, added_by
) VALUES (
    $1, $2, 'bot', $3, $4
);
```

3. 若 bot 在线，下发 `channel_joined`，更新 connector membership cache。
4. 写审计日志 `channel.member_added`。

不再签发 channel grants。

### 7.3 Bot 离开频道

离开频道与用户离开频道一致：

1. 删除或失效 `channel_memberships`。
2. 该频道下 bot 后续所有 resource 调用因 membership 缺失而失败。
3. 停止或标记该频道相关 active/busy session。
4. 若 bot 在线，下发 `channel_left` 和必要的 `cancel`。
5. 写审计日志 `channel.member_removed`。

不需要吊销 channel grants，因为不再依赖 channel grants 表达频道资源权限。

### 7.4 Bot 禁用、token 轮换、账号删除

- 禁用 bot：拒绝新 WS auth，关闭现有 Agent Bridge 连接，active/busy session 标记 `revoked`。
- token rotate：旧 token hash 失效，新 token 明文只返回一次，旧连接关闭。
- token revoke：bot 无法再建立 Agent Bridge 连接，但历史消息和审计保留。
- 删除 bot：删除账号、membership、pending runtime requests；审计日志保留。

## 8. 资源权限函数

建议新增统一授权 helper：

```rust
pub async fn authorize_channel_read(
    db: &PgPool,
    principal: &Principal,
    channel_id: Uuid,
) -> Result<ChannelMembership, AppError>;

pub async fn authorize_channel_write(
    db: &PgPool,
    principal: &Principal,
    channel_id: Uuid,
) -> Result<ChannelMembership, AppError>;

pub async fn authorize_channel_admin(
    db: &PgPool,
    principal: &Principal,
    channel_id: Uuid,
) -> Result<ChannelMembership, AppError>;
```

这些函数统一处理 `user` 和 `bot`：

```rust
WHERE channel_id = $1
  AND member_id = $2
  AND member_type = $3
```

然后根据 role 判断能力。

现有 `check_bot_in_channel()` 应收敛为：

```rust
check_principal_in_channel(db, &principal, channel_id)
```

现有 `check_write_permission()` 不应再查询 `bot_grants`，而应调用：

```rust
authorize_channel_write(db, &Principal::bot(bot_id), channel_id)
```

## 9. 管理 API

### 9.1 成员管理

bot 和 user 使用同一成员接口：

```http
GET    /api/v1/channels/:channel_id/members
POST   /api/v1/channels/:channel_id/members
DELETE /api/v1/channels/:channel_id/members/:member_id
PATCH  /api/v1/channels/:channel_id/members/:member_id
```

`POST/PATCH` body：

```json
{
  "member_id": "...",
  "member_type": "bot",
  "role": "member"
}
```

### 9.2 Bot 账号管理

bot 账号管理仍是单独 API，因为它处理认证材料和 connector 配置，不是频道资源：

```http
GET    /api/v1/bots
POST   /api/v1/bots
PATCH  /api/v1/bots/:bot_id
DELETE /api/v1/bots/:bot_id
POST   /api/v1/bots/:bot_id/token/rotate
POST   /api/v1/bots/:bot_id/token/revoke
```

权限：

- bot owner
- system admin

### 9.3 Capability delegation

Capability delegation 继续保留：

```http
GET    /api/v1/bots/:bot_id/capability-delegations
POST   /api/v1/bots/:bot_id/capability-delegations
DELETE /api/v1/bots/:bot_id/capability-delegations/:delegation_id
```

它只控制 Agent Bridge data frame 签名，不控制频道资源权限。

### 9.4 不再需要的 API

不新增：

```http
GET    /api/v1/bots/:bot_id/grants
POST   /api/v1/bots/:bot_id/grants
PATCH  /api/v1/bots/:bot_id/grants/:code
DELETE /api/v1/bots/:bot_id/grants/:code
```

频道资源权限由 membership role 表达。保留 `bot_grants` 只会让权限来源变成两套。

## 10. 前端闭环

### 10.1 频道成员页

同一个成员列表展示 user 和 bot：

- 名称、头像、`member_type`
- role：owner/admin/member/readonly
- 在线状态
- bot 的 connector status 可作为附加状态显示

调整 bot 权限时，改的是它在频道中的 role，而不是 trust level。

### 10.2 Bot 管理页

Bot 管理页只处理账号和连接：

- status
- binding_type / bridge_provider
- token rotate/revoke
- connector config
- capability delegations
- capability reject logs
- joined channels 列表

不展示 trust level 和 grants。

### 10.3 聊天审批卡

`permission` 消息应渲染为审批卡，而不是系统横线文本：

- title/body
- 请求者：user 或 bot
- tool/resource/action
- options
- pending/resolved 状态
- resolve 按钮

## 11. 审计

建议新增通用成员/资源审计，而不是 bot grant 审计：

```sql
CREATE TABLE IF NOT EXISTS resource_audit_logs (
    log_id          VARCHAR(36) PRIMARY KEY,
    principal_type  TEXT NOT NULL,     -- user | bot
    principal_id    VARCHAR(36) NOT NULL,
    channel_id      VARCHAR(36),
    session_id      VARCHAR(36),
    event_type      TEXT NOT NULL,
    resource        TEXT,
    action          TEXT,
    decision        TEXT NOT NULL,     -- allow | deny | pending | cancelled
    reason          TEXT,
    request_id      VARCHAR(36),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_resource_audit_principal_type
        CHECK (principal_type IN ('user', 'bot'))
);
```

必须记录：

- `resource.read.allowed`
- `resource.read.denied`
- `resource.write.allowed`
- `resource.write.denied`
- `permission.requested`
- `permission.resolved.allow`
- `permission.resolved.deny`
- `channel.member_added`
- `channel.member_removed`
- `bot.token.rotated`
- `bot.token.revoked`
- capability deny 仍写已有 `acp_capability_reject_logs`

## 12. 实施顺序

### Phase 0：文档与契约对齐

- `BOT_PERMISSION.md` 中的 `trust_level` 默认授权矩阵降级为历史方案或删除。
- `AGENT_BRIDGE_RESOURCE.md` 改成 principal/member 权限模型。
- 明确 user REST 与 bot `resource_req` 共享 domain service。

### Phase 1：Principal 授权层

- 新增 `Principal` 类型。
- 新增 `authorize_channel_read/write/admin()`。
- 将 `check_bot_in_channel()` 改成 `check_principal_in_channel()`。
- 将 `check_write_permission()` 从 `bot_grants` 改成 membership role 判断。

### Phase 2：资源接口合流

- REST message/file/fs/memory handler 与 Agent Bridge resource handler 复用同一 domain service。（⚠️ `memory` handler 已废弃 —— 只剩 message/file/`fs.*`，见 CURRENT MODEL）
- `send` 帧和 `channel.messages.create` 走同一 `create_channel_message()`。
- `fs.*` user/bot 走同一 path 校验、版本锁、operation log。

### Phase 3：审批持久化

- 新增 `0009_agent_permission_requests.sql`。
- Agent Bridge `permission_request` 写请求表。
- 新增 resolve API。
- `permission_resolution` 支持离线 pending 和重连重放。

### Phase 4：前端

- 频道成员页支持 user/bot 同构 role 管理。
- Bot 管理页移除 trust level/grants，聚焦账号连接。
- `MessageItem` 增加 `PermissionRequestCard`。

### Phase 5：审计与测试

- 新增 `resource_audit_logs`。
- ops 页面聚合 resource deny、pending approvals、capability reject。
- 增加 Principal 授权测试。

## 13. 测试与验收

### 13.1 单元测试

- `authorize_channel_read()` 对 user/bot 都按 membership 放行。
- `authorize_channel_write()` 对 `readonly` 拒绝，对 `member/admin/owner` 放行。
- admin/owner 可管理成员，member 不可管理成员。
- bot token 只影响 Agent Bridge 身份，不影响资源权限。
- capability 通过但 bot 不在频道时仍返回 `NOT_MEMBER`。

### 13.2 API 测试

- user 和 bot 读取同一 channel resource 返回同结构数据。
- user 和 bot 发消息走同一 domain service。
- bot role 改成 `readonly` 后，发消息/写 fs 被拒绝。
- bot 离开频道后，读写均返回 `NOT_MEMBER`。
- `send` 帧和 `channel.messages.create` 权限行为一致。

### 13.3 WebSocket/Connector 测试

- `require_capability=true` 时，无签名 data frame 被拒绝并写 reject log。
- capability 通过后，resource 权限仍由 membership role 决定。
- connector 发 `permission_request` 后收到 `send_ack`。
- 用户 resolve 后 connector 收到 `permission_resolution`。
- connector 离线时 resolution 不丢，重连后收到 pending resolution。

### 13.4 前端验收

- 频道成员列表同时显示 user 和 bot。
- 可以给 bot 设置 `member` 或 `readonly`。
- `permission` 消息显示为审批卡。
- Bot 管理页不再展示 trust level/grants。

### 13.5 迁移验收

如涉及新迁移，遵守 sqlx 纪律：

```bash
cd server && cargo build && cargo test
```

涉及 gateway schema 后：

```bash
docker compose build --no-cache gateway
docker compose up -d --force-recreate --no-deps gateway
```

新增迁移使用下一个顺序号，不修改已应用迁移正文。

## 14. 完成标准

权限闭环完成后，应满足：

- bot 在资源层与 user 一样是 channel member。
- 所有 channel resource handler 接收 `Principal`，不分 user-only 或 bot-only 路径。
- bot 的频道资源权限由 `channel_memberships.role` 和对象级规则决定。
- 不再需要 `trust_level`、默认 grant seed、channel grant 吊销这些 bot 专属流程。
- Agent Bridge token/capability 只证明身份和运行期有效性，不扩大资源权限。
- 审批请求持久化，前端可处理，connector 可收到可靠的 `permission_resolution`。
- 审计日志能统一记录 user 和 bot 的资源访问决策。
