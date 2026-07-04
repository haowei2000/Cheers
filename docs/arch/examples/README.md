# 工作台示例(参考)

两个可直接上传试用的最小样例,配套 [WORKBENCH.md](../WORKBENCH.md) / [RENDERER_PLUGIN.md](../RENDERER_PLUGIN.md)。

| 文件 | 类型 | 怎么用 |
|---|---|---|
| [`md-checklist.plugin.html`](./md-checklist.plugin.html) | **渲染器插件**(代码/沙箱) | 设置 → Workbench extensions → 「插件」卡上传 `.html`。把 Markdown 待办(`- [ ]` / `- [x]`)渲染成可勾选清单,勾选写回 md。声明了**接受判断**(`match.requireAny` + 运行期 `cheers:unsupported`),只接受含待办行的 markdown。 |
| [`md-demo.template.json`](./md-demo.template.json) | **环境模板**(数据,纯 seed) | 工作台抽屉「临时模板」上传 `.json`(或 设置 → 全局模板)。只 seed 两个 `.md`,**不指定**渲染器——怎么渲染由你在 Files 面板按文件挑。 |

**串起来试**:装模板 → Files 打开 `demo/todo.md` → 右上「渲染器」选「清单」→「设为 Tab」→ 顶部 tab 即用该渲染器。
对比 `demo/notes.md`(纯散文)下拉里**没有**「清单」——这就是「渲染器只接受它能渲染的文件」。

> 这两个文件同时作为前端的可运行样例存在:
> `frontend/src/features/chat/workbench/sandbox/examples/md-checklist.html` ·
> `frontend/src/features/chat/workbench/examples/md-demo.json`。docs 这份是定稿参考副本。
