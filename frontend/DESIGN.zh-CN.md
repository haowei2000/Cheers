# Cheers 前端设计规范

> **语言**: [English](DESIGN.md) | 中文

Cheers 前端的视觉契约。**`src/components/ui/` 下的共享组件是唯一事实来源**——
本文档记录它们尚未覆盖的部分的标准写法（canonical recipe），让新 UI 复制一个
已知形态，而不是发明一个新形态。

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

### 表面层级（深色主题，由后到前）

| 层 | 值 |
|---|---|
| 应用背景 | `#09090b`（body）/ `bg-zinc-950` |
| 工作区侧轨 | `bg-rail`（`#0f0f11`） |
| 侧栏 | `bg-sidebar`（`#18181b`） |
| 卡片、弹窗、popover | `bg-zinc-900` —— 无边框；分层靠表面明度差 + 阴影 |
| 输入框、chip、软按钮 | `bg-zinc-800`（chip 可用 `/60`） |
| 弹窗内的内凹字段 | `bg-zinc-950` |
| 软表面 hover | `bg-zinc-700` |

**分层原则——全面无边框。** 层与层之间靠表面明度差和阴影分离，绝不用盒式描边：
按钮、输入框、卡片、chip、popover 一律禁止 `border border-*`。堆叠区域之间的
1px **分割线**（`border-b border-zinc-800`）和 tab 的下划线**指示器**保留。
ring 只作为**状态**出现：focus（`ring-indigo-500`）和错误（`ring-red-500`）。

### 排版

| 角色 | 写法 |
|---|---|
| 页面 H1 | `text-lg font-semibold` |
| 弹窗 / 面板标题 | `text-sm font-semibold text-zinc-100` |
| 正文 | `text-sm text-zinc-200/300` |
| 表单 label | `text-xs font-medium text-zinc-500 uppercase tracking-wide` |
| 区块标题 | `text-xs font-semibold text-zinc-500 uppercase tracking-wider` |
| 面板内分组标签 | `text-[10px] uppercase tracking-wide text-zinc-500` |
| 提示 / 帮助文字 | `text-xs text-zinc-500`（更暗用 `zinc-600`） |
| 密集面板 mini 阶 | `text-[11px]` / `text-[10px]` —— 下限 10px |

### 形状与状态

- 圆角：chip/输入框/按钮 `rounded-md`(小)/`rounded-lg`(中) · 卡片与 popover `rounded-xl` · 胶囊 `rounded-full`
- Focus：`focus:ring-2 focus:ring-indigo-500`（按钮用 `focus-visible:`）——**禁止**用 `focus:border-indigo-*` 替代
- 错误：字段上加 `ring-1 ring-red-500/70` —— 是状态 ring，不是常驻边框
- Disabled：统一 `disabled:opacity-50`
- 过渡：所有可交互元素带 `transition-colors`

---

## 2. 组件目录

### 2.1 按钮 —— 一律无边框

用 `<Button>`（`src/components/ui/button.tsx`）。变体：`primary`（indigo 实心）、
`secondary`（zinc 软底）、`ghost`（透明）、`danger`（红字）。尺寸：`sm`（h-7）、
`md`（h-9）、`icon`（h-8 方形）。

组件不适用的场景（密集 workbench 面板），软底写法：

| 类型 | 写法 |
|---|---|
| 中性软底 | `rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100` |
| indigo 软底 | `rounded-lg bg-indigo-600/15 text-indigo-200 hover:bg-indigo-600/30` |
| 危险软底 | `rounded-lg bg-red-950/40 text-red-300 hover:bg-red-950/70` |
| 警告软底 | `rounded bg-amber-900/40 text-amber-200 hover:bg-amber-900/60` |

**禁止**：任何按钮上出现 `border border-*`（唯一例外：`fileView.tsx` 的虚线
staged-file chip，虚线表达"尚未拉取"）。禁止手写 `bg-indigo-600` 主按钮——用
`<Button>`。

### 2.2 搜索 / 过滤框 —— 三种形态

同一套视觉语言，三种放置方式。图标统一用 lucide `Search`（或语境图标），
`w-3.5`–`w-4 text-zinc-500`，内部 input 透明。

**A. 弹窗内选择器搜索** —— 样式在 wrapper 上，input 裸写。
用于 NewChannelDialog、NewDmDialog、频道设置的成员搜索：

```tsx
<div className="flex items-center gap-2 rounded-lg bg-zinc-950 px-3 py-2
                focus-within:ring-2 focus-within:ring-indigo-500 transition-shadow">
  <Search className="w-4 h-4 text-zinc-500" />
  <input className="flex-1 bg-transparent text-sm text-zinc-200 outline-none
                    placeholder:text-zinc-600" placeholder="…" />
</div>
```

**B. 页面级过滤框** —— 自包含 input + 绝对定位图标。
用于 AdminUsers 过滤、FriendsPage 查找：

```tsx
<div className="relative">
  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
  <input className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-950
                    text-base md:text-sm text-zinc-100 placeholder:text-zinc-600
                    focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow" />
</div>
```

**C. popover 内联过滤** —— 分割线上的裸 input，无盒子。
用于密集 popover / 面板（ActivityPanel 搜索）：

```tsx
<input className="w-full bg-transparent border-b border-zinc-800 px-1 py-1.5
                  text-xs text-zinc-200 outline-none placeholder:text-zinc-600
                  focus:border-indigo-500/60" />
```

注意：移动端可达的 input 一律 `text-base md:text-sm`（防 iOS 聚焦自动缩放）。
弹窗内字段底色用 `bg-zinc-950`（内凹感）；`zinc-950` 页面上独立出现时用
`bg-zinc-900`。

### 2.3 文本输入

单行文本用 `<Input>`。输入类字段是**无边框的填充盒**——填充色就是可输入的
提示，ring 只表达状态。select / textarea 在共享组件出现前镜像同一写法：

```tsx
// 字段标准写法（input / select / textarea）—— 无边框
className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600
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

无边框软胶囊：`rounded-lg bg-zinc-800/60 px-2 py-1 text-[11px]`。
可交互的加 `hover:bg-zinc-800 hover:text-zinc-200`；激活/展开态切换为
`bg-indigo-600/15 text-indigo-200`。

### 2.6 徽标与计数

| 徽标 | 写法 |
|---|---|
| BOT 标签 | `text-[10px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300 font-medium` |
| 未读计数 | `text-[10px] font-bold bg-indigo-600 text-white rounded-full px-1.5 py-0.5 min-w-[18px] text-center` |
| 提及计数 | 同上形状，`bg-rose-600` |
| 角色 / 状态标签 | 名字旁纯文字 `text-[10px] text-zinc-500`（不做 pill） |

### 2.7 在线状态点

头像右下叠加 `w-2 h-2 rounded-full ring-2 ring-zinc-900`；在线 `bg-emerald-500`、
离线 `bg-zinc-600`。一种尺寸、一种描边方式——不要混用 `border` 和 `ring` 两种写法。
（这个 ring 是头像上的镂空遮罩，不是装饰性边框。）

### 2.8 Tab —— 只允许两种

- **下划线 Tab**（页面与详情导航——FriendsPage、BotDetailPanel）：
  容器 `flex gap-1 border-b border-zinc-800`；项
  `px-3 py-2 text-sm border-b-2 -mb-px transition-colors`，激活
  `border-indigo-500 text-zinc-100`，未激活
  `border-transparent text-zinc-500 hover:text-zinc-300`。
- **胶囊 Tab**（密集面板工具栏——ViewBoard）：
  `rounded-md px-2 py-1 text-xs`，激活 `bg-zinc-800 text-zinc-100`，
  未激活 `text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300`。

不要引入第三种；分段控件（segmented control）复用胶囊写法放进 `bg-zinc-800` 容器。

### 2.9 空态

标准是 Plan 面板：居中，图标 + 主文案 + 副文案。

```tsx
<div className="flex flex-col items-center justify-center py-8 text-center">
  <SomeIcon className="w-5 h-5 text-zinc-600 mb-2" />
  <p className="text-xs text-zinc-500">Nothing here yet</p>
  <p className="text-[11px] text-zinc-600 mt-0.5">It appears when …</p>
</div>
```

紧凑列表可用单行版：`text-xs text-zinc-600 py-4 text-center`。

### 2.10 加载态

- 行内 / 操作中：`Loader2` 图标 + `animate-spin`，颜色继承 `currentColor`。
- 整面加载：`Loader2 w-5 h-5 text-zinc-600 animate-spin` 居中。
- 按钮：用 `<Button>` 自带的 `loading` prop。
- 禁止手写 CSS border 圆环 spinner；等待不长时不要 spinner + "Loading…" 双重表达。

### 2.11 关闭按钮

`text-zinc-500 hover:text-zinc-300`，`X w-4 h-4`，右上角。抽屉和浮动面板可加
`rounded p-0.5 hover:bg-zinc-800`。hover 目标色是 `zinc-300`——不是 `zinc-200`。

### 2.12 列表行

可选择行：`px-2.5 py-1.5 rounded-md text-sm hover:bg-zinc-800`；
选中 `bg-zinc-800 text-zinc-100`（导航列表可按 §2.8 的激活胶囊加 indigo 着色）。
所有可交互行必须有 hover 态。

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
