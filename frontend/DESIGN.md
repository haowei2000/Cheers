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

### Appearance: dark-only (deliberate)

Cheers ships a **single dark appearance** — this is a product decision, not an
oversight. `index.css` sets `color-scheme: dark`; there is no light token set
and no in-app appearance switch. The audience (developers running an
agent-console chat tool) works dark, and a second theme would double the
token-maintenance surface for little value. The trade-off we accept: users
whose OS is set to light still get a dark app. If that ever changes, the
migration is "lift every `zinc-*` literal into CSS variables + add a
`prefers-color-scheme` default + a System/Light/Dark setting" — do it as its
own PR, not piecemeal.

### Text contrast floor (non-negotiable)

Every color that paints **meaningful text** must clear **WCAG AA 4.5:1**
against its surface (3:1 only for large text ≥18px, or ≥14px bold). On our
zinc surfaces that makes **`zinc-400` the floor for muted/secondary text**
(`zinc-400` on `zinc-900` ≈ 6.9:1). The dimmer tiers are for pixels that carry
no text meaning:

| Use | Token | Why |
|---|---|---|
| Meaningful text — labels, hints, timestamps, placeholders, section headers, code comments, chart axis text | `zinc-400` floor (brighter for primary: `zinc-100/200/300`) | must reach 4.5:1 |
| Functional icons (search, chevron, close) | `zinc-500` acceptable (icons need only 3:1) — but never on `zinc-800` fills where it dips to 3.08:1 | non-text 3:1 floor |
| Purely decorative marks — separators (`·`), large empty-state hero glyphs | `zinc-600/700` OK (decorative, information is carried elsewhere) | exempt |

**`zinc-500` is never a text color for content, and `zinc-600`/`zinc-700` are
never a text color at all** (they fail even 3:1). Placeholders count as
meaningful text → `zinc-400`.

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
| Form label | `text-xs font-medium text-zinc-400 uppercase tracking-wide` |
| Section header | `text-xs font-semibold text-zinc-400 uppercase tracking-wider` |
| In-panel group label | `text-[10px] uppercase tracking-wide text-zinc-400` |
| Hint / helper | `text-xs text-zinc-400` — this is the muted-text floor; there is no dimmer text tier (see §1 contrast floor) |
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
| Anchored popover (use `<PopoverPanel>` + `usePopoverDismiss`) | `rounded-xl bg-zinc-900 shadow-xl shadow-black/40` |
| Autocomplete / menu list | same as popover, `rounded-lg` acceptable for compact lists |
| Draggable window (use `<FloatingPanel>`) | `rounded-xl bg-zinc-900/95 backdrop-blur-sm shadow-2xl shadow-black/50` |

`shadow-2xl` is reserved for draggable windows; anchored popovers use
`shadow-xl`.

**Anchored popover primitive** (`src/components/ui/popover.tsx`): a `relative`
wrapper holds the trigger and the panel; `usePopoverDismiss(open, onClose,
rootRef)` closes on outside-mousedown / Escape (Escape is claimed with
`preventDefault` so outer Esc handlers skip it); `<PopoverPanel placement="up"|
"down" align="start"|"end">` renders the §2.4 surface at `z-50`. Keep the
trigger inside the root ref so toggling never close-then-reopens:

```tsx
const rootRef = useRef<HTMLDivElement>(null);
usePopoverDismiss(open, close, rootRef);
<div ref={rootRef} className="relative inline-flex">
  <button aria-expanded={open} …>trigger</button>
  {open && <PopoverPanel placement="up" className="w-72 p-1">…</PopoverPanel>}
</div>
```

If the panel must escape a `transform`/`overflow-hidden`/`backdrop-blur`
ancestor, portal to `document.body` instead (ProfileHovercard precedent,
`z-[60]`).

### 2.5 Chips (composer, files)

Borderless soft pills: `rounded-lg bg-zinc-800/60 px-2 py-1 text-[11px]`.
Interactive chips add `hover:bg-zinc-800 hover:text-zinc-200`; an active/open
chip switches to `bg-indigo-600/15 text-indigo-200`.

**Composer control chips** (session target, model — the composer card's
controls row): the interactive chip recipe above plus a leading `w-3.5 h-3.5`
icon, a `truncate` label with a `max-w-*` cap, and a trailing `ChevronDown
w-3 h-3` that rotates 180° while open. Three states: resting (soft zinc),
open/targeted (`bg-indigo-600/15 text-indigo-200`, icon `text-indigo-400`),
mobile touch target via `max-md:py-2`. Focus:
`focus-visible:ring-2 focus-visible:ring-indigo-500`. The composer card itself
is the canonical borderless field: `rounded-xl bg-zinc-800/80` with
`focus-within:ring-2 focus-within:ring-indigo-500/50` — no resting border.

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
  `border-transparent text-zinc-400 hover:text-zinc-200`.
- **Pill tabs** (dense panel toolbars — ViewBoard):
  `rounded-md px-2 py-1 text-xs` with active `bg-zinc-800 text-zinc-100`,
  inactive `text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200`.

Don't introduce a third style; segmented controls reuse the pill recipe
inside a `bg-zinc-800` container.

### 2.9 Empty state

Canon is the Plan panel: centered, icon + primary + secondary line.

```tsx
<div className="flex flex-col items-center justify-center py-8 text-center">
  <SomeIcon className="w-5 h-5 text-zinc-500 mb-2" />   {/* decorative glyph: zinc-500 ok */}
  <p className="text-xs text-zinc-400">Nothing here yet</p>       {/* primary line: meaningful text */}
  <p className="text-[11px] text-zinc-400 mt-0.5">It appears when …</p>  {/* secondary line: still meaningful */}
</div>
```

Compact lists may use the one-liner `text-xs text-zinc-400 py-4 text-center`.

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

### 2.13 Field (label + control + hint)

Use `<Field>` (`src/components/ui/field.tsx`) to stack a form label over a
control with an optional hint — the label is **persistent**, never a
placeholder standing in for one (HIG data-entry floor). The label uses the §1
form-label recipe; the control is any shared field (`Input`/`Textarea`/
`Select`) or a custom row (e.g. an emoji box + text input side by side).

```tsx
<Field label="Display name" htmlFor="dn">
  <Input id="dn" value={name} onChange={…} />
</Field>
```

`<SectionHead>` (same file) is the in-card divider heading —
`text-xs font-semibold text-zinc-400 uppercase tracking-wider`, optional
leading icon. Don't repeat a heading the surrounding chrome already says (a
card whose header shows the identity doesn't also need a "Profile" heading).

### 2.14 Hover help (`<Tip>`)

Supplementary explanation — what a control does, a constraint, a one-time
note, a consequence preview — lives behind `<Tip>`
(`src/components/ui/tip.tsx`), not as a resting paragraph of body copy. The
bubble shows on **hover and keyboard focus** (touch: tap the trigger); it is a
lighter transient layer (`bg-zinc-700`) so it separates from the `zinc-900`
card, `role="tooltip"`, associated to its trigger via `aria-describedby`.

```tsx
<Tip content="Asks the bot on a schedule and writes the answer back." />   {/* default ⓘ trigger */}
<Tip content={`Current prompt: "${p}". Click to edit.`}>                    {/* wrap any control */}
  <Button size="sm" variant="secondary">Edit prompt</Button>
</Tip>
```

**Never hide behind hover** anything the user must see to act correctly:
validation errors stay inline (`text-red-400` next to the field), and
irreversible consequences are confirmed in a dialog, not merely tooltipped.
Hover help is for "nice to know", not "need to know".

### 2.15 Danger zone

Destructive actions (delete, disable) sit in their own trailing section
behind a `Danger zone` `<SectionHead>`, divider-separated from the form above
— never inline next to ordinary Save/Add controls. Buttons use the danger
**soft** recipe (`bg-red-950/40 text-red-300 hover:bg-red-950/70`), never the
accent fill; the irreversible one gets a `…` suffix (`Delete…`) to signal a
confirm step follows (§7 reversibility — prefer a confirm dialog to an
inline red button that fires on first click). Consequences go in a `<Tip>`.

### 2.16 Error notifications — three tiers

Pick the tier by **how much of the user's current work is unusable**, not by
technical severity — and every error names an exit (Retry / Sign in again /
Reload / Go back), never just a statement of failure. Interactive mockup with
live demos of every tier:
[docs/design/ERROR_NOTIFICATIONS.html](../docs/design/ERROR_NOTIFICATIONS.html)
(open in a browser).

| Tier | User state | Form | Component |
|---|---|---|---|
| **S — routine failure** | can keep working | toast, bottom-right, auto-dismisses | `notify.error/warning/success/info` (`src/lib/notify.tsx`) — carries one optional action (`{ label, onClick }`) |
| **M — degraded context** | still readable, but the context is impaired | persistent soft strip atop the affected region; reflects a *state*, unmounts when it clears | `<Banner severity icon action onDismiss>` (`src/components/ui/banner.tsx`) |
| **L — blocked** | must resolve before continuing | blocking dialog · panel/full-page state | `<ErrorDialog action?>` · `<ErrorState icon tone title description action secondaryAction>` (`src/components/ui/error-state.tsx`) |

Global wiring that already exists — extend it, don't rebuild it:

- **Session expiry**: a 401 on any authenticated request (`api/client.ts`
  classifier, `/auth/*` exempt) or a ws `auth_err` flips
  `authStore.sessionExpired` → `App` renders the full-screen **Session
  expired** takeover, whose "Sign in again" round-trips through
  `/login?redirect=…`. Never handle 401 at a call site.
- **Render crashes**: the top-level `ErrorBoundary` (`main.tsx`) renders an
  `ErrorState` with Reload + copy-details. Don't add per-page boundaries
  without a reason.
- **Connection loss**: `useChatRealtime().status` drives the ChannelView
  "Connection lost" `<Banner>` (1.5s grace before showing; auto-clears on
  resubscribe; "Retry now" = `reconnectNow`).

Status → tier quick map: `401` → L takeover (automatic) · route-level
`403`/`404` → `<ErrorState>` in the panel · validation `409`/`422` → inline
field error first (§2.3 error ring + `text-red-400` line), toast only without
a form · `429`/`5xx`/network → `notify.error` with a Retry action when the
caller can retry · ws drop → M banner. Inline beats toast when the error has
an anchor (a message, a field): keep `MessageItem`-style "Failed to send +
Retry" rows.

**Don't**: `toast.error(String(e))` — it re-degrades the already-humanized
`ApiError` message to `Error: …`; use `notify.error(messageOf(e))`. Don't
hand-roll full-page error markup when `<ErrorState>` fits.

---

## 3. Known gaps (extraction roadmap)

Patterns that should graduate into `src/components/ui/` — until then, copy
the recipes above:

1. `SearchInput` (forms A & B of §2.2)
2. `Badge` (§2.6)

Extracted (were gaps, now shared components): `Select` / `Textarea`
(mirror `Input`), `EmptyState` (§2.9), `Spinner` (§2.10), `Field` +
`SectionHead` (§2.13), `Tip` (§2.14).

The full audit that produced this doc: visual-consistency reports
2026-07-10 (static sweep + live review, see PR #134 context).

---

## 4. Anti-pattern checklist

Reject in review:

- [ ] `gray-*` / `slate-*` / `neutral-*` / `stone-*` anywhere
- [ ] `text-zinc-500` on meaningful text — it's below 4.5:1 on every surface; use `zinc-400`, and reserve `zinc-500` for functional icons (§1 contrast floor)
- [ ] `text-zinc-600` / `text-zinc-700` as a text color — decorative marks (separators, hero glyphs) only
- [ ] any interactive element with a hit area below 44×44px (pad the target even when the glyph is smaller)
- [ ] icon-only button without an `aria-label`; `outline-none` without a replacement focus ring; a clickable `<div>` where a `<button>` belongs
- [ ] `rose-*` for errors (rose is mention-only)
- [ ] box borders anywhere — `border border-*` on buttons, fields, cards, chips or popovers (1px `border-b` dividers between regions are fine)
- [ ] hand-rolled `bg-indigo-600` primary buttons
- [ ] `focus:border-*` instead of a focus ring
- [ ] `outline-none` without a replacement focus affordance
- [ ] raw enum / field names in UI copy (`in_progress`, `system_admin`, `bot_id`)
- [ ] new tab / empty-state / spinner styles when §2 already has one
- [ ] `toast.error(String(e))` — use `notify.error(messageOf(e))` (§2.16)
- [ ] hand-rolled error banners / full-page error markup when §2.16 has a tier for it; 401 handling at a call site (the client classifier owns it)
