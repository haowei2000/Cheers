# Cheers Frontend Design Guide

> **Language**: English | [中文](DESIGN.zh-CN.md)

The Web implementation guide for the Cheers frontend. The canonical product
design decisions live in `../design-system/DESIGN_LANGUAGE.zh-CN.md`, with the
machine-readable item contract in `../design-system/item-contract.json` and
managed collection behavior in
`../design-system/COLLECTION_MANAGER.zh-CN.md`. Shared components in
`src/components/ui/` implement that contract.

The current product language is **Editorial Correspondence**. If a legacy
recipe later in this file uses a different radius, boxed card, decorative
border, non-standard height, multiline browse item, or neon effect, the
canonical design language wins. Treat that recipe as migration inventory, not
permission to introduce another visual language.

Rules of engagement:

1. If a shared component exists (`Button`, `Input`, `Dialog`, `Avatar`,
   `FloatingPanel`), use it. Don't re-implement its look inline.
2. If none exists, copy the **canonical recipe** below verbatim.
3. If you genuinely need a new pattern, add it here in the same PR.

Button geometry is semantic: `content="icon"` is square at the inherited
ControlSize, `content="text"` owns the 96px slot, and `content="iconText"`
owns the 128px slot. All three use the global `regular` typography token.
Inside `iconText`, the leading icon owns a square ControlSize slot while the
label owns the remaining width and its own horizontal padding. The outer button
must not emulate this with a shared `gap` or a feature-local padding rule.
Visible action labels come from `ActionKey`; object names and context belong in
`aria-label`, adjacent status, or supporting content. Latin labels are limited
to the calibrated 68px label-slot budget (at most eight characters and two words).
This has a zero-exception CI policy: selectors, tabs, menu options, disclosures,
and navigation use their semantic primitives/roles rather than a fabricated action.
`controlWidth="fill"` is allowed for full-width form actions; feature code may
not add another fixed width, horizontal padding, or button typography class.

Existing objects use inline editing. Place an Edit IconButton next to the
object; while editing, replace it in place with Cancel and Save IconButtons.
Do not place a detached Save/Edit text button at the bottom of a section. A
first-time creation form or whole-form submission is the only exception.

Common product actions use `<ActionButton action context>`; feature code does
not choose `content` or `variant`. The registered presentation is:

| Context | Icon only | Text | Icon + text |
|---|---|---|---|
| Window chrome | Back, Close, More, Refresh | — | — |
| Disclosure | Expand, Collapse | — | — |
| Inline edit | Edit, Save, Cancel, Delete, Remove | — | — |
| Full form | — | Back, Cancel | Create, Save |
| Dialog footer | — | Back, Cancel | — |
| Destructive confirmation | — | Cancel | Delete, Remove |
| Account security | — | — | Add, Copy, Turn off, Done, Turn on, Link, Revoke, Set up, Unlink, Update |
| Dark settings | — | Review, Resolve, Dismiss, Test | Check, Turn off, Turn on, Open, Restart, Retry, Save, Sign out, Switch |

Account-security presentation uses one additional tone rule inside the shared
`ActionButton` registry: Add/Done/Turn on/Set up/Update use the dark-surface
emphasis tone; Copy/Link are secondary; Turn off/Revoke/Unlink are danger. Every one
uses the registered utility font, regular type token, icon slot, and visible
label, including disabled and loading states. Button-like external links are
not allowed; render them as underlined semantic links.

Settings pages use the `settings` action context. Its completion actions use
the dark `emphasis` surface instead of the light `primary` surface; supporting
actions use `secondary`, and sign-out/destructive actions use `danger`.

Use `ControlTrigger` for a disclosure whose label/content is the disclosed
object itself (for example a diff file heading). `ActionButton` disclosure is
for a compact standalone chevron in chrome. Icon-only actions must supply an
object-specific `accessibleLabel` when the adjacent context is insufficient.

## Cross-platform item contract

The platform-independent item inventory and information-density contract lives
in `../design-system/item-contract.json`. Web renders that contract through
`PresentationProvider`, `ItemRow`, `ItemChip`, and `IconButton`; SwiftUI and
Compose retain native rendering while using the same anatomy and levels.

`PresentationLevel` is `max | medium | minimal`, with `medium` as the default.
A provider/container supplies the inherited level and an explicit item prop
always wins. Responsive rules may choose the inherited default only. The
levels change information density, never business behavior:

| Level | Visible information |
|---|---|
| `max` | identity, title, full supporting content, preview, state, common actions |
| `medium` | identity, title, one supporting line, state, primary/overflow action |
| `minimal` | minimum identity/title plus every critical state |

Unread, mention, approval, error, and online state must remain perceivable in
all three levels. New semantic entity rows must use `ItemRow` instead of
recreating the leading/title/supporting/status/trailing anatomy in a feature.
Use `ItemGallery` as the canonical visual fixture for the three levels.

---

## 1. Tokens

### Appearance: system, light, and dark

Cheers supports **System / Light / Dark**, with System as the default. The
preference is stored per device in `cheers.theme`; System listens to
`prefers-color-scheme` live, including changes made while the app is open.
`ThemeProvider` owns state and `index.html` applies the stored preference before
React starts so the initial frame does not flash the wrong appearance.

The Tailwind `zinc`, neutral `indigo`, status, rail, and sidebar palettes resolve
through CSS variables in `index.css`. Existing semantic utility classes therefore
switch globally; product components must not add parallel `dark:` class lists.
Shared controls and custom renderers consume the same tokens. Brand artwork and
isolated sandbox documents may retain their authored colors.

### Four-level neutral foreground hierarchy (non-negotiable)

Every meaningful foreground clears WCAG AA 4.5:1. Web neutral foregrounds use
exactly four semantic levels; `zinc-300/500/600/700` are not foreground colors:

| Level | Token | Use |
|---|---|---|
| Primary | `zinc-50` or `zinc-100` | body copy, headings, ordinary buttons and functional icons |
| Secondary | `zinc-200` | supporting body copy |
| Metadata | `zinc-400` | timestamps, hints, placeholders, section labels and auxiliary notes |
| Disabled | the enabled foreground plus `opacity-50` | every disabled control; never a darker gray token |

`white` and `zinc-950` remain inverse-color exceptions on semantic filled
surfaces. Syntax highlighting may use registered categorical colors. Business
button call sites may not override an ordinary action to `zinc-200/400`.

### Semantic typography aliases

Use semantic text roles when the role is clear; keep raw size tokens for
geometry-driven controls and one-off dense layouts. These classes define the
complete text contract: family, size, line-height, weight/style, and foreground
color.

| Alias | Use |
|---|---|
| `text-message` | Chat messages, markdown copy, long-form previews; defaults to `zinc-200` |
| `text-message-error` | Error text inside a message; italic red serif |
| `text-body` | Ordinary UI body copy; defaults to `zinc-50` |
| `text-body-secondary` | Secondary body copy; defaults to `zinc-200` |
| `text-body-error` / `text-body-warning` | Body-sized state text |
| `text-title` | Small dialog/card titles; semibold `zinc-50` |
| `text-label` | Form labels and compact text actions; defaults to `zinc-400` |
| `text-label-primary` | Compact primary text actions; defaults to `zinc-50` |
| `text-section-label` | Uppercase section dividers and group labels; defaults to `zinc-400` |
| `text-section-label-error` | Uppercase section/error group label |
| `text-caption` | Hints, metadata, descriptions, empty-state copy; defaults to `zinc-400` |
| `text-caption-error` / `text-caption-italic` | Caption-sized state or italic variants |
| `text-metadata` | Minimal-size dense metadata; defaults to `zinc-400` |
| `text-status` | Status values and compact operational figures; defaults to `zinc-50` |

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

### Surfaces (semantic, back to front)

| Layer | Value |
|---|---|
| App background | `bg-zinc-950` |
| Workspace rail | `bg-rail` |
| Sidebar | `bg-sidebar` |
| Cards, dialogs, popovers | `bg-zinc-900` — no border; separation comes from surface contrast + shadow |
| Fields | `bg-zinc-800 ring-1 ring-inset ring-zinc-600` |
| Chips, soft buttons | `bg-zinc-800` (or `/60` for chips) |
| Inset fields inside dialogs | `bg-zinc-950` |
| Hover on soft surfaces | `bg-zinc-700` |

Settings screens compose `<SettingsSection>` and `<SettingsCard>` rather than
repeating card padding, title, description, and action anatomy. Compact KPI
summaries use `<MetricCard>` with a registered semantic `tone`; callers do not
pass arbitrary foreground classes. All three live in `src/components/ui/` and
are demonstrated in the Item Gallery.

**Elevation principle — borderless everywhere.** Layers separate by surface
contrast, shadow, and deliberate spacing, never by layout-affecting box outlines: `border
border-*` is banned on buttons, fields, cards, chips and popovers alike. Filled
form fields use a neutral inset ring so their boundary keeps at least 3:1 contrast. Use
vertical and horizontal gaps as the default way to group stacked regions.
Reserve 1px rules only for dense, data-heavy surfaces where adjacent rows must
be scanned as a table; underline *indicators* remain for tabs. Rings appear
as field boundaries and **states**: neutral (`ring-zinc-600`), focus
(`ring-indigo-500`), and error (`ring-red-500`).

### Typography

All production text uses exactly four semantic size tokens: `text-minimal`
(10px), `text-compact` (12px), `text-regular` (14px), or
`text-comfortable` (16px). There are no exceptions for mastheads, dense
panels, code, Diff, charts, or empty states. Do not use Tailwind's default
Tailwind's legacy size names, arbitrary pixel utilities, relative `em` sizing, or
literal `fontSize`; use the corresponding CSS variable when an external API
requires an inline value.

Every text property is registered globally: families, optical variants, size,
line height, tracking, weight, foreground hierarchy, and semantic state color.
Use `text-content-strong`, `text-content-primary`, `text-content-secondary`, or
`text-content-muted` for neutral copy. Use `text-accent-*`, `text-danger-*`,
`text-warning-*`, `text-success-*`, `text-info-*`, and `text-removed-*` for
meaningful states; raw palette foregrounds such as `text-zinc-*` and
`text-red-*` are not production typography APIs.

The Web client has four semantic roles: Source Serif 4 plus Source Han Serif
CN `display`, the same pair at text optical sizes for `reading`, Source Sans 3
`utility`, and the registered system monospace stack as `code`. The default UI face is utility; entity names, navigation,
buttons, status, warnings, and trace labels must not inherit the reading serif.
Commands, paths, identifiers, logs, and diffs use `font-code`; generic
`font-mono` is not a production typography API.
The Chinese serif is loaded on demand and excluded from the PWA app-shell
precache; CJK utility text falls through to the locale-correct platform sans.

| Role | Recipe |
|---|---|
| Page H1 | `text-comfortable font-semibold` |
| Dialog / panel title | `text-regular font-semibold text-content-primary` |
| Body | `text-regular text-content-secondary` |
| Form label | `text-compact font-medium text-content-muted uppercase tracking-label` |
| Section header | `text-compact font-semibold text-content-muted uppercase tracking-section` |
| In-panel group label | `text-minimal uppercase tracking-label text-content-muted` |
| Hint / helper | `text-compact text-content-muted` — this is the muted-text floor; there is no dimmer text tier (see §1 contrast floor) |
| Code / path / ID | `font-code text-compact` |
| Mini scale (dense panels) | `text-compact` / `text-minimal` — floor is 10px |

Sidebar group labels such as Channels, Private, and Direct
Messages use the static header of `<ItemSection>`. They are typographic
dividers, not disclosure buttons: do not add a chevron, collapsed state, or
`aria-expanded`. A create action, when available, remains a separate labeled
`IconButton` in the section action slot.

### Shape & states

- Radius: the shared ordinary Web rectangle radius is 10px for product items,
  controls, fields, cards, and composer surfaces. Nested overlays use the same
  rule concentrically: outer radius = 10px + the actual content inset. Use
  `rounded-sm` for ordinary surfaces and `rounded-concentric` with
  `--concentric-inset` for an overlay; never introduce another fixed radius.
  Supporting browsers enhance both with `corner-shape: squircle`; standard
  `border-radius` is the fallback. `rounded-full` is reserved for avatars,
  presence, unread dots, progress, and platform-native controls whose shape
  carries meaning.
- Separation: resting controls stay free of layout-affecting borders. Form fields use `ring-1 ring-inset ring-zinc-600`; other controls use spacing and surface contrast first. Use hairline rules only for editorial sections or dense rows that must scan as a register.
- Focus: `focus:ring-2 focus:ring-indigo-500` (buttons use `focus-visible:`) — **never** a bare `focus:border-indigo-*` substitute
- Error: `ring-1 ring-red-500/70` on the field — a state ring, not a resting border
- Disabled: `disabled:opacity-50` everywhere
- Transitions: `transition-colors` on every interactive element

---

## 2. Component catalog

### 2.1 Buttons — always borderless

Use `<ActionButton>` for registered common actions and `<Button>` for all other
semantic actions (`src/components/ui/action-button.tsx` and `button.tsx`). Variants: `primary`
(indigo fill), `secondary` (zinc soft fill), `ghost` (transparent), `danger`
(red text). Physical sizing must resolve through `ControlSize`: compact 28px,
regular 36px, or comfortable 44px. An icon-only button uses the same selected
ControlSize; it does not introduce a separate 32px tier.
Text buttons default to the registered 96px `slot`; use
`controlWidth="fill"` only when the owning container requires a full-width
control. Label length never determines peer-control width. Business call sites
must not add `px-*`, `pl-*`, or `pr-*` to shared controls; horizontal padding
is owned by the primitive or a registered variant.

Toggle and panel-launch controls pass `selected` to `<Button>` or
`<ControlTrigger>`. The primitive owns the selected fill and exposes
`aria-pressed` for toggles; disclosure triggers retain `aria-expanded` instead.
Business call sites must not recreate selected styling with `className`.

Business call sites must not add any local `p-*` to shared controls. Icon actions
use `square` plus a registered `ControlSize`; text actions use the primitive's
registered padding. Flex rows and headers that participate in the control rhythm
resolve to 28/36/44px rather than introducing 32/40/48/56px variants. Semantic
icons resolve to 14/16/20px, and identity marks to 20/28/36px, through the shared
size maps. CI rejects each of these violations with a zero ceiling.
Layout spacing uses whole Tailwind spacing steps on the 4px grid; fractional
`0.5/1.5/2.5/3.5` spacing utilities are rejected. Loading indicators consume
`ContentSize` instead of accepting arbitrary numeric sizes.

For contexts the component doesn't fit (dense workbench panels), the soft
recipes are:

| Kind | Recipe |
|---|---|
| Neutral soft | `rounded-lg bg-zinc-800 text-content-secondary hover:bg-zinc-700 hover:text-content-primary` |
| Indigo soft | `rounded-lg bg-indigo-600/15 text-accent-200 hover:bg-indigo-600/30` |
| Danger soft | `rounded-lg bg-red-950/40 text-danger-300 hover:bg-red-950/70` |
| Warning soft | `rounded bg-amber-900/40 text-warning-200 hover:bg-amber-900/60` |

**Don't**: `border border-*` on any button (one exception: the dashed
staged-file chip in `fileView.tsx`, where the dashed outline means "not
fetched yet"). Don't hand-roll `bg-indigo-600` primaries — use `<Button>`.

### 2.2 Leading-icon and search fields

Use `<InputWithLeadingIcon>` for a single-line field with a contextual icon
such as a channel hash. Use `<SearchInput>` for every search or filter field;
it fixes `type="search"`, the Search icon, accessible naming, icon geometry,
and native cancel-button normalization.

```tsx
<InputWithLeadingIcon
  leading={<Hash />}
  aria-label="Channel name"
  placeholder="Channel name…"
/>

<SearchInput
  aria-label="Search workspace members"
  placeholder="Search members…"
/>
```

Both composites render the icon inside the shared `<Input>` boundary. `Input`
alone owns the fill, radius, neutral inset ring, focus ring, error state,
ControlSize, mobile zoom guard, and horizontal padding. Business code must not
wrap an Input in another `focus-within:ring-*` field, manually position a Search
icon, or add `pl-9`; use `containerClassName` only for layout and `className`
only for approved surface/tone overrides.

### 2.3 Text fields

Use `<Input>` for single-line text. Fields are **filled boxes with a neutral
inset boundary** — the fill is the affordance and the ring preserves a 3:1
boundary against adjacent dark surfaces. Focus/error replace that neutral ring. Selects/textareas mirror
the same recipe until a shared component exists:

```tsx
// field canon (input / select / textarea) — no layout-affecting border
className="rounded-lg bg-zinc-800 px-3 py-2 text-regular text-content-primary placeholder:text-content-muted
           ring-1 ring-inset ring-zinc-600
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

Borderless soft pills: `rounded-lg bg-zinc-800/60 px-2 py-1 text-compact`.
Interactive chips add `hover:bg-zinc-800 hover:text-content-secondary`; an active/open
chip switches to `bg-indigo-600/15 text-accent-200`.

**Composer toolbar controls** (session target, model — the composer card's
controls row) use `<ComposerToolbarButton>`. Both consume the same regular
36px height and 96px width slot; the label is a flexible single line that
truncates inside the slot, so content length never changes the button size.
Use a leading semantic icon and a trailing `ChevronDown` that rotates 180°
while open. Three states: resting (soft zinc),
open/targeted (`bg-indigo-600/15 text-accent-200`, icon `text-accent-400`),
mobile touch target via the regular ControlSize mapping. Focus comes from the
shared Button primitive. The composer card itself
is the canonical borderless field with the shared 10px Web radius and
`bg-zinc-800/80` plus
`focus-within:ring-2 focus-within:ring-indigo-500/50` — no resting border.

### 2.6 Badges & counters

| Badge | Recipe |
|---|---|
| BOT tag | `text-minimal px-1 py-0.5 rounded bg-indigo-900/60 text-accent-300 font-medium` |
| Unread count | `text-minimal font-bold bg-indigo-600 text-content-on-accent rounded-full px-1.5 py-0.5 min-w-[18px] text-center` |
| Mention count | same shape, `bg-rose-600` |
| Role / status label | plain `text-minimal text-content-muted` next to the name (no pill) |

### 2.7 Presence dot

Presence and avatar geometry uses the shared three-tier `ContentSize`: small,
regular, and large. Web mappings are 20/28/36px for avatars, 14/16/20px for
semantic icons, and 6/8/10px for presence dots. Do not override these shared
primitives with local width or height classes. ContentSize is visual content
scale only; its containing control still uses ControlSize for the hit target.

Chat, Discussion, and Reply identity columns use the same regular avatar
inside a regular control that retains a 44px hit target on touch viewports,
plus the registered regular 96px identity rail. They show only the avatar and
sender name; visible timestamps and BOT labels are omitted. The rail follows
the ContentSize 64/96/128px scale and never uses a feature-local width. Message-record affordances use the
record icon; raw attachment/trace counts belong in the accessible label and
tooltip, not as unexplained zero-padded folio numbers in the timeline.

`w-2 h-2 rounded-full ring-2 ring-zinc-900` overlaid bottom-right of the
avatar; `bg-emerald-500` online / `bg-zinc-600` offline. One size, one ring
style — don't mix `border` and `ring` variants. (This ring is the avatar
cut-out mask, not a decorative border.)

### 2.8 Tabs — two styles only

- **Underline tabs** (page & detail navigation — FriendsPage, BotDetailPanel):
  container `flex gap-1 border-b border-zinc-800`; item
  `px-3 py-2 text-regular border-b-2 -mb-px transition-colors` with active
  `border-indigo-500 text-content-primary`, inactive
  `border-transparent text-content-muted hover:text-content-secondary`.
- **Pill tabs** (dense panel toolbars — ViewBoard):
  `rounded-md px-2 py-1 text-compact` with active `bg-zinc-800 text-content-primary`,
  inactive `text-content-muted hover:bg-zinc-800/60 hover:text-content-secondary`.

Don't introduce a third style; segmented controls reuse the pill recipe
inside a `bg-zinc-800` container.

Mutually exclusive form choices use `<ChoiceGroup>` and its registered
`<ChoiceButton>` anatomy, not tabs or feature-owned buttons. The group exposes
`radiogroup`/`radio` semantics, one roving tab stop, and arrow/Home/End keyboard
navigation. Each choice uses the shared `iconText` slots at fill width; selected
state uses a neutral filled surface rather than a resting border or an
action-colored treatment.

### 2.9 Empty state

Canon is the Plan panel: centered, icon + primary + secondary line.

```tsx
<div className="flex flex-col items-center justify-center py-8 text-center">
  <SomeIcon className="w-5 h-5 text-content-muted mb-2" />   {/* decorative glyph: zinc-500 ok */}
  <p className="text-compact text-content-muted">Nothing here yet</p>       {/* primary line: meaningful text */}
  <p className="text-compact text-content-muted mt-0.5">It appears when …</p>  {/* secondary line: still meaningful */}
</div>
```

Compact lists may use the one-liner `text-compact text-content-muted py-4 text-center`.

### 2.10 Loading

- Inline / action: `Loader2` icon + `animate-spin`, inheriting `currentColor`.
- Full surface: `Loader2 w-5 h-5 text-content-muted animate-spin` centered.
- Buttons: the built-in `loading` prop of `<Button>`.
- Don't hand-roll CSS border-circle spinners; don't pair a spinner with
  "Loading…" text unless the wait is long.

### 2.11 Close button

`text-content-muted hover:text-content-secondary` with `X w-4 h-4`, top-right. Drawers and
floating panels may add `rounded p-0.5 hover:bg-zinc-800`. Hover target is
`zinc-300` — not `zinc-200`.

### 2.12 List rows

Selectable rows use the shared Item geometry and hover fill. Selected
NavigationItems use `bg-zinc-800 text-content-primary` plus `aria-current="page"`;
the fill remains visible even when a borderless placement suppresses the
ordinary left marker. Every interactive row needs a hover state.

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
`text-compact font-semibold text-content-muted uppercase tracking-section`, optional
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
validation errors stay inline (`text-danger-400` next to the field), and
irreversible consequences are confirmed in a dialog, not merely tooltipped.
Hover help is for "nice to know", not "need to know".

### 2.15 Danger zone

Destructive actions (delete, disable) sit in their own trailing section
behind a `Danger zone` `<SectionHead>`, divider-separated from the form above
— never inline next to ordinary Save/Add controls. Buttons use the danger
**soft** recipe (`bg-red-950/40 text-danger-300 hover:bg-red-950/70`), never the
accent fill; the irreversible one gets a `…` suffix (`Delete…`) to signal a
confirm step follows (§7 reversibility — prefer a confirm dialog to an
inline red button that fires on first click). Consequences go in a `<Tip>`.

### 2.16 Avatar stack (participant overview)

"Who's here" at a glance — a channel/board's distinct participants as
overlapping avatars, most-relevant first. Used by the Activity ViewBoard
(`ActivityPanel.tsx`'s `ParticipantStrip`).

```tsx
<div className="flex items-center -space-x-2">
  {ids.map((id) => (
    <button
      key={id}
      className={cn(
        "relative rounded-full ring-2 transition-all",
        active ? "ring-indigo-500" : "ring-zinc-900",
        dimmed && "opacity-50 hover:opacity-100"
      )}
    >
      <Avatar size="xs" className="!w-6 !h-6" online={m.is_online ?? undefined} … />
    </button>
  ))}
</div>
{overflow > 0 && <span className="ml-1 text-minimal text-content-muted">+{overflow}</span>}
```

The `ring-zinc-900`/`ring-indigo-500` ring doubles as the overlap separator
(resting) and the selected state (active) — don't add a second selection
treatment. Cap the stack (10 is the Activity precedent) and show a plain
`+N`, never render an unbounded row. If the stack drives a filter, clicking
toggles membership in that filter's own selection state — don't invent a
parallel one.

### 2.17 Error notifications — three tiers

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
field error first (§2.3 error ring + `text-danger-400` line), toast only without
a form · `429`/`5xx`/network → `notify.error` with a Retry action when the
caller can retry · ws drop → M banner. Inline beats toast when the error has
an anchor (a message, a field): keep `MessageItem`-style "Failed to send +
Retry" rows.

**Don't**: `toast.error(String(e))` — it re-degrades the already-humanized
`ApiError` message to `Error: …`; use `notify.error(messageOf(e))`. Don't
hand-roll full-page error markup when `<ErrorState>` fits.

### 2.18 Action icons — semantic convention

One glyph, one action family. A `+`-shaped icon is not a generic "do
something here" mark — it specifically means **create a brand-new resource**.
Attaching, uploading, or adding an *existing* thing each has its own glyph, so
two different actions never share a mark on the same surface (the bug this
codifies: the Workbench file panel once drew *create-file* and *add-to-context*
both as a bare `Plus`).

| Action family | Icon | Applies to |
|---|---|---|
| Create a new resource | `Plus` (bare) | file, folder, session, channel, DM, workspace, permission rule/grant, table row, kanban task |
| Create rooted at a folder | `FolderPlus` | a session rooted at a directory (RemoteWorkspace tree) |
| Attach / upload a file to the message | `Paperclip` | composer "Attach file" (upload / pick channel file), channel files |
| Add a Cheers resource to context | `MessageSquarePlus` | workbench file, ViewBoard, workspace-file reference, suggested-context chip, the composer "Add context" menu — the bundle rides your *next message* |
| Add a selected passage to context | `TextQuote` | a ranged `fs.read` excerpt — a labeled sub-variant of add-to-context (keeps its "quote a passage" meaning) |
| Add a person | `UserPlus` | add friend, invite member (decorative adornments on member-search inputs use it too) |
| `+N` count / overflow | literal `+N` text, **no icon** | avatar-stack overflow, diff added-lines — a quantity, not an action |

Add-to-context is centralized in `AttachContextButton`
(`src/features/chat/context/ContextPickBar.tsx`) — reuse it rather than
hand-drawing an attach glyph. `Paperclip` is reserved: it never means
"add to context" (that pipeline is resource references, not uploaded files).

Pending composer context uses `ItemChip` at regular height. Its remove and
jump actions use compact `IconButton`s inside that registered height; never
wrap a regular action in a padded chip, which creates an unregistered fourth
control height. The pending item and the Add context entry must align to the
same 36px desktop / 44px touch row.


---

## 3. Known gaps (extraction roadmap)

Patterns that should graduate into `src/components/ui/` — until then, copy
the recipes above:

1. `SearchInput` (forms A & B of §2.2)
2. `Badge` (§2.6)

Extracted (were gaps, now shared components): `Select` / `Textarea`
(mirror `Input`), `EmptyState` (§2.9), `Spinner` (§2.10), `Field` +
`SectionHead` (§2.13), `Tip` (§2.14), `SettingsCard` / `SettingsSection`, and
`MetricCard`.

The full audit that produced this doc: visual-consistency reports
2026-07-10 (static sweep + live review, see PR #134 context).

---

## 4. Anti-pattern checklist

Reject in review:

- [ ] `gray-*` / `slate-*` / `neutral-*` / `stone-*` anywhere
- [ ] raw palette foregrounds (`text-zinc-*`, `text-red-*`, and peers) instead of semantic text tokens
- [ ] a foreground below the registered `text-content-muted` contrast floor on meaningful copy
- [ ] any interactive element with a hit area below 44×44px (pad the target even when the glyph is smaller)
- [ ] icon-only button without an `aria-label`; `outline-none` without a replacement focus ring; a clickable `<div>` where a `<button>` belongs
- [ ] `rose-*` for errors (rose is mention-only)
- [ ] box borders anywhere — `border border-*` on buttons, fields, cards, chips or popovers (1px `border-b` dividers between regions are fine)
- [ ] hand-rolled `bg-indigo-600` primary buttons
- [ ] `focus:border-*` instead of a focus ring
- [ ] `outline-none` without a replacement focus affordance
- [ ] raw enum / field names in UI copy (`in_progress`, `system_admin`, `bot_id`)
- [ ] new tab / empty-state / spinner styles when §2 already has one
- [ ] `toast.error(String(e))` — use `notify.error(messageOf(e))` (§2.17)
- [ ] hand-rolled error banners / full-page error markup when §2.17 has a tier for it; 401 handling at a call site (the client classifier owns it)
- [ ] `Plus` on anything that isn't "create a brand-new resource" — add-to-context is `MessageSquarePlus`, attach-file is `Paperclip`, add-person is `UserPlus` (§2.18)
- [ ] a new add-to-context affordance drawn with any glyph other than `MessageSquarePlus` (or `TextQuote` for a ranged passage) — or bypassing `AttachContextButton` (§2.18)
