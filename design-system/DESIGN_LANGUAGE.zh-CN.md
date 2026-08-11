# Cheers「Editorial Correspondence」跨端设计语言

这份文件是 Cheers 新版设计的产品规范。机器可读的 item、状态与三档展示契约以
[`item-contract.json`](item-contract.json) 为准；三端迁移进度以
[`INVENTORY.md`](INVENTORY.md) 为准。

## 1. 设计目标

Cheers 是人与 Agent 协作的工作空间。新版界面使用“编辑部、报纸、信件”的正式语义，
但不复刻纸张材质或古董装饰。视觉重点是清楚的版面层级、可长时间阅读的正文，以及可信、
克制的操作反馈。

统一的是语义、信息层级和组件 anatomy；React、SwiftUI、Compose 继续使用各自平台的
导航、动效、焦点、辅助功能和系统控件。三端不追求逐像素相同。

## 2. 五条不可破坏的规则

1. **无框优先**：静止状态的按钮、输入框、卡片、弹层不使用装饰性描边。先用留白、背景层级和对齐分组。
2. **横线是版面，不是卡片**：hairline rule 只用于标题分区、长列表和表格式扫描；焦点和错误使用状态 ring。
3. **接近直角**：通用圆角固定为 2px/pt/dp。头像、在线点、未读点保留圆形，因为形状本身携带语义。
4. **紧凑不等于难点**：内部间距以 4/8 为主，但 Web 触屏至少 44px、iOS 至少 44pt、Android 至少 48dp。
5. **颜色只表达含义**：普通层级使用中性墨色；强调、在线、未读、warning、error、approval 才使用语义色。
6. **不使用霓虹效果**：禁止彩色发光、装饰性渐变和高饱和彩色阴影。黑色阴影只表达浮层空间关系；默认焦点、选中和主操作使用中性墨色。

## 3. 三类字体

| 角色 | 字体 | 使用位置 | 禁止位置 |
|---|---|---|---|
| `display` | 拉丁/希腊/西里尔使用 Source Serif 4 Display；中文使用 Source Han Serif CN Semibold | 网站介绍、Hero、大标题、版面 masthead | 按钮、状态、trace |
| `reading` | 拉丁/希腊/西里尔使用 Source Serif 4 Text；中文使用 Source Han Serif CN Regular/Semibold | 消息正文、预览、政策和帮助正文 | 身份名称、导航标签、高频控制标签 |
| `utility` | Web 使用 Source Sans 3；iOS/Android 使用平台系统无衬线，并保留多语言原生回退 | User/Bot/Channel/Workspace 名称、Button、输入、导航、warning、trace、状态、时间 | 长篇消息正文 |

代码、路径、命令和标识符可使用 monospace；它只是 `utility` 的技术子角色，不构成第四套品牌字体。
三级角色按文字脚本解析完整文本：中文衬线使用随应用分发的开源思源宋体 CN，避免同一行逐字回退造成基线和字面大小不一致；日文、韩文使用平台本地化衬线；utility 始终保留平台多语言无衬线回退。字体只取自 Adobe 官方发布并保留 SIL OFL 1.1 许可证。

## 4. Item 统一契约

所有 User、Bot、Workspace、Channel、DM、Message、Context、Approval、File 等语义 Item
都使用同一 anatomy：

`leading → title/supporting/preview → critical status → status → primary/overflow action`

- `max`：完整身份、副信息、预览、状态和常用动作。
- `medium`：标题、一行关键副信息、关键状态和主要/溢出动作；全局默认。
- `minimal`：最小身份与名称，但错误、审批、未读、mention、在线等关键状态不能消失。

容器通过 React Provider、SwiftUI Environment、Compose CompositionLocal 设置默认档位；
单个 Item 的显式设置优先，响应式只能决定未显式设置时的默认值。档位只改变信息密度，不改变业务状态或 API 数据。

控件高度使用独立三级体系，不与 PresentationLevel 混用：`comfortable = 44px`、
`regular = 36px`（默认）、`compact = 28px`。Workspace Rail 使用 comfortable，
普通 Item、Button、Input 与 Composer 控件使用 regular，密集 section 工具使用 compact。
触控视口无论视觉档位如何都保留至少 44px 命中区域；改变高度不能隐藏错误、审批、未读等状态。

## 5. 图标语言

产品语义图标使用 24 单位网格、1.75 线宽和清晰不同的轮廓。`correspondence`、`section`、
`edition`、`excerpt`、`approval seal`、`agent mark` 等概念在全局只能有一个正式映射。

图标不能都由“纸张 + 小符号”演变，否则缩小后会难以区分。纯工具动作（关闭、更多、返回、删除）
优先使用 SF Symbols、Material Symbols 或项目既有图标库，让平台习惯胜过品牌装饰。

## 6. 页面组合

- 网站和政策页：使用大幅 display 标题、窄正文栏、明确章节节奏；不用带边框的营销卡片墙。
- 产品工作区：保留深色、紧凑的信息密度；导航和列表通过选中底色、左侧标记或 hairline rule 表达结构。
- 消息：正文使用 reading；时间、BOT、trace、重试和审批使用 utility。正文可读性优先于“复古感”。
- 身份与导航：User、Bot、Channel、Workspace 等名称使用 utility；它们需要快速扫描，不能与正文共享衬线层级。
- 弹层和表单：保留平台原生行为，静止状态无描边；focus、error、disabled 必须可见。
- 移动端：不把 Web 侧栏压缩成小网页。使用系统导航、Sheet、Menu、Dynamic Type 和返回手势。

## 7. 迁移顺序

1. 固化 tokens、字体、图标、PresentationLevel 和通用 Item anatomy。
2. 迁移 Button/IconButton、Avatar/Badge/Presence、Channel/DM/User 等高频基础项。
3. 迁移 Message、Reply、Attachment、Context、Approval 等核心协作流程。
4. 迁移 Fleet、Settings、Notifications、Workbench 等管理与工作台区域。
5. 每迁移一种 Item 就删除对应局部配方，并降低 CI 中的 legacy 数量上限。

Android 尚未提供的产品能力只在契约中标记 unavailable，不创建假页面。现有服务端 DTO 和 API 不因视觉迁移而改变。

## 8. 完成标准

- Component Gallery 覆盖三档以及 selected、disabled、loading、error、unread、approval 等关键状态。
- Web 桌面/窄窗/手机宽度，iOS Dynamic Type，Android 系统字号与横竖屏均可读。
- 键盘焦点、VoiceOver、TalkBack、颜色对比度和触控区域通过验证。
- 聊天、频道切换、Context 添加、审批、通知、Fleet、Settings、Workbench 核心流程完成回归。
- CI 阻止新增重复按钮、头像、徽标、频道行和 Context chip 配方。

## 9. 当前决策

- 设计语言采用「Editorial Correspondence」，保持暗色产品工作区和移动端系统主题能力。
- Source Serif 4 为开源字体资产；显示与正文使用不同 optical size，无衬线承担所有工具语义。
- `max / medium / minimal` 表示信息展示层级，不是控件尺寸。
- `comfortable / regular / compact` 表示控件高度，与信息展示层级独立继承和覆盖。
- 网站、政策和帮助内容与产品共享字体和语义原则，但页面排版可以更接近正式出版物。
- 本轮不修改 MIT 开源许可。
