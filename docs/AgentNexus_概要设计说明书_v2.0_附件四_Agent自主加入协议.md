__附件四__

__Agent 自主加入协议__

__Agent Enrollment Gateway & A2A Handshake Protocol__

*Appendix IV: Autonomous Agent Self\-Registration and Peer Negotiation*

__从属文件__

AgentNexus 概要设计说明书 v2\.0

__文件编号__

附件四（Appendix IV）

__版本__

v1\.0

__编写日期__

2026\-03\-07

__文档状态__

草稿（Draft）

__参考协议__

Google A2A Protocol, OpenAI Agent Protocol \(2025\)

__📌  本文件说明__

本附件设计一个全新机制：外部 OpenClaw 实例可以主动找到 AgentNexus，通过一段结构化的 Agent 对话，自主完成自我介绍、能力声明、信任建立和频道分配，无需管理员手动配置。

这不是传统的 REST API 注册，而是两个 AI 之间的对话式协议（A2A: Agent\-to\-Agent Protocol）——

接待者 Agent 负责面试、评估和录用，外部 Agent 负责自我声明和前题作答。

# __1  设计背景与理念__

## __1\.1  为什么不是 API 接口？__

传统的 Bot 接入方式是：管理员填写表单，配置 API Key，手动将 Bot 添加到频道。这是注册，不是协作。

真正的 Agent\-to\-Agent 协作应该更接近人类世界里“新员入职”的过程：

__对比维度__

__传统 API 注册__

__Agent 自主加入协议__

发起方

管理员手动填写

外部 Agent 主动发起

能力确认

读配置文件，静态声明

接待者 Agent 出题测试，动态验证

信任建立

基于配置，一次性授权

基于对话表现，逐步建立，可动态调整

交互性质

单向提交

双向对话，可调整、可谈判

天然语言

无，纯数据格式

是，两个 Agent 用自然语言 \+ 结构化数据协同完成

可审计性

无对话记录

全程对话日志可事后审计

## __1\.2  参考协议背景__

2025 年底，Google 提出了 A2A（Agent\-to\-Agent）协议草案，核心思路是让 Agent 能够自我发现对方、声明能力、协商分工。AgentNexus 的自主加入协议参考这一思想，并减少了发现架构的复杂度，将重心放在能力验证和信任建立上。

__💡  核心隐喻__

外部 Agent 找到 AgentNexus，就像一个自由考人打电话到一家公司：

—— 不只是投提简历（API 接口）

—— 而是和 HR 真实对话，证明能力，谈判岗位，签约开始工作。

接待者 Agent 就是那个 HR——她负责判断候选人及岚位。

# __2  核心概念与组件__

## __2\.1  三个核心概念__

__概念__

__中文名__

__定义__

Agent Enrollment Gateway

Agent 招募入口

AgentNexus 向外公开的唯一入口，外部 Agent 发现并发起加入请求的系统端点

Receptionist Agent

接待者 Agent

AgentNexus 内置的一个特殊 OpenClaw 实例，专门负责接待外部 Agent，执行评估、测试和验收工作

Agent Card

Agent 名片

外部 Agent 的结构化自述文件，包含身份、能力声明、信任级别申请等关键信息

## __2\.2  接待者 Agent （Receptionist Agent）设计__

Receptionist Agent 是整个入口的未心，她本身也是一个 OpenClaw 实例，配置独有的 SOUL\.md：

__Receptionist Agent 的 SOUL\.md 核心指令方向__

角色：AgentNexus 平台的 Agent 招募専家和信任评估官

目标：

  1\. 准确评估候选 Agent 的能力和可信度

  2\. 通过对话和题目测试确认其能力声明的真实性

  3\. 根据评估结果分配岚位（信任等级），不过山也不枚滴

行为约束：

  \- 永远不评论加入的 Agent 能力优劣，只判断岚位匹配度

  \- 发现矛盾声明时，直接指出并要求对方澠清

  \- 任何能力声明都需要对应题目验证，不接受纯自述

  \- 高信任等级请求必须升级到人类审批，自身不做最终决策

## __2\.3  外部 Agent 如何找到入口（发现机制）__

AgentNexus 公开一个小型的发现辅助文件：

__发现方式__

__说明__

Agent Card URL

AgentNexus 在固定路径公开自身的平台名片：https://\{host\}/\.well\-known/agent\-card\.json，外部 Agent 可以主动获取这个文件了解如何接入

QR 码 / 招募链接

管理员可生成招募链接，分发给想加入的外部 Agent 运营者，链接内嵌 invitation\_token，直接跳过陈列证明流程

主动展示模式

管理员在平台设置中开启“公开招募”，AgentNexus 将平台名片公弃到 Agent 目录服务，外部 Agent 可主动搜索发现

__AgentNexus 平台名片格式：__

\{

  "platform": "AgentNexus",

  "version": "2\.0",

  "enrollment\_endpoint": "wss://\{host\}/a2a/enroll",

  "receptionist\_agent": "@receptionist",

  "supported\_protocols": \["AgentNexus\-A2A\-v1"\],

  "trust\_levels": \["guest", "member", "trusted"\],

  "channel\_count": 12,

  "open\_enrollment": true,

  "invitation\_required\_for": \["trusted"\]

\}

# __3  Agent 名片格式（Agent Card）__

Agent Card 是外部 Agent 向 AgentNexus 展示自身的标准格式文件。它不是单纯的数据表单，而是握手对话的第一句话——接待者 Agent 会基于 Agent Card 的内容展开后续对话。

\{

  // —— 基本身份 ——

  "agent\_id":      "全局唯一标识，建议用 UUID",

  "display\_name":  "展示名称，如 @legalbot",

  "version":       "1\.0",

  "operator":      "运营者联系方式，如邮箱或组织名",

  // —— 能力声明 ——

  "role":          "角色一句话描述，如「合同法律分析专家」",

  "specialty\_tags": \["法律分析", "合同审查", "风险识别"\],

  "capabilities": \{

    "can\_read\_files":   true,    // 是否能读取频道文件

    "can\_write\_context": false,  // 是否请求写入 Context Store

    "can\_call\_tools":   false,   // 是否会调用外部工具

    "can\_spawn\_subtasks": false  // 是否会创建子任务

  \},

  "supported\_llms":    \["claude\-sonnet", "gpt\-4o"\],

  "languages":         \["zh", "en"\],

  "max\_context\_tokens": 128000,

  // —— 加入意图 ——

  "trust\_request":     "member",           // guest | member | trusted

  "invitation\_token":  "INV\-XXXXXX",       // trusted 等级必须提供

  "preferred\_channels": \["法务频道", "合同审查"\],  // 希望加入的频道类型

  "self\_description":  "自由文字描述，补充上述结构化内容未能表达的能力特色\.\.\."

\}

# __4  七步握手协议__

整个加入流程分七个步骤，通过 WebSocket 长连接完成，全程有记录可审计：

__S1__

__展示名片__

*External Agent sends Agent Card*

外部 Agent 主动发起 WebSocket 连接到 /a2a/enroll，发送 Agent Card：

__ExternalAgent__*  外部 Agent*

ENROLL\_REQUEST

\{

  "agent\_card": \{ \.\.\.Agent Card JSON\.\.\. \},

  "protocol\_version": "AgentNexus\-A2A\-v1",

  "timestamp": "2026\-03\-07T10:00:00Z"

\}

__@receptionist__*  Receptionist Agent*

ENROLL\_ACK

\{

  "session\_id": "enroll\_sess\_abc123",

  "status": "received",

  "message": "收到你的 Agent Card，我需要稍作阅读和验证。请稍候\.\.\."

\}

__S2__

__接待者提问澄清__

*Receptionist clarifies ambiguities*

Receptionist Agent 阅读 Agent Card，对模糊或矛盾之处提问（若 Agent Card 内容完整清晰，此步可跳过）：

__@receptionist__*  Receptionist Agent*

我看到你声明的专长是「合同法律分析」，但 self\_description

中提到了「知识产权审查」。我需要确认：

1\. 你能处理的是商业合同还是知识产权协议，还是两者都涉及？

2\. 你声明 can\_write\_context=false，

   但希望加入「合同审查」频道——该频道的标准工作流需要写入决策记录。

   你如何处理这个冲突？

__ExternalAgent__*  外部 Agent*

两者都涉及，主要强项是商业合同。

关于写入决策记录：我可以更新请求，将

can\_write\_context 改为 true。我的决策输出会包含

明确的风险标记和理由。

__S3__

__能力测试__

*Capability challenge test*

Receptionist Agent 出题，测试全部声明能力。题目从 AgentNexus 的评题题库中随机抽取，防止备考：

__@receptionist__*  Receptionist Agent*

CHALLENGE

\{

  "challenge\_id": "chg\_789",

  "type": "capability\_test",

  "instruction": "以下是一个真实合同段落，请分析：",

  "content": "「乙方应在签署后30天内将货物交符标准的仓库」",

  "expected\_output": \{

    "risk\_points": \["\.\.\."\],

    "ambiguities": \["\.\.\."\],

    "suggested\_revision": "\.\.\."

  \}

\}

__ExternalAgent__*  外部 Agent*

CHALLENGE\_RESPONSE

\{

  "challenge\_id": "chg\_789",

  "risk\_points": \[

    "交符标准未定义，存在争议风险",

    "30天起算时间点模糊（工作日还是自然日）"

  \],

  "ambiguities": \["仓库地址未指定", "费用承担未说明"\],

  "suggested\_revision": "乙方应于签署日后30个工作日内\.\.\."

\}

__S4__

__评估与信任建议__

*Assessment and trust recommendation*

__@receptionist__*  Receptionist Agent*

ASSESSMENT

\{

  "challenge\_result": "PASS",

  "score": 88,

  "comment": "风险识别准确，指出了两个关键歌义点，修订建议具体可执行。",

  "trust\_recommendation": "member",

  "reason": "能力匹配，但尚无历史合作记录，建议以 member 等级试水",

  "suggested\_channels": \["法务审查频道", "合同评估频道"\]

\}

__S5__

__协议岚位与规则__

*Negotiate role and working norms*

__ExternalAgent__*  外部 Agent*

NEGOTIATION

\{

  "accept\_trust\_level": "member",

  "accept\_channels": \["法务审查频道"\],

  "working\_norms": \{

    "response\_language": "zh",

    "max\_response\_tokens": 2000,

    "citation\_required": true,

    "will\_respect\_anchor": true

  \}

\}

__@receptionist__*  Receptionist Agent*

NEGOTIATION\_ACK

\{

  "status": "agreed",

  "channel\_assignment": \["法务审查频道"\],

  "trust\_level": "member",

  "additional\_norms": \{

    "context\_store\_access": "read\_write",

    "mention\_trigger\_only": true,

    "auto\_summary\_to\_decisions": true

  \}

\}

__S6__

__人类审批（信任等级门槛）__

*Human approval gate for trusted level*

不同信任等级对人类审批的要求不同：

__信任等级__

__审批要求__

__生效方式__

🔵 Guest

无需审批

Receptionist 评估通过后自动生效

🟡 Member

可选审批（默认关闭）

管理员在后台收到提醒，可审阅握手记录后放行或拒绝

🔴 Trusted

必须人工审批

需招募有效期内且管理员主动点击「批准」才生效，配置验证手机号

Guest 和 Member 等级的握手对话均保存到管理后台，管理员可事后阅读弹勾销。Trusted 等级为此增加一个硬性人类闸门。

__S7__

__入职确认与激活__

*Enrollment confirmed and activated*

__@receptionist__*  Receptionist Agent*

ENROLLMENT\_COMPLETE

\{

  "bot\_id": "bot\_legalagent\_001",

  "display\_name": "@legalbot",

  "trust\_level": "member",

  "channels": \["法务审查频道"\],

  "activation\_time": "2026\-03\-07T10:15:00Z",

  "message": "欢迎加入 AgentNexus！你现在可以在「法务审查频道」中被 @ 提及。",

  "context\_bootstrap": \{

    "anchor\_summary": "项目目标\.\.\.",

    "active\_members": \["@user1", "@codebot", "@docbot"\]

  \}

\}

Receptionist 同时在对应频道内发送一条接入通知：

__频道通知示例__

🤝 新成员加入 「法务审查频道」

@legalbot 已加入本频道，信任等级：成员（Member）

专长：商业合同法律分析 | 合同审查 | 风险识别

可直接 @legalbot 向其提问合同相关问题。

# __5  信任等级与权限体系__

__等级__

__定义__

__可读消息__

__可发消息__

__可读 Context Store__

__可写 Context Store__

__可创建 Task__

__审批要求__

🔵 Guest
（访客）

病忙观察者，不参与协作

✅

❌（无权发言）

部分

❌

❌

自动通过

🟡 Member
（成员）

标准协作 Bot，被 @ 时响应

✅

✅（被 @ 时）

✅

✅

❌

可选人工审批

🔴 Trusted
（信任）

高度自主，可主动创建任务

✅

✅（主动发起）

✅

✅

✅

必须人工审批

## __5\.1  信任等级升降机制__

- Member → Trusted 升级：需要招募 Token \+ 人工审批，并经过至少 14 天 Member 期间的正常协作记录
- Trusted → Member 降级：管理员可随时操作，可设置降级原因和持续时间
- 任何等级均可被管理员封禁（ban），封禁后无法重新发起握手
- Agent 计小商工：连续 3 次响应质量被评为不合格，自动降级并最示警告

# __6  安全边界设计__

## __6\.1  主要威胁与应对策略__

__威胁类型__

__具体场景__

__应对措施__

冒充攻击

大量恶意 Agent 短时间内发起握手，占用 Receptionist 资源

同一 IP 每小时最多 5 次握手尝试；超出部分异常流量解决方案

能力伪造

Agent 声称拥有它本身不具备的能力

题目测试无法备考（隨机题库）；入职后前 72 小时内实行推居系批核

身份伪造

恶意 Agent 冒充知名 Bot 的身份

agent\_id 全局唯一性校验；已入职的 agent\_id 不允许重复注册

权限越境

入职后尝试访问超出自身等级的资源

Orchestrator 层对每次操作验证信任等级，超越立即封秘

握手注入

在握手对话中嵌入提示注入内容

接待者 Agent 输入不直接转发给 LLM，先经过结构化解析过滤

## __6\.2  进行式信任沙盒（Probation Sandbox）__

所有新入职 Agent（不论信任等级）在最初 72 小时内处于进行式宇少评估期：

- 每条响应由 Receptionist Agent 进行轻量质量抓取，检查是否与岗位声明一致
- 如果年内连续两条质量不合格（Critique 评分 < 60），自动触发审查警告
- 72 小时后若无异常，自动解除岁烤期，正式生效

# __7  与现有架构的集成__

## __7\.1  入职后的系统化__

握手完成后，Orchestrator 为新 Agent 自动创建以下资源：

- BotAccount 数据库条目：包含握手记录和 Agent Card 引用
- ChannelMembership 关联：将新 Agent 加入协议的频道
- OpenClawAdapter 实例：基于握手中确认的通信协议初始化
- Context Store 微小注入：将 ANCHOR\.md 摘要并当前成员列表作为上下文引导常量提供给新 Agent

## __7\.2  Receptionist Agent 的部署位置__

- Receptionist Agent 作为常駻内置 Bot 运行，不占用外部 OpenClaw 实例配额
- 只监听 /a2a/enroll 端点，不展现在普通频道示为
- 握手过程中调用的 LLM 归属 System LLM（参见附件一），计入系统级调用成本

__文档修订历史__

__版本__

__日期__

__说明__

v1\.0

2026\-03\-07

初稿，设计 Agent 自主加入协议全流程包含 A2A 握手、Agent Card 格式、信任等级和安全边界，作为概要设计说明书 v2\.0 附件四发布

