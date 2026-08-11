---
title: Cheers Web Item System Implementation
date: 2026-08-11
tags:
  - Cheers
  - Web
  - Design-System
  - Item-System
status: implemented
---

# Cheers Web Item System Implementation

## 本次结果

Web 已从“业务页面各自拼装 Row/Card”迁移到共享 Item anatomy。Gallery 不再是孤立设计稿，正式聊天、设置、Fleet、通知、权限和 Workbench 调用点已经接入同一套组件。服务端 DTO、API 和业务行为保持不变。

iOS 本轮没有改代码，后续工作见 [[Cheers-iOS-Item-System-Migration-2026-08-11]]。

## 共享组件

核心实现：`frontend/src/components/ui/item.tsx`

- `ItemRow`：统一 leading、title、subtitle、metadata、preview、关键状态、普通状态、trailing 和 actions。
- `ItemList` / `ItemSection`：统一列表、分组标题和间距。
- `EntityItem`：User、Bot、Member、Friend、Passkey、Device 等身份实体。
- `NavigationItem`：Channel、DM、Mention、Forward destination、Session option。
- `OperationsItem`：Approval、Task Claim、Notification、Invite、Grant、Report、Session。
- `WorkbenchItem`：Plugin、Template、Activity、Audit、Plan、Connector。
- `FileTreeItem`：保留 treeitem、层级、选中和 disclosure 语义。
- `DiffLineItem`：保留 Diff 行号、增删状态和等宽文本语义。
- `ItemChip`：Context 等紧凑语义标签。

## 交互契约

- `PresentationLevel = max | medium | minimal`，默认 `medium`。
- 页面环境提供默认 level，单个 Item 可以显式覆盖。
- 单一整行交互使用 `onClick`，不能同时提供 `actions`。
- 复合操作行不允许整行点击，按钮只能进入 `actions` slot。
- `trailing` 只放时间、计数等非交互信息。
- error、approval、unread、mention、online、disabled 等关键状态在 minimal 下仍保持可感知。
- 文件树、Diff、数据表继续使用正确的专用结构，不机械转换成普通 ItemRow。

## 已迁移的正式 Web 区域

### 身份与成员

- Bot 管理、Fleet Bot。
- 用户管理、成员列表、成员搜索结果。
- Workspace / Channel 成员管理。
- Voice Channel 在线参与者。
- Passkey 和 Device Session。

### 导航与选择器

- Channel、DM。
- New DM 用户与 Bot 选择。
- Forward destination。
- Mention suggestions。
- Session picker / Session chip。

### 通知与运行管理

- Notification、Invite。
- Task Claim。
- Permission Grant、Bot-to-Bot Grant。
- Admin Report。
- Agent Update。
- Session controller；保留拖拽设为 primary 的行为，行 anatomy 使用 `OperationsItem`。

### Workbench

- Plugin、Template、Personal Plugin。
- Activity、Connection History、Audit。
- Plan、Pinned File。
- Connector change、Connector instance header、Connector audit event。
- File tree 使用 `FileTreeItem`。
- Diff 使用 `DiffLineItem`。
- Kanban task 使用 `WorkbenchItem`，保留左右移动和删除动作。

## 视觉语言

- Item 保持无卡片边框风格，以细分隔线、左侧选中标记和背景变化表达层级。
- 圆角统一为 2px / `rounded-sm`。
- 名称、频道、按钮、状态和 tracing 使用 Source Sans 3 utility 字体。
- 消息正文和长预览使用 Source Serif 4 reading 字体。
- 网站介绍和大标题使用更正式的 display / masthead 字体角色。
- 业务语义图标统一映射到 editorial icon 系统；避免页面自行挑选含义相近但造型不同的图标。

### 多语言三级字体补充

- `display`：拉丁/希腊/西里尔使用 Source Serif 4 Display；中文使用 Source Han Serif CN Semibold。
- `reading`：拉丁/希腊/西里尔使用 Source Serif 4 Text；中文使用 Source Han Serif CN Regular/Semibold。
- `utility`：Web 使用 Source Sans 3，并保留平台多语言无衬线 fallback。
- 中文字体取自 Adobe 官方 Source Han Serif 2.003R，许可证为 SIL OFL 1.1，可随商业软件分发；许可证保存在 `design-system/fonts/SourceHanSerif-OFL.txt`。
- Web 使用 11 MB WOFF2 地区可变字体，只在页面出现中文衬线文本时加载，并从 PWA 首装预缓存中排除。

## Gallery 与回归保护

- Gallery：`frontend/src/components/ui/ItemGallery.tsx`
- 本地入口：`/dev/item-gallery.html`
- Gallery 覆盖 max、medium、minimal，以及 Entity、Navigation、Conversation、Feedback、Operations、Workbench、Context、File Tree 和 Diff。
- `scripts/check-design-system.mjs` 检查共享组件登记和旧配方基线。
- 检查业务 `.map()` 中直接返回的 `<button>`、`<li>`、`<div>` Row。
- 合理的 menu、form、code list、trace line、section wrapper 必须写明 `design-system-exempt: <reason>`。
- Web 原生 `<button>` ceiling 从 309 下调为 303，禁止数量反弹。
- `design-system/INVENTORY.md` 记录各平台的 `shared / partial / specialized / unavailable` 状态。

## 验证结果

- `npm run typecheck`：通过。
- `npm test -- --run`：25 个测试文件、167 个测试通过。
- `npm run build`：通过，PWA service worker 正常生成。
- `npm run design-system:check`：通过，共登记 46 个 item kind、3 个 presentation level。
- Gallery 在 1280px、768px、390px 下没有页面级横向溢出。
- Gallery 中嵌套 `<button>` 数量为 0。
- Gallery 浏览器 console warning / error 为 0。

## 关键文件

- `frontend/src/components/ui/item.tsx`
- `frontend/src/components/ui/item.test.tsx`
- `frontend/src/components/ui/ItemGallery.tsx`
- `frontend/src/components/ui/presentation.tsx`
- `frontend/src/components/ui/editorial-icons.tsx`
- `design-system/item-contract.json`
- `design-system/INVENTORY.md`
- `scripts/check-design-system.mjs`
- `docs/obsidian/Cheers-iOS-Item-System-Migration-2026-08-11.md`

## 后续工作

- 在已登录状态继续回归 Sidebar、Fleet、Friends、成员管理、通知审批、Settings 和 Workbench。
- 后续新增语义 Item 必须先登记共享 contract，再实现业务调用点。
- 按 iOS Obsidian 计划分阶段迁移 SwiftUI，本轮不修改 iOS。
- Android 未支持的能力继续标记为 `unavailable`，不创建占位页面。
