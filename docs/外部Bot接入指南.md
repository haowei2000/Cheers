# AgentNexus 外部 Bot 接入完整指南

> 面向 **Bot 开发者、系统集成工程师、管理员**：全面说明将外部 AI 服务或 OpenClaw 实例接入 AgentNexus 的三种方式、操作步骤、配置参数与排查方法。

---

## 一、接入方式总览

AgentNexus 支持三种外部 Bot 接入方式，按适用场景选择：

| 方式 | 适用场景 | 技术难度 | 是否需要外部服务 | 用户能看到真实回复 |
|------|----------|----------|-----------------|------------------|
| **① LLM Bot（推荐）** | 接入任何 OpenAI 兼容 API（OpenAI、本地 Ollama、Claude、智谱、Kimi 等） | ★ 低 | 只需要一个 API Endpoint | ✅ 是，流式显示 |
| **② HTTP OpenClaw** | 已有 OpenClaw 实例，fire-and-forget 触发 | ★★ 中 | 需运行 OpenClaw Gateway | ❌ 仅显示占位消息 |
| **③ WebSocket OpenClaw（推荐 OpenClaw 用户）** | 已有 OpenClaw 实例，需展示真实 AI 回复 | ★★★ 高 | 需运行 OpenClaw Gateway | ✅ 是 |

> **大多数用户首选方式①**：只需提供一个 OpenAI 兼容的 API 地址和 Key，无需额外服务。
> 方式②③ 专为 OpenClaw 用户设计，详见本文 §四、§五 及《OpenClaw接入AgentNexus指南》。

---

## 二、核心概念

### Bot 的组成

AgentNexus 中每个 Bot（`BotAccount`）由三部分组成：

```
Bot
 ├── AI 模型（AIModel）    — LLM 提供商配置：接口地址、Key、模型名
 ├── 提示词模板（PromptTemplate）— System Prompt + 用户消息模板
 └── Bot 账号（BotAccount）— @ 名字、显示名、描述、头像等
```

### 频道记忆注入

Bot 被调用时，AgentNexus 会自动将频道的五层记忆注入到上下文：

| 层 | 变量名 | 内容 |
|----|--------|------|
| 项目锚点 | `{{anchor}}` | 项目目标、背景、约定 |
| 项目进度 | `{{progress}}` | 当前进度、待办、已完成 |
| 决策记录 | `{{decisions}}` | 已做的重要决策 |
| 文件索引 | `{{files_index}}` | 已上传文件的摘要 |
| 近期活动 | `{{recent}}` | 最近频道对话摘要 |

在提示词模板中可以用 `{{anchor}}`、`{{decisions}}` 等占位符直接引用这些记忆。

---

## 三、方式①：接入 OpenAI 兼容 API（推荐）

这是最常用的方式，适用于：

- **OpenAI**：GPT-4o、GPT-4o-mini 等
- **Anthropic Claude**：通过兼容层或代理
- **本地模型**：Ollama（Llama 3、Qwen、Mistral 等）
- **国内 API**：智谱 ChatGLM、月之暗面 Kimi、DeepSeek、百川等
- **其他兼容 OpenAI `/v1/chat/completions` 的任何服务**

### 3.1 第一步：在管理后台创建 AI 模型

打开浏览器，进入前端地址 → 点击左下角 **「管理」** 按钮 → 切换到 **「模型与模板」** 标签。

点击「**添加模型**」，填写以下信息：

| 字段 | 说明 | 示例 |
|------|------|------|
| **名称** | 在系统中显示的名称 | `GPT-4o` / `本地Ollama-Llama3` |
| **提供商** | 标识符（任意字符串，仅用于展示） | `openai` / `ollama` / `zhipu` |
| **模型名** | API 中使用的模型标识符 | `gpt-4o` / `llama3.2` / `glm-4` |
| **Base URL** | API 根地址，不含 `/chat/completions` | 见下方示例 |
| **API Key** | 鉴权密钥（本地模型可留空） | `sk-xxxxx` |
| **描述**（可选） | 备注信息 | `用于代码审查的旗舰模型` |

**常见 Base URL 示例：**

| 服务 | Base URL |
|------|----------|
| OpenAI 官方 | `https://api.openai.com/v1` |
| Ollama 本地 | `http://localhost:11434/v1` |
| Ollama 局域网 | `http://192.168.x.x:11434/v1` |
| 智谱 ChatGLM | `https://open.bigmodel.cn/api/paas/v4` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| 百川 AI | `https://api.baichuan-ai.com/v1` |
| LM Studio | `http://localhost:1234/v1` |

> **注意**：Base URL 末尾不需要加 `/`，系统会自动拼接 `/chat/completions`。

**高级配置（可选）**：在「额外配置」JSON 字段中可覆盖模型参数：

```json
{
  "temperature": 0.3,
  "max_tokens": 4000,
  "top_p": 0.9,
  "extra_headers": {
    "X-Custom-Header": "value"
  }
}
```

### 3.2 第二步：创建提示词模板

在「**模型与模板**」标签 → 「提示词模板」区块，点击「**添加模板**」：

| 字段 | 说明 |
|------|------|
| **名称** | 模板名称，如 `代码审查助手` |
| **System Prompt** | 定义 Bot 角色与行为的系统提示词 |
| **用户消息模板** | 用户消息的包装格式，`{{message}}` 为消息占位符 |

**System Prompt 中可用的记忆变量：**

```
你是一个专业的代码审查助手。

## 项目背景
{{anchor}}

## 已有决策
{{decisions}}

## 文件索引
{{files_index}}

## 近期讨论
{{recent}}

请根据以上项目背景，针对用户的代码或问题给出专业审查意见。
```

**用户消息模板示例：**

```
用户提问：{{message}}

请给出详细、专业的回答。
```

> 如果模板很简单，用户消息模板直接写 `{{message}}` 即可，系统会直接传递用户输入的原始消息。

### 3.3 第三步：创建 Bot 账号

切换到「**Bot 管理**」标签，点击「**添加 Bot**」：

| 字段 | 说明 | 示例 |
|------|------|------|
| **@ 名字（username）** | 用户 @ 时使用的名字，全系统唯一，建议小写无空格 | `codereview` / `finance-bot` |
| **显示名称** | 聊天界面显示的名称 | `代码审查助手` |
| **描述** | Bot 的功能说明，显示在成员列表中 | `专注于代码审查与质量改进` |
| **AI 模型** | 选择第一步创建的模型 | `GPT-4o` |
| **提示词模板** | 选择第二步创建的模板 | `代码审查助手` |
| **自定义系统提示词**（可选） | 若填写，会覆盖模板的 System Prompt | 留空则使用模板的 |

### 3.4 第四步：将 Bot 加入频道

Bot 创建后不会自动出现在任何频道，需要手动加入：

**方式 A（推荐）**：在频道内直接 @

1. 打开目标频道
2. 在消息输入框输入 `@` + Bot 的 @ 名字
3. 如果 Bot 未加入该频道，会弹出提示「Bot 不在本频道，是否邀请加入？」
4. 点击「加入并 @ta」即可自动加入并发送消息

**方式 B**：通过管理界面

1. 打开管理界面 → **「成员管理」** 区块
2. 选择目标频道
3. 在「添加成员」中选择 Bot 类型，搜索并添加

**方式 C**：通过 API

```bash
curl -X POST "http://localhost:8000/api/channels/{channel_id}/members" \
  -H "Content-Type: application/json" \
  -d '{"member_id": "<bot_id>", "member_type": "bot"}'
```

### 3.5 第五步：测试 Bot

在频道内发消息：

```
@codereview 请帮我审查这段 Python 代码的可读性：
def f(x): return x*2+1
```

Bot 应在几秒内给出流式回复（逐字显示）。

---

## 四、方式②：HTTP OpenClaw 接入（fire-and-forget）

适用于已有 OpenClaw 实例、不需要在频道内展示真实 AI 回复的场景（仅触发处理，回复通过其他渠道传达）。

> **提醒**：HTTP 模式下 AgentNexus 只显示「OpenClaw 已接收请求，正在处理…」占位消息，**不显示真实 AI 回复**。如需显示回复，请使用方式③（WebSocket 模式）。

### 4.1 OpenClaw 侧配置

编辑 `~/.openclaw/openclaw.json`，在 `hooks` 节开启外部 Webhook：

```json
"hooks": {
  "enabled": true,
  "token": "your-hook-secret-token",
  "path": "/hooks",
  "allowedAgentIds": ["main"],
  "allowRequestSessionKey": true,
  "allowedSessionKeyPrefixes": ["nexus:", "hook:"],
  "defaultSessionKey": "hook:ingress"
}
```

重启 Gateway：

```bash
openclaw gateway restart
```

### 4.2 AgentNexus 侧配置

在 `backend/.env` 中添加：

```env
OPENCLAW_HOOK_TOKEN=your-hook-secret-token   # 与 hooks.token 一致
OPENCLAW_AGENT_ID=main                        # allowedAgentIds 中的 agent 名
OPENCLAW_SESSION_PREFIX=nexus:                # sessionKey 前缀
```

### 4.3 注册 Bot

向 AgentNexus 提交注册申请（无需手动创建 AI 模型和模板）：

```bash
curl -X POST "http://localhost:8000/api/bots/register-request" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "my-openclaw-bot",
    "openclaw_endpoint": "http://10.1.10.66:18789",
    "display_name": "我的 OpenClaw Bot"
  }'
```

然后管理员在前端「管理」→「待审核 Bot 申请」中审核通过即可。

---

## 五、方式③：WebSocket OpenClaw 接入（推荐 OpenClaw 用户）

WebSocket 模式下，AgentNexus 与 OpenClaw 建立持久连接，等待并接收完整 AI 回复，实时写入频道。

详细配置步骤见：[OpenClaw接入AgentNexus指南](OpenClaw接入AgentNexus指南.md)

**关键点摘要：**

1. OpenClaw 配置与方式②相同（开启 `hooks`）
2. Bot 的 `openclaw_endpoint` 填 **WebSocket 地址**（以 `ws://` 或 `wss://` 开头）：
   ```
   ws://10.1.10.66:18789
   ```
3. 还需填写 `openclaw_session`（如 `nexus:user1`）和 `openclaw_token`
4. AgentNexus 会执行握手 → `chat.send` → 等待 `lifecycle phase=end` → 写入频道

---

## 六、方式对比与选择建议

```
我有现成的 OpenAI/Ollama/国内 API Key
        └→ 用方式① LLM Bot（最简单，5分钟完成）

我已经在运行 OpenClaw，想接入 AgentNexus
        ├→ 需要用户在频道看到真实回复 → 用方式③ WS 模式
        └→ 只需触发，回复通过其他渠道 → 用方式② HTTP 模式

我想开发一个完全自定义的 Bot（不用 OpenClaw）
        └→ 用方式① + 自定义 API 兼容层（将自己的服务包装成 OpenAI 兼容接口）
```

---

## 七、提示词编写技巧

### 7.1 基础模板结构

```
# 角色定义
你是 [角色描述]，擅长 [专业领域]。

# 行为准则
- [规则1]
- [规则2]

# 项目上下文
{{anchor}}

# 近期动态
{{recent}}

# 回答要求
- 使用中文回答
- 回答简洁明了
- 若不确定，说明你的假设
```

### 7.2 针对不同场景的模板示例

**代码助手：**

```
你是一个专业的软件工程师，精通 Python、JavaScript 等语言。

项目背景：
{{anchor}}

文件索引：
{{files_index}}

请根据项目上下文，回答用户的编程问题。代码使用合适的代码块格式。
```

**文档整理 Bot：**

```
你是一个文档整理助手。你的任务是帮助团队整理和总结信息。

近期讨论摘要：
{{recent}}

已有决策：
{{decisions}}

请帮助整理用户提供的内容，并按结构化格式输出。
```

**项目管理助手：**

```
你是一个项目管理助手，负责跟踪进度、识别风险、协调资源。

项目目标：
{{anchor}}

当前进度：
{{progress}}

已有决策：
{{decisions}}

请根据以上信息，回答用户的项目管理相关问题，或主动提醒潜在风险。
```

### 7.3 提示词中的占位符

| 占位符 | 说明 | 建议用途 |
|--------|------|----------|
| `{{message}}` | 用户的原始消息（**用户消息模板必填**） | 用户消息模板 |
| `{{anchor}}` | 频道锚点（项目背景） | System Prompt |
| `{{progress}}` | 项目进度 | System Prompt |
| `{{decisions}}` | 决策记录 | System Prompt |
| `{{files_index}}` | 文件索引摘要 | System Prompt |
| `{{recent}}` | 近期活动摘要 | System Prompt |

---

## 八、通过 API 批量配置（管理员高级用法）

如需批量创建模型/模板/Bot，可直接调用 REST API。访问 `http://localhost:8000/docs` 查看 Swagger 文档，以下为常用接口：

### 8.1 创建 AI 模型

```bash
curl -X POST "http://localhost:8000/api/admin/models" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "GPT-4o",
    "provider": "openai",
    "model_name": "gpt-4o",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-xxxxx",
    "is_enabled": true
  }'
```

响应中会包含 `model_id`，后续创建 Bot 时需要用到。

### 8.2 创建提示词模板

```bash
curl -X POST "http://localhost:8000/api/admin/templates" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "通用助手模板",
    "system_prompt": "你是一个智能助手。\n\n项目背景：\n{{anchor}}\n\n近期活动：\n{{recent}}",
    "user_template": "{{message}}"
  }'
```

响应中会包含 `template_id`。

### 8.3 创建 Bot 账号

```bash
curl -X POST "http://localhost:8000/api/bots" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "mybot",
    "display_name": "我的助手",
    "description": "一个通用 AI 助手",
    "model_id": "<model_id>",
    "template_id": "<template_id>"
  }'
```

### 8.4 将 Bot 加入频道

```bash
curl -X POST "http://localhost:8000/api/channels/{channel_id}/members" \
  -H "Content-Type: application/json" \
  -d '{"member_id": "<bot_id>", "member_type": "bot"}'
```

---

## 九、常见问题排查

| 现象 | 可能原因 | 解决方案 |
|------|----------|----------|
| @Bot 后无任何回复 | Bot 未加入该频道 | 在频道输入 `@botname`，点击「加入并 @ta」 |
| @Bot 后显示「未配置模型」 | Bot 没有关联 AI 模型 | 管理 → Bot 管理 → 编辑 → 选择模型 |
| @Bot 后显示「模型已禁用」 | 对应 AI 模型被设为禁用 | 管理 → 模型与模板 → 启用该模型 |
| @Bot 后显示「无法连接到 LLM API」 | Base URL 填写错误或服务不可达 | 检查 Base URL 和网络连通性；执行 `curl <base_url>/models` 验证 |
| @Bot 后显示「LLM API 错误 (HTTP 401)」 | API Key 错误或过期 | 更新 AI 模型配置中的 API Key |
| @Bot 后显示「LLM API 错误 (HTTP 404)」 | Base URL 或模型名填写有误 | 确认 `/v1` 路径是否包含在 Base URL 中；确认模型名 |
| @Bot 后回复为空 | 模型返回了空内容 | 检查 System Prompt 是否过于严格；尝试降低 temperature |
| Bot 回复缓慢 | 模型响应慢 | 考虑换更快的模型，或调低 `max_tokens` |
| Ollama 连接失败 | Ollama 未启动或仅监听 127.0.0.1 | 执行 `OLLAMA_HOST=0.0.0.0 ollama serve`；DockerDeployment时需特别注意 |
| Docker 内访问宿主机 Ollama | 容器内无法访问 localhost | 将 Base URL 改为 `http://host.docker.internal:11434/v1`（Mac/Windows）或宿主机局域网 IP |

---

## 十、Bot 配置速查卡

**接入 OpenAI**

```
Base URL : https://api.openai.com/v1
API Key  : sk-xxxxxxxx
模型名   : gpt-4o / gpt-4o-mini / gpt-3.5-turbo
```

**接入本地 Ollama**

```
Base URL : http://localhost:11434/v1
API Key  : （留空）
模型名   : llama3.2 / qwen2.5 / mistral / deepseek-r1
```

**接入智谱 ChatGLM**

```
Base URL : https://open.bigmodel.cn/api/paas/v4
API Key  : 在智谱 AI 开放平台获取
模型名   : glm-4 / glm-4-flash / glm-4v
```

**接入月之暗面 Kimi**

```
Base URL : https://api.moonshot.cn/v1
API Key  : 在 Kimi 开放平台获取
模型名   : moonshot-v1-8k / moonshot-v1-32k / moonshot-v1-128k
```

**接入 DeepSeek**

```
Base URL : https://api.deepseek.com/v1
API Key  : 在 DeepSeek 开放平台获取
模型名   : deepseek-chat / deepseek-coder / deepseek-reasoner
```

---

## 十一、相关文档

- [普通用户使用说明](普通用户使用说明.md)——如何 @ Bot、上传文件、查看频道记忆
- [OpenClaw接入AgentNexus指南](OpenClaw接入AgentNexus指南.md)——WebSocket 模式详细步骤与 OpenClaw 配置
- [OpenClaw接入指南](OpenClaw接入指南.md)——OpenClaw 注册申请流程
- [安装部署说明](安装部署说明.md)——系统部署与环境配置
- [技术排查Q&A](技术排查Q&A.md)——故障现象、日志诊断
