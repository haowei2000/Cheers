# 前端重做架构

> 状态：已定稿
> 日期：2026-06-02
> 范围：Cheers 浏览器前端重做

本文固化 Rust Backend 和 Rust local daemon 架构之后的前端重做方向。

## 1. 结论

新的 Cheers 前端采用：

```text
TypeScript + React + Vite
```

配套选择：

| 层 | 决策 |
|---|---|
| 语言 | TypeScript |
| UI 框架 | React |
| 构建和开发工具 | Vite |
| 路由 | TanStack Router |
| 服务端状态 | TanStack Query |
| 实时层 | 独立 Browser WS client，负责 patch 或 invalidate server state |
| 本地 UI 状态 | Zustand 或小型 React context，按 feature 选择 |
| 样式 | CSS variables + Tailwind utilities + headless primitives |
| Backend 边界 | Rust Backend 继续作为 API、权限、文件、session、Agent Bridge 的唯一权威 |

当前 `frontend/` 包标记为 deprecated legacy frontend。它可以做短期兼容修复，保证现有部署
还能用，但新的产品工作应进入 `frontend-next/`。

## 2. 为什么选这个栈

Cheers 是登录后的实时工作台，不是公开营销站点。核心工作流是：

- workspace 和 channel 导航
- chat 和 streaming message 状态
- bot 配置和 runtime status
- approval card 和 permission resolution
- Agent Bridge 配置与诊断
- files、memory、docs、settings、运维面板

这些工作流需要快速 UI 迭代、强组件组合、类型化 API model、可控客户端路由，以及清晰的
server state 同步。TypeScript + React + Vite 是最直接的匹配。

## 3. 非目标

### 3.1 不默认选 Next.js

Cheers 已经有 Rust Backend 负责 API、WebSocket、auth、permissions、files、sessions 和
Agent Bridge。再引入 Node full-stack 层会模糊边界。

只有未来明确需要 SSR、公开 SEO 页面或 Node-side BFF 时，才考虑 Next.js。

### 3.2 不把 Rust 作为主前端语言

Rust 继续用于 gateway、local daemon、ACP adapter、MCP server 和协议密集代码。它不适合作为
当前主浏览器 UI 语言，因为主要工作是高频交互设计、表单、路由、虚拟列表、富文本和实时 UI 状态。

Rust/WASM 可以用于局部模块，例如加密、协议校验或性能敏感转换。

### 3.3 不做组件库优先重写

重做不应从引入大型视觉组件库开始。Cheers 需要的是密集、可扫描、可重复操作的工作台，
所以设计系统先从 tokens、layout、interaction states 和 focused primitives 开始。

## 4. 运行时边界

前端不能成为平台裁判。

```text
Browser UI
  -> REST commands
  -> Browser WebSocket events
  -> local rendering and interaction state

Rust Backend
  -> auth
  -> permissions and grants
  -> message/file/session persistence
  -> browser fanout
  -> Agent Bridge control/data
  -> permission_resolution routing
```

例子：

- 审批按钮可以根据用户上下文显示或隐藏，但谁有权审批由 Backend 判断。
- WebSocket event 可以 patch UI state，但持久化事实仍以 Backend 为准。
- Agent Bridge 配置界面可以编辑面向本地 connector 的设置，但 Backend 拥有 connector control snapshot 和 dispatch。

## 5. 设计语言

`frontend-next/` 的设计语言是：

```text
动静结合、图标优先、层级浮面、始终有方向感
```

Cheers 应该像一个实时 agent operations workbench。主内容保持安静可读；所有正在变化的
状态都要明显“活着”。

### 5.1 静态结构，动态状态

稳定内容要安静。正在变化的信息必须明显。

例子：

- agent 流式输出使用可见 streaming cursor 或 progressive reveal。
- running task 使用动态状态标记、progress track 或 live timer。
- 等待审批必须有明确 pending 状态，不能只是静态文字。
- online/offline/runtime transition 在短时间内 pulse 或动画提示。
- 刚变化的 row、message、counter 有短暂 highlight。

动效必须表达状态，不做装饰。使用 150-250ms transition，避免导致 layout shift，并尊重
`prefers-reduced-motion`。

### 5.2 图标优先，hover 展开细节

主导航和工具面优先使用图标、紧凑标签和 hover/tooltip，避免大量解释文字占据页面。

规则：

- 使用同一套图标体系，优先 lucide，并保持 stroke weight 一致。
- icon-only control 必须有 `aria-label`、可见 focus state 和 tooltip。
- hover 可以展示名称、说明、preview 或 secondary actions。
- 关键操作仍然必须支持 click、keyboard 和移动端 tap；hover 是增强，不是唯一入口。
- 长段解释文字放到 docs、inspector 或 expandable detail panel，不占据主工作台。

### 5.3 分层工作台界面

主内容是底层。操作控制浮在其上。

底层内容必须铺满整个可用工作区。主 chat/timeline/workbench surface 不是居中的 card 或 panel，
而是最深层的全空间 canvas。sidebar、composer、route header、inspector、popover 和 modal
都浮在这个 canvas 上面。

层级模型：

| 层 | 用途 |
|---|---|
| Base content | Chat、timeline、workbench canvas、主要页面内容 |
| Persistent chrome | workspace rail、channel list、route header |
| Floating controls | composer、action bars、search、command palette trigger |
| Inspectors | 右侧 bot status、approval detail、file/context、trace 面板 |
| Popovers | icon hover detail、menu、quick settings |
| Modals/sheets | 少量阻塞流程和移动端 detail view |

这样 chat 或主要工作面在视觉上最深、最稳定；sidebar、composer、top bar、dialog 则像更高一层的
操作面。

不要把主内容塞进装饰性 card 或居中 panel。浮层只在提供操作能力或上下文时使用。

### 5.4 方位感契约

每个 view 都必须持续回答三个问题：

1. 我在哪儿？
2. 我怎么回到之前？
3. 我现在能做什么？

必备 UI 信号：

- 当前 workspace、channel、route、session 可见，或最多一步可见。
- back/breadcrumb/history affordance 必须可预测。
- 可用操作通过 action rail、toolbar、command menu 或 contextual floating controls 展示。
- disabled 或 unavailable action 通过 hover/detail text 解释原因。
- realtime state 清楚表明当前数据是 live、stale、paused 还是 failed。

这条方位感契约优先级高于视觉极简。如果一个极简界面让用户失去位置感，它就不合格。

## 6. 目标目录

新代码从 `frontend-next/` 开始：

```text
frontend-next/
  src/
    app/
      App.tsx
      router.tsx
      providers.tsx
    routes/
    features/
      auth/
      workspaces/
      channels/
      messages/
      approvals/
      bots/
      agent-bridge/
      files/
      memory/
      settings/
    shared/
      api/
      realtime/
      ui/
      model/
      config/
```

## 7. 数据流

```text
Route loader / component
  -> shared/api REST client
  -> TanStack Query cache
  -> feature component

Browser WebSocket
  -> shared/realtime event normalizer
  -> query cache patch or invalidate
  -> feature component rerender

User command
  -> API mutation
  -> Backend writes state
  -> Browser WS confirms state transition
```

不要把原始 `fetch` 或 WebSocket handler 散落在 feature 组件里。transport 收口在
`shared/api` 和 `shared/realtime`。

## 8. 第一批 vertical slices

新前端按 vertical slice 做：

1. App shell、auth bootstrap、workspace/channel route frame。
2. Message list、composer、browser WS message updates。
3. Approval cards 和 Backend `permission_resolution` workflow。
4. Bot settings、connector status、Agent Bridge diagnostics。
5. Files、memory、docs、admin/settings panels。

Approval cards 应该早做，因为它验证最关键的边界：Backend 判断审批人并发送
`permission_resolution`，frontend 只渲染和提交用户意图。

## 9. 迁移规则

在 `frontend-next/` 替换 `frontend/` 之前：

- `frontend/` 是 legacy deployed frontend。
- 新前端架构和新产品面进入 `frontend-next/`。
- 复制旧 UI 行为之前，先文档化共享 API contract。
- 不盲目搬旧组件；围绕 Rust Backend 和 Agent Bridge contract 按 feature 重建。
