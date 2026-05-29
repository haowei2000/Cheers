# AgentNexus Bot 配置分级设计

> 版本：v0.1 设计草稿（仅设计，不含实现）
> 分支：`break/rust-gateway-arch`
> 前提：**不考虑多租户**。基于现有 `bot_accounts` / `ChannelMembership` schema。

本文回答「一个 Bot 有多个配置项该怎么管理」。结论先行：
**AgentNexus 现在已经在分级，只是较窄、合并逻辑隐式。** 本文把现状显式化，
并给出最小、可扩展的补强方案——**不引入与本项目不匹配的表结构**。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 分级模型 | **3 层 + 1 合并器**（库 / Bot 全局 / 频道覆盖 → effective_config） | 贴合现有 schema，避免过度设计 |
| 频道覆盖载体 | 复用 `ChannelMembership`，加 `bot_override_config JSONB` | 已有 `template_id` 覆盖先例，不新建表 |
| 合并规则 | 普通覆盖 / limits 取最小 / tools 取交集 / security 只收紧 | 安全成本边界不能被下层放宽 |
| 版本管理 | **暂不做** `bot_versions` | 有价值但大改，需要回滚/灰度时再上 |
| 权限引擎 | **不做** `capability_grants` 独立层 | 无多租户、当前规模下属过度设计 |
| 密钥 | 维持现状（哈希存储，不进 JSONB） | 已符合最佳实践 |

---

## 1. 现状：已经存在的分层

| 层 | 现有载体 | 说明 |
|----|---------|------|
| **可复用库** | `ai_models`（模型参数）+ `prompt_templates`（提示词） | 独立表、多 Bot 共享，比「全塞 JSONB」更规范 |
| **Bot 身份** | `bot_accounts`: `username` / `display_name` / `avatar_url` / `scope` / `status` | Bot 是谁 |
| **Bot 全局运行配置** | `bot_accounts`: `model_id`→ai_models、`template_id`→prompt_templates、`custom_system_prompt`（覆盖模板）、`binding_type`/`bridge_provider`/`binding_config` | Bot 默认怎么跑 |
| **频道级覆盖** | `ChannelMembership.template_id`（注释：channel-level prompt-template override, bot only） | **已存在**，但只能换 prompt 模板 |
| **密钥** | `bot_account.bot_token_hash` / `bot_token_prefix`（哈希，明文仅创建/轮换时返回） | ✅ 不进 JSONB |

对照常见的「配置分层」建议，AgentNexus **已满足**：密钥分离、模型/提示词复用、Bot 级覆盖、频道级覆盖（窄）。

---

## 2. 缺口

1. **频道覆盖太窄**：只能覆盖「用哪个 prompt 模板」，无法按频道调 `temperature` / `requires_mention` / `max_recent_messages`。← **最该补、成本最低**
2. **无 effective_config 合并器**：合并逻辑隐式、分散在 adapter 解析处，难审计、难调试。
3. **无版本/回滚**：改配置即时生效，无 draft/active/archived。← 有价值，但本期不做
4. **权限隐式**：靠 `binding_type`/`scope` 表达，无独立权限层。← 无多租户下不引入

---

## 3. 目标分层（最小可扩展）

```
ai_models / prompt_templates           ← 可复用库（已有）
        │ 引用
        ▼
bot_accounts                           ← Bot 全局默认（已有）
  model_id / template_id /
  custom_system_prompt / binding_config
        │ 覆盖
        ▼
频道级覆盖                              ← ChannelMembership.bot_override_config (JSONB, 拟新增)
  把现有 template_id 覆盖泛化为任意配置项
        │
        ▼
build_effective_bot_config()           ← 集中合并 + 约束（拟新增）
        │
        ▼
effective_config  →  adapter / pipeline
```

> 说明：现有 `ChannelMembership.template_id` 可视为 `bot_override_config.prompt.template_id` 的特例，迁移期两者并存，最终收敛到 JSONB。

---

## 4. 合并规则（本设计的核心，非表结构）

`build_effective_bot_config(bot_id, channel_id)` 按下述规则合并：

| 字段类型 | 规则 | 示例 |
|---------|------|------|
| 普通标量 | 下层覆盖上层 | `llm.temperature`、`prompt.response_style`、`trigger.requires_mention` |
| `limits.*` | **取最小值**（不能被频道放大） | `max_recent_messages`、`max_tool_calls_per_run` |
| `tools.enabled` | **取交集**（不是并集） | Bot 启用 ∩ 系统允许 |
| `security.*` | **只能收紧，不能放宽** | `redact_pii` 一旦上层为真，下层不能改假 |

合并顺序（不考虑多租户，无 system/tenant 多级，仅两层 + 系统默认）：

```
系统默认值
  < bot_accounts 全局配置（含 ai_models / prompt_templates 解析后的值）
  < ChannelMembership.bot_override_config
  < 安全/限额约束（最高优先级，最后套用，不可被覆盖）
```

> **关键原则**：约束（limits 最小、tools 交集、security 收紧）**最后套用**，保证任何频道覆盖都无法突破安全/成本边界。

---

## 5. 频道覆盖载体：两种放法

| 方案 | 改动 | 适合 | 取舍 |
|------|------|------|------|
| **A. 复用 `ChannelMembership` + `bot_override_config JSONB`**（推荐） | 加 1 列 + resolver | 沿用「bot 是频道成员」模型，已有 template_id 先例 | 最小改动；override 与成员关系同生命周期 |
| B. 独立 `channel_bot_configs` 表 | 新表 | 覆盖项极多、需独立审计/软删除 | 更干净但更重 |

推荐 **A**：`ChannelMembership` 本就是 bot↔channel 关系载体，加 JSONB 列顺理成章。

`bot_override_config` 示例（频道级想覆盖的项）：

```jsonc
{
  "llm":     { "temperature": 0.1 },
  "trigger": { "requires_mention": true, "auto_reply": false },
  "context": { "max_recent_messages": 10, "include_room_summary": true },
  "prompt":  { "template_id": "..." }   // 兼容现有 ChannelMembership.template_id
}
```

---

## 6. 明确「不要做」（避免过度设计）

| 不引入 | 原因 |
|--------|------|
| `principals` 统一身份表 | AgentNexus 的 `users` 与 `bot_accounts` 已分离，无 principals 抽象，引入是大重构 |
| `tenant_configs` / `tenant_id` / 租户级继承 | **不考虑多租户** |
| `capability_grants` 独立权限引擎 | 当前权限靠 `binding_type`/`scope` 已够；无多租户下属过度设计 |
| `bot_versions`（本期） | 有价值，但需回滚/灰度时再上，避免现在拖慢 |
| 把配置「全摊进 `bot_accounts` 字段」 | 用 JSONB override + 复用库表，已比摊字段更好 |

> 词汇对齐：外部资料常用 `room`=本项目 `channel`、`tenant`=`workspace`。本设计一律用 AgentNexus 术语。

---

## 7. 未来可选增强（非本期）

- **`bot_versions`**：draft / active / archived + 回滚 + 变更审计。`bot_accounts.active_version_id` 指向当前版本，配置从字段挪到版本表。
- **effective_config 调试接口**：`GET /channels/{cid}/bots/{bid}/effective-config` 返回各层来源，便于排查「为什么这个频道里 Bot 行为变了」。
- **配置 schema 校验**：按 `binding_type`（http / agent_bridge）用 Pydantic 校验 override 结构，保存前拒绝非法配置。

---

## 8. 与重构主线的关系

- 本设计属于 **Agent Worker（Python）** 范畴：`build_effective_bot_config()` 在 worker rehydrate 上下文（见 [TASK_DELIVERY.md](./TASK_DELIVERY.md) §5）时调用，产出喂给 adapter。
- 与 Rust Gateway / 线协议无关——配置解析全在 Python 侧。
- 频道覆盖的 JSONB 列是一次 Alembic 迁移；实现时机随 Agent Worker 剥离（Phase 2）。
