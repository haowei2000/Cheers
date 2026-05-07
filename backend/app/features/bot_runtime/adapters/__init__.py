"""``BotAdapter`` 协议的具体实现（策略模式）。

命名约定
--------
- 抽象协议：``base.py`` → ``BotAdapter``
- 具体实现文件：``<kind>_bot.py``
- 具体实现类：``<Kind>BotAdapter``

三类适配器
----------
1. 兜底 / 测试替身
   - ``mock_bot.py`` → ``MockBotAdapter``
   - 用于 ``adapter_resolver`` 的错误分支（未知 Bot、未配置模型/模板、
     Bot 离线等），以及单测替身。不发真实请求。

2. 内置系统 Bot（按 ``bot_id`` 路由，不走 ``BotAccount`` 配置）
   - ``channel_bot.py`` → ``ChannelBotAdapter``
     ——@Helper，帮助/协作/记忆管理三合一 + 工具系统
   - 路由表在 ``builtin_registry.BUILTIN_BOT_ADAPTERS``（bot_id → 零参工厂）。

3. 用户自定义 Bot（按 ``BotAccount.binding_type`` 路由）
   - ``http_bot.py`` → ``HttpBotAdapter``
     ——binding_type=``"http"``，经 AIModel + PromptTemplate 调用 OpenAI 兼容 API
   - ``agent_bridge_bot.py`` → ``AgentBridgeBotAdapter``
     ——binding_type=``"agent_bridge"``，经外部 provider 异步回推

边界约束
--------
- 唯一入口是 ``features.bot_runtime.pipeline.bot.get_adapter_for_bot``。
  API route / 领域服务禁止直接 import 具体 adapter 类。
- adapter 之间不互相 import；共享逻辑放到 ``base.py`` 或上移到领域服务。
"""
