# Inline Workspace Reference QA

- Source visual truth: `/var/folders/tn/l7kr202d20q7j7rcxdy62pwc0000gn/T/codex-clipboard-6f99d20c-066b-458c-9d29-9471aae3c60b.png`
- Implementation: `http://127.0.0.1:4175/dev/item-gallery.html`
- Viewport: 1280 × 720 CSS px, device scale factor 1
- Source pixels: 1678 × 886; implementation pixels: 1280 × 720. Comparison focused on the inline-reference region rather than absolute page geometry.
- State: dark theme, inline workspace references rendered inside reading prose

## Full-view comparison evidence

The source showed path-like inline code replaced by repeated fixed-width `Open` buttons, which broke sentence flow and hid every actual reference. The implementation keeps the same reading structure while rendering each original path inline.

## Focused region comparison evidence

- Typography: references use the approved utility monospace role at the inherited four-tier text size; surrounding copy stays in the reading face.
- Spacing/layout: references remain baseline-aligned and content-width; no action slot or control-height box interrupts the sentence.
- Colors/tokens: zinc semantic fill and indigo link/focus colors match the existing dark editorial palette.
- Image/assets: no image asset is involved.
- Copy/content: `/workspace/Cheers`, `codex/fix-inline-workspace-links`, and `frontend/src` remain visible verbatim. `Open … in the remote workspace` is limited to the accessible name and tooltip.
- Interaction/accessibility: each reference is a semantic link, retains the existing click callback, exposes a full accessible name, and has keyboard focus styling.
- Browser console: no errors.

## Comparison history

1. P1: paths were replaced by repeated `Open` Action Buttons. Fixed by introducing `InlineReference` and using it in `MarkdownRenderer`.
2. Post-fix evidence: Gallery shows all three references inline without layout interruption; DOM inspection found three `data-inline-reference` links and no console errors.

## Findings

No remaining P0/P1/P2 mismatch for this component.

## Follow-up polish

None required.

final result: passed

