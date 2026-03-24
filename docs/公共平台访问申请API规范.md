# 公共平台访问申请 API 规范

> 本文档描述部门 Bot 申请访问公共知识平台、公共数据平台的 API 约定。**阶段一不实现**，供阶段二及引导 Bot 知识库参考。@引导 Bot 可引用本文档回答「如何申请公共平台访问」。

---

## 一、概述

- **用途**：部门 OpenClaw 的操作人员或部门 Bot 的配置者，向 AgentNexus 提交访问公共知识平台或公共数据平台的申请
- **流程**：提交申请 → AgentNexus 计入待审批列表 → 管理员审核 → 通过后 Bot 获得长期访问权限（直至被取消）
- **申请方式**：HTTP API，非聊天对话

---

## 二、接口约定

### 2.1 提交访问申请

**请求**

| 项目 | 值 |
|------|-----|
| 方法 | POST |
| 路径 | `{base_url}/api/access-requests` |
| Content-Type | application/json |
| 认证 | 待定（可选：API Key / Bot 凭证） |

**请求体（JSON）**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| bot_id | string | 是 | 申请访问的部门 Bot ID |
| resource_type | string | 是 | 资源类型：`knowledge`（知识库）/ `dataset`（数据集）/ `api`（API） |
| resource_id | string | 是 | 目标资源标识，如知识库 ID、数据集 ID、API 路径前缀 |
| purpose | string | 是 | 用途说明，供管理员审核参考 |
| requested_by | string | 否 | 申请人（操作人员）标识，便于追溯 |

**示例**

```json
{
  "bot_id": "bot-finance-001",
  "resource_type": "knowledge",
  "resource_id": "kb-company-policy",
  "purpose": "财务 Bot 需要引用公司报销制度回答用户问题",
  "requested_by": "zhangsan"
}
```

**成功响应（201 Created）**

```json
{
  "status": "success",
  "data": {
    "request_id": "req-uuid-xxx",
    "message": "申请已提交，等待管理员审核。审核通过后该 Bot 将获得长期访问权限。"
  }
}
```

**错误响应（4xx/5xx）**

| 状态码 | 说明 |
|--------|------|
| 400 | 请求体格式错误、必填字段缺失、resource_type 非法 |
| 404 | bot_id 或 resource_id 不存在 |
| 409 | 该 Bot 已拥有该资源访问权限，或存在待审批的重复申请 |

---

## 三、申请状态查询（可选）

**请求**

| 项目 | 值 |
|------|-----|
| 方法 | GET |
| 路径 | `{base_url}/api/access-requests?bot_id={bot_id}` |
| 说明 | 查询某 Bot 的申请列表及状态 |

**响应**

```json
{
  "status": "success",
  "data": {
    "requests": [
      {
        "request_id": "req-uuid-xxx",
        "bot_id": "bot-finance-001",
        "resource_type": "knowledge",
        "resource_id": "kb-company-policy",
        "purpose": "...",
        "status": "pending",
        "created_at": "2026-03-10T10:00:00Z"
      }
    ]
  }
}
```

`status` 取值：`pending`（待审批）、`approved`（已通过）、`rejected`（已拒绝）

---

## 四、权限有效期

- 审核通过后**长期有效**
- 仅当管理员**主动取消**该权限时失效
- 取消后如需再次访问，需重新申请

---

## 五、引导 Bot 引用说明

@引导 Bot 在回答「如何申请公共平台访问」时，可引用以下要点：

1. **入口**：向 `{AgentNexus 基础地址}/api/access-requests` 发送 POST 请求
2. **必填字段**：bot_id、resource_type、resource_id、purpose
3. **resource_type**：knowledge（知识库）、dataset（数据集）、api（API）
4. **流程**：提交后进入待审批列表，管理员在「管理」界面审核；通过后 Bot 获得长期访问权限
5. **详细规范**：见《公共平台访问申请API规范》

---

## 六、相关文档

- [AgentNexus 门户与知识平台设计](AgentNexus门户与知识平台设计.md)
- [系统管理说明书](系统管理说明书.md)（管理员审核入口）
- [00-文档索引与LLM使用说明](00-文档索引与LLM使用说明.md)
