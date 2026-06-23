# Release Artifacts

> **语言**：中文 | [English](README.md)

该目录保留给 gateway 可直接托管的发布产物。

旧 OpenClaw channel plugin 包已经停用，仓库中不再保留对应源码包。新部署不要再向
这里放置 `openclaw-channel-cheers.tgz`，请改用 `/acp-bridge` 文档中的
ACP Connector 接入路径。

Docker Compose 部署中，该目录仍会以只读方式挂载到 gateway 容器的
`/app/release`。
