---
title: Cheers iOS Item System Migration
date: 2026-08-11
tags:
  - Cheers
  - iOS
  - SwiftUI
  - Design-System
status: implemented
---

# Cheers iOS Item System Migration

## 实施结果

2026-08-11 已完成 SwiftUI 代码迁移。共享层新增 `CheersItemButton`、`CheersEntityItem`、`CheersNavigationItem`、`CheersOperationsItem`、`CheersWorkbenchItem`、`CheersFileTreeItem` 和 `CheersDiffLineItem`；正式业务调用点已迁移，服务端 DTO/API 未修改。

本次保留 SwiftUI 原生 `List`、`NavigationLink`、`Menu`、`swipeActions`、`ShareLink`、confirmation dialog 和 Dynamic Type 行为。复合操作通过 `actions` slot 表达，单一整行操作通过 `CheersItemButton` 表达。

## 目标

将 iOS 中由页面直接组合的 User、Bot、Member、Friend、Passkey、Session、Mention、Forward、Task Claim、ViewBoard 和 Workbench Row 收口到共享 Item anatomy，同时保留 SwiftUI `List`、`NavigationLink`、`swipeActions`、`Menu` 和系统可访问性行为。服务端 DTO 与 API 不变。

## 公共组件决策

- 扩展 `CheersItemRow`，继续继承 `PresentationLevel = max | medium | minimal`，显式 level 始终覆盖 Environment。
- 单一整行交互由外层 `Button` 或 `NavigationLink` 包裹 Item；复合操作 Item 本身保持非交互，动作放入 `actions` slot，禁止嵌套 Button。
- `trailing` 只承载时间、计数等非交互信息；新增 `actions`、`primaryAction`、`overflowAction` 语义。
- 建立 `EntityItem`、`OperationsItem`、`WorkbenchItem` SwiftUI wrapper；文件树、Diff、表格使用专用结构与共享 token，不伪装成普通 Item。
- error、approval、unread、mention、online、disabled 等关键状态在三档中都必须可感知；minimal 只能移除非关键信息。

## 当前迁移台账

| 区域 | 迁移结果 | 状态 |
|---|---|---|
| Agents / Fleet | `CheersEntityItem`；待审批入口为 `CheersOperationsItem` | completed |
| Friends / requests / blocked | `CheersEntityItem` + actions / swipe actions | completed |
| Members / candidates / invite links | `CheersEntityItem` / `CheersOperationsItem` | completed |
| Passkeys / device sessions | `CheersOperationsItem` | completed |
| Mention / Forward / New DM | `CheersNavigationItem` | completed |
| Task Claim / Approval / Invite | `CheersOperationsItem`，审批状态始终保留 | completed |
| Sessions / Plan / Activity / Audit | `CheersNavigationItem` / `CheersWorkbenchItem` | completed |
| Workbench templates / files / Diff | `CheersWorkbenchItem` / `CheersFileTreeItem` / `CheersDiffLineItem` | completed |

Conversation/Channel/DM 已经通过 `ConversationRowView → CheersItemRow`，迁移时作为行为和视觉基线，不再创建第二套会话 Row。

## 实施阶段

1. **共享 API**：已完成复合动作模型、wrapper 和 Preview。
2. **身份与选择器**：已迁移 Agents、Friends、Members、Mention、Forward 和 New DM。
3. **运行与管理**：已迁移 Passkey、Device Session、Task Claim、Activity、Approval 和 Invite Link。
4. **Workbench**：已迁移 ViewBoards、模板、文件树和 Diff；表格保持原生语义。
5. **约束收口**：跨端 inventory 和 CI primitive 登记已更新。Android 未支持能力继续为 `unavailable`。

## Dynamic Type 与 VoiceOver

- 不使用固定高度截断正文；44pt 只是最小触控高度。
- `title/subtitle/metadata` 使用语义字体并允许 Dynamic Type；超大字号下 actions 移到菜单或下一行。
- Avatar 与装饰图标隐藏重复朗读；整行组合出名称、关键状态和动作结果。
- online/offline、approval、error、disabled 不只依赖颜色；提供文字或 accessibility value。
- `swipeActions`、`Menu` 中的 destructive action 保留系统 role，并提供等价 VoiceOver 操作。

## 验证与完成标准

- 每种 wrapper 提供 max、medium、minimal Preview，以及 selected、disabled、loading、error、approval、online 示例。
- 在默认字号和最大辅助字号下检查 iPhone 纵向、横向及 iPad split view。
- 使用 VoiceOver 回归名称、状态、操作顺序；确认不存在嵌套交互控件或重复朗读。
- 回归 Conversation、Agents、Friends、Members、Mention、Forward、Task Claim、Settings、ViewBoards、Workbench。
- 运行 iOS Simulator Debug build；新增组件测试或 snapshot 后再删除旧 Row。
- 完成标准：台账内所有 iOS 已支持 item 均为 `shared` 或有理由的 `specialized`，无长期兼容 wrapper。

## 本次验证

- iOS Simulator Debug build：通过，`CODE_SIGNING_ALLOWED=NO`。
- Web / iOS 跨端设计系统检查：通过；46 个 item kind、3 个 presentation level。
- iOS 原生 `Button(` 基线保持 186，没有因 wrapper 迁移增加。
- `CheersItemRow` Preview 覆盖 max / medium / minimal 和复合审批动作。
- 尚需在真机或已启动模拟器中人工检查最大辅助字号、VoiceOver 操作顺序和横屏；这些属于视觉/辅助功能验收，不阻塞本次代码编译。

## 2026-08-11 多语言字体迁移补充

- 已加入 Adobe 官方 Source Han Serif CN 2.003R 可变字体，并登记到 `UIAppFonts`；SIL OFL 1.1 允许免费商用和随 App 分发。
- `Theme.TypographyRole` 固定为 `display / reading / utility`，所有语义字体通过完整字符串选择字体族，避免 Source Serif 4 缺少中文字形时发生逐字 fallback。
- 中文 display 使用 Source Han Serif CN Semibold，中文 reading 使用 Regular/Semibold；日文和韩文使用系统本地化 serif；utility 使用系统多语言 sans。
- `MessageBubble` 正文和 `CheersItemRow` 标题已接入解析器；登录/注册标题也改用统一 display 接口。
- iOS Simulator Debug 构建通过，字体已包含在 `.app` 并重新安装、启动于 iPhone 17 Pro 模拟器。
