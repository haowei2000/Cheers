---
name: apple-hig-review
description: >-
  Apple Human Interface Guidelines (HIG) distilled into web-applicable design
  specs, UX principles, and pass/fail review checks. Use this skill whenever
  reviewing or auditing frontend UI, building or restyling components (dialogs,
  panels, sidebars, forms, menus, toasts), doing an accessibility or dark-mode
  pass, or answering questions about spacing, contrast, typography, focus,
  keyboard support, loading/feedback states, modality, or UI copywriting —
  even if the user never mentions "HIG" or "Apple". Also use it before merging
  any PR that adds new visual surfaces.
---

# Apple HIG Design Review

Distilled from ~70 pages of Apple's Human Interface Guidelines
(developer.apple.com/design/human-interface-guidelines) into rules that
transfer to web frontends. Units are translated 1pt → 1px; platform jargon is
translated to web equivalents (Dynamic Type → text scaling / 200% zoom,
VoiceOver → screen reader, Increase Contrast → `prefers-contrast: more`).

**Scope discipline**: HIG governs *behavior, hierarchy, and accessibility
minimums*. If the project has its own visual-token contract (in this repo:
`frontend/DESIGN.md`), that contract wins on token specifics — which hue,
which radius, which shadow. This skill wins on UX behavior and on
accessibility floors, which are never negotiable downward. When the two seem
to conflict, the resolution is almost always "keep the project's look, fix
the behavior."

## The ten laws

The compressed model behind every specific check. When a situation isn't
covered by an explicit rule, reason from these.

1. **Hierarchy through restraint.** Prominence is a scarce resource: one
   accent-filled primary action per view, ≤3 type levels per view, emphasis
   steps of exactly one weight (Regular→Semibold). Spreading emphasis
   destroys it.
2. **One color, one meaning.** A color that marks interactivity or status is
   never reused decoratively — users learn false affordances. Name colors by
   semantic role, never by hue.
3. **Never a single channel.** Color needs a shape/text/position backup;
   audio needs visual cues; gestures and hover need visible button
   equivalents; motion is never the sole carrier of information.
4. **Chrome floats, content rules.** Sidebars/headers/toolbars are a distinct
   layer that content scrolls beneath; translucency belongs only on chrome.
   Chrome stays monochrome so content carries the color.
5. **Feedback is a contract.** Every action produces perceivable response:
   skeletons render immediately, indicators scope to the affected region,
   failures always surface with a reason, success confirms only when
   significant. A blank region reads as breakage.
6. **Modality is expensive.** A modal suspends the user's mental context —
   reserve it for critical info, confirmations, or one narrow task. Shallow,
   titled, honest exits (Esc + Cancel), confirm before discarding user input.
7. **Reversibility over confirmation.** Prefer undo to "Are you sure?".
   Confirm only what genuinely can't be undone; never confirm actions whose
   loss is the expected result.
8. **Consistency is a learned grammar.** Standard gestures, shortcuts,
   icon variants (outline=default, fill=selected), and component semantics
   (select shows state; menu performs actions) transfer between apps —
   repurposing them breaks the user's model. Same data, same chart/color
   everywhere.
9. **Respect user settings.** `prefers-color-scheme`, `prefers-reduced-motion`,
   `prefers-contrast`, 200% zoom — honoring these is the contract that makes
   an app feel native. An app that ignores them reads as broken.
10. **Words are UI.** Verbs on buttons, the fix stated in the error, "you"
    never "the user", no jargon, no blame, no "oops". If copy can't fix a
    common error, redesign the interaction.

## Hard specs — the numbers

The non-negotiable measurables. Full tables live in the reference files.

| Check | Value |
|---|---|
| Text contrast (normal) | ≥ 4.5:1, in **both** themes; custom pairs target 7:1 |
| Text contrast (large: ≥18px, or ≥14px bold) | ≥ 3:1 |
| Hit area of interactive elements | ≥ 44×44px, even when the glyph is smaller |
| Padding around bare icon buttons | ~24px to visible edge (bezel-less); ~12px if bezeled |
| Body text size | ≥ 13px desktop UI; 11px absolute floor for meaningful content |
| Line height | 1.2–1.35 × font size for anything that can wrap |
| Type hierarchy | ≤ 3 levels per view; one weight step for emphasis |
| Text scaling | Layout survives 200% zoom — no clipping, overlap, or loss |
| Prominent (filled) buttons | 1–2 per view, max; never destructive as keyboard default |
| Launch to interactive | ≤ ~2s; show skeleton if content load exceeds ~1s |
| Animation | 60fps target; `transform`/`opacity` only; brief; interruptible |
| Sustained oscillation | avoid ~0.2Hz (one cycle/5s) — physiologically uncomfortable |
| Transient layers | one popover / one sheet at a time; only an alert may stack above |
| Raster assets | ship ≥2× CSS size (srcset) for HiDPI; prefer vectors + `currentColor` |
| Icon canvas | glyph fills ~80%, ~10% margin per side; legible at 16×16 |

## Review workflow

Run this when auditing an existing UI (for building new UI, read the matching
reference file *first*, then build).

1. **Inventory surfaces.** List the pages, dialogs, panels, menus, and
   composite widgets in scope. For a diff review, list only surfaces the diff
   touches — but always check both themes and keyboard path even for small
   diffs.
2. **Pick dimensions and load references.** Use the table below. Load only
   the files matching the surfaces in scope — each is self-contained.
3. **Audit code first, live UI second.** Grep-able violations (contrast
   tokens, missing focus styles, `outline-none`, hit-area paddings, missing
   `aria-*`, hardcoded colors) come from the source. Behavior violations
   (focus order, loading feel, modal stacking, state restoration) need the
   running app — drive it if available, and say so in the report if not.
4. **Classify every finding** with severity, the law/spec violated, evidence
   (`file:line` or screenshot), and a concrete fix:
   - `[A11y]` — accessibility floor violated (contrast, keyboard, focus,
     zoom, reduced-motion). These block.
   - `[UX]` — behavior contradicts a HIG pattern (feedback, modality,
     selection semantics, destructive defaults). Fix before merge.
   - `[Polish]` — hierarchy/consistency drift (extra type levels, accent
     overuse, inconsistent empty states). Batch into cleanup.
5. **Verify before reporting.** For each finding, re-read the code in
   context — components often satisfy a rule at a different layer (a shared
   `<Button>` may carry the focus ring). Report only confirmed findings.

## Reference files

| Read | When auditing / building |
|---|---|
| [references/foundations.md](references/foundations.md) | color, dark mode, typography, layout & adaptivity, materials, icons, motion, writing & tone, accessibility |
| [references/patterns.md](references/patterns.md) | feedback, loading, launching, data entry, modality, search, settings, help, onboarding, charts, drag & drop, file management, undo/redo, accounts, collaboration |
| [references/components.md](references/components.md) | text/labels, lists & tables, collections, disclosure, split views, tab views, sidebars, tab bars, search fields, token fields |
| [references/controls.md](references/controls.md) | buttons, menus, toolbars, context menus, alerts, sheets, popovers, panels, windows, scroll views, text fields, toggles, pickers, segmented controls, sliders, progress indicators |
| [references/interaction.md](references/interaction.md) | keyboard support & shortcuts, focus & selection, gestures, pointer/hover behavior |

Each file keeps a per-topic structure — **Principles / Specs / Do / Don't /
Web review checks** — plus a quick-scan spec table at the end. The "Web
review checks" bullets are written to be directly pass/fail-able.

## The 20-point core checklist

The checks that catch ~80% of violations. Use as the minimum pass for any
diff that touches UI; escalate to the full reference files for new surfaces.

1. Contrast ≥4.5:1 normal / ≥3:1 large text — verified in light **and** dark.
2. Every interactive element has a ≥44×44px hit area.
3. No information carried by color alone (status dots, chart series, errors).
4. Visible focus indicator on every focusable element; no `outline-none`
   without a ring replacement.
5. Complete keyboard path: logical tab order, Esc dismisses, Enter never
   triggers a destructive action by default.
6. Layout survives 200% zoom / enlarged root font.
7. Body/content text ≥13px; nothing meaningful below 11px.
8. ≤3 type levels per view; emphasis = one weight step up.
9. Accent used by scarcity: one filled primary action per view.
10. Dark mode is a designed palette (elevated surfaces get *lighter*), not an
    inversion; both themes honor `prefers-color-scheme` live.
11. `prefers-reduced-motion` collapses movement to fades; no motion as the
    only state signal.
12. Loading: immediate skeleton/placeholder, indicator scoped to the region,
    rest of the app stays interactive; determinate bar once duration is knowable.
13. Failures always explain what happened and how to fix it, inline, next to
    the problem.
14. Modals: single narrow task, title, Esc + explicit Cancel, confirm-discard
    when closing loses user input.
15. One transient layer at a time; closing returns focus to the invoking
    element.
16. Destructive actions: never the primary/default button; undo preferred
    over confirmation; irreversible-only confirmations.
17. Empty states explain what the area is for and offer the next action.
18. Every field has a persistent label — placeholder is not a label;
    validation fires when the fix is cheapest (on blur / pre-submit).
19. Every drag, hover-reveal, or shortcut has a visible clickable equivalent.
20. Selection semantics: navigation lists persist highlight; option lists
    checkmark; never mixed.

## Reporting format

```
## HIG review — <scope>

### [A11y] <rule violated>
- Evidence: <file:line or screenshot> — <what was observed>
- HIG: <law or spec, e.g. "contrast ≥4.5:1 (foundations/color)">
- Fix: <concrete change>

### [UX] ...
### [Polish] ...

Passed: <dimensions checked and found clean — say what was verified, not just what failed>
Not verified: <what needed a live app / other themes / etc.>
```

Findings without evidence or a concrete fix aren't findings — drop them.
