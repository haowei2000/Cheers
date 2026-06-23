# Workbench 架构

> 日期：2026-06-23 ｜ 状态：设计 + 部分落地（M2）
> 关联：[[context-and-environment]]（奠基 Lens/Environment 概念）· [ROADMAP](./ROADMAP.md)

Workbench 是频道右侧的工作台:一个频道一个,浏览/编辑 bot 工作区文件,并承载「场景」(看板、提示词等)。

## 三层模型

```
文件（唯一基质）   context_files：频道工作区。纯内容，主格式 Markdown，agent 经 fs.* 按需 pull。
   ▲ 被「认领 + 渲染」（判断在渲染器侧，文件不声明类型）
渲染器（Lens/Plugin）  内容 → 可交互 UI。CSS 式：自带匹配规则，可只吃特定格式/结构。内置或插件提供。
   ▲ 产出初始文件
场景（Scenario）   只 seed 一组初始文件（md 为主），把频道变成某个工作场景；不描述 lens/config。
                   来源:内置 / 全局(workbench_templates 表) / 临时(会话级)。详见下「关系与边界」。
```

- **底座**:`context_files`(per-channel 文件树),读写经 resource `fs.*`(channel-role 鉴权)。**没有独立 memory 概念**,见 [[context-and-environment]] 顶部「CURRENT MODEL」。激活任一场景都把 seed 文件落进**当前频道**的 `context_files`(create-only,不覆盖已有)——场景定义可以是全局/临时的,但数据始终是 per-channel 的。
- **pin(semantic 层)**:把某文件 pin 进 `.workbench.json` → 派发时其内容前置进每次 prompt(受控 push,人写的约定,非自动记忆)。
- **`.workbench.json`(per-channel 工作台配置)**:一个普通 `context_files` 文件,存:`views`(=顶部 **tab**,一组 `{path,title}`,用各文件绑定的渲染器渲染)· `bindings`(`path → 渲染器 id`)· `pinned` · `_doc`(每次回写**重新生成**的自文档字段,让人/AI 读得懂 schema)。**tab 来自这里的 `views`**,不再来自模板的 `views[{file,lens,config}]`。因 UI 会机器回写本文件,自由注释会丢——故用 `_doc` 字段(真字段,回写保留)而非注释;详见下「配置格式」。后端只读 `pinned`,对未知字段宽容。

---

## ⭐ 决策:插件分两类(2026-06-23)

工作台的可扩展性**正交地分成两件事**,机制轻重不同,别混为一谈:

| | **场景模板 (Scenario Template)** | **插件 (Plugin)** |
|---|---|---|
| 本质 | **声明式场景清单**(数据) | **渲染器**(代码),可选自带一个默认场景 |
| 是什么 | 「视图声明 + seed 文件」,激活时 seed 进当前频道 | 自带 UI 渲染逻辑的代码单元 |
| 需要插件机制吗 | **不需要**——它只是数据 | **需要**——沙箱、服务端安装、代码加载 |
| 作用域 | **全局**(admin 装,全频道可见)**或临时**(浏览器会话内上传,仅本会话) | server-level(admin 装一次,全频道) |
| 装在哪 | 全局:设置 → Workbench extensions(admin);临时:工作台抽屉「临时模板」(人人) | 设置 → Workbench extensions(admin) |
| 渲染靠 | 内置 lens **或** 插件提供的渲染器 | 自身(iframe 里自带渲染器) |
| 格式 | 声明式 manifest JSON(纯数据) | `.html` bundle(代码)+ 内嵌 manifest |
| 后端存储 | `workbench_templates` 表(全局,仅 manifest);临时模板**不入库** | `workbench_plugins` 表(manifest + bundle) |
| 安全 | 安全(数据不执行,只能引用内置 lens) | 沙箱隔离(见下) |

**一句话**:**渲染器是插件(代码,重机制);场景是数据(轻机制)。** 两者后端各一张表、前端各一条上传通道:插件走专门的 admin 插件接口(`/workbench/plugins`,带 bundle、需沙箱);模板走 `/workbench/templates`(纯 manifest、无 bundle、无沙箱),且额外提供**人人可用的临时上传**(只活在浏览器会话里,激活仍 seed 频道数据,但模板定义不持久、不共享)。

> **现状 vs 方向**:
> - 现已落地:内置 lens(编译进去的安全词汇表)· **全局模板**(数据,server-level,admin 装,`workbench_templates` 表)· **临时模板**(数据,会话级,人人可上传,不入库)· 沙箱插件(代码,server-level,iframe,自带渲染器+自带场景)。代码插件与文件模板已在**存储和上传通道两层彻底分开**(各自的表、各自的 API、各自的 UI:插件在设置页 admin 上传,模板全局在设置页 admin / 临时在抽屉人人可上传)。
> - **待做(本决策的剩余方向)**:让**插件只提供渲染器(lens)**,场景模板(数据)去**引用**这些插件提供的 lens——目前沙箱插件仍把渲染器+场景捆在一个 iframe bundle 里;下一步是把「插件导出的 lens」暴露给声明式模板复用,而不必各自带一份渲染逻辑。

---

## 关系与边界:渲染器插件 ↔ 环境模板(目标模型)

> **三句话**:**① 文件只管内容(主格式 Markdown),不声明类型、不绑渲染器。② 渲染器自带"我认领什么 + 怎么画"的全部判断(可只支持一种格式/结构),把内容渲染成可交互 UI。③ 环境模板只 seed 初始文件。**

### CSS 类比(北极星)

渲染器之于文件,**就像 CSS 之于 HTML**:HTML 是纯内容,样式表用 selector 去命中并渲染;HTML 从不声明自己该用哪条规则。

| CSS | 工作台 |
|---|---|
| HTML(纯内容,不写样式) | **文件**:纯 Markdown 内容,不声明渲染器 |
| CSS 规则 = selector + 声明 | **渲染器** = 匹配规则(认领什么)+ 渲染逻辑 |
| 选择器可窄可宽、多份共存 | 渲染器**可专可全**:一个只管「看板 md」,一个只管「论文表」——小而专、可共存 |
| 特异性/层叠定胜负 | 多个渲染器都命中时:**具体者胜 / 用户指定** |
| 行内 style 覆盖样式表 | 用户在 `.workbench.json` 按文件覆盖绑定 |

### 三层与依赖方向(单向)

```
文件 context_files   纯内容,主格式 Markdown(agent 按需 pull,人/bot 读写)
   ▲ 被「认领 + 渲染」(判断在渲染器侧)
渲染器 (插件 / 内置)  内容 → 可交互 UI。自带匹配规则,可只吃特定格式/结构。
   ▲ 产出这些文件
环境模板             只 seed 初始文件(Markdown 为主)。不描述 lens/config。
```

**依赖单向**:模板产出文件;渲染器认领并渲染文件;文件谁也不依赖。**绑定不在文件里**——"这个文件用哪个渲染器"是 UI 偏好,存 `.workbench.json`(`path → renderer`,缺省由渲染器的匹配规则自动定),可被用户覆盖。

### 边界 5 条

| # | 维度 | 环境模板(数据) | 渲染器插件(代码) |
|---|---|---|---|
| 1 | 本质 | 惰性数据(一组初始文件) | 代码(执行;第三方必须沙箱) |
| 2 | 职责 | 提供**哪些初始文件** | 把**一个文件的内容** → 可交互 UI |
| 3 | 格式 | 主 Markdown(纯内容) | 默认吃 Markdown;**可自愿**支持 json/xml/toml… |
| 4 | 复杂度 | 零判断(只是文件) | **全部判断在此**:认领什么、怎么解析、怎么画 |
| 5 | 安全 | 跟数据走:人人可传、可临时 | 跟代码走:admin 装 + iframe 沙箱 |

> **Markdown 为主的取舍**:内容优先、bot(LLM)母语、人手改友好;代价是极富交互的结构态(带类型的列、拖拽元数据)纯 md 有损 → 由渲染器自行约定(`## = 列`、`- [ ] = 卡片`)或在 md 里用 ` ```json ` 围栏块兜底,**复杂度上移到渲染器**——这正是本模型要的。

### 现状 → 目标(待迁移)

- **现状(legacy)**:模板是 `views:[{file, lens, config}]`,**手工绑定** file↔lens↔config;内置 lens 吃 JSON;沙箱插件是单体 iframe(渲染器+场景焊死、自己 seed)。
- **目标**:模板坍缩成**纯 seed(md 为主)**;`view.lens/config` 取消,改由**渲染器按内容认领**(CSS 式),用户绑定存 `.workbench.json`;渲染器(内置或插件)只做 `内容 → UI`,可只支持一种格式/结构。

---

## 沙箱插件机制(server-level,代码)

> **开发渲染器插件?** 完整契约 + 可抄的最小示例见 **[RENDERER_PLUGIN.md](./RENDERER_PLUGIN.md)**。下方是现版(legacy `panels` 协议)的机制说明;目标 `render/save` 协议见那篇。

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

示例:`frontend/.../workbench/sandbox/examples/{notes,research}-plugin.html`。**可上传试用的参考样例**(一个渲染器插件 + 一个环境模板)见 [`examples/`](./examples/README.md)。

---

## 待办

- [ ] **彻底解耦渲染器**:插件只导出 lens,声明式场景模板按 lens id 引用之(现沙箱插件仍把渲染器+场景捆在一个 bundle 里;见上「方向」)。
- [ ] 浏览器里给插件更丰富的 host API(读频道信息/消息,不止 fs)。
- [x] ~~场景模板的 server-level 共享(原仅 per-channel)~~(已做:`workbench_templates` 全局表 + 临时会话上传,代码插件与文件模板各走独立表/API/UI)。
- [x] ~~多 panel 沙箱插件切 tab 卡在第一个板~~(已修:panel 加 key remount)。
