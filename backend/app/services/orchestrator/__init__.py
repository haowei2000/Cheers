"""Orchestrator：把一次 @mention 组装成完整的 Bot 回复流程。

职责范围：
- ``service.run_orchestrator`` —— 对外入口，被 ``message_service`` 调用。
- ``mention`` —— 解析 @mention、匹配频道内 Bot。
- ``adapter_resolver`` —— 按 Bot 配置选出 ``OpenClawAdapter``。
- ``topic_context`` —— 组装四层记忆 + 最近消息作为 adapter 输入。

依赖方向：orchestrator → (services 顶层领域服务) + (services.adapters)。
禁止反向依赖：adapter / 领域服务不得 import orchestrator。
"""
