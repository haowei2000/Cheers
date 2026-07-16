# Workbench 架构

> 日期：2026-06-23 ｜ 状态：设计 + 部分落地（M2）
> 关联：[[context-and-environment]]（奠基 Lens/Environment 概念）· [ROADMAP](./ROADMAP.md)
>
> ⚠️ **2026-07-07 更新：tab 层已退役，工作台改为「文件中心」。** 抽屉主体就是文件浏览器；
> 选中一个文件只有三个操作——**Pin**（注入每次 bot prompt）、**Preview**（用绑定的或按内容
> 匹配到的渲染器渲染，多个匹配时可切换，"Auto" 选项可解绑回内容匹配）、**Raw**（纯
> textarea，兜底）。`.workbench.json` 的 `views` 字段（顶部 tab 列表）废除，场景激活改为写
> `bindings`（file→渲染器）+ `configs`（file→lens 配置，如表格列）+ `pinned`；前端读到遗留
> `views` 时就地迁移成 bindings/configs（create-only，下次回写落盘）。下文提到 tab/views 处
> 均为历史记录。
>
> **有意接受的取舍**（对抗 review 盘点后确认）：① 一屏只看一个文件（无并排 tab；文件树可
> 折叠换取整幅预览画布）；② 场景 view 的 `title`（如 "Literature"）暂不在 UI 出现，仅作
> manifest 文档；③ 「一键在场景各视图间切换」由文件树点选替代。

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
- **`.workbench.json`(per-channel 工作台配置)**:一个普通 `context_files` 文件,存:`bindings`(`path → 渲染器 id`,Preview 用哪个渲染器打开该文件;未绑定则按内容取最优匹配,再不行 Raw)· `configs`(`path → lens 配置`,如表格列,场景激活时 create-only 写入)· `pinned` · `environment` · `_doc`(每次回写**重新生成**的自文档字段,让人/AI 读得懂 schema)。~~`views`(顶部 tab)~~ **已废除(2026-07-07)**——没有 tab 层,模板的 `views[{file,lens,config}]` 激活时坍缩成 `bindings`+`configs`。因 UI 会机器回写本文件,自由注释会丢——故用 `_doc` 字段(真字段,回写保留)而非注释。后端只读 `pinned`,对未知字段宽容;前端读时丢弃遗留字段。

---

## ⭐ 决策:插件分两类(2026-06-23)

工作台的可扩展性**正交地分成两件事**,机制轻重不同,别混为一谈:

| | **场景模板 (Scenario Template)** | **插件 (Plugin)** |
|---|---|---|
| 本质 | **声明式场景清单**(数据) | **渲染器**(代码),可选自带一个默认场景 |
| 是什么 | 「视图声明 + seed 文件」,激活时 seed 进当前频道 | 自带 UI 渲染逻辑的代码单元 |
| 需要插件机制吗 | **不需要**——它只是数据 | **需要**——沙箱、服务端安装、代码加载 |
| 作用域 | **全局**(admin 装,全频道可见)**或临时**(浏览器会话内上传,仅本会话) | server-level(admin 装一次,全频道)**或临时**(会话内,调试用) |
| 装在哪 | 全局:设置 → Workbench extensions(admin);临时:工作台抽屉「Load extension」(人人) | 全局:设置 → Workbench extensions(admin);临时:工作台抽屉拖入 `.html`(人人,仅本会话,同 id 遮蔽已装版) |
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

> **完整契约 + 可抄的最小示例见 [RENDERER_PLUGIN.md](./RENDERER_PLUGIN.md)。** 下面是要点概览。

```
服务端 workbench_plugins 表（admin 装一次 → 全频道可见）
   manifest（id/title/renderers[{id,title,match}]）+ bundle（插件自带 HTML/JS 渲染器）
   API: GET /workbench/plugins（列）· GET :id/bundle（取码，带鉴权）· PUT/DELETE :id（admin）
        ▼
前端 SandboxRenderer：<iframe sandbox="allow-scripts" 无 same-origin>
   → 不透明(null)源：插件碰不到主站 token/cookie/localStorage
   → host 指派一个文件渲染（render/save 协议），插件只能动那一个文件 + 读白名单 channel.* verb
```

**postMessage 协议(render/save)**:`cheers:ready` → host `cheers:render{path,content,version}` → 插件 `cheers:save{content}` → host `cheers:saved`。可拒绝:`cheers:unsupported`。host API:`cheers:resource{resource,params}`(白名单只读 channel.*)。细节见 RENDERER_PLUGIN.md §3。

**安全三道**:① iframe 不透明源(偷不到密钥)· ② **单文件能力**(只渲染/存回被指派的那一个文件,host 钉死 + 服务端 channel-role 鉴权)· ③ host API 只放行只读 channel.* 白名单、强制当前 `channel_id`。

**插件格式**:一个 `.html`,内嵌 `<script type="application/json" id="cheers-plugin">{id,title,renderers}</script>`(host 上传时 DOMParser 惰性解析,不执行)。

> **已退役**:旧的 `panels`/`init` 场景插件协议(`SandboxPanel`、`plugins/<id>/` 整目录代理)已删除;插件不再是「场景」,而是按文件绑定的「渲染器」。

可上传试用的参考样例(一个渲染器插件 + 一个环境模板)见 [`examples/`](./examples/README.md)。

---

## 待办

- [x] ~~**彻底解耦渲染器 / 退役 legacy tab 来源**~~(已做:tab 只来自 `.workbench.json` `views`;模板激活时把 `views[{file,lens,config}]` 迁移进 `.workbench.json`;旧的「模板 lens-views 直渲」与「沙箱 `panels` 场景插件」两条路退役,`SandboxPanel` 删除。渲染器插件只渲单文件,与场景彻底分离)。
- [x] ~~浏览器里给插件更丰富的 host API~~(已做:`cheers:resource` 代理一组**只读** `channel.*` verb(info/members/messages/activity),`channel_id` 强制当前频道;见 [RENDERER_PLUGIN.md](./RENDERER_PLUGIN.md) §3.1)。
- [x] ~~场景模板的 server-level 共享(原仅 per-channel)~~(已做:`workbench_templates` 全局表 + 临时会话上传)。
- [x] ~~多 panel 沙箱插件切 tab 卡在第一个板~~(已修:panel 加 key remount)。
- [x] ~~模板能 seed 一份带 `views` 的 `.workbench.json`(需 merge 语义,现 seed 是 create-only)~~(**以另一种方式解决,2026-07-07**:`views`/tab 整层废除;激活即对 `.workbench.json` 做 merge——`bindings`/`configs` create-only 并入、`pin` 去重并入,用户已有绑定不被覆盖)。
- [ ] 渲染器多文件读(`cheers:render` 现单文件,v2)。
