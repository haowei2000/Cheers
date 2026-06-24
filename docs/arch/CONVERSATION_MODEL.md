# 会话与工作区模型（决策 2026-06-24）

> 状态：已拍板，分片实施中。关联：[ROADMAP](./ROADMAP.md) M2 · [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md)

## 一句话

**会话只有一个原语：channel。** `channel.type ∈ {public, private, dm}`。没有 topic（线程）这一层，也不为 DM 建平行子系统——DM 就是一个 `type='dm'` 的两人 channel。

## 1. 单一会话原语

一段会话 = **成员 + 一条消息时间线 + 文件 + bot 会话**。这四样全部 keyed by `channel_id`（`channel_seq`、`channel_memberships`、`context_files`、`cheers_sessions`、`channel.*` resource）。public / private / dm 只是 `channel.type` 的取值，**共享同一套机制**。

- **删 topic**：会话层级从 `workspace → channel → topic → message` 塌缩为 `workspace → channel → message`。topic 不是字段，是每条 scope 轴上多出的一层；删了它，「按 channel 还是 topic」的追问一律只有一个答案：channel。
- **DM 不另起炉灶**：messages / seq / 成员 / 文件 / 工作台 / sessions / `channel.*` 全部直接复用 channel 机器。

## 2. DM = dm-typed channel

| 维度 | 做法 |
|---|---|
| 存储 | `channels.type='dm'`（已有该列）；无独立 dm 表 |
| 成员 | 两人（user+user 或 user+bot），建时固定，皆 peer |
| 归属 | `workspace_id` = **发起方的 personal workspace**（仅作 FK 锚点，见 §3） |
| 唯一性 | `find-or-create`：按「成员对规范键」（排序后的 member ids）查重，已存在则复用 |
| 命名 | `channel.name` 可空，前端按对方成员派生 |
| 访问 / 列表 | **由 `channel_memberships` 驱动，与 workspace 无关**（见 §3 铁律） |

## 3. 工作区两类 + 一条铁律

- **team workspace**：共享空间，`workspaces.kind = 'team'`（已有列），`owner_user_id = NULL`。
- **personal workspace**：每用户一个，`kind = 'personal'` + `owner_user_id = 自己`。一身两职：① 用户私人空间（self-notes / 个人文件，即 FILE_STORAGE 的 `personal` scope）；② DM 的 FK 锚点。
  - **惰性创建**：当前没有用户注册端点（用户经 seed/admin 建），所以 personal ws 用 `get_or_create_personal_workspace(user_id)` 在**首次用到时**创建（首个 DM / 首次个人内容），天然兼容存量用户。`(owner_user_id) WHERE kind='personal'` 偏唯一索引保证每人至多一个。

> **铁律：频道访问与边栏列表只看 `channel_memberships`，不看 workspace 成员。**
> 这是「DM 锚在某人 personal workspace 却人人能进」成立的前提：`workspace_id` 对 DM 只是满足 FK 的锚点，不驱动访问。user↔user 的 DM 锚在发起方 personal ws，这个不对称对用户不可见。

## 4. 会话 scope 精简（session_bindings）

`cheers_session_bindings` 曾把 scope 冗余投影成 `channel_id / topic_id / dm_id / task_id` 四列（与规范键 `(scope_type, scope_id)` 重复）：

- `topic_id` — 已删（migration 0013，随 topic 移除）。
- `dm_id` — 删（migration 0014）：DM 既是 channel，DM 会话的 scope 就是 `channel`/dm-channel 的 id，`dm` scope_type **折进 `channel`**。投影列只留 **`channel_id` + `task_id`**。
- scope_type 现有：`channel`（含 dm）/ `task` / `workspace` / `global` / `user`。

## 5. 永远别建（topic 连带省掉的）

- ❌ topic 成员表 / topic 级 capability scope
- ❌ `topic.*` resource 动词
- ❌ 线程 UI（TopicPage / ChatTopicOverlay / TopicComposer）
- ❌ per-topic 消息序（只有一条 `channel_seq`）
- ❌ topic 上下文注入提示词
- ❌ 平行 DM 栈（`api/v1/dms/` 那种）——DM 复用 channel

## 6. 落地分片

1. **dm scope 折叠**（本决策已实施）：sessions.rs 去 `dm` scope_type、`scope_columns` 投影减到 channel_id+task_id；migration 0014 drop `dm_id`。
2. **personal workspace**：`workspaces` 加 `owner_user_id`（复用已有 `kind`）+ 偏唯一索引；`get_or_create_personal_workspace` 惰性创建。
3. **DM find-or-create + 列表**：`POST /channels/dm`（按成员对查重，锚发起方 personal ws，type='dm'，两人成员）；`GET /channels?type=dm`。
