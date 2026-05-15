# FRONTEND.md

AgentNexus 前端组件层级与复用约定。

本文覆盖主应用 `frontend/src`。`skillhub-standalone/` 是独立前端，不纳入本组件层级。

## 技术栈

- React 18 + TypeScript
- Vite
- Tailwind CSS + 全局设计 token
- React Router
- `react-hot-toast`
- `@tanstack/react-virtual`

## 总体分层

前端按职责从上到下分为 8 层：

| 层级 | 目录/文件 | 职责 | 约束 |
|------|-----------|------|------|
| 0. 入口与路由层 | `main.tsx` | 注册 Router、全局样式、全局 Toast、懒加载页面 | 只做应用启动和路由，不放业务状态 |
| 1. 应用编排层 | `App.tsx` | 主聊天工作台状态、WebSocket、频道/消息/文件/Bot 协调 | 负责 orchestration，不直接沉淀可复用 UI |
| 2. 应用布局层 | `components/app/*` | 聊天主框架、侧栏面板、频道主区域、详情弹窗 | 放跨页面布局壳，不直接请求业务数据 |
| 3. 页面/大面板层 | `DocsPage.tsx`、`BulletinPage.tsx`、`MemoryPage.tsx`、`components/*Modal.tsx` | 独立页面、设置页、频道成员、记忆面板等完整业务界面 | 可持有本界面状态，但应复用共享组件 |
| 4. 业务复合组件层 | `Sidebar.tsx`、`ChannelHeader.tsx`、`MessageComposer.tsx`、`MemoryPanel.tsx` 等 | 某一业务区域内的复合交互 | 不重复实现通用搜索、成员项、Modal、图标 |
| 5. 共享交互组件层 | `SearchPicker.tsx`、`Modal.tsx`、`components/members/*` | 跨业务复用的交互组件 | 新 UI 优先复用；新增能力从这里扩展 |
| 6. 领域视觉组件层 | `BotAvatar.tsx`、`FilePreviewSidebar.tsx`、`ChatMessageRenderer.tsx`、`MessageMarkdown.tsx` | 消息、文件、Bot、Markdown 等领域渲染 | 保持表现一致，避免在业务组件内重写视觉规则 |
| 7. 基础视觉与样式层 | `components/icons/*`、`styles/design-tokens.css`、`styles/composer.css`、`index.css` | 图标、颜色、间距、密度、全局样式 | 样式 token 优先，避免散落硬编码 |
| 8. 数据与工具层 | `api/*`、`hooks/*`、`lib/*`、`types/*` | API 客户端、hooks、纯函数、类型定义 | 不依赖 React UI；业务组件从这里取能力 |

## 路由层级

`main.tsx` 是唯一前端入口：

```text
main.tsx
└── BrowserRouter
    ├── /                                      -> App
    ├── /workspaces/:workspaceId              -> App
    ├── /workspaces/:workspaceId/channels/:channelId -> App
    ├── /docs                                 -> DocsPage
    ├── /bulletin                             -> BulletinPage
    └── *                                     -> Navigate("/")
```

路由层只负责加载页面，不负责业务数据和 WebSocket。

## 主聊天界面组件树

主工作台由 `App.tsx` 编排，组件树应保持如下结构：

```text
App.tsx
├── ChatShell
│   ├── WorkspaceRail
│   ├── Sidebar
│   │   └── SearchPicker
│   ├── ChannelMainFrame
│   │   └── ChatWorkspaceView
│   │       ├── ChatTaskOverlay
│   │       ├── ChatTopicOverlay
│   │       ├── ChannelHeader
│   │       ├── ChatMessageList
│   │       │   ├── ChatMessageRenderer
│   │       │   │   ├── MessageMarkdown
│   │       │   │   └── ChatAttachments
│   │       │   ├── SecretMessageVeil
│   │       │   ├── AgentBridgeTaskCard
│   │       │   ├── BotAvatar
│   │       │   └── ClarifyInlineBlock
│   │       └── MessageComposer
│   └── ChatSidePanels
│       ├── MemoryPanel
│       │   ├── InviteMemberSearch
│       │   ├── SearchPicker
│       │   ├── QuickAddFooter
│       │   ├── MembersView
│       │   └── ProjectView
│       └── FilePreviewSidebar
├── AppModals
│   ├── NotificationPanel
│   ├── LoginModal
│   ├── CreateWorkspaceModal
│   ├── InviteWorkspaceMemberModal
│   │   └── SearchPicker
│   ├── CreateChannelModal
│   ├── ChannelMembersModal
│   │   ├── SearchPicker
│   │   └── MemberListItem
│   ├── ChannelSettingsModal
│   │   └── MemberListItem
│   ├── OpenClawQcModal
│   ├── AddBotModal
│   │   └── MemberListItem
│   ├── MessageDetailModal
│   ├── HelpModal
│   └── SettingsModal
│       ├── BotPane
│       │   ├── BotListSubPane
│       │   │   ├── BotAvatar
│       │   │   ├── BotSessionsPanel
│       │   │   └── ModelBrandCard
│       │   ├── BotNewPane
│       │   ├── BotEditPane
│       │   ├── BotShared
│       │   ├── TemplateListSubPane
│       │   └── ModelListSubPane
│       ├── FriendsPane
│       │   ├── SearchPicker
│       │   └── MemberListItem
│       ├── AccountPane
│       │   └── ProfilePane
│       ├── AppearancePane
│       ├── BulletinPane
│       └── KeychainPane
├── ImageLightbox
```

`App.tsx` 可以继续负责状态聚合、路由同步、WebSocket、消息窗口和跨面板协调。新 UI 代码如果可以独立复用，应优先放到 `components/app/` 或 `components/`，不要继续扩大 `App.tsx`。

## 目录职责

### `features/`

按业务域组织的 feature 层。这里放已经从通用 `components/` 中拆出的业务功能，目标是让大文件逐步瘦身。

当前已落地：

```text
features/
├── chat/
│   ├── ChatWorkspaceView.tsx        # 频道主区域：header、session、消息列表、composer 和空态
│   ├── hooks/
│   │   ├── useChannelMessages.ts   # 消息 store、加载、分页、滚动、虚拟列表和 topic 派生
│   │   ├── useChannelParticipants.ts # 频道用户/Bot、Bot 候选、添加/移除和 autoAssist
│   │   ├── useChatRealtime.ts      # 频道 WebSocket、流式增量、trace 和 message_done 合并
│   │   ├── useComposerController.ts # 输入草稿、消息类型、标题、回复和加密模式
│   │   └── usePendingFiles.ts       # 待发送文件、预览 URL、上传、删除和清理
│   ├── messages/
│       ├── AgentBridgeTaskCard.tsx  # Agent Bridge 后台任务消息卡
│       ├── ChatMessageList.tsx      # 虚拟消息列表、特殊消息卡和话题回复渲染
│       └── SecretMessageVeil.tsx    # 加密消息遮罩与过期倒计时 helper
│   └── overlays/
│       ├── ChatTaskOverlay.tsx      # TaskPage 懒加载覆盖层
│       └── ChatTopicOverlay.tsx     # TopicPage 懒加载覆盖层
├── memory/
│   ├── editor/
│   │   ├── EntryEditor.tsx         # Markdown 条目编辑器，MemoryPage 复用
│   │   └── QuickAddFooter.tsx      # 记忆侧栏底部快速新增条目
│   ├── views/
│   │   ├── MembersView.tsx         # 记忆侧栏成员列表与成员资料卡
│   │   └── ProjectView.tsx         # PROJECT 虚拟层的项目旅程视图
│   ├── parsers.ts                  # FILES_INDEX / RECENT 解析与时间格式化
│   └── types.ts                    # 文件卡片、时间线、文件预览等 memory 局部类型
└── settings/
    ├── account/
    │   └── AccountPane.tsx         # 账户资料、头像上传、密码修改、钥匙链
    ├── appearance/
    │   └── AppearancePane.tsx      # 主题和界面密度
    ├── bulletin/
    │   └── BulletinPane.tsx        # 留言板 Issue 列表、创建、状态切换
    ├── bots/
    │   ├── BotPane.tsx             # Bot 设置 tab 入口，只编排 Bot/模板/模型子页
    │   ├── BotListSubPane.tsx      # Bot 列表、刷新状态、进入新建/编辑
    │   ├── BotNewPane.tsx          # HTTP / Agent Bridge Bot 新建向导
    │   ├── BotEditPane.tsx         # Bot 详情、在线检测、模型/模板绑定、头像上传
    │   ├── BotShared.tsx           # Bot scope 控件、在线徽标、展示辅助函数
    │   └── types.ts                # BotRow、BotScope、ModelItem、TemplateItem
    ├── friends/
    │   └── FriendsPane.tsx          # 好友列表、申请、黑名单、添加好友
    ├── models/
    │   └── ModelListSubPane.tsx     # LLM 模型列表、创建、编辑、删除、模型品牌卡
    ├── templates/
    │   └── TemplateListSubPane.tsx  # Prompt 模板列表、创建、编辑、删除
    └── shared/
        └── SettingsControls.tsx     # 设置页共享 Field/Button/input 样式
```

放置规则：

- 只放有明确业务域的组件、hooks、api 和局部类型。
- 一个 feature 可以复用 `shared`/`components` 的通用 UI，但不要反向依赖别的 feature 内部实现。
- 从大文件迁移时优先切出完整业务闭环，如 `settings/friends`、`settings/bots`、`memory/files`。
- `features/memory` 承接 `MemoryPanel` 与 `MemoryPage` 的共享 parser、编辑器和视图；两个入口组件应只保留数据加载、状态编排和页面布局。
- `SettingsModal` 是设置页壳层：只持有顶层导航、Bot 列表加载、主题密度状态，不内联具体 pane 实现。
- `settings/bots` 拥有 Bot 设置入口、列表钻取、新建/编辑表单、Bot 展示辅助和 `BotRow` 类型；`SettingsModal` 只负责加载 Bot 列表并把数据传入 `BotPane`。
- `settings/models` 拥有模型管理闭环，并导出 `ModelBrandCard` / `modelBrandName` 给 Bot 创建与编辑复用。
- feature 内如果出现第二个可跨 feature 复用的组件，应再下沉到 `components/` 或未来的 `shared/ui/`。

### `components/app/`

应用级布局壳和主工作台专属组件。

```text
components/app/
├── AppModals.tsx         # 顶层弹窗组合，集中承接 App 的 modal 渲染
├── ChatShell.tsx          # 工作区栏 + 频道侧栏 + 主区域布局
├── ChannelMainFrame.tsx   # 频道主内容容器，包含拖拽上传覆盖层
├── ChatSidePanels.tsx     # 记忆侧栏、文件预览侧栏
├── AddBotModal.tsx        # 频道 Bot 管理弹窗
├── LazyPanelFallback.tsx  # 懒加载面板统一 loading 占位
└── MessageDetailModal.tsx # 消息详情弹窗
```

放置规则：

- 只放主聊天工作台相关组件。
- 组件可接收数据和回调，但不应直接承接全局业务编排。
- 与工作台无关的通用弹窗不要放这里。

### `components/members/`

成员、好友、Bot 行展示的统一组件层。

```text
components/members/
├── MemberListItem.tsx # 统一成员/Bot item
└── index.ts           # 统一导出
```

`MemberListItem` 是唯一标准成员项，适用于：

- 频道成员列表
- 好友列表
- 邀请成员列表
- Bot 列表
- 搜索结果里的用户/Bot
- 设置页里的成员角色行
- 记忆面板里的成员列表

禁止在新 UI 中重新手写头像、首字母、Bot 标签、当前用户“我”标识、成员行 hover/selected 状态。需要新形态时扩展 `MemberListItem` props 或样式变体。

### `components/icons/`

图标统一入口。

```text
components/icons/
├── AppIcon.tsx
├── FileTypeIcon.tsx
├── BrandIcon.tsx
├── AiBrandIcon.tsx
├── OtherIcon.tsx
├── iconMap.ts
└── index.ts
```

优先使用 `AppIcon` 和 `FileTypeIcon`。业务组件不要内联手写 SVG，除非是一次性、无法复用且没有现有图标能表达的图形。

### `components/`

业务面板、弹窗和复合组件。

```text
components/
├── Sidebar.tsx
├── ChannelHeader.tsx
├── MessageComposer.tsx
├── ChatMessageRenderer.tsx
├── MemoryPanel.tsx
├── SearchPicker.tsx
├── Modal.tsx
├── SettingsModal.tsx
├── ChannelSettingsModal.tsx
├── ChannelProfileModal.tsx
├── InviteMemberSearch.tsx
├── InviteWorkspaceMemberModal.tsx
├── CreateChannelModal.tsx
├── CreateWorkspaceModal.tsx
├── LoginModal.tsx
├── HelpModal.tsx
├── FilePreviewSidebar.tsx
├── ImageLightbox.tsx
├── SessionScopePanel.tsx
├── TopicPage.tsx
├── TopicComposer.tsx
├── TaskPage.tsx
├── OpenClawQcModal.tsx
├── AnnouncementComposerModal.tsx
├── DragOverlay.tsx
├── BotAvatar.tsx
├── ClarifyInlineBlock.tsx
└── ThinkMarkdownContent.tsx
```

放置规则：

- 某个页面或弹窗独有的状态可以留在本组件。
- 通用 UI 行、搜索、Modal、图标、成员项必须复用共享组件。
- 同一 UI 模式出现第二次时，应抽取到共享层。

## 页面级组件

```text
frontend/src/
├── App.tsx          # 主聊天工作台
├── DocsPage.tsx     # 帮助文档页
├── BulletinPage.tsx # 公告/议题页
├── MemoryPage.tsx   # 频道记忆全屏页
├── TodoPanel.tsx    # 待办面板
└── NotificationPanel.tsx # 通知面板
```

页面级组件可以组织完整业务流程，但不应复制共享视觉组件。`MemoryPage` 和 `MemoryPanel` 的成员展示都应走 `MemberListItem`，搜索都应走 `SearchPicker`。

## 统一搜索组件

`SearchPicker` 是唯一标准搜索框。

内部组件层级：

```text
components/
├── SearchPicker.tsx                 # 对外 API、请求状态、输入框、快捷键和 imperative handle
└── search/
    ├── SearchFilters.tsx            # 类型筛选 chips
    ├── SearchHighlight.tsx          # 命中文本高亮
    ├── SearchResultGroup.tsx        # 分组标题与列表
    ├── SearchResultItem.tsx         # 各类型结果行，用户/Bot 复用 MemberListItem
    ├── SearchScopeMenu.tsx          # 搜索范围切换菜单
    └── searchResultUtils.ts         # 结果 label、subtitle、key 等纯函数
```

适用场景：

- 全局导航搜索
- 成员搜索
- 好友搜索
- Bot 搜索
- 工作区邀请
- 频道邀请成员/Bot
- 文件搜索
- 消息搜索
- 待办/任务搜索

约定：

- 新 UI 不再新增专用搜索框。
- 后端入口优先使用 `GET /api/v1/search`。
- 通过 `context` 表达业务场景。
- 通过 `types` 控制结果类型，如 `users,bots,files,messages`。
- 通过 `workspace_id`、`channel_id` 控制搜索范围。
- 搜索结果中的用户/Bot 必须复用 `MemberListItem`。
- 文件结果使用 `FileTypeIcon`。
- 消息结果保留频道、发送人、片段展示。

## 统一成员项

`MemberListItem` 是成员、好友、Bot 的唯一标准 item。

核心 props：

| Prop | 用途 |
|------|------|
| `id` | 头像颜色和 key 的稳定来源 |
| `kind` | `user` / `bot` / `system` |
| `username` | 用户名，默认生成 `@username` 副标题 |
| `displayName` | 主显示名 |
| `name` | 自定义主显示内容，常用于搜索高亮 |
| `avatarUrl` | 头像 URL |
| `subtitle` | 自定义副标题 |
| `meta` | 附加元信息，如 Bot scope/owner |
| `badges` | 额外标签，如状态 chip |
| `leading` | 左侧选择框等控件 |
| `actions` | 右侧按钮或 select |
| `children` | 展开内容，如 Bot 模板选择 |
| `selected` | 选中态 |
| `self` | 当前用户态，显示“我”标识 |
| `variant` | `panel` / `card` |
| `compact` | 紧凑模式 |

使用规则：

- 列表行、卡片行、搜索用户/Bot 结果都应使用它。
- 如果行内包含 checkbox、select、button 等交互控件，使用 `actions`、`leading` 或 `children`，不要自行重写外层布局。
- 如果需要高亮文本，使用 `name` 插槽，不要复制头像和行样式。
- 如果需要新尺寸，优先添加 `variant` 或 CSS modifier。

## 样式层级

```text
styles/
├── design-tokens.css # 颜色、表面、按钮、搜索、成员项、面板等全局 token
└── composer.css      # 消息输入器专用样式
index.css             # Tailwind 入口和全局基础样式
```

样式规则：

- 优先使用 `design-tokens.css` 中的变量：`--bg-*`、`--fg-*`、`--border`、`--accent` 等。
- 通用组件样式写入 `design-tokens.css`。
- 只属于单个复杂组件的样式可局部保留，但不要复制已有 token。
- 避免新增散落的硬编码色值；确需新增时应先判断是否属于设计 token。
- 不要为了单个按钮、头像或行项新增一套临时 class。

## 数据、类型与工具层

```text
api/
├── client.ts
└── index.ts

hooks/
├── useAuth.ts
└── useResize.ts

lib/
├── agent-bridge.ts
├── app-config.ts
├── avatar.ts
├── bot-display.ts
├── bot-trace.ts
├── chat-routing.ts
├── cn.ts
├── density.ts
├── helper.ts
├── layer-meta.ts
├── message.ts
├── message-store.ts
├── message-window.ts
├── refresh.ts
└── think.tsx

types/
├── bot.ts
├── chat.ts
├── helper.ts
├── index.ts
├── member.ts
├── memory.ts
├── search.ts
├── session.ts
├── todo.ts
└── user.ts
```

约定：

- `api/` 只放请求封装和 API 基础能力。
- `hooks/` 放 React 状态复用逻辑。
- `lib/` 放纯函数、格式化、路由解析、消息窗口、Bot 展示逻辑。
- `types/` 放共享类型，并从 `types/index.ts` 统一导出。
- UI 组件不要定义可跨模块复用的业务类型；应下沉到 `types/`。

## 新组件放置决策

新增组件时按以下顺序判断：

1. 是路由页面吗？放 `frontend/src/*Page.tsx`，并在 `main.tsx` 注册。
2. 是主聊天工作台布局壳吗？放 `components/app/`。
3. 是完整业务弹窗或业务面板吗？放 `components/`。
4. 是成员、好友、Bot 行吗？扩展 `components/members/MemberListItem.tsx`。
5. 是搜索框或搜索结果吗？扩展 `components/SearchPicker.tsx`。
6. 是图标吗？放 `components/icons/` 并从 `components/icons/index.ts` 导出。
7. 是纯函数、格式化、数据转换吗？放 `lib/`。
8. 是共享类型吗？放 `types/`。

## 复用优先级

新增或改造 UI 时按以下优先级复用：

1. `SearchPicker`：所有搜索入口。
2. `MemberListItem`：所有用户、好友、成员、Bot item。
3. `Modal` / `ModalFooter`：所有标准弹窗。
4. `AppIcon` / `FileTypeIcon`：所有图标。
5. `BotAvatar`：Bot 头像大尺寸、品牌化展示；普通 Bot 行优先 `MemberListItem`。
6. `design-tokens.css`：颜色、间距、状态、按钮、搜索、成员项样式。

## 禁止事项

- 禁止新增第二套搜索组件。
- 禁止在业务组件里重复手写成员头像、首字母、Bot 标签、当前用户标识。
- 禁止把可复用 UI 继续堆进 `App.tsx`。
- 禁止绕过 `apiFetch` 自行复制请求认证逻辑。
- 禁止新增未归档的硬编码主题色和重复按钮样式。
- 禁止在页面组件里定义跨模块共享类型。

## 验证

前端改动至少运行：

```bash
cd frontend
npm run build
```

涉及样式、布局、搜索、成员项、文件预览、消息渲染时，还应本地启动并手工检查：

```bash
cd frontend
npm run dev
```

重点检查：

- 全局搜索、频道邀请、工作区邀请、添加好友是否都仍使用统一结果样式。
- 成员、好友、Bot、搜索结果中的用户/Bot 是否都使用一致头像和 item 样式。
- 移动端宽度下按钮、标签、成员名和搜索结果不重叠。
- 后端未启动时出现 Vite proxy `ECONNREFUSED` 属环境问题，不代表前端构建失败。
