# 一个 Bot 在多频道并发工作

> 配套：[ACP_CONNECTION_MODEL](./ACP_CONNECTION_MODEL.md) · [SESSION_MODEL](./SESSION_MODEL.md) · [CONNECTOR_HOSTS](./CONNECTOR_HOSTS.md) · [SESSION_WORKDIR_ROOTSET](./SESSION_WORKDIR_ROOTSET.md)

一个 bot 账号 = 一个 connector daemon = 一个 agent 进程 = **N 个频道**。这是既有拓扑，
不是将来时：频道会话键是 `cheers:channel:{channel}:bot:{bot}`（`domain/sessions.rs`），
每频道一条，回合由 per-session-key 锁串行；而 `bridge_runtime` 在发出 prompt 前就
释放了 adapter 锁，正是为了让"一个频道卡在审批卡上"不会冻结同一 bot 的其他频道。

本文写下这套并发必须满足的不变量、当前实现与之的差距，以及 agent 镜像的验收标准。

---

## 1. 四条不变量

1. **每频道一会话；频道内串行，跨频道并行。**
2. **权限随回合收窄；收窄信息只能减权，不能授权；收窄失效即拒绝。**
3. **回合绑定不存放在可变的共享连接状态里。**
4. **容量有界、按频道公平、故障按频道隔离。**

不变量 2 和 3 是一对，来源是一次外部事故复盘：某系统把每回合的身份烤进 MCP 连接的
静态 header，而 agent 进程按 server **名字**复用 MCP client，于是后建会话的 header
覆盖了在途会话的，并发回合之间身份互换——下游每一道鉴权都忠实地校验了"别人的、
自洽的"凭证，全部放行。

Cheers 今天不受该机制影响：注入的 MCP server 配置只有一个 host 级 OAuth bearer
（`bridge_runtime/prompt.rs` 的 `native_cheers_mcp_server`），`mcp_servers_for_task`
显式忽略 task，因此即便发生 header 覆盖，被覆盖的也是一份完全相同的凭证；且身份只到
bot 账号，不存在"代表某个人类用户"的凭证可被交换。

**但代价是身份完全没有回合作用域**：频道来自模型传入的 `channel_id` 参数，网关只校验
"这个 bot 是不是这个频道的成员"（`resource/mod.rs` 的 `authorize_channel_read/write`），
不校验"这次回合该不该碰这个频道"。频道正文是不可信输入，因此频道 A 的一条消息可以诱导
agent 去读写该 bot 所属的频道 B。半径限于该 bot 自己的成员频道，不跨租户、不冒充用户——
但不是零。不变量 2、3 就是为关掉它而存在，而且**加收窄信息时必须同时满足 3**，否则我们会
把上面那个竞态亲手引进来。

---

## 2. 与当前实现的差距

| 不变量 | 现状 |
| --- | --- |
| 1 每频道一会话 | ✅ 已成立。**但**：两个频道可能 pin 到同一个真实 `cwd` 并发写同一个仓库，无检测；长期不活跃的频道会话无 TTL |
| 2 权限随回合收窄 | ❌ 未实现。access token 只绑 bot 账号，无频道声明 |
| 3 绑定不放在可变连接状态 | ⚠️ 今天无绑定可放，因而无风险；一旦引入频道绑定即成为硬约束 |
| 4 容量有界 | ✅ 阶段 1：`TurnSlots` 信号量，默认 4（原默认 1 从未生效，实际并发无上限）；超限回合发 `turn_queued` trace |
| 4 配额按频道 | ❌ `MAX_WATCHES = 16` 挂在 daemon 全局的 `shared.watches`，单频道可饿死其他频道 |
| 4 故障隔离 | ⚠️ 单进程服务全部频道；`BusyGuard` 整个回合持有，持续多频道流量下自更新可能永远等不到空窗 |

---

## 3. 落地顺序

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 跨频道调用基线埋点；隔离验收矩阵成文 | ✅ 本文 + `api/mcp.rs` 的 channel-scope 审计 |
| 1 | 并发阀门：让 `max_concurrent` 生效 + 背压 trace | ✅ 连接器 0.1.42 |
| 2 | 身份收窄：MCP server 名字按频道唯一化 → token 带 `chan` 声明 → warn → enforce | 待办 |
| 3 | 隔离补强：cwd 冲突检测、会话 TTL、崩溃终帧、自更新静默窗口 | 待办 |

阶段 1 排在 2 前面：阶段 2 修的是需要提示注入配合才能利用的越权，阶段 1 修的是正常
业务增长就会撞上的稳定性悬崖；且阶段 2 的方案要在高并发下才验证得出来，先有阀门才好做
受控实验。

### 阶段 1 为什么不需要"每频道配额"

原计划是"每频道上限 + 全局信号量"两级配额。实现时发现**用顺序即可解决**：把全局槽位放在
per-session 锁**之后**获取，频道 A 连收 10 条消息时，排队的回合停在自己的会话锁上、
手里不持槽位，因而占不住池子、饿不死频道 B。

顺序比配额好在两点：不必给"每频道上限"选一个凭感觉的数字；也不会像"每频道上限 1"那样，
让用户的回合排在同频道的 claim evaluation 后面——那是把饥饿从频道之间搬到了频道内部。

### 阶段 2 为什么要两层

- **第一层，让碰撞不发生**：MCP server 名字按频道唯一化（`cheers-{channel_short}`）。
  连接器自己生成名字，成本近乎为零，从物理上让"按名字复用 client"无法串台。
  代价是工具名带 server 前缀会随频道变化，落地前须核对 `domain/tool_presentation.rs`
  与提示词是否硬依赖 `cheers` 这个名字。
- **第二层，碰撞发生也只降级为拒绝**：access token 带 `chan` 声明（铸造时即校验成员
  资格），网关在 `call_tool` / `read_resource` 做等值校验，不匹配即 `PERMISSION_DENIED`。

只做第二层是"能扛"，只做第一层是"侥幸"。两层一起，才满足不变量 2 + 3。

---

## 4. Phase 0 埋点：channel-scope 审计

`api/mcp.rs` 对每一次 MCP 调用（tool call 与 resource read 两个入口）发一条结构化事件，
target 为 `cheers::mcp::channel_scope`，按 `verdict` 聚合即得基线：

| verdict | 含义 |
| --- | --- |
| `in_turn` | 调用的频道正是该 bot 某个在途回合的频道 |
| `cross_channel` | 该 bot 有在途回合，而调用指向其中任何一个之外的频道——**要找的就是它** |
| `no_active_turn` | 本进程看不到在途回合，不可判定 |
| `channelless` | 调用不带频道（`dm.open`、`bot.status.write`） |

在途频道集合来自 `StreamRegistry::active_channels(bot_id)`。

**这套判定只用于观测，永远不可用于鉴权**，两条理由缺一不可：

1. 它是**进程本地**的。多副本网关下，流挂在持有该 bot WS 的副本上，未必是接收 MCP
   请求的那个副本；`no_active_turn` 因此不等于"没有在途回合"。
2. 多频道 bot 的在途集合本来就**同时含多个频道**，无法据此判断某次调用属于哪个回合。

把调用绑到回合，需要凭证自身携带频道——那是阶段 2，本埋点是给它定规模的基线。

---

## 5. 隔离验收矩阵

以下五项是 agent 镜像的验收标准。**架构上不依赖它们通过**——不变量 2、3 的设计前提
就是"agent 可能不隔离"——但通不过的 agent 应被记录在案。

| # | 场景 | 通过标准 |
| --- | --- | --- |
| 1 | 同一 bot 两频道并发回合 | 上下文与 `cwd` 不互窜 |
| 2 | 并发期间抓 MCP 请求头 | 阶段 2 后：每个请求的 `chan` 与其所属频道一致 |
| 3 | 频道 A 卡在审批卡上 | 频道 B 的回合照常完成（`bridge_runtime` 释放 adapter 锁那段注释的回归） |
| 4 | 并发度打满信号量 | 背压帧到达前端，频道显示"排队中"而非静默等待 |
| 5 | agent 进程被 kill | 每个在途频道各自收到终帧，而非集体静默超时 |

第 3 项今天没有自动化回归，需要一个假 `RuntimeAdapter` 的测试夹具，随阶段 1 一并补。
