# @agentnexus/bridge-client

Shared Node.js client for the AgentNexus Agent Bridge WebSocket protocol.

It manages the per-bot `control` and `data` streams, reconnect/resume, reply
acks, streaming deltas, traces, and file-upload frames. It is intentionally
provider-agnostic so connectors for OpenClaw, ACP stdio agents, or other local
runtimes can reuse the same bridge transport.
