# ACP 单次操作审批流（Per-operation Approval）

> 版本：v1.0（2026-06-25，M-permissions / M3 之后）
> 分支：`feat/m3-hardening`
> 配套：[BOT_PERMISSION](./BOT_PERMISSION.md) · [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) · [ACP_INTEGRATION](./ACP_INTEGRATION.md)

本文定义 **ACP agent 在执行中遇到敏感工具调用（跑命令 / 写本地文件 / 删除…）时，
向频道发起一次性审批、由人裁决、回灌给 agent** 的完整链路。

> **与 [BOT_PERMISSION](./BOT_PERMISSION.md) 的关系（务必分清两个「审批」）**：
> - BOT_PERMISSION §9 的审批流是给 **Grant 签发**用的——而 Grant/trust_level 整套**已搁置**（channel-role 唯一事实源）。
> - 本文是 **ACP 单次操作审批**：一次一议、不签发 Grant、不进 `bot_grants` 表。它管的是
>   **bot owner 本地机器上的工具调用**（`local:*`，按 BOT_PERMISSION §12 归 daemon/agent 管），
>   平台只做**路由 + 谁能裁决 + 审计**。
> 两者**不复用同一套引擎**，只复用「审批卡片」这一 UX 词汇。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 默认裁决人 | **仅 bot owner** | 操作执行在 owner 的本地机器，爆炸半径归他 |
| 频道成员 | **可见**审批卡 + **可申请**裁决权 | 透明 + 可用性，但看见 ≠ 能批 |
| 授权管理 | bot owner **随时签发 / 收回** 裁决权（委托） | owner 是机器主人，掌控委托 |
| 「记住决定」 | `allow_always`/`reject_always` 由 **agent 自己记**，平台不持久化 | 贴合 ACP；本地决策归 daemon/agent（§12） |
| 审计 | 每一次**裁决 / 申请 / 授权 / 收回 / 超时**都落 `approval_audit`（append-only） | **本特性的核心**：可追溯即威慑 |
| 委托存储 | 独立轻量表 `approval_delegations`，**不复用 `bot_grants`** | 不复活已搁置的 Grant 引擎 |

---

## 1. ACP 协议：三套枚举（实现的事实来源）

`session/request_permission` 请求经 connector 转发（`acp_adapter.rs:603`），落到三套**互不相同**的枚举：

### 1.1 PermissionOptionKind —— 用户「点什么」（4 种）

agent 在 `params.options[].kind` 里发来，connector **原样透传**（`acp_adapter.rs:451`），到达网关
`content_data.options`：

| kind | 含义 | 「记住」归属 |
|---|---|---|
| `allow_once` | 仅此次允许 | — |
| `allow_always` | 始终允许（本 session / 此工具） | **agent 端**，平台不存 |
| `reject_once` | 仅此次拒绝 | — |
| `reject_always` | 始终拒绝 | **agent 端**，平台不存 |

> 选项集合**不硬编码**：agent 发几个就渲染几个；`name` 用 agent 给的；`kind` 用于归类成
> allow / reject 两族（`prompt.rs:194` `permission_option_id_for_resolution` 用 `kind.starts_with`）。

### 1.2 RequestPermissionOutcome —— connector「回什么」（2 种）

connector 只能回这两个（`runtime_adapter.rs:44` `to_acp_value`）：

| outcome | 语义 |
|---|---|
| `selected { optionId }` | 用户选了某选项——**allow 与 reject 都走这个！** |
| `cancelled` | 回合被**取消**（超时 / 用户取消）——**不等于「拒绝」** |

> **关键纠偏**：`reject_*` 必须回 `selected{ 该 reject 选项的 optionId }`，**不是** `cancelled`。
> `cancelled` = 整轮中止；`reject_once` = 只否这一个工具调用、agent 可换路。
> 详见 §6「连接器 bug 纠偏」。

### 1.3 ToolKind —— 「在批什么」（用于风险展示）

`params.toolCall.kind`：`read / edit / delete / move / search / execute / fetch / think / other`。
卡片应展示 `toolCall.kind` + 关键 `rawInput`（命令 / 路径），`execute`/`delete`/`move` 标红高危。
当前 `permission_body_from_params`（`prompt.rs:178`）只取了 tool name —— UI 侧用 `content_data` 补全。

---

## 2. 角色与裁决人集合

```
裁决人集合(bot, channel) = { bot owner } ∪ { (bot,channel) 的有效 approval_delegations }
```

- **bot owner**：`bot_accounts.owner_id`（网关已带进 `content_data.bot_owner_id`，`agent_bridge.rs:776`）。永远可裁决、可管理委托。
- **被委托人**：bot owner 经 `grant_approver` 加入；`revoke_approver` 移除（随时）。
- **其余频道成员**：只读卡片 + 可 `request_access` 申请裁决权。
- **频道 admin/owner**：v1 **不**自动成为裁决人（本模型以 bot owner 为权威；如需 break-glass 再加）。

> 看见 ≠ 能批：审批卡 `broadcast_channel` 给全频道（`agent_bridge.rs:831`，透明 / 审计），
> 但 `resolve` 在服务端校验调用者 ∈ 裁决人集合。

---

## 3. 端到端时序

```
1. ACP agent 触发 session/request_permission
     connector handle_permission_request (permission.rs:10)
       · auto_allow 本地策略命中 → 直接 Selected（不打扰频道）
       · 否则 forward_to_backend → 发 PermissionRequest 帧 + 起 wait_timeout
2. 网关 handle_permission_request_frame (agent_bridge.rs:733)
       · 落库 messages(msg_type='permission', content_data{options,bot_owner_id,request_id,...})
       · broadcast_channel 给全频道（看得见）
       · send_ack_ok（异步，不带 resolution）
3. 前端渲染交互卡（§5）
       · 裁决人 → 显示按钮（按 option kind）
       · 非裁决人 → 只读 + 「申请裁决权」
4. 裁决人点击 → POST .../resolve { option_id }
       · 服务端 is_approver 校验
       · audit('resolved', decision=kind, option_id, actor)
       · 更新 permission 消息 content_data{resolved:true, resolved_by, resolved_at, chosen}
       · 经 locator 发 control 帧 permission_resolution 给 bot
       · broadcast 更新后的卡片（全频道看到「✅ 由 @x 批准」）
5. connector ControlInbound::PermissionResolution (mod.rs:307)
       → handle_permission_resolution → Selected{optionId} → ACP（§6 修正后）
6. allow_always / reject_always 的「记住」：agent 自己留，平台不持久化
超时/取消：connector wait_timeout → Cancelled（permission.rs:161）
           + 网关补一条终态卡片「⏱ 审批超时，已自动拒绝」+ audit('timeout')
```

---

## 4. 存储 Schema（migration 0019）

```sql
-- 裁决权委托：bot owner 把「裁决某 bot 在某频道的审批」的权力委托给某用户。
-- 当前态表（可吊销）；历史在 approval_audit。
CREATE TABLE approval_delegations (
    id          VARCHAR(36) PRIMARY KEY,
    bot_id      VARCHAR(36) NOT NULL,
    channel_id  VARCHAR(36) NOT NULL,
    user_id     VARCHAR(36) NOT NULL,        -- 被委托的裁决人
    granted_by  VARCHAR(36) NOT NULL,        -- bot owner
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,                 -- NULL = 有效
    revoked_by  VARCHAR(36),
    UNIQUE (bot_id, channel_id, user_id)     -- 一三元组一行；重新授权 = 清空 revoked_at
);
CREATE INDEX idx_deleg_active ON approval_delegations (bot_id, channel_id)
  WHERE revoked_at IS NULL;

-- 审批审计：append-only，本特性核心。
CREATE TABLE approval_audit (
    id             VARCHAR(36) PRIMARY KEY,
    event_type     VARCHAR(32) NOT NULL,     -- resolved|access_requested|access_granted|access_revoked|timeout
    bot_id         VARCHAR(36),
    channel_id     VARCHAR(36) NOT NULL,
    request_id     VARCHAR(64),              -- ACP permission request_id（resolved/timeout）
    msg_id         VARCHAR(36),              -- 审批消息
    actor_id       VARCHAR(36),              -- 谁做的（裁决人/申请人/owner）
    target_user_id VARCHAR(36),             -- access_* 的对象用户
    decision       VARCHAR(32),              -- resolved: allow_once|allow_always|reject_once|reject_always
    option_id      VARCHAR(128),
    detail         JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_channel ON approval_audit (channel_id, created_at DESC);
```

> VARCHAR(36) id + 运行时 `query_as`/`Row`，与全仓现状一致（R12 UUID 列迁移未做）。

---

## 5. REST 契约

所有路由在 authed 组（带 `Claims`）。`{cid}` = channel_id，`{bid}` = bot_id。

| 方法 + 路径 | 谁可调用 | 作用 |
|---|---|---|
| `POST /channels/{cid}/permissions/{request_id}/resolve` `{ option_id }` | **裁决人** | 裁决：校验 → audit → 更新卡片 → 发 resolution 给 bot |
| `POST /channels/{cid}/permissions/{request_id}/request-access` | 任意频道成员 | 申请裁决权：audit('access_requested') + 通知 owner |
| `GET  /bots/{bid}/approvers?channel_id={cid}` | 频道成员 | 列出有效委托 |
| `POST /bots/{bid}/approvers` `{ channel_id, user_id }` | **bot owner** | 授予裁决权（upsert，清 revoked_at）+ audit |
| `DELETE /bots/{bid}/approvers/{user_id}?channel_id={cid}` | **bot owner** | 收回裁决权 + audit |
| `GET  /channels/{cid}/permissions/audit?limit=` | 频道成员 | 读审计日志 |

错误：`403`（非裁决人 / 非 owner）、`404`（无此 request_id 的 pending 卡 / 无此 bot）、`409`（已被裁决）。

---

## 6. 连接器 bug 纠偏（必做）

`bridge_runtime/permission.rs:199-208` 现状：
```rust
let outcome = if resolution.resolution == "allow" {
    ... Selected{option_id} ...
} else {
    PermissionOutcome::Cancelled   // ← reject 被塌成 cancelled，语义错
};
```
**修正**：优先用 `option_id`——只要带了 `option_id` 就 `Selected{option_id}`（allow / reject 同处理）；
仅当无 option 且 resolution 表示取消时才 `Cancelled`。网关 `resolve` 始终回传所选 `option_id`。

---

## 7. 安全边界回顾（defense in depth）

平台层的「裁决人集合」是**第二道门，不是唯一的门**（BOT_PERMISSION §12）：

1. **daemon（bot owner 本地）**：目录/命令白名单、`auto_allow`/`forward_to_backend` 策略——平台改不了。
   owner 选择 `forward_to_backend` 本身就是「授权频道里的人替我决定」的显式委托。
2. **平台裁决人集合**（本文）：谁能点 allow/reject。
3. **审计**：谁批了什么、谁授/收了权——全留痕，可追溯即威慑。

---

## 8.5 会话模式 / 模型：ACP 原生 session-state（mode & model）

agent 是否「会问权限」由 **ACP session mode** 决定，与模型选择是**对称的一等机制**：

| | 权限/操作模式 | 模型 |
|---|---|---|
| 发现（session/new 返回） | `modes: { currentModeId, availableModes[] }` | `models: { currentModelId, availableModels[] }` |
| 切换 | `session/set_mode { sessionId, modeId }` | `session/set_model { sessionId, modelId }` |
| 通知（session/update） | `current_mode_update` | `current_model_update` |

claude-code-acp 的 `availableModes` 常见为 `default`(放行白名单、其余询问) / `acceptEdits` / `bypassPermissions` / `plan`。

### 临时方案（已落地）
连接器 `adapter.permission_mode`（toml）→ 在 `new_session`/`load_session` 后调
`session/set_mode`（best-effort，未知 modeId 仅告警）。让你现在就能强制 agent 的模式
（`acp_adapter.rs::apply_permission_mode`）。

### 真正的方案（待做）：mode & model 作为平台 bot config
- bot config（binding_config）持 `default_mode` + `default_model`。
- 连接器读 session/new 的 `availableModes/Models` → 上报平台 → bot 设置 UI 渲染下拉。
- 按 bot 配置的默认值经 `set_mode`/`set_model` 应用；监听 `current_*_update` 回写。
- 概念锁定：**mode/model 是 bot 的设置项**，运行时落为 ACP session-state，平台不硬编码选项。

> 这与本审批流正交但相邻：mode 决定「**是否产生**审批请求」，本文其余部分决定「**谁能裁决**」。

---

## 8. 实现落点（file:line 索引）

| 关注点 | 位置 |
|---|---|
| ACP 请求转发 | `packages/.../acp_adapter.rs:595` `handle_peer_request` |
| 选项透传 | `acp_adapter.rs:435` `permission_options` |
| outcome 序列化 | `runtime_adapter.rs:44` `to_acp_value` |
| 连接器审批入口 | `bridge_runtime/permission.rs:10` |
| 连接器裁决回灌（**待修**） | `bridge_runtime/permission.rs:186` |
| 控制帧入口 | `bridge_runtime/mod.rs:307` `ControlInbound::PermissionResolution` |
| 裁决契约 | `bridge.rs:587` `PermissionResolution`（已含 option_id/resolved_by/resolved_at） |
| 网关审批落库+广播 | `server/.../agent_bridge.rs:733` `handle_permission_request_frame` |
| 网关 send_ack（异步） | `agent_bridge.rs:547` |
| 发控制帧给 bot | `gateway/registry.rs:15` `BotLocator::dispatch_task` |
| 裁决/委托逻辑（**新增**） | `server/src/domain/approval.rs` |
| REST handler（**新增**） | `server/src/api/approval.rs` |
| 前端卡片（**新增**） | `frontend/src/features/chat/PermissionCard.tsx` |
</content>
</invoke>
