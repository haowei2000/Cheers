---
title: Cheers Native HTTP MCP、Installation 与 ACP 改造完成报告
date: 2026-08-13
tags:
  - Cheers
  - MCP
  - OAuth
  - ACP
  - Connector
  - Installation
status: implemented-with-compatibility-gate
---

# Cheers Native HTTP MCP、Installation 与 ACP 改造完成报告

## 结论

代码改造已经完成：Cheers 的 Agent 工具面从 Connector 本地 stdio MCP 强制切换到 Gateway 原生 Streamable HTTP MCP + OAuth；Connector 不提供 OAuth proxy、stdio sidecar、静态 Bearer 或自动 transport 回退。ACP Agent 仍是 Connector 拉起的本地 stdio 子进程，这只是 Connector→Agent 的 ACP 传输，与 Agent→Gateway 的 HTTP MCP 是两条独立边界。

这不等于“四个 Agent 的八条 OAuth 生命周期用例已经全部通过”。真实证据显示四个固定版本都声明 HTTP MCP capability；Codex 1.2.0 也接受 headerless HTTP MCP session，但随后明确要求用户执行 `codex mcp login cheers`。四个 Agent 目前没有统一、公开的 client-credentials credential-provider 契约。因此产品策略是：原生支持者走 Agent 自己的显式登录流程；不支持者失败关闭，不由 Cheers 私下补齐或降级。

## 最终数据流

```text
Browser / Mobile
        │ REST + browser WS
        ▼
Gateway ── task / delta / done ── Connector ── ACP v1 stdio ── Agent
   ▲                                                           │
   └──────── Streamable HTTP MCP + installation OAuth ─────────┘

Gateway ── workspace_req ── owner Connector ── local file read
        ◀─ workspace_res ───┘
```

`workspace_req/workspace_res` 有意保留：远程 `read_workspace` 的文件在 owner Connector 所在机器，Gateway 必须通过这一最后一跳读取。它不是 MCP transport fallback。

## 已完成的改造

### Installation 与 OAuth

- Connector 配置要求 installation credential，拒绝旧 bot token。
- Gateway hello 在已认证控制通道下发 canonical `mcp_url`。
- Agent session 只收到 `name + url + empty headers` 的 HTTP MCP 配置。
- Gateway 将 token 绑定到 installation、Bot、audience、scope；频道 membership/role 继续是最终授权边界。
- 支持 RFC 9728 protected-resource metadata、OAuth discovery、Authorization Code + PKCE、refresh family rotation、Client Credentials 与 installation 撤销后立即 401。
- Connector 不持有 MCP access/refresh token，也不会为 Agent 注入静态 Authorization header。

### MCP 工具面

- Gateway `/mcp` 是唯一活跃的 Cheers MCP 工具面。
- 远程 catalog 包含 `read_workspace`，最后一跳复用 `workspace_req/workspace_res`。
- 新附件只允许 `inbox_deliver`，直接上传到 Gateway/S3。
- `inbox_stage`、`realize_file`、Connector pending resource map、loopback server、stdio sidecar 进程入口及其 release asset 已删除。
- `Done.file_ids` wire 字段暂时保留为空数组以维持 Cheers Bridge v1 shape；runtime 不再保留无写入者的 `created_file_ids` 状态。

### 历史 staged 文件

- migration `0075_retire_staged_attachments.sql` 将历史 `status='staged'` 标为 `expired`，清除 `remote_ref` 并写入 `expires_at`。
- 这些记录只有 Connector 本地路径而没有 Gateway 可访问的字节，无法安全自动迁移；Web 不再尝试 realize。
- 迁移已在一次性 PostgreSQL 16 上验证：首次更新 1 行，重复执行更新 0 行，最终断言 `expired | remote_ref is null | expires_at is not null`。

### ACP runtime 与 Elicitation

- `agent-client-protocol = 2.0.0`，只协商 stable `ProtocolVersion::V1`，启用 v1 `unstable_elicitation` schema，不启用 MCP-over-ACP。
- official SDK runtime 是 0.1.37 默认；legacy 只作为该版本 ACP transport 回滚窗口。该回滚只影响 ACP framing/runtime，不会恢复 stdio Cheers MCP。
- `RuntimeAdapter` 管生命周期/session/config/auth，cloneable `PromptClient` 管并发 prompt，immutable `AgentCapabilities` 集中表达能力，factory 返回 trait object。
- `session/update`、`session/request_permission` 与 `elicitation/create` 在 raw/untyped 边界保留未知 update 和 `_meta` 字段；稳定出站请求使用官方 typed API。
- session-scoped 与可信 human-origin request-scoped elicitation 已贯通 Connector、Bridge、Gateway、持久化 Web DTO 和 UI；敏感 form schema 与不可信 URL fail closed。

### 性能与并发

- Delta 按 12ms/8KiB 合并，减少 JSON serialization、WebSocket frame 与 Gateway 压力。
- streaming 与 permission/elicitation 使用独立有界队列，交互事件不被 Delta 洪峰排队。
- `SharedRuntimeState` 拆为多个锁域；Delta frame 在 run lock 内计算，Bridge I/O 在释放锁后 await。
- 高频 JSON relay 使用 move/subtree extraction，减少 `serde_json::Value` clone。
- official runtime 的 prompt/control actor 有独立并发上限，饱和时显式失败，不无限 spawn。

## OAuth 真实兼容性证据

固定版本的 ACP initialize 结果：

| Agent | 固定版本 | HTTP MCP capability | 完整 OAuth 生命周期 |
|---|---:|---:|---|
| Codex ACP | 1.2.0 | 是 | 未通过；需要显式 `codex mcp login cheers` |
| Claude Agent ACP | 0.66.0 | 是 | 待真实 consent/refresh/restart/revoke 验收 |
| Gemini CLI ACP | 0.55.1 | 是 | 待真实 consent/refresh/restart/revoke 验收 |
| OpenCode ACP | 1.18.18 | 是 | 待真实 consent/refresh/restart/revoke 验收 |

Client Credentials 模式没有通用标准输入。Harness 明确拒绝把 installation secret 塞进自创环境变量；只有 Agent 提供公开 credential provider 时才可测试。因此“原生 HTTP 实现完成”和“所有 Agent 版本可用”必须分开陈述。强制 HTTP 下，未完成自身 OAuth 的 Agent 版本就是不受支持，而不是触发 fallback。

## 验证结果

- Connector：`cargo fmt --check`、`cargo check --locked`、`cargo test`（130 passed）、`cargo build --release --locked` 全通过。
- Gateway：`cargo fmt --check`、`cargo check --locked`、`cargo test`（273 passed）全通过；仅有 5 条既有 warning。
- MCP shared crate：fmt/check、9 tests 全通过。
- Frontend：生产 build、38 test files / 213 tests 全通过。
- Spike harness：shell syntax 与 10 个 Node tests 全通过，覆盖 secret redaction、失败分类、command pinning、八矩阵 dry-run、端口/案例隔离和拒绝未文档化 credential 注入。
- 0075 migration：PostgreSQL 16 定向幂等验证通过。

## 发布判断

本分支已经达到“架构与代码完成、失败关闭”的状态，但尚不应宣称四 Agent 全兼容，也不应据此删除 0.1.37 的 legacy ACP runtime。发布前仍需：

1. 为目标 Agent 逐个完成交互式登录、真实 `get_channel_info`/`post_message`、十分钟刷新、Agent 重启恢复和 installation revoke 401。
2. 对没有公开 Client Credentials provider 的 Agent，把该模式标记为 unsupported；不要用私有补丁制造通过。
3. 完成 Codex/Claude × macOS/Linux 至少 7 天观察且无 P0/P1 后，再发布 0.1.38 删除 legacy ACP transport。
4. 按 connector release 顺序生成 tag、locked targets、签名 manifest，最后再更新 Gateway 的 `CHEERS_CONNECTOR_RELEASE_VERSION`。

## 关键提交

- `549bacde` — require native HTTP MCP transport
- `b1758160` — adopt official ACP runtime and add elicitation
- `124340cc` — bound runtime and streaming concurrency

## 核心理念

协议库负责协议，Cheers 负责产品语义；身份与授权绑定 installation，而不是隐藏 token；MCP 直达 Gateway，Connector 只编排 ACP 与本地 workspace；能力不兼容就明确失败，不用兼容层把安全边界和运维状态变得不可解释。
