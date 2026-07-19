# 移动 App 设计

> **语言**: [English](MOBILE_APP_DESIGN.md) | 中文
>
> **状态**: 草案 · **日期**: 2026-07-17 · **修订**: 2026-07-19 · **负责人**: haowei

> ## ⚠️ 先读这里 —— 本文中 Expo 相关部分已被取代
>
> 本设计当初是为 `apps/mobile/` 下的 Expo（React Native）App 写的。**2026-07-19** 该方向
> 已放弃：移动端客户端是 **`apps/ios` 的原生 SwiftUI App**，`apps/mobile/` 不会被创建。
> 见 [MOBILE_CLIENT_STRATEGY.zh-CN.md](MOBILE_CLIENT_STRATEGY.zh-CN.md)。
>
> | 章节 | 状态 |
> |---|---|
> | 产品/UX 设计、屏幕、信息架构 | **有效** —— 与平台无关，用 SwiftUI 实现 |
> | §5 推送通知 | **有效** —— 已于 2026-07-18 改为直连 APNs + 中继 |
> | 代码库表格、`apps/mobile/` 目录树、expo-router、expo-secure-store、NativeWind | **已取代** —— 读作「原生 App 需要提供的形态」，而非实施指令 |
>
> Expo 特有的机制会**随原生实现推进逐段替换**，而不是一次性删除 —— 里面的论证仍然是
> SwiftUI 实现必须回答的问题。

Cheers 移动 App 设计文档。最初为 `apps/mobile/` 下整合的 Expo (React Native) 代码库撰写；
现在的目标是 `apps/ios` 的原生 SwiftUI App（见上方横幅）。涵盖产品/UX
设计、App 架构与推送通知系统（需要新的服务端工作，此处给出规格并作为后续任务跟踪）。

配套交互原型：[docs/design/mobile-app-prototype.html](../design/mobile-app-prototype.html)
（浏览器打开 —— 8 个关键屏幕 + 1 个浅色模式变体）。

## 1. 背景与目标

Cheers 移动端**不是把 Web 应用塞进手机**。Web 前端仍是工作台（文件、深度
diff 审阅、workbench 面板、管理后台）。手机是**人类监督 Agent 的随身伴侣**：

1. **随时随地批准/拒绝 Agent 的工具调用** —— 杀手级场景。你的 Agent 在你
   离开工位时撞上权限门；一条 time-sensitive 推送让你在几秒内审阅命令/diff
   并做出裁决。
2. **一瞥收件箱 → 快速聊天** —— 读会话、催 Agent、回 DM、接受邀请。
3. **Fleet 可见性** —— 我的 bot 们此刻在干什么。

原生 SwiftUI App（`apps/ios/`）已验证聊天骨架（会话列表 → 聊天 → 设置）、
DTO↔serde 映射、`/ws` 重连策略与深/浅 token 映射。本设计保留该骨架，补上缺失
的四大支柱：审批、工作区上下文、Fleet 可见性、管理流程。

**非目标（v1）**：平板/iPad 布局、离线发件箱（发送失败显示重试而非排队）、
E2EE、workbench/ViewBoard 体系、管理后台（跳转 Web）。

## 2. 决策摘要

| 维度 | 决策 | 理由 |
| --- | --- | --- |
| 代码库 | Expo (React Native)，`apps/mobile/`，TypeScript | 既定战略；iOS+Android 一份代码；React 团队 |
| 导航模型 | 抽屉优先（Claude App 风格）：Chats 是唯一主界面；左侧抽屉承载工作区、频道及 Activity / Agents / 好友 / 设置入口 —— **无底部 Tab 栏** | 一个干净的聊天主面；全部导航收在一次边缘滑动之后 |
| 工作区切换 | Chats 左侧滑出抽屉（边缘滑动/菜单键）：顶部工作区条、中间频道列表、底部功能行 | Telegram/Claude App 抽屉模式；取代 Web 的左侧 rail；扁平 "All" 列表仍是主页 |
| 移动端审批 | 内联紧凑卡 → 根级 Approval bottom sheet | 360pt 气泡里塞不下 radio；sheet 同时是推送深链落点 |
| 推送传输 | **Expo Push Service**，Rust 侧 `PushTransport` trait 封装 | 唯一让自托管网关无需 APNs/FCM 凭据即有推送的方案 |
| 推送策略 | 服务端总是发送；前台客户端抑制展示 | 服务端按 socket 在线抑制会让桌面标签页吃掉手机推送 |
| 路由 | expo-router（文件式） | 深链 + 推送点击路由近乎免费；类型化路由 |
| 状态 | Zustand（会话/WS/UI）+ TanStack Query（全部 REST 读取） | Web 正要迁移的目标架构；移动端成为参考实现 |
| 样式 | NativeWind v4，共享 Tailwind preset 的语义 token | 移植 `frontend/DESIGN.md` zinc/indigo 体系；浅色模式采用 `Theme.swift` 映射 |
| 代码共享 | 抽取 `packages/core`（DTO + REST client + WS 状态机） | 共享逻辑而非 UI（战略文档）；包内无 React/DOM |
| Token 存储 | expo-secure-store，`AFTER_FIRST_UNLOCK` | Keychain/Keystore；后台通知动作需要能读到凭据 |
| 离线缓存 | TanStack Query persister + MMKV（列表 + 每频道末 50 条） | 冷启动即时渲染；WatermelonDB 式同步对 v1 过重 |

## 3. App 架构

```
apps/mobile/                  # Expo 应用（expo-router）
├── app/                      # 文件式路由
│   ├── (auth)/login.tsx
│   ├── (tabs)/
│   │   ├── chats/            # 列表 + [channelId] 聊天 + 频道信息栈
│   │   ├── activity.tsx      # 审批/邀请收件箱
│   │   ├── agents/           # fleet 列表 + 会话详情 + trace
│   │   └── you/              # 资料、好友、外观、通知
│   └── _layout.tsx           # 登录门、主题 provider、sheet 宿主
├── components/               # RN 组件（气泡、卡片、sheet、chip）
├── stores/                   # Zustand：auth/session、socket、UI
└── tailwind.config.ts        # 消费共享 token preset

packages/core/                # 新增 —— 框架无关 TS（无 React、无 DOM）
├── types.ts                  # 从 frontend/src/types/index.ts 移植的 DTO
├── api.ts                    # REST client（fetch，注入 base URL + token）
└── socket.ts                 # /ws 协议状态机（见 §4）
```

- **expo-router** 通过 linking 配置承接推送点击与深链；每条推送 payload 携带
  路由（§5.4）。
- **TanStack Query 拥有全部 REST 读取**（会话列表、消息分页、fleet、审批）。
  WS 帧 patch 缓存：`message`/`message_done` → `setQueryData` 追加/替换；粗粒度
  事件（`member_updated`、`permission_*`）→ 定向 invalidation。不再手写
  `useEffect + fetch`（Web 的已知债务；共享 query key + fetcher 约定放在
  `packages/core`）。
- **Zustand** 持有 Query 不该管的：auth/会话状态、socket 状态、每频道草稿、
  UI sheet 状态。
- **NativeWind v4** 只用语义 token（`bg-app`、`bg-surface`、`bg-raised`、
  `text-primary`、`text-secondary`、`accent`…）—— 组件里不出现裸 `zinc-*`
  字面量，浅色模式是换 token 而非全组件审计（§7.4）。

## 4. 实时与数据层

App 原样实现 [WIRE_PROTOCOL.md](WIRE_PROTOCOL.md) —— RN 标准
`WebSocket` 直接承载帧协议。

**`packages/core/socket.ts`** 是从已验证的 Swift 实现
（`apps/ios/Sources/Networking/ChatSocket.swift`）移植的状态机：

- 连接 → 首帧 `{type:"auth", token}` → `auth_ok` → 对可见频道 `subscribe`；
  user-scope 帧在 `auth_ok` 后自动到达。
- 流式：`message_stream` 增量按 `msg_id` 的最大 `seq` 去重；`message_done`
  为终态，自愈丢失的增量。
- 重连：指数退避 1s → 30s（最多 10 次），随后自动重订阅并 **REST 补洞**
  （`?since_seq=` / `after=` 游标，见
  [MESSAGE_PAGINATION.md](MESSAGE_PAGINATION.md)）—— 实时层保持
  哑管道；追赶走 REST。
- `auth_err` 或 REST 401 → 会话过期态（重新登录；目前无 refresh token，见 §6）。

**移动端 WS 生命周期由 AppState 驱动** —— 与 Web 的主要差异：

| AppState | 行为 |
| --- | --- |
| `active` | 连接、认证、订阅 user scope + 可见频道 |
| `background` | **立即优雅关闭** socket —— 不与 OS 约 30s 的 socket 回收对抗；空窗由推送兜底 |
| 回到 `active` | 重连 + 对可见频道 REST 补洞 + 刷新 Activity badge |

**离线缓存**：TanStack Query persister + MMKV。持久化：工作区+频道列表、
Activity 收件箱、最近浏览频道的末 50 条消息。冷启动先渲染缓存再revalidate。
发送失败的消息留在列表中并提供重试（v1 无发件箱/队列）。

**分页**：触顶时 `GET /channels/:id/messages?before=<oldest>`，`limit` ≤ 200，
与 Web/iOS 一致。

## 5. 推送通知

网关**目前没有任何推送基础设施** ——「通知」只是应用内邀请收件箱
（`GET /api/v1/notifications`）加上经 `server/src/api/notifications.rs` 的
`push_notification()` 发出的尽力而为 user-scope WS 帧。本节给出 v1 推送系统
规格。服务端工作是路线图（§8）跟踪的后续 PR，不属于 App 脚手架。

### 5.1 传输：直连 APNs + 官方中继

> **2026-07-18 修订** —— 客户端整合到了原生 SwiftUI App（非 Expo），商店
> 二进制的凭据归我们所有：网关实现 `PushTransport` seam，两个实现。
> **直连 APNs**（ES256 provider token + HTTP/2；`APNS_KEY_P8`/`APNS_KEY_ID`/
> `APNS_TEAM_ID`）供持有 App 凭据的部署使用；**中继客户端**
> （`PUSH_RELAY_URL`/`PUSH_RELAY_KEY`）供自托管网关使用——它们拿不到不属于
> 自己 bundle id 的 APNs 凭据，改为把推送 POST 给持有密钥的官方 Cheers
> 中继。中继服务本身是独立部署物；其 API 契约由网关的中继客户端定义
> （`server/src/notify/relay.rs`）。未配置 = 推送禁用，应用内 WS 投递不受
> 影响。下方 Expo Push 论证保留存档。

#### （已被取代）Expo Push Service 论证

Rust 服务端向 Expo 推送 API（`https://exp.host/--/api/v2/push/send`）POST
发送，每请求最多 100 条打包，藏在 trait 后：

```rust
// server/src/notify/transport.rs（新增）
trait PushTransport {
    async fn send(&self, batch: &[PushMessage]) -> Result<Vec<PushReceiptId>>;
}
```

**为何选 Expo Push 而非直连 APNs/FCM**：平台推送凭据（APNs `.p8` 密钥、FCM
服务账号）绑定的是 **App 二进制**的 bundle ID，属于签名并上架商店 App 的一方
—— 跑自己网关的自托管用户拿不到。用 Expo Push，商店分发的 App 经 Expo 基础设施
携带平台凭据，*任何*网关只需用设备的 `ExponentPushToken` 发一个普通 HTTPS POST
即可送达。「克隆仓库 → 跑服务 → 装商店 App → 指向自己的服务器」的推送开箱即
用。直连 APNs/FCM 保留为未来的 `PushTransport` 实现，供自行构建二进制的运营者
使用。

**Payload 隐私**：通知 payload 会经过 Expo 服务器，因此服务端默认**开启
payload 最小化**：推送只带 `{type, channel_id, request_id?, deep_link}` 加
通用但有用的文案（"Permission request from claude-code"、"New message in
#release"）—— 绝不带消息正文或命令内容。完整内容由 App 点开后拉取。接受该
权衡的运营者可用服务端配置放宽。

### 5.2 服务端：`notify` 服务、设备、schema

**Seam**：新增 `server/src/notify/` 域服务 —— **不是**扩展
`Fanout`（`server/src/gateway/realtime/fanout.rs`），后者保持线协议的哑管道。

- `NotificationEvent` —— 类型化枚举（`PermissionRequest`、`DirectMessage`、
  `Mention`、`Invite`、`PermissionResolved`…）。发射点构造枚举而非手写帧。
- `notify::dispatch(state, event)` 做两件事：(a) 既有的
  `Fanout::broadcast_user` WS 帧（行为保持）；(b) 评估推送策略（§5.3）→ 对
  每台注册设备 `PushTransport::send`。发送是 **fire-and-forget 异步**（spawn
  任务）—— 绝不占消息热路径。回执轮询；`DeviceNotRegistered` 修剪 token。
- 迁移成本极低：`api/notifications.rs` 的 `push_notification()` 已是三个邀请
  发射点（`api/workspaces.rs`、`api/channels.rs`）背后的唯一辅助函数；把它
  泛化进 `notify::dispatch` 即零成本转换邀请路径。随后
  `gateway/ws/agent_bridge.rs` 的 `permission_request` 发射走同一服务。

**设备注册**：

- `POST /api/v1/users/me/devices` `{push_token, platform, device_name}` ——
  幂等 upsert，token 唯一。
- `DELETE /api/v1/users/me/devices/:token` —— 登出时调用。
- 新表 `user_devices`：`(id, user_id, push_token unique, platform,
  device_name, created_at, last_seen_at)`。`DeviceNotRegistered` 回执与用户
  `token_version` 提升时修剪（被吊销的会话必须停止接收推送）。

### 5.3 事件分类 → 推送策略

| 事件 | 推送？ | 优先级 | Collapse key |
| --- | --- | --- | --- |
| `permission_request` | **总是** | 高；iOS `interruptionLevel: timeSensitive`；category `acp-approval` | `request_id` |
| DM 消息 | 是 | 默认 | `channel_id`（"N 条新消息" 替换式） |
| 频道内 @mention | 是 | 默认 | `channel_id` |
| 工作区/频道邀请 | 是 | 默认 | `invite:<workspace_id>` |
| 普通频道消息 | **否** —— 只计未读 badge | — | — |
| `message_stream`、`bot_trace`、presence、已读回执 | 从不 | — | — |

**前台抑制，而非服务端抑制。** 服务端总是发送该推的事件。按「有 socket 在线
就不推」是错的，因为 socket 在线是跨所有客户端的用户级状态 —— 桌面开着的 Web
标签页会吞掉手机推送，杀死离开工位的审批场景。正确做法：**前台 App 抑制展示**
（其在线 WS 已实时展示该事件）；`read` 事件按 collapse key 撤销该频道已送达的
通知并重算 badge。

请求在别处被裁决（`permission_resolve` / `permission_cancel`）时，服务端用
相同 collapse key 发一条内容替换式跟进推送（"Already resolved"）—— Expo 不
提供远程撤回，替换即机制。已知局限：两条推送期间都离线的设备可能短暂显示
过期的审批通知；点开后落在已裁决的卡片上。

### 5.4 客户端：category、动作、深链、badge

- **Category `acp-approval`** 携带 **Approve / Reject 动作按钮**。后台通知
  响应处理器从 SecureStore（`AFTER_FIRST_UNLOCK`）读 JWT，直接调用
  `POST /channels/:id/permissions/:req/resolve` —— 无需拉起 UI 即可批准。
  任何失败（token 过期、网络、已被裁决）回退为拉起 App 落在 Approval sheet。
  通知正文不足以支撑盲批 —— 动作按钮服务于用户本就预期的请求；点开
  「Review」才是主路径。
- **深链**：`cheers://channel/:id?msg=<id>` 与
  `cheers://approval/:channelId/:requestId`。每条推送的 `data` 携带深链，
  expo-router linking 负责路由。Approval sheet 是根级 modal，可覆盖任意屏幕。
- **Badge** = 待审批数 + 有未读 DM/@ 的频道数。服务端在每条推送里带上计算好
  的 `badge`；客户端已读时也本地重算。Badge 漂移可接受，下次打开 App 校正。

## 6. 认证与安全

- JWT（RS256，24h，无 refresh token）存 **expo-secure-store**，
  `AFTER_FIRST_UNLOCK` 可达性 —— 后台批准动作要在手机锁定（但开机后解锁过）
  时读到它。非机密会话字段（服务器 URL、用户 id）存 MMKV/AsyncStorage，对应
  iOS App 的 Keychain/UserDefaults 划分。
- 服务器 URL 是登录屏字段（自托管优先，同 `apps/ios`）；缺省自动补 `/api/v1`，
  WS URL 派生。非本地主机要求 HTTPS。
- REST 401 / WS `auth_err` → 登录屏上的会话过期接管（对应 Web 的 L 级接管）。
  登出调用 `POST /auth/logout`（经 `token_version` 服务端吊销）**并**
  `DELETE /users/me/devices/:token`。
- **必须在服务端修复的已知缺口**：24h token 且无刷新机制，会让后台批准动作
  每天失效并强制重新登录。本设计不做静默绕过。必要后续：refresh token 或
  设备级长效 token（至少限定在通知裁决端点），并保持 `token_version` 吊销
  语义。§8 跟踪。

## 7. UX 与信息架构

### 7.1 导航

```
Root（登录门）
├─ Login 栈
└─ Chats（主界面）— 会话列表 → 聊天 → 频道信息 → 成员/文件/邀请
   └─ 左侧抽屉（边缘滑动 / 带角标的菜单键）— 唯一导航中枢
      ├─ 顶部：工作区条（All · Personal · <工作区> · +）
      ├─ 中间：所选工作区的频道与 DM
      └─ 底部：Activity（收件箱，角标）· Agents（fleet）· 好友 ·
               个人资料与设置 · New chat
根级 sheet：Approval · 新建聊天 · Session 选择 ·
            Model 选择 · 转发选择 · 附件查看器
```

- **Chats 是 Telegram 模型**：跨工作区一张扁平列表（每行带小工作区 chip），
  含 DM —— `apps/ios` 已验证。Slack 的工作区优先层级为典型的 2–4 个工作区
  多加了一层导航。
- **Activity ≠ Agents。** Activity 回答「什么在等*我*」（审批置顶 —— 它是
  推送落点）；Agents 回答「我的 bot 在*做什么*」（可观测性）。合并会把批准
  动作埋进监控界面。邀请并入 Activity —— 一个收件箱，不设独立通知铃铛。
- **工作区切换 —— 左侧抽屉**（Telegram / Claude App 模式）：在 Chats 列表
  **从左边缘滑入**（或点头部菜单键）滑出抽屉覆盖列表，右侧残留内容压暗。
  自上而下三个区域：
  1. **工作区条** —— 横向一排工作区方块（`All · Personal · <工作区> · +`），
     方块上带未读数，当前工作区有 accent 描边；`+` 新建或加入工作区。条下方
     是所选工作区的名称、元信息（频道 · bot · 成员）和设置齿轮。
  2. **频道与 DM 列表**（所选工作区的），带未读/@ badge —— 点频道即关抽屉
     直达该聊天。选 `All` 则主列表显示跨工作区扁平收件箱。
  3. **底部导航与设置**，保持紧凑：一行并排 chip 承载剩余顶层入口
     （**Activity** 带待审批角标、**Agents**、**好友**），其下窄页脚放
     个人头像、设置和醒目的 **New chat** 按钮。
  主界面**没有底部 Tab 栏、没有悬浮按钮** —— 抽屉是 App 唯一的导航中枢，
  同时取代 Web 的 rail 和常规移动端 Tab。主 Chats 列表保持跨工作区扁平
  收件箱；主界面菜单键带待审批角标，没有 Tab 栏审批也不会失去存在感。
- **返回模型 —— 层级制，非历史制。** 主聊天是根：其左上角是抽屉菜单键，
  左边缘滑动开抽屉。抽屉目的地（Notifications、Fleet、好友、设置、频道
  信息）恒定**一级深**：其返回键——以及同一左边缘滑动（在二级页含义为原生
  滑动返回）——直接回到主聊天。**返回落在入口处**：从抽屉进入的页面，返回
  时抽屉自动重新打开（枢纽连续性——设置 → 返回 → 抽屉 → Fleet）；从聊天
  ⋯ 菜单进入的页面，返回到聊天本身、不出抽屉。切换会话是**平级**动作
  （替换当前聊天，不留返回轨迹）；sheet 是**模态**（下滑关闭，回到原地）。
  返回永远不表示「撤销上一次操作」。

### 7.2 屏幕清单

**Login** —— 服务器 URL（可折叠「高级」，默认开发地址）、用户名、密码。
会话过期复用此屏加横幅。

**Chats** —— 紧凑的一行：带角标的圆形菜单键（打开抽屉，§7.1）+ 搜索框。
无标题栏（抽屉优先后无需再标注 "Chats"）、无 Tab 栏、无悬浮新建按钮
（New chat 在抽屉里）。行内：头像（与
`frontend/src/lib/format.ts` 一致的哈希调色板）、名称 + BOT pill、工作区
chip（仅「All」下显示）、末条消息预览（流式中显示打字指示）、时间戳、未读
badge（indigo）/ @badge（rose）。下拉刷新。新会话（DM / 频道 / 工作区）从抽屉的 **New chat** 按钮发起 →
新建聊天 sheet。

**Chat** —— 核心屏。
- 头部（Claude App 风格）：左侧圆形返回键；**居中**的频道标题 + 一行副标题
  —— Agent 活跃时显示 bot 实时状态（"● claude-code · running"，
  emerald/amber 圆点），否则显示 工作区 · 成员数。头部所有动作（搜索、静音、
  文件、成员、设置）收进右上角单个圆形 **⋯（更多）** 按钮打开的菜单 sheet；
  点标题打开频道信息。
- 倒置消息列表；气泡沿用 iOS 参考：自己 = indigo `#4f46e5` 右对齐，他人 =
  raised 表面左对齐，16pt 圆角、组末 6pt 尾巴，日期分隔 chip，多方频道显示
  发送者名 + BOT pill。回复引用为着色引用块（点按跳转）。Markdown + 围栏
  代码（横向滚动、复制按钮）。附件为缩略图/文件 chip；语音为波形 pill +
  下方转写文本。
- 流式：部分消息带光标实时渲染；bot 回合中发送键变 **Stop**；出 token 前
  打字点。仅贴底时自动滚动；否则浮动「↓ New messages」pill —— 流式期间绝不
  抢滚动。
- Bot trace：完成的 bot 回合下方一行折叠的「Agent steps · N」；点按内联展开
  约 6 行，「View all steps」推入完整 Trace 屏。
- Composer：无边框 raised 卡片；`+` 附件（照片/相机/文件）、文本框（最长约
  5 行）、mic（按住录音、左滑取消、上锁免持）、发送/停止。频道有 bot 时字段
  上方出 chip 行：**Session chip**（Auto ▾ / 固定会话）与 **Model chip**，
  各自打开对应 `SessionChip.tsx` 语义的底部 sheet（打开时拉取，Auto = 按
  @ 路由）。

**审批流程** —— 杀手级功能，三种状态：
1. *内联待定卡*（消息流中）：紧凑 —— 盾形图标 + bot 名、一行 mono 命令预览、
   **Review** 按钮。360pt 气泡里不放 radio。
2. *Approval sheet*（根级底部 sheet；也是推送深链落点）：头部（bot +
   "requests permission" + 频道链接）→ 黑色内嵌 mono 命令块（可滚动）→
   `edit` 类工具调用内联渲染 agent diff（限高，可展开全屏）；`git commit`
   提供懒加载「View staged diff」行 → radio 行 = `allow*` 选项（首项预选；
   连接器未发 allow 选项时回退为全部选项）→ home indicator 之上的 sticky
   底栏：**Deny**（安静）· **Approve**（醒目浅色 pill），全宽 48pt 触区。
   裁决后：「✓ Approved」确认；响应 `delivered: false` 时显示 amber「未送达」
   提示 —— 绝不让用户误以为 agent 已执行。
3. *已裁决卡*收敛为一行安静的 trace 风格行（同 Web）。

**Activity** —— 分区：**Needs approval**（恒置顶；行内：bot 头像 + 盾形、
标题、mono 单行预览、频道 · 工作区、时长，amber 强调）、**Invites**
（内联 Accept/Decline）、**Recent**（已处理项，安静）。下拉刷新；从抽屉进入，待审批数同时以角标形式挂在主界面
菜单键上。

**Agents** —— 摘要条（"3 running · 1 waiting on approval · 5 idle"；waiting
chip 链到 Activity），下方按 bot 分组的在线会话（状态点 emerald/zinc/red、
会话 tag、中段截断的 cwd、频道链接、最近活动）。**会话详情**：状态/模型/
模式/cwd/频道；动作：打开聊天、看 trace、停止回合。无文件工作台 ——
「Open in Cheers web」跳出。

**频道信息** —— hero、动作行（搜索/静音/文件）、成员（→ 成员列表：角色、
增删）、Bots（→ bot 行 → 会话/权限模式）、文件（→ 查看器：图片可缩放、PDF
分页、代码只读高亮、系统分享导出）、邀请链接（创建/复制/吊销）、危险区
（离开/删除，soft-red，确认对话框）。

**You** —— 资料卡、好友（请求 badge、按用户名添加、点按 → DM）、外观
（跟随系统/浅色/深色，默认跟随系统）、通知（按 §5.3 分类的开关）、服务器
（URL + 连接状态）、关于、退出。管理员行仅对管理员显示并跳转 Web。

### 7.3 移动交互语言

- **长按消息 → 原生上下文菜单**（zeego 等实现的 UIMenu / Material 菜单）带
  模糊预览：回复、转发、复制文本、复制代码（代码块时）、删除（自己的；
  destructive 红；确认）。取代 Web 的悬停工具条。
- **气泡右滑 = 回复**（触觉反馈）。会话行：侧滑 = 静音 / 标记已读。
  **任何地方都没有破坏性侧滑。**抽屉的边缘滑动只在 Chats *列表*屏生效，
  与聊天内的气泡回复滑动不冲突。
- **`@` 提及选择器**：composer *上方*内联浮层（键盘不收起），成员 + bot
  （bot 频道中 bot 优先），模糊过滤；插入 token chip —— bot 用 indigo 色调、
  人用 rose。
- **键盘**：交互式收起（顺列表下拉，iOS 风格），经
  `react-native-keyboard-controller`；composer 钉在键盘/home indicator 之上；
  输入字号 ≥16pt。
- **触区**：处处最小 44×44pt；审批 Deny/Approve 为全宽 48pt。
- **下拉刷新**：Chats/Activity/Agents。聊天历史触顶分页加载 —— 聊天内不做
  下拉转圈。
- 附件以 chip 形式暂存在字段上方（虚线 = 尚未上传，沿用 Web 约定）。

### 7.4 视觉系统

Token 来自 `apps/ios/Sources/Support/Theme.swift` 已验证的双模式映射（Web
dark-only `frontend/DESIGN.md` 体系的派生浅色版），以 NativeWind 语义 token
表达（浅 / 深）：

| Token | 浅色 | 深色 |
| --- | --- | --- |
| `bg-app` | `#FAFAFA` zinc-50 | `#09090B` zinc-950 |
| `bg-surface` | `#FFFFFF` | `#18181B` zinc-900 |
| `bg-raised` | `#F4F4F5` zinc-100 | `#27272A` zinc-800 |
| `bg-selected` | `#E4E4E7` zinc-200 | `#3F3F46` zinc-700 |
| `text-primary` | `#18181B` | `#F4F4F5` |
| `text-body` | `#27272A` | `#E4E4E7` |
| `text-secondary` | `#52525B` zinc-600 | `#A1A1AA` zinc-400 |
| `accent`（按钮、自己的气泡） | `#4F46E5` indigo-600 | `#4F46E5`（恒定） |
| `link` | `#4F46E5` | `#818CF8` indigo-400 |
| `danger` | `#DC2626` | `#F87171` |
| success / online | emerald-500 | emerald-500 |
| warning（待审批） | amber-600 | amber-400 |
| mention badge | rose-600 | rose-600 |

- **跟随系统外观**；You → 外观可覆盖。
- Web 的规则全部沿用：**对比度地板**（深色 zinc-400 / 浅色 zinc-600 是次要
  文本地板；zinc-500 永不用于有意义文本）、**无边框分层**（表面靠对比 +
  阴影区分；ring 只用于 focus/error）、头像颜色复用 Web 精确哈希
  （`frontend/src/lib/format.ts`，`Theme.swift` 已移植）。
- 字体：系统字体（SF Pro / Roboto）；大标题 28–34（iOS）/ 22（Android），
  屏幕标题 17 semibold，正文/消息 16，次要 14，元信息 12，badge 底 11。
  mono（Menlo / Roboto Mono）用于命令、代码、cwd。正文支持 Dynamic Type /
  字体缩放。
- 间距：4pt 网格、16pt 页边、12pt 气泡内边距、组内 8pt / 组间 16pt 气泡距。
- **一套布局，原生交互**：两平台都用抽屉优先导航 —— 不做平台分叉。仅在
  交互层做平台条件化：上下文菜单、分享 sheet、触觉、头部风格（iOS 大标题 +
  毛玻璃；Android 平面表面 + 居中标题）。底部 sheet
  （`@gorhom/bottom-sheet`）是两平台的主力容器。

## 8. 里程碑

1. **M1 —— 聊天对等**：脚手架 `apps/mobile/` + `packages/core`；登录、
   Chats、聊天（流式、分页、补洞）、已读状态、You 基础。达到今日
   `apps/ios` 的水平。
2. **M2 —— 审批 + 推送**：Activity 屏、Approval sheet、Agents 屏、会话
   chip；服务端 `notify` 服务 + `PushTransport` + `user_devices` + 设备端点；
   通知 category/动作/深链。*§6 的服务端前置：refresh/设备 token 跟进。*
3. **M3 —— 管理 + 退役**：频道/工作区管理流程、好友、文件查看器、@ 选择器；
   随后按战略文档退役 `apps/ios` + `apps/android`。

## 9. 备选方案

- **Rust 直连 APNs + FCM** —— 无第三方中转，但按部署配置平台凭据让用商店
  App 的自托管用户无法获得推送；保留为未来 `PushTransport` 实现。
- **服务端按 socket 在线抑制推送** —— 桌面标签页会吞掉手机推送；否决（§5.3）。
- **Slack 式工作区优先导航** —— 为 2–4 个工作区多一层层级；否决，采用扁平
  列表 + 工作区抽屉。
- **扩展 `Fanout` 承载推送** —— 实时层刻意保持哑管道；策略繁重的推送属于域
  服务。
- **WatermelonDB/SQLite 离线同步** —— 对 v1 过重；Query persister + MMKV
  已覆盖冷启动渲染。
- **双原生（保留 Swift + Kotlin）** / **仅 PWA** —— 已在
  [MOBILE_CLIENT_STRATEGY.zh-CN.md](MOBILE_CLIENT_STRATEGY.zh-CN.md) 中否决。

## 10. App Store 上架就绪清单

当前分支状态（2026-07-18）：`apps/ios/` SwiftUI target 已能通过
`generic/platform=iOS Simulator` 构建，但**还不能直接正式提交 App Store**。
剩余发布门槛如下：

- **Apple 签名**：配置真实 Apple Developer Team（`DEVELOPMENT_TEAM`）和生产
  provisioning。当前工程使用 automatic signing，但没有记录 team id。
- **最终 Bundle Identity**：上传前确认 `PRODUCT_BUNDLE_IDENTIFIER =
  app.cheers.ios` 就是最终值；App Store Connect 会把 bundle id 作为 App 的
  永久身份。
- **APNs capability**：补齐生产推送 entitlement（`aps-environment`）以及匹配的
  App Store provisioning。当前分支已有设备注册和 gateway APNs/relay 支持，但
  iOS target 还缺 capability/profile 侧配置。
- **生产网络**：把开发/本地 API 假设替换成生产 HTTPS base URL。Store build 前
  移除或严格解释当前针对 `localhost` 和 `127.0.0.1` 的 ATS 例外。
- **Release archive 验证**：对 `generic/platform=iOS` 做带签名的 Release
  archive，然后通过 Xcode Organizer、`xcrun altool` 或 Transporter 验证/上传。
- **商店元数据**：在 App Store Connect 创建 App 记录，准备最终名称、副标题、
  分类、年龄分级、描述、关键词、支持 URL、价格、地区，以及每个必需设备类别
  至少一张有效截图。
- **隐私材料**：发布隐私政策 URL，并按 Cheers 实际处理的数据填写 App Store
  privacy details（账号数据、消息/内容、设备 push token、诊断信息，以及后续若
  添加 analytics 也要披露）。
- **审核访问**：为 Apple 提供稳定审核环境、demo account 凭据，以及任何服务端
  配置或角色流程说明。
- **账号生命周期**：如果 App 支持创建账号，需要提供 App 内账号删除路径，或符合
  App Review Guideline 5.1.1 的等效说明。
- **生产运维**：上线带 TLS 的 gateway，配置 APNs 凭据或官方 relay，并执行
  `0050_user_devices.sql` migration。按项目 migration discipline，迁移/代码
  变更后需要 rebuild 并 force-recreate gateway。

Apple 官方参考：

- <https://developer.apple.com/app-store/app-privacy-details/>
- <https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/>
- <https://developer.apple.com/distribute/app-review/>
- <https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/>
- <https://developer.apple.com/app-store/submitting/>

## 11. 参考

- [MOBILE_CLIENT_STRATEGY.zh-CN.md](MOBILE_CLIENT_STRATEGY.zh-CN.md) —— 本设计实现的既定方向
- [WIRE_PROTOCOL.md](WIRE_PROTOCOL.md) —— `/ws` 帧协议契约（英文）
- [MESSAGE_PAGINATION.md](MESSAGE_PAGINATION.md) —— App 复用的游标分页（英文）
- [ACP_APPROVAL_FLOW.md](ACP_APPROVAL_FLOW.md) —— 权限请求/裁决语义（英文）
- `frontend/DESIGN.md` —— 移动 token 继承的 token 体系与组件配方
- `apps/ios/Sources/Support/Theme.swift` —— 已验证的深/浅 token 映射
- `frontend/src/features/chat/PermissionCard.tsx` —— 审批卡语义（allow*/reject* 选项、`delivered`、edit diff、staged git diff）
- [docs/design/mobile-app-prototype.html](../design/mobile-app-prototype.html) —— 8 个关键屏幕的交互原型
