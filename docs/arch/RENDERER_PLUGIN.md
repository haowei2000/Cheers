# 渲染器插件开发指南

> **Language**: [English(规范版)](../developer/PLUGIN_DEVELOPMENT.md) | 中文(本文,设计原文)
>
> ⚠️ **规范以英文版为准**:协议消息表、manifest 校验规则、Troubleshooting 都维护在
> [PLUGIN_DEVELOPMENT.md](../developer/PLUGIN_DEVELOPMENT.md);本文保留设计动机与中文语境,两边冲突时以英文版为准。

> 状态:**v1 已实现**。host 侧 `render/save` 协议已落地——工作台 **File 面板**里选中一个文件,用顶部「渲染器」下拉选内置 lens 或已装插件;绑定(`path → renderer id`)存进 `.workbench.json`。旧的 `panels`/`init` 沙箱(场景插件)**已退役**(上传会被拒绝,示例已删除)。代码:`renderers/registry.ts`、`renderers/RendererHost.tsx`、`sandbox/SandboxRenderer.tsx`、`panels/FilePanel.tsx`。
> 关联:[[WORKBENCH]]「关系与边界」· [[context-and-environment]]

## 0. 一分钟心智模型

渲染器之于文件,**像 CSS 之于 HTML**:

- **文件**是纯内容(主格式 **Markdown**),从不声明自己该用哪个渲染器。
- **渲染器**自带「我认领什么 + 怎么解析 + 怎么画」的全部判断,把一个文件的内容渲染成可交互 UI,并能把编辑写回那个文件。
- **环境模板**只负责 seed 初始文件,不描述用哪个渲染器。

一个渲染器**可专可全**:可以只管「带 `- [ ]` 的 markdown 清单」,也可以只管「某种 json 结构」。小而专、可共存——和写一条只命中特定 selector 的 CSS 规则一样。

## 1. 插件 = 一个沙箱 HTML

一个插件就是**一个 `.html` 文件**,里头:

1. 一段**内嵌 manifest**(`<script type="application/json" id="cheers-plugin">`),声明它提供哪些渲染器;
2. 你的渲染逻辑(任意 vanilla JS / 打包后的框架代码,**全部内联进这一个 html**);
3. 通过 `postMessage` 和宿主通信(见 §3)。

它运行在 `<iframe sandbox="allow-scripts">` 里——**不透明(null)源**,读不到主站的 token / cookie / localStorage;只能通过 postMessage 协议触达被指派的那一个文件。

## 2. Manifest

```json
{
  "id": "md-checklist",
  "title": "Markdown 清单",
  "renderers": [
    { "id": "checklist", "title": "清单", "match": { "format": "markdown" } }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 插件全局唯一 id(安装的主键) |
| `title` | 给人看的名字 |
| `renderers[]` | 这个插件提供的渲染器,可多个 |
| `renderers[].id` | 渲染器在插件内唯一 |
| `renderers[].match.format` | `markdown` / `json` / `yaml` / `toml` / `xml` / `text`(可为数组)。host 按扩展名归类(`.md`→markdown,`.yaml`/`.yml`→yaml,无扩展名→text)。 |
| `renderers[].match.glob` | (可选)按路径窄化,如 `"reviews/*.md"` |
| `renderers[].match.requireAll` | (可选)内容必须**全部包含**这些子串。用于「md 含某些标题」,如 `["## 待办","## 进行中"]`。 |
| `renderers[].match.requireAny` | (可选)内容至少包含**其一**,如 `["- [ ]","- [x]"]`(待办行)。 |
| `renderers[].match.jsonHas` | (可选,仅 json)解析后的对象必须**含全部**这些顶层键,如 `["columns","cards"]`。**已弃用**:新 manifest 用 `dataHas`。 |

> **协议 1 补充(规范见英文版)**:manifest 顶层可声明 `"protocol": 1`(缺省即 1);`match.format` 可为字符串**数组**;新增 `dataHas`(结构化内容顶层键,格式无关,取代 `jsonHas`)与 `dataKind`(`"object" | "array"`,声明顶层形状——认领「JSON 数组」的唯一方式)。服务端安装时校验 manifest(错误表见英文版 §8);bundle ≤ 2 MiB。

> **`match` = 你声明「我接受什么」**。host 拿文件内容廉价评估(子串/JSON 键,**不**启动你的沙箱),据此决定你**是否出现在该文件的渲染器候选里**——所以一个需要 `## ` 标题的渲染器,不会被推荐给一篇纯散文。
>
> **两层接受判断**(都由渲染器声明,正是「判断在渲染器侧」):
> 1. **声明式 `match`**(上面)——host 预筛候选,廉价、精准。
> 2. **运行期最终裁决**——`cheers:render` 收到后你真去解析;解析不了就回 `cheers:unsupported {reason}`,host 显示「该渲染器无法渲染此文件」。这是你对**结构**的最终判断(`match` 兜不住的复杂结构在此把关)。
>
> 文件**始终是纯内容**:它不声明类型,是渲染器声明它接受什么。

## 3. postMessage 协议

| 方向 | `type` | 载荷 | 时机 |
|---|---|---|---|
| plugin → host | `cheers:ready` | — | iframe 加载完,告诉 host「派活给我」 |
| host → plugin | `cheers:render` | `{ path, format, content, version, rendererId }` | 指派渲染**一个**文件。**只有两个触发点**:你的 `cheers:ready`,以及一次写冲突之后。**别人(bot/其他成员)改了文件不会重发**——见下方「渲染时机」 |
| plugin → host | `cheers:unsupported` | `{ reason? }` | 看了内容渲染不了(最终裁决)→ host 显示「该渲染器无法渲染此文件」 |
| plugin → host | `cheers:save` | `{ content }` | 把当前这一个文件存回去 |
| host → plugin | `cheers:saved` | `{ ok, version, error? }` | 乐观锁写入结果;`ok` 时更新你手里的 `version` |
| plugin → host | `cheers:resource` | `{ reqId, resource, params }` | **host API**:读频道信息(见下白名单),`channel_id` 由 host 强制为当前频道 |
| host → plugin | `cheers:resource:result` | `{ reqId, ok, data\|error }` | 读取结果 |
| plugin → host | `cheers:open` | `{ uri }` | 请求把**用户的视图**导航到一个 `cheers:` 定位符:`cheers:ws/<bot>/<路径>#L<行>` 打开远程工作区并定位到行(先做存在性探测),`cheers:desk/<路径>` 聚焦工作台文件,`cheers:inbox/<file_id>` 打开频道文件。发出即忘、无回执;纯 UI 路由——host 严格解析,跳转背后的每次读取照常鉴权,解析不了给用户看清晰报错。不支持的 host 直接忽略(协议 1 的"忽略未知"生长规则),可以无条件发。 |
| plugin → host | `cheers:compose` | `{ text }` | **预填**聊天输入框——**绝不代发**。空草稿直接填入;已有草稿则换行追加(用户敲的字永不丢失);文本里匹配频道成员的 `@名字` 会注册为可路由的提及。人审阅、可改、亲手按发送——那一下按键才让插件的建议变成频道动作,副作用保持人在环、全程可审计。host 侧形状把关(≤4000 字符、剥控制符)。发出即忘;不支持的 host 忽略。 |

### 3.1 Host API:读频道信息

除了 `fs`(只能动被指派的那一个文件),渲染器还能读**当前频道**的若干信息,经 `cheers:resource` 代理。host 只放行白名单内的**只读** verb,并强制 `channel_id` = 当前频道(你读不到别的频道):

| resource | 内容 |
|---|---|
| `channel.info` | 频道元信息(名称等) |
| `channel.members` | 成员列表 |
| `channel.messages` | 历史消息 |
| `channel.activity.read` / `channel.messages.index` | 活动 / 消息索引 |

```js
function res(resource, params) {
  return new Promise(function (ok) {
    var id = ++rid; pendingRes[id] = ok;
    parent.postMessage({ type: "cheers:resource", reqId: id, resource: resource, params: params || {} }, "*");
  });
}
// window.onmessage 里:if (m.type==="cheers:resource:result"){ var p=pendingRes[m.reqId]; if(p){delete pendingRes[m.reqId]; p(m);} }
var info = await res("channel.info", {});   // → { ok, data }
```

> **信任与外泄**:沙箱 iframe 隔离的是 token/DOM,**不隔离网络**——拿到数据的插件理论上能 fetch 到外部。所以 ① 这些 verb 全部**只读**且服务端仍按你的 channel-role 鉴权;② 插件是 **admin 安装**的(装的人为其背书);③ 白名单刻意保守。要给更敏感的能力,应走显式同意,别直接加进白名单。

### 3.2 渲染时机(最容易踩的一条)

`cheers:render` **只有两个触发点**:① 你发出 `cheers:ready` 之后;② 你自己的一次保存撞上版本冲突之后。

**没有第三个。** bot 或别的成员在后台改了这个文件,你**不会**收到新的 `cheers:render`,而且你**没有任何办法自己重读**——`cheers:resource` 白名单只覆盖 `channel.*`,不含文件内容。用户重新打开这个文件(iframe remount → `ready` → `render`)才会看到新内容。

这是刻意的能力收紧,不是缺陷:插件拿到的永远是 host 明确指派的那一份快照。但在 bot 会主动写工作区文件的产品里,它意味着「我的看板不刷新」是**预期行为**——设计 UI 时别假设自己能拿到实时内容,也别把「长期开着不动」当成正常使用姿势。

要点:

- **单文件能力**。一次 `cheers:render` = 一个文件。你**只能**渲染并存回这个 `path`,碰不到别的文件/频道。需要读兄弟文件的高级场景留待 v2(届时在 manifest 里声明额外只读路径)。
- **乐观锁**。`save` 不带 version;host 用它发给你的 `version` 做 if-version 写入。冲突时 `cheers:saved.ok=false`,host 会重发一条新的 `cheers:render`(带最新 content/version),你重渲染即可。
- **安全渲染**。`content` 是不可信文本(可能来自 bot 或别人)。用 `textContent` / 受控表单写入 DOM,**绝不 `innerHTML` 拼接**。

## 4. 完整最小示例:Markdown 清单渲染器

> 可直接上传的成品在 [`examples/md-checklist.plugin.html`](./examples/md-checklist.plugin.html)(配套环境模板 [`examples/md-demo.template.json`](./examples/md-demo.template.json),见 [examples/README](./examples/README.md))。

把一个普通的 markdown 待办(`- [ ] 任务` / `- [x] 任务`)渲染成可勾选清单;勾选即把 markdown 写回。文件始终是一份**人能读、bot 能写**的普通 markdown——「判断」(认出 task 行、序列化回去)全在渲染器里。

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <!-- 内嵌 manifest:host 上传时惰性解析,不执行 -->
    <script type="application/json" id="cheers-plugin">
      {
        "id": "md-checklist",
        "title": "Markdown 清单",
        "renderers": [
          { "id": "checklist", "title": "清单", "match": { "format": "markdown" } }
        ]
      }
    </script>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font: 13px system-ui, sans-serif; background: #0a0a0a; color: #e4e4e7; }
      #root { padding: 8px 10px; }
      .task { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
      .task span.done { color: #71717a; text-decoration: line-through; }
      .line { white-space: pre-wrap; color: #a1a1aa; padding: 1px 0; }
      #st { padding: 4px 10px; color: #71717a; font-size: 11px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <div id="st"></div>
    <script>
      var ASSIGN = null;             // 当前指派:{ path, format, content, version, rendererId }
      var lines = [];                // 内容按行拆开(就地编辑)
      var TASK = /^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/;   // - [ ] / - [x]

      function send(msg) { parent.postMessage(msg, "*"); }
      function setStatus(t) { document.getElementById("st").textContent = t; }

      window.addEventListener("message", function (e) {
        var m = e.data; if (!m || typeof m !== "object") return;
        if (m.type === "cheers:render") {           // host 指派一个文件
          ASSIGN = m; lines = String(m.content || "").split("\n"); render();
        } else if (m.type === "cheers:saved") {     // 写回结果
          if (m.ok) { ASSIGN.version = m.version; setStatus("已保存 v" + m.version); }
          else setStatus("保存失败:" + (m.error || ""));
        }
      });

      function save() { send({ type: "cheers:save", content: lines.join("\n") }); }

      function render() {
        var root = document.getElementById("root"); root.innerHTML = "";
        lines.forEach(function (line, i) {
          var mt = line.match(TASK);
          if (mt) {
            var row = document.createElement("label"); row.className = "task";
            var cb = document.createElement("input"); cb.type = "checkbox";
            cb.checked = mt[2].toLowerCase() === "x";
            var txt = document.createElement("span");
            txt.textContent = mt[3];                 // textContent → 不可信文本无 XSS
            if (cb.checked) txt.className = "done";
            cb.onchange = function () {
              lines[i] = mt[1] + "[" + (cb.checked ? "x" : " ") + "] " + mt[3];
              render(); save();                      // 就地改这一行 → 写回
            };
            row.appendChild(cb); row.appendChild(txt); root.appendChild(row);
          } else {
            var p = document.createElement("div"); p.className = "line";
            p.textContent = line;                    // 非 task 行原样保留
            root.appendChild(p);
          }
        });
      }

      send({ type: "cheers:ready" });                // 最后一步:告诉 host 我就绪
    </script>
  </body>
</html>
```

它展示了一个合格渲染器的全部要素:**接 `render` → 解析内容 → 画 UI → 编辑就地改 → `save` 写回 → 收 `saved` 更新 version**,且对不可信内容用 `textContent`。

## 5. 安全模型(三道,沿用沙箱机制)

1. **不透明源**:`sandbox="allow-scripts"` 无 `allow-same-origin` → 插件偷不到主站密钥。
2. **单文件能力**:插件只能渲染/存回 host 指派的那一个 `path`——host 在代理层钉死,服务端 channel-role 鉴权照常生效。
3. **惰性解析 manifest**:host 用 `DOMParser` 读内嵌 JSON,**不执行**脚本。

## 6. 开发清单

- [ ] 一个 `.html`,内嵌 `#cheers-plugin` manifest(`id` / `title` / `renderers[]`)。
- [ ] 每个渲染器声明 `match.format`(粗选择器);精判断放进渲染代码。
- [ ] `cheers:ready` 收尾;`cheers:render` 里解析 `content`;编辑走 `cheers:save`;`cheers:saved` 更新 `version`。
- [ ] 只动 host 指派的那个文件,不假设别的路径。
- [ ] 不可信内容一律 `textContent` / 受控表单,**绝不 `innerHTML`**。
- [ ] 主格式 Markdown 优先;要支持 json/xml 等是你渲染器自己的事(`match.format` 写对即可)。

## 7. 安装与绑定

- **试用/开发**(人人):把 `.html` 拖进工作台抽屉(或点「Load extension」选文件)——**仅本浏览器会话**生效,渲染器立即进入匹配文件的候选列表(⏱ 标记);同 id 会话插件会遮蔽已安装版本,方便迭代调试,刷新即消失。
  - **热重载**:点「Watch file」选中磁盘上的 `.html`,之后**在编辑器里保存即自动重载**,不必反复拖拽(基于 File System Access API,仅 Chromium 系浏览器有此按钮;其他浏览器继续用拖拽)。
  - **调试**:会话插件(⏱)的预览区右下角有 **Dev** 按钮,打开**协议检查器**——逐条列出 `cheers:*` 的收发方向、类型和截断后的载荷。沙箱是不透明源,插件里的 `console.log` 和未捕获异常**传不到宿主页**(表现为一片空白 iframe),SDK 会把它们转成 `cheers:log` 送进这个面板。这是排查「为什么什么都没画出来」的主要手段。
- **安装**(admin):设置 → Workbench extensions → 上传 `.html`(进 `workbench_plugins` 表,全频道可见)。
- **绑定**:打开某文件时,工作台按 `.workbench.json` 的 `bindings[path]` 选渲染器;没有就默认「原文」(textarea)或让用户从候选里挑,选择持久化进 `.workbench.json`(`path → rendererId`)。**绑定不进文件**,文件始终是纯内容。

### 一个文件被多个渲染器匹配时(CSS 式层叠)

不是冲突,是一个**排好序的候选列表**,按 CSS 的「特异性 + 层叠」消解:

1. **用户绑定 = 终裁**(像 inline style / `!important`):`bindings[path]` 一旦设了,这个文件永远用它,无视有多少候选。
2. **没绑定时按特异性排序**:声明的约束越多越具体(`requireAll` 标题数、`jsonHas` 键数、`requireAny`、`glob` 计分;插件略高于内置同分),**最具体的排候选第一**。
3. **同分按稳定顺序**(内置在前、插件按安装序),保证确定性。
4. **去歧义**:候选标来源(`清单 · md-checklist`),两个同名也分得清。
5. **默认仍是「原文」**——系统**不替你自动挑**渲染器(避免「凭什么是它」的意外);候选只是按最优排在最前,选择权始终在人。

## 8. 与「环境模板」的关系

渲染器**供给**能力,模板**产出**文件,二者经「文件 format/结构 + 用户绑定」松耦合。模板不引用、不依赖任何具体渲染器;换掉渲染器,同一批 markdown 文件可以换一种画法。详见 [WORKBENCH.md](./WORKBENCH.md)。
