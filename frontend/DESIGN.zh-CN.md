# Cheers 前端设计规范

> **语言**: [English](DESIGN.md) | 中文

这是 Cheers Web 实现指南。跨端设计唯一事实源是
`../design-system/DESIGN_LANGUAGE.zh-CN.md`，机器可读 Item 契约是
`../design-system/item-contract.json`，可管理集合交互规范是
`../design-system/COLLECTION_MANAGER.zh-CN.md`。`src/components/ui/` 的共享组件负责
实现这些契约。

如果本文后续旧配方出现不同圆角、卡片包框、装饰边框、非三档高度、多行 Browse Item
或霓虹效果，以跨端设计真源为准；旧配方只作为迁移台账，不能被复制到新代码。

使用规则：

1. 有共享组件（`Button`、`Input`、`Dialog`、`Avatar`、`FloatingPanel`）就用组件，
   不要在行内重新实现它的样子。
2. 没有组件的，逐字复制下面的标准写法。
3. 确实需要新模式时，在同一个 PR 里把它补进本文档。

---

## 1. 设计 Token

### 颜色语义

| 角色 | Token | 说明 |
|---|---|---|
| 主色 / 可交互 | `indigo` | 按钮 `indigo-600`、focus ring `indigo-500`、链接 `indigo-400`、选中着色 `indigo-600/15` |
| 危险 / 错误 | `red` | 文字 `red-400`、软底 `red-950/40` —— 错误**禁用 `rose`** |
| 提醒 / @提及 | `rose-600` | 仅用于 mention 徽标，这是 rose 唯一的合法用途 |
| 成功 / 在线 | `emerald` | 圆点 `emerald-500`、文字 `emerald-400` |
| 警告 | `amber-400` | 文字用 `-400`；软底 `amber-900/40` |
| 灰阶 | 只用 `zinc` | 禁用 `gray`、`slate`、`neutral`、`stone` |
| 分类编码色 | 任意着色 | 编码**身份**而非状态的徽标——如权限能力标签（sky/violet）、按 bot 区分的活动圆点、头像调色板、语法高亮。只允许用在着色徽标/标记上；禁止用于交互元素、focus ring 或按钮。 |

中性前景严格收敛为四个语义层级：主正文、标题、普通按钮与功能图标使用 `zinc-50/100`；
次要正文使用 `zinc-200`；元数据、提示、placeholder、分组标签和辅助说明使用 `zinc-400`；
禁用状态沿用启用态前景并统一增加 `opacity-50`。`zinc-300/500/600/700` 不得作为 Web 前景色。
语义填充表面上的 `white` / `zinc-950` 和代码语法分类色属于明确例外。

### 表面层级（深色主题，由后到前）

| 层 | 值 |
|---|---|
| 应用背景 | `#09090b`（body）/ `bg-zinc-950` |
| 工作区侧轨 | `bg-rail`（`#0f0f11`） |
| 侧栏 | `bg-sidebar`（`#18181b`） |
| 卡片、弹窗、popover | `bg-zinc-900` —— 无边框；分层靠表面明度差 + 阴影 |
| 输入框 | `bg-zinc-800 ring-1 ring-inset ring-zinc-600` |
| chip、软按钮 | `bg-zinc-800`（chip 可用 `/60`） |
| 弹窗内的内凹字段 | `bg-zinc-950` |
| 软表面 hover | `bg-zinc-700` |

**分层原则——全面无边框。** 层与层之间靠表面明度差、阴影和有意识的间距分离，绝
不用会影响布局的盒式描边：按钮、输入框、卡片、chip、popover 一律禁止 `border border-*`。
表单字段使用中性内描边，确保边界与相邻深色表面至少达到 3:1 对比度。堆
叠区域默认用垂直和水平**间距**分组；只有需要像表格一样连续扫描的高密度数据区域
才保留 1px 分割线，tab 的下划线**指示器**仍然保留。ring 用于字段边界和**状态**：
中性（`ring-zinc-600`）、focus（`ring-indigo-500`）和错误（`ring-red-500`）。

### 排版

所有生产文字只使用 `text-minimal`、`text-compact`、`text-regular`、
`text-comfortable` 四档语义字号。字体族、光学变体、字号、行高、字距、字重、
前景层级和状态颜色均在全局 token 中定义。中性文字使用
`text-content-strong`、`text-content-primary`、`text-content-secondary`、
`text-content-muted`；状态文字使用 `text-accent-*`、`text-danger-*`、
`text-warning-*`、`text-success-*`、`text-info-*`、`text-removed-*`。
生产代码不直接使用 `text-zinc-*`、`text-red-*` 等原始色板前景类。
字体角色统一为 `display`、`reading`、`utility` 和 `code`。命令、路径、ID、
日志及 diff 使用 `font-code`；生产代码不使用通用的 `font-mono`。

| 角色 | 写法 |
|---|---|
| 页面 H1 | `text-comfortable font-semibold` |
| 弹窗 / 面板标题 | `text-regular font-semibold text-content-primary` |
| 正文 | `text-regular text-content-secondary` |
| 表单 label | `text-compact font-medium text-content-muted uppercase tracking-label` |
| 区块标题 | `text-compact font-semibold text-content-muted uppercase tracking-section` |
| 面板内分组标签 | `text-minimal uppercase tracking-label text-content-muted` |
| 提示 / 帮助文字 | `text-compact text-content-muted`（有意义文字的最低对比层级） |
| 代码 / 路径 / ID | `font-code text-compact` |
| 密集面板 mini 阶 | `text-compact` / `text-minimal` —— 下限 10px |

### 形状与状态

- 圆角：Web 普通矩形统一 10px。嵌套浮层使用同一规则的同心计算：外层圆角 = 10px +
  实际内容 inset。普通表面使用 `rounded-sm`，浮层使用 `rounded-concentric` 并设置
  `--concentric-inset`；禁止再引入另一固定圆角。支持的浏览器用 `corner-shape: squircle`
  增强连续曲线，其余浏览器回退到标准 `border-radius`。`rounded-full` 只用于 Avatar、
  Presence、Unread、Progress 等形状携带语义的对象。
- Focus：`focus:ring-2 focus:ring-indigo-500`（按钮用 `focus-visible:`）——**禁止**用 `focus:border-indigo-*` 替代
- 错误：字段上加 `ring-1 ring-red-500/70` —— 是状态 ring，不是常驻边框
- Disabled：统一 `disabled:opacity-50`
- 过渡：所有可交互元素带 `transition-colors`

---

## 2. 组件目录

### 2.1 按钮 —— 一律无边框

用 `<Button>`（`src/components/ui/button.tsx`）。变体：`primary`（indigo 实心）、
`secondary`（zinc 软底）、`ghost`（透明）、`danger`（红字）。物理尺寸只通过
`ControlSize`：compact 28px、regular 36px、comfortable 44px。纯图标按钮使用同一档位，
不能另建 32px 第四档。

关闭、展开、保存等常用动作必须用 `<ActionButton action context>`；业务调用点不得自行指定
`content` 或 `variant`。窗口栏的 Back / Close / More / Refresh、展开收起、已有对象的行内
Edit / Save / Cancel / Delete / Remove 使用纯图标；完整表单的 Create / Save 使用图标加文字，
Back / Cancel 使用文字；弹窗底部 Back / Cancel 使用文字；破坏性确认使用文字 Cancel 加
图标文字 Delete / Remove。若整行内容本身就是展开目标（例如 diff 文件标题），使用
`ControlTrigger`，不要把对象标题替换成通用的 Expand / Collapse 标签。纯图标动作在邻近上下文
不足时必须提供对象化的 `accessibleLabel`。

组件不适用的场景（密集 workbench 面板），软底写法：

| 类型 | 写法 |
|---|---|
| 中性软底 | `rounded-lg bg-zinc-800 text-content-secondary hover:bg-zinc-700 hover:text-content-primary` |
| indigo 软底 | `rounded-lg bg-indigo-600/15 text-accent-200 hover:bg-indigo-600/30` |
| 危险软底 | `rounded-lg bg-red-950/40 text-danger-300 hover:bg-red-950/70` |
| 警告软底 | `rounded bg-amber-900/40 text-warning-200 hover:bg-amber-900/60` |

**禁止**：任何按钮上出现 `border border-*`（唯一例外：`fileView.tsx` 的虚线
staged-file chip，虚线表达"尚未拉取"）。禁止手写 `bg-indigo-600` 主按钮——用
`<Button>`。

### 2.2 搜索 / 过滤框 —— 三种形态

同一套视觉语言，三种放置方式。图标统一用 lucide `Search`（或语境图标），
`w-3.5`–`w-4 text-content-muted`，内部 input 透明。

**A. 弹窗内选择器搜索** —— 样式在 wrapper 上，input 裸写。
用于 NewChannelDialog、NewDmDialog、频道设置的成员搜索：

```tsx
<div className="flex items-center gap-2 rounded-lg bg-zinc-950 px-3 py-2
                focus-within:ring-2 focus-within:ring-indigo-500 transition-shadow">
  <Search className="w-4 h-4 text-content-muted" />
  <input className="flex-1 bg-transparent text-regular text-content-secondary outline-none
                    placeholder:text-content-muted" placeholder="…" />
</div>
```

**B. 页面级过滤框** —— 自包含 input + 绝对定位图标。
用于 AdminUsers 过滤、FriendsPage 查找：

```tsx
<div className="relative">
  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-content-muted" />
  <input className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-950
                    text-comfortable md:text-regular text-content-primary placeholder:text-content-muted
                    focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow" />
</div>
```

**C. popover 内联过滤** —— 分割线上的裸 input，无盒子。
用于密集 popover / 面板（ActivityPanel 搜索）：

```tsx
<input className="w-full bg-transparent border-b border-zinc-800 px-1 py-1.5
                  text-compact text-content-secondary outline-none placeholder:text-content-muted
                  focus:border-indigo-500/60" />
```

注意：移动端可达的 input 一律 `text-comfortable md:text-regular`（防 iOS 聚焦自动缩放）。
弹窗内字段底色用 `bg-zinc-950`（内凹感）；`zinc-950` 页面上独立出现时用
`bg-zinc-900`。

### 2.3 文本输入

单行文本用 `<Input>`。输入类字段是**带中性内描边的填充盒**——填充色表达可输入性，
内描边保证字段边界与相邻深色表面至少达到 3:1；focus / error 会替换中性 ring。
select / textarea 镜像同一写法：

```tsx
// 字段标准写法（input / select / textarea）—— 无影响布局的边框
className="rounded-lg bg-zinc-800 px-3 py-2 text-regular text-content-primary placeholder:text-content-muted
           ring-1 ring-inset ring-zinc-600
           focus:outline-none focus:ring-2 focus:ring-indigo-500
           disabled:opacity-50"
// 错误态：追加 ring-1 ring-red-500/70
```

### 2.4 浮层表面

所有浮层表面无边框——模态靠调暗的遮罩、popover 和窗口靠阴影完成分离：

| 表面 | 写法 |
|---|---|
| 模态弹窗（用 `<Dialog>`） | 遮罩 `bg-black/50`，卡片 `rounded-xl bg-zinc-900 p-4` —— 无需阴影 |
| 锚定 popover | `rounded-xl bg-zinc-900 shadow-xl shadow-black/40` |
| 自动补全 / 菜单列表 | 同 popover，紧凑列表可用 `rounded-lg` |
| 可拖拽窗口（用 `<FloatingPanel>`） | `rounded-xl bg-zinc-900/95 backdrop-blur-sm shadow-2xl shadow-black/50` |

`shadow-2xl` 只给可拖拽窗口；锚定 popover 用 `shadow-xl`。

### 2.5 Chip（composer、文件）

无边框软胶囊：`rounded-lg bg-zinc-800/60 px-2 py-1 text-compact`。
可交互的加 `hover:bg-zinc-800 hover:text-content-secondary`；激活/展开态切换为
`bg-indigo-600/15 text-accent-200`。

### 2.6 徽标与计数

| 徽标 | 写法 |
|---|---|
| BOT 标签 | `text-minimal px-1 py-0.5 rounded bg-indigo-900/60 text-accent-300 font-medium` |
| 未读计数 | `text-minimal font-bold bg-indigo-600 text-content-on-accent rounded-full px-1.5 py-0.5 min-w-[18px] text-center` |
| 提及计数 | 同上形状，`bg-rose-600` |
| 角色 / 状态标签 | 名字旁纯文字 `text-minimal text-content-muted`（不做 pill） |

### 2.7 在线状态点

头像右下叠加 `w-2 h-2 rounded-full ring-2 ring-zinc-900`；在线 `bg-emerald-500`、
离线 `bg-zinc-600`。一种尺寸、一种描边方式——不要混用 `border` 和 `ring` 两种写法。
（这个 ring 是头像上的镂空遮罩，不是装饰性边框。）

### 2.8 Tab —— 只允许两种

- **下划线 Tab**（页面与详情导航——FriendsPage、BotDetailPanel）：
  容器 `flex gap-1 border-b border-zinc-800`；项
  `px-3 py-2 text-regular border-b-2 -mb-px transition-colors`，激活
  `border-indigo-500 text-content-primary`，未激活
  `border-transparent text-content-muted hover:text-content-secondary`。
- **胶囊 Tab**（密集面板工具栏——ViewBoard）：
  `rounded-md px-2 py-1 text-compact`，激活 `bg-zinc-800 text-content-primary`，
  未激活 `text-content-muted hover:bg-zinc-800/60 hover:text-content-secondary`。

不要引入第三种；分段控件（segmented control）复用胶囊写法放进 `bg-zinc-800` 容器。

### 2.9 空态

标准是 Plan 面板：居中，图标 + 主文案 + 副文案。

```tsx
<div className="flex flex-col items-center justify-center py-8 text-center">
  <SomeIcon className="w-5 h-5 text-content-muted mb-2" />
  <p className="text-compact text-content-muted">Nothing here yet</p>
  <p className="text-compact text-content-muted mt-0.5">It appears when …</p>
</div>
```

紧凑列表可用单行版：`text-compact text-content-muted py-4 text-center`。

### 2.10 加载态

- 行内 / 操作中：`Loader2` 图标 + `animate-spin`，颜色继承 `currentColor`。
- 整面加载：`Loader2 w-5 h-5 text-content-muted animate-spin` 居中。
- 按钮：用 `<Button>` 自带的 `loading` prop。
- 禁止手写 CSS border 圆环 spinner；等待不长时不要 spinner + "Loading…" 双重表达。

### 2.11 关闭按钮

`text-content-muted hover:text-content-secondary`，`X w-4 h-4`，右上角。抽屉和浮动面板可加
`rounded p-0.5 hover:bg-zinc-800`。hover 目标色是 `zinc-300`——不是 `zinc-200`。

### 2.12 列表行

可选择行：`px-2.5 py-1.5 rounded-md text-regular hover:bg-zinc-800`；
选中 `bg-zinc-800 text-content-primary`（导航列表可按 §2.8 的激活胶囊加 indigo 着色）。
所有可交互行必须有 hover 态。

### 2.17 错误提示——三级体系

级别由**用户当前工作还剩多少可用**决定，而不是技术严重程度——并且每个错误都
必须给出口（Retry / Sign in again / Reload / Go back），不能只陈述失败。
（英文版 §2.13–2.16 暂未镜像，本节编号与英文版对齐。）
各层级的可交互设计稿（浏览器直接打开，含 live 演示）：
[docs/design/ERROR_NOTIFICATIONS.html](../docs/design/ERROR_NOTIFICATIONS.html)。

| 级别 | 用户状态 | 形态 | 组件 |
|---|---|---|---|
| **S · 轻** | 可以继续工作 | toast，右下角，自动消失 | `notify.error/warning/success/info`（`src/lib/notify.tsx`），可带一个动作 `{ label, onClick }` |
| **M · 中** | 还能看，但上下文已降级 | 常驻软色条，置于受影响区域顶部；反映"状态"，状态解除即卸载 | `<Banner severity icon action onDismiss>`（`src/components/ui/banner.tsx`） |
| **L · 重** | 必须先处理 | 阻塞对话框 · 面板/整页错误态 | `<ErrorDialog action?>` · `<ErrorState>`（`src/components/ui/error-state.tsx`） |

已有的全局接线——扩展它，不要重建：

- **登录过期**：任何带 token 请求的 401（`api/client.ts` 分类器，`/auth/*` 豁免）
  或 ws `auth_err` 都会置位 `authStore.sessionExpired` → `App` 渲染全屏
  **Session expired** 接管页，"Sign in again" 经 `/login?redirect=…` 回跳。
  **不要在调用点单独处理 401。**
- **渲染崩溃**：顶层 `ErrorBoundary`（`main.tsx`）渲染 `ErrorState`
  （Reload + 复制错误详情）。无理由不要加页面级 boundary。
- **连接断开**：`useChatRealtime().status` 驱动 ChannelView 的
  「Connection lost」`<Banner>`（1.5s 宽限再显示；重订阅后自动收起；
  "Retry now" = `reconnectNow`）。

状态 → 级别速查：`401` → L 接管（自动）· 路由级 `403`/`404` → 面板内
`<ErrorState>` · 校验 `409`/`422` → 优先字段旁 inline（§2.3 错误 ring +
`text-danger-400`），无表单才 toast · `429`/`5xx`/网络 → `notify.error`，可重试
就带 Retry 动作 · ws 断开 → M 级 banner。错误有锚点（某条消息、某个字段）时
inline 优先于 toast——保留 `MessageItem` 式的「Failed to send + Retry」行。

**不要**：`toast.error(String(e))`——会把已人性化的 `ApiError` 文案退化回
`Error: …`；用 `notify.error(messageOf(e))`。`<ErrorState>` 能覆盖时不要手写
整页错误标记。

---

## 3. 已知缺口（组件抽取路线图）

以下模式应逐步升级为 `src/components/ui/` 组件——在那之前，复制上面的写法：

1. `Select` / `Textarea`（镜像 `Input`）
2. `SearchInput`（§2.2 的 A、B 两种形态）
3. `EmptyState`（§2.9）
4. `Spinner`（§2.10）
5. `Field` + `Label`（label + 控件 + 提示的组合，§1 排版）
6. `Badge`（§2.6）

本文档来源：2026-07-10 的两份视觉一致性审查（静态扫描 + 线上实测，
见 PR #134 背景）。

---

## 4. 反模式清单

Review 时直接打回：

- [ ] 任何位置出现 `gray-*` / `slate-*` / `neutral-*` / `stone-*`
- [ ] 错误语义用 `rose-*`（rose 只属于 mention）
- [ ] 任何位置出现盒式边框——按钮、输入框、卡片、chip、popover 上的 `border border-*`（区域之间的 1px `border-b` 分割线除外）
- [ ] 手写 `bg-indigo-600` 主按钮
- [ ] 用 `focus:border-*` 替代 focus ring
- [ ] `outline-none` 而没有替代的 focus 可见性
- [ ] 原始枚举 / 字段名直接进 UI（`in_progress`、`system_admin`、`bot_id`）
- [ ] §2 已有的模式（tab / 空态 / spinner）又发明新样式
- [ ] `toast.error(String(e))`——用 `notify.error(messageOf(e))`（§2.17）
- [ ] §2.17 已有对应级别时手写错误横条 / 整页错误标记；在调用点单独处理 401（归 client 分类器管）
