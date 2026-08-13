# Tool Presentation Design

> Implementation target: Web, macOS, and iOS consume the same wire type with
> platform-native presentation.

## Selected direction

Global control, typography, and message-surface rules are defined in
[Web Editorial Item System](WEB_EDITORIAL_ITEM_SYSTEM.md). This document owns
only tool classification and detail presentation.

The tool row is one quiet, continuous surface. It does not use timelines,
connectors, table grids, row separators, nested outlines, or decorative badges.
Hierarchy comes from spacing, typography, opacity, and alignment.

- The activity row contains the tool icon, operation, short target, terminal state,
  and one disclosure affordance.
- The detail surface contains branch/context, a compact result list, and text
  disclosures for the command or diff.
- Green is reserved for success/additions; muted red is reserved for
  failures/deletions. All other tool categories remain neutral.
- Desktop may align secondary metadata to the right. At narrow widths paths wrap,
  metadata stacks, and controls retain a minimum 44-point hit target.

## Unified parsing boundary

The Gateway owns source classification and emits `TraceEvent.data.presentation`.
Its v2 `event_type` is the only display-routing field. Web, macOS, and iOS map
that exact enum to platform-native components; they do not infer a display type
from family, operation, title, command content, or separate regular expressions.

```text
ACP producer payload
  -> Gateway alias/command matching
  -> ToolPresentation v2 (`event_type`)
  -> Web parser -> React renderer
                -> macOS Tauri webview (same renderer)
                -> iOS parser -> native SwiftUI renderer
```

The interactive reference is [tool-presentation-prototype.html](tool-presentation-prototype.html).
The wire-level contract is documented in
[TOOL_PRESENTATION.md](../arch/TOOL_PRESENTATION.md).

## iOS direction

Use a compact chat summary, then progressive disclosure inside the existing
native trace presentation:

1. The bot message owns only the current live `Git status · 4 files changed`
   activity row. It remains quiet and disappears after completion; durable
   history belongs to Message Record.
2. Tapping the row opens the existing resizable activity sheet. If Git is the
   only meaningful event, open its detail directly; otherwise keep the agent
   activity list as the first level.
3. Git detail is pushed inside the sheet's `NavigationStack`. Changed-file rows
   remain non-interactive until the backend includes a structured diff payload or
   queryable repository context in the event contract.

This combines the context preservation of an iOS sheet with the predictable
hierarchy of native push navigation. The sheet is a scoped inspection task, not
a second app navigation system.

### Native component map

| Need | SwiftUI component | Use |
| --- | --- | --- |
| Keep chat context | `.sheet` + `.presentationDetents([.medium, .large])` | Retain the current trace container and visible drag indicator. |
| Drill into Git | `NavigationStack`, `navigationDestination` | Agent activity -> Git summary. Add file navigation only when its destination is backed by event data. |
| Compact activity summary | `Button` + `Label`/SF Symbol | `arrow.triangle.branch`, title, count, state, and one chevron. |
| Sparse repository summary | `ScrollView` + `LazyVStack` | Avoid the default separators and grouped cards of `List` while keeping native scrolling and Dynamic Type. |
| Empty, clean, and failed states | `ContentUnavailableView` | Working tree clean, unavailable repository, and loading failure. |
| Secondary action | Inline borderless `Button` with a 44-point hit target | `Copy command` follows the command context without creating a bottom-bar shape. |
| Command copy/share | selectable system-font `Text`, `Button`, optional `ShareLink` | Preserve the exact command and working directory without introducing another typeface. |

Use `Theme` system semantic colors and spacing. Keep `.systemBackground`,
`.secondary`, `.tertiary`, Dynamic Type, Reduced Motion, Increased Contrast,
and the existing 44-point hit floor. Branches, paths, commands, and ordinary
labels all use the existing system font hierarchy.

### Git detail anatomy

- Inline navigation title: `Git status`.
- First row: branch SF Symbol, `Done`, and `4 files changed`.
- Repository context: branch name, then `1 staged · 2 unstaged · 1 untracked`.
- Changed files: one status character plus a middle-truncated path. Green is
  reserved for added/untracked files; red for deleted files; modified and
  renamed files remain neutral.
- Command: `git status --short --branch` with `cwd: /repo/Cheers`, selectable
  and copyable without an outlined code card.
- Inline action: `Copy command`. `View diff` is intentionally absent until the
  backend provides the data needed to render it.

The specialized Git detail replaces the generic `Form` presentation for Git
events. Generic tool events can continue using `TraceDetailView`.

### GitHub Mobile reference

GitHub Mobile is useful as an information-architecture reference, not a visual
template. Its current code-review flow keeps an inline navigation title, pins
the current filename above a single-column diff, and places review actions near
the bottom. Cheers should adopt those three behaviors while keeping its own
quieter, borderless styling.

Do not copy GitHub Mobile's heavier comment cards, grouped control capsules, or
repository-specific review controls. A tool trace is primarily evidence of what
the agent did; it is not a pull-request review client.

References:

- [Apple HIG: Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
- [Apple HIG: Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)
- [SwiftUI presentation modifiers](https://developer.apple.com/documentation/swiftui/view-presentation)
- [GitHub Mobile code review update](https://github.blog/changelog/2026-02-03-github-mobile-comment-on-unchanged-lines-in-pull-request-files/)
