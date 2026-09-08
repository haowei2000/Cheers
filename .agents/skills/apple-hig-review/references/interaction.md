# HIG Interaction — gestures, keyboard, pointing devices, focus & selection

Apple HIG input-and-interaction guidance translated for reviewing React web frontends: what gestures, keyboard support, pointer/hover behavior, and focus/selection handling must look like to pass a design review.

## Contents

- [Cross-cutting principles](#cross-cutting-principles)
- [Gestures](#gestures)
- [Keyboard support & shortcuts](#keyboard-support--shortcuts)
- [Pointing devices & hover](#pointing-devices--hover)
- [Focus & selection](#focus--selection)
- [Quick-scan spec table](#quick-scan-spec-table)

---

## Cross-cutting principles

These recur across multiple HIG input pages; treat a violation of any of them as a finding regardless of which topic it surfaces under.

1. **Input redundancy.** No important action may depend on a single input mode. Gestures, hover reveals, and shortcuts are accelerators over visible, keyboard-reachable controls — never the sole path. (Appears under Gestures, Keyboards, and Pointing devices.)
2. **Respect the system's vocabulary.** Standard gestures, standard shortcuts, and standard cursor shapes carry meanings users learned elsewhere. Repurposing any of them — click, swipe, Cmd/Ctrl+Z, the I-beam — spends user trust for zero gain. Never collide with browser/OS-reserved interactions (back/forward swipe, pinch-zoom, Cmd/Ctrl+W/T/N/L, native scroll and text selection).
3. **State must be visible.** Disabled controls look disabled, in-progress gestures show live feedback, hover confirms interactivity, focus is always indicated. Any interaction whose failure or target is invisible is a defect: people blame themselves or assume the app is broken.
4. **Consistency across modes and instances.** The same modifier does the same thing with mouse, keyboard, and touch (Shift extends, Alt duplicates); the same component class gets the same hover recipe everywhere; the same list behaviors (Shift-click, arrow keys) work in every list.
5. **User-initiated only.** Focus never moves, views never open, and content never shifts as a side effect of app state changes. The user's point of control is sacred; the only sanctioned exception is relocating focus when its current target is destroyed.

---

## Gestures

### Principles

- Gestures are direct manipulation, and people carry expectations for them across every app: click/tap activates or selects, swipe/wheel scrolls, drag moves. Repurposing a familiar gesture for an app-unique action — or inventing a new gesture for a standard action — breaks those expectations and erodes trust in the whole interface.
- A gesture must never be the *only* way to perform an important action. People may prefer or need other inputs (keyboard, screen reader, switch access), so gestures are accelerators layered on top of visible controls. An edge-swipe or keyboard shortcut to go back supplements a visible Back button; it never replaces it.
- Feedback must be immediate and continuous. While a gesture is in progress, the UI should help people predict its result (drag ghost, drop indicator, swipe follow-through). If a gesture is unavailable — a locked object, a disabled control — the UI must show that state visibly. Silent failure makes people conclude the app is frozen or that they did something wrong.
- Custom gestures are reserved for frequent, specialized tasks. They must be discoverable, easy to perform, visually/mechanically distinct from other gestures, and must never conflict with system-level gestures — on the web that means browser back/forward swipes, native scroll, pinch-zoom, and text selection.
- Learnability smell test: if a gesture is hard to describe in a simple sentence plus one picture, it will be hard for people to learn. Treat description difficulty as a design defect, not a documentation problem.
- Don't require physically demanding input. The HIG rule "never require a specific hand or both hands" transfers to web as: never require multi-touch, chorded input, or high-precision drags without an alternative path.

### Specs

None — this topic is qualitative. (Target-size and hit-region numbers live under [Pointing devices & hover](#pointing-devices--hover).)

### Do

- Offer multiple input paths for every task: pointer, keyboard, and touch where applicable.
- Respond to in-progress gestures with live feedback — drag previews, drop-target indicators, resize outlines that track the pointer.
- Visually distinguish disabled/locked states from enabled ones so a failed interaction is explainable at a glance.
- Keep shortcut gestures as supplements to visible buttons and menu items.

### Don't

- Don't repurpose click/tap, swipe, or drag for nonstandard actions, and don't invent a custom gesture for an action that already has a standard one.
- Don't create gestures that collide with system/browser gestures — e.g., horizontal drag handlers near viewport edges that fight browser back/forward swipe.
- Don't gate any important action behind a gesture with no button or keyboard equivalent.
- Don't require multi-touch or precision dragging with no alternative.

### Web review checks

- [ ] Every drag/swipe/long-press interaction (reorder, dismiss, panel resize) has a click/button/keyboard alternative.
- [ ] Disabled controls are visually distinct — reduced opacity or muted color AND `cursor: default`/`not-allowed` plus `disabled`/`aria-disabled` — not silently inert.
- [ ] Drag operations render live feedback: a drag ghost/preview and a visible drop-target indicator while dragging.
- [ ] No custom handler hijacks native scroll, text selection, or browser back/forward swipe zones (audit `preventDefault` on wheel/touch/pointer events).
- [ ] Click means activate/select everywhere; no element uses click for a surprising app-unique action.
- [ ] Hidden interactions (hover-to-reveal, swipe-to-reveal) are discoverable via a visible affordance or a documented shortcut/help list.

---

## Keyboard support & shortcuts

### Principles

- Keyboard users transfer shortcut knowledge between apps. Standard shortcuts (Cmd/Ctrl+C, X, V, Z, A, F…) are shared vocabulary: repurposing one for a different action confuses people. Only redefine a standard shortcut if its conventional action genuinely does not exist in your app.
- Full keyboard operability is the accessibility baseline, not an enhancement. People must be able to reach, navigate, and activate every window, menu, and control using only the keyboard.
- Shortcut budget: too many custom shortcuts makes an app feel hard to learn. Define custom shortcuts only for the most frequently used app-specific commands.
- Modifier conventions are semantic, not arbitrary: Shift constrains or extends (extend selection, constrain drag axis); holding an arrow key repeats movement by the smallest unit. Consistent modifier semantics let people predict combined behaviors they've never tried.
- Never build a new shortcut by adding a modifier to an existing shortcut for an *unrelated* command. Shift+Cmd+Z is expected to be Redo — assigning it to anything else is hostile.
- International layouts are a correctness issue: modifier+punctuation and modifier+number combos may be physically unreachable or produce different characters on non-US keyboards (e.g., Option/Alt-5 types "{" on French layouts). Cmd/Meta (and Ctrl on Windows/Linux) is the safest modifier across layouts; pair other modifiers only with alphabetic keys.

### Specs

- Modifier display order when writing out a shortcut: Control, Option, Shift, Command — web equivalent: **Ctrl, Alt, Shift, Cmd/Meta**.
- Never add Shift to a shortcut that uses the upper character of a two-character key: Help is **Cmd-?** (written with "?"), not Shift-Cmd-/.
- Cmd (Meta) is the safest modifier across international keyboard layouts; non-Cmd modifiers combined with non-alphabetic characters may be unavailable (Option-5 = "{" on French keyboards) — restrict non-Cmd modifiers to alphabetic keys.

### Do

- Support full keyboard navigation and activation for every interactive element (Tab to reach, Enter/Space to activate, Esc to dismiss).
- Keep standard shortcuts mapped to their standard actions.
- Localize/mirror shortcuts for RTL and non-US layouts where relevant.
- Give shortcuts descriptive names in any shortcut-help UI — each title must convey its action without surrounding menu context (write "Delete conversation", not "Delete").

### Don't

- Don't override browser/OS-reserved shortcuts (Cmd/Ctrl+W, T, Q, L, N…) — users lose tabs and windows, and trust.
- Don't define many custom shortcuts; keep them to frequent commands only.
- Don't pair non-Cmd/Ctrl modifiers with punctuation or number keys that vary by keyboard layout.
- Don't reuse a standard-shortcut-plus-modifier combo for an unrelated command.

### Web review checks

- [ ] The entire app is operable keyboard-only: Tab reaches every control, Enter/Space activates, Esc closes overlays. Verify with a real Tab walk-through, not code inspection alone.
- [ ] Custom shortcut handlers check `e.metaKey`/`e.ctrlKey` correctly per platform and never `preventDefault` on browser-reserved combos (Ctrl/Cmd+W/T/N/L).
- [ ] Standard editing shortcuts (Cmd/Ctrl+C/X/V/Z/A, Shift+Cmd/Ctrl+Z for Redo) behave normally in text inputs — especially the main composer — and are not repurposed.
- [ ] Displayed shortcuts list modifiers in canonical order (Ctrl, Alt, Shift, Cmd) and show the upper character ("?" not "Shift+/").
- [ ] A discoverable shortcut reference exists (e.g., "?" opens a shortcut sheet) with descriptive action names.
- [ ] Shortcuts on punctuation keys are Cmd/Ctrl-only or verified against non-US layouts; bindings use `e.key` where character identity matters (be wary of `e.code`-based punctuation bindings, which map physical positions that differ per layout).

---

## Pointing devices & hover

### Principles

- People move fluidly between input modes (mouse, trackpad, keyboard, touch) and expect the same behavior from each. Don't make them learn per-input interactions, and keep modifier-key behavior identical across input types (Alt-drag duplicates whether by mouse or touch).
- The pointer and the element under it cooperate to signal interactivity. Hover effects (highlight, lift, subtle tint/shadow) confirm the target; the cursor shape itself is a communication channel — I-beam over text, resize arrows on edges. A wrong or missing cursor breaks the affordance as surely as a missing hover state.
- Hover feedback must be meaningful, not decorative. People assume any visual change means something; gratuitous pointer/hover effects distract and irritate because they promise meaning and deliver none.
- Hit regions extend beyond visible bounds. Comfortable invisible padding around targets makes pointing feel forgiving; adjacent bar buttons need *contiguous* hit regions so the cursor doesn't flicker back to default in the gaps between them.
- Let the pointer reveal auto-hidden chrome: hovering over minimized/faded toolbars or media controls should bring them back. Hiding controls is fine; making them unrecoverable by hover is not.

### Specs

- Hit-region padding: **~12px** of invisible padding around interactive elements that have a bezel/visible border; **~24px** around the visible edges of borderless elements (bare icon buttons). (pt→px 1:1.)
- Minimum comfortable target: **44×44px** effective hit area for icon buttons — a smaller visible glyph is fine if padding brings the target to a comfortable size per the 12/24px rule.
- Hover-effect composition rules:
  - Scale only when the element has room to grow without crowding neighbors — **never scale table/list rows**.
  - Tint-only hover for tightly packed elements.
  - **Never shadow without scale** — shadow alone reads as broken elevation.
  - Lift-style hover must use the element's real corner radius so the effect matches its actual shape.

### Do

- Add generous invisible hit area (padding, not margin) around small icon buttons.
- Make hit regions of adjacent toolbar/sidebar buttons contiguous.
- Use one system-consistent hover treatment per component class for elements that behave like standard controls.
- Keep modifier semantics identical across input types.
- Consider informative hover annotations where they carry data — dimensions while resizing a panel, values over a chart point.

### Don't

- Don't create decorative hover/cursor effects with no meaning.
- Don't attach instructional text to the cursor — needing it signals a confusing interface; fix the interface instead.
- Don't scale list rows or crowded elements on hover.
- Don't redefine systemwide pointer gestures (native scroll, pinch-zoom, swipe-back).

### Web review checks

- [ ] Icon buttons have at least a 44×44px effective hit area, or a smaller glyph with padding making the target comfortable (~12px padding for bordered controls, ~24px for borderless icons).
- [ ] Adjacent toolbar/sidebar icon buttons have contiguous hit areas — no dead gaps where the cursor loses hover state between buttons.
- [ ] Cursor semantics are correct: `cursor: pointer` on all clickable elements, `cursor: text` only over text-entry/selectable regions, resize cursors on panel-resize handles, `default`/`not-allowed` on disabled controls.
- [ ] Every interactive element has a hover state, and each component class uses one consistent recipe app-wide (same tint/underline treatment; no one-off effects).
- [ ] Hover effects never scale tightly packed rows; row hover uses background tint only, and no hover uses shadow without scale.
- [ ] Auto-hidden or fade-out controls (message action buttons, collapsed toolbars) reappear on hover of their region.
- [ ] Modifier+interaction combos behave consistently across the app (e.g., Shift-click extends selection in every list that supports selection).

---

## Focus & selection

### Principles

- Focus is how people visually confirm what their next interaction will target; it is the anchor of keyboard navigation. Removing or obscuring the focus indicator leaves keyboard users lost — this is the single most common web failure in this topic.
- Focus and selection are distinct states when auto-selection would cause a distracting context shift: focusing a list item must not open a new view. Activation is a separate, deliberate act (Enter/Space/click).
- Never move focus without user interaction — people must hunt for the relocated indicator, which interrupts their task. The one exception: when the focused item disappears (deleted, closed), move focus to a predictable adjacent item; if no sensible target exists, hide the indicator rather than teleport it somewhere arbitrary.
- Focus traverses the UI in reading order (leading→trailing, top→bottom) and in coherent groups: Tab jumps *between* regions (sidebar, list, main pane); arrow keys move *within* a region. When a group receives focus, its primary/most-likely item should receive focus first — not necessarily its first DOM child.
- Indicator style follows content type: a focus ring suits text/search fields and freestanding controls; a full-row background highlight is easier to read in lists and collections.

### Specs

- **Tab** = move between focus groups/regions; **arrow keys** = directional movement within a group (roving tabindex or `aria-activedescendant`).
- Focus traversal order: reading order — leading to trailing, top to bottom (mirror for RTL).
- Focused/active list item: text switches to white/on-accent color on an **accent-color background**; unfocused or inactive selection degrades to **standard text on a gray/neutral highlight** — visibly selected, visibly not focused.
- Focus ring (halo) must match the element's actual contour — same corner radius/shape — and must not be clipped by parent containers (`overflow: hidden`) or occluded by siblings (badges may need to layer above it).

### Do

- Rely on platform-native focus visuals (`:focus-visible` outline) or a single consistent custom ring across the app, visible in both light and dark themes.
- Use a ring for inputs and freestanding controls; use full-row highlight for list/collection items.
- Give each panel/region a sensible primary item that receives focus when the region is focused.
- On deletion of the focused item, move focus to the next/previous sibling (or the list container if the list is now empty).

### Don't

- Don't change focus programmatically as a side effect — after a data refresh, on an unrelated state change, or when async content arrives.
- Don't suppress focus outlines (`outline: none`) without an equally visible replacement.
- Don't auto-open views or navigate merely because an item became focused.

### Web review checks

- [ ] No global `outline: none` / `:focus { outline: 0 }` without a `:focus-visible` replacement of equal or greater visibility, verified in both light and dark themes.
- [ ] Focus rings are not clipped by `overflow: hidden` ancestors and match the control's border-radius.
- [ ] Tab order follows visual reading order (e.g., sidebar → chat → panels); composite widgets (message list, conversation list, menus) are single Tab stops with arrow-key navigation inside (roving tabindex or `aria-activedescendant`).
- [ ] Active selection in lists uses accent background + on-accent text; when the list loses focus, selection degrades to a gray/neutral highlight rather than disappearing or staying full-accent.
- [ ] Deleting or closing the focused item (conversation, panel, message) moves focus to an adjacent item or the list container — focus never falls to `<body>`.
- [ ] Focusing an item never triggers navigation or opens a panel by itself; activation requires Enter/Space/click.
- [ ] Async updates (incoming messages, refetches) never steal focus from the composer or the currently focused element.

---

## Quick-scan spec table

| Spec | Value | Topic |
|---|---|---|
| Hit-region padding around bordered/bezeled controls | ~12px | Pointing devices & hover |
| Hit-region padding around borderless controls (bare icon buttons) | ~24px | Pointing devices & hover |
| Minimum effective hit area for icon buttons | 44×44px | Pointing devices & hover |
| Hover scale on table/list rows | Never (tint only) | Pointing devices & hover |
| Shadow-only hover (no scale) | Never | Pointing devices & hover |
| Lift-hover corner radius | Must match element's real radius | Pointing devices & hover |
| Modifier display order in shortcut UI | Ctrl, Alt, Shift, Cmd | Keyboard support & shortcuts |
| Shortcut on upper character of two-char key | Show upper char (Cmd-?, not Shift-Cmd-/) | Keyboard support & shortcuts |
| Safe modifier across international layouts | Cmd/Ctrl only for punctuation/number keys (Option/Alt-5 = "{" on French layouts) | Keyboard support & shortcuts |
| Tab key semantics | Moves between focus groups/regions | Focus & selection |
| Arrow key semantics | Moves within a focus group | Focus & selection |
| Focus traversal order | Reading order: leading→trailing, top→bottom | Focus & selection |
| Focused list item | On-accent (white) text on accent background | Focus & selection |
| Unfocused/inactive selection | Standard text on gray/neutral highlight | Focus & selection |
| Focus ring shape | Matches element contour/radius; never clipped or occluded | Focus & selection |
