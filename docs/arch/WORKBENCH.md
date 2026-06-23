# Workbench 架构

> 日期：2026-06-23 ｜ 状态：设计 + 部分落地（M2）
> 关联：[[context-and-environment]]（奠基 Lens/Environment 概念）· [ROADMAP](./ROADMAP.md)

Workbench 是频道右侧的工作台:一个频道一个,浏览/编辑 bot 工作区文件,并承载「场景」(看板、提示词等)。

## 三层模型

```
文件（唯一基质）   memory_files：频道工作区。一切都是文件，agent 经 fs.* 按需 pull。
   ▲
渲染器（Lens/Plugin）  把「文件 → 可操作 UI」。内置 lens（table/kanban/markdown）或插件自带。
   ▲
场景（Scenario）   一组「视图 = {文件, 渲染器, 配置}」+ 初始化文件，把频道变成某个工作场景。
```

- **底座**:`memory_files`(per-channel 文件树),读写经 resource `fs.*`(channel-role 鉴权)。**没有独立 memory 概念**,见 [[context-and-environment]] 顶部「CURRENT MODEL」。
- **pin(semantic 层)**:把某文件 pin 进 `.workbench.json` → 派发时其内容前置进每次 prompt(受控 push,人写的约定,非自动记忆)。

---

## ⭐ 决策:插件分两类(2026-06-23)

工作台的可扩展性**正交地分成两件事**,机制轻重不同,别混为一谈:

| | **场景模板 (Scenario Template)** | **插件 (Plugin)** |
|---|---|---|
| 本质 | **一组频道文件**(数据) | **渲染器**(代码),可选自带一个默认场景 |
| 是什么 | 临时的「文件集合 + 视图声明」,seed 进某频道 | 自带 UI 渲染逻辑的代码单元 |
| 需要插件机制吗 | **不需要**——它只是文件 | **需要**——沙箱、服务端安装、代码加载 |
| 作用域 | per-channel(拖入 `.workbench/templates/`) | server-level(admin 装一次,全频道) |
| 渲染靠 | 内置 lens **或** 插件提供的渲染器 | 自身(iframe 里自带渲染器) |
| 格式 | 声明式 manifest JSON(纯数据) | `.html` bundle(代码)+ 内嵌 manifest |
| 安全 | 安全(数据不执行) | 沙箱隔离(见下) |

**一句话**:**渲染器是插件(代码,重机制);场景是数据(文件,轻机制)。** 场景引用渲染器(按 lens id);渲染器来自内置或插件。一个插件**可以**捎带一个默认场景,但场景本身不该背上插件机制的重量。

> **现状 vs 方向**:
> - 现已落地:内置 lens(编译进去的安全词汇表)· 场景模板(数据,per-channel,drop-to-install)· 沙箱插件(代码,server-level,iframe,自带渲染器+自带场景)。
> - **待做(本决策的方向)**:让**插件只提供渲染器(lens)**,场景模板(数据)去**引用**这些渲染器——把「渲染器=插件」和「场景=数据」彻底解耦,而不是现在沙箱插件把渲染器+场景捆在一起。

---

## 沙箱插件机制(server-level,代码)

```
服务端 workbench_plugins 表（admin 装一次 → 全频道可见）
   manifest（元数据：id/title/panels）+ bundle（插件自带 HTML/JS 渲染器）
   API: GET /workbench/plugins（列）· GET :id/bundle（取码，带鉴权）· PUT/DELETE :id（admin）
        ▼
前端 SandboxPanel：<iframe sandbox="allow-scripts" 无 same-origin>
   → 不透明(null)源：插件碰不到主站 token/cookie/localStorage
   → 插件只能 postMessage 请求 fs；host 代理时把路径锁进 plugins/<id>/ + 服务端 channel-role 鉴权
```

**postMessage 协议**:
- plugin → host:`{type:"cheers:ready"}` / `{type:"cheers:fs", reqId, op, args}`
- host → plugin:`{type:"cheers:init", channelId, panelId}` / `{type:"cheers:fs:result", reqId, ok, data|error}`

**安全三道**:① iframe 不透明源(偷不到密钥)· ② fs 只能经 host 代理(host 服务端鉴权)· ③ 路径命名空间 `plugins/<id>/`(插件只动自己目录)。

**插件格式**:一个 `.html`,内嵌 `<script type="application/json" id="cheers-plugin">{id,title,panels}</script>`(host 上传时 DOMParser 惰性解析,不执行)。多 panel 由 `cheers:init` 的 `panelId` 分发;切 panel 时 host 给 iframe 加 `key` 强制 remount(否则卡在第一个板)。

示例:`frontend/.../workbench/sandbox/examples/{notes,research}-plugin.html`。

---

## 待办

- [ ] **解耦**:插件只提供 lens(渲染器),场景模板引用之(见上「方向」)。
- [ ] 浏览器里给插件更丰富的 host API(读频道信息/消息,不止 fs)。
- [ ] 场景模板的 server-level 共享(现仅 per-channel)。
- [x] ~~多 panel 沙箱插件切 tab 卡在第一个板~~(已修:panel 加 key remount)。
