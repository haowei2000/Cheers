# Cheers Frontend Design Guide

> **Language**: English | [中文](DESIGN.zh-CN.md)

The visual contract for the Cheers frontend. **The shared components in
`src/components/ui/` are the source of truth** — this document records the
canonical recipes for everything they don't cover yet, so new UI copies one
known form instead of inventing a new one.

Rules of engagement:

1. If a shared component exists (`Button`, `Input`, `Dialog`, `Avatar`,
   `FloatingPanel`), use it. Don't re-implement its look inline.
2. If none exists, copy the **canonical recipe** below verbatim.
3. If you genuinely need a new pattern, add it here in the same PR.

---

## 1. Tokens

### Color semantics

| Role | Token | Notes |
|---|---|---|
| Accent / interactive | `indigo` | Buttons `indigo-600`, focus rings `indigo-500`, links `indigo-400`, selected tints `indigo-600/15` |
| Danger / error | `red` | Text `red-400`, soft fills `red-950/40` — **never `rose`** for errors |
| Attention / mention | `rose-600` | Mention badges only — the one legitimate rose |
| Success / online | `emerald` | Dots `emerald-500`, text `emerald-400` |
| Warning | `amber-400` | Text at `-400`; soft fills `amber-900/40` |
| Grayscale | `zinc` only | Never `gray`, `slate`, `neutral`, `stone` |
| Categorical (data-coding) | any tinted hue | Badges that encode *identity*, not state — e.g. permission-capability tags (sky/violet), per-bot activity markers, avatar palette, syntax highlighting. Keep them to tinted badges/marks; never use them for interactive chrome, focus rings or buttons. |

### Surfaces (dark theme, back to front)

| Layer | Value |
|---|---|
| App background | `#09090b` (body) / `bg-zinc-950` |
| Workspace rail | `bg-rail` (`#0f0f11`) |
| Sidebar | `bg-sidebar` (`#18181b`) |
| Cards, dialogs, popovers | `bg-zinc-900` — no border; separation comes from surface contrast + shadow |
| Fields, chips, soft buttons | `bg-zinc-800` (or `/60` for chips) |
| Inset fields inside dialogs | `bg-zinc-950` |
| Hover on soft surfaces | `bg-zinc-700` |

**Elevation principle — borderless everywhere.** Layers separate by surface
contrast and shadow, never by box outlines: `border border-*` is banned on
buttons, fields, cards, chips and popovers alike. 1px *dividers* between
stacked regions (`border-b border-zinc-800`) and underline *indicators*
(tabs) remain. Rings appear only as **states**: focus (`ring-indigo-500`)
and error (`ring-red-500`).

### Typography

| Role | Recipe |
|---|---|
| Page H1 | `text-lg font-semibold` |
| Dialog / panel title | `text-sm font-semibold text-zinc-100` |
| Body | `text-sm text-zinc-200/300` |
| Form label | `text-xs font-medium text-zinc-500 uppercase tracking-wide` |
| Section header | `text-xs font-semibold text-zinc-500 uppercase tracking-wider` |
| In-panel group label | `text-[10px] uppercase tracking-wide text-zinc-500` |
| Hint / helper | `text-xs text-zinc-500` (dimmer: `zinc-600`) |
| Mini scale (dense panels) | `text-[11px]` / `text-[10px]` — floor is 10px |

### Shape & states

- Radius: chips/inputs/buttons `rounded-md`(sm)/`rounded-lg`(md) · cards & popovers `rounded-xl` · pills `rounded-full`
- Focus: `focus:ring-2 focus:ring-indigo-500` (buttons use `focus-visible:`) — **never** a bare `focus:border-indigo-*` substitute
- Error: `ring-1 ring-red-500/70` on the field — a state ring, not a resting border
- Disabled: `disabled:opacity-50` everywhere
- Transitions: `transition-colors` on every interactive element

---

## 2. Component catalog

### 2.1 Buttons — always borderless

Use `<Button>` (`src/components/ui/button.tsx`). Variants: `primary`
(indigo fill), `secondary` (zinc soft fill), `ghost` (transparent), `danger`
(red text). Sizes: `sm` (h-7), `md` (h-9), `icon` (h-8 square).

For contexts the component doesn't fit (dense workbench panels), the soft
recipes are:

| Kind | Recipe |
|---|---|
| Neutral soft | `rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100` |
| Indigo soft | `rounded-lg bg-indigo-600/15 text-indigo-200 hover:bg-indigo-600/30` |
| Danger soft | `rounded-lg bg-red-950/40 text-red-300 hover:bg-red-950/70` |
| Warning soft | `rounded bg-amber-900/40 text-amber-200 hover:bg-amber-900/60` |

**Don't**: `border border-*` on any button (one exception: the dashed
staged-file chip in `fileView.tsx`, where the dashed outline means "not
fetched yet"). Don't hand-roll `bg-indigo-600` primaries — use `<Button>`.

### 2.2 Search / filter field — three forms

One visual language, three placements. All use a `Search` (or contextual)
lucide icon at `w-3.5`–`w-4 text-zinc-500` and a transparent inner input.

**A. Dialog picker search** — wrapper carries the style, input is bare.
Used by NewChannelDialog, NewDmDialog, ChannelSettingsDialog member search:

```tsx
<div className="flex items-center gap-2 rounded-lg bg-zinc-950 px-3 py-2
                focus-within:ring-2 focus-within:ring-indigo-500 transition-shadow">
  <Search className="w-4 h-4 text-zinc-500" />
  <input className="flex-1 bg-transparent text-sm text-zinc-200 outline-none
                    placeholder:text-zinc-600" placeholder="…" />
</div>
```

**B. Page-level filter** — self-contained input with an absolutely
positioned icon. Used by AdminUsers filter, FriendsPage lookup:

```tsx
<div className="relative">
  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
  <input className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-950
                    text-base md:text-sm text-zinc-100 placeholder:text-zinc-600
                    focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow" />
</div>
```

**C. Inline popover filter** — bare input on a divider, no box. Used inside
dense popovers/panels (ActivityPanel search):

```tsx
<input className="w-full bg-transparent border-b border-zinc-800 px-1 py-1.5
                  text-xs text-zinc-200 outline-none placeholder:text-zinc-600
                  focus:border-indigo-500/60" />
```

Notes: `text-base md:text-sm` on any input reachable on mobile (iOS zoom
guard). Field background inside dialogs is `bg-zinc-950` (inset look);
standalone on a `zinc-950` page it is `bg-zinc-900`.

### 2.3 Text fields

Use `<Input>` for single-line text. Fields are **borderless filled boxes** —
the fill is the affordance, the ring is the state. Selects/textareas mirror
the same recipe until a shared component exists:

```tsx
// field canon (input / select / textarea) — no border
className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600
           focus:outline-none focus:ring-2 focus:ring-indigo-500
           disabled:opacity-50"
// error state: add ring-1 ring-red-500/70
```

### 2.4 Overlay surfaces

All overlay surfaces are borderless — the dimmed backdrop (modals) or the
shadow (popovers, windows) provides the separation:

| Surface | Recipe |
|---|---|
| Modal (use `<Dialog>`) | backdrop `bg-black/50`, card `rounded-xl bg-zinc-900 p-4` — no shadow needed |
| Anchored popover | `rounded-xl bg-zinc-900 shadow-xl shadow-black/40` |
| Autocomplete / menu list | same as popover, `rounded-lg` acceptable for compact lists |
| Draggable window (use `<FloatingPanel>`) | `rounded-xl bg-zinc-900/95 backdrop-blur-sm shadow-2xl shadow-black/50` |

`shadow-2xl` is reserved for draggable windows; anchored popovers use
`shadow-xl`.

### 2.5 Chips (composer, files)

Borderless soft pills: `rounded-lg bg-zinc-800/60 px-2 py-1 text-[11px]`.
Interactive chips add `hover:bg-zinc-800 hover:text-zinc-200`; an active/open
chip switches to `bg-indigo-600/15 text-indigo-200`.

### 2.6 Badges & counters

| Badge | Recipe |
|---|---|
| BOT tag | `text-[10px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300 font-medium` |
| Unread count | `text-[10px] font-bold bg-indigo-600 text-white rounded-full px-1.5 py-0.5 min-w-[18px] text-center` |
| Mention count | same shape, `bg-rose-600` |
| Role / status label | plain `text-[10px] text-zinc-500` next to the name (no pill) |

### 2.7 Presence dot

`w-2 h-2 rounded-full ring-2 ring-zinc-900` overlaid bottom-right of the
avatar; `bg-emerald-500` online / `bg-zinc-600` offline. One size, one ring
style — don't mix `border` and `ring` variants. (This ring is the avatar
cut-out mask, not a decorative border.)

### 2.8 Tabs — two styles only

- **Underline tabs** (page & detail navigation — FriendsPage, BotDetailPanel):
  container `flex gap-1 border-b border-zinc-800`; item
  `px-3 py-2 text-sm border-b-2 -mb-px transition-colors` with active
  `border-indigo-500 text-zinc-100`, inactive
  `border-transparent text-zinc-500 hover:text-zinc-300`.
- **Pill tabs** (dense panel toolbars — ViewBoard):
  `rounded-md px-2 py-1 text-xs` with active `bg-zinc-800 text-zinc-100`,
  inactive `text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300`.

Don't introduce a third style; segmented controls reuse the pill recipe
inside a `bg-zinc-800` container.

### 2.9 Empty state

Canon is the Plan panel: centered, icon + primary + secondary line.

```tsx
<div className="flex flex-col items-center justify-center py-8 text-center">
  <SomeIcon className="w-5 h-5 text-zinc-600 mb-2" />
  <p className="text-xs text-zinc-500">Nothing here yet</p>
  <p className="text-[11px] text-zinc-600 mt-0.5">It appears when …</p>
</div>
```

Compact lists may use the one-liner `text-xs text-zinc-600 py-4 text-center`.

### 2.10 Loading

- Inline / action: `Loader2` icon + `animate-spin`, inheriting `currentColor`.
- Full surface: `Loader2 w-5 h-5 text-zinc-600 animate-spin` centered.
- Buttons: the built-in `loading` prop of `<Button>`.
- Don't hand-roll CSS border-circle spinners; don't pair a spinner with
  "Loading…" text unless the wait is long.

### 2.11 Close button

`text-zinc-500 hover:text-zinc-300` with `X w-4 h-4`, top-right. Drawers and
floating panels may add `rounded p-0.5 hover:bg-zinc-800`. Hover target is
`zinc-300` — not `zinc-200`.

### 2.12 List rows

Selectable rows: `px-2.5 py-1.5 rounded-md text-sm hover:bg-zinc-800`;
selected `bg-zinc-800 text-zinc-100` (nav lists may tint with indigo per
§2.8's active pill). Every interactive row needs a hover state.

---

## 3. Known gaps (extraction roadmap)

Patterns that should graduate into `src/components/ui/` — until then, copy
the recipes above:

1. `Select` / `Textarea` (mirror `Input`)
2. `SearchInput` (forms A & B of §2.2)
3. `EmptyState` (§2.9)
4. `Spinner` (§2.10)
5. `Field` + `Label` (label + control + hint stack, §1 typography)
6. `Badge` (§2.6)

The full audit that produced this doc: visual-consistency reports
2026-07-10 (static sweep + live review, see PR #134 context).

---

## 4. Anti-pattern checklist

Reject in review:

- [ ] `gray-*` / `slate-*` / `neutral-*` / `stone-*` anywhere
- [ ] `rose-*` for errors (rose is mention-only)
- [ ] box borders anywhere — `border border-*` on buttons, fields, cards, chips or popovers (1px `border-b` dividers between regions are fine)
- [ ] hand-rolled `bg-indigo-600` primary buttons
- [ ] `focus:border-*` instead of a focus ring
- [ ] `outline-none` without a replacement focus affordance
- [ ] raw enum / field names in UI copy (`in_progress`, `system_admin`, `bot_id`)
- [ ] new tab / empty-state / spinner styles when §2 already has one
