# Cheers 代码库分析报告

- **分析对象**：`develop` 分支，**HEAD `f13c0edd`**（工作区干净）
- **分析时间**：分析过程中远端 rebase 把 HEAD 从 `b39f1b3e` 推到 `f13c0edd`；本报告所有结论已重新钉在 `f13c0edd`，其中经我本人复验的关键项已标注
- **方法**：静态阅读（主）+ 实际执行工程门禁（可验证项一律跑过，不靠推断）
- **说明**：本文件是分析产物，不属于代码库的一部分，可随时删除

---

## 0. 我实际执行过的验证（ground truth）

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 编译（含测试目标） | `cargo check --all-targets` | ✅ 通过，无告警 |
| Rust 单元测试 | `cargo test` | ✅ **480 passed / 0 failed**（2.1s） |
| Rust 格式 | `cargo fmt --check` | ✅ 通过 |
| Rust lint | `cargo clippy --all-targets --features integration` | ✅ 仅 **1 条**告警（`api/mcp.rs:3716` 常量断言） |
| 前端类型 | `npm run typecheck` | ✅ 0 error |
| 前端测试 | `npm run test` | ✅ 143 文件 / 917 测试全通过（3.2s） |
| 前端 lint | `npm run lint` | ⚠️ 0 error / **126 warning** |
| 设计系统 | `npm run design-system:check` | ✅ 通过（47 item kinds 契约有效） |
| 前端安全 | `npm run security:check` | ✅ 3 测试通过 + `npm audit` **0 vulnerabilities** |
| 连接器 | `cargo fmt --check` / `cargo test` / `cargo check` | ✅ **170 passed**，全部通过 |

> 注：rebase 后前端测试文件由 143 → 144（测试数 917 → 923）。上表数字是我执行时的快照。

---

## 1. 代码规模与结构

### 1.1 体量（git 跟踪文件）

| 语言 | 文件 | 行数 |
|---|---:|---:|
| Rust (`.rs`) | 209 | 105,415 |
| TypeScript (`.ts` + `.tsx`) | 508 | 84,632 |
| Swift (`.swift`) | 58 | 25,441 |
| SQL（迁移） | 102 | 3,281 |
| Kotlin (`.kt`) | 26 | 3,810 |
| Markdown | 222 | 38,724 |

关键比例：**代码 ~19.5 万行，文档 ~3.9 万行（约 20%）**。文档密度很高，而且是双语（46 个 `*.zh-CN.md` 镜像）。

### 1.2 六大子系统

```
server/                          Rust 网关（唯一后端，73,199 行 src）
  ├─ src/api/        29,748 行   REST + MCP HTTP + OAuth（40 文件）
  ├─ src/domain/     22,176 行   业务逻辑：会话/提及/链/ACP 策略/审批/集成
  ├─ src/gateway/    10,530 行   浏览器 WS + Agent Bridge WS + 扇出 + 后台任务
  ├─ src/resource/    4,874 行   类型化资源协议（bot 读写平台状态的唯一入口）
  ├─ src/infra/       1,978 行   PG/S3/邮件/APNs/限流/加密
  └─ src/notify/      1,139 行   APNs + relay
frontend/                        React 18 + Vite + Tailwind（83,858 行）
packages/cheers-acp-connector-rs/  Rust ACP 连接器守护进程（20,290 行）
packages/cheers-mcp-server/        Rust 共享库：资源词汇表 + 31 个 MCP 工具（2,055 行）
packages/cheers-workbench-sdk/     TypeScript 扩展 SDK（353 行 TS）
apps/{macos,ios,android}/          Tauri 外壳 / SwiftUI / Compose 三端
```

### 1.3 核心架构：一个进程，三张面孔

这是本代码库最重要的设计决策，而且**它是真的**：

- 一个 `axum::serve`（`server/src/main.rs:335`）同时服务 **252 条路由**（199 认证 + 42 公开 + 8 认证流 + 3 WS）。
- 浏览器 WS、Agent Bridge WS、REST、MCP 共享同一个 `AppState`（`server/src/app_state.rs:17-42`）。
- **关键收口点**：`server/src/gateway/resource_effects.rs:49` 的 `dispatch_with_effects`。`resource::dispatch` 被刻意设计成纯 DB 操作（`resource/mod.rs:166` 只收 `&PgPool` + `Principal`），所有副作用（广播 + 触发 bot）集中在上层。该模块头部注释直接点名了它要防的 bug：新传输层若直接调 `dispatch`，会「落库成功但静默不广播、不触发 bot」。
- 依赖方向靠约定而非 crate 边界维持：`domain`/`resource`/`infra` 基本不反向依赖 `gateway`/`api`，只有两处例外（`domain/auth.rs:5` 引 `api::middleware::Claims`；`infra/web_push.rs:25` 引 `app_state::AppState`）。

**协议分三层，各有权威**：
1. `bridge-protocol`（Rust 共享 crate，`packages/cheers-acp-connector-rs/bridge-protocol/src/lib.rs`，1,327 行）——网关 ↔ 连接器线协议，`BRIDGE_PROTOCOL_VERSION = 1`，四个 internally-tagged 枚举带 `#[serde(other)] Unknown` 前向兼容，关闭码 4400/4401/4402/4403。**每个网关→连接器帧都是具名构造函数 + golden fixture**（`gateway/bridge_frames.rs`），fixture 可 `CHEERS_REGEN_FIXTURES=1` 重生成。
2. `resource_req`/`resource_res` 信封——bot 读写平台资源（35 个资源 = 33 个 DB 路由 + `workspace.read` 代理 + `locator.read` 归一化）。
3. 浏览器 WS——channel-scoped 订阅 + `seq` 去重排序。

---

## 2. 做得好的地方（有证据）

这部分不是客套，是代码里能验证出来的强项：

1. **线协议保护得极好。** 共享 crate + golden fixture + 两端对称的严格版本协商（`bridge_session.rs:402-414` ↔ `agent_bridge.rs:2663-2696`），且 `bridge-protocol/src/lib.rs:12-28` 明确列出「哪些改动不安全」。这是整个仓库防护最严密的地方。
2. **工程门禁齐备且真的在跑。** `ci.yml` 8 个 job：Rust fmt、Rust 单测+集成测（真实 Postgres 16）、MCP 2026-07-28 一致性、前端 9 道检查（design-system / lint / security / typecheck / test / build / Docker）、连接器、桌面端、iOS 真机编译。还有 `main-source-gate.yml` 强制「进 main 的 PR 必须来自 develop」。
3. **Rust 代码质量高。** clippy 仅 1 条告警、**零 `unsafe`**、FIXME/HACK **零**、`src/` 内 TODO **仅 1 条**（`domain/bot_status_scheduler.rs:17`）。742 处 `sqlx::query(` 中，16 处 `format!` 拼接**全部只拼编译期常量列名**，用户数据一律 `$n` 绑定——无注入面。
4. **并发正确性有意识地做了。** 任务派发用 UUID v5 确定性占位 id + `INSERT … ON CONFLICT DO NOTHING` 做幂等仲裁（`dispatcher.rs:242,260`）；审批用原子 CAS 作为「人类 HTTP 审批」与「连接器超时取消」的唯一仲裁者（`api/approval.rs:284`）；流式 delta 有 R1 归属/R2 后端盖章 seq/R3 不建占位/R4 finalize 守卫四条规则；`claim_finalize` 在 DashMap 分片写锁内读改写。
5. **安全基线扎实（我逐项核对过）。** JWT 固定 RS256 + `set_issuer` + **每请求**复查撤销/封禁/删除/token_version（`api/middleware.rs:85-111`）；CORS 失败即关闭（显式 allowlist，绝不 `AllowOrigin::any`）；CSRF 会话绑定 + SHA-256；cookie `HttpOnly` + `Secure` + `SameSite=Lax`；bcrypt 走 `spawn_blocking`；密钥 AES-256-GCM 落库；webhook 恒定时 HMAC 比较。**未发现 SQL 注入、未发现路径穿越、未发现提交进仓库的密钥**（`.env`、`*.pem` 均已 gitignore，只有连接器**公钥**例外）。
6. **`.env` 未被跟踪**，gitleaks 白名单只放行了一处文档里的占位 PEM。

---

## 3. 发现的问题（按优先级）

### 🔴 P0 — 连接器配置 schema 下限未同步抬升（发布安全，会重现 #538 事故）

**这是本次分析时发现的高危项；发布状态随后已有更新。**

> **后续状态（2026-10-08）**：connector `0.1.50` 已正式发布，包含解析新配置字段所需的版本；下方工作区改动把网关最低接受版本从 `0.1.41` 提高到 `0.1.49`，拒绝 `0.1.48` 及更早的旧连接器。该门槛修复尚待合入和部署。原表格记录的是报告所钉定的 `f13c0edd` 快照，不代表当前发布清单。

AGENTS.md 明文规定：*「在新增旧二进制会拒绝的配置字段的同一个改动里，抬升 `MIN_CONNECTOR_VERSION`」*。这条被漏掉了：

| 环节 | 证据 |
|---|---|
| 网关现在会渲染新字段 | `server/src/domain/connector_config.rs:478` 无条件输出 `auto_allow_cheers_mcp = true`（模板第 469-485 行，非条件分支） |
| 旧连接器**不是忽略而是拒绝**整个配置 | 该表用 `#[serde(deny_unknown_fields)]` 解析（`packages/cheers-acp-connector-rs/src/config.rs:506-507`，字段在 `:518`） |
| 该字段只存在于未发布的 HEAD | 引入提交 `2dd3bca4`；`git tag --contains 2dd3bca4` → **空** |
| 最新连接器 tag 不认识该字段 | `git show connector-v0.1.48:packages/cheers-acp-connector-rs/src/config.rs \| grep -c auto_allow_cheers_mcp` → **0** |
| 下限常量仍是旧值 | `server/src/api/pairing.rs:663` `MIN_CONNECTOR_VERSION = "0.1.41"`（HEAD 与 v0.1.48 都是这个值） |
| 能解析的二进制尚未发布 | HEAD 连接器 `Cargo.toml` 为 `0.1.49`，无 `connector-v0.1.49` tag |

**后果**：一旦网关发布带着 HEAD 渲染器、而 `CHEERS_CONNECTOR_RELEASE_VERSION` 仍指向 0.1.48（或未设置时走 `pairing.rs:702-706` 的「取最新」），新装机下载 0.1.48 → 启动即 TOML 解析失败 → 崩溃循环。下载代理与 `install.sh` 都不会拦（下限还是 0.1.41）。

**修复**：在发布该渲染器的同一改动里把 `MIN_CONNECTOR_VERSION` 抬到 `"0.1.49"`；并保证 `connector-v0.1.49` 已 tag → `manifest` 已签名 → `sync-pin` 已执行，**然后**才部署网关镜像。

> 注意：`scripts/version_control.py check` 退出码 0，connector 0.1.49 ≠ 根 `VERSION` 0.1.48 是**设计如此**（四个独立组件组）。真正的缺口是那个下限常量，不是版本号不一致。

---

### 🟠 P1 — 门禁存在「配了但没接」的漏洞

| # | 问题 | 证据 |
|---|---|---|
| 1 | **gitleaks 配了但从未执行**——密钥扫描在流水线中实际不存在，也没有 pre-commit 兜底 | `.gitleaks.toml` 存在；`grep -rn gitleaks .github/ Makefile scripts/` → **无任何引用**（我复验） |
| 2 | **clippy 非阻塞**，`\|\| true` 吞掉所有告警；`make lint` 也无 `-D warnings` | `ci.yml:149`。讽刺的是**实际只剩 1 条告警**，直接开成阻塞项即可 |
| 3 | **59 个 Rust 测试在 CI 中从不运行**：mcp-server 29 个、macOS Tauri 31 个，CI 只做 `cargo check` | `ci.yml:302`（我已复验）、`ci.yml:341` |
| 4 | **鉴权没有端到端测试**：`router.rs` 1,221 行仅 2 个 CORS 测试，没有一条「未认证访问受保护路由必须 401」的断言；`middleware.rs` 仅 1 个测试；`api/apple_auth.rs` 866 行 0 测试 | `router.rs:1165,1201` |
| 5 | 无 Rust 依赖 CVE 扫描（无 `cargo audit`/`cargo deny`）；`cd.yml` 推镜像无扫描/签名/SBOM | 仅前端 `npm audit` |
| 6 | 无 Android CI 通道（26 个 Kotlin 文件可静默损坏）；dependabot 监听已删除的 `/backend` pip 路径、却漏掉 `server/` 的 cargo | `.github/dependabot.yml:8-9` |
| 7 | 门禁自身的测试文件不在变更映射里——改门禁不会触发该门禁 | `.github/ci-paths.json:29` |

### 🟠 P1 — 前端「零交互测试」

- **无 jsdom / happy-dom / @testing-library**（我复验：`frontend/package.json` 中一个都没有），也**没有 vitest 配置**。
- 因此 143 个测试文件里约 60 个是 `renderToStaticMarkup` 的 SSR 标记断言（`floating-panel.test.tsx:16` 自己承认了这点）。**没有任何 `fireEvent`/`userEvent`**，hooks、effect、事件处理完全未被执行。
- 覆盖空洞：`auth`（7 文件，含登录/注册/重置/StepUp/Apple OAuth）**0 测试**；`fleet`、`friends`、`invite`、`permissions`、`activity` 各 0；`src/api/` 32 个模块只测了 7 个。
- 好消息：纯逻辑测试覆盖不错（chat 73 个测试文件），且**全部 917 个测试通过**。

### 🟡 P2 — 集中化与重复代码

**Rust 侧：**

- **17 个文件 > 1000 行**，其中两个已无明显接缝：
  - `api/mcp.rs` 3,718 行（**生产 3,196**）——把 MCP 双时代协议、OAuth AS 与令牌签发、工具/资源目录、**以及一整套 MCP 一致性 fixture 工装**（`TEST_PNG_BASE64` + 20 个 `test_*` 工具）塞在一起。
  - `gateway/ws/agent_bridge.rs` 3,034 行（**生产 3,011，测试仅 23 行**）——WS 认证+生命周期、约 20 个 data 帧处理器、能力校验、三个各自手写事务的卡片创建处理器。
- **`ensure_channel_member` 被近乎逐字重写 6 次**（`api/approval.rs:113`、`api/session_control.rs:24`、`api/messages.rs:590`、`api/compliance.rs:473`、`api/files.rs:220`、`api/workspace.rs:231`），其中 3 处仅函数签名不同。另有第 7、第 8 个变体。**全仓库 101 处各自手写 `FROM channel_memberships` 查询**，没有共享的成员访问类型。
- **8 处 `lock().unwrap()` 的互斥锁中毒 panic**（`gateway/presence.rs:44,60`、`api/messages.rs:109,123,129,161`、`notify/apns.rs:181,197`）——讽刺的是 `agent_bridge.rs:1387,1395` 已经写对了模式（`if let Ok(guard)`），照抄即可。
- `gateway/dispatcher.rs:766` 在**任务派发热路径**上有 `.expect("attachment objects fit AttachmentInfo")`——wire 结构一改就是运行时 panic，而不是降级派发。
- **两处失败方向有问题**：`allowed_seers` 在权限规则读失败时**返回全部在线用户**（fail-open，`agent_bridge.rs:1417`）；`bot_has_active_delegation` 在 DB 错误时返回 `false`（`:2849-2851`），等于**关掉**能力校验而非关闭（fail-closed）。
- `agent_bridge.rs:1063-1087`：`resume` 只回 ACK、事件重放未实现，断连期间丢的帧不可恢复，只打 `warn!`。这是桥接路径上最实质的功能缺口。

**前端侧：**

- **react-query 名义上是技术栈，实际只用了 2 个文件**（`ProfileSettings.tsx`、`AccountSettings.tsx`），共 5 个 query + 6 个 mutation。消息、频道、bot、fleet、好友、文件全部是手写 `useState` + `useEffect` + 模块级缓存（`chatCache.ts` 自研 LRU、`composerDrafts.ts`、`sessionControlsCache.ts`）。宣称的技术栈与实际架构在此分叉，付出了两套范式的成本却没拿到任一边的收益。
- **三个互不相干的 WebSocket 客户端**，各自复制了退避/重连/认证重试逻辑：`useChatRealtime.ts`(629)、`useUserSocket.ts`(133)、`useFleetLive.ts`(79)。协议一改要改三处。
- **22 个 >700 行的组件**，最大的是 `RemoteWorkspaceDialog.tsx` **2,135 行 / 单组件 29 个 `useState` + 17 个 `useEffect`**（文件编辑 + 冲突解决 + git，属全应用爆炸半径最大且无测试的面）。
- `any` **真的是 0**（唯一命中是注释里的英文单词「any」）。真实类型风险是 `WsEvent.data: Record<string, unknown>` 在单一帧分发 switch 里的 4 处 `as unknown as` 强转。
- 可访问性**在配置层被降级**：`eslint.config.js:7-9` 把所有 `jsx-a11y` 规则设为 `"warn"`，所以 33 条 label 关联、18 条点击/键盘处理告警永远无法让 CI 失败——而 `DESIGN.md:726` 的禁忌清单里恰好禁止「可点击的 `<div>`」。
- 设计系统门禁有个洞：`nonStandardRadius` **上限 73、实际 18**（我复验），CI 还允许再犯 55 次；18 处里 **12 处集中在 `PermissionsPage.tsx`**，而该文件其他方面堪称模范。

### 🟡 P2 — 迁移与版本纪律的细颗粒问题

- 102 个迁移 `0001..0102` **编号连续、无重复、无缺口**，`IF NOT EXISTS` 普及率高，破坏性 DDL 全部有守卫。**但有 4 处违反项目自己的强制规则**：`0048_workbench_plugin_origin.sql:11,17`、`0074_mcp_oauth_refresh_families.sql:4,13` 缺 `IF NOT EXISTS`。
- `0051_user_devices.sql:5` 的 `device_id UUID PRIMARY KEY` 是 102 个迁移里**唯一**的 UUID 主键，违反 `VARCHAR(36)` 规范（因网关按 String 读而掩盖了漂移）。
- 历史上存在**修改已应用迁移**的提交（最近一次 2026-06-26），这正是 sqlx 校验和不匹配的隐患；近三个月未再发生。

### 🟡 P2 — 三端客户端 N 倍重复

| 层 | Web | macOS | iOS | Android |
|---|---|---|---|---|
| REST 客户端 | `src/api/*` 33 文件 4,187 行 | 复用前端 | `APIClient.swift` **1,500 行 / 167 函数 / 52 条路径** | `CheersApi.kt` 12 条路径 |
| 实时 WS | `useChatRealtime.ts` 629 | 复用前端 | `ChatSocket.swift` 499 | `ChatSocket.kt` 227 |
| DTO | `types/index.ts` 429 | 复用前端 | `DTOs.swift` **2,642** | `Dtos.kt` 165 |
| 设计 token | CSS | 继承 | `Theme.swift` 264 | 3 个 Kotlin 文件 390 |

- **同一批关注点被实现 3–4 次**（实时、认证刷新、DTO 字段名、设计 token）。Android 的 socket 注释直接写「协议以 `frontend/src/features/chat/hooks/useChatRealtime.ts` 为准」（`ChatSocket.kt:49-52`）——靠注释同步。
- **仓库里没有任何 OpenAPI/Swagger/schema 产物**。唯一被机器保护的契约是 Rust 的 `bridge-protocol` fixtures（仅连接器↔网关）和 `frozen-tool-catalog.json`（仅 MCP 工具表）；**浏览器 `/ws` + `/api/v1` 契约无人守护**。
- iOS 24,784 行 Swift vs Android 3,810 行 Kotlin——**6.5 倍差距**，且 **Android 完全没有 CI、没有发布流程、不被 `version_control.py` 跟踪**（versionName 还是 `0.1.0`）。
- macOS（Tauri）做得最对：**零重复**，直接把 `frontend/dist` 当 webview，唯一的自研网络面是原生认证（522 行，refresh/CSRF 存 Keychain）。但它用手工结构体镜像了连接器的 `daemon.json`（`connector.rs:27-33`），改 schema 会静默失配——正是 `bridge-protocol` 当初要消灭的那类问题。

### 🟢 P3 — 文档漂移

文档整体质量高（33 个 README 链接全部有效、无一断链，废弃模型都带 ⚠️ SUPERSEDED 标注），但仍有具体漂移：

| 说法 | 实际 |
|---|---|
| AGENTS.md/CLAUDE.md：「集成测试正在重建」 | 已存在且相当可观：`server/tests/` 65 个测试（`flows.rs` 单文件 4,190 行 / 58 个 `#[sqlx::test]`），CI 已在跑 |
| 「集成测试须从 `INTEGRATION_BASE_URL` 读 URL」 | 该变量**只出现在文档里**，代码/脚本/CI 中零引用（实际用 `DATABASE_URL`） |
| `cargo test` / `make test` 是网关检查方式 | `integration` feature 默认关闭，**本地会静默跳过全部 65 个集成测试**——本地绿 ≠ CI 绿 |
| AGENTS.md 主张 `docker compose up` 为全栈路径 | CLAUDE.md 说 Helm/kind 才是规范、compose 是遗留回退——**两份 AGENTS 文档互相矛盾** |
| README：`GET /files/:id/preview` | 实际是 `/api/v1/files/:file_id/preview`（`router.rs:744`） |
| PR 模板检查项「本地 pytest 全量通过」 | pytest 随 Python 后端一起移除，模板未更新 |
| `.github/pull_request_template` 与 CONTRIBUTING 只要求 `cargo build && cargo test` + 前端 build | CI 还强制 typecheck/test/lint/design-system/security——照文档做会挂 CI |

---

## 4. 建议的行动顺序

**立即（发布前必须）**
1. 抬升 `MIN_CONNECTOR_VERSION` 到 `0.1.49`，并与连接器 tag → 签名 manifest → `sync-pin` 排好序（P0）。

**高杠杆、低成本**
2. 把 gitleaks 接进 CI（`.github/workflows/ci.yml`），并考虑 pre-commit 兜底。
3. clippy 去掉 `|| true` 改成阻塞——**实际只有 1 条告警**，成本几乎为零。
4. 在 CI 里给 `cheers-mcp-server` 和 `apps/macos/src-tauri` 加 `cargo test`（59 个测试白拿）。
5. 把 `nonStandardRadius` 上限从 73 收到 18，顺手改掉 `PermissionsPage.tsx` 的 12 处 `rounded-md/lg`。
6. `agent_bridge.rs:1387,1395` 的正确锁中毒模式照抄到另外 8 处 `lock().unwrap()`。
7. 修掉文档漂移：集成测试状态、`INTEGRATION_BASE_URL`、`make test` 与 CI 不一致、PR 模板 pytest 项、AGENTS 与 CLAUDE 的 compose/Helm 矛盾。

**结构性（需要排期）**
8. 抽出唯一的 `channel_membership` 访问类型，删掉 6 份重复实现并收口 101 处查询。
9. 合并三个 WebSocket 客户端为一个连接管理器 + 类型化帧联合——顺手把 `WsEvent.data` 的检查收到一个边界。
10. 前端二选一：真用 react-query 管服务端状态，或删掉依赖与 `QueryClientProvider`；当前中间态最差。
11. 拆分 `api/mcp.rs`（OAuth AS / MCP 传输 / 一致性工装）与 `agent_bridge.rs`（传输 / 卡片创建）；拆 `RemoteWorkspaceDialog.tsx`(2,135)。
12. 决定 `resume` 的去向：要么补 `event_log` 重放，要么让 `server_capabilities.resume` 如实回答「none」，不要保持「ack_only + 静默丢帧」。
13. 为前端引入 jsdom + Testing Library，优先补 `auth`；为 `router.rs` 补「未认证 → 401」的路由级测试。
14. 产出一份机器可读的网关契约（OpenAPI 或受版本控制的 JSON Schema），给 Android 加 CI job。

---

## 5. 一句话结论

**这是一个工程质量明显高于其"早期公开预览"自我定位的项目**：线协议有共享 crate + golden fixture 守护，Rust 侧零 `unsafe`、clippy 几乎全绿、480 单测 + 65 集成测全过，安全基线（JWT 撤销复查、CORS 失败即关、CSRF、bcrypt、AES-GCM、恒定时间 HMAC）逐项核对无硬伤，迁移编号纪律良好。**它的问题是"长大得太快"而不是"做错了"**：schema 五个月加了 102 个迁移，于是出现了 3,000 行的 MCP 文件、6 份复制的成员校验、三套 WS 客户端、以及一个漏抬的配置 schema 下限。**唯一需要立刻处理的是 P0 那个发布顺序缺口**——它的失败模式（新装机崩溃循环）已经在 #538 上演过一次。
