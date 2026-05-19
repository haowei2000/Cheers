# AgentNexus TodoList

> **语言**：中文 | [English](TodoList.md)

- **当前阶段**：里程碑 3（智能调度）已实现 Coordinator 主链路；资源监控看板仍为后续规划。
- **当前 todo**：持续打磨门户阶段一体验；验收见 [功能测试清单](功能测试清单.md)。

---

## 文档阶段

- [x] 整理并写入 `需求汇总.md`、`总体架构设计.md`、`详细设计.md`、`关键技术文档.md`
- [x] 在 `开发计划与里程碑.md` 中固定三阶段交付物、验收标准、TDD 策略，并维护当前阶段/当前 todo 指针
- [x] 创建本 `TodoList.md`

---

## 里程碑 1：核心链路

- [x] **M1-01** 项目骨架：目录结构、依赖（FastAPI/React/Docker/PostgreSQL/Redis）、.env 与 .gitignore、README
- [x] **M1-02** 数据层：PostgreSQL 主库表结构（Workspace/Channel/User/BotAccount/ChannelMembership/Message 等），迁移方式（Alembic）
- [x] **M1-03** ChatCore 频道与成员：REST 接口（列表/创建/成员管理），TDD 先行
- [x] **M1-04** ChatCore 消息：持久化 + REST 拉取历史；WebSocket 连接与广播（可先单机内存）
- [x] **M1-05** @mention 解析与路由：从消息文本提取 @BotName，与频道已激活 Bot 匹配；单测覆盖
- [x] **M1-06** BotAdapter 接口与 Mock 实现：AgentPayload/AgentResponse、execute/health_check；MockAdapter 用于本地测试
- [x] **M1-07** 单 Bot 接入：Orchestrator 调用 Adapter，Payload 构造（含四层记忆占位）与响应回写消息；集成测试一条链路
- [x] **M1-08** Context Store：PostgreSQL + 四层 key 读写 + MD 镜像；MemoryManager 读取接口供 Bot Runtime 注入
- [x] **M1-09** 文件处理管道（基础）：txt/md/docx → MD，FileRecord 与状态（转换中/已就绪/失败）；上传 API 与状态查询 API
- [x] **M1-10** 前端基础版：登录/频道列表/频道内消息列表与发送/WebSocket 收消息/@ 展示与发送
- [x] **M1-11** Docker Compose：后端 + 前端 + PostgreSQL + Redis + RustFS；一键启停可复现验收场景

---

## 里程碑 2：多 Agent 协作

- [x] 多 Bot 同时运行与串行执行
- [x] MemoryManager RECENT 自动压缩（系统 LLM 异步，可选配置）
- [x] 文件类型扩展（pdf/xlsx/图片占位）
- [x] 管理后台 Bot 添加向导
- [x] 前端 Bot 标识与上下文面板
- **附件三**：意图指令（/anchor、/decide 等）与知识确认机制（可选）
- **附件四**：Agent 自主加入协议与 A2A 端点（可选）

---

## 里程碑 3：智能调度

- [x] Coordinator 主控 Bot（`@Coordinator` 聚合频道内其他 Bot 回复）
- [ ] 响应质量监控看板（后续规划）
- ChromaDB 大文件检索（可选，未实现）
- **附件三**：Task 生命周期与确认节点、Critique Loop、自主错误恢复、Task DAG（可选）

## 近期修复事项

- [x] **UX-DEL-001** 补齐用户创建资源的删除路径：文件、消息/话题/公告、头像清理，并明确 Agent Bridge 会话和账号删除策略。详见 [创建/删除对称性修复事项](create-delete-symmetry-fix-item.zh-CN.md)。

---

## 门户阶段一：门户基础（不涉及公共平台）

> 详见《AgentNexus门户与知识平台设计》§七。公共知识平台、公共数据平台、访问申请 API 在阶段二实现。

- [x] **P1-01** Coordinator 作为系统内置 Bot：可加入频道
- [x] **P1-02** Coordinator 触发模式配置：显式 @ 或频道 `auto_assist` 直接回答
- [x] **P1-03** Coordinator 职责明确：使用引导、澄清、业务问答与路由建议
- [x] **P1-04** Bot 层级与 @ 规则：内置 Bot 可 @ Bot/人；外部 Bot 仅可 @ 人
- [x] **P1-05** 自动接手机制：Coordinator 建议后，被建议 Bot 可自动接手（可关闭）
- [x] **P1-06** 自动接手 UI：显示部门 Bot 回复框 +「正在处理...」
- [ ] **P1-07** 所有 Bot 支持澄清：信息不足时可向用户提问（Coordinator 已支持；HTTP Bot 待扩展）
- [ ] **P1-08** 资源监控看板：Bot 任务数、平均耗时、成功率
