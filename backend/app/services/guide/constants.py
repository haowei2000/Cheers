"""内置 Bot 常量，供 seed、channels、orchestrator 等复用."""

# 统一内置 Bot（引导 + 助手 + 记忆管理三合一）
GUIDE_BOT_ID = "bot-guide-001"

# 系统占位 AIModel / PromptTemplate（供内置 Bot 满足 DB FK 约束；运行时不实际调用）
SYSTEM_MODEL_ID = "model-system-builtin"
SYSTEM_TEMPLATE_ID = "template-system-builtin"

# 保留旧常量，避免其他地方 import 出错
ORCHESTRATOR_BOT_ID = "bot-coordinator-001"
ASSISTANT_BOT_ID = "bot-assistant-001"

# 智枢协作操作指引助手 Bot（帮助文档问答）
GUIDE_HELPER_BOT_ID = "bot-guide-helper-001"
