# ACP File System：能不能开启 + 由 connector 代理到本地/远程工作区？

> 版本：v1.0（2026-06-26）
> 结论先行：**对当前栈（`claude-agent-acp@0.36.1` + `claude-agent-sdk@0.3.143`）——不开。** 翻 `clientCapabilities.fs.*=true` 是 no-op 且会「撒谎」。本文记录裁决、证据、方案与取舍，供未来换 agent 时复查。
> 配套：[ACP_APPROVAL_FLOW](./ACP_APPROVAL_FLOW.md) · [AGENT_BRIDGE_ACP_COMPATIBILITY](./AGENT_BRIDGE_ACP_COMPATIBILITY.md) · [CLIENT_DAEMON_ARCHITECTURE](./CLIENT_DAEMON_ARCHITECTURE.md)

---

## 1. 问题

ACP 定义了两个 **agent→client** 文件方法：`fs/read_text_file`、`fs/write_text_file`，由 `clientCapabilities.fs.readTextFile/writeTextFile` 两个 boolean 门控。设想：Cheers 把它们开启，并在 **connector** 里实现 handler，把 agent 的文件读写**代理**到 owner 的本地工作区或某个远程工作区——从而**收口 + 审计** agent 的文件访问。

## 2. 可行性裁决：翻 fs capability 会改变 agent 行为吗？→ **不会**

扒了 `@agentclientprotocol/claude-agent-acp@0.36.1` 的 `dist/*.js`（证据带行号）：

1. `acp-agent.js:1045-1052` 的 `readTextFile`/`writeTextFile` 是 **agent 侧的 ACP 服务端 handler**（经 `AgentSideConnection` 暴露，`:2407`），只在**别的 client 调 agent** 时触发，**绝不会**被 agent 自己的 Read/Write/Edit/MultiEdit 工具调用。grep 全 dist，零内部调用点。
2. agent 真正的文件操作在 **spawn 出的 Claude Code CLI 子进程**里，用 Node 自带 `fs` 直接读写本地盘（`pathToClaudeCodeExecutable`，`:1444`），只受 `cwd`/`additionalDirectories`/`canUseTool` 约束。query() options（`:1412-1533`）里**没有任何 fs 代理回调**。
3. `claude-agent-sdk` 的 `Options` 类型（`sdk.d.ts:1158`）**没有** `readTextFile/writeTextFile/canReadFile` 之类选项——即使想委托也无 API 面。
4. `clientCapabilities` 虽被存储（`acp-agent.js:213`），但只读 `auth.*`/`terminal_*`；**`clientCapabilities.fs.*` 全程从未被消费**。

→ 把 Cheers 的 `client_capabilities().fs.*`（`config.rs:918-926`）翻成 `true`：对 claude-agent-acp 是**彻底 no-op**；更糟——宣称却不实现 handler，哪天换个真发 `fs/*` 的 agent 会撞上 `acp_adapter.rs:636` 的硬 `-32601`，等于**公开撒谎**。

> 适用范围：本裁决特定于 `claude-agent-acp 0.36.1 / claude-agent-sdk 0.3.143`。换 agent 或升 SDK 须复查（SDK 未来可能新增 fs 委托选项）。

## 3. 三个「即使硬实现也不行」

- **Bash 一句就绕过**：ACP fs 只覆盖类型化的 Read/Write/Edit，agent 还有 `Bash("cat …")`/`python`/`sed`。所以 ACP fs **永远不可能**成为 agent 文件访问的收口/审批/审计边界——天生是漏的。任何「把 agent fs 走审批」的安全论证，一个 Bash 调用就破。
- **未保存缓冲区语义错配**：ACP fs 的全部意义是服务编辑器**未保存缓冲区**。Cheers 无缓冲区，connector 服务的是**磁盘**——即使跑起来也违反契约（agent 以为读的是 IDE 打开的内容，实为已落盘版本）。若将来 Desk 暂存编辑，ACP fs 读到的磁盘会与 Desk 的活版本**分裂**。
- **审批回灌可能死锁**：在收到 `fs/write_text_file` 时先弹频道审批再应答——但 agent 正阻塞等这个 JSON-RPC 响应，ACP 状态机里没有「client 先问人类再答你 fs 调用」这一说，很可能触发 agent 端超时/死锁。

## 4. 方案对照（均受 §2 裁决制约，对当前 agent 无效）

| 方案 | 机制 | 复用 | 取舍 |
|---|---|---|---|
| **A 本地代理** | `handle_peer_request` 放开白名单，新增 `fs/*` 分支，复用 `handle_workspace_req` 的 `allowed_roots` 校验（`mod.rs:520`）。ACP 用**绝对路径**，需新增「绝对路径落入某 root」入口 | `WorkspacePolicy.allowed_roots`、canonicalize/`starts_with`/10MB 逻辑 | 引入**第三套文件命名空间**（绝对路径），与 Desk(PATH)/Inbox(FILE_ID) 冲突；写操作绕过审批/审计 |
| **B 远程代理** | B1=容器/沙箱（owner 机器内隔离 FS，符合 CLIENT_DAEMON_ARCHITECTURE §76-80）；B2=云 FS（**当前无此宿主**）；B3=映射到 `context_files`（**直接违反**「不要把平台资源伪装成本地 FS」AGENT_BRIDGE_ACP_COMPATIBILITY §229-232） | B1 同 A，root 指向容器卷 | 仅 B1 合规但需容器化；B2/B3 不采纳 |
| **C config 混合** | `acp_fs_mode: Off\|Local\|Remote`（默认 Off）+ `acp_fs_require_approval`（默认 true），按账户分派 | A/B 全部设施 + 现有 per-account TOML | 最灵活、回归最小；但仍受 §2 制约 |

### 对抗性复核抓到的硬伤（为何不现在做）
- **绝对路径 ↔ root 的 canonicalize 契约未定义**：agent 的 cwd 若是 symlink/bind-mount，绝对路径可能 `starts_with` 不上 root → 全部 `fs` 调用失败；且写新文件时 `canonicalize` 对不存在路径会报错（需「解析最深已存在祖先再校验」）。
- **命名空间消解的缓解打错了层**：「在 MCP instructions 里区分」只对**模型选 MCP 工具**有效；而 ACP fs 是 **CLI 子进程的工具透明发出的**，模型并不「选择」用 ACP fs——两个控制面不相交。
- **与现有 remote-workspace 浏览器重复**：会出现两条读写同一 `allowed_roots` 的代码路径，但鉴权不对称（人路径要频道成员；agent 路径无任何检查）。若抽公共 helper，必须带显式 `caller_trust` 参数。
- **审批/审计未建**：ACP fs 写对 Backend `resource` dispatch、capability 签名、`approval_audit` 全不可见；`channel_operations` 是平台文件专用，没有「agent 写了 `/abs/path`」的 schema。

## 5. 与现有 MCP 虚拟文件系统的关系

Cheers **故意**给 agent 两个**平台**命名空间，都走 MCP（`resource_req/res`），**不是** ACP fs：

| 命名空间 | 寻址 | 后端 | 工具 | 授权/审计 |
|---|---|---|---|---|
| **Desk** | PATH，可编辑，每频道虚拟 FS | `context_files` | `desk_*` → `fs.read/write/ls/edit` | Backend membership + `channel_operations` ✅ |
| **Inbox** | FILE_ID，只读聊天附件 | 对象存储 | `inbox_*`/`channel.files*` | membership ✅ |

MCP instructions（`mcp/main.rs:137-140`）已明确告诉模型这两处不是本地磁盘。再引入 ACP fs（OS 绝对路径）会复活架构反目标「把 local-fs 与 platform-file 合成一个概念」。**分工必须保持**：平台文件永远走 MCP；本地工作区文件归 agent 进程自身（owner 用 cwd/沙箱/容器约束）。

## 6. 推荐 + 现状

**推荐：方案 C 默认 `Off`，但当前只落地 Phase 0。** 其余推迟到树里真有「会发 `fs/*` 的 agent」再做。

### 已落地（Phase 0，2026-06-26）
- 保持 `client_capabilities().fs.* = false` + `terminal=false`（`config.rs:918-926`）。
- `acp_adapter.rs` 抽出 `peer_method_supported()`：唯一支持 `session/request_permission`，其余 `-32601`；带注释说明「fs/terminal 有意不实现」并指向本文。
- 回归测试 `only_request_permission_is_a_supported_peer_method`：断言 `fs/read_text_file`、`fs/write_text_file`、`terminal/*` 均不支持——**防止有人误开 capability 而不建 handler**。

### 不做
- B3（ACP fs → `context_files`）、B2（无宿主的云 FS）、以及**在未实现 handler 前翻 `fs.*=true`**。

## 7. 顺带修复的真 bug（独立于本题）

复核发现 **remote-workspace 浏览器的 write 路径有 symlink/TOCTOU 逃逸**（`bridge_runtime/mod.rs` write 分支）：原实现只 canonicalize **父目录** + 检查 `starts_with`，再 `join(filename)` 直接 `fs::write` —— 若最终组件是指向 root 外的 symlink，写入逃逸 `allowed_roots`。`read` 路径先 canonicalize 整个 target 再检查，安全；**只有 write 有洞**。

**已修**（2026-06-26）：write 前对最终 dest 做 `symlink_metadata`（no-follow）——是 symlink 则拒（`E_FORBIDDEN_PATH`），是已存在实体则再 canonicalize 复核在 root 内，新文件在已在 root 的 canonical 父目录下安全创建。残留（亚毫秒 TOCTOU、hardlink）已注释，若此路径将来由 agent 驱动应升级为 `O_NOFOLLOW`。

---

## 附：关键 file:line
- 裁决证据：`/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`（:1045-1052 agent-side fs handler；:1412-1533 query options 无 fs；:1444 spawn CLI；:213 clientCapabilities 仅存不读 fs）
- capability 声明：`packages/cheers-acp-connector-rs/src/config.rs:918-926`
- chokepoint + 测试：`packages/cheers-acp-connector-rs/src/acp_adapter.rs`（`peer_method_supported` + `-32601` 分支 + 回归测试）
- write 修复 / workspace 读写：`packages/cheers-acp-connector-rs/src/bridge_runtime/mod.rs:520-680`
- 既有 remote-workspace：`server/src/api/workspace.rs`、`server/src/gateway/workspace_rpc.rs`
- 平台虚拟 FS：`server/src/resource/fs.rs`、`packages/cheers-mcp-server/src/main.rs:137-140`
</content>
