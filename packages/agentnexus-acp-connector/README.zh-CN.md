# @haowei0520/acp-connector

> **语言**：中文 | [English](README.md)

Runs local ACP stdio agents, such as OpenCode or Claude-compatible agents, and
reverse-connects them to a public AgentNexus server through the existing Agent
Bridge WebSocket protocol.

适用于 AgentNexus 部署在服务器上，但 ACP agent 需要运行在开发者电脑、
私有机器或其他能访问本地凭据与项目文件的环境。Connector 会主动反连
AgentNexus WebSocket，启动本地 ACP stdio 进程，把用户消息和附件转发给
agent，并把回复与生成文件流式回传到 AgentNexus。

核心能力：

| 范围 | 行为 |
| --- | --- |
| 传输 | 通过带鉴权的 control/data WebSocket 反连 AgentNexus。 |
| 会话 | 复用 provider session key，让频道/私聊对话保持 ACP session 上下文。 |
| 入站文件 | 按能力把解析文档、图片和不支持解析的二进制附件传给 ACP agent。 |
| 出站文件 | 把 ACP resource/file chunk 和新创建的本地文件上传回 AgentNexus。 |
| 运维 | 支持前台运行和带本地日志/状态命令的命名 daemon 模式。 |

```json
{
  "accounts": {
    "opencode-main": {
      "botToken": "agb_xxx",
      "controlUrl": "wss://agentnexus.example.com/ws/agent-bridge/control",
      "dataUrl": "wss://agentnexus.example.com/ws/agent-bridge/data",
      "agent": {
        "transport": "stdio",
        "command": "opencode",
        "args": ["acp", "--cwd", "/Users/me/project"],
        "cwd": "/Users/me/project",
        "env": {
          "OPENCODE_CONFIG_CONTENT": "$OPENCODE_CONFIG_CONTENT"
        }
      }
    }
  }
}
```

```bash
agentnexus-acp-connector --config ./agentnexus-acp.json
```

## npm CLI and daemon mode

Install from npm after the package is published:

```bash
npm install -g @haowei0520/acp-connector
npm list -g @haowei0520/acp-connector --depth=0
```

新版本发布后，升级已有全局安装：

```bash
npm install -g @haowei0520/acp-connector@latest
agentnexus-acp-connector restart --name opencode-main
```

Install from this repository checkout:

```bash
npm install -g ./packages/agentnexus-bridge-client
npm install -g ./packages/agentnexus-acp-connector
```

Or run from the package source after building:

```bash
cd packages/agentnexus-acp-connector
npm install
npm run build
```

Foreground mode is useful for first-time debugging:

```bash
agentnexus-acp-connector run --config ./agentnexus-acp.json
# Backward-compatible:
agentnexus-acp-connector --config ./agentnexus-acp.json
```

Daemon mode keeps the connector running after the terminal exits. It writes a
PID file plus stdout/stderr logs under `~/.agentnexus/acp-connector/<name>/`.

```bash
agentnexus-acp-connector start --config ./agentnexus-acp.json --name opencode-main
agentnexus-acp-connector status --name opencode-main
agentnexus-acp-connector logs --name opencode-main --lines 200
agentnexus-acp-connector restart --name opencode-main
agentnexus-acp-connector stop --name opencode-main
```

From a source checkout, the same commands can be run through npm:

```bash
npm run daemon:start -- --config ./agentnexus-acp.json --name opencode-main
npm run daemon:status -- --name opencode-main
npm run daemon:logs -- --name opencode-main
npm run daemon:stop -- --name opencode-main
```

Use `AGENTNEXUS_ACP_HOME=/path/to/state` or `--home /path/to/state` to change
where daemon metadata and logs are stored.

## Local operation flow

1. Create or pick an AgentNexus user, then register an Agent Bridge bot with
   ACP metadata:

```bash
curl -X POST http://localhost:8000/docs/agent-bridge/register \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "opencode-main",
    "bridge_provider": "acp",
    "account_username": "alice",
    "account_password": "password",
    "agent_id": "opencode-main",
    "scope": "private"
  }'
```

2. Save the returned `data.acp_connector_config` as a local JSON file. Edit only
   the local ACP agent command, workspace, and environment values, for example:

```json
{
  "accounts": {
    "opencode-main": {
      "botToken": "agb_xxx",
      "controlUrl": "ws://localhost:8000/ws/agent-bridge/control",
      "dataUrl": "ws://localhost:8000/ws/agent-bridge/data",
      "agent": {
        "transport": "stdio",
        "command": "opencode",
        "args": ["acp", "--cwd", "/Users/me/project"],
        "cwd": "/Users/me/project",
        "env": {
          "OPENCODE_CONFIG_CONTENT": "$OPENCODE_CONFIG_CONTENT"
        }
      }
    }
  }
}
```

3. Start the connector from the local machine that can run OpenCode/Claude:

```bash
agentnexus-acp-connector start --config ./agentnexus-acp.json --name opencode-main
```

4. Add the Agent Bridge bot to a channel or DM in AgentNexus, then send
   `@opencode-main hello`. The connector receives the AgentNexus dispatch frame,
   calls the local ACP agent over stdio, and streams `delta`/`done` frames back
   through the existing Agent Bridge WebSocket.

## Receiving AgentNexus files

When a user message in AgentNexus includes attachments, the bridge dispatch
sends file metadata to the connector. The connector then uses the bot token to
hydrate the files on demand:

- parsable document/text attachments (`pdf`, `docx`, `xlsx`, `txt`, `md`,
  `html`) call
  `GET /api/v1/agent-bridge/files/{file_id}/content` and are sent to ACP as
  `resource` content blocks when the agent declares `embeddedContext`
  capability;
- image attachments call
  `GET /api/v1/agent-bridge/files/{file_id}/binary` and are sent to ACP as
  `image` content blocks when the agent declares `image` capability;
- other non-image attachments call
  `GET /api/v1/agent-bridge/files/{file_id}/binary`, are saved under
  `agent.cwd/.agentnexus/attachments/<task_id>/<file_id>/`, and are exposed to
  the ACP agent through a local `file://` resource plus prompt metadata;
- when a capability is missing or hydration fails, the connector falls back to
  the filename and summary metadata in a text block.

This matches OpenCode ACP, which declares both `image` and
`embeddedContext` prompt capabilities during ACP initialization.

Unsupported document types are intentionally not sent as large inline base64
prompt text. The local file handoff lets agents inspect, convert, unzip, or
otherwise process the original bytes with their own tools while keeping the ACP
prompt small. Downloaded inbound attachments are ignored by the output-file
scanner, so an agent echoing the local path will not upload the same input file
back to AgentNexus as a generated result.

入站附件处理摘要：

| 附件类型 | Connector 行为 | ACP 侧结果 |
| --- | --- | --- |
| `pdf`, `docx`, `xlsx`, `txt`, `md`, `html` | 从 `/content` 获取解析文本。 | agent 支持 `embeddedContext` 时发送 `resource.text`，否则发送文本块。 |
| 图片 | 从 `/binary` 获取字节；如果 AgentNexus 已携带 `image_b64`，则直接使用内联图片。 | agent 声明图片能力时发送 `image` content block。 |
| 其他非图片文件，如 `doc`, `xls`, `pptx`, `zip`, `csv`, `cad` | 从 `/binary` 获取原始字节并写入 `agent.cwd/.agentnexus/attachments/...`。 | 本地 `file://` resource，加上包含路径、MIME type、大小的文本块。 |
| 无法 hydrate | 只使用元数据。 | 文件名和摘要 fallback 文本。 |

对于不支持解析的二进制文件，本地保存路径会刻意放在 `agent.cwd` 内。
这让文件访问边界与生成文件上传的工作区边界保持一致，也让 OpenCode 或其他
ACP agent 自己决定如何查看、转换、解压或处理该文件。

## Returning files

ACP `agent_message_chunk` updates can include file-like content. The connector
uploads those files to AgentNexus over the data WebSocket and attaches the
returned `file_id` to the final `done` or `reply` frame.

Supported content shapes:

```json
{
  "sessionUpdate": "agent_message_chunk",
  "content": {
    "type": "resource",
    "resource": {
      "uri": "file:///Users/me/project/report.md",
      "mimeType": "text/markdown"
    }
  }
}
```

```json
{
  "sessionUpdate": "agent_message_chunk",
  "content": {
    "type": "resource",
    "resource": {
      "uri": "file:///tmp/report.md",
      "mimeType": "text/markdown",
      "text": "# Report\n\nGenerated by ACP."
    }
  }
}
```

Inline `text`, `blob`, `data_b64`, and `data:` base64 payloads are supported.
For `file://` URIs without inline content, the file must be inside the
configured `agent.cwd`; this avoids accidentally attaching unrelated local
files.

Some ACP agents, including OpenCode ACP, may create a local file and mention it
in the final text instead of emitting a structured `resource` block. As a
compatibility fallback, the connector also scans the final ACP text for
Markdown links or `file://` links that point inside `agent.cwd` and uploads
newly-created/modified files as AgentNexus attachments.

If the ACP agent needs to create or modify files before returning them, set
`agent.permissionMode` intentionally. The default is `reject`; use `allow` only
for a trusted local workspace.

## Troubleshooting

### 附件提示 "currently only supports pdf/docx/xlsx/txt/md/html"

通常表示旧版 connector 试图通过
`/api/v1/agent-bridge/files/{file_id}/content` 读取不支持解析的文档。
升级 npm 包并重启 daemon 后，不支持解析的非图片文件会改走 `/binary`，
并以本地文件形式交给 ACP agent。

```bash
npm install -g @haowei0520/acp-connector@latest
agentnexus-acp-connector restart --name opencode-main
```

### agent 看到了本地路径，但无法检查文件

确认 `agent.cwd` 存在、可写，并且是 ACP agent 被允许读取的工作区。二进制
入站附件会写到：

```text
<agent.cwd>/.agentnexus/attachments/<task_id>/<file_id>/<filename>
```

如果 ACP agent 有工具权限限制，需要允许该工作区的文件读取，或有意识地调整
connector/agent 的 permission mode。

### connector 无法 hydrate 大文件

`/binary` bridge endpoint 受 AgentNexus 后端上传/读取大小限制约束。超大文件
应通过外部链接、缩小文件体积，或接入自定义后端解析流程。

### 确认当前运行版本

```bash
npm list -g @haowei0520/acp-connector --depth=0
npm view @haowei0520/acp-connector version
```

## Release

The real npm release is tag-driven by
`.github/workflows/release-acp-connector.yml`.

Prerequisite: configure the GitHub repository secret `NPM_TOKEN` with publish
permission for the public `@haowei0520` npm scope.

The workflow publishes packages in this order:

1. `@haowei0520/bridge-client`
2. `@haowei0520/acp-connector`

If the shared bridge client has changed in a way consumers need, bump
`packages/agentnexus-bridge-client/package.json` before tagging the connector.

Runtime changes in this connector are not available to npm users until
`@haowei0520/acp-connector` is published again. For connector-only changes,
such as attachment hydration behavior, bump and publish only
`@haowei0520/acp-connector`; do not bump `@haowei0520/bridge-client` unless its
public API or published package contents changed.

The repository keeps the connector dependency as
`"@haowei0520/bridge-client": "file:../agentnexus-bridge-client"` for local
development. During release, the workflow rewrites that dependency in the
published tarball to the bridge package version, for example `^0.1.0`, so npm
users can install the connector normally.

To release the connector:

```bash
cd packages/agentnexus-acp-connector
npm version patch --no-git-tag-version
cd ../..
VERSION=$(node -p "require('./packages/agentnexus-acp-connector/package.json').version")
git add packages/agentnexus-acp-connector/package.json packages/agentnexus-acp-connector/package-lock.json
git commit -m "chore: release ACP connector v${VERSION}"
git push origin develop
git tag "agentnexus-acp-connector-v${VERSION}"
git push origin "agentnexus-acp-connector-v${VERSION}"
```

The tag must exactly match the connector package version:

```text
agentnexus-acp-connector-v<package.json version>
```
