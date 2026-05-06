# Release Artifacts

Put the AgentNexus OpenClaw plugin tarball here:

```text
release/openclaw-channel-agentnexus.tgz
```

The backend exposes it at:

```text
/docs/openclaw/release/openclaw-channel-agentnexus.tgz
```

For Docker Compose deployments, this folder is mounted read-only into the backend container at `/app/release`.
