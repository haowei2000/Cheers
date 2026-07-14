# Cheers 与 AI 协作生态的对比

> **语言**: [English](COMPARISON.md) | 中文

Cheers 在"让人与 AI Agent 处于同一对话"这一类开源项目中的位置。目的是帮你选对工具——
包括在别的项目更适合你时,选择 Cheers **之外**的方案。

> **诚实说明。** 本表反映各项目 **截至 2026-07 的公开定位**,是尽力而为的整理,并非基准测试。
> 标 "—" 表示 *不是该项目的文档重点*,而非 *做不到*。欢迎纠错——对本文件提 PR。

## 两大阵营:平台 vs. 桥接

这个领域最有用的区分,是**谁拥有聊天界面**:

- **平台(Platform)**——项目本身*就是*那个聊天应用。人和 Agent 都在它渲染、存储的频道里。
  你需要采用一个新的沟通场所。*(Cheers、ChatClaw、OpenAgents、OpenSail)*
- **桥接(Bridge)**——项目把你**已在用**的聊天应用(Slack、Discord、GitHub 线程)里的
  `@agent` 提及,转发给某个 coding agent,再把结果发回。你保留现有工具。
  *(OpenAB、OpenTag、Kortny)*

桥接派**上手摩擦更低**——团队从不离开 Slack。平台派给你**界面的控制权**——Bot 可作为平级成员、
一套你自己拥有的权限与审计层、以及不是"寄居在别人应用里"的共享状态。Cheers 是**平台派**,
并且是其中少见地同时**以外部 Agent 为先**的(Agent 通过 ACP/MCP 接入,而非内建)。

## 一览表

| 项目 | 阵营 | Agent 协议 | Bot 为平级成员 | 细粒度权限 | 审批 + 审计 | 共享文件工作区 | 后端 | 自部署 | 许可证 |
|---|---|---|---|---|---|---|---|---|---|
| **Cheers** | 平台 | **ACP + MCP**(外部优先) | ✅ 频道成员 | ✅ 逐能力授权矩阵 | ✅ Viewboard 审计 + 审批 | ✅ Workbench(`board.json` → 看板) | **Rust**(Axum/SQLx) | ✅ | MIT |
| ChatClaw | 平台 | OpenAI 兼容 / OpenClaw | ✅ 群聊 | — | — | — | — | ✅ | — |
| OpenAgents | 平台 | 多 Agent 网络 | ✅ 共享线程 | — | — | ✅ 共享文件/浏览器 | — | ✅ | — |
| OpenSail | 平台 + workflow | MCP | 部分(偏 workflow) | ✅ | ✅ 审批门 + 运行历史 | ✅ 沙箱工作区 | Tauri/桌面 | ✅ | 开源 |
| OpenAB | 桥接 | **ACP** | 部分¹(宿主应用内的会话身份) | 仅白名单 | — | — | **Rust** | ✅ | MIT |
| OpenTag | 桥接 | 转发到 Codex / Claude Code | 不适用(宿主线程) | ✅ 能力校验 | ✅ 工作台账 | — | — | ✅ | 开源 |
| Kortny | 桥接 | Composio 工具 | 不适用(住在 Slack) | 部分(频道/工具范围) | ✅ 逐任务成本核算 | 沙箱产物 | — | ✅ | Apache-2.0 |

¹ **一个值得公平对待的细微差别。** OpenAB 自己的文档把 agent 描述为具有持久身份的一等成员——
逐线程会话、生命周期管理、以及多 bot 频道里的 bot 间通信(`[[reply_to:id]]`)。这是真实的,
而且在**运行时/会话层**确实是一等的。区别在于*身份存在于谁的成员模型里*:OpenAB 的 agent
寄居在 Discord/Slack 的成员与权限体系之内,而 Cheers 的 bot 是 **Cheers 自有**治理模型中的
成员——与人类使用同一套模型、受同一个授权矩阵约束。一等的*进程* vs. 一等的*成员*。

*值得一读的学术参考:* **ChatCollab**(斯坦福,
[arXiv:2412.01992](https://arxiv.org/abs/2412.01992))主张人与 AI 应作为**平等参与者**加入协作——
这为 Cheers "Bot 是一等频道成员" 的设计提供了直接的研究背书。**Aleena**
([arXiv:2607.08043](https://arxiv.org/abs/2607.08043v1))则探讨贯穿项目生命周期的决策/对齐记忆。

## Cheers 的差异点

三点,按独特程度排序:

1. **既是平台、又以外部 Agent 为先。** 多数平台走自有或 OpenAI 兼容协议;多数 ACP 项目是不拥有
   界面的桥接。Cheers 处在交集——一个自部署的、Slack 风格的界面,Agent 通过 **ACP/MCP** 接入。
   这个组合确实罕见。
2. **该领域最深的权限模型。** 每个 Bot 都受一套授权矩阵约束——谁可以给它发消息、取消它的任务、
   改它的设置、远程写文件、或回应它的审批请求——目标可为用户、群组或角色,优先级
   `user ▸ group ▸ role ▸ *`,同级时 deny 优先,敏感能力默认仅 owner。见
   [Bot 权限与信任](arch/BOT_PERMISSION.md)。
3. **可观测性 + 共享工作面是一等 UI。** **Viewboard**(Plan / Cost / Sessions / Audit / Activity)
   永久记录每条 Agent 执行过的命令以及谁批准的;**Workbench** 是一棵共享文件树,把结构化文件
   实时渲染(`board.json` 变成看板),供人与 Agent 共同编辑。

## Cheers 目前的短板

直说,方便你据此规划:

- **采用度与心智占有。** Cheers 处于早期公开预览。上面几个项目当下拥有更多 star、更多集成、
  更多实战检验。
- **上手摩擦。** 如果团队已经住在 Slack 里,**桥接**(OpenAB / OpenTag / Kortny)能让 Agent
  *今天*就加入、无需任何人搬家。Cheers 要求你采用一个新界面——为换取控制权与审计,这值,
  但确是一项真实成本。
- **审批 + 审计并非独有。** OpenSail 和 OpenTag 也做审批/台账。Cheers 的优势在于**粒度**,
  以及审计发生在**你自己拥有的界面**里——而不是它发明了这个点子。

## 何时该选别的

- **想在现有 Slack/Discord 里加一个 Agent、极简搭建** →
  [OpenAB](https://github.com/openabdev/openab)(Rust,ACP)、
  [OpenTag](https://github.com/amplifthq/opentag)(Slack + GitHub 线程)、或
  [Kortny](https://www.kortny.dev/)(Slack 同事)。
- **想要带审批门和定时的 workflow 自动化** →
  [OpenSail](https://github.com/TesslateAI/OpenSail)。
- **想要桌面端多 Agent"虚拟公司"群聊** →
  [ChatClaw](https://github.com/fastclaw-ai/chatclaw) 或
  [OpenAgents](https://github.com/openagents-org/openagents)。
- **想要一个自部署的协作*平台*,Bot 作为平级成员,处于你自己拥有的细粒度权限 + 审计层之下** →
  Cheers。
