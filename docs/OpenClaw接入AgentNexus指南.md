# OpenClaw 接入 AgentNexus 指南

> 面向 **AgentNexus 管理员**：通过 OpenClaw 的 OpenAI 兼容网关，将 OpenClaw Agent 作为 LLM 模型接入 AgentNexus，配置为可在频道中 @ 使用的 Bot。

---

## 接入流程概览

```text
① 配置 OpenClaw OpenAI 端点 → ② 在系统模型中添加该端点 → ③ 配置对话模版 → ④ 创建 Bot 并选择模型与模版
```

---

## 第一步：配置 OpenClaw OpenAI 端点

OpenClaw Gateway 提供 OpenAI 兼容的 HTTP API，可直接作为 LLM 端点使用。

参考 OpenClaw 官方文档：[OpenAI HTTP API](https://docs.openclaw.ai/zh-CN/gateway/openai-http-api)

在 OpenClaw Gateway 配置中，启用 OpenAI 兼容接口。配置完成后，你将获得：

- **Base URL**：例如 `http://10.1.10.66:18789/v1`
- **API Key**：Gateway 鉴权 token（如未启用鉴权可填任意值）
- **Model Name**：对应的 Agent ID，例如 `main`

请记录以上信息，第二步使用。

---

## 第二步：在系统模型中配置 OpenClaw OpenAI 端点

1. 打开 AgentNexus 前端，点击左侧「**管理**」进入管理页面
2. 切换到「**LLM 设置**」→「**系统模型**」标签
3. 点击「**添加模型**」，按如下填写：

   | 字段 | 示例值 | 说明 |
   |------|--------|------|
   | 模型名称 | `openclaw-main` | 在系统内标识此模型的名称（自定义） |
   | Provider | `openai` | 选择 OpenAI 兼容协议 |
   | Base URL | `http://10.1.10.66:18789/v1` | OpenClaw Gateway 的 OpenAI 兼容端点 |
   | Model Name | `main` | OpenClaw 中配置的 Agent ID |
   | API Key | `YOUR_GATEWAY_TOKEN` | Gateway token；未启用鉴权时可填任意非空字符串 |

4. 点击「**保存**」

---

## 第三步：配置对话模版

对话模版定义了 Bot 的系统提示词和消息格式。

1. 在管理页面切换到「**对话模版**」标签
2. 点击「**添加模版**」，填写：

   | 字段 | 示例值 | 说明 |
   |------|--------|------|
   | 模版名称 | `OpenClaw 通用模版` | 自定义名称 |
   | 系统提示词 | `你是一个由 OpenClaw 驱动的 AI 助手。` | Bot 的角色定义；可根据 Agent 用途自定义 |
   | 用户消息模版 | `{{message}}` | 保持默认即可；`{{message}}` 会被替换为用户实际消息 |

3. 点击「**保存**」

---

## 第四步：创建 Bot 并选择模型与模版

1. 在管理页面切换到「**Bot 与频道**」标签
2. 点击「**创建 Bot**」，填写：

   | 字段 | 示例值 | 说明 |
   |------|--------|------|
   | Username | `openclaw` | @ 时使用的名字，系统内唯一 |
   | 显示名称 | `OpenClaw Agent` | 选填，频道内显示的名称 |
   | 系统模型 | `openclaw-main` | 选择第二步添加的模型 |
   | 对话模版 | `OpenClaw 通用模版` | 选择第三步创建的模版 |

3. 点击「**创建**」
4. 创建成功后，将该 Bot 加入目标频道：
   - 在频道内输入 `@`，从下拉列表选择该 Bot；若 Bot 未加入频道，点击「加入并 @ta」
   - 或在「管理」→「添加成员」中手动添加

完成后，用户在频道内输入 `@openclaw 你的问题` 即可触发 OpenClaw Agent 回复。

---

## 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| Bot 无回复 | 模型端点不可达 | 确认 OpenClaw Gateway 已启动，Base URL 和端口正确 |
| 回复报 401 | API Key 错误 | 检查 Gateway token 与系统模型中的 API Key 是否一致 |
| 回复报 404 | Model Name 错误 | 确认 Model Name 与 OpenClaw 中的 Agent ID 完全一致 |
| Bot 未出现在 @ 列表 | Bot 未加入频道 | 在「管理」→「添加成员」将 Bot 加入当前频道 |

---

## 相关文档

- [系统管理说明书](系统管理说明书.md) §四 Bot 管理
- [技术排查Q&A](技术排查Q&A.md) §三 @ Bot 无回复
- OpenClaw 官方文档：[OpenAI HTTP API](https://docs.openclaw.ai/zh-CN/gateway/openai-http-api)
