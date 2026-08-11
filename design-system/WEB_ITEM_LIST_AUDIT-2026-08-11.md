# Web Item List 结构审计 · 2026-08-11

状态：`complete`

## 统一接口

- `ItemList presentationLevel controlSize`：列表级继承边界。
- `ItemSection`：标题、可选动作与 ItemList。
- `CollectionManager`：标题、计数、Search、Add、Empty 与模式状态。
- `CollectionPickerItem`：Add-by-search 的原位选择器。
- `ItemGroup`：summary Item 与可展开 detail 共占一个 `listitem` 的 specialized 结构。
- 信息档位只能是 `max / medium / minimal`；物理尺寸只能是 `comfortable / regular / compact`。

## 审计结果

| 区域 | 问题 | 处理 |
|---|---|---|
| Channel Settings · Members | 独立标题、卡片底色、常驻邀请框、立即删除，与 Claims/Links 不同 | 已迁移 CollectionManager；regular 单行；Add-by-search；删除确认 |
| Workspace Settings · Members | 与旧 Channel Members 相同的独立配方 | 已迁移 CollectionManager；Add-by-search；原行删除确认 |
| MembersPopover | Loading/Empty 直接作为 list 子节点，未使用语义 Item | 已改为 OperationsItem，并显式继承 medium/regular |
| New DM | 选择列表正确，但容器未显式登记档位 | 已使用 ItemList medium/regular 收口 |
| Notifications / Task Claims | 本地 section header；信息档位由单项重复声明 | 已迁移 ItemSection 与容器继承 |
| Bot Activity / Connection History | 语义 Item 正确，容器档位未显式登记 | 已使用 ItemList max/regular 收口 |
| Bot Grants | 编辑表单与列表仍由页面组合 | 两类 Grants 均已迁移 CollectionManager 与 Add/Edit/Delete 模式 |
| Workbench Manager | Empty paragraph 直接混入 list，三组列表重复结构 | 已迁移 WorkbenchItem Empty 与 ItemSection |
| Connector Changes | ItemList 内存在额外 div 包装，破坏直接 listitem 语义 | 已使用 ItemGroup 表达 summary + expandable detail |

## 验收约束

- ItemList 的直接业务子项必须具备 `listitem` 语义。
- Browse Item 最多单行；详细信息进入 max、编辑态或详情视图。
- Search/Add 只出现一次；Empty 不重复 Add。
- 删除与撤销必须先进入确认态。
- 文字容器必须 `min-w-0` 并截断；图标按钮必须提供可访问名称。
- CI 禁止业务 ItemList 缺少继承参数，也禁止 `.map()` 返回原始 div/p wrapper。
