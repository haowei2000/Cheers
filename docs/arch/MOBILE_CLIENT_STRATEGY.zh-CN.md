# 移动端客户端策略

> **语言**：[English](MOBILE_CLIENT_STRATEGY.md) | 中文
>
> **状态**：已采纳 · **日期**：2026-07-06 · **负责人**：haowei

Cheers 如何交付到手机的决策记录：三个移动分支怎么落地，以及原生 vs 跨平台的走向。

## 背景

三个移动分支并行构建（见 2026-07-04 的构建笔记）并已推到 `origin`。它们都对接
同一个 Rust gateway（`server/`）—— REST + `/ws` 帧协议
（`auth → auth_ok → subscribe → subscribed`，之后是
`message`/`message_stream`/`message_done`/`presence`）。

| 分支 | 内容 | 落点 | 合并进 `develop` |
| --- | --- | --- | --- |
| `feat/android-app` | 原生 Android —— Kotlin + Jetpack Compose（Material 3），约 4130 行 | `apps/android/` | **干净**（加法式，无重叠） |
| `feat/ios-app` | 原生 iOS —— SwiftUI，零依赖，约 3373 行 | `apps/ios/` | **干净**（加法式，无重叠） |
| `feat/mobile-web-adapt` | React 网页端的响应式改造，+394/−91 | `frontend/` | **6 处冲突**（develop 已前进） |

用 `git merge-tree` 实测：两个原生分支纯加法（`develop` 尚无 `apps/`），彼此之间、
与前端之间都无重叠。`feat/mobile-web-adapt` 在 `package.json`、
`package-lock.json`、`ChannelView.tsx`、`ChatLayout.tsx`、`Sidebar.tsx`、
`SettingsPage.tsx` 上冲突 —— 因为 `develop` 往前走了（例如 #86 把 DM 并入 personal
workspace，动了 `Sidebar`/`ChatLayout`）。

## 决策

**一 —— 现在就把三个分支全部落地，按此顺序。**

1. `feat/android-app` → `develop`（干净、独立、加法式）
2. `feat/ios-app` → `develop`（干净、独立、加法式）
3. `feat/mobile-web-adapt` → `develop` —— 解 6 处冲突：
   - `package.json` / `package-lock.json`：保留 `develop` 一侧。分支只加了
     `@types/node ^22`，而 `develop` 已有 `^26`，丢弃这个降级即可。
   - 4 个 `.tsx`：人工处理 —— 把移动响应式改动重新叠加到 develop 更新后的逻辑上。
     之后跑 `typecheck` + `build` + 手机宽度冒烟。

原生分支先合，这样它们不受网页合并的任何改动影响，`develop` 也不再被三条长命分支拉着漂移。

**二 —— 战略方向：把移动端收敛到一套 Expo（React Native）代码；两个原生分支作为已验证的
API/协议参考保留。**

理由 —— 团队以 React/TypeScript 为主且规模小。为一个 chat 应用维护 Swift + Kotlin
两套独立原生代码是双倍维护面。Expo：

- 一套 TS/React 代码同时覆盖 iOS 和 Android；
- 复用团队的 React 心智，以及 `frontend/src/types` + API/WS 逻辑（共享的是**逻辑层**，
  **不是** UI —— RN 用 `View`/`Text` 而非 DOM；Tailwind → NativeWind）；
- 自定义 `/ws` 帧协议在 RN 标准 `WebSocket` 上原样跑通；
- EAS Build（云端出 `.ipa`/`.apk`）+ EAS Update（OTA 热更 JS）加速迭代。

原生分支**不作废**：它们的 DTO↔serde 映射、WS 重连逻辑（退避 + `?since_seq=` 补洞）、
设计 token，是 Expo 重写时可直接照抄的、已测过的参考实现。

## 后果

- 完成第一步后，Cheers 有**四个客户端**：桌面 Web、移动 Web、原生 iOS、原生 Android，
  全部对一套 gateway。这是过渡态，不是终态。
- 原生 app 立刻交付价值；Expo 逐步替代它们。Expo 达到功能对齐后，删除
  `apps/ios` + `apps/android`（可轻易回退 —— 它们自包含在 `apps/` 下）。
- **前端待优化项**（评审时发现，与本决策分开跟踪，但与移动 Web 线相关）：
  - React Query 已配置但**完全没用**（0 处 `useQuery`，19 个文件手写
    `useEffect` + `apiJson`）—— 收益最高的重构，零 bundle 成本。
  - 测试覆盖近乎为零（整个前端只有 1 个测试文件）。
  - `highlight.js` 全量打包（969 KB）—— 改用 `lib/core` + 按需注册语言。
  - 巨型组件（`RemoteWorkspaceDialog.tsx` 1309 行）。

## 考虑过的备选

- **保持双原生（把 Swift + Kotlin 作为产品）。** 平台体验最佳，但对 React 为主的小团队
  是双语言双倍持续维护。不作为默认；若出现原生独占特性再重新评估。
- **只做移动 Web（PWA），不做 app。** 最省；合 `feat/mobile-web-adapt` 就停。作为即时
  步骤保留，但既然想要真 app，这不是终态。
- **不合原生分支（反正 Expo 要替代，何必落地）。** 否决：它们已完成、干净、现在就能交付
  价值；Expo 是数周工程，而先落地它们日后回退的成本几乎为零。

## 路线图

1. ✅ 决策记录（本文）。
2. 三个分支合进 `develop`（按上面的顺序）。
3. 用 Expo 起 `apps/mobile/` 脚手架 —— 复用 REST + `/ws` 协议；移植原生的重连/DTO 逻辑。
4. 达到功能对齐后，下线 `apps/ios` + `apps/android`。
5. 并行把网页数据层迁到 React Query（移动 Web 同样受益）。

## 参考

- [架构总览](ARCHITECTURE_OVERVIEW.md)
- [线协议](WIRE_PROTOCOL.md) —— 两个原生 app 都实现的 `/ws` 帧协议
- `apps/ios/README.md` —— 原生 iOS 说明（DTO↔serde、重连、主题）
- 2026-07-04 构建笔记（Obsidian）—— 三个分支怎么造出来的
