---
title: Cheers Web Editorial Design System — 2026-08-12
date: 2026-08-12
tags:
  - Cheers
  - Web
  - Design-System
  - Editorial-UI
  - ActionKey
status: pull-request
pr: https://github.com/haowei2000/Cheers/pull/492
---

# Cheers Web Editorial Design System — 2026-08-12

## 今日结果

今天完成了 Cheers Web 编辑式设计语言的全量收口，并提交到 `develop`：

- Commit：`66118f54 fix(web): finish action and overflow system migration`
- PR：[#492 — fix(web): complete editorial design system migration](https://github.com/haowei2000/Cheers/pull/492)
- 关联 Issue：[#483 — Web Design System 全量修复](https://github.com/haowei2000/Cheers/issues/483)
- 分支：`codex/fix-composer-control-size`
- PR 共包含本轮连续的 4 个设计系统提交。

这次不是只更新 Gallery，而是正式 Web、静态网站、设计文档、Cheers design-system skill 和 CI 同步迁移。服务端 DTO、API、路由和业务状态没有变化。

## 最终设计规范

### 1. 字体体系

- `display`：网站介绍、masthead、大标题，强调古典正式感。
- `reading`：消息正文和长内容，使用 Source Serif 4；中文使用 Source Han Serif CN。
- `utility`：Bot 名、频道名、按钮、状态、warning、tracing、表单和操作界面，使用 Source Sans 3。
- Web 只允许 4 档字号：10 / 12 / 14 / 16px，对应 `minimal / compact / regular / comfortable`。
- 业务代码禁止创建字号例外，包括密集面板、Diff、Workbench 和 tracing。

### 2. 控件尺寸与形状

- ControlSize 固定为 `compact / regular / comfortable`：28 / 36 / 44px。
- 按钮、输入框、选择器、composer toolbar 和参与控件节奏的 header/row 使用同一尺寸系统。
- Button 全部消费全局 `regular` 字号 token，不在业务组件内自行声明 14px。
- 普通矩形圆角统一为 4px；identity、presence、unread、progress 等语义圆形才允许圆形。
- 静止 surface 保持无边框；层级通过背景、方向性 hairline、留白和选中状态表达。

### 3. Button 契约

按钮内容只有三类：

- `icon`：正方形，宽高随 ControlSize 为 28 / 36 / 44px。
- `text`：96px 标准宽度槽。
- `iconText`：128px 标准宽度槽。

`iconText` 内部把图标和文字拆成两个独立空间：图标占当前 ControlSize 的方形槽，文字占剩余宽度并独立拥有水平 padding。业务代码禁止覆盖共享按钮宽度、字号和水平 padding。

所有业务动作按钮必须声明共享 `ActionKey`：

- 可见标签由共享短动作词典生成。
- 英文最多 2 个词、8 个字符，并适配标准文字槽。
- 对象名和完整上下文进入 `aria-label` 或邻近状态，不拼入按钮正文。
- selector、tab、menu、disclosure 和 navigation 不是 Action，必须使用相应 primitive 或 ARIA role，不能伪造 ActionKey。
- ActionKey CI ceiling 已从 228 降为 0，且不允许注释例外。

### 4. 编辑模式

- 已有对象的 Edit 按钮必须紧邻对象。
- 编辑态在原位置切换为 Cancel / Save IconButton。
- 禁止在 section 底部放置与编辑对象分离的 Save/Edit 文本按钮。
- 仅首次创建或整页表单提交允许集中提交动作。

### 5. Item 与 Collection

- Browse Item 默认单行。
- anatomy 顺序固定为：`leading → title → critical status → optional status → actions`。
- 关键状态和 actions 不压缩；title 使用剩余宽度。
- Members、Claims、Links、Sessions、Notifications、Permissions、Fleet、Workbench 等管理结构统一使用 Item / ItemList / ItemSection / CollectionManager。
- 管理列表统一为 Search / Add / Edit / Delete 模式，不在 list 内直接拼装临时 Row/Card。
- Sidebar 的 Channels、Direct Messages 等是文字分隔 section，不再用 disclosure 展开按钮；当前频道有明确选中高亮。

### 6. 文字溢出

- 新增共享 `OverflowText`，真实检测文本是否溢出。
- 桌面 hover/focus 显示完整 Tooltip；触屏仅在截断时提供信息按钮和可复制 Popover。
- Button 禁止截断、ellipsis 和换行；通过短 ActionKey 解决按钮溢出。
- 普通标题、路径、ID、Session、Sidebar、FileTree 和 Workbench 使用共享溢出策略，删除业务层局部 `max-w-*` 配方。

### 7. Composer 与消息

- Composer 内按钮使用相同的 ControlSize、内容类型和宽度槽。
- Add context、Cost、模型、参数、语音、附件和发送动作不再由内容长度决定尺寸。
- Chat 和 Discussion 共用头像与消息身份样式；不在消息身份列重复显示时间或 Bot 标识。
- 消息正文使用 reading 字体，但字号受全局四档控制；details 降低干扰并按需展开。
- Discussion 顶部删除重复信息，标题和正文回到对应字体角色。

## 本次迁移范围

- Chat：Sidebar、Channel、Discussion、Message、Composer、Context、Session、Permission、Task Claim、Invite Links、Voice Room。
- Settings：Profile、Account、Security、Members、Admin Reports、Speech-to-text。
- Bots/Desktop：Bot onboarding/detail/activity、Connector、Agent Picker、Quick Panel、Local Open。
- Fleet/Friends：列表、筛选器、添加和状态操作。
- Workbench：File、Diff、Scene、ViewBoard、Activity、Audit、Sessions、Plugin、Template。
- Auth：登录、注册、验证码、密码重置和 OAuth 回调。
- Website：27 个静态页面与 editorial.css，统一字号、圆角、无边框 surface 和控件高度。

## 新增/强化的共享能力

- `ActionKey` 和共享动作标签词典。
- `Button` 的 icon / text / iconText 契约。
- `ControlTrigger`：selector、disclosure 和 navigation 等非动作触发器。
- `OverflowText`：真实截断检测与跨输入方式完整内容显示。
- `InlineEditActions`：贴近对象的 Edit / Cancel / Save IconButton。
- CheckboxField、Item、CollectionManager、ControlSize、ContentSize 和四档 Typography 的一致使用。

## CI 与验证

设计扫描当前结果：

- `action-key = 0`
- `detached-edit = 0`
- `radius / full / border = 0`
- `hardcoded-size / shared-size / shared-padding / shared-width = 0`
- `row-height / identity-size / icon-size / spacing / spinner-size = 0`
- `typography / button-typography = 0`
- 业务层未豁免原生按钮、输入、选择器和 textarea = 0
- Website 扫描：28 个文件，0 违规

验证命令：

- `npm run typecheck`：通过
- `npm run design-system:test`：23 / 23
- `npm run design-system:check`：通过
- `npm test -- --run`：201 / 201
- `npm run build`：通过
- `git diff --check`：通过

## 后续

- 等待 PR #492 CI 与 review，通过后合并到 `develop`。
- 在已登录环境重点回归 Chat、Discussion、Composer、Channel Settings、Profile、Account、Members、Fleet 和 Workbench。
- 合并后再创建 `develop → main` promotion PR；是否发版根据最终回归和产品变更范围决定。
- iOS 继续参考 [[Cheers-iOS-Item-System-Migration-2026-08-11]]，保持跨端语义契约一致。

