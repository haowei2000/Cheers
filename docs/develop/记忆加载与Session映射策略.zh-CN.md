# 记忆加载与 Session 映射策略

> **语言**：中文 | [English](记忆加载与Session映射策略.md)

> 适用对象：后端研发、Bot 适配器开发者、Agent Bridge provider 开发者。本文只描述当前代码实现，不描述历史 orchestrator 路径。

---

## 一、设计目标

当前 Bot 运行时分成两层 workflow：

1. **消息写入 workflow**：负责校验、落库、广播、未读 fanout。
2. **Bot workflow**：负责根据消息和频道配置构建执行计划，再加载上下文并派发 Bot。

记忆加载属于 **Bot workflow 的 ContextLoadStage**，不会在普通消息写入阶段执行。Session 映射属于 **Agent Bridge Bot dispatch**，用于把 AgentNexus 的频道、DM、主题、任务映射到外部 provider 的稳定会话 key。

核心原则：

- 普通消息先稳定落库，Bot 上下文加载随后发生。
- 记忆按计划和模板按需加载，避免每次无条件拉满。
- AgentNexus 拥有稳定 session 身份，provider 的会话 id 只是实现细节。
- Agent Bridge 的在线连接是进程内状态，持久 session 归数据库管理。

---

## 二、记忆加载策略

### 2.1 入口与触发点

Bot pipeline 入口是：

- `backend/app/features/bot_runtime/pipeline/bot/service.py`
- `run_bot_pipeline(...)`

执行顺序：

```text
run_bot_pipeline
  -> build_bot_workflow(ctx)
  -> Pipeline(plan.stages, name="bot").run(ctx)
```

`build_bot_workflow(ctx)` 位于：

- `backend/app/features/bot_runtime/pipeline/workflow.py`

当 workflow 没有目标 Bot 时，`plan.stages == ()`，不会执行 `ContextLoadStage`，也就不会加载记忆。

### 2.2 Plan 如何决定记忆加载

`BotWorkflowBuilder.build(ctx)` 会先完成路由，再写入 `BotWorkflowPlan`：

```text
BotWorkflowPlan
  route_mode
  target_usernames
  stages
  memory_layers
  memory_requested
  load_attachments
  load_topic_context
  reason
```

计划生成规则：

| 场景 | stages | 记忆加载策略 |
|------|--------|--------------|
| 无目标 Bot | 空 workflow | 不加载记忆 |
| 普通 @Bot | `ContextLoadStage -> DispatchStage` | 按目标 Bot 模板和消息类型决定 |
| DM Bot | `ContextLoadStage -> DispatchStage` | 与普通 @Bot 相同 |
| auto-assist | `ContextLoadStage -> AutoTakeoverStage` | 按 Coordinator 模板和消息类型决定 |

`memory_layers` 由 `select_memory_layers(ctx.trigger_msg.msg_type)` 决定：

| msg_type | 加载层 |
|----------|--------|
| `routing` | `anchor`, `decisions` |
| `permission` | `anchor` |
| 其他 / 空值 / 未知 | `ChannelMemory.ALL_LAYERS` |

`memory_requested` 由 `should_build_memory(ctx)` 决定：

- 遍历本次 `target_usernames`。
- 读取每个目标 Bot 的有效 `user_template`。
- 如果任一模板使用 memory 占位，则加载记忆。
- 如果某个模板未知，保守地视为需要记忆。
- 如果所有目标模板都不使用 memory，则跳过记忆加载，返回空 memory dict。

也就是说，**消息类型决定加载哪些层，模板决定是否加载记忆**。

### 2.3 ContextLoadStage 做什么

`ContextLoadStage` 位于：

- `backend/app/features/bot_runtime/pipeline/bot/stages/context_load.py`

它按 plan 并发执行三类 I/O：

```text
memory.manager.load_layers(channel_id, session, layers)
FilePipelineService.prepare_metadata_only(...)
gather_topic_context(trigger_msg, session)
```

结果写回 `BotRunContext`：

| 字段 | 含义 |
|------|------|
| `memory_context` | 传给 adapter 的 flat memory dict |
| `memory_load_detail` | 写入 bot placeholder `content_data.memory_load` 的调试快照 |
| `attachments` | Bot 可见的附件元数据 |
| `attachment_error` | 附件加载失败时的用户可见错误 |
| `topic_chain` | 回复链上文 |
| `child_replies` | 主题根的子回复上下文 |

附件和 topic context 由 plan 的 `load_attachments`、`load_topic_context` 控制。当前 Bot workflow 对有目标的消息默认加载 topic context；附件仅当触发消息或澄清原问题有文件时加载。

### 2.4 ChannelMemory 六层来源

统一领域对象是：

- `backend/app/features/memory/channel_memory.py`
- `ChannelMemory`

当前记忆层：

| 层 | key | 来源 | 说明 |
|----|-----|------|------|
| 项目锚点 | `anchor` | `memory_entries`，layer=`ANCHOR` | 最高优先级约束 |
| 决策记录 | `decisions` | `memory_entries`，layer=`DECISIONS` | 关键决策 |
| 项目进度 | `progress` | `memory_entries`，layer=`PROGRESS` | 当前进展 |
| 资料索引 | `files_index` | `FileRecord` 实时渲染 | 排除 image 类型，包含摘要和 file_id |
| 近期动态 | `recent` | `history_pager.render_recent_context` | 当前页 + 历史摘要页 |
| 待办事项 | `todos` | `TodoItem` 实时渲染 | 未完成清单 + 已完成索引 |

`memory.manager.load_layers(...)` 会调用 `ChannelMemory.load_layers(...)`，最后通过 `to_context_dict()` 导出为：

```python
{
    "anchor": "...",
    "decisions": "...",
    "progress": "...",
    "files_index": "...",
    "recent": "...",
    "todos": "...",
}
```

未请求的层也会出现在 dict 中，但值为空字符串。这样 adapter 和模板不用区分“未加载”和“无内容”。

### 2.5 RECENT 层的实时渲染

`recent` 不是直接读取某个 `MemoryEntry`，而是在加载时实时渲染：

- 当前未封存页：取最近 N 条消息，默认由 `MEMORY_RECENT_DIRECT_MESSAGE_COUNT` 控制。
- 历史摘要页：读取已封存的 `HistoryPage` 摘要。
- 输出由 `MEMORY_RECENT_SUMMARY_MAX_CHARS` 控制截断。

消息写入和 Bot 回复完成后会调度 recent 更新/压缩，但 Bot 真正读取 `recent` 时仍以运行时渲染结果为准。

### 2.6 Prompt 注入位置

记忆不会直接在 workflow 里拼成 system prompt，而是作为 `AgentPayload.context.memory` 传给 adapter：

```text
BotRunContext.memory_context
  -> build_payload(...)
  -> AgentPayload.context.memory
  -> adapter 根据模板渲染
```

HTTP Bot / Agent Bridge Bot 都会基于 PromptTemplate 渲染用户消息或系统提示。旧的 `build_system_prompt_prefix(...)` 仍提供兼容拼接能力，但当前 Bot pipeline 的关键边界是 `AgentPayload.context.memory`。

### 2.7 可观测性

每个 Bot placeholder 会携带记忆加载快照：

```text
Message.content_data.memory_load
```

字段包括：

- `memory_requested`
- `trigger_msg_id`
- `trigger_msg_type`
- `requested_layers`
- 每层是否 requested、是否 present、字符数、preview
- `total_chars`

这用于排查“为什么 Bot 没看到某层记忆”“模板是否触发了 memory gate”等问题。

---

## 三、Session 映射策略

### 3.1 三类 session/状态

当前系统里“session”有三层含义：

| 层 | 模块 | 生命周期 | 用途 |
|----|------|----------|------|
| 在线 WebSocket 会话 | `agent_bridge.registry.BotSessionRegistry` | 进程内，随连接消失 | 记录每个 Agent Bridge Bot 的 control/data WS |
| 稳定业务会话 | `agentnexus_sessions` / `agentnexus_session_bindings` | 数据库持久化 | 将频道/DM/主题/任务映射到 provider session key |
| 单次回复运行态 | `pending_replies` / `stream_registry` | 进程内，随回复完成清理 | 占位消息 finalize、流式 buffer、取消控制 |

不要把这三层混为一谈：

- `BotSessionRegistry.session_id` 是在线连接的临时 id。
- `AgentNexusSession.session_id` 是持久业务会话 id。
- `AgentPayload.task_id` 是一次 Bot dispatch/run 的任务 id。

### 3.2 在线连接映射：bot_id -> control/data WS

模块：

- `backend/app/features/agent_bridge/registry.py`

每个 Agent Bridge Bot 通过自己的 token 建立两条 WS：

- control WS：成员事件、控制事件、心跳。
- data WS：接收 AgentNexus 派发消息，回传 delta/reply/done/trace。

映射规则：

```text
bot_id -> BotSession(control_ws, data_ws)
```

不变量：

- 每个 `bot_id` 最多一个 control WS 和一个 data WS。
- 新连接会替换旧连接，旧连接以 4402 关闭。
- `connection_status`：
  - `online`：control + data 都在线
  - `partial`：只有一条在线
  - `offline`：都不在线

限制：

- 当前 registry 是进程内内存状态。
- 多副本部署需要外部 pub/sub 或集中式 registry，否则不同进程看不到彼此连接。

### 3.3 稳定业务会话：AgentNexusSession

模块：

- `backend/app/features/agent_bridge/session_map.py`
- `backend/app/db/models.py`

AgentNexus 不直接信任 provider 的 `sessionId` 作为产品级会话身份。系统创建自己的稳定会话：

```text
AgentNexusSession.session_id
AgentNexusSession.provider_session_key
```

provider session key 格式：

```text
agent:{provider_agent_id}:agentnexus:account:{provider_account_id}:session:{session_id}
```

provider/account/agent 信息来源：

| 字段 | 来源 |
|------|------|
| provider | `BotAccount.binding_config.bridge_provider` / `provider` / `BotAccount.bridge_provider` / `generic` |
| provider_account_id | `binding_config.account_id` / `provider_account_id` / `bot_id` |
| provider_agent_id | `binding_config.agent_id` / `provider_agent_id` / `main` |

这些值会经过安全字符清洗，只保留适合放进 session key 的字符。

### 3.4 Scope 选择规则

`resolve_dispatch_session(...)` 每次 Agent Bridge Bot 被派发时执行。

当前主 scope 选择顺序按实际代码为：

1. 如果 channel 是 DM：scope=`dm`
2. 否则如果 trigger message 能解析出 topic：scope=`topic`
3. 否则：scope=`channel`

DM scope 不直接使用底层 `Channel.channel_id`，而是使用稳定产品语义：

```text
user:{user_id}:bot:{bot_id}
```

这样即使 1:1 DM 的 backing channel 被重建，同一个用户和同一个 Bot 仍会落到同一个 provider 会话。兼容旧数据时，如果找不到新 DM scope，会尝试复用旧的 `scope_id == channel_id` 绑定，并补上新绑定。

Topic scope 来源：

- `trigger_message.topic_chain[0].msg_id`
- 或 `trigger_message.msg_type == "topic"` 时的 `trigger_message.msg_id`

Channel scope 直接使用 `channel_id`。

### 3.5 Task alias 策略

每次 dispatch 如果有 `task_id`，系统会把它作为 alias 绑定到同一个稳定 session：

```text
scope_type = task
scope_id = task_id
role = alias
```

查找顺序：

1. 先查 `(bot, provider, agent, account, task_id)` 是否已有 task binding。
2. 如果没有，再查主 scope binding。
3. 如果都没有，创建新的 `AgentNexusSession`。
4. 确保主 scope binding 和 task alias binding 都存在。

特殊规则：

- 如果通过 task binding 找到了旧 session，而当前消息只携带 channel scope，则不会把整个 channel 绑定到这个 task session。
- 这样可以避免“从任务视图回到频道时，把频道会话错误地收窄到某个任务会话”。

### 3.6 Dispatch 到 provider 时传什么

`AgentBridgeBotAdapter.execute(...)` 在派发前调用：

```python
resolve_dispatch_session(...)
```

然后把结果放入发给 plugin 的 data WS 事件：

```json
{
  "session": {
    "id": "...",
    "provider": "...",
    "provider_session_key": "...",
    "provider_account_id": "...",
    "provider_agent_id": "...",
    "primary_scope_type": "channel|dm|topic|task",
    "primary_scope_id": "...",
    "task_scope_id": "..."
  },
  "provider_session_key": "..."
}
```

provider 应优先使用 `provider_session_key` 作为外部对话线程 key，而不是自行使用临时 WebSocket session id。

### 3.7 PendingReply 与 StreamRegistry

Agent Bridge Bot 回复是异步的，因此占位消息和 provider 回推之间需要运行时映射。

`pending_replies`：

```text
(task_id, bot_id) -> PendingReply
msg_id -> PendingReply
```

用途：

- plugin 回传 `reply_to_msg_id` 时定位占位消息。
- plugin 只回传 `task_id` 时按 `(task_id, bot_id)` 兜底定位。
- 强制 bot_id 匹配，避免一个 Bot finalize 另一个 Bot 的占位消息。
- timeout handle 挂在 pending 上，reply 成功后会取消。

`stream_registry`：

```text
msg_id -> StreamState
```

用途：

- 缓存 delta 流式文本。
- 保存 local/agent_bridge source。
- 存储取消信号 `cancel_event`。
- 绑定本地 producer task，用户取消时可 `task.cancel()`。
- finalize 后移除。

这两类 registry 也都是进程内状态，多副本部署需要额外持久化或粘性路由。

### 3.8 Agent Bridge 回复路径

典型链路：

```text
Bot pipeline
  -> pre_create placeholder
  -> AgentBridgeBotAdapter.execute
  -> resolve_dispatch_session
  -> pending_replies.register
  -> stream_registry.register
  -> commit placeholder
  -> bot_session_registry.dispatch_data
  -> plugin data WS receives message
  -> plugin sends delta/reply/done
  -> routes.py data handler
  -> bot_events queue
  -> finalize placeholder / broadcast message_done
```

为何 dispatch 前要 commit placeholder：

- plugin 可能“秒回”。
- 回推 handler 使用独立 DB session。
- 如果占位消息尚未提交，handler 可能只能看到 pending 内存，看不到 DB row。
- 因此 adapter 在 dispatch 前先 `flush + commit`，降低竞态。

### 3.9 事件日志与 resume

`bot_session_registry.dispatch_data(...)` 会在发送 data WS 事件前写入：

- `agent_bridge_events`
- 按 `(bot_id, stream, seq)` 递增

plugin 重连后可发送 `resume`，服务端按 `last_event_seq` 回放 data 事件。

注意：

- 目前记录的是发往 provider 的 data 事件。
- control 事件没有完整日志；membership 快照是重连后的最终一致兜底。

---

## 四、调试入口

### 4.1 排查 Bot 没读到记忆

优先看：

1. Bot 回复消息的 `content_data.memory_load`
2. `requested_layers`
3. 每层 `present/chars/preview`
4. 目标 Bot 的 PromptTemplate 是否包含 memory 占位
5. 触发消息 `msg_type` 是否为 `routing` 或 `permission`

相关代码：

- `pipeline/workflow.py`：`BotWorkflowBuilder.build`
- `pipeline/bot/stages/context_load.py`：`select_memory_layers`、`should_build_memory`
- `features/memory/channel_memory.py`：各层加载来源

### 4.2 排查 Agent Bridge Bot 没复用会话

优先检查：

1. `agentnexus_sessions.provider_session_key`
2. `agentnexus_session_bindings.scope_type/scope_id`
3. Bot 的 `binding_config.account_id / agent_id / provider`
4. 触发消息是否带 topic_chain
5. DM 是否能从 trigger message 中拿到 user id

相关代码：

- `features/agent_bridge/session_map.py`
- `features/bot_runtime/adapters/agent_bridge_bot.py`
- `db/models.py` 中 `AgentNexusSession` / `AgentNexusSessionBinding`

### 4.3 排查 Agent Bridge 回复无法 finalize

优先检查：

1. plugin 回传的 `reply_to_msg_id`
2. plugin 回传的 `task_id`
3. `pending_replies` 是否仍有记录
4. `stream_registry` 是否存在对应 msg_id
5. bot_id 是否匹配
6. 占位消息是否已经提交

相关代码：

- `features/agent_bridge/pending.py`
- `features/agent_bridge/streams.py`
- `api/v1/agent_bridge/routes.py`
- `features/agent_bridge/service.py`

---

## 五、已知边界

- `BotSessionRegistry`、`PendingReplyRegistry`、`StreamRegistry` 都是进程内状态。
- 多副本部署时需要 sticky session、外部 pub/sub、或把 pending/stream 状态迁移到 Redis/DB。
- `recent` 层是运行时渲染，不应假设它是单条持久 `MemoryEntry`。
- `memory_requested=false` 时，adapter 收到 `{}`，`{{memory}}` 渲染为空字符串；只有执行 `load_layers` 时，未请求层才会以空字符串出现在兼容 dict 中。
- DM 的 session scope 使用 `user:{user_id}:bot:{bot_id}`，不是 backing channel id。
- 删除 Bot 时，`agentnexus_sessions` 和 bindings 通过外键级联删除。

---

## 六、关键文件速查

| 模块 | 文件 |
|------|------|
| Bot workflow 规划 | `backend/app/features/bot_runtime/pipeline/workflow.py` |
| 记忆上下文加载 | `backend/app/features/bot_runtime/pipeline/bot/stages/context_load.py` |
| 频道记忆领域对象 | `backend/app/features/memory/channel_memory.py` |
| 记忆 manager facade | `backend/app/features/memory/manager.py` |
| recent 渲染与分页 | `backend/app/features/memory/history_pager.py` |
| Agent Bridge session 映射 | `backend/app/features/agent_bridge/session_map.py` |
| Agent Bridge 在线连接 registry | `backend/app/features/agent_bridge/registry.py` |
| Agent Bridge pending reply | `backend/app/features/agent_bridge/pending.py` |
| 流式状态与取消 | `backend/app/features/agent_bridge/streams.py` |
| Agent Bridge adapter | `backend/app/features/bot_runtime/adapters/agent_bridge_bot.py` |
| Agent Bridge WS routes | `backend/app/api/v1/agent_bridge/routes.py` |
| session 数据模型 | `backend/app/db/models.py` |
