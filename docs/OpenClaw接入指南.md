# OpenClaw 接入 AgentNexus 指南

> 面向 **OpenClaw 开发者**：如何让 OpenClaw 实例发现 AgentNexus 并自动提交注册申请，经管理员审核后即可被 @ 使用。

---

## 一、接入流程概览

```
OpenClaw → ① GET 发现接口 → ② POST 注册申请 → ③ 管理员审核通过 → ④ 管理员将 Bot 加入项目 → 用户可 @ 使用
```

---

## 二、步骤详解

### 前置条件

- 已知 AgentNexus 后端地址，例如：`http://10.1.9.130:8000`（替换为实际 IP 和端口）
- OpenClaw 已实现 HTTP 服务，可被 AgentNexus 调用 `POST {openclaw_endpoint}/execute`

---

### 第一步：获取发现与注册指南

**请求：**

```bash
curl -X GET "http://10.1.9.130:8000/api/public/agentnexus-discovery"
```

**注意：路径必须包含 `/api` 前缀。** 以下路径会返回 404，请勿使用：

- ❌ `http://10.1.9.130:8000/public/agentnexus-discovery`（缺少 `/api`）
- ❌ `http://10.1.9.130:8001/...`（端口错误，请确认后端实际端口）

**响应示例：**

```json
{
  "name": "AgentNexus",
  "description": "智枢人机协作平台；Bot 需管理员审核通过后可被加入项目并 @。",
  "base_url": "http://10.1.9.130:8000",
  "register_request": {
    "url": "http://10.1.9.130:8000/api/bots/register-request",
    "method": "POST",
    "content_type": "application/json",
    "body_schema": {
      "username": "string，必填，@ 时使用的名字，唯一",
      "display_name": "string，选填，显示名称",
      "openclaw_endpoint": "string，必填，本 OpenClaw 的 http(s) 根地址，系统将向 {openclaw_endpoint}/execute 发送 POST 请求"
    }
  },
  "execute_contract": "审核通过后，用户 @ 该 Bot 时，AgentNexus 会向 openclaw_endpoint 的 POST /execute 发送请求，请求/响应格式见《系统管理说明书》§4.4。"
}
```

**OpenClaw 应解析 `register_request.url` 和 `body_schema`，用于第二步。**

---

### 第二步：提交注册申请

使用第一步返回的 `register_request.url` 发起 POST 请求。

**请求：**

```bash
curl -X POST "http://10.1.9.130:8000/api/bots/register-request" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "openclaw66",
    "openclaw_endpoint": "http://10.1.10.66:8181",
    "display_name": "Epicwise-MOM"
  }'
```

**参数说明：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `username` | 是 | @ 时使用的名字，系统内唯一；建议不含 `@`，用户输入时会自动补全 |
| `openclaw_endpoint` | 是 | 本 OpenClaw 的 http(s) 根地址；AgentNexus 将向 `{openclaw_endpoint}/execute` 发送 POST 请求 |
| `display_name` | 否 | 显示名称 |

**成功响应示例：**

```json
{
  "status": "success",
  "data": {
    "request_id": "f76d5bbd-af6b-40dd-998d-8cae0f6812a7",
    "message": "注册申请已提交，等待管理员在「管理」界面审核通过后可被加入项目并 @。"
  }
}
```

---

### 第三步：管理员审核

1. 管理员打开 AgentNexus 前端，进入 **「管理」→「Bot 与频道」** 标签
2. 在 **「待审核 Bot 申请」** 区块查看列表，点击 **「刷新」** 可重新拉取
3. 对每条申请点击 **「通过」** 或 **「拒绝」**
4. 通过后，管理员可将该 Bot 加入目标项目：方式一，用户在频道内输入 @ 选择该 Bot，系统提示「是否邀请加入？」确认即可；方式二，在「管理」→「添加成员」中填 bot_id、类型选 Bot 添加

**若管理端看不到申请，请确认：**

- 前端连接的 API 与提交注册的后端是同一实例（同一 IP、同一端口）
- 若前端通过 Vite 代理，代理目标端口需与后端一致（默认 8000）

---

## 三、常见错误

| 现象 | 原因 | 解决 |
|------|------|------|
| `{"detail":"Not Found"}` | 路径缺少 `/api` 前缀 | 使用 `/api/public/agentnexus-discovery`，不要用 `/public/agentnexus-discovery` |
| `Connection refused` / 超时 | 端口错误或后端未启动 | 确认后端端口（默认 8000），确认 `--host 0.0.0.0` 以便外网访问 |
| 管理端看不到申请 | 前端连到不同后端 | 确保前端代理指向接收注册的同一后端（IP + 端口） |

---

## 四、相关文档

- [系统管理说明书](系统管理说明书.md) §四 OpenClaw 接入、§五 发现与自动注册、§4.4 请求响应约定
- [技术排查Q&A](技术排查Q&A.md) §三 @ Bot 无回复
