# Cheers「Editorial Correspondence」跨端设计语言

状态：`canonical`
最后更新：`2026-08-11`

本文是 Cheers Web、iOS、Android 与网站/政策页的设计唯一事实源。机器可读的 Item、状态与
三档展示契约以 [`item-contract.json`](item-contract.json) 为准；集合交互以
[`COLLECTION_MANAGER.zh-CN.md`](COLLECTION_MANAGER.zh-CN.md) 为准；平台迁移进度以
[`INVENTORY.md`](INVENTORY.md) 为准。其他旧设计稿或页面配方与本文冲突时，以本文为准。

## 1. 设计方向

Cheers 使用“编辑部、报纸、信件”的正式语义，强调清楚的版面层级、可信的操作反馈和长时间
阅读能力。它不是复古纸张拟物，也不是霓虹科技界面。

- 统一语义、信息层级、状态、Item anatomy、字体角色、尺寸等级和图标映射。
- React、SwiftUI、Compose 分别保留平台原生导航、动效、焦点、菜单、Sheet 与辅助功能。
- 三端追求相同的理解和操作结果，不追求逐像素相同。
- 网站介绍与政策页可以更接近正式出版物；产品工作区保持暗色、克制、紧凑和高可扫描性。

## 2. 不可破坏的视觉规则

1. **静止无框**：Button、Input、Item、Card、Dialog、Popover、Composer 等 resting surface
   不使用四周装饰性 border。先使用留白、背景层级、对齐与方向性 hairline。
2. **统一圆角**：普通矩形容器统一 `4px / 4pt / 4dp`。不使用 `rounded-xl/2xl` 形成卡片墙；
   圆形只用于 Avatar、Presence、Unread、进度或其他形状本身携带语义的对象。
3. **不使用霓虹**：禁止彩色外发光、装饰性渐变和高饱和彩色阴影。中性阴影只用于表达浮层
   空间关系；焦点、选中、主操作和状态通过 fill、ring、文字或标记表达。
4. **颜色只表达含义**：普通层级使用中性墨色；accent、online、unread、warning、error、
   approval 等语义才使用颜色，且不能只靠颜色传达状态。
5. **4/8 间距体系**：Item 内部和相邻控件以 4、8 及其倍数组织。列表结构依靠稳定的基线、
   行高和 section 节奏，不靠每项独立包框。
6. **方向性分隔**：hairline 只用于 section、长列表、表格或需要连续扫描的相邻行；它表达
   版面关系，不得退化成每个组件的四周边框。
7. **关键状态不可被密度隐藏**：error、approval、unread、mention、online、disabled 等在任意
   PresentationLevel 下都必须可感知。

## 3. 三级字体体系

字体角色只有三种，技术 monospace 是 `utility` 的子角色，不新增第四级。

| 角色 | 多语言字体 | 使用位置 | 禁止位置 |
|---|---|---|---|
| `display` | Source Serif 4 Display；中文 Source Han Serif CN Semibold；日/韩使用本地化系统衬线 | 网站介绍、Hero、masthead、页面大标题 | Button、状态、trace、列表名称 |
| `reading` | Source Serif 4 Text；中文 Source Han Serif CN Regular/Semibold；日/韩使用本地化系统衬线 | 消息正文、政策、帮助、长预览 | User/Bot/Channel/Workspace 名称、高频控件 |
| `utility` | Web Source Sans 3；iOS/Android 系统无衬线；完整多语言 sans fallback | 身份名称、导航、Button、Input、warning、trace、时间、状态 | 长篇消息正文 |

- 消息正文使用 reading，但字号与行高必须像正文而非标题：Web 基准 `14px / 1.55`，iOS
  `16pt`，Android `15sp`，再遵循平台动态字体。
- Bot name、Channel name、User name、Workspace name 等快速扫描文字必须使用 utility。
- 中文衬线使用随应用分发的 Source Han Serif CN，按完整文字 run 选择字体，避免逐字 fallback
  导致基线和字面大小不一致。
- 字体资产只使用 Adobe 官方开源发布并保留 SIL OFL 1.1 许可；缺少脚本字形时使用平台正确的
  本地化 fallback，不能显示 tofu、错误日文字形或混合基线。
- 代码、路径、命令、ID 和 tracing value 可使用 monospace；按钮、warning 标题仍使用 utility。
- 字号只有四档：`minimal 10px`、`compact 12px`、`regular 14px`、`comfortable 16px`。
  所有产品页面、网站介绍、密集面板、代码、Diff、图表和空状态一律从四档选择，不允许例外。
- 字体角色与字号档位正交；标题可使用 display、字重、字距和留白建立层级，但不能创建第五种字号。
- 禁止局部 `text-[Npx]`、Tailwind 默认 `text-xs/sm/base/lg/xl/...` 和裸 `fontSize` 数值。

## 4. 两个正交的三级体系

### 4.1 信息展示：PresentationLevel

`PresentationLevel = max | medium | minimal`，默认 `medium`。

| 档位 | 可见信息 |
|---|---|
| `max` | 标题、身份、完整支持信息、预览、状态和常用动作 |
| `medium` | 标题、一行关键支持信息、关键状态和主要/overflow 动作 |
| `minimal` | 最小身份和名称，仍保留全部关键状态 |

### 4.2 物理尺寸：ControlSize

`ControlSize = comfortable | regular | compact`，默认 `regular`。

| 档位 | Web | 用途 |
|---|---:|---|
| `comfortable` | 44px | Workspace Rail、触屏主目标、需要更强触控性的组件 |
| `regular` | 36px | 默认 Item、Button、Input、Composer、Collection toolbar |
| `compact` | 28px | 桌面密集工具、次要 icon action、受控的 panel toolbar |

- PresentationLevel 控制“显示多少”，ControlSize 控制“占多高”，两者不得混为一档。
- 页面或容器设置继承默认值；单个组件仅在确有语义差异时显式覆盖。
- 同级文字控件禁止按内容长度决定宽度：默认使用共享标准槽位，需要占满容器时显式使用 fill；
  业务组件不能通过局部 `width` 制造新槽位。
- Button、Input、Select、Item 等共享 primitive 的水平 padding 由 primitive 固定，业务调用点禁止
  使用 `px/pl/pr` 覆盖。布局差异进入共享 variant 或父容器，不进入单个调用点。
- Button 内容类型固定为三种宽度：`icon` 使用随 ControlSize 变化的 28/36/44px 方形，`text`
  使用 96px 标准槽，`iconText` 使用 128px 宽槽；表单主操作可显式 `fill`，但不形成第四个固定宽度。
  `iconText` 内部必须拆成独立 icon slot 与 label slot：icon slot 使用当前 ControlSize 的方形宽度，
  label slot 占据剩余空间并独立持有水平 padding；外层不使用共享 gap 混排两种内容。
  可见动作必须来自共享 `ActionKey`；对象名和上下文进入 `aria-label` 或邻近信息。英文标签除两词以内外，
  还必须满足 iconText 剩余文字槽的 8 字符预算，不能用减少字号或裁切规避。
  此规则 CI ceiling 为 0 且不允许业务例外；selector、tab、menu、disclosure 和 navigation 必须使用对应
  语义 primitive 或 ARIA role，禁止为了通过扫描伪造 ActionKey。
  三种 Button 均消费全局 `regular` 字号 token，业务层不得覆盖字号、宽度或水平 padding。
- 业务调用点也禁止给共享控件添加任意 `p-*`。纯图标动作必须使用 `square + ControlSize`，文本动作
  使用 primitive 的固定 padding。参与控件节奏的 flex row/header 只能使用 28/36/44px，不得产生
  32/40/48/56px 等第四尺寸。语义图标只能是 14/16/20px，身份标识只能是 20/28/36px，并通过
  共享 size map 获取；这些规则在 Web CI 中 ceiling 均为 0。
- 编辑已有对象必须使用就地编辑模式：默认对象旁显示 Edit IconButton；编辑态在同一位置替换为
  Cancel 与 Save IconButton。保存动作不得漂到 section 底部或远离被编辑对象；整页首次创建/提交表单除外。
- 产品布局间距只能使用 4px 网格对应的整数 Tailwind 档位，禁止 `0.5/1.5/2.5/3.5` 等半档；
  Loading Spinner 使用 ContentSize，不接受任意数字尺寸。
- 响应式规则只能选择未显式设置时的环境默认值，不能覆盖业务显式设置。
- 触控命中区域 Web/iOS 至少 44px/pt，Android 至少 48dp；视觉 glyph 可以更小。
- 页面 header、画布、图片和纯图标 glyph 不机械套用 ControlSize，但其中的交互控件必须套用。

### 4.3 内容尺寸：ContentSize

`ContentSize = small | regular | large`，默认 `regular`，只控制非容器内容，不创建第四档。

| 档位 | Avatar | 语义图标 | Presence | Identity rail |
|---|---:|---:|---:|---:|
| `small` | 20px | 14px | 6px | 64px |
| `regular` | 28px | 16px | 8px | 96px |
| `large` | 36px | 20px | 10px | 128px |

- Checkbox glyph 固定 16px，整体 label/hit row 仍继承 ControlSize。
- Unread、Progress 使用同一档 ContentSize 选择视觉直径，但不得削弱关键状态。
- Avatar、Presence、语义图标禁止在业务调用点用 `w/h` 覆盖；更换档位而不是制造新尺寸。
- Avatar 纵向身份列的宽度必须随 ContentSize 使用 64/96/128px，不允许业务页面写局部宽度。
- FileTree、Diff 行使用 ControlSize；缩进、gutter、Canvas 节点和 Workbench 面板几何使用专用布局 token。
- 拖拽柄使用共享视觉 token；其可交互命中区域由所属面板保证。
- Editor/Composer textarea、隐藏 file input 与响应式浮层宽度不是内容尺寸，不强套 ContentSize。

## 5. Item 与 ItemList

所有 User、Bot、Member、Workspace、Channel、DM、Message、Context、Approval、File、Session
等语义 Item 使用相同 anatomy：

`leading → title → critical status / status → actions`

- Browse/静止列表 Item **最多单行**。名称和关键状态同一行，使用 `min-width: 0`、truncate
  或平台等价能力处理溢出。
- subtitle、metadata、preview 和复杂说明进入 Edit、Detail、Popover/Sheet，或仅在明确需要的
  `max` 内容场景显示；不能让普通管理列表重新变成多行卡片。
- 单一整行交互可以使用 row action，但不得包含内部按钮；复合操作行禁止整行 action，所有操作
  进入 actions slot，避免嵌套按钮。
- `trailing` 只承载非交互时间、计数等信息；交互必须进入 actions。
- User/Bot/Member/Friend 使用 EntityItem；Workspace/Channel/DM/Destination 使用
  NavigationItem；Approval/Claim/Notification/Invite/Grant/Session 使用 OperationsItem；
  Plugin/Activity/Audit/Plan 使用 WorkbenchItem。

`ItemList` / `ItemSection` 是两套三级体系的继承边界。每个业务列表必须在容器声明
`presentationLevel` 与 `controlSize`，内部 Item 默认继承。不得在业务 `.map()` 中直接拼装
Row 型 `button/div/li` anatomy。

File tree、Diff、table、canvas、code editor 保留其键盘、层级和原生语义，使用专用 Item 或共享
token，不强塞进普通 ItemRow。合法例外必须登记原因，不能成为普通页面的逃生口。

## 6. Collection：Search / Add / Edit / Delete

成员、Claims、Invite Links、Permission Grants、Passkeys、Device Sessions 等可管理集合统一使用
`CollectionManager` 模式：

```text
Section header: title + count
Toolbar: Search (flex) + exactly one Add (regular)
ItemList: browse item | inline editor | inline delete confirmation | empty item
```

- `browse`：单行 regular Item 列表。
- `add`：列表首位插入 editor；不能在页面其他位置保留另一套大表单。
- `edit(id)`：原行被 editor 替换，保持空间位置。
- `delete(id)`：原行被明确的危险确认替换；Delete/Revoke 第一次点击绝不能直接调用 API。
- Add 入口只出现一次。空集合显示 “No items yet”，不能再放第二个 Add。
- Search 无结果显示 “No matching items” 与 Clear search；结果复用同一 Item，不另造 result row。
- Add-by-search 使用 `CollectionPickerItem`；summary + expandable detail 使用单一 listitem 的
  `ItemGroup`；服务端不支持的 Edit/Delete 能力必须省略，不能伪造。
- Members、Claims、Links 以及其他同类集合必须共享同一 section、toolbar、empty、editor、
  confirmation 和间距结构，不因业务名称不同而各自设计。

完整状态机与 Claims/Links 映射见 [`COLLECTION_MANAGER.zh-CN.md`](COLLECTION_MANAGER.zh-CN.md)。

## 7. 图标语言

- 产品语义图标使用 24 单位网格、约 1.75 线宽、简洁且彼此易区分的轮廓。
- 每个语义只有一个正式映射；禁止同一 Channel、Workspace、Context 在不同页面使用不同图标。
- 图标不能都由“纸张 + 小符号”派生，否则缩小后相似且难以识别。
- close、more、back、delete 等纯工具动作优先使用 SF Symbols、Material Symbols 或项目图标库的
  平台惯用图标；品牌化只用于 Cheers 特有语义。
- Personal workspace 使用 Cheers 系统的 correspondence/personal mark，不使用临时 emoji、通用
  envelope 或与系统映射不一致的图标。
- icon button 必须有 accessible name；选中状态不能只靠图标颜色。

## 8. 消息、Discussion 与 Details

- 消息正文使用 reading 正文字号，作者、trace、状态和操作使用 utility。
- Chat、Discussion 与 Reply 使用同一套 regular 身份区：28px Avatar、96px identity rail，
  只显示头像和名称，不显示时间或 BOT 标识。
- Message、Discussion、Reply 的悬浮动作必须使用 ControlSize；桌面可 compact，触屏命中区域仍
  不小于 44px，不能出现难以点击的任意小按钮。
- 消息下方 details/tracing 默认降噪：优先摘要、折叠或按需展开，使用 utility/monospace，视觉
  层级低于正文。错误、审批和失败原因仍必须直接可见。
- details 不能使用霓虹 glow，也不能靠高饱和边框抢占消息正文注意力。
- Composer 的输入面、toolbar、附件、发送与上下文控件共享 regular 高度和统一 4px shape；多行
  textarea 行为可以 specialized，但不能自创另一套控件高度。Session 与 model 这类带文字的
  toolbar 控件必须使用相同宽度槽位，长标签在槽位内截断，不能随内容长度改变按钮尺寸。
- Composer 的已添加 Context item 与 Add context 入口必须共享 regular 外框高度；Context item
  内的 remove/jump 使用 compact 图标动作，禁止在 regular item 外再叠加 padding 形成第四种高度。

## 9. 页面与平台边界

- 网站/政策/帮助页：display 大标题、窄 reading 正文栏、清晰章节节奏；不用带框营销卡片墙。
- 产品工作区：导航和列表依靠选中 fill、左侧标记、留白或方向性 hairline，不靠每项四周边框。
- Channel、DM 与其他 NavigationItem 的选中状态统一使用清晰的中性填充高亮和高对比文字；
  无边框场景不能移除唯一可见的选中提示，Web 同时暴露 `aria-current="page"`。
- Sidebar 中 Channels、Voice Channels、Private、Direct Messages 等分组名称是静态文字分隔符，
  不作为展开按钮，也不显示 disclosure 箭头；创建动作保持为标题右侧独立的可访问按钮。
- 弹层/表单：保留平台原生行为；resting 无框，focus、error、disabled、loading 必须明确可见。
- 移动端：使用系统 Navigation、Sheet、Menu、Dynamic Type 和返回手势，不把 Web 侧栏压缩成小网页。
- Android 未支持的产品能力只在共享契约登记 `unavailable`，不创建假占位页面。
- 视觉改造不改变服务端 DTO、API、权限和业务状态。

## 10. 可访问性与响应式

- meaningful text 达到 WCAG AA；focus ring 清晰；颜色状态同时有文字、形状或位置备份。
- Web 键盘路径覆盖 Item、menu、tab、disclosure、dialog escape 和 tree navigation。
- VoiceOver/TalkBack 暴露名称、角色、selected/expanded/disabled/critical state。
- Web 在 390/768/1280px 下无裁切和横向溢出；iOS/Android 支持 Dynamic Type、系统字号和横竖屏。
- 200% zoom 或大字体下允许布局重排，不允许文字越过容器、遮挡操作或被固定高度裁切。
- `prefers-reduced-motion` 下移除非必要动效；loading、error、success 反馈作用于实际受影响区域。

## 11. Gallery、扫描与完成标准

- Component Gallery 覆盖每种 Item、三种 PresentationLevel、三种 ControlSize，以及 selected、
  disabled、loading、error、unread、approval、multi-action、empty、editor、delete confirmation。
- CI 扫描业务原生 button/input/select/textarea、非三档高度、共享高度覆盖、非标准普通圆角、
  未登记圆形、resting 四周 border、ItemList 直接非 listitem 子项和无理由 exception。
- 每次迁移一个语义 Item 后删除局部 Row/Card 配方并下调 audit ceiling；不保留长期兼容 wrapper。
- 回归 Sidebar、Chat、Composer、Claims、Links、Members、Settings、Bots、Fleet、Notifications、
  Workbench，以及三端核心导航和辅助功能路径。

## 12. 今日固定决策摘要

- 设计方向固定为正式、克制的 Editorial Correspondence；撤销全部霓虹风格。
- 普通全局圆角从过硬的 2px 提高到统一 4px，仍保持无框和非卡片墙。
- 字体固定为 display / reading / utility 三角色，并补齐免费开源的中文衬线支持。
- 正文 reading 字号降低为正文尺度；所有实体名称回到 utility sans。
- 信息档位固定 max / medium / minimal；物理尺寸固定 comfortable / regular / compact。
- 默认控件和集合 Item 使用 regular 36px；Browse Item 最多单行。
- Members、Claims、Links 等完整迁移到同一 CollectionManager 的 Search/Add/Edit/Delete 结构。
- Personal workspace、Channel 等换用统一 Cheers 系统图标；图标保持简单且语义可区分。
- 消息 details/tracing 默认降噪，悬浮操作遵循三档尺寸与触控下限。
- 本轮设计变更不修改 MIT 开源许可。
