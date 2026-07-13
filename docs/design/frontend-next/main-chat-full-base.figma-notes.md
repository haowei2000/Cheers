# Cheers Main Chat Mockup - Full Base Layer Notes

> **Status:** 📝 Draft / Proposal — visual direction draft v2, not yet implemented; may change without notice.
> File: `main-chat-full-base.svg`
> Date: 2026-06-02

This version updates the layout rule:

```text
Base content fills the entire available space and sits at the deepest layer.
```

The previous mockup treated chat as a centered panel. This version makes the
chat/timeline/workbench surface the full canvas. Sidebars, route header,
inspector, and composer are floating layers above it.

## Key Differences From v1

- removed the centered chat panel container
- base timeline extends edge-to-edge behind all floating UI
- added subtle full-canvas grid and timeline guide lines
- floating surfaces use opacity and shadow so the base remains visually present
- chat content is positioned directly on the canvas, not inside a card

## Layer Rule

1. **Deepest layer**: full-space chat/workbench content
2. **Navigation layer**: workspace rail and channel list
3. **Orientation layer**: floating route header
4. **Action layer**: floating composer and contextual controls
5. **Context layer**: right inspector
6. **Temporary layer**: popovers, menus, sheets, modals

This should be the default mental model for `frontend-next`.

