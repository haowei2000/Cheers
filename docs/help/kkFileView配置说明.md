# kkFileView Preview Guide

> **Language**: English | [中文](kkFileView配置说明.zh-CN.md)

AgentNexus combines built-in preview for simple files with kkFileView for complex Office, WPS, OFD, archive, CAD, and EPUB previews.

## Preview Flow

1. User opens a file preview in AgentNexus.
2. Backend creates a short-lived `public-preview` URL.
3. The URL is encoded and passed to kkFileView.
4. kkFileView fetches the source file through AgentNexus.
5. Backend validates the token and streams the file.
6. kkFileView renders the preview page.

## Important Variables

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | Public AgentNexus URL kkFileView can call back to |
| `KKFILEVIEW_ENABLED` | Enables complex document preview |
| `KKFILEVIEW_BASE_URL` | Public kkFileView URL returned to the frontend |
| `KKFILEVIEW_HOST_BIND` | Host bind address; keep local-only in production behind a reverse proxy |
| `KKFILEVIEW_HOST_PORT` | Host port for kkFileView |
| `KKFILEVIEW_TRUST_HOST` | Hostname kkFileView is allowed to fetch |
| `JWT_SECRET_KEY` | Stable signing key for preview tokens |

## Reverse Proxy

Expose kkFileView under `/preview/` and make sure `/api`, `/ws`, and file preview routes are forwarded to the AgentNexus backend. The kkFileView container must be able to reach `PUBLIC_BASE_URL`.

## Common Problems

| Symptom | Likely Cause |
|---|---|
| Preview iframe opens but document never loads | kkFileView cannot reach `PUBLIC_BASE_URL` |
| 401/403 preview source | Token expired or `JWT_SECRET_KEY` changed after restart |
| Host denied | `KKFILEVIEW_TRUST_HOST` does not match deployment host |
| Office document renders incorrectly | kkFileView conversion image or cache issue |
| Port already in use | Change `KKFILEVIEW_HOST_PORT` in `.env` |

## Local Disable

For local development without kkFileView:

```env
KKFILEVIEW_ENABLED=false
```

Built-in preview and download routes still work for simple file types.
