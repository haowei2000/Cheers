# 工作台示例(参考)

可直接上传试用的最小样例,配套 [WORKBENCH.md](../WORKBENCH.md) / [RENDERER_PLUGIN.md](../RENDERER_PLUGIN.md)。
英文开发指南见 [docs/developer/PLUGIN_DEVELOPMENT.md](../../developer/PLUGIN_DEVELOPMENT.md)。

## 渲染器插件(代码/沙箱)

设置 → Workbench extensions → 「插件」卡上传 `.html`。

| 文件 | 场景 | 说明 |
|---|---|---|
| [`md-checklist.plugin.html`](./md-checklist.plugin.html) | 通用 | 把 Markdown 待办(`- [ ]` / `- [x]`)渲染成可勾选清单,勾选写回 md。声明了**接受判断**(`match.requireAny` + 运行期 `cheers:unsupported`),只接受含待办行的 markdown。 |
| [`lit-review.plugin.html`](./lit-review.plugin.html) | **科研** | 论文追踪表:把 `{ "papers": [...] }` 结构的 JSON 渲染成可编辑表格(标题/作者/期刊/年份/笔记 + 阅读状态下拉 + 星级评分),编辑写回 JSON。`match.jsonHas: ["papers"]` 预筛,运行期再验证 `papers` 是数组。 |
| [`code-review.plugin.html`](./code-review.plugin.html) | **代码** | 代码评审清单:渲染 `## 文件路径` 分节、`- [ ] [P0/P1/P2] 描述` 的 markdown 评审记录,severity 徽章 + 顶部进度条,勾选就地改写该行并写回。`match.requireAny: ["[P0]","[P1]","[P2]"]`。 |

## 环境模板(数据,纯 seed)

工作台抽屉「临时模板」上传 `.json`(或 设置 → 全局模板)。模板只 seed 文件,**不指定**渲染器——怎么渲染由你在 Files 面板按文件挑。

| 文件 | 场景 | seed 内容 |
|---|---|---|
| [`md-demo.template.json`](./md-demo.template.json) | 通用 | 两个 `.md`(todo + 说明),配合 md-checklist 插件演示「模板=数据、渲染器=代码」解耦。 |
| [`lit-review.template.json`](./lit-review.template.json) | **科研** | `research/papers.json`(配 lit-review 插件)、`research/reading-notes.md` 阅读笔记、`prompts/summarize-paper.md` 论文总结提示词;内置一个 markdown 视图。 |
| [`code-project.template.json`](./code-project.template.json) | **代码** | `dev/board.json` 看板视图、`dev/review-findings.md`(配 code-review 插件)、`dev/tasks.md`(配 md-checklist 插件)、`prompts/code-review.md` 评审提示词。 |

**串起来试**:装 `md-demo` 模板 → Files 打开 `demo/todo.md` → 右上「渲染器」选「清单」→「设为 Tab」→ 顶部 tab 即用该渲染器。
对比 `demo/notes.md`(纯散文)下拉里**没有**「清单」——这就是「渲染器只接受它能渲染的文件」。
科研/代码同理:装 `lit-review` 模板 + 插件后,打开 `research/papers.json` 选「Paper tracker」;装 `code-project` 模板 + 插件后,打开 `dev/review-findings.md` 选「Review findings」。

> 这些文件同时作为前端的可运行样例存在:
> `frontend/src/features/chat/workbench/sandbox/examples/*.html` ·
> `frontend/src/features/chat/workbench/examples/*.json`。docs 这份是定稿参考副本。
