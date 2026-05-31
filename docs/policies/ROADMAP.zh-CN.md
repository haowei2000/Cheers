# AgentNexus Roadmap

> **语言**：中文 | [English](ROADMAP.md)

本文档描述 AgentNexus 的里程碑规划与当前进度。详细任务拆解见 [docs/INDEX.zh-CN.md](INDEX.zh-CN.md) 的历史任务记录，完整设计背景可参考 [docs/arch/ARCHITECTURE_OVERVIEW.md](arch/ARCHITECTURE_OVERVIEW.md)。

---

## 里程碑 1：核心链路（已完成）

**目标**：跑通「用户 @bot → Bot 回复」完整链路。

- [x] Python ChatCore（频道 + WebSocket 实时推送）
- [x] 单 Bot 接入（HTTP Bot / Agent Bridge 隔离层）
- [x] 基础文件上传与内容抽取（txt / md / docx 等）
- [x] @mention 解析与路由
- [x] 四层记忆结构建立（anchor / decisions / files_index / recent）
- [x] React 前端基础版（登录、发消息、历史、WebSocket）
- [x] Docker Compose 一键部署

**验收标准**：频道内 @bot 能正确回复；上传 docx 后 Bot 能读取内容；前端可登录、发消息、看历史。

---

## 里程碑 2：多 Agent 协作（已完成）

**目标**：同一频道多 Bot 协同工作，管理员无需命令行即可配置 Bot。

- [x] 3–5 个专业化 Bot 同时运行（串行执行）
- [x] MemoryManager RECENT 层自动压缩（系统 LLM 异步）
- [x] 文件类型扩展（pdf / xlsx / 图片等按能力处理）
- [x] 管理后台 Bot 添加向导（AIModel + PromptTemplate + BotAccount）
- [x] 前端 Bot 标识与上下文面板

**验收标准**：同一频道多 Bot 可分别被 @ 且共享项目上下文；管理员通过向导完成新 Bot 配置，无需命令行。

---

## 里程碑 3：智能调度（已完成）

**目标**：引入 Coordinator 主控 Bot，实现任务自动分配与结果汇总。

- [x] Coordinator Bot（`@Coordinator` 聚合频道内其他 Bot 回复）
- [x] 频道 auto_assist 直接回答模式与自动 Bot 建议
- [ ] 响应质量监控看板（任务数、平均耗时、成功率）
- [ ] ChromaDB 大文件向量检索（规划中，未实现）

**验收标准**：用户仅 `@Coordinator` 即可由主控 Bot 分配任务并汇总结果。

---

## 门户阶段一：门户基础（进行中）

**目标**：完善平台智能调度体验，不涉及公共平台。

- [x] Coordinator 作为系统内置 Bot，可加入频道
- [x] Coordinator 触发模式配置（必须 @ / 直接回答）
- [x] Coordinator 职责明确（使用引导、澄清、业务问答与路由建议）
- [x] Bot 层级与 @ 规则（内置 Bot 可 @ Bot/人）
- [x] 自动接手机制（Coordinator 建议后被建议 Bot 自动接手）
- [x] 自动接手 UI（显示「正在处理...」）
- [ ] 资源监控看板（队列、耗时、成功率）
- [ ] 用户权限管理
- [ ] 缓存优化
- [ ] 多媒体输入与响应

---

## 门户阶段二：公共平台（规划中）

**目标**：开放公共知识与数据平台，支持跨团队访问申请。

- [ ] 公共知识平台（跨频道/工作空间只读知识库）
- [ ] 公共数据平台（结构化数据集接入）
- [ ] 访问申请 API（待审批与审核流程）
- [ ] Coordinator 知识扩展（能回答公共平台相关问题）

详情可参考 [文档索引](INDEX.zh-CN.md) 中的历史规范说明（已归档，不再作为日常入口）。

---

## 门户阶段三：能力发现与编排增强（规划中）

**目标**：Bot 能主动声明能力，Coordinator 动态学习并编排。

- [ ] Bot 能力描述（skills / MCP 拉取）
- [ ] Agent 自主加入协议（A2A 握手、Agent Card、Receptionist Agent）
- [ ] 资源监控增强（Task DAG 可视化、风险分级）

可参考 [文档索引](INDEX.zh-CN.md) 中的历史协议设计说明（已归档，不再作为当前实施依据）。

---

## 近期计划(资源占用考虑/安全性问题/关键断点->行动建议->工作量)

### UI

- [ ] UI hover 状态统一
- [ ] 中英文遗漏修复
- [ ] 默认选项优化

### 后端

- [ ] 代码整理
- [ ] 消息队列职责与流程更明晰
- [ ] 远程 Bot 工作区隔离规划：明确每个 Bot 的独立工作目录、权限边界、清理策略与部署/运行时防护
- [ ] 默认opencode的权限限制

### Feature

- [ ] 钉钉集成
- [ ] iOS App
- [ ] Android App

---

## 长期方向

- [ ] **Human-in-the-loop**：Task 生命周期确认节点、Critique Loop、自主错误恢复
- [ ] **多租户 / 权限体系**：工作空间隔离、成员角色细化、Auth 完整集成
- [ ] **数据库可靠性**：PostgreSQL 备份/恢复演练、迁移回滚预案与大库维护手册
- [ ] **知识库**: 知识库语义搜索、Grep等搜索方式内置支持
- [ ] **Threads API**: 线程级对话，频道内频繁记录合为threads，保证记忆隔离
