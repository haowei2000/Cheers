# Release Artifacts

> **Language**: English | [Chinese](README.zh-CN.md)

This folder is reserved for release artifacts that the gateway may serve.

The legacy OpenClaw channel plugin package is disabled and no longer has a
source package in this repository. Do not add new
`openclaw-channel-cheers.tgz` artifacts here for new deployments; use the
ACP Connector path documented under `/acp-bridge` instead.

For Docker Compose deployments, this folder remains mounted read-only into the
gateway container at `/app/release`.
