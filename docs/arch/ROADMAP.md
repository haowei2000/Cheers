# Engineering Execution Roadmap

> **Status:** 🛠 Planning — actively-maintained engineering execution plan, **not** the current-state reference. For the current architecture see [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md); for the public product roadmap see [docs/ROADMAP.md](../ROADMAP.md).

> 版本：v1.8（2026-06-26）—— M3.5：ACP 协议库采用 R14（Tier A typed schema 已落地 / Tier B 全量 runtime 规划）
> 版本：v1.7（2026-06-25）—— M3 收口：R8 错误上下文 · R9 session 解析合并 · R10 sqlx 样板 · R11 拆 bridge_runtime(+impl) · 孤儿占位回收器 · R13 文档对齐（R12 长期搁置）
> 版本：v1.5（2026-06-18）—— M0 完成：R1（进程内）·R3 背压·R4-1 单测·R4-2 集成·R5 双派发
> 性质：**执行路线图** —— 把架构现状转成可落地的里程碑序列。
> 与其他文档的关系：
> - [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) —— 目标拓扑与硬契约（**做什么**）
> - [DATA_FLOW_AND_REFACTOR_PLAN.md](./DATA_FLOW_AND_REFACTOR_PLAN.md) —— 代码现状快照 + 改造项 R1–R13（**改哪里**）
> - 本文 —— 里程碑、依赖、验收门（**按什么顺序、何时算完成**）
> - 区别于 [docs/ROADMAP.md](../ROADMAP.md)：那是**面向公众的产品路线图**；本文是**工程执行计划**。

---

## 〇、驱动判断：schema 远超 code

迁移文件定义了 **~37 张表**，但 `server/src/domain` + `api` 仅实现 **~9 个功能域**。核心闭环
（auth / workspaces / channels / messages / mentions / files / bots / sessions / chains / resource 协议）是真实可用的。
但大量表是**只有 schema、没有任何 handler/domain 代码**：

| 有 schema、无实现 | 隐含功能 |
|---|---|
| `document_sets` / `_items` / `_exclusions` | RAG / 检索（且缺 `search` resource —— 见 OVERVIEW 未决 #10） |
| `history_pages` `bulletin_issues` | Lens 渲染 / 摘要页 |
| `todo_items` `prompt_templates` `keychain_items` `ai_models` | 次级产品面 |

> **记忆/文件已落地，不在「无实现」之列**：`memory_entries`（旧分层记忆模型）已在 `0003_decentralized_mesh.sql:89` **DROP**；`context_files`（「Agent 记忆即文件系统」）的 `fs.*` 读写在 `server/src/resource/fs.rs` **已实现并接线**。M2 的「Agent 记忆」=`context_files` 上 `/memory/*` 约定子树的**策展视图（Memory 插件）**，**不新建表**。

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
- **connector 通路验证**：一条文档化的 happy-path —— 经 `cheers-mcp-server` *或* `cheers-acp-connector-rs` 接入 Claude/Codex，@提及、流式、断线重连。
- 可选：R6 delta 热路径优化（M0 测试就位后才安全）—— 非性能瓶颈则延后。

**验收门**：新用户能 建工作区/频道 → 邀请 → 发带 mention+文件的消息 → 接入外接 agent → @它 → 看它流式回复 → 刷新后看到完整历史。这就是可交付切片。

---

## M2 — 按范围裁剪的功能（体量取决于裁剪）

即 OVERVIEW 的 Phase 2，**也是必须刻意裁剪范围之处**。对每个 schema-only 功能，明确：*v1 进 / 延后 / 砍掉*。

**范围已拍板（2026-06-23）**——v1 = 统一工作台 + DM/topic；权限不实现；其余延后/砍。
**范围收窄（2026-06-24）**——**砍掉 topic**，会话域只做 **channel（已有）+ DM**。topic（频道内子话题/线程）从 v1 移除,需要时再单列里程碑。

> **概念锁定：没有独立的「memory」概念。** 平台只拥有**共享文件**（channel workspace = `context_files`）；bot 拥有它**自己**的记忆（外部 agent 的本地上下文），平台不碰、不抢——否则两份记忆争权威（external-agent-first 打破了奠基 doc「平台拥有 runtime」的前提）。agent 一律 **pull**；workbench 用**插件**策展若干「**Context**」=就是文件。详见 [context-and-environment.md](./context-and-environment.md) 的「现行模型」声明。

| 功能 | 需要 | v1 决策 |
|---|---|---|
| **统一工作台 + 插件系统**（workbench = 面板宿主；插件 = 初始化文件 + ViewPanel + `fs.*` 读写，即奠基的 Environment/Lens） | 后端 `ResourceRegistry` 重构（注册 verb，非 plugin）+ 前端 ViewPanel 注册 + `user→dispatch` 桥 + 2 个内置插件 | ✅ **进**（本里程碑核心） |
| ├ **File 插件** | 通用文件树 + 编辑器，读写 `context_files`（`fs.*` 后端已实现，缺 UI + 测试） | ✅ 内置 |
| └ **Context 插件**（取代「Agent 记忆」） | 策展特定共享文件（`project.md`/约定/术语表…）= Environment/Lens；**无独立 memory、无 push 正文**，agent 经 `fs.*` pull，存在性经系统提示告知（semantic） | ✅ 内置 |
| 安全 blocker（上 UI 前必做） | `fs.*` 写入硬大小上限 + 每频道配额；内容 inert 渲染防存储型 XSS；限制 member 的 `rm`/`mv` | ✅ 进（随工作台） |
| **DM**（私信会话域） | DM 频道的创建/成员/capability scope（channel.* 读动词已有,DM 复用 channel 模型） | ✅ **进**（范围收窄 2026-06-24:只做 DM,channel 已有） |
| ~~topic（频道内子话题/线程）~~ | — | ✂️ **砍**（2026-06-24 移出 v1；需要时单列里程碑） |
| 权限：Grant/trust_level | — | 📌 **标进 roadmap、不实现**——channel-role 唯一事实源，已在 [BOT_PERMISSION.md](./BOT_PERMISSION.md) 顶部标注废弃（R13） |
| 文档/RAG + `search` resource | 新 resource 动词 + 检索 | ⏸ **延后**（除非 RAG 成为卖点） |
| Lens 渲染 v1（`history_pages`）/ 公告页（`bulletin_issues`） | 渲染管线 + UI | ⏸ **延后** |
| todos / prompt_templates / keychain / ai_models | 各自 CRUD + UI | ✂️ **砍/延后** |

**验收门**：每个选入的功能 —— resource 动词 + handler + UI + 一条集成测试。**不得**把只有 schema 的功能标成「完成」。

---

## M3 — 加固 & 文档真相（~1 周，可与 M2 重叠）

R8 错误上下文（消灭 21 处 `map_err(|_| "db error")`）· R9 session 解析合并 · R10 sqlx `FromRow` 清理 ·
R11 拆 `bridge_runtime.rs`(2.5k)/`agent_bridge.rs`/`acp_capability.rs` · **孤儿占位回收器**（流程 8 缺口）·
R13 文档对齐（§2.6 差异表）。R12（UUID 列迁移）长期 / 可选。

---

## M3.5 — ACP 协议库采用（R14：typed schema → 官方 runtime）

connector ↔ ACP agent 这一侧原为**手写 JSON-RPC**（`acp_adapter.rs`）。分两档迁到官方 Rust 库，接缝 `RuntimeAdapter` trait 不变，blast radius = 单文件。详见 [ACP_RUST_SDK_ADOPTION.md](./ACP_RUST_SDK_ADOPTION.md)。

- **Tier A（已落地，2026-06-26）**：依赖 `agent-client-protocol-schema = "1.1"`（稳定 wire v1，无 `unstable` feature）。仅在安全敏感边界 typed —— `initialize` 能力宣告（`ClientCapabilities::default()` == 锁定姿态，类型断言）、`initialize` 响应解析、权限响应（wire-identical）。纯透传 payload（mcpServers / prompt content / session_update / tool_call）有意保持 `Value`。加 2 条回归测试钉住安全姿态与 wire 形态。
- **Tier B（规划，未启动）**：全量采用 `agent-client-protocol` runtime（1.0.0，2026-06-24 发布），删手写传输层（JSON-RPC + framing + 子进程），把 `RuntimeEvent` 重塑为 builder/callback/responder 模型。**触发门**：1.x 出 ≥1 patch 且无 API 破坏 · Send/线程模型确认可嵌入多线程 runtime · 重跑 `/security-review` 确认 fs/terminal 锁定不被库默认重开。

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
- [x] **M1** 核心闭环可演示 ✅ **2026-06-21 真机验证**（message→@bot→流式→持久化 + mention + 文件 + presence 全链路）
  - [x] 后端 CRUD 补洞（admin seed 引导 · messages `?since_seq=` 追平 · botToken 签发 `POST /bots/:id/token` · S3 网关代理上传/下载 + 桶引导）
  - [x] 前端实时 / 流式 / mention / 文件 / presence（全部 ✅）
  - [x] bot 管理 UI（Settings → Bots：注册 / 签发 token / 加入频道）
  - [x] connector happy-path 文档化验证（Rust connector + claude-code-acp 真机流式回复；见 [../DEMO_M1.md](../DEMO_M1.md)）
- [x] **M2** 功能裁剪 ✅ **收口（2026-06-24，已并入 develop `439c679a`）**——会话模型单级化（一切皆 channel），无独立 memory 概念
  - [x] **Slice 0 — 回归锁**：`resource::dispatch` + `fs.*` 的 verb 级回归测试 —— `server/tests/flows.rs` 绿
  - [x] ~~`ResourceRegistry` 重构~~ **YAGNI 延后**：v1 插件不新增后端 verb，保留 `match` 穷尽检查
  - [x] 后端：`user→dispatch` 桥（浏览器 WS `ResourceReq` 通道）+ 鉴权契约（member 的 `rm`/`mv` 收紧）
  - [x] 安全 blocker：`fs.*` 大小上限 + 每频道配额；inert 渲染防存储型 XSS
  - [x] File 插件：文件树 + 编辑器 + 渲染器选择，读写 `context_files`（+ 集成测试）
  - [x] Context 策展：pin（提示词注入）+ 全局/临时模板 + tab(views) —— 文件即 Context，无 push 正文
  - [x] **渲染器插件体系**（M2 中途扩展）：render/save 协议、接受判断、特异性、host API；两类插件拆分
  - [x] DM 会话域：DM = `type='dm'` channel + find-or-create + personal workspace + 前端 UI（迁移 0013–0016）。topic 已砍
  - [x] Grant/trust_level：**不实现**（channel-role 唯一事实源）
  - [x] 延后/砍：RAG · Lens/公告 · todos/templates/keychain/ai_models（有意裁掉）
- [x] **M3** 加固 & 文档对齐 ✅ **收口（分支 `feat/m3-hardening`，2026-06-25）**——加固项全部落地
  - [x] R8 错误上下文：内部错误改为 `tracing` 记录而非吞掉（`internal_err`/`db_err`/`log_db_err` 助手，76 处转换；输入校验类 `|_|` 有意保留；commit `e08e5bf1`）
  - [x] R9 session 解析合并：抽 `resolve_session_id` + 纯函数 `decide_explicit_or_entry`，`handle_done`/`mark_session_alive` 两处共用（4 来源优先级 + 6 单测；commit `16eae1f1`）
  - [x] R10 sqlx 样板削减：`messages.rs`/`dispatcher.rs` DTO 取数改 `query_as` + `#[derive(FromRow)]`（`try_get` 40→18；`stream.rs` 因严格/容错混用有意保留；commit `cda69f71`）
  - [x] R11 拆 `bridge_runtime.rs`（2.9k 行 → `mod`+`io`/`prompt`/`signing`/`frames`；commit `4377027c`）+ 拆 `RuntimeContext` impl（config/permission 组，`mod.rs` 1973→1576；commit `ae6f35e3`）
  - [x] 孤儿占位回收器（流程 8 缺口）：启动 + 周期扫描，仅回收「早于 threshold 且无存活流」的占位，finalize 为 `[bot offline]`（env 可调阈值，默认 15min；commit `1e644c8f`）
  - [x] R13 文档对齐：§2.6 差异表逐条处置（GATEWAY_CODE_ARCH 重写目录树、AGENT_BRIDGE_RESOURCE 刷新词表、BOT_PERMISSION 现状标注；commit `157d7087`）
  - [ ] R12 UUID 列迁移：长期 / 可选，未启动
- [ ] **M3.5** ACP 协议库采用（R14）—— 见 [ACP_RUST_SDK_ADOPTION.md](./ACP_RUST_SDK_ADOPTION.md)
  - [x] **Tier A** typed schema：`agent-client-protocol-schema = "1.1"`，安全敏感边界 typed（能力宣告 / init 响应 / 权限响应），纯透传 payload 保持 `Value`，+2 回归测试（2026-06-26）
  - [ ] **Tier B** 全量 runtime（`agent-client-protocol` 1.x）：待触发门（1.x 稳定 · Send 模型可嵌入 · security-review 复跑）
- [ ] **M4** 扩容（HA 触发）
