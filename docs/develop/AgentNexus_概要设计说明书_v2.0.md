__AgentNexus__

__智枢协作平台__

*概要设计说明书（Preliminary Design Specification）*

__文档版本__

v2\.0

__编写日期__

2026\-03\-07

__文档状态__

草稿（Draft）

__系统英文名__

AgentNexus

__系统中文名__

智枢人机协作平台

__适用范围__

产品研发团队 / 技术决策层

# __1  项目概述__

## __1\.1  系统命名与定位__

本系统命名为 AgentNexus（智枢协作平台）。

"AgentNexus" 取意 "Agent（智能体）" 与 "Nexus（枢纽/连接核心）" 的组合，中文释义 "智枢"：

- 智：人工智能与人类智慧的融合
- 枢：多个智能体与人类共同协作的核心调度中心

AgentNexus 的核心价值主张：让技术能力一般的普通用户，也能像管理一支专业团队一样，通过聊天界面调度多个 AI 专家 Bot，共同完成复杂的项目任务。

## __1\.2  项目背景__

在团队协作领域，Slack、Mattermost 等聊天工具已成为工作枢纽。随着 AI Agent 技术（以 OpenClaw、CrewAI 为代表）的成熟，将多个专业化 AI Agent 无缝引入聊天协作流程，已具备技术可行性。

现有痛点：

- 现有聊天工具的 Bot 接入方式单一，多 Bot 协作缺乏统一调度，Agent 之间无法感知彼此的工作状态
- AI Agent 缺乏项目级持久记忆，每次对话从零开始，无法保持目标和上下文一致性
- 系统配置门槛高，非技术背景的管理员难以独立部署和管理 AI Bot

OpenClaw 是一个开源自主 AI Agent 框架（2025年底发布），能对接 Claude、GPT、DeepSeek 等主流大语言模型，通过消息平台界面执行自主任务。AgentNexus 将 OpenClaw 实例以 Bot 身份接入聊天频道，并在其上构建专属的多 Agent 协作调度层。

## __1\.3  项目目标__

核心目标：

- 提供类 Slack 的聊天体验（频道、@提及、文件共享），底层以 Python 全栈自研，不依赖 Mattermost 二进制包
- 支持 2–15 个专业化 OpenClaw Agent 实例并发运行，每个 Agent 对应特定专业领域
- 支持将多个 Bot 拉入同一协作群（Channel），Bot 与人类成员协同推进项目任务
- 设计四层记忆体系，确保同一项目群内所有 Agent 共享一致的上下文与目标认知
- 面向低计算机能力用户：前端操作极简，管理员后台提供向导式配置

分阶段目标：

- 第一阶段：单 Bot 接入，端到端链路跑通，文件读取可用
- 第二阶段：多 Bot 协作，共享上下文，任务协调机制上线
- 第三阶段：主控 Agent 自动任务调度，Bot 间可结构化通信

## __1\.4  设计原则__

| 原则 | 说明 |
|------|------|
| 参考不依赖 | 参考 Mattermost 的 UX 模式和 API 设计理念，以 Python 从头实现核心功能，不引入 Go 语言依赖 |
| 最小可用子集 | 只实现本系统目标所需的聊天功能（频道、消息、文件、Bot），剔除视频会议、看板、插件市场等无关模块 |
| Agent 优先 | 系统架构围绕多 Agent 协作设计，聊天平台是 Agent 工作的舞台，而非附属功能 |
| 记忆持续 | 所有 Agent 共享同一项目群的结构化记忆，任何 Bot 响应均以项目上下文为前提 |
| 易用第一 | 前端 UI 对标主流聊天 App，管理后台提供向导式引导，核心功能无需阅读文档即可上手 |

# __2  技术选型__

## __2\.1  核心技术决策__

__重要设计决策：为什么不直接基于 Mattermost？__

Mattermost 是 Go 语言编写的完整产品，包含大量与本系统目标无关的企业功能（SAML、合规归档、看板、视频会议等）。

强行在其基础上二次开发，意味着维护一个庞大的 Go 代码库，技术栈碎片化（Go \+ Python），升级时破坏性风险高。

本系统参考 Mattermost 的 UX 设计模式、WebSocket 通信协议格式和 REST API 规范，使用 Python 重新实现精简版聊天核心，

聚焦于频道管理、实时消息、Bot 接入三个核心能力，其余一律不实现。

## __2\.2  技术栈汇总__

| 组件 | 技术选型 | 选型理由 |
|------|----------|----------|
| 聊天后端（自研） | Python \+ FastAPI \+ WebSocket | 与 Agent 框架语言统一，异步性能佳，维护成本低 |
| 前端 UI | React \+ Tailwind CSS | 参考 Mattermost/Slack 交互模式，组件化开发，易于定制 |
| Agent 框架 | OpenClaw（\+ CrewAI 协作理念） | OpenClaw 负责单 Agent 执行，CrewAI 的 Crew/Task 概念指导多 Agent 编排设计 |
| Agent 编排层 | Python AgentOrchestrator（自研） | 参考 CrewAI 的角色/任务/进程模型，管控多 Agent 协作流程 |
| 实时通信 | FastAPI WebSocket | 原生支持，无需额外中间件，足够目标用户规模 |
| 消息队列 | Redis（轻量部署） | Bot 响应异步化，防止 LLM 等待阻塞用户体验 |
| 记忆存储 | PostgreSQL \+ 结构化 MD 文件 | 结构化数据存 PG，上下文文件用 MD，两者配合读写高效 |
| 向量检索（可选） | ChromaDB | 超长文档按需分块检索，初期可不启用 |
| 文件转换 | mammoth \+ pymupdf \+ openpyxl | docx/pdf/xlsx 转 Markdown，开源方案组合效果最佳 |
| 容器编排 | Docker Compose | 一键启停，适合目标用户规模，复杂度最低 |
| 管理后台 | React Admin（自研向导式） | 面向低技术能力管理员，向导式配置流程 |

# __3  系统总体架构__

## __3\.1  架构层次划分__

AgentNexus 分为六个层次，从上至下依次为：

| 层次 | 组件 | 核心职责 |
|------|------|----------|
| ① 用户交互层 | React 前端（Web/移动自适应） | 消息收发、文件上传、Bot 标识展示、Markdown 预览、@提及补全 |
| ② 实时通信层 | FastAPI WebSocket \+ REST API | 消息广播、连接管理、消息持久化、文件上传接口 |
| ③ Agent 编排层 | AgentOrchestrator（自研） | @提及路由、任务分配、多 Bot 协调、进程控制（顺序/并行） |
| ④ 记忆管理层 | MemoryManager（自研） | 四层记忆读写、上下文拼接注入、记忆摘要压缩 |
| ⑤ Agent 执行层 | OpenClaw 实例 × N | 对接 LLM、执行专业任务、返回结构化响应 |
| ⑥ 数据持久层 | PostgreSQL \+ 文件存储 \+ ChromaDB | 消息历史、文件存储、Context Store、向量索引 |

## __3\.2  系统数据流（文字描述）__

__核心消息流转路径__

① 用户在前端发送消息 → WebSocket 推送到服务端

② ChatCore 持久化消息，广播到频道所有在线成员

③ 若消息包含 @BotName，触发 AgentOrchestrator

④ Orchestrator 从 MemoryManager 加载该频道四层上下文

⑤ Orchestrator 构造 Payload（上下文 \+ 当前消息 \+ 附件 MD），发送给对应 OpenClaw 实例

⑥ OpenClaw 调用 LLM 生成响应，返回给 Orchestrator

⑦ Orchestrator 将响应以 Bot 身份通过 WebSocket 广播回频道

⑧ MemoryManager 异步更新 RECENT 摘要，重要决策写入 DECISIONS

## __3\.3  与 Mattermost 的参考关系__

AgentNexus 参考 Mattermost 的以下设计理念，但完全以 Python 自研实现：

| 参考方面 | Mattermost 原设计 | AgentNexus 实现方式 |
|----------|-------------------|----------------------|
| 频道模型 | Team > Channel > Message 三层结构 | 保留 Channel 作为核心协作单元，去掉 Team 层，简化为 Workspace > Channel |
| Bot Account | 独立 Bot 用户账号，有头像和 @mention 名 | 完全保留，每个 OpenClaw 实例对应一个 Bot Account |
| Webhook 机制 | Outgoing/Incoming Webhook | 内化为 Orchestrator 内部调用，不对外暴露 Webhook URL，更安全 |
| WebSocket 实时消息 | Go 原生 WebSocket 实现 | FastAPI \+ websockets 库重新实现，接口格式参考 Mattermost |
| REST API 格式 | Mattermost REST API v4 | 参考其 URL 结构和响应格式，自行实现核心子集 |
| 权限系统 | Team/Channel/Role 细粒度权限 | 简化为 Admin/Member/BotManager 三角色，足够目标用户规模 |

# __4  核心模块设计__

## __4\.1  聊天核心（ChatCore）__

ChatCore 是 AgentNexus 的聊天基础设施，以 Python \+ FastAPI 实现，仅包含本系统所需的最小功能集。

### __4\.1\.1  功能范围__

| 功能模块 | 说明 | 是否实现 |
|----------|------|----------|
| 频道（Channel） | 创建/管理协作群，支持公开和私有频道 | ✅ 实现 |
| 实时消息 | WebSocket 广播，支持 Markdown 渲染 | ✅ 实现 |
| @提及（Mention） | @用户 和 @Bot 自动补全与通知 | ✅ 实现 |
| 文件上传与预览 | 上传文件，前端预览 MD 转换结果 | ✅ 实现 |
| Bot Account 管理 | Bot 用户注册、头像、在线状态 | ✅ 实现 |
| 消息历史加载 | 滚动加载历史消息，翻页不卡顿 | ✅ 实现 |
| 消息搜索 | 全文搜索频道消息和文件内容 | ✅ 实现（基础版） |
| 视频/音频通话 | 超出目标范围 | ❌ 不实现 |
| 看板/任务管理 | 超出目标范围 | ❌ 不实现 |
| 插件/应用市场 | 超出目标范围 | ❌ 不实现 |
| 企业级合规归档 | 超出目标范围 | ❌ 不实现 |

## __4\.2  Agent 编排框架（AgentOrchestrator）__

AgentOrchestrator 是 AgentNexus 最核心的自研组件，深度参考 CrewAI 的 Crew/Role/Task/Process 概念，并结合本系统的聊天场景定制设计。

### __4\.2\.1  核心概念模型__

| 概念 | 对应 CrewAI 概念 | 在 AgentNexus 中的含义 |
|------|-------------------|--------------------------|
| Crew（协作组） | Crew | 一个 Channel 内被激活的所有 Bot 集合，共同服务于该频道的项目目标 |
| Agent（智能体） | Agent | 每个 OpenClaw 实例，具备角色（Role）、目标（Goal）、背景（Backstory） |
| Task（任务） | Task | 用户的一次 @提及触发，包含输入消息、期望输出格式、上下文 |
| Process（执行模式） | Process | Sequential（顺序）或 Parallel（并行），控制多 Bot 同时被@时的响应方式 |
| Coordinator（协调者） | Manager Agent | 可选的主控 Bot，负责任务拆解和结果汇总（第三阶段功能） |

### __4\.2\.2  消息路由逻辑__

第一阶段：显式 @mention 模式（最安全，调试友好）

def route\_message\(message\):

    mentioned\_bots = extract\_mentions\(message\.text\)  \# 解析 @BotName

    if not mentioned\_bots: return  \# 无@mention，静默忽略

    active\_bots = channel\_crew\[message\.channel\_id\]  \# 本频道已激活的 Bot

    targets = \[b for b in mentioned\_bots if b in active\_bots\]

    context = memory\_manager\.load\(message\.channel\_id\)  \# 加载四层记忆

    files\_md = file\_converter\.load\(message\.file\_ids\)  \# 加载附件MD

    if len\(targets\) == 1 or process\_mode == 'parallel':

        for bot in targets:  \# 并行执行

            asyncio\.create\_task\(execute\_agent\(bot, message, context, files\_md\)\)

    else:  \# 顺序执行（默认，避免消息乱序）

        for bot in targets:

            await execute\_agent\(bot, message, context, files\_md\)

第三阶段：Coordinator 自动调度模式（高级功能）

- 用户只需 @coordinator，主控 Bot 自动分析任务，决定调用哪些专业 Bot
- 主控 Bot 收集各专业 Bot 的输出，进行汇总或二次加工后统一回复
- 主控 Bot 在 Context Store 中记录任务分工和各 Bot 贡献，供后续追溯

### __4\.2\.3  Bot 角色配置（SOUL\.md）__

每个 OpenClaw 实例通过 SOUL\.md 文件定义其专业角色，AgentNexus 在注册 Bot 时读取此配置：

__Bot 示例名__

__角色（Role）__

__专长领域__

__适配 LLM__

@codebot

资深代码审查工程师

代码质量、架构分析、Bug 检测、PR 审查

Claude Sonnet

@docbot

技术文档专家

信息提炼、文档写作、格式规范、Markdown 输出

Claude Haiku

@databot

数据分析师

数据解读、图表建议、Excel/CSV 分析、报告生成

GPT\-4o

@planbot

项目规划顾问

任务分解、优先级排序、风险识别、里程碑规划

Claude Sonnet

@searchbot

知识检索专家

RAG 检索、知识库问答、信息聚合

DeepSeek

@coordinator

任务协调主控（第三阶段）

任务分析、Bot 调度、结果汇总

Claude Opus

## __4\.3  四层记忆体系（MemoryManager）__

这是 AgentNexus 保障"多 Agent 上下文一致性与目标对齐"的核心设计。参考认知心理学的记忆分层模型，为每个协作频道建立四层独立的记忆结构。

__设计核心思想__

每次 OpenClaw 实例被调用前，MemoryManager 自动将四层记忆拼接为 System Prompt 前缀注入。

这意味着：即使不同 Bot 实例之间完全无直接通信，它们也能通过共享的 Context Store 获得一致的项目视角。

这是整个多 Agent 协作方案的"认知黏合剂"。

__记忆层__

__文件/存储__

__内容__

__更新方式__

__大小上限__

第一层：项目锚点
（长期记忆）

ANCHOR\.md

项目/频道的核心目标、关键约定、团队成员职责、重要限制条件

管理员手动维护，或触发 Bot 生成摘要

约 1500 字

第二层：决策记录
（情景记忆）

DECISIONS\.md

重要决策记录（含时间戳、决策人、依据、结论）

Bot 自动追加重要结论，人工可编辑修正

约 3000 字

第三层：资料索引
（外部记忆）

FILES\_INDEX\.md

已上传文件的摘要索引（文件名 \+ 核心内容 3 句话 \+ 上传人）

文件处理管道完成后自动写入

无硬上限

第四层：近期动态
（工作记忆）

RECENT\.md（滚动）

最近 50 条消息的压缩摘要，保留关键信息密度

每次 Bot 交互后，由轻量 LLM 自动压缩更新

固定约 1500 字

### __4\.3\.1  上下文注入格式__

system\_prompt = f"""

你是 \{bot\.role\}，正在参与频道「\{channel\.name\}」的协作工作。

== 项目锚点（最高优先级，务必遵守）==

\{ANCHOR\.md 内容\}

== 重要决策记录 ==

\{DECISIONS\.md 内容\}

== 已上传资料索引 ==

\{FILES\_INDEX\.md 内容\}

== 近期频道动态 ==

\{RECENT\.md 内容\}

"""

### __4\.3\.2  目标对齐机制__

为防止多次对话后 Bot 偏离项目目标，设计以下对齐机制：

- ANCHOR\.md 在 System Prompt 中置于最高优先级位置，并加注强调说明
- 每次 Bot 响应后，由 MemoryManager 对比响应内容与 ANCHOR\.md 的目标一致性，若偏差过大则发出警告
- 管理员可在任意时间更新 ANCHOR\.md，更新后的内容在下一次 Bot 调用时立即生效
- DECISIONS\.md 自动追加时，MemoryManager 会检查新决策是否与已有记录冲突，若冲突则生成冲突提示

## __4\.4  文件处理管道（FileProcessor）__

__文件格式__

__处理工具__

__特殊说明__

\.txt / \.md

直接使用

无需转换，直接读取

\.docx

mammoth 库

保留标题、列表、表格结构，转换质量最佳

\.pdf

pymupdf（fitz）

提取文字和表格；图片页调用 Vision API 生成描述

\.xlsx / \.csv

openpyxl / pandas

转为 Markdown 表格；超大表格自动截取关键摘要

\.png / \.jpg

Claude Vision / GPT\-4o Vision

生成图片内容文字描述，存为 Markdown

\.mp4（视频）

ffmpeg 抽帧 \+ Vision

按时间间隔抽帧，生成时间线描述 Markdown

超长文档（>3万字）

LlamaIndex / 手写分块

分块向量化存入 ChromaDB，响应前检索相关块

# __5  易用性设计__

本章专门针对"使用者计算机能力不高"的设计约束，分别从前端用户体验和管理员后台两个维度展开设计。

## __5\.1  前端用户体验设计__

### __5\.1\.1  核心交互原则__

- 零学习成本：界面风格对标微信群 / Slack，熟悉聊天软件的用户无需培训即可上手
- @提及引导：输入 @ 符号时自动弹出 Bot 列表，展示每个 Bot 的专长描述，让用户知道该@谁
- Bot 状态可见：Bot 在线/离线/处理中状态实时展示，处理中显示打字动画，让用户知道 AI 在工作
- 响应结果清晰：Bot 回复附带角色标签和专长说明，区分不同 Bot 的回复，避免混淆
- 文件上传反馈：文件上传后显示处理进度（转换中 → 已就绪），明确告知 Bot 何时可读取

### __5\.1\.2  关键 UI 组件__

__UI 组件__

__功能说明__

__易用性考虑__

Bot 选择浮窗

输入@后弹出，展示 Bot 头像、名称、专长标签、当前状态

直观展示每个 Bot 能做什么，避免用户盲目@

上下文摘要面板

频道右侧栏展示当前 ANCHOR\.md 和 DECISIONS\.md 摘要

让用户随时了解 AI 记住了哪些信息，增加信任感

任务进度气泡

Bot 接到任务后显示"正在处理\.\.\."气泡，完成后消失

降低等待焦虑，用户明确知道系统在响应

文件预览内联

上传的 MD/PDF/docx 可内联预览，无需下载

减少操作步骤，流畅体验

一键拉入 Bot

频道成员列表中点击 Bot 即可将其加入当前频道

取代复杂的配置步骤

记忆编辑入口

频道设置页提供 ANCHOR\.md 的富文本编辑入口

非技术用户可直接修改项目目标，无需接触文件系统

## __5\.2  管理员后台设计__

管理员后台遵循"向导优先"原则：所有复杂配置操作均提供步骤引导，不让用户面对空白表单或命令行。

### __5\.2\.1  Bot 添加向导（5步完成）__

1. 选择 Bot 类型：从预置模板列表中选择（代码审查 / 文档整理 / 数据分析 / 自定义）
2. 配置 LLM：下拉选择 Claude / GPT / DeepSeek，粘贴 API Key（有眼睛图标可显示/隐藏），系统自动验证连通性
3. 设置角色描述：基于模板预填 SOUL\.md，用户可在文本框中直接修改，无需了解文件格式
4. 测试对话：内置对话测试框，发送测试消息验证 Bot 是否正常响应
5. 分配到频道：多选框选择哪些频道激活此 Bot，点击完成

### __5\.2\.2  系统状态监控（无需专业知识）__

- 首页仪表盘：所有 Bot 在线状态一览，绿色=正常、橙色=高负载、红色=离线，点击查看详情
- 今日统计卡片：每个 Bot 今日响应次数、平均响应时间、用户满意度（👍/👎 反馈统计）
- 错误日志友好展示：技术错误信息转换为人类可读文字（如"codebot 在处理消息时出错，建议检查 API Key 是否有效"）
- 一键重启：Bot 出现异常时，管理员可在界面上直接点击重启，无需操作命令行

### __5\.2\.3  频道上下文管理__

- ANCHOR\.md 图形化编辑：富文本编辑器，支持标题/列表/粗体，保存后自动转为 Markdown
- DECISIONS\.md 可视化：时间线视图展示所有决策记录，支持搜索和手动添加
- FILES\_INDEX\.md 预览：列表展示所有已上传文件及其摘要，支持删除和重新处理
- "重置记忆"功能：管理员可清除 RECENT\.md 或全部重置，适用于项目阶段切换

# __6  数据模型设计__

## __6\.1  核心数据实体__

| 实体 | 关键字段 | 说明 |
|------|----------|------|
| Workspace（工作区） | workspace\_id, name, created\_at | 顶层组织单元，简化自 Mattermost 的 Team |
| Channel（频道/协作群） | channel\_id, workspace\_id, name, type\(public/private\), purpose | 核心协作单元，对应一个项目或话题 |
| User（用户） | user\_id, username, display\_name, role\(admin/member/botmanager\), avatar\_url | 人类用户账户 |
| BotAccount（Bot账户） | bot\_id, username, display\_name, specialty\_label, soul\_config\_path, openclaw\_endpoint, status | 每个 OpenClaw 实例对应一条记录 |
| ChannelMembership | channel\_id, member\_id, member\_type\(user/bot\), joined\_at, added\_by | 频道成员关系，统一管理人和 Bot |
| Message（消息） | msg\_id, channel\_id, sender\_id, sender\_type, content, file\_ids\[\], mention\_bot\_ids\[\], created\_at | 所有消息统一存储 |
| ContextStore（记忆存储） | channel\_id, layer\(ANCHOR/DECISIONS/FILES\_INDEX/RECENT\), content, updated\_at, updated\_by | 四层记忆的数据库缓存 |
| FileRecord（文件记录） | file\_id, channel\_id, uploader\_id, original\_path, md\_path, status, summary\_3lines, converted\_at | 文件处理状态追踪 |
| AgentTask（任务日志） | task\_id, channel\_id, bot\_id, trigger\_msg\_id, response\_msg\_id, latency\_ms, token\_count, feedback | Bot 响应质量监控原始数据 |

## __6\.2  文件存储结构__

data/

├── uploads/                    \# 原始上传文件

│   └── \{channel\_id\}/\{file\_id\}\.\{ext\}

├── converted/                  \# 转换后 MD 文件

│   └── \{channel\_id\}/\{file\_id\}\.md

├── context\_store/              \# 四层记忆 MD 文件

│   └── \{channel\_id\}/

│       ├── ANCHOR\.md           \# 第一层：项目锚点

│       ├── DECISIONS\.md        \# 第二层：决策记录

│       ├── FILES\_INDEX\.md      \# 第三层：资料索引

│       └── RECENT\.md           \# 第四层：近期动态

├── bot\_configs/                \# Bot SOUL\.md 配置文件

│   └── \{bot\_id\}/SOUL\.md

└── vector\_index/               \# ChromaDB（大文件，可选）

    └── \{channel\_id\}/

# __7  关键接口设计__

## __7\.1  REST API 核心接口__

| 接口路径 | 方法 | 描述 |
|----------|------|------|
| /api/channels | GET / POST | 获取/创建频道列表 |
| /api/channels/\{id\}/messages | GET / POST | 获取消息历史 / 发送消息 |
| /api/channels/\{id\}/members | GET / POST / DELETE | 查询/添加/移除频道成员（含 Bot） |
| /api/channels/\{id\}/context | GET / PUT | 读取/更新频道四层 Context Store |
| /api/bots | GET / POST | 查询/注册 OpenClaw Bot 实例 |
| /api/bots/\{bot\_id\}/status | GET | 查询 Bot 实例运行状态 |
| /api/bots/\{bot\_id\}/test | POST | 发送测试消息验证 Bot 配置 |
| /api/files/upload | POST | 上传文件，触发转换管道 |
| /api/files/\{file\_id\}/status | GET | 查询文件转换状态 |
| /ws/channels/\{id\} | WebSocket | 实时消息双向推送 |

## __7\.2  AgentOrchestrator 内部调用 Payload__

\{

  "task\_id": "uuid",

  "channel\_id": "ch\_abc123",

  "trigger\_message": \{

    "user": "张三", "text": "@codebot 帮我审查这段代码",

    "timestamp": "2026\-03\-07T10:30:00Z"

  \},

  "memory\_context": \{

    "anchor": "（ANCHOR\.md 内容）",

    "decisions": "（DECISIONS\.md 内容）",

    "files\_index": "（FILES\_INDEX\.md 内容）",

    "recent": "（RECENT\.md 内容）"

  \},

  "attachments": \[

    \{ "filename": "main\.py", "md\_content": "（转换后 MD 内容）" \}

  \],

  "process\_config": \{ "mode": "sequential", "timeout\_seconds": 120 \}

\}

# __8  开发阶段规划__

## __8\.1  三阶段路线图__

| 阶段 | 时间 | 核心交付物 | 验收标准 |
|------|------|------------|----------|
| 第一阶段（核心链路） | 5–7 周 | Python ChatCore（频道\+WebSocket）；单 OpenClaw Bot 接入；基础文件转 MD（txt/md/docx）；@mention 路由；四层记忆结构建立（手动维护）；React 前端基础版；Docker Compose 一键部署 | 用户在频道 @bot 能正确回复；上传 docx 后 Bot 能读取内容；前端可正常登录、发消息、看历史 |
| 第二阶段（多 Agent 协作） | 5–7 周 | 3–5 个专业化 Bot 同时运行；MemoryManager 自动摘要更新；文件类型扩展（pdf/xlsx/图片）；前端 Bot 标识 UI 优化；管理员后台 Bot 添加向导；上下文面板 UI | 同一频道 3 个 Bot 可分别被 @ 调用，且都感知项目上下文；管理员通过向导无需命令行配置新 Bot |
| 第三阶段（智能调度） | 持续迭代 | Coordinator 主控 Bot；Bot 间结构化通信协议；自动任务分解与分发；响应质量监控看板；ChromaDB 大文件检索 | 用户只 @coordinator，主控 Bot 自动分配任务给专业 Bot 并汇总结果 |

## __8\.2  技术风险与应对__

| 风险 | 等级 | 应对策略 |
|------|------|----------|
| 多 Bot 同时响应导致消息乱序 | 高 | 第一阶段严格默认串行（Sequential）模式，并行模式作为高级选项由管理员开启 |
| Agent 上下文“失忆”（每次调用独立） | 高 | Orchestrator 每次调用前强制注入四层 Context Store，上下文持久化不依赖 Agent 本身 |
| RECENT\.md 压缩质量差导致信息丢失 | 高 | 使用专属的轻量 LLM 做摘要，保留关键决策和@提及；同时保留最后 20 条原始消息作为补充 |
| OpenClaw API 版本升级破坏兼容性 | 中 | 建立 OpenClawAdapter 接口隔离层，版本升级时只改 Adapter，Orchestrator 不受影响 |
| 大文件超出 LLM context window | 中 | 超过 3 万字自动启用 ChromaDB 分块检索，第一阶段可先设定文件大小上限提示用户 |
| 管理员配置错误导致 Bot 不响应 | 中 | 管理后台每步配置实时验证，Bot 注册完成后强制经过测试对话才能激活 |
| Python ChatCore WebSocket 并发性能不足 | 低 | 目标用户 ≤100 并发，FastAPI \+ uvicorn 完全可支撑；如超出则引入 Redis Pub/Sub 扩展 |

# __9  非功能性需求__

## __9\.1  性能指标__

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 日常并发用户 | ≤ 100 人 | 常态设计基准 |
| 峰值用户支持 | ≤ 1000 人 | 系统扩展上限 |
| 消息推送延迟（人类消息） | < 200ms | WebSocket 实时消息 |
| Bot 响应启动延迟 | < 500ms | 从收到消息到 OpenClaw 开始处理 |
| Bot 首字响应（流式） | < 3s | 取决于 LLM 服务，系统层延迟 < 500ms |
| 文件转 MD（< 10MB） | < 30s | 异步处理，完成后通知用户，不阻塞聊天 |
| Context Store 加载时间 | < 100ms | 四层 MD 文件读取 \+ 拼接 |
| 管理后台页面加载 | < 1s | React SPA，关键页面 |

## __9\.2  安全要求__

- OpenClaw 实例运行于 Docker 容器，与 ChatCore 服务网络隔离，仅通过 Orchestrator 内部调用
- LLM API Key 存储于服务器环境变量或 Docker Secret，禁止写入代码仓库和日志
- 用户上传文件进行类型白名单校验（拒绝可执行文件）和 ClamAV 病毒扫描
- Context Store 不存储用户认证凭据等敏感信息
- 管理员后台与用户聊天界面分离部署，访问端口不同，建议加访问 IP 白名单
- 所有 HTTP 接口默认启用 HTTPS，WebSocket 使用 WSS

## __9\.3  可运维性（面向低技术能力管理员）__

- 全部服务通过 Docker Compose 编排，提供 start\.sh / stop\.sh / restart\.sh 一键脚本
- 管理后台系统状态页展示所有服务健康状态，异常时用中文描述错误原因和建议操作
- 提供图形化日志查看器，支持按 Bot 筛选和时间范围过滤，无需操作命令行
- 数据库备份脚本开箱即用，支持一键导出整个 data/ 目录

# __10  部署方案__

## __10\.1  Docker Compose 服务拓扑__

services:

  chat\-core:       \# Python FastAPI 聊天核心

  frontend:        \# React 前端（Nginx 静态服务）

  admin\-panel:     \# 管理后台（React \+ FastAPI）

  orchestrator:    \# AgentOrchestrator 编排层

  memory\-manager:  \# MemoryManager 记忆管理层

  file\-processor:  \# 文件转换服务

  postgres:        \# 主数据库

  redis:           \# 消息队列

  openclaw\-code:   \# OpenClaw 代码专业实例

  openclaw\-doc:    \# OpenClaw 文档专业实例

  openclaw\-data:   \# OpenClaw 数据分析实例

  \# \.\.\. 按需扩展更多 OpenClaw 实例

  chromadb:        \# 向量数据库（可选）

networks:

  public:   \# frontend, admin\-panel, chat\-core（对外）

  internal: \# orchestrator ↔ openclaw 实例（内部隔离）

  data:     \# chat\-core ↔ postgres, redis（数据层）

## __10\.2  最小化首次部署步骤（面向低技术能力管理员）__

1. 安装 Docker Desktop（提供官方一键安装包链接）
2. 下载 AgentNexus 安装包，解压到任意目录
3. 双击 start\.sh（Mac/Linux）或 start\.bat（Windows）
4. 浏览器打开 http://localhost:3000，完成管理员账号注册
5. 进入管理后台，按 Bot 添加向导配置第一个 OpenClaw Bot
6. 创建第一个频道，将 Bot 拉入，开始使用

# __11  待决策事项与后续工作__

## __11\.1  需进一步决策的问题__

| 编号 | 问题 | 影响范围 | 当前建议 |
|------|------|----------|----------|
| D\-01 | Bot 响应是否支持流式输出（Streaming）？ | 用户体验、前端改造 | 第一阶段先做非流式，验证链路后升级。流式需 WebSocket 分片协议 |
| D\-02 | Context Store 是否迁移到数据库替代 MD 文件？ | 性能、可靠性、并发写入 | 初期 MD 文件 \+ 数据库缓存，并发高时迁移到 PostgreSQL 存储 |
| D\-03 | 多 Bot 同时被@时默认串行还是并行？ | 响应时间、消息排序 | 建议默认串行，避免消息乱序；管理员可按频道配置为并行 |
| D\-04 | Bot 响应内容是否需要人工审核流程？ | 内容安全、工作流设计 | 面向对外输出场景可加审核队列；内部协作场景可关闭 |
| D\-05 | RECENT\.md 压缩使用哪个 LLM？ | 成本、质量 | 建议使用最廉价的模型（如 Claude Haiku / GPT\-4o\-mini）降低成本 |
| D\-06 | 是否支持移动端原生 App？ | 用户覆盖范围、开发成本 | 初期专注 Web 自适应，稳定后考虑 React Native 复用代码 |

## __11\.2  本文档下一步完善计划__

1. 完成详细设计说明书（各模块内部设计、数据库 DDL、API 接口详细规范）
2. 完成前端 UI 原型设计（聊天界面、Bot 选择浮窗、上下文面板、管理向导）
3. 完成第一阶段技术验证（PoC）：Python ChatCore \+ 单 OpenClaw 实例端到端链路
4. 根据 PoC 结果修订本文档中的架构假设，特别是 WebSocket 性能和记忆注入延迟
5. 编制面向最终用户的《5分钟快速上手指南》和《管理员配置手册》

# __12  当前实现对齐（2026-03）__

为保证本概要设计与仓库当前代码一致，补充如下对齐说明：

- 内置 Bot 体系已收敛为统一 `channel bot`（`bot-guide-001`），不再以 `@coordinator` 作为用户主入口。
- Bot 执行默认主链路为 `LLMBotAdapter`（模型 + 模板）；OpenClaw HTTP/WS Adapter 保留为可选接入能力。
- 频道模型新增 `auto_assist`，支持频道级自动接管与协作触发。
- 消息链路新增 SSE 流式接口（`/api/channels/{channel_id}/messages/stream`）。
- 文件上传主路径升级为预签名上传（`/api/files/presign`），legacy 上传接口继续兼容。
- 存储架构新增抽象层（`StorageProvider`）与 S3 兼容实现，支持对象存储落盘。
- 新增工作空间成员体系（workspace memberships）与好友关系 API。
- 新增图片生成能力（文生图/图生图）与 MCP 配置导入能力。
- 公共知识/数据平台访问申请 API 与 A2A 自主加入协议目前仍属于设计阶段能力，未作为默认生产路径实现。

__文档修订历史__

| 版本 | 日期 | 说明 | 作者 |
|------|------|------|------|
| v1\.0 | 2026\-03\-07 | 初稿，基于多轮需求讨论形成 | — |
| v2\.0 | 2026\-03\-07 | 系统命名为 AgentNexus；改为 Python 自研 ChatCore；深化多 Agent 协作框架；增加四层记忆体系；增加易用性设计章节 | Claude |
| v2\.1 | 2026\-03\-16 | 根据代码实现完成对齐修订：内置 Bot 统一为 channel bot；主链路默认 LLM Bot；补充 SSE、对象存储、workspace membership、image\_gen、MCP 导入与频道级 auto\_assist；明确公共平台与 A2A 仍属后续阶段。 | 维护更新 |

