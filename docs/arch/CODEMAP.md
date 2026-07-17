# Codemap 设计（Devin 式代码地图 @ Workbench）

> 日期：2026-07-16 ｜ 状态：设计稿（未实现）｜ 基线：develop @ 370f67ef
> （已吸收插件协议 1 / YAML 一等格式 / 官方插件集 / session 插件，PR #224–#232）
> 关联：[[WORKBENCH]] · [[RENDERER_PLUGIN]] · [[context-and-environment]]
> 交互设计稿：[codemap-mockup.html](./codemap-mockup.html)（自包含 HTML，可直接打开）

## 0. 一句话结论

**现有插件系统能直接承载 codemap 的 MVP，不需要新后端。** codemap 的本质是
「bot 维护的一份结构化 YAML + 一个把它画成交互式地图的渲染器」——这正好落在
workbench 的设计中心上：数据即文件（`context_files`）、渲染器认领文件（沙箱插件）、
场景模板 seed 初始文件并 pin 约定、bot 经 `desk_*` 写同一份文件。

「点节点跳代码」这一项需要给频道资源补一个**统一的文本定位符（Cheers Locator，
§4）**——不是新寻址体系，而是把平台既有的 `{verb, params}` 寻址序列化成 AI 能
直接书写的一行文本，并给两个查看器补上行号锚点。

## 1. Devin codemap 是什么（需求拆解）

Devin 的 codemap 是 **agent 边探索边维护的代码库认知地图**，不是静态分析产物：

| # | 需求 | 说明 |
|---|---|---|
| R1 | 层级结构 | 区域 → 模块 → 文件（热点路径可到符号级） |
| R2 | 节点标注 | 每节点一句 agent 摘要 + 置信状态（已探明 / 部分 / 可能过时） |
| R3 | 关系边 | 依赖 / 调用 / 数据流，跨模块 |
| R4 | 实时性 | agent 探索时地图跟着更新，当前焦点高亮 |
| R5 | 跳转 | 点节点 → 打开对应文件的对应**行** |
| R6 | 对话入口 | 从节点发起「给我讲讲这个模块」 |
| R7 | 人可修正 | 用户直接改摘要 / 打标签，bot 下次读到 |

关键定性：**这是 agent 写的知识，不是编译器算的事实。** 这个定性让 codemap 完全
落进「文件为唯一基质、pull 不 push、后端只有 `fs.*`」的既有边界——不需要任何
代码索引服务（那属于 workbench 明确拒绝的后端插件机制）。

## 2. 能力映射：平台现状 vs 需求

| 需求 | 平台现状 | 结论 |
|---|---|---|
| 数据存储（R1–R3） | `context_files`，bot 侧 `desk_read/write/edit`，乐观锁；**YAML 一等格式 + 保注释机器写回（`yamlDoc.applyEdits`，PR #232）** | ✅ 直接可用 |
| 渲染（R1–R3） | 沙箱渲染器插件，**协议 1**：版本化 manifest、`dataHas`/`dataKind`（JSON/YAML 通吃）、服务端校验、bundle ≤2MiB | ✅ 直接可用 |
| bot 维护习惯（R2、R4） | 环境模板 seed 骨架 + `pin` 约定文件（进每次 prompt） | ✅ 直接可用 |
| 人可修正（R7） | 插件有 `cheers:save`（单文件写回），冲突时 host 重发 render | ✅ 直接可用 |
| 开发/发布通道 | **session 插件**（拖进抽屉即生效、遮蔽同 id 已装版本，⏱ 会话级）→ admin 安装 → **官方插件集**（gateway 播种，`origin:system`） | ✅ 直接可用 |
| 实时刷新（R4） | `filesTick` 只热刷内置 lens 和 Raw 编辑器；**沙箱插件不会重收 `cheers:render`**（协议 1 合并后复核过 `SandboxRenderer`，仍未接） | ⚠️ 缺口 G1 |
| 点节点跳代码（R5） | 三个半成品：① context chip 的 `{verb,params}` → `jumpToContextSource` 跳 Workbench/工作区；② 消息里反引号路径 → `resolveAndOpenRef` + 服务端 `resolveRef` 按来源 bot 跨 inbox/desk/workspace **启发式**解析（带存在性探测与清晰报错）；③ `RemoteWorkspaceDialog` 的 `initialBotId/initialPath` 深链 | ⚠️ 缺口 G2：无**确定性文本定位符**、无**行号锚点**、未暴露给插件 |
| 大 repo（>256KB） | 单文件 ≤256KB；插件只能读被指派的那一个文件 | ⚠️ 缺口 G3（v2） |
| 节点发起提问（R6） | 插件无任何触达聊天输入的通道 | ⚠️ 缺口 G4（v2） |

> G1 的定性随协议 1 变了：英文规范（PLUGIN_DEVELOPMENT.md §5.2 与 SDK 注释）
> 现在**明文规定** render 只有两个触发点（回应 `cheers:ready`、冲突保存之后），
> 「外部改动**不**重发」。所以 G1 不再是实现欠账，而是一个**协议增补请求**：
> 给 protocol 1 加第三个触发点（`filesTick` bump 时重发）。对存量插件仍零破坏
> （插件本来就必须幂等处理重发），但要走规范修订而不是悄悄改实现。

## 3. 数据契约：`codemap/map.yaml`

一个频道一份地图，路径按模板 id 命名空间：`codemap/map.yaml`。
**选 YAML 而不是 JSON**（PR #232 后 YAML 是一等 board 格式）：

- **注释是 agent 的页边笔记通道**：不进 schema、不占结构字段的"为什么"可以就地
  写成 `#` 注释（`# TODO: 还没看鉴权分支`），人在 Raw 里直接读，bot 用 desk_read
  也读得到——结构化字段管渲染，注释管心迹，各走各的。
- **机器写回不吃注释**：内置 lens 保存结构化文件走 `yamlDoc.applyEdits`（CST 补丁，
  只动 diff 到的节点）；bot 的 `desk_edit` 是文本级替换，天然保注释；codemap
  渲染器写回时同样做**行级 patch**（见 §5.2）。三条写路径注释都活着。
- 已知损耗（照抄 yamlDoc 的文档化取舍）：**数组变长时整段重写、段内注释丢失**——
  所以 nodes 用**顶层 map（id 作键）**而不是数组，增删节点只动一个键，
  绕开这个损耗面。

```yaml
codemap: 1                # schema 版本；渲染器 dataHas 认领的锚点
repo: ElePerson/Cheers
updated: 2026-07-16T12:00:00Z   # bot 每次写入时更新
focus: [gateway.resource]       # agent 当前工作焦点（渲染器高亮）

nodes:
  # ── Gateway（server/ · Rust）─────────────────────────
  gateway.resource:             # 稳定 id：点号路径，父子由前缀推出
    kind: module                # area | module | file | symbol
    label: Resource verbs
    loc: cheers:ws/@backend/server/src/resource/fs.rs#L564-L600   # §4，R5 跳转用
    summary: fs.* 动词的鉴权与实现，乐观锁在这里    # ≤200 字符
    status: explored            # explored | partial | stale
    tags: [hot]
    # 乐观锁的 VERSION_CONFLICT 分支还没细看 —— 下次从这里继续

edges:
  - { from: gateway.resource, to: gateway.db, kind: calls, label: sqlx }
```

设计要点：

- **nodes 是 map 不是数组**（id 作键）：增删节点 = 动一个键，`yamlDoc` 的
  数组变长损耗面碰不到；`desk_edit` 的锚点就是唯一的 `  gateway.resource:` 行。
  层级仍用 id 前缀表达（`a.b.c` 的父是 `a.b`），不存 children。
- **id 段字符限 `[a-z0-9_-]`**：点号只作层级分隔符，文件名里的点要下划线化
  （`fs.rs` → 段 `fs_rs`），真名放 `label`——否则 `gateway.resource.fs.rs`
  会被误读成四层。
- **`nodes:` 刻意排在文件最后**：bot 加新节点可以直接 `desk_append` 到文件尾，
  连锚点都不用找；改已有节点才需要 `desk_edit`。
- **注释不进语义**：渲染器只解析结构化字段，注释一律不解析（否则注释会变成
  隐性 schema）；它们是给人和 bot 的自由文本，仅此而已。
- **尺寸预算**：YAML 比紧凑 JSON 略胖，单节点 ~200B，256KB ≈ 1200+ 节点——
  对本仓库到「模块 + 热点文件」粒度仍绰绰有余。约定写进 conventions：
  符号级节点只给热点路径开。
- **`status: stale`** 是诚实性开关：agent 改了某模块的代码却没核对地图时，先把
  相关节点标 stale，比留着过时摘要好。

## 4. 资源定位符：Cheers Locator（R5 跳转的地基）

### 4.1 为什么需要、以及为什么不是新体系

平台今天有三种「指到一个资源」的方式，各有短板：

- context chip / prompt bundle 里的 `{verb, params}` JSON——**确定**但不是文本，
  AI 没法把它写进一句话或一个 JSON 字符串字段里；
- 消息里的反引号裸路径——是文本，但要靠 `resolveRef` **按来源 bot 猜**它在
  inbox/desk/workspace 哪一层；codemap 节点没有「来源消息」可依，猜不了；
- `RemoteWorkspaceDialog` 深链——只是组件 props，没有可传播的外在形式。

**Locator = 把第一种（既有 `{verb,params}` 寻址）序列化成一行文本。** 不新增第二
套寻址体系、不新增后端概念：解析后仍落回 `fs.read` / `workspace.read` / 消息锚点
这些既有 verb 与既有鉴权。

### 4.2 语法

```
cheers:desk/<path>[#L<start>[-L<end>]]        本频道 Desk（context_files）文件
cheers:ws/<bot>/<path>[#L<start>[-L<end>]]    某 bot 真实工作区的源码文件
cheers:msg/<message_id>                        本频道某条消息（滚动定位）
cheers:inbox/<file_id>                         聊天附件（channel files 视图聚焦）
```

- `<bot>`：`@handle`（成员名，AI 友好、bot 自己就知道）或 `bot_id`（uuid，机器
  友好）；前端经成员索引解析 handle，歧义/不存在 → 沿用现有的清晰报错弹窗。
  消息文本里额外允许 `~` = 本条消息的发送 bot（codemap 文件里禁用——无来源可依）。
- 行号锚 `#L12-L34` 刻意照抄 GitHub 约定。
- 频道作用域**隐式**（永远是当前频道），与「host 强制 channel_id」的既有安全姿势
  一致；跨频道引用不在范围内。

### 4.3 「AI 更易操作」的具体含义（设计原则）

1. **单 token 纯文本**：无空格、无需转义，能同时活在 markdown、JSON 字符串、
   desk 笔记和 grep 输出里。
2. **借用模型已有强先验**：`#L12-L34`、`@handle`、`path/to/file.rs` 都是模型
   天生会写的形态；不发明新语法 = 最低的幻觉率。
3. **用 bot 已知的标识构造**：路径 + 自己的 handle，bot 无需任何额外查询就能拼出
   合法 locator（对照：uuid 类 id 必须先查询、且极易被编造）。
4. **宽容解析，严格生成**：约定要求 bot 写完整 locator；但消息里的裸路径继续走
   既有 provenance 启发式，两条路并存、互不破坏。
5. **优雅降级**：行号会随代码漂移——查看器对越界行钳到文件末尾并提示；
   （可选 v2）`#L12-L34,q=<pct-encoded 片段>` 允许按内容搜索兜底。

### 4.4 解析与落点（全部复用既有面）

前端一个 `resolveLocator(uri)`，输出直接接现有跳转面：

| locator | 落点（全部已存在） | 需补的部分 |
|---|---|---|
| `cheers:desk/…` | Workbench 深链（`openTarget`/`wbTarget`） | CodeEditor 接受 `initialLine`，滚动+高亮 |
| `cheers:ws/…` | `getWorkspaceFile` 存在性探测 → `RemoteWorkspaceDialog(initialBotId, initialPath)` | 对话框接受 `initialLine`，滚动+高亮 |
| `cheers:msg/…` | 消息列表滚动定位 | 无 |
| `cheers:inbox/…` | `filesFocus` + channel files 视图 | 无 |

出现面（谁来渲染成可点击链接）：

1. **聊天消息**：MarkdownRenderer 把 `cheers:` token 链接化——比 `looksLikePath`
   启发式更强的确定信号，bot 任何回答里的「定义在 cheers:ws/@backend/…#L826」
   都变成一次点击；
2. **codemap 渲染器**：节点侧栏「跳转」按钮 → `cheers:open { uri }`（§6 G2）；
3. **desk 笔记 / 任何文本文件**：内置 markdown lens 同样链接化。

教 AI 使用：语法写进 codemap 的 `conventions.md`（pin 进每条 prompt），并在
cheers-mcp-server 的工具描述里加一句「引用代码位置请用 `cheers:ws/@你的名字/路径#L行`」
——工具描述是 bot 必读的地方，比任何文档都可靠。

### 4.5 安全

Locator 只是 **UI 路由**，不是数据通道：解析后的每一步读取都过既有鉴权
（desk = `fs.read` channel-role；workspace = `workspace.read` owner 授权 + 探测，
未授权/离线 → 既有报错文案）。插件经 `cheers:open` 递来的 uri 由 host 校验
scheme、锁定当前频道后才路由——不增加任何新的数据访问面。

## 5. 交付物三件套（全部走既有安装通道）

### 5.1 环境模板 `codemap.template.json`（数据，admin 全局装或抽屉临时装）——**已实现**

**成品在 [docs/arch/examples/codemap.template.json](./examples/codemap.template.json)**
（骨架字符串由脚本从插件的 `INIT_SKELETON` 提取生成，两份逐字节一致）。

```jsonc
{
  "id": "codemap",
  "title": "Codemap",
  "views": [],                         // ⚠️ 必须为空：激活会把 views[].lens 写成
                                       // bindings（用户绑定=终裁）。声明任何内置 lens
                                       // 都会把 map.yaml 锁死在那个 lens 上，反而压过
                                       // codemap 插件的候选排序。留空 = 只 seed + pin。
  "pin": ["codemap/conventions.md"],   // 只 pin 一行指路牌，绝不 pin 地图本身
  "seed": {
    // seed 规则：object → 按目标路径格式序列化、string → 原样文本。YAML 骨架必须以
    // 【字符串】seed 才能带出注释表头。内容 = §5.3 的英文文件头指南 + 空骨架
    //（与插件 INIT_SKELETON 同一份；插件的「初始化 map.yaml」按钮是没模板时的等价物）。
    "codemap/map.yaml": "<§5.3 的 INIT_SKELETON 字符串>",
    "codemap/conventions.md": "Maintain codemap/map.yaml — read that file first; its header comments are the full instructions.\n"
  }
}
```

模板与渲染插件的分工（对应 WORKBENCH.md 的两分法）：**插件管看和改（代码、重机制），
模板管三件插件做不到的事（数据、轻机制）**——① seed 两个文件（create-only 幂等）；
② **pin 指路牌**：这是唯一能到达 bot 每条 prompt 的通道，渲染插件是单文件能力，
写不了 conventions.md 也碰不了 `.workbench.json`，没有模板 bot 就不知道地图的存在；
③ 一键激活的分发形态（admin 全局 / 抽屉临时）。首次 Preview 时 codemap 插件靠
特异性排序自动排第一（`dataHas` 两键 + glob + 插件 0.5 加成），用户选择一次即持久绑定。

### 5.2 渲染器插件 `codemap.plugin.html`（代码，协议 1）——**已实现**

**成品在 [docs/arch/examples/codemap.plugin.html](./examples/codemap.plugin.html)**，
可直接拖进工作台抽屉（session 通道）试用。要点：内联 SDK + 受限 YAML 子集解析器
（超出子集 → `cheers:unsupported`）；空文件给「初始化」按钮（写入 §5.3 骨架）；
直接双击打开 = standalone 演示模式（喂样例数据，便于不连 host 预览）；节点点击
会前瞻性地向 host 发 `cheers:open {uri}`（G2 落地即自动生效），当前以「复制
locator」兜底。会话内可拖动整理版面（坐标暂不持久化，等 host 的 configs 通道）。

```json
{
  "id": "codemap",
  "title": "Codemap",
  "protocol": 1,
  "renderers": [
    { "id": "map", "title": "代码地图",
      "match": { "format": "yaml", "glob": "codemap/*.yaml", "dataHas": ["codemap", "nodes"] } }
  ]
}
```

发布路径按平台现有三级走：**开发期**拖进抽屉 session 加载（⏱ 会话级、遮蔽同 id
已装版本，改完刷新即弃）→ **团队用** admin 装进 `workbench_plugins` → **成熟后**
进官方插件集（gateway 播种，`origin: system`）。bundle ≤ 2 MiB，手写 SVG 远用不满。

**写回策略（保注释）**：渲染器持有整份 YAML 文本；侧栏改摘要/状态时做**行级
patch**（定位该节点块内的 `summary:` / `status:` 行，只替换那一行，其余字节原样
保留）再 `cheers:save`——和 bot 的 `desk_edit` 是同一哲学，注释永不受伤。
不 bundle YAML 库（解析用手写的受限子集：本 schema 只需要两层 map + 行内数组）。

- **单个自包含 .html**，手写 SVG（无外部依赖，不引 CDN）。
- **形态：节点 + 地图**（node-link 画布，见 `codemap-mockup.html` 设计稿）：
  可拖拽平移、滚轮缩放的无限画布；区域（area）画成半透明 hull 底图；模块是
  画布上的节点，双击展开**卫星文件节点**；右下角 minimap 定位，左下角缩放控件；
  「模拟 bot 更新」时镜头自动跟随 `focus`。
- **布局仍是确定性的，不用力导向**——地图会随 bot 写入反复重渲，节点必须待在
  原地，抖动的地图不可用。初始坐标由固定算法生成；**人可拖动节点微调版面**，
  坐标持久化到 `.workbench.json` 的 `configs`（版面归人，结构归 bot——bot 只写
  map.yaml，从不碰坐标）。
- **交互模型：概览 → hover → 一击到源码**。节点只承担结构概览（名称 + 状态点）；
  **hover 弹出摘要卡**（摘要 / locator / 状态，IDE hover 式）；**单击节点 = 直接
  `cheers:open` 跳转到对应文件**（卫星文件节点同理，带行号）；展开文件用节点上的
  `▸N` 角标（单击已被跳转占用）。辅助：搜索过滤（无关节点变暗）、`focus` 呼吸环、
  `status` 着色（explored 绿 / partial 灰 / stale 黄）、边悬停高亮出标签；侧栏
  仍承载编辑（摘要/状态/标签行级 patch 写回 map.yaml，注释保留）。
- **R7 写回**：侧栏里摘要/标签可编辑 → `cheers:save` 整文件写回；收到
  `cheers:saved.ok=false`（版本冲突）后 host 会重发 render，渲染器把用户未提交
  的那条标注在新内容上重放再存一次。
- 所有 `summary`/`label` 一律 `textContent` 渲染（不可信内容，来自 bot）。
- 解析失败（不是 `codemap:1` 结构）→ `cheers:unsupported`，把最终裁决留在渲染器侧。

### 5.3 给 AI 的提示词：写进 map.yaml 文件头（英文注释），pin 只指路

**决策：完整的维护指南以英文注释形式内嵌在 `map.yaml` 文件头部**，
`conventions.md` 退化成一行指路牌。理由：

- **零 prompt 税**：pin 的文件体进**每条** prompt（持续付费）；文件头注释只在
  bot 真正 `desk_read` 这个文件时被读到——指令和数据同一时刻到场，不早不晚。
- **自描述数据**：指南跟文件走。换 bot、换频道、隔了三个月再打开，读文件即读懂
  契约——不依赖某个 pin 还在不在。
- **写不坏**：三条写路径（`desk_edit` 文本替换、内置 lens 的 `applyEdits`、
  codemap 渲染器的行级 patch）都保注释，指南天然免疫机器写回。
- **用英文**：模型的指令遵循先验最强、token 最省；schema 词汇
  （explored/stale/focus）本身就是英文。

pin 的 `codemap/conventions.md` 只剩发现层（一行）：

> `Maintain codemap/map.yaml — read that file first; its header comments are the full instructions.`

文件头指南全文（与插件 `INIT_SKELETON` / 模板 seed 保持同一份）：

```yaml
# =================================================================
# CODEMAP - an agent-maintained map of this repository.
# Humans see this file rendered as an interactive graph in the
# Workbench; you (the agent) are its maintainer. Keep it truthful.
#
# WHEN TO UPDATE (in the same turn as the work, not batched):
#   - explored new code       -> add or refine the nodes you touched
#   - changed code            -> update those summaries, or set
#                                status: stale if you didn't re-verify
#   - starting work somewhere -> put those node ids in `focus:`,
#                                and clear them when you move on
#
# SCHEMA (structure is the contract; comments are yours to use):
#   nodes:               # a MAP keyed by node id - never a list
#     <id>:              # dotted path: a.b.c is a child of a.b;
#                        # segment chars [a-z0-9_-] only, so file
#                        # names need '_' (fs.rs -> fs_rs), and the
#                        # real name goes in `label`
#       kind: area | module | file | symbol
#       label: short human-readable name
#       loc: cheers:ws/@<your-handle>/<repo-relative-path>#L<n>[-L<n>]
#            <your-handle> = the EXACT name this channel @-mentions
#            you by (you see it in messages addressed to you, e.g.
#            '@deng please ...'). NEVER guess it and never copy a
#            handle from an example - a wrong handle breaks every
#            jump. Unsure? Omit loc rather than invent one.
#       summary: what it does / what matters; <=200 chars; facts only
#       status: explored | partial | stale
#       tags: [optional, short]
#   edges:
#     - { from: <id>, to: <id>, kind: calls|data, label: short }
#
# HOW TO EDIT:
#   - append NEW nodes at the end of the file (desk_append) -
#     `nodes:` is intentionally the last top-level key
#   - change EXISTING nodes with desk_edit, replacing single lines;
#     each node's unique '  <id>:' line is your anchor - never
#     rewrite the whole file
#   - comments survive every write path; leave margin notes freely
#     (e.g. '# TODO: auth branch unverified')
#   - granularity: areas + modules always; files only when they
#     matter; symbols only for hot paths. Keep the file under 256 KB
#   - unsure? prefer `status: partial` over invented detail
# =================================================================
```

提示词的设计取舍（为什么长这样）：

- **触发条件放最前**（WHEN 先于 SCHEMA）：bot 最常见的失败不是写错格式，
  是**忘了更新**——把"什么时候动手"放在第一屏。
- **"same turn, not batched"**：明确反对攒批——攒批 = 地图长期滞后 = 失去实时性。
- **"facts only" / "prefer partial over invented detail"**：直接对冲幻觉，
  和 `status` 三态一起构成诚实性协议。
- **负面指令给了替代动作**：不是光说 "never rewrite the whole file"，而是紧跟
  "append at end / desk_edit single lines" ——告诉它**改用什么**，比禁止更有效。
- **handle 的来源写死、宁缺毋滥**（实战教训：bot 猜了个 `@backend`）：派发
  prompt 并不告诉 bot 自己的 mention 名，它唯一可靠的来源是**触发消息里别人
  @ 它的那个名字**——提示词明说这一点，并禁止猜测/照抄示例，不确定就不写 `loc`。
  解析侧配套兜底：频道只有一个 bot 时，错误 handle 直接落到它（存在性探测照旧）。
- 全文 ~2.4KB，不到 256KB 预算的 1%，一次性成本。

## 6. 缺口与补丁（分阶段）

### Phase 0 —— 今天就能跑，零平台改动

模板 + 插件 + 约定三件套即可交付，**连 admin 都不用**：插件拖进抽屉 session
加载（协议 1 的临时插件通道），模板走抽屉「临时模板」——一个人五分钟就能在任意
频道搭出全套试验场。局限：bot 更新后用户要重新点一下文件才能看到新地图
（G1 未修）；节点侧栏只能**展示** `loc` 文本，用户手动去工作区浏览器找
（G2 未修）。作为验证「agent 会不会好好维护地图」的 MVP 足够。

### Phase 1 —— 小补丁两件 + Locator MVP（全部向后兼容）

1. **G1（对齐文档）**：`SandboxRenderer` 接收 `filesTick`，bump 时重发
   `cheers:render`（带最新 content/version）。插件按协议本来就要能处理重发
   （VERSION_CONFLICT 路径已经在重发），所以对存量插件零破坏。
   （改动点：`RendererHost.tsx` 把 `ctx.filesTick` 传进 `SandboxRenderer.tsx`，
   后者加一个 effect。）
2. **G2（新 host verb + Locator）——已实现**：
   - `parseLocator`（`features/chat/locator.ts`，带单测）：desk/ws/msg/inbox 四个
     子 scheme + `#L<n>[-L<n>]` 行锚；严格解析（空白/控制符/路径穿越/坏片段全拒，
     倒序行区间宽容交换）；
   - 插件协议新增 `plugin → host: cheers:open { uri }`（英文规范 §5.1 表 +
     中文表 + SDK `host.open(uri)` 已同步）：`SandboxRenderer` 形状把关 →
     `ChannelView.openLocator` 路由——desk→工作台深链、ws→`@handle` 经频道 bot
     成员解析 + `getWorkspaceFile` 存在性探测→远程工作区、inbox→频道文件；
     解析失败 / bot 找不到或重名 / 连接器离线，都有清晰的用户可读报错；
   - `CodeEditor` 新增 `scrollToLine`（选中整行 + 居中，selection-only 不弄脏
     缓冲），远程工作区对深链文件生效——**ws 行锚已通**。
   - 留到后续：聊天消息里 `cheers:` token 链接化（MarkdownRenderer）、desk 深链的
     行锚（要打通 FilePanel 选中态）、`cheers:msg` 滚动定位、cheers-mcp-server
     工具描述里的 locator 语法提示。

### Phase 2 —— 协议 v2（按需，另立提案）

3. **G3（分片读）**：manifest 增加 `reads: ["codemap/**"]`（RENDERER_PLUGIN.md
   早已把「声明额外只读路径」列为 v2 方向）。地图分片成
   `codemap/map.yaml`（索引）+ `codemap/modules/<id>.yaml`，突破 256KB。
   协议 1 明确「host 忽略未知 manifest 键」，`reads` 可以在协议 1 内增补而不 bump 版本。
   host 在代理层按 glob 白名单放行 `fs.read`，仍然只读、仍然本频道。
4. **G4（对话入口）**：`cheers:compose { text }` —— 只**预填**聊天输入框，
   绝不代发。点节点 →「问 bot：解释 gateway.resource」→ 用户自己按发送。
   发消息的主体始终是人，避开沙箱插件代用户说话的信任问题。
5. （可选）**行号漂移兜底**：locator 增加 `q=<pct-encoded 片段>`，查看器行号
   未命中时按内容搜索定位。

## 7. 安全盘点（沿用三道防线，无新增信任面）

- 插件仍是不透明源 iframe + 单文件写能力；G2/G4 只新增「切视图」「预填输入」两个
  纯 UI 动作，不经它们读写任何新数据。
- Locator 是 UI 路由不是数据通道（§4.5）：每次实际读取仍过 `fs.read` /
  `workspace.read` 既有鉴权与存在性探测。
- 地图内容对渲染器是不可信输入（bot 写的），`textContent` 渲染，既有规矩。
- G3 的 `reads` 是只读 + glob 白名单 + 服务端 channel-role 照常鉴权，与现有
  `channel.*` 白名单同一个信任论证（admin 装插件 = 为其背书）。
- 不新增表、不新增后端 verb（G3 复用 `fs.read`）——「后端只有 `fs.*`」的边界不动。

## 8. 尚未决定 / 留给实现时拍板

- 渲染器要不要在 MVP 就支持编辑边（edges）？倾向不支持——人改摘要，bot 管结构。
- `focus` 高亮的过期策略（bot 忘了清 focus 时前端要不要按 `updated` 时间衰减）。
- 模板激活时 `views[].lens` 只能引用内置 lens——绑定到插件渲染器目前靠用户手选或
  特异性排序；WORKBENCH.md 的「模板引用插件 lens」待做项落地后可在模板里直绑。
- `cheers:ws` 的 `<bot>` 用 handle 时的改名漂移：locator 里存 handle 对 AI 最友好
  但非永久稳定；是否约定 bot 在 conventions 里定期用 `desk_edit` 修正，或前端
  解析失败时提示「成员名可能已变更」。
- 多工作区/多会话 bot：MVP 定位到 bot 的当前浏览根；session 级定位
  （`cheers:ws/<bot>/<session>/…`？）留给真实需求出现后再定。
