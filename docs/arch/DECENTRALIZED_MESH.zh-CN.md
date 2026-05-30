# 去中心化 Bot 网格

> **状态**：设计（v1）· **定稿**：2026-05-30 · **语言**：中文镜像（[English](./DECENTRALIZED_MESH.md)，以英文为准）
>
> 本文记录用去中心化 bot 网格替代中央 coordinator 的设计、每频道事件时钟（`channel_seq`）、
> 两类资源的一致性模型、频道操作日志、Bot@Bot 任务链与取消、以及可选的失控预算。
>
> 这是**先于代码的设计意图**。它扩展了
> [context-and-environment.md](./context-and-environment.md)（两类文件模型是本文基础）与
> [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md)。实现前请对照 `gateway/src/` 核验——
> 大部分是净新增或填补明确的 Phase 1 占位（见 §10）。

---

## 1. 为什么：去掉调度层

现有内置 `Coordinator` 用 LLM agent **猜**哪个 bot 该回复，路由非确定、难测试。网格用一条
确定性协议规则替代它：**频道只转发 `@`**。

- 无调度层。频道做 `@entity → 转发给该用户/bot`。
- 所有 bot 同级；内置 == 外置，走同一 Agent Bridge。移除 `Coordinator` 路由特权与 `AutoTakeoverStage`。
- `trust_level` 仍有区别（内置 `system` vs 外置），但只影响**写 Grant**，不影响路由。

这让 Bot@Bot 组合透明（每一跳都是可见的频道消息），路由变成确定性的 `@mention → bot_id` 查表。

---

## 2. 调度模型

```
消息到达
  ├─ 含 @bot → 派发给该 bot   （单纯 @user 仅是通知）
  └─ 无 @bot → 查 channel.default_bot_id
                 ├─ 已配 → 派发
                 └─ 未配 → 静默（消息照常落库，不触发任何 bot）

bot 回复（含 @botB）→ 作为普通消息落库 → 触发 botB
```

派发逻辑退化为 O(1) 查表，链路中无 AI。

**决策：**
- 无 `@` 且无默认 bot → **静默**（消息仍被记录）。
- 所有 `@` 消息在频道里**可见**。
- Bot@Bot **无深度上限**（链 + 取消见 §8，预算见 §9）。

---

## 3. 频道时钟：`channel_seq`

一个每频道单调、**连续无空洞**的序号，是排序与恢复的主干。

```sql
ALTER TABLE channels ADD COLUMN next_seq BIGINT NOT NULL DEFAULT 0;   -- 每频道计数器
ALTER TABLE messages ADD COLUMN channel_seq BIGINT;                   -- 占位期间为 NULL
CREATE UNIQUE INDEX idx_messages_channel_seq
  ON messages(channel_id, channel_seq) WHERE channel_seq IS NOT NULL;
```

**分配（正确性核心）**——在事件的提交事务内、行锁下进行，保证 `seq 顺序 == 提交顺序`：

```sql
UPDATE channels SET next_seq = next_seq + 1 WHERE channel_id = $c RETURNING next_seq;
-- 然后把返回的 seq 写到该行
```

- 回滚归还自增 → **无空洞**。
- 在 **finalize**（`is_partial` TRUE→FALSE）时分配，因此被遗弃的流式占位不占号 → **无空洞**。
- 全局 `BIGSERIAL` 是**错的**：其值顺序可能与提交顺序不一致，增量 `> cursor` 读会永久跳过
  晚提交的较小 seq。每频道行锁串行化写入，杜绝此问题。

> **三个不同的 seq，切勿混淆：**
> - WIRE `seq`——每 `msg_id`、从 0 起，流式 delta 去重（帧层）。
> - `agent_bridge_events.seq`——每 `(bot, stream)`，bridge 重放（传输层）。
> - `channel_seq`——每频道，域事件时间线 + 恢复索引（**新增**）。

`channel_seq` 为**每一个**频道事件分配（消息**和**操作，见 §6），所以频道有一条全序事件流。

---

## 4. 一致性：两类文件，放宽

一致性**按文件类分流**（依
[context-and-environment.md §2.2](./context-and-environment.md)）。之前"memory 怎么做版本"的
纠结，根源就是没分类。

| | **Class 1 — 自维护** | **Class 2 — agent 可编辑** |
|---|---|---|
| 例子 | 消息历史、操作、文件索引、成员 | progress.md、anchor.md、场景文件 |
| 真相在 | 别处（messages / operations / file_records / membership） | 文件本身（memory tree） |
| 一致性原语 | `channel_seq`（append-only） | 每路径 `version`（乐观锁） |
| 读 | 读当前 + 游标增量 + 索引恢复 | 读当前 |
| 改 | **无 fs.write**——只有域动作 | `fs.write`/`fs.edit` 带 `if_version` |
| 恢复 | `messages.index` 高水位对账 | `version` 不匹配 → 重读 |

**铁律：每路径单一写权威。** 一个路径要么系统写（Class 1）、要么 agent 写（Class 2），绝不两者都写。

### 放宽一致性（关键简化）

ACP agent 输出本就非确定，因此**不**为每个任务冻结快照。保证更弱但足够：

> **单调完整性**：任何已提交事件都不会对某 bot 永久不可见；下次它被 `@` 时，能经 Resource API
> 读到完整内容。

这由**读当前 + 写后投递**天然满足（`is_partial = FALSE` 过滤使 bot 永不读到撕裂/半流式消息；
一旦 finalize 即对此后所有读可见）。**没有快照钉死、没有 connector 注入 seq**——两者都被考虑过并放弃。

明确放弃的是：跨资源的同一时刻一致性（messages 与 memory 的读可能差几微秒）。鉴于 ACP 非确定性
+ 下次触发会重读，可接受。

### 增量游标 + 主动恢复

- 增量读：bot 存 `last_seq`，读 `channel_seq > last_seq`。连续无空洞 + 提交序分配保证 `> cursor`
  永不跳过。
- 任务帧携带 `trigger_seq`（触发消息的 `channel_seq`）作参考点；游标由 bot 自管（如存在它的
  `channel.memory`）。网关对 per-bot 游标保持无状态。
- 主动恢复：`channel.messages.index` 返回 `{ min_seq, max_seq, count }`（+ 可选无内容 headers）。
  因流连续，bot 能精确算出缺哪些并按区间/seq 取回。这是崩溃与尽力 fan-out 的自愈路径——与现有
  `message_done` 自愈哲学一致。
- 已知限制：纯 `> cursor` 不会重新浮现已读消息的编辑/删除（seq 未变）；需要时由 header 索引
  （`edited_at`/`is_deleted`）覆盖。v1 不在范围。

### memory 写修复

旧 memory 路径被 `fs.*` 取代前唯一要改的：把 `replace` 模式（`DELETE` + 循环 `INSERT`）包进
**事务**，消除撕裂读窗口。

---

## 5. Resource API 结构

```
Class 1 — 自维护（agent 只读；改 = 域动作；系统盖 channel_seq + 记一条操作）
  channel.messages.{read, index, by-seq}          ← channel_seq 模型（§3）
  channel.activity.read(since_seq)                 ← 统一事件流（消息 + 操作交织）
  channel.files            读；改 = upload/delete 域动作
  channel.members          读；改 = invite/remove 域动作

Class 2 — agent 工作区（统一 fs.*；每路径 version 乐观锁）
  fs.{ls, read, write(if_version), edit(old→new, if_version), append, rm, mv}
  ← 新 memory_files tree（materialized path）；取代旧 memory_entries layer 模型
  ← 每次写副带一条 Class 1 操作事件（系统写，不同资源 → 不违反铁律）

Environment 层（位于 Resource API 之上）
  seed  → 批量写 memory_files + 注入约定 prompt
  lens  → file → UI 渲染规则（前端；非资源）
  tools? → 场景专属域动作（需按频道动态注册资源）
```

`memory_files` 存储：materialized `path`（子树用 `WHERE path LIKE 'a/b/%'`），每节点 `version`
做乐观锁，局部编辑用 string-replace，多文件编辑包 DB 事务。二进制/大文件仍存 `file_records`。

---

## 6. 频道操作日志

文件改动（及其他非对话事件）**不驱动调度**，但**必须记录**进频道。

- **决策：独立的 `channel_operations` 表**（自带 payload），不是薄指针索引。

```sql
CREATE TABLE channel_operations (
    id           UUID PRIMARY KEY,
    channel_id   UUID NOT NULL,
    channel_seq  BIGINT NOT NULL,        -- 同一 channels.next_seq 计数器取号
    op_type      TEXT NOT NULL,          -- fs.write | fs.rm | file.upload | member.join | chain.cancelled ...
    actor_type   TEXT NOT NULL,          -- bot | user | system
    actor_id     UUID,
    target_ref   TEXT,                   -- path / file_id / member_id
    payload      JSONB,
    created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_chan_ops_seq ON channel_operations(channel_id, channel_seq);
```

`channel.activity.read(since_seq)` = `messages UNION channel_operations`，按共享 `channel_seq`
排序。连续的全局流重新拼成一条有序活动流；bot 游标在其上读，看到消息 + 操作交织。

- 只有 **message 类型 + 含 `@mention`** 触发 bot。操作被记录、可见、可重放，但**对控制流惰性**。
  文件是黑板，`@` 是信号。
- **决策：操作不 fan-out** 给浏览器。实时层（`realtime::Fanout`）保持纯对话（消息终态 + 流式
  delta）。操作与工作区文件经拉取发现（`channel.activity.read`、`fs.read` + Lens），不 push。

---

## 7. Environment / 工作区模板插件

依 [context-and-environment.md §2.3](./context-and-environment.md)。`progress.md` / `anchor.md`
**不是引擎常量**——是模板 seed 的数据。

```
Environment 插件 = {
  seed:     初始文件树 + 约定 prompt   // 建频道时浇一次
  lens:     file → 可操作 UI 渲染规则   // 前端（View）
  bindings: path → lens
  tools?:   场景专属域动作             // 可选 Controller 扩展
}
```

Resource API 保持通用（Class 1 读 + Class 2 `fs.*`）；模板只灌内容、可加可选域动作。唯一的新机制：
`tools?` 要求资源分发器从 `gateway/src/acp_bridge/resource/mod.rs` 的静态 `match` 升级为
**按频道动态注册**。

---

## 8. Bot@Bot 链：跟踪 + 取消

Bot@Bot 无深度上限；级联以**链**跟踪，由用户取消停止。

```sql
CREATE TABLE task_chains (
    chain_id      VARCHAR(36) PRIMARY KEY,
    channel_id    VARCHAR(36) NOT NULL,
    root_task_id  VARCHAR(36) NOT NULL,
    root_msg_id   VARCHAR(36) NOT NULL,        -- 用户触发消息
    status        VARCHAR(16) NOT NULL DEFAULT 'active',  -- active | paused | cancelled | done
    cancelled_by  VARCHAR(36),
    cancelled_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agent_tasks ADD COLUMN chain_id       VARCHAR(36);
ALTER TABLE agent_tasks ADD COLUMN parent_task_id VARCHAR(36);  -- 触发本任务的那条回复的 task；root 为 NULL
ALTER TABLE agent_tasks ADD COLUMN depth          INTEGER DEFAULT 0;  -- 仅观测，非上限
ALTER TABLE bot_runs    ADD COLUMN chain_id       VARCHAR(36);
CREATE INDEX ix_bot_runs_chain_status ON bot_runs(chain_id, status);
```

根（用户触发）任务开启一条链；每个 Bot@Bot 后代继承 `chain_id`、设 `parent_task_id`、`depth` 自增。

### 停止 = 两部分——派发门禁才是权威

向在途 bot 广播取消是必要但**不充分**的：bot 可能已吐出回复，其 `@mention` 正排队等下一跳。

**(a) 派发门禁——权威，挡未来跳。** 派发任何下一跳前查 `task_chains.status`；`!= active` 则丢弃
（不建占位、不派发）。这是真正的止血，即使广播失败也成立（离线 bot 的 run 自会超时）。

**(b) 取消广播——尽力，停在途算力。** 枚举链上非终态 `bot_runs`，对每个发**现有的 per-`msg_id`
`cancel` 帧**（`{type:cancel, msg_id:<占位>, reason:chain_cancelled}`）到该 bot 的 control WS。
**connector 零改动**——其 `onCancel(msgId)` 已会停 delta + abort LLM。链取消即网关侧在既有
单 bot 原语上的 fan-out。

### 取消流程

```
1. 用户点某回复的 ⏹ → 解析 msg_id → chain_id（经 bot_runs/agent_tasks）
2. UPDATE task_chains SET status='cancelled', cancelled_by=$u, cancelled_at=now()
     WHERE chain_id=$c AND status='active';     -- 原子 + 幂等
3. SELECT placeholder_msg_id, bot_id FROM bot_runs
     WHERE chain_id=$c AND status NOT IN ('done','failed','cancelled');
4. 逐条 → BotLocator → control WS → per-msg_id cancel（尽力）
5. 在途占位由现有逻辑 finalize 成部分回复
6. （可选）记 op_type='chain.cancelled' 进 channel_operations
```

### 不可变性

已完成的回复留着（Class 1 事实，永不回收）；在途回复 finalize 成部分；未派发的跳被门禁挡掉。
取消是"不再往前"，不是"抹掉已发生"。

多实例时：取消经 `Fanout` / `BotLocator` trait 路由；协议不变。

---

## 9. 失控防护：可选预算

无深度上限 + 去中心化 = 可能的指数级 A@B / B@A 环。

- **决策：链预算 opt-in，默认无（unbounded）。** 产品默认只靠用户 ⏹ 停止。预算是可配置安全阀，
  **不是**硬深度上限。
- **归属：频道级，非 per-bot `effective_config`。** 链跨多个 bot，无法放进
  `build_effective_bot_config` / `ChannelMembership.bot_override_config`。它放在频道级设置 JSONB
  （`chain_budget`，默认 NULL）；Environment 模板可 seed 默认值。多层合并 = 取最小（依
  [BOT_CONFIG_LAYERING](./BOT_CONFIG_LAYERING.md) 的 limits 规则）。单位可配：任务数（推荐默认）、
  token 或成本。
- **机制复用派发门禁。** 增加 `paused` 状态（可恢复，区别于终态 `cancelled`）；门禁的
  `status != active` 同时挡两者。预算超阈：置 `paused` + 发系统消息（继续/停止）；用户继续 →
  status 回 `active` + 重派被 hold 的那一跳。无新增控制路径。
- 可选附加：靠 `parent_task_id` 做环可观测；同节点去重（同一 bot + 同一 `trigger_msg_id` 超 N 次
  → 仅中止该节点）。

---

## 10. 对当前 Rust gateway 的影响

大部分是净新增或填补明确的 Phase 1 占位；架构接缝已就位。

**已对齐（地基，不动）：** `Fanout` / `BotLocator` trait；`create_message` 的写后投递；
`resource_req` 静态分发器；确定性占位 id（UUID v5）幂等；权限/Grant 引擎。

**冲突（现有行为要改）：**
- `domain/messages.rs::resolve_bot_triggers` 当前触发频道内**所有 online bot**（其 TODO 自己注明
  "@mention / coordinator 路由"未建）。这与网格相反，是最大的行为反转。
- `resource/memory.rs::handle_update` 的 `replace` 未包事务（撕裂读）。
- 消息读按 `created_at` 排序；游标模型需要 `channel_seq`。

**缺失（净新增）：** `channel_seq`（+ 分配）、`channels.default_bot_id`、finalize 时的 Bot@Bot
重入（Rust 侧没有——原在 Python 的 `trigger_sub_bots_from_mentions`）、`task_chains` + 链列、
派发门禁、`cancel_chain`、`channel_operations` + `channel.activity.read`、`memory_files` +
`fs.*`、`messages.handle_read` 的 `since_seq`/index、Environment 动态工具注册。

---

## 11. 落地顺序

每步独立可测。

1. **迁移先行**——`channels.next_seq` + `default_bot_id`、`messages.channel_seq`、`task_chains`、
   `channel_operations`、`memory_files`。先把表结构钉死。
2. **`channel_seq` 分配**——在 `create_message` 与 finalize 路径加行锁分配，是后续一切的坐标。
3. **重写 `resolve_bot_triggers`**——all-online-bots → `@mention` + `default_bot`。这一步把系统
   切到去中心化网格（核心行为变更）。
4. **Bot@Bot 重入 + 链传播 + 派发门禁**——在回复 finalize 处重跑 `@` 解析 → 带 `chain_id` 和
   状态门禁派发下一跳。
5. **`cancel_chain`**——翻转 status + fan-out 现有 cancel 帧。
6. **资源层**——`since_seq`/index、`channel.activity.read`、`fs.*` + `memory_files`（旧 `memory.*`
   退场）。
7. **Environment 动态工具**——把资源静态 `match` 升级成注册表。

第 1–3 步是"地基 + 核心行为反转"，做完系统就已是去中心化的；4–7 补全能力。

---

## 待定 / 不在范围

- E2EE（依 SECURITY / E2EE_NOTES——本期不做）。
- 多实例 fan-out（trait 接缝已预留；接入时协议不变）。
- 游标模型之外的编辑/删除恢复（将来需要时用 header 索引）。
