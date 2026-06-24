# 前端代码导读（2026-06-24）

> 给在这套前端里干活的人：怎么读、各目录干什么、有哪些可复用积木。
> 关联：[FRONTEND.md](./FRONTEND.md) · [WORKBENCH.md](../arch/WORKBENCH.md)

## 1. 心智模型（顺这条链读任何功能）

```
api/ (薄 fetch 封装) → stores/ (zustand 全局状态) → features/ (组件)
                       ↑ realtime hook (WS) 也写 store
components/ + lib/  =  跨功能复用的积木 + 工具
```

**事件 → api → 写 store → store 驱动渲染**——所有功能都是这个形状。

## 2. 目录职责

| 目录 | 是什么 |
|---|---|
| `api/` | 后端 REST 的薄封装，全走 `client.ts` 的 `apiJson`（自动注入 Bearer） |
| `stores/` | 全局状态：`chatStore`（workspaces/channels/选中）、`authStore`（user/token + `useIsAdmin`） |
| `features/chat/` | 聊天主界面：`ChatLayout`(编排) · `WorkspaceRail`(左栏) · `Sidebar` · `ChannelView` · `MessageList/Item/Composer` |
| `features/chat/hooks/` | 实时：`useChatRealtime`（WS 订阅消息 + `sendResourceReq` 请求/响应） |
| `features/chat/workbench/` | 工作台（见 §3） |
| `features/{bots,settings,workbench,auth}/` | 各独立页/区 |
| `components/ui/` | 设计系统原子：`Button` `Input` `Avatar` `Dialog` |
| `components/` | 跨功能组件：`MarkdownRenderer` |
| `lib/` | 纯工具：`cn`(className) `format`(时间) |
| `types/` | 全局 TS 类型 |

## 3. 工作台的「插件缝」：注册 + 按 id 取用

看到 `registerX/getX` 就是一个**可扩展点**：

| registry | 注册什么 | 谁消费 |
|---|---|---|
| `panelRegistry` | 面板(tab) `PanelDef` + `PanelContext` | `WorkbenchDrawer` 渲成 tab |
| `lens/registry` | 内置渲染器 `table/kanban/markdown` | `LensPanel` |
| `renderers/registry` | 统一渲染器目录（内置+插件）+ `accepts/candidatesFor/specificity` | `FilePanel` 渲染器下拉、`RendererHost` |

## 4. 可复用积木

**已有、优先用：**
- `components/ui/`：`Button` `Input` `Avatar` `Dialog`
- `components/MarkdownRenderer`
- `lib/cn`（条件 className）、`lib/format`
- `useFile`（jsonFile.ts）：加载+编辑+乐观锁保存+冲突重载 — 任何读写 `context_file` 的面板都用它
- `useFileEditor`（jsonFile.ts）：上面的「纯文本」版（原文编辑器用）
- `fsClient` / `sendResourceReq`：统一 fs/资源访问
- 三个 registry：扩展点
- `PinToggle`、`errMsg`：pin 按钮 / 统一错误文案

**约定**：新 UI 先翻 `components/ui` 和上面这些；要加面板/渲染器，走 registry，别硬编码。
