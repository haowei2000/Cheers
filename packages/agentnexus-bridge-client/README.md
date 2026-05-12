# @agentnexus/bridge-client

Shared Node.js client for the AgentNexus Agent Bridge WebSocket protocol.

It manages the per-bot `control` and `data` streams, reconnect/resume, reply
acks, streaming deltas, traces, and file-upload frames. It is intentionally
provider-agnostic so connectors for OpenClaw, ACP stdio agents, or other local
runtimes can reuse the same bridge transport.

## Release

`@agentnexus/bridge-client` is published by the ACP connector release workflow
before `@agentnexus/acp-connector`. Configure the repository secret `NPM_TOKEN`,
then push a tag named `agentnexus-acp-connector-v<version>` that matches the
connector package version.
