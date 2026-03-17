# AgentNexus Roadmap

本文档描述 AgentNexus 的里程碑规划与当前进度。详细任务拆解见 [docs/TodoList.md](docs/TodoList.md)，完整设计依据见 [docs/开发计划与里程碑.md](docs/开发计划与里程碑.md)。

---

## 里程碑 1：核心链路（已完成）

**目标**：跑通「用户 @bot → Bot 回复」完整链路。

- [x] Python ChatCore（频道 + WebSocket 实时推送）
- [x] 单 OpenClaw Bot 接入（OpenClawAdapter 隔离层）
- [ ] 基础文件转 Markdown（txt / md / docx）
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
- [ ] 文件类型扩展（pdf / xlsx / 图片占位）
- [x] 管理后台 Bot 添加向导（AIModel + PromptTemplate + BotAccount）
- [x] 前端 Bot 标识与上下文面板

**验收标准**：同一频道多 Bot 可分别被 @ 且共享项目上下文；管理员通过向导完成新 Bot 配置，无需命令行。

---

## 里程碑 3：智能调度（已完成）

**目标**：引入 Coordinator 主控 Bot，实现任务自动分配与结果汇总。

- [x] Coordinator Bot（@coordinator 聚合频道内其他 Bot 回复）
- [x] Orchestrator 直接回答模式与自动 Bot 建议（`orchestrator_direct_answer` / `orchestrator_auto_takeover`）
- [ ] 响应质量监控看板（`/api/tasks/stats`，任务数、平均耗时、成功率）
- [ ] ChromaDB 大文件向量检索（规划中，未实现）

**验收标准**：用户仅 @coordinator 即可由主控 Bot 分配任务并汇总结果。

---

## 门户阶段一：门户基础（进行中）

**目标**：完善平台智能调度体验，不涉及公共平台。

- [x] Orchestrator 作为系统内置 Bot，可加入频道
- [x] Orchestrator 触发模式配置（必须 @ / 直接回答）
- [x] 引导 Bot 职责明确（仅回答系统使用问题）
- [x] Bot 层级与 @ 规则（内置 Bot 可 @ Bot/人）
- [x] 自动接手机制（Orchestrator 建议后被建议 Bot 自动接手）
- [x] 自动接手 UI（显示「正在处理...」）
- [x] 资源监控基础版（队列、耗时、成功率）
- [ ] 用户权限管理
- [ ] 缓存优化
- [ ] 多媒体输入与相应
---

## 门户阶段二：公共平台（规划中）

**目标**：开放公共知识与数据平台，支持跨团队访问申请。

- [ ] 公共知识平台（跨频道/工作空间只读知识库）
- [ ] 公共数据平台（结构化数据集接入）
- [ ] 访问申请 API（待审批与审核流程）
- [ ] 引导 Bot 知识扩展（能回答公共平台相关问题）

详见 [docs/公共平台访问申请API规范.md](docs/公共平台访问申请API规范.md)。

---

## 门户阶段三：能力发现与编排增强（规划中）

**目标**：Bot 能主动声明能力，Orchestrator 动态学习并编排。

- [ ] Bot 能力描述（skills / MCP 拉取）
- [ ] Agent 自主加入协议（A2A 握手、Agent Card、Receptionist Agent）
- [ ] 资源监控增强（Task DAG 可视化、风险分级）

详见 [docs/附件四_Agent自主加入协议摘要.md](docs/附件四_Agent自主加入协议摘要.md)。

---

## 长期方向

- [ ] **Human-in-the-loop**：Task 生命周期确认节点、Critique Loop、自主错误恢复
- [ ] **多租户 / 权限体系**：工作空间隔离、成员角色细化、Auth 完整集成
- [ ] **主库迁移**：SQLite → PostgreSQL（规模超出阈值时，迁移路径见 [docs/关键技术文档.md](docs/关键技术文档.md)）
