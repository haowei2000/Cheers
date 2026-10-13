# Intelligent UI / 智能卡片

> 状态：部分实现，2026-10-12。已接入有界 A2UI renderer、网关校验、流式附卡、
> ACP 结构化请求、回复内 Desk minimal 预览与 Mac 打开适配；全局 URI 和远端 operation 任务仍是提案。
> [使用说明](../help/INTERACTIVE_RESOURCES.zh-CN.md)。
> [English](INTELLIGENT_CARDS.md)

## 本次已实现的接入闭环

详情见[交互资源使用说明](../help/INTERACTIVE_RESOURCES.zh-CN.md)。MCP 提供远程目录
发现，网关验证 A2UI 文件/动作，流式回复附卡在完成时发布，Workbench 发出结构化
用户请求并复用现有 ACP prompt，Bot 按版本更新原资源。Mac 本地打开复用现有原件/
下载副本适配器。下文的全局 ResourceRuntime、v2 描述符和远程操作记录仍为设计方案。

## 定义

**智能卡片是模型描述、宿主渲染的资源或操作交互界面。** 模型提出内容和动作，
Cheers 负责解析目标、检查权限、提供控件、执行动作与展示真实回执。

`Card = 目标 + 展示方式 + 动作绑定 + 权威状态`

例如文件卡片显示预览、打开、下载；桌面操作卡片显示目标设备、将发生的变化、
执行入口和结果；表单卡片收集有明确 schema 的输入。卡片可出现在聊天、Workbench
或 Canvas 中，容器不改变它的权限。

## 后端与前端职责

**后端负责资源语义，前端负责呈现以及与用户环境的交互。** 中间通过有版本的
Resource Descriptor（资源描述）连接。

后端负责：

- URI 身份、来源作用域、别名、全局解析与资源定位。
- 资源鉴权、版本，以及共享内容的读取和修改。
- 内容语义解析与校验：文件元数据、文档节点、Canvas 图结构、表单 schema 和资源关系。
- 模型卡片定义校验，返回允许的资源操作及输入契约。
- 远端设备操作的授权协调、任务状态与执行回执。

前端负责：

- 根据资源类型与描述选择 renderer，渲染卡片、Canvas、预览和源码视图。
- 内部跳转：聊天、Workbench、Canvas 节点或源码锚点。
- 外部交互：浏览器打开、下载、剪贴板、本机文件打开或定位、外部应用唤起。
- 表单输入、选择、展开、键盘焦点、即时反馈，以及本地状态。
- 平台能力适配与 sandbox 事件接入，再把需要共享修改或远端执行的请求发给后端。

建议资源描述包含 `schema_version`、`canonical_uri`、`resource_type`、`mime_type`、
`revision`、`metadata`、解析后的 `content` 或授权的 `content_ref`，以及
`allowed_operations`。大文件或不透明格式可返回内容引用，不要求后端解码所有格式。
前端的视频/图片解码、编辑器高亮 AST 等属于展示解析；身份、语义契约和鉴权仍以后端为准。

`模型引用 → 后端 URI 解析与内容解析 → 资源描述 → 前端渲染与交互适配`

前端结合后端允许的资源操作和当前平台能力决定实际控件。后端可给声明式展示提示，
布局、文案和具体控件由前端选择。本机权限由本地执行边界验证，不能仅由后端推断。

交互分三条路径：

1. **客户端交互**：打开、跳转、复制、下载、本机 reveal，由前端及浏览器/原生适配器
   完成；资源读取仍走鉴权，本机副作用仍走本地策略。普通跳转不创建后端 operation。
2. **共享资源修改**：前端提交请求，后端检查权限与版本、修改内容并返回结果。
3. **远端设备操作**：前端发起，后端协调授权和持久化回执，connector 执行并报告。

本机 reveal 和远端 reveal 可以有相同外观，但必须绑定不同的明确执行路径。
前端不能把 bot 的远端路径直接当成本机文件，后端也不能直接唤起用户机器上的应用。

## 全系统一套链路

**Card 是资源的呈现方式，不是新的业务子系统。每个已登记、可解析的资源 URI 都要
有默认卡片展示，但不为每个 URI 写一个组件。** 同一资源类型的 URI 共用 renderer。
未知、无权限、已删除或不可用目标展示明确的引用/状态，不泄露受保护元数据，也不
伪造资源内容。当前 Cheers 尚未做到所有 URI 都有专门卡片，这里定义目标架构。

`URI → ResourceRuntime → 后端 resolver / source handler → ResourceDescriptor → Renderer Registry → Interaction Dispatcher → Executor → Result / 资源更新`

共享的 ResourceRuntime 提供 `resolve`、`subscribe`、`invoke` 三个边界，负责作用域、
读取/订阅去重、能力匹配、交互分发与结果归一化。renderer 只消费资源状态并发出
有类型的交互意图，不自己解析业务 URI、发资源请求、调用原生命令或发送临时聊天文字
来代替动作。普通跳转也经过 dispatcher，再由本地适配器完成，无需后端执行任务。

后端从 URI 解析身份与语义锚点，经过 source adapter 接现有鉴权 handler/producer。
内容 parser 按资源语义类型/格式登记，生成统一描述。不要创建 Card 专用文件存储和
读写接口。REST、WS、MCP 和原生桥可以保留不同传输，入口都归一化为同一资源/调用
契约。审批等原领域协议的特殊解决规则由绑定保留，走同一分发链路。

**统一 Renderer Registry 按 resource_type、格式和契约版本选择渲染器。** 不按 URI
字符串逐个登记，也不只看 MIME：Canvas YAML 与普通 YAML 的资源语义不同。
后端提供资源类型与可选声明式 view hint，前端选择当前支持的 renderer。
SwiftUI/Compose 实现相同的语义注册项，不另建聊天卡片、Canvas、移动端三套业务注册表。

renderer 接收容器位置（message、panel、canvas_node、详情页）、现有
`PresentationLevel = minimal / medium / max` 与焦点锚点。外层负责位置、导航历史
和 Canvas 几何，内层负责资源展示与交互。紧凑和详情视图可以有不同布局实现，但
必须使用同一资源状态与动作模型，不能各自读取或执行。

登记一个资源类型时必须提供默认摘要、可用详情视图、动作 schema/执行绑定及跨端
回退规则，例如：

- 文件：文件摘要、预览及打开/下载。
- 消息：消息摘要及线程定位。
- Canvas：文档摘要、图视图或节点列表。
- Operation：状态与执行回执。
- Approval：待处理/已解决状态与真实审批动作绑定。

缺少专门 renderer 时回退到通用资源信息与允许的交互。无权限时只展示安全状态。

资源 cache key 包含实例、来源作用域、规范对象身份和版本模式，权限相关数据按
当前认证主体隔离。不同锚点可共用对象数据，但保留各自焦点。卡片展开、Canvas
平移缩放和表单草稿属于个人状态，不写进资源业务记录。别名先归一化再订阅。

迁移从共享边界开始：扩展 gateway 的 `resolve_frame` 与现有 dispatch；统一前端
loader 为 ResourceRuntime；将 Lens 的 `{source, view, config}` 接入；现有 URI
打开、`onOps` 与表单提交改成注册交互绑定。旧格式只在入口转换一次，迁完删除旧
读取/分发路径，不长期套一个 Card 框架在旧子系统外面。

验收：同一 URI 放在聊天、面板和 Canvas 节点时，指向同一资源/版本、共享状态更新、
动作含义一致、执行回执相同；所有登记资源类型都具备默认卡片或明确通用回退。

## 已有基础与缺口

- `ResourceRefCards.tsx` 已支持消息 `content_data.cards` 中的 v1 `resource_ref`。
  服务端限制一到三张、只读引用，拒绝额外字段；MCP 桥接已经提供发卡入口。
- `locator.ts` 已有 `cheers:desk/…`、`cheers:ws/…`、附件、消息、投影和锚点。
  它们隐含当前频道，因此不是全局地址。Desk 的 `#^id` 解析已经存在。
- `deepLink.ts` 已有 `cheers://channel/<id>?msg=<id>` 桌面跳转，尚未统一跨实例资源。
- 结构化 Canvas 已有节点、连线、布局，以及 `fs.patch` 编辑路径。
- HTML/React Canvas 已有 sandbox 和 `form.submit` / `action.trigger`，但
  `FilePanel.tsx` 当前将输入交给 `composeMessage`，只是填写聊天草稿。
  这不是桌面操作执行回执；旧 Canvas 文档中的部分状态已经落后于代码。

核心缺口是共享的“目标—动作—结果”契约，而不只是卡片样式。

## 与你的 Canvas 的关系

**Card 负责一个局部交互；Canvas 负责持续组织内容。**

文件卡片可以引用一份 Canvas 文件，让用户打开编辑；Canvas 节点可以呈现文件或
操作卡片。节点记录引用，执行状态仍然属于原操作记录，不能复制一份独立状态。

结构化 Canvas 是多人和模型都能编辑的文档，保存节点与关系。HTML/React Canvas
是更自由的自定义视图，适合报告、可视化与复杂交互。它可以使用同一受控动作桥，
但脚本执行能力不等于桌面权限。现有“提交到聊天草稿”的行为必须保留明确模式，
不能升级后悄悄变成执行命令。

Workbench 面板位置则是个人视图偏好，应继续与共享 Canvas 内容分开。

## 建议的卡片协议

初期只有 resource、operation、form 三种语义类别；文件、Diff、图表等通过注册的
`view` 专门化。这些是展示模式，不是独立 loader、存储或执行框架。
复用 `{source, view, config}` 词汇，以目标解析适配现有面板。

v2 建议包含 `id`、`kind`、`target`、`view`、`title`、`description`、`actions`。
每个 action 有稳定 id、注册 binding 和经过 schema 校验的 input。完整 JSON 示例
见英文版。该结构尚不被现有 v1 接口接受，必须增加显式版本契约。

模型可以建议 `resource.open` 或 `desktop.reveal`；前端通过注册表决定实际按钮文案、
跳转和平台适配器，后端与本地执行器分别管理自己的权限策略。模型不能提供任意 Tauri 命令、shell 命令或本地绝对
路径作为执行绑定。文件存在性、运行成功和权限都不能由模型写的文本证明。

现有 Permission、Auth、Elicitation 和任务认领仍走原协议与解决端点，可以统一展示，
但普通模型卡片不能伪装成它们。符合 ACP elicitation 的表单应复用它。

## 交互执行

点击后，宿主以当前操作者身份校验卡片、动作、输入和目标版本，执行器再次检查权限。
服务端动作复用 gateway 资源接口；设备动作由授权的本地执行器或 connector 执行。
设备文件使用已登记的不透明 handle，并验证设备授权、目标文件和允许的应用。

接受的远端设备调用或异步服务端调用产生 operation 记录；普通跳转和本地 UI
交互不要求创建这类后端任务：

`queued → running → succeeded / failed / cancelled / unknown`

断连时若无法知道操作是否已发生，展示 unknown 并对账，不盲目重试副作用。
同一次调用用幂等键去重，新的一次操作使用新键；一次性审批和表单另需原子解决。
设备侧还需去重或对账，gateway 幂等键本身不能保证系统操作跨崩溃只执行一次。

权限策略根据确切目标、输入和版本决定是否需要确认，可撤销的低影响动作直接执行。
取消请求不等于已取消；只有执行器实际支持时才显示撤销。

聊天和 Canvas 展示同一操作回执，包括设备、执行者、结果和产物。旧调用保留历史，
不能用之后一次运行的状态覆盖。消息是当时的描述，资源可以是当前或固定版本，
操作记录才是执行事实；展开状态和表单草稿属于个人视图。

## 全局 URI

**已有局部 URI；建议增加完整限定的全局 URI。** 使用新的 `resource` host，
与现有 `channel`、`auth`、`extension` 路由分开：

```text
cheers://resource/<instance-id>/channels/<channel-id>/desk/reports/summary.pdf
cheers://resource/<instance-id>/channels/<channel-id>/desk/canvases/arch.canvas.yaml#^plan
cheers://resource/<instance-id>/channels/<channel-id>/messages/<message-id>/cards/<card-id>
cheers://resource/<instance-id>/channels/<channel-id>/operations/<operation-id>
cheers://resource/<instance-id>/devices/<device-id>/files/<file-handle>
```

这是拟议语法，需要同步更新 TS/Rust 解析器、gateway resolver 和桌面路由。
instance-id 是稳定 gateway 身份，通过已配置连接映射到端点，不能直接用任意远端
URL 触发请求。实例身份还需规定初始化、备份恢复的处理规则。

保留 `cheers:desk/…` 作为模型书写短形式，在消息写入时绑定来源实例和频道。
跨频道复制之后仍解析原目标，不能依赖阅读时正在选中的频道。

“全局”表示身份无歧义，不表示公开访问、设备永远在线或所有用户都有权限。
远程 workspace 应使用稳定 bot/workspace id，不能依赖可变 `@handle`；本地文件
必须带设备作用域和登记 handle。URI 不携带 token，handle 也不是访问凭证。

带完整作用域的 Desk 路径仍会在重命名后失效。如果需要跨重命名的稳定引用，需增加
file-id、路径别名和删除状态。`#^id` 用于支持稳定元素 id 的格式，行号则可能漂移，
严格引用需要固定版本。全局寻址不能自动解决资源版本与重命名。

打开 operation URI 只是查看记录，不能触发执行。Web 分享可增加配置 gateway 域名下
的 HTTPS 链接，指向同一对象并执行相同鉴权。

## 桌面端与移动端

共享 URI、资源语义与动作含义，React/Tauri、SwiftUI 和 Compose 各自实现渲染器与
平台适配器。可移植卡片协议不能要求所有客户端运行 React；原生适配需要实际实现。

动作明确声明执行作用域：`viewer`（当前设备）、`server` 或带稳定 device-id 的
`registered_device`。手机上的“在 Mac 定位”仍指向那台 Mac；“在本机打开”则是另一个
动作，可能先下载授权副本。远端设备不可用时不能自动改为本机执行。

实际可用性由允许的操作、协议/renderer 版本、本机权限、目标设备授权与在线状态共同
决定；区分不支持、需要授权、离线和已过期。执行时再次检查，客户端能力声明不是凭证。

- 桌面：详情面板、键盘/鼠标及各操作系统的文件和应用适配器。
- 手机：紧凑摘要，点击进入原生 sheet 或详情页；使用预览、分享、文件选择和原生表单。
- 平板/可变窗口：按可用空间与输入选择单栏或分栏。Canvas 可提供节点列表与节点详情，
  保留同一节点 id 和关系；列表排序不能改写空间坐标。

复杂自定义视图需有资源摘要、源码或原生预览回退。支持的编辑仍走后端版本校验和
结构化写入。内容按需加载，支持大字体、读屏和手势的可见替代入口，iOS 命中区域至少
44pt，Android 至少 48dp。

分享优先使用后端生成的 HTTPS 资源链接，可接 iOS Universal Links / Android App Links。
自托管域名需单独配置关联，不假定所有服务器都能直接唤起 App；保留浏览器与明确的
App 打开入口。登录或服务器选择之后恢复原目标，未知服务器不自动切换。
[Apple 文档](https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content)、
[Android 文档](https://developer.android.com/training/app-links)。

全局 Cheers URI 与本机临时文件地址/访问授权分开。iOS 复用原生预览、分享和导入；
Android 跨应用文件分享使用 `content://` 与临时授权。
[Android 文件分享](https://developer.android.com/training/secure-file-sharing)。
“分享资源链接”与“导出文件副本”是不同动作，副本不自动回写。唤起外部 App 成功
只证明交接被接受或打开，不能证明外部任务完成。

远端任务不依赖手机持续前台运行。发送前保存调用幂等键，回前台或重连后对账回执与
资源版本；离开页面不代表取消。离线缓存标注过期，不悄悄排队稍后执行副作用。
草稿和缓存按账户/资源隔离，退出时适当清理，临时下载凭证不能作为永久链接。

现有 iOS 的 `ChatView.swift` 已有导入/分享，`WorkbenchSheet.swift` 已有 Quick Look
临时文件预览，`CheersApp.swift` 已有前台恢复连接。这些可复用，但不等于已经支持
v2 卡片/全局 URI；Android 也需要明确实现卡片和交互适配。

## 可复用协议与收到卡片后的流程

**A2UI** 最接近跨端声明式卡片：描述组件、数据绑定与用户动作，由客户端按自己的
组件目录渲染。Cheers 可以定义 catalog 并实现原生 renderer。官方当前标记 0.9.1
为 current、1.0 为 candidate，落地时固定版本，不能混用动作 schema。
[A2UI](https://a2ui.org/)、[动作机制](https://a2ui.org/concepts/actions/)。

**MCP Apps** 适合外部 MCP 工具 UI：工具关联 `ui://` 界面资源，宿主 sandbox 渲染，
界面通过桥请求工具调用、打开链接或更新模型上下文。它不是原生 SwiftUI/Compose
卡片格式，`ui://` 也不等于 Cheers 全局资源 URI。
[MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html)、
[桥接方法](https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html)。

**AG-UI** 负责 agent 与前端的事件/状态交换，可作为兼容 agent runtime 的可选适配，
初期不必替换现有 Cheers realtime。
[AG-UI](https://docs.ag-ui.com/introduction)。

A2UI 与 MCP Apps 可以组合，官方有集成指南，但这些协议不替代 Cheers 的 URI、鉴权、
设备执行和回执存储。
[集成指南](https://a2ui.org/guides/a2ui-in-mcp-apps/)。

收到卡片之后：

1. 后端解析 target 并校验版本，返回资源描述；前端匹配 renderer 与能力后展示。
2. 用户点击产生有类型的 action，关联卡片/动作 id、目标、输入、执行设备、版本与调用 id。
   这是 Cheers 自己的执行绑定契约，不把它冒充成标准 A2UI JSON。
3. 前端 dispatcher 分流：本地交互走平台适配，共享修改走 gateway，远端操作走 connector。
4. 返回结构化结果或新数据，更新原卡片。只有声明需要 agent 继续处理的动作才续接模型；
   打开、刷新和翻页无需每次让模型重新理解一段文字。

推荐以 URI 资源解析和 Cheers ResourceDescriptor 作为核心契约，A2UI 作为可选生成式
展示格式，以 MCP Apps 接外部 UI，AG-UI 按需要适配。以上仍是设计提案，尚未安装依赖
或实现协议兼容。

## URI 优先的资源交互

**核心对象是可寻址的资源，卡片是它的一种呈现。** 模型只输出 URI 也应足够：后端
解析成当前操作者有权访问的资源描述，前端按类型生成默认卡片。标题、偏好的 view
和模型说明都是可选展示提示。聊天、Canvas、通知与复制链接使用同一资源身份，
不要求附带原始生成式 UI 组件树。

资源描述提供 affordances（可用交互）：动作 id、关系、执行作用域、输入 schema 与
明确的调用绑定。前端把这些描述映射为本机控件与适配器。

- URI 回答“是哪一个对象”。
- ResourceDescriptor 回答“是什么、当前允许做什么”。
- Invocation 契约回答“如何请求执行，以及如何获取结果”。

打开动作或 operation 引用只查看描述/记录，执行必须显式调用，不能因 URI 被解析、
预览或打开而自动修改资源。调用时再次鉴权。

A2UI 主要回答“展示哪些组件、绑定哪些数据、点击发出什么用户动作”。它的
surface/component id 不替代 Cheers 全局资源身份、别名、权限和版本规则。
一个 A2UI surface 可以引用 Cheers URI，动作也能映射到同一资源交互契约。
组件解析属于展示层，资源语义仍由 gateway 管理。

这是资源导向 / hypermedia 的设计方向，不表示已有一个万能标准涵盖所有桌面和移动
执行。URI 语法本身还不足以定义资源描述、动作、能力匹配、幂等与回执；Cheers 需要
明确这一小层契约。初期先做文件 URI → 默认原生卡片 → 授权的打开/下载与明确的
远端设备动作，再按需要增加生成式组件树。

## 实施顺序

1. 统一 scoped target 与全局 resolver，先解决跨频道复制、锚点和权限。
2. 增加 v2 resource 卡片及宿主动作注册表，保留 v1 与文本回退。
3. 增加 operation 回执，先落地一个登记文件的桌面动作，验证授权、幂等与断连。
4. 在 Canvas / Workbench 复用同一渲染器与目标适配，不建立新的 Canvas 存储。
5. 接入 form 和可选 sandbox 动作桥，明确区分草稿提交与真实执行。

界面沿用 Cheers Item anatomy、ActionKey 和 medium / regular；保留可访问的命中
区域、键盘操作、就地进度和错误。是否能执行取决于目标执行器及授权，而不是简单
区分 Web/桌面：Web 可以访问已授权的在线设备，桌面也可能没有该目标的权限。
缺失能力时继续提供预览、下载并解释原因。

验收重点：跨频道不改目标，聊天和 Canvas 回执一致，伪造动作被拒绝，同次重复点击
不重复执行，未知版本可读，设备不可用时仍有实际可用的资源展示。
