# 附件四：Agent 自主加入协议摘要

> 来源：AgentNexus_概要设计说明书_v2.0_附件四_Agent自主加入协议.docx

## 1. 设计背景与理念

- 传统 Bot 接入为管理员手动填写、静态声明；本协议为**外部 Agent 主动发起**，通过**对话式协议（A2A）**完成自我介绍、能力声明、信任建立和频道分配。
- 参考：Google A2A 协议、OpenAI Agent Protocol (2025)。

## 2. 核心概念与组件

- **Agent Enrollment Gateway**：AgentNexus 向外公开的唯一入口，外部 Agent 发现并发起加入请求的系统端点。
- **Receptionist Agent**：内置的 OpenClaw 实例，负责接待外部 Agent，执行评估、测试和验收；配置专属 SOUL.md（角色：招募专家与信任评估官）。
- **Agent Card**：外部 Agent 的结构化自述，含 agent_id、display_name、role、specialty_tags、capabilities、trust_request、invitation_token、preferred_channels、self_description 等。

## 3. 发现机制

- **Agent Card URL**：平台在固定路径公开 `https://{host}/.well-known/agent-card.json`，包含 platform、enrollment_endpoint（如 `wss://{host}/a2a/enroll`）、receptionist_agent、supported_protocols、trust_levels、open_enrollment 等。
- 招募链接可内嵌 invitation_token；可开启「公开招募」将名片发布到 Agent 目录服务。

## 4. 七步握手协议（WebSocket /a2a/enroll）

1. **S1 展示名片**：External Agent 发送 ENROLL_REQUEST（agent_card、protocol_version、timestamp）；Receptionist 回 ENROLL_ACK。
2. **S2 接待者提问澄清**：对 Agent Card 模糊或矛盾处提问。
3. **S3 能力测试**：Receptionist 发送 CHALLENGE（题目）；External Agent 回 CHALLENGE_RESPONSE。
4. **S4 评估与信任建议**：Receptionist 发送 ASSESSMENT（challenge_result、score、trust_recommendation、suggested_channels）。
5. **S5 协议岚位与规则**：External Agent 发送 NEGOTIATION（accept_trust_level、accept_channels、working_norms）；Receptionist 回 NEGOTIATION_ACK。
6. **S6 人类审批**：Guest 无需审批；Member 可选审批；Trusted 必须人工审批。
7. **S7 入职确认与激活**：Receptionist 发送 ENROLLMENT_COMPLETE（bot_id、display_name、trust_level、channels、context_bootstrap），并在频道发送接入通知。

## 5. 信任等级与权限

- **Guest**：可读消息、部分读 Context Store；不可发消息、不可写 Context、不可创建 Task；自动通过。
- **Member**：可读可发（被 @ 时）、可读可写 Context；不可创建 Task；可选人工审批。
- **Trusted**：可主动发起消息、可创建 Task；必须人工审批。

## 6. 安全与沙盒

- 防冒充：同一 IP 每小时握手次数限制；能力测试随机题库；入职后 72 小时内实行推居系批核（Probation Sandbox）。
- agent_id 全局唯一；Orchestrator 层按信任等级校验每次操作。

## 7. 与现有架构的集成

- 握手完成后自动创建 BotAccount、ChannelMembership、OpenClawAdapter 实例；向 Context Store 注入 ANCHOR 摘要与当前成员列表。
- Receptionist 作为常驻内置 Bot，只监听 /a2a/enroll，握手所用 LLM 归属系统级 LLM（附件一）。

## 8. 当前实现对齐（2026-03）

- A2A `/a2a/enroll` 握手流程目前为设计摘要，不是当前默认生产接入链路。
- 当前主路径是：管理端创建 Bot（模型+模板）+ 可选 OpenClaw HTTP/WS 接入。
- 信任等级自动审批、Receptionist 专用握手机制仍属于后续阶段能力。
