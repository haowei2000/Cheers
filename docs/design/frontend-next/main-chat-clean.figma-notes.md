# Cheers Main Chat Mockup - Figma Notes

> **Status:** 📝 Draft / Proposal — visual direction draft, not yet implemented; may change without notice.
> File: `main-chat-clean.svg`
> Date: 2026-06-02

This mockup is intended to be imported into Figma as a first visual direction for
`frontend-next`.

## Direction

The current design problem was:

- too much information shown at once
- too many colors competing for attention
- insufficient hierarchy between base content and operational controls

This version reduces the design to a quiet workbench:

- base chat content is the deepest layer
- controls float above the base layer
- color is mostly neutral
- blue is the only primary action color
- amber is reserved for approval/waiting states
- green is reserved for connected/healthy states
- red is intentionally absent in the mockup except for future destructive states

## Palette

| Token | Value | Use |
|---|---|---|
| `surface.page` | `#F6F7F9` | whole app background |
| `surface.base` | `#FBFCFD` | main chat base layer |
| `surface.panel` | `#FFFFFF` | floating panels |
| `surface.soft` | `#F8FAFC` | subtle rows and icon buttons |
| `border.default` | `#E4E7EC` | panel borders |
| `text.primary` | `#182230` | titles and important text |
| `text.secondary` | `#344054` | body text |
| `text.muted` | `#667085` | labels |
| `text.faint` | `#98A2B3` | metadata |
| `accent.primary` | `#2563EB` | selected state, send button, live stream |
| `accent.primarySoft` | `#EFF6FF` | selected row background |
| `state.approval` | `#D97706` | approval pending |
| `state.approvalSoft` | `#FFFDF7` | approval card |
| `state.success` | `#16A34A` | connected/healthy |

## Layer Model

1. `base-chat-layer`
   - quiet timeline
   - message stream
   - live delta indicator
   - approval card embedded as timeline event

2. `workspace-rail`
   - icon-only global navigation
   - selected item visible through blue soft background
   - hover tooltip sample included

3. `channel-list-panel`
   - compact list of projects and agents
   - minimal copy
   - status dots only where state changes

4. `floating-route-header`
   - answers "where am I?"
   - provides back affordance
   - exposes live connection state

5. `right-inspector`
   - operational context
   - BridgeSession / ACP session / trace / files
   - mostly short labels and icons

6. `floating-composer`
   - action layer above the chat
   - icon-first controls
   - one primary send action

## What Was Intentionally Removed

- large explanatory blocks
- multiple saturated colors
- decorative gradients
- huge cards around the main content
- duplicate status text in several places
- marketing-style hero composition

## Next Figma Iteration

For the next version:

1. Use `main-chat-full-base.svg` as the preferred direction because the base
   content fills the full workspace instead of sitting inside a centered panel.
2. Turn each SVG group into a named Figma frame/component.
3. Create component variants for:
   - live message
   - idle message
   - approval pending
   - approval resolved
   - inspector running/ready/failed
   - icon button default/hover/focus/disabled
4. Create a mobile adaptation:
   - left rail becomes bottom nav or compact drawer
   - channel list and inspector become sheets
   - composer remains floating above bottom safe area
