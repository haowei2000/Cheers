#SecurityPolicy

> **Language**: English | [中文](SECURITY.zh-CN.md)

## Supported Versions

AgentNexus is in early public preview. Security fixes are prioritized for:

- `develop` branch
- Latest official tag / release

Whether the old version will be restored or repaired depends on the scope of impact and maintenance costs.

## Reporting a Vulnerability

Please do not disclose vulnerability details in public issues, PRs, or discussion forums.

Prefer using GitHub's private vulnerability reporting / security advisory functionality. If the repository does not have this feature turned on, please report it via the contact information listed in the maintainer's public profile and include `AgentNexus security` in the title.

Please try to include in your report:

- Affected versions, commits, or deployment methods
- Vulnerability type and scope of impact
- Minimum steps to reproduce
- Relevant logs, request samples or screenshots
- Whether you have access to real user data

Please do not verify vulnerabilities on unauthorized systems and do not export, modify or delete other people's data.

## Deployment Security Checklist

Before production deployment, confirm at least:

- Set strong random `JWT_SECRET_KEY`.
- Replace `POSTGRES_PASSWORD`, `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `ADMIN_PASSWORD`.
- If Agent Bridge is enabled, set strong random `AGENT_BRIDGE_TOKEN` and restrict external access.
- Configure trusted `PUBLIC_BASE_URL`, `KKFILEVIEW_BASE_URL` and `KKFILEVIEW_TRUST_HOST`.
- Tighten CORS, reverse proxy, object bucket permissions and file upload types.
- Submission of `.env`, logs, databases, uploaded files, private keys and production tokens is prohibited.