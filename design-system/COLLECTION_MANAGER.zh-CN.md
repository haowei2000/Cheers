# Cheers Collection Manager 模式

状态：`reference`

适用范围：Claims、Invite Links、Permission Grants、Passkeys、Device Sessions，以及任何包含
搜索、添加、编辑和删除能力的业务集合。

## 1. 核心结构

```text
Section header: 名称 + 非交互计数
Toolbar: Search（flex） + Add（regular）
ItemList:
  OperationsItem × n
  或 CollectionEditorItem
  或 CollectionDeleteItem
  或 CollectionEmptyItem
```

集合始终以 List 为主体。搜索和 Add 是列表级动作；Edit、Delete、Copy、Revoke 等是单项动作。
不能把一个常驻的大表单放在列表上方，再把已有记录放在表单下方。

## 2. 模式状态机

| 模式 | 呈现 | 退出方式 |
|---|---|---|
| `browse` | 搜索栏、Add、普通 OperationsItem 列表 | Add / Edit / Delete |
| `add` | 在列表首位插入 editor item；Add 暂时 disabled | Save / Cancel |
| `edit(id)` | 原位置的 item 被 editor item 替换 | Save / Cancel |
| `delete(id)` | 原位置被危险确认 item 替换 | Delete / Cancel |

同一时间只能存在一个非 browse 模式。搜索只影响可见集合，不修改业务状态。

## 3. Item anatomy

普通项目使用：

`leading → title / subtitle / metadata → critical status / status → actions`

- `title`：可识别名称，例如 Bot 名、链接短名或设备名。
- Browse Item 最多单行，不展示 `subtitle`、`metadata` 或 `preview`；这些信息进入 Edit 或详情视图。
- `status`：Active、Paused、Expired 等状态；关键错误必须进入 `criticalStatus`。
- `actions`：Copy/Open → Edit → Delete/Revoke。复合操作行不得同时设置整行 `onClick`。

## 4. Add / Edit

- Add editor 固定插入列表首位，让新项目进入后自然落在同一个集合里。
- Edit editor 必须替换原行，保持用户的空间定位；不能跳到页面顶部的另一套表单。
- Editor 使用持久 label，不以 placeholder 代替字段名称。
- 字段不超过 4 个时使用 inline editor；超过 4 个或包含高风险权限矩阵时使用 Dialog/Sheet，保存后仍回到原 item。
- Save 使用主要动作；Cancel 使用 ghost。校验错误留在 editor item 内。

## 5. Delete / Revoke

- Trash/Revoke icon 第一次点击只进入 `delete(id)`，绝不能立即调用 API。
- 确认态替换原 item，并明确显示对象名称和影响。
- Cancel 在前，危险确认在后；执行期间只禁用该确认 item。
- 服务端不支持 Delete/Edit 时必须省略对应动作，不能伪造能力。

## 6. Search 与空状态

- Search 使用 regular 36px 控件，移动触屏保留 44px 命中高度。
- 查询为空且集合为空：只显示 “No items yet”；Add 仅保留在顶部工具栏，避免重复入口。
- 查询非空且无结果：显示 “No matching items” 和 Clear search。
- 搜索结果仍使用同一 OperationsItem，不创建另一套 result row。

## 7. 三档与视觉规则

- Toolbar：`regular`；Item：固定 `regular = 36px`；尾部图标动作：桌面 `compact`、触屏自动 44px。
- 字号只使用 12 / 14 / 16px；Web 通用圆角 10px；静止状态无四周边框。
- 关键状态在 `max / medium / minimal` 下均不可隐藏。
- Avatar、Presence、Unread 等语义形状继续使用圆形。

## 8. Claims 与 Links 的映射

Claims：每个 Bot policy 是一个 OperationsItem；Add 创建尚未配置的 Bot policy；Edit 在原位置展开；
Delete 表示删除 policy 或重置为 Off，具体语义必须与服务端契约一致。

Links：每个 invite link 是一个 OperationsItem；Add 创建 link；Copy 是普通单项动作；Delete 对应 Revoke。
如果服务端不支持修改已创建 link，则省略 Edit，不通过“撤销后重建”伪装成 Edit。

可交互参考实现位于 Web Item Gallery 的 **Search · Add · Edit · Delete** 区域。
