# Engineering Execution Roadmap

> 版本：v1.5（2026-06-18）—— M0 完成：R1（进程内）·R3 背压·R4-1 单测·R4-2 集成·R5 双派发
> 性质：**执行路线图** —— 把架构现状转成可落地的里程碑序列。
> 与其他文档的关系：
> - [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) —— 目标拓扑与硬契约（**做什么**）
> - [DATA_FLOW_AND_REFACTOR_PLAN.md](./DATA_FLOW_AND_REFACTOR_PLAN.md) —— 代码现状快照 + 改造项 R1–R13（**改哪里**）
> - 本文 —— 里程碑、依赖、验收门（**按什么顺序、何时算完成**）
> - 区别于 [docs/policies/ROADMAP.md](../policies/ROADMAP.md)：那是**面向公众的产品路线图**；本文是**工程执行计划**。

---

## 〇、驱动判断：schema 远超 code

迁移文件定义了 **~37 张表**，但 `server/src/domain` + `api` 仅实现 **~9 个功能域**。核心闭环
（auth / workspaces / channels / messages / mentions / files / bots / sessions / chains / resource 协议）是真实可用的。
但大量表是**只有 schema、没有任何 handler/domain 代码**：

| 有 schema、无实现 | 隐含功能 |
|---|---|
| `memory_entries` `memory_files` | Agent 记忆即文件系统 |
| `document_sets` / `_items` / `_exclusions` | RAG / 检索（且缺 `search` resource —— 见 OVERVIEW 未决 #10） |
| `history_pages` `bulletin_issues` | Lens 渲染 / 摘要页 |
| `todo_items` `prompt_templates` `keychain_items` `ai_models` | 次级产品面 |

前端同样是**薄切片**（27 文件、~1.8k 行）：登录 + 基础聊天 + 设置页。无 bot 管理 UI、无文件 UI、无权限 UI、无任何次级功能。

> **结论**：「完成项目」= 两件事 ——（1）**无条件**夯实已存在的核心；（2）**显式裁剪**那些只有 schema 的功能哪些真正进入范围。
> 下面 M0 把（1）设为关键路径，M2 把（2）设为强制裁剪门。

**一个需先消解的矛盾**：OVERVIEW 的 Phase 1 仍提到「从零写 Python Agent Service runtime」，但 §二 与
[BUILTIN_AGENT.md](./BUILTIN_AGENT.md) 已**外接优先、无 Python 服务**取代之 —— connector + mcp-server **就是** agent 层。
本路线图以**外接优先**为准，故**删除整条 Python 服务工作流**。

---

## 一、里程碑总览

```
M0 夯实地基 ──▶ M1 核心闭环可演示 ──▶ M2 按范围裁剪的功能 ──▶ M3 加固 & 文档对齐
  ~1 周, 无条件      ~2–3 周                 体量取决于裁剪          ~1 周
                                                                      └─ M4 扩容 & 运维（未来 / 仅 HA 触发）
```

唯二需要你拍板的决策：**(R1) 部署形态**（M0 内）与 **(M2) 功能裁剪**。其余均已排序并设验收门。

---

## M0 — 夯实地基（无条件，~1 周）

没有测试网 + 单一部署形态之前，其它一切都不安全。这是关键路径。

| 工作 | 改造项 | 体量 |
|---|---|---|
| 收尾 WIP，删 `BIND_DATA CALLED` 调试日志，提交干净工作树 | R2 | 0.5h |
| 纯逻辑单测（幂等 I4、seq 单调 I7、finalize 守卫 R4、`role_can_write`、退避、mention 解析、`is_terminal_frame`） | R4-1 | 0.5d |
| **决策：部署形态。** 回退进程内 `Fanout`+`BotLocator`（**推荐** —— 契合单实例定调、消除每帧 Redis 开销与「已支持多实例」假象；trait 保留给未来） | R1-A | 0.5–1d |
| 终态帧背压修复（队列满时关连接而非静默丢 `message_done`） | R3 | 0.5d |
| dispatcher 双派发修复（原子 INSERT，删前置 SELECT） | R5 | 0.5d |
| 集成测试：流程 2→4 全链路、I1 写后投递、I2 gap-free seq、断线补齐 | R4-2 | 1–2d |

**验收门**：工作树干净 · CI 中 `cargo test` + 集成 job 双绿 · 不变量 I1–I4 各至少一条覆盖 · 单实例冒烟通过 ·
Redis 不再是 fan-out 路径的启动硬依赖。

> 唯一真决策是 R1。下游全部假设单实例 / 进程内。若近期确需 ≥2 实例，改走 R1-B（Redis StreamRegistry + R7 按需订阅 + 跨实例测试），约 +1 周，且仅在有明确 HA 需求时才做。

---

## M1 — 核心闭环端到端可演示（~2–3 周）

让「消息 + 外接 bot」闭环**通过 UI 真正可用**。这是 MVP。

- **后端补齐**：用核心闭环对照现有 ~32 条路由，补齐 channels / memberships / messages-since-seq / files / bots / workspaces 的 CRUD 缺口。大部分已存在 —— 是补洞，不是新建。
- **前端（本里程碑真正的工作量）**：打通 `useChatRealtime` 重连 → REST 补齐；流式 bot 回复渲染；mention 选择器（`<@bot>`/`<@user>`）；文件上传/附件 + `<#file>` token；presence；**bot 管理 UI**（注册外接 bot、签发 botToken、查看 config/status）。
- **connector 通路验证**：一条文档化的 happy-path —— 经 `agentnexus-mcp-server` *或* `agentnexus-acp-connector-rs` 接入 Claude/Codex，@提及、流式、断线重连。
- 可选：R6 delta 热路径优化（M0 测试就位后才安全）—— 非性能瓶颈则延后。

**验收门**：新用户能 建工作区/频道 → 邀请 → 发带 mention+文件的消息 → 接入外接 agent → @它 → 看它流式回复 → 刷新后看到完整历史。这就是可交付切片。

---

## M2 — 按范围裁剪的功能（体量取决于裁剪）

即 OVERVIEW 的 Phase 2，**也是必须刻意裁剪范围之处**。对每个 schema-only 功能，明确：*v1 进 / 延后 / 砍掉*。

| 功能 | 需要 | 默认建议 |
|---|---|---|
| DM/topic resource scope | resource 协议扩出 `channel.*`（未决 #10） | **进**（mesh 核心） |
| Agent 记忆（memory 文件上的 `fs.*`） | resource handler + UI | **进**（标志性能力） |
| 文档/RAG + `search` resource | 新 resource 动词 + 检索 | 除非 RAG 是卖点，否则延后 |
| Lens 渲染 v1（`history_pages`） | 渲染管线 + UI | 延后 |
| 权限：Grant/trust_level | **决策：实现 还是 正式放弃** | **放弃 → 保留 channel-role**，在 [BOT_PERMISSION.md](./BOT_PERMISSION.md) 顶部标注（R13） |
| todos / prompt_templates / keychain / ai_models | 各自 CRUD + UI | 砍掉或延后 |

**验收门**：每个选入的功能 —— resource 动词 + handler + UI + 一条集成测试。**不得**把只有 schema 的功能标成「完成」。

---

## M3 — 加固 & 文档真相（~1 周，可与 M2 重叠）

R8 错误上下文（消灭 21 处 `map_err(|_| "db error")`）· R9 session 解析合并 · R10 sqlx `FromRow` 清理 ·
R11 拆 `bridge_runtime.rs`(2.5k)/`agent_bridge.rs`/`acp_capability.rs` · **孤儿占位回收器**（流程 8 缺口）·
R13 文档对齐（§2.6 差异表）。R12（UUID 列迁移）长期 / 可选。

---

## M4 — 扩容 & 运维（未来，仅 HA 需求触发）

R1-B + R7（多实例）· OpenTelemetry · 权限审计日志。即 Phase 3 —— **明确不在当前范围**。

---

## 二、状态看板

> 勾选随实现推进更新；每次架构变更同步本文版本号。

- [x] **M0** 夯实地基 ✅ **全部完成（2026-06-18）**
  - [x] R2 WIP 收尾 + 工作树干净（commit 8a7b661：删调试日志 + bind 竞态修复 + 单测）
  - [x] R4-1 纯逻辑单测（17 项：I4 幂等派生 / I7 seq 单调 / R4 finalize 守卫 / role_can_write / compute_backoff / mention 去重 / is_terminal_frame）
  - [x] R1 部署形态决策 → **方案 A（进程内）**：`main.rs` 装配 InProcessFanout + InProcessBotLocator，Redis 退出 fan-out 启动路径（2026-06-18）
  - [x] R3 终态背压修复（fanout 入队失败且终态帧 → 4408 关闭；closers 信号 + browser close_rx；单测 3 项）
  - [x] R5 dispatcher 双派发修复（删前置 SELECT，create_placeholder 返回 rows_affected==1 定胜负；败者不派发 task）
  - [x] R4-2 集成测试（bin→lib + `#[sqlx::test]`，feature `integration` 门控；4 项对真实 PG：I2 gap-free / 流程 2 连续 seq + 流程 8 补齐 / R5 并发只派一次 / 流程 4 done finalize + 幂等）
- [ ] **M1** 核心闭环可演示
  - [ ] 后端 CRUD 补洞
  - [ ] 前端实时 / 流式 / mention / 文件 / presence
  - [ ] bot 管理 UI
  - [ ] connector happy-path 文档化验证
- [ ] **M2** 功能裁剪（先定表，再实现）
- [ ] **M3** 加固 & 文档对齐
- [ ] **M4** 扩容（HA 触发）
