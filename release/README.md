# Release Artifacts

> **Language**: English | [Chinese](README.zh-CN.md)

Put the AgentNexus OpenClaw plugin tarball here when you want the backend to serve an offline installer:

```text
release/openclaw-channel-agentnexus.tgz
```

The backend exposes it at:

```text
/docs/agent-bridge/release/openclaw-channel-agentnexus.tgz
```

For Docker Compose deployments, this folder is mounted read-only into the backend container at `/app/release`.

The public npm package is `@haowei0520/openclaw-channel-agentnexus`. For most installations, prefer:

```bash
npm pack @haowei0520/openclaw-channel-agentnexus@0.2.4 --pack-destination /tmp
openclaw plugins install /tmp/haowei0520-openclaw-channel-agentnexus-0.2.4.tgz
```

If you serve the tarball from this `release/` folder, make sure the file is rebuilt for the same plugin version you advertise via `OPENCLAW_PLUGIN_VERSION`.
