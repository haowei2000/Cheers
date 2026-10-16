# 模型生成的交互资源

> 已接入 React Web/Tauri Workbench。[English](INTERACTIVE_RESOURCES.md)

交互界面是一份普通频道文件，通过普通资源 URI 打开，由现有 Workbench 的
`builtin:a2ui` renderer 展示。复用文件存储、加载、Raw/Preview 与资源跳转。

## 模型怎么生成

1. 从注入的 Cheers MCP 调用 `read_ui_contract`，获得固定版本、目录、说明和示例，
   无需 Bot 本地有 Cheers 仓库。example 是草稿示例，request_example 是结构化请求示例，
   Bot 调用时会绑定到自己的认证 Bot id；人类读取时使用示例 UUID，需替换目标。
   也可通过 MCP resources/read 读取
   `cheers://help/interactive-ui`、`/catalog`、`/example`。
   本地规范源文件是 `design-system/a2ui-catalog.json`。
2. 用现有 `fs.write` 写入 `forms/report.a2ui.json`，结构化修改使用 `fs.patch`。
3. 回复 `cheers:desk/forms/report.a2ui.json`。在完成前调用 `set_resource_cards`，
   使用当前回复的 msg_id 和 v1 resource_ref。流式期间暂存 pending_cards，
   回复完成时原子发布为 cards，不需要另发一条重复消息。
   Desk 卡片在回复内显示 minimal 预览，小表单可直接填写和提交；Expand 在聊天里
   展开更多内容。点击标题仍可打开 Workbench 的完整视图。

文件结构是 `{ "a2ui": "v0.9.1", "messages": [...] }`。这是 Cheers 的持久化包装，
其中消息使用固定的 A2UI v0.9.1 envelope。`createSurface.catalogId` 必须为
`urn:cheers:a2ui:catalog:v1`；每个有效 surface 必须有 `root` 组件。

支持四种消息：createSurface、updateComponents、updateDataModel、deleteSurface。
按顺序重放，最多八个有效 surface。不支持任意 Basic Catalog，也不宣称全协议兼容。

## 组件与动作

目录包含 Column、Row、Text、TextField、CheckBox、Button。容器通过 children 引用
组件 id；字符串可直接填写或使用 `{ "path": "/report/topic" }` 绑定。
输入只改变本地表单草稿，不修改源文件。文本按纯文本安全展示，控件复用 Cheers 组件。

按钮的描述性 label 显示在旁边，实际按钮使用统一 Open/Request 标签。支持：

- `cheers.open`：context 中提供 uri 或其绑定，走宿主资源跳转。
- `cheers.compose`：context 中提供 actionId 与 payload。payload 值是 JSON 标量或
  数据绑定，提交后只准备聊天草稿，需用户检查并发送，不自动启动模型或执行桌面命令。

- `cheers.request`：context 提供 actionId、稳定 UUID botId、payload。宿主补齐
  源 URI、源版本、surface/component id 和 invocationId，然后走现有人类消息接口。
  网关核对权限、源版本、声明的动作/Bot、输入字段及固定值，通过现有 Bot task
  和 ACP session/prompt 回传。Bot 使用 if_version 更新同一资源，现有资源信号刷新视图。
- `cheers.openNative`：context 提供 uri 和 opener（finder、vscode、zed）。Mac 端复用
  已注册本地根目录和已安装应用检查。当前设备上的已授权 workspace 文件打开原件；
  Desk 或远端文件打开下载副本，并明确显示结果。副本的外部编辑不自动回写。
  Web 禁用本地动作并保留内容预览。

HTML/React artifact 和 extension 表单也归一化到同一个 Workbench 交互分发器，
文件面板与 Collection 不再各自维护表单转草稿逻辑。分发器再次校验输入。

不支持相对数据路径、集合模板、函数调用、脚本、任意样式、外部媒体 URL 或自定义
主题。未知字段、未知动作、循环引用、错误版本与超限内容明确拒绝。

草稿属于当前视图，源文件更新或视图重新挂载会重置，不隐式回写或跨端同步。
错误内容可以通过 Raw 修正；手动指定 renderer 时会展示具体错误。
宿主能力缺失时禁用动作，保留可读内容。

## 预览与当前边界

在 `frontend/` 运行 `pnpm dev`，按实际输出 URL 打开 `/dev/a2ui.html`。
预览支持修改源码、输入、勾选、生成草稿和展示目标 URI，不连接 gateway。

## 回复内的展示层级

Desk 文件卡片复用 Workbench 的 A2UI renderer 与交互分发器。普通文本/代码显示
转义的源码预览，HTML/React 脚本不在消息内执行。workspace、附件与频道投影 URI
保留已有打开入口，目前没有冒充 Desk 的 inline 适配器。

文件包装可声明 views.minimal / views.medium，每项为 `{surfaceId, root}`，指向同一
已验证组件树中的子树。这是 Cheers 展示元数据，不是新的 A2UI protocol 消息。
前后端都校验引用的 surface 和组件存在。minimal 上限为一个 surface、16 次组件
访问、三个输入和两个动作。未声明时小表单使用完整 root；复杂表单要求展开，
不会悄悄删掉部分字段后仍允许提交。展开内容在回复内滚动，完整源码编辑仍在
Workbench。同一个 surface 展开/收起保留草稿；新的源版本会重置表单草稿。

频道中的卡片和 Workbench 共用认证的 FsClient 与服务器资源快照，同时读取会
合并，资源信号会刷新可见预览，编辑器保存会发布同一快照。Raw 未保存内容和表单
草稿仍属于视图本地状态。离屏历史卡片延迟加载；加载、错误、重试、刷新和版本
均可感知，预览不绕过服务器权限检查。

## Bot 接入与请求契约

ACP connector 的输出契约和每轮提示引导 Bot 读取 read_ui_contract，附带当前回复
msg_id，并说明流式附卡。Agent 必须声明 HTTP MCP 支持，使用现有频道授权的 MCP
工具。没有新增 ACP RPC；结构化事件通过 context_bundle.interaction 进入现有任务，
由 connector 放进 XML 转义的非可信 interaction 区域，输入不授予额外权限。

网关在写入、patch、edit、append、rename 时校验 A2UI JSON/YAML，并在提交时重新
校验源文件。接受回执是持久化的普通用户消息。同一 invocationId 和相同请求重试时
在现有 24 小时幂等保留期内返回原回执，不重复消息或 Bot 派发；源文件后来更新
或 Bot 下线也可查询该回执，
但仍需当前调用者的频道写权限。同一 id 搭配不同输入会拒绝。

当前视图为相同表单输入/源版本保留重试 id，提交期间禁用控件并明确显示失败；
重新挂载或刷新后的新提交会生成新 id。不宣称持久离线队列或外部设备操作 exactly-once。
接受请求不等于 Bot 完成任务，完成结果通过回复及同一资源的版本更新呈现。

当前闭环：MCP 发现 → Desk 写入 → 当前回复附卡 → Workbench A2UI → 结构化用户
请求 → 现有 ACP prompt → 按版本更新 Desk。桌面打开也经过同一个 dispatcher。
全局 URI、远程桌面操作任务/回执、实时 A2UI wire transport、Canvas 嵌入、非 Desk inline 适配器和 SwiftUI/Compose
原生 renderer 尚未实现。cheers:desk 仍隐含当前频道；消息卡片显示有界 Desk 预览，
完整视图继续由 Workbench 承载。

协议参考：[A2UI v0.9.1](https://a2ui.org/specification/v0.9.1-a2ui/)。

## TSX 请求确认

沙箱 bridge 请求只提出动作，不直接发送消息。Cheers 在 iframe 外显示动作、目标
Bot 和输入；用户点击宿主 Request 控件后才发送。Cancel 丢弃提议，来源更新使确认
失效。失败在当前视图显示，重试沿用 invocationId；成功表示请求已接收，不代表任务
完成。普通表单与 compose 动作经统一 dispatcher 准备聊天草稿。

iframe 允许脚本和表单事件，不授予同源访问。CSP 继续禁止外部表单提交及网络访问。
运行时通过 pnpm 本地包依赖安装并解析 React peer dependencies，开发和 Docker
构建使用同一安装链路。

## 全局身份、跨设备草稿及远程执行

`desk_write`、`desk_read` 返回 `uri`：优先把原值用于回复和附卡。
格式为 `cheers:resource/<服务 UUID>/desk/<资源 UUID>`，不依赖当前频道或路径。
服务身份保存在数据库；恢复备份时保留，克隆为独立服务时应重新生成。
URI 不授予权限，解析仍检查来源频道。其他服务的 URI 需要切换服务打开，尚无联邦解析或自动服务发现。
附件、消息及 plan/sessions/cost/activity 支持同一全局描述符；后四者以频道 UUID 为资源 ID。
REST `/api/v1/resources/resolve` 和 MCP locator 共用解析器，受频道约束的 Agent 不可跨频道读取。

`?v=N` 打开保留版本，Workbench 只读。迁移只收录现有文件的当前版本及以后版本，
不会恢复迁移前的历史。删除文件后保留版本仍受原频道权限约束，频道删除则一并清除。
旧 `cheers:desk/...` 是来源频道的相对路径，不应复制到其他频道作为全局链接。

A2UI 只同步输入绑定，TSX 同步私有表单与自定义视图状态。隔离键是用户/资源/视图/schema，
不会改写资源文件。`if_revision` 乐观锁防止覆盖另一设备草稿；来源更新或并发编辑要求明确选择。
离线保留本地输入，恢复连接不会自动执行。TSX 字段需稳定 id/name/data-cheers-state-key，
password/file/hidden 默认不保存，`data-cheers-persist="false"` 可关闭。
自定义状态使用 CheersBridge.getState/setState/subscribeState，JSON 上限 60 KB，请勿保存秘密。
React Web 和 Tauri 共用实现，SwiftUI/Compose 原生页面尚未接入这些草稿及终端视图。

工作区浏览器增加终端入口：空命令打开真实交互 shell，填写命令则在指定设备执行。
需要 Bot 所有者或管理员身份，启动、输入、调整窗口及取消需要近期认证。
设备 connector 的 workspace 策略需启用 remote_terminal / remote_open，默认关闭；桌面设置可修改。
注册根路径限制起始目录，不是命令沙箱；shell 后续操作拥有设备账户的操作系统权限。

A2UI cheers.execute 和 TSX CheersBridge.execute 使用同一 dispatcher，源文件声明稳定 Bot ID、
actionId 和 payload，例如 `{action:"terminal.start",path:"",command:null}`；null 表示变量输入。
payload 仅接受 action/path/root/command/opener；file.open 仅支持 finder/vscode/zed。
宿主确认实际设备、目录及命令；TSX 初始化或 effect 只能提议，必须由宿主可信点击确认。
后端校验源版本、声明、组件身份、用户权限、活跃设备及 invocationId。

执行复用既有 workspace RPC 与 connector data bridge，不新增 ACP terminal 方法。
回执归当前用户持久保存，最近执行可重新打开；关闭视图不取消终端。
输入按序发送，不重放结果不确定的输入。后端持续跟踪完成，保留最多 256 KB 输出。
每设备最多八个运行中终端，15 分钟到期。连接器或网关丢失时可能显示 unknown，
不会自动重跑，也不保证外部副作用恰好执行一次。
