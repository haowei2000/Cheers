# Security Policy

> **语言**：中文 | [English](SECURITY.md)

## Supported Versions

AgentNexus 处于早期公开预览阶段。安全修复优先面向：

- `develop` 分支
- 最新正式 tag / release

旧版本是否回补修复视影响范围和维护成本决定。

## Reporting a Vulnerability

请不要在公开 Issue、PR 或讨论区披露漏洞细节。

优先使用 GitHub 的 private vulnerability reporting / security advisory 功能。如果仓库未开启该功能，请通过维护者公开资料中列出的联系方式报告，并在标题中包含 `AgentNexus security`。

报告中请尽量包含：

- 受影响版本、commit 或部署方式
- 漏洞类型和影响范围
- 最小复现步骤
- 相关日志、请求样例或截图
- 你是否已经接触到真实用户数据

请不要在未授权的系统上验证漏洞，不要导出、修改或删除他人数据。

## Deployment Security Checklist

生产部署前至少确认：

- 设置强随机 `JWT_SECRET_KEY`。
- 替换 `POSTGRES_PASSWORD`、`RUSTFS_ACCESS_KEY`、`RUSTFS_SECRET_KEY`、`ADMIN_PASSWORD`。
- 如启用 Agent Bridge，设置强随机 `AGENT_BRIDGE_TOKEN` 并限制外部访问面。
- 配置可信 `PUBLIC_BASE_URL`、`KKFILEVIEW_BASE_URL` 和 `KKFILEVIEW_TRUST_HOST`。
- 收紧 CORS、反向代理、对象存储桶权限和文件上传类型。
- 禁止提交 `.env`、日志、数据库、上传文件、私钥和生产 token。
