"""业务服务层。

三个层次，职责不要混：

1. 顶层 ``*_service.py`` / ``*/service.py``
   —— 领域服务，面向 API route 提供 CRUD / 编排 / 事务。
   直接依赖 ``app.db``，不依赖 ``adapters`` 或 ``orchestrator``。
   例：``channel_service``、``bot_service``、``memory/manager``、
   ``openclaw_bridge/service``、``file_processor/service``。

2. ``services.adapters``
   —— ``OpenClawAdapter`` 协议的实现（策略模式）。
   只被 ``services.orchestrator.adapter_resolver`` 构造；禁止在 API route 或
   领域服务里直接 import 某个具体 adapter。

3. ``services.orchestrator``
   —— 调度引擎，把领域服务 + adapter 组合成一次 @mention 的完整回复流程。
   可以依赖 1 与 2，反向依赖不允许。
"""
