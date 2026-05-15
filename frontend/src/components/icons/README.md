# AgentNexus icon system

Use this folder as the only frontend entry point for icon libraries. Feature
components should import from `components/icons`, not from third-party icon
packages directly.

## Categories

| Category | Component | Library | Status | Usage |
| --- | --- | --- | --- | --- |
| Main icons | `AppIcon` | `lucide-react` | Required, installed | Core UI: channels, messages, send, search, settings, notifications, attachments, bots, users, memory, admin. |
| AI brand icons | `AiBrandIcon` | `@lobehub/icons` | Required, installed | OpenAI, Claude, Anthropic, Gemini, DeepSeek, Mistral, Qwen, Ollama, Hugging Face, and other AI/LLM providers. |
| File-type icons | `FileTypeIcon` | `react-file-icon` | Required, installed | Chat attachments and file previews such as PDF, DOCX, XLSX, PPTX, PNG, ZIP, Markdown, JavaScript, and similar files. |
| Other icons | `OtherIcon` / `BrandIcon` | `simple-icons` | Optional, installed | General brand and technology logos such as GitHub, Docker, Google, Slack, Microsoft, AWS, and future non-core icon families. |

## Optional families

These libraries are intentionally not core dependencies yet:

| Family | Library | Use when |
| --- | --- | --- |
| Office file icons | `@fluentui/react-file-type-icons` | Enterprise-style Word, Excel, PowerPoint, and SharePoint icons are needed. |
| Code file/tree icons | `material-icon-theme` or `vscode-icons-js` | Repository file trees or code package previews need detailed file recognition. |
| Extended business icons | `@tabler/icons-react` | Lucide does not cover a specialized workflow, database, deployment, model, or dashboard icon. |
| Compact admin icons | `@radix-ui/react-icons` | Dense admin buttons, menus, or table actions need a smaller visual system. |
| Fallback/prototype icons | `@iconify/react` | A rare icon is needed during prototyping. Avoid making this a core dependency. |

## Rules

- Prefer `AppIcon` for all ordinary UI controls and navigation.
- Use `AiBrandIcon` only for AI model or provider identity.
- Use `FileTypeIcon` for attachment/file cards instead of generic document icons.
- Use `BrandIcon` or `OtherIcon` for non-AI brand logos.
- Add new semantic names to `AppIcon` before importing another UI icon library.
- Keep brand logos visually subordinate to AgentNexus branding. Icon packages provide assets, not trademark permission.
