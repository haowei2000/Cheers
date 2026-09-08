# HIG Components (structure & navigation) — text/labels, lists, split views, tabs, sidebars, search fields

Apple HIG guidance for structural and navigational components, translated to web equivalents (pt = px 1:1, Dynamic Type = text scaling / 200% zoom, VoiceOver = screen reader), for auditing React web frontends.

## Contents

- [Text views](#text-views)
- [Labels](#labels)
- [Image views](#image-views)
- [Charts](#charts)
- [Web views (embeds)](#web-views-embeds)
- [Boxes (group containers)](#boxes-group-containers)
- [Collections (grids)](#collections-grids)
- [Lists and tables](#lists-and-tables)
- [Outline views (trees)](#outline-views-trees)
- [Disclosure controls](#disclosure-controls)
- [Split views](#split-views)
- [Tab views](#tab-views)
- [Sidebars](#sidebars)
- [Tab bars (top-level navigation)](#tab-bars-top-level-navigation)
- [Search fields](#search-fields)
- [Token fields (chips/tag inputs)](#token-fields-chipstag-inputs)
- [Path controls (breadcrumbs)](#path-controls-breadcrumbs)
- [Quick-scan spec table](#quick-scan-spec-table)

Shared principles that recur across topics (stated once, referenced where they apply):

- **Copyability**: useful values (errors, IDs, IPs, addresses) must be selectable and copyable — trapping them in unselectable UI forces retyping. Applies to text views and labels.
- **Heading style**: column/group headings are nouns or short noun phrases, no ending punctuation. Applies to lists, tables, outline views, boxes (boxes use sentence case; the only punctuation exception is settings-style `Label:` forms).
- **Sort convention**: clicking a sorted column heading again reverses the sort direction, with a visible direction indicator. Applies to tables and outline views.
- **Alternating row backgrounds**: recommended for wide multicolumn tables and outlines so the eye can track a row across columns.
- **Middle-ellipsis**: prefer a centered ellipsis over end-truncation or clipping when a string's ends are the distinctive parts (filenames, paths, IDs). Applies to lists, tables, outline views.

---

## Text views

**Principles**
- Match the component to the text's job: static element for small read-only text, single-line input for small editable text, textarea/rich editor only for long, editable, or specially formatted text. Overpowered components add complexity without benefit.
- Legibility beats expressiveness: fonts/colors/alignments are flexible, but text must survive user-controlled size changes (browser zoom, OS large-text) and settings like bold text.
- Copyability applies (see shared principles) — people expect to select error messages, serial numbers, IP addresses.
- Text containers can be any height and should scroll when content overflows. Defaults exist for a reason: leading-edge alignment (left in LTR) and the semantic text color; deviating needs a justification.

**Specs**
- No numeric values. Defaults: leading-edge alignment, semantic text color, internal scroll on overflow.

**Do**
- Use a textarea/editor only for long or rich editable text; simpler elements otherwise.
- Use relative units (rem/em); test with accessibility options on (bold text, large text).
- Make diagnostic/reference text (errors, IDs, addresses) selectable and copyable.
- Declare correct `type`/`inputmode` (email, url, numeric) so touch keyboards match the content.

**Don't**
- Don't use a full editor when a static element or single-line field suffices.
- Don't let creative styling (fonts, colors, alignment) undermine readability.

**Web review checks**
- [ ] Long-form or rich editable content uses a textarea/editor; short editable strings use single-line inputs; read-only text is plain elements, not disabled inputs.
- [ ] Error messages, IDs, tokens, IPs, and code output are selectable (`user-select` not disabled) and copyable.
- [ ] Body text uses relative units (rem/em) and the layout survives 200% browser zoom / OS large-text without clipping or overlap.
- [ ] Multiline text containers scroll internally when content overflows instead of clipping or breaking layout.
- [ ] Inputs declare correct `type`/`inputmode` for their content.
- [ ] Text is left-aligned to the leading edge by default; centered/justified multiline text is a deliberate, justified exception.

---

## Labels

**Principles**
- Labels are the connective tissue of the interface — in buttons they state the action (Edit, Cancel, Send), in lists they identify items, in views they introduce controls — helping people understand context and what they can do next.
- Relative importance is expressed through a systematic hierarchy of text colors, not ad-hoc grays: exactly four semantic levels (primary / secondary / tertiary / quaternary) that adapt to light and dark. Using the scale keeps emphasis consistent app-wide.
- Prefer system fonts with scalable sizing; custom fonts are acceptable only if legibility holds across user text-size settings.
- Copyability applies (see shared principles): informative label values must be selectable.

**Specs**
- Exactly **4 semantic text-color levels** for text importance — web: a 4-step text-color token scale defined per theme (light and dark).

**Do**
- Use static text for small uneditable content; switch to an input the moment editing is needed, or a textarea for long text.
- Use the semantic color scale to express hierarchy (primary content vs. secondary metadata vs. placeholder/disabled).
- Keep text-scaling/zoom support intact when styling labels.

**Don't**
- Don't invent one-off gray values for de-emphasized text outside the token scale.
- Don't use custom fonts that break legibility at user-adjusted sizes.

**Web review checks**
- [ ] Text colors come from a small semantic token scale (~4 levels), defined for both light and dark themes — no hard-coded hex grays scattered in components.
- [ ] Button labels are verbs stating the action (Send, Cancel, Edit), not vague words; list items and controls have introducing labels where context isn't obvious.
- [ ] De-emphasized text (timestamps, metadata) uses the secondary/tertiary tokens consistently across all panels.
- [ ] Static text is rendered as text elements (not readonly inputs), and informative values are selectable.
- [ ] Font sizing is relative (rem) so labels scale with user preferences without truncating critical words.

---

## Image views

**Principles**
- An image is for display only; people don't expect plain images to be interactive. If an image must be clickable, make it a real button or link containing the image — that carries correct affordance, focus, and semantics.
- Interface icons should be vectors, not rasters: vectors recolor with theme/accent colors, stay crisp at any scale, and stay consistent with the icon system.
- Text composited over images degrades both: guard legibility with strong contrast plus a shadow, scrim, or background layer.
- Prescale images to their rendered size and keep animated sequences uniformly sized — runtime scaling costs performance; mixed frame sizes cause visual jitter.

**Specs**
- Rich formats: PNG, JPEG, and vector (web: PNG, JPEG, SVG, WebP/AVIF).
- All frames in an animated sequence share one size/shape; prescale to the container so no runtime scaling occurs.

**Do**
- Wrap clickable images in a `<button>`/`<a>`, never a bare `<img>` with an onClick.
- Use SVG/symbol icons that inherit `currentColor`/theme variables.
- Add a scrim, gradient, or text shadow when overlaying text on imagery.
- Serve images at (or near) display size; fix container dimensions to avoid layout shift.

**Don't**
- Don't attach click behavior to a plain image element; don't use bitmaps where a recolorable vector icon works.
- Don't overlay text on busy imagery without a contrast aid.
- Don't mix frame sizes in an animation sequence.

**Web review checks**
- [ ] No bare `<img>`/`<div>` with onClick where an image is interactive — it must be inside a `<button>` or `<a>` with an accessible name.
- [ ] UI icons are SVG (or symbol components) colored via `currentColor`/CSS variables so they adapt to themes and accent color.
- [ ] Any text over an image (avatars, banners, media cards) has a scrim/gradient/shadow and remains readable over worst-case image content.
- [ ] `<img>` elements have explicit width/height (or aspect-ratio) to prevent layout shift; images aren't drastically downscaled by CSS from oversized sources.
- [ ] Decorative images have empty `alt=""`; informative images have descriptive `alt`.

---

## Charts

**Principles**
- A chart's job is to communicate a few key insights, not dump a dataset; summarize the main message in a title/subtitle so people grasp it before (or without) reading the marks. Users with cognitive disabilities and screen-reader users depend on this framing.
- Visual hierarchy: data marks are most prominent; axes, grid lines, and labels are quiet supporting context that must not compete with the data.
- Axis semantics carry meaning: bounded quantities (battery 0–100%) get fixed axes; dynamic ranges suit wide-varying data so marks fill the plot. Bar height is read as magnitude, so bars need a zero baseline; line charts of narrow-band data (heart rate) may crop the baseline so meaningful differences stay visible.
- Interaction may enrich a chart but must never gate critical information — the key takeaway is visible without hover/drag.
- Color is a highlight channel, never the sole encoding: pair it with shape, pattern, or labels so colorblind users get the same information.

**Specs**
- Bar charts: **Y-axis lower bound = 0** (so relative bar heights read as true ratios); line charts of narrow-range data may use a nonzero lower bound.
- **Fixed axis range** when the domain has meaningful absolute bounds (e.g., 0–100%); dynamic range so the max value sits near the top of the plot otherwise.
- Tick labels use familiar arithmetic sequences (**0, 5, 10 …**) — uncommon steps (1, 6, 11 …) cost comprehension time.
- Hit target: when marks are too small to point at precisely, expand the interactive hit area to the **entire plot area** and support scrubbing.
- Accessibility: **one accessible label per important mark or per meaningful group of marks** — unless the chart is a thumbnail, which gets a single summary label.
- Stacked/adjacent color areas need **visible separators** between segments.
- Date/unit clarity in labels: "June 6" not "6/6"; "60 minutes"/"60 meters" not "60m".

**Do**
- Title/subtitle every chart with its main message ("Rain expected in the next hour"), not just a dataset name.
- Keep vertical-axis labels short; move units to the title; align the chart's leading edge with surrounding views (Y-axis labels on the trailing side if needed).
- Combine mark types when it clarifies (points on a line to expose individual values within a trend).
- Animate changes to marks/axes AND convey the change non-visually (announcements) for users with animations off or using screen readers.
- Let keyboard users navigate marks in a logical path (e.g., along the X axis) and, for large datasets, by subsets rather than every point.
- Write accessible labels with context + value, in consistent axis order, using objective values (avoid "rapidly", "almost"); describe what data represents, not its appearance ("systolic series", not "the red dots").
- Hide visible axis/tick text from assistive tech when mark labels/summaries already carry the values.

**Don't**
- Don't rely on color alone to distinguish series.
- Don't require interaction (hover/drag) to reveal the chart's critical information.
- Don't overload with grid lines, or starve the chart of them — tune density to the task.
- Don't use subjective adverbs or ambiguous abbreviations in accessible descriptions.

**Web review checks**
- [ ] Every chart has a text title/summary stating its main message, exposed to screen readers (not just an axis-labeled SVG).
- [ ] Bar charts have a zero baseline; axes with natural bounds (percentages) are fixed 0–100; tick steps are familiar sequences (0/5/10, 0/25/50…).
- [ ] Series are distinguishable without color (shape, pattern, dash, or direct labels), and adjacent color blocks in stacked bars have separators.
- [ ] Tooltip/hover-only data has a non-hover equivalent (visible summary, table, or focusable marks); keyboard users can reach data values.
- [ ] Small marks aren't the hit target — pointer interaction works across the whole plot area (scrubbing), not pixel-precise hover.
- [ ] Grid lines/axis labels are visually muted relative to data marks (lighter color, thinner stroke); data has the highest contrast in the chart.
- [ ] Chart leading edge aligns with surrounding content; Y-axis labels don't push the plot out of alignment.
- [ ] Accessible labels give context + exact values ("June 6, 9,132 steps"), no subjective terms, no ambiguous formats like "6/6" or bare "60m".

---

## Web views (embeds)

**Principles**
- An embedded web view (iframe/preview) exists to let people briefly consult web content without losing app context; the moment it becomes a browsing session, hand off to the real browser instead of half-reimplementing one.
- Navigation state must match expectations: if people can follow links to multiple pages inside the embed, they expect working back/forward controls — provide them, they aren't automatic.

**Specs**
- None.

**Do**
- Provide back/forward controls when embedded content is multi-page.
- Offer an "open in browser/new tab" escape hatch for extended reading.

**Don't**
- Don't build a browser inside the app (URL bar, tabs, bookmarks).
- Don't trap users in an embed with no way back after navigating.

**Web review checks**
- [ ] Any iframe/embedded preview that allows link navigation offers back/forward or at minimum a reset-to-start control.
- [ ] Embedded external content has a visible "open in new tab" affordance instead of encouraging prolonged in-app browsing.
- [ ] Embeds are used for brief in-context reference (link previews, docs panels), not as a general browsing surface.
- [ ] Sandboxed iframes can't hijack the app context (navigation confined to the frame, `sandbox`/`rel="noopener"` where applicable).

---

## Boxes (group containers)

**Principles**
- A box (bordered or background-tinted container) exists to communicate that its contents are logically related; the visual separation IS the message.
- A box loses its meaning as it approaches the size of its container — separation only reads when there is clearly "inside" vs "outside".
- Nesting boxes inside boxes makes an interface feel busy and constrained; hierarchy inside a box should come from padding and alignment, not more borders.
- A title on a box tells sighted users *why* items are grouped and lets screen-reader users predict what follows.

**Specs**
- Box titles: sentence-style capitalization, no ending punctuation (exception: settings panes may append a colon).
- Box fills: a step down the semantic background-hierarchy scale (secondary/tertiary surface tokens), not an arbitrary color.
- Title position default: above the box.

**Do**
- Keep boxes small relative to their containing view.
- Use padding and alignment to express subgrouping inside a box.
- Provide a succinct title when the relationship between contents isn't obvious.

**Don't**
- Don't nest boxes to define subgroups.
- Don't let a grouped container grow to nearly the full window/panel size.
- Don't add ending punctuation to group titles.

**Web review checks**
- [ ] Card/panel containers use a semantic background one step removed from the page background (secondary surface token), not ad-hoc hex values — verify in both themes.
- [ ] No card/box nested directly inside another card/box with its own border or background; inner grouping uses spacing/alignment only.
- [ ] Grouped containers occupy clearly less than the full panel — if a "card" spans ~100% of its parent, question whether the border adds anything.
- [ ] Section/group headings use sentence case and no trailing punctuation (except settings-style `Label:` forms).
- [ ] Every visually grouped region has an accessible name (heading or `aria-label`) so screen-reader users get the same grouping cue.

---

## Collections (grids)

**Principles**
- Grids are for image-led content; text is faster to scan in a single-column list. Choose the layout by content type, not aesthetics.
- People expect the standard row/grid arrangements; a novel custom layout draws attention to itself and costs comprehension.
- If reaching an item is effortful, people give up before the content — item selection must be the cheapest action in the view.
- Layout that changes under the user's cursor breaks their spatial model; dynamic reflow is only acceptable in response to an explicit user action.

**Specs**
- None.

**Do**
- Use standard row or grid layouts.
- Pad around grid items so hover/focus effects are visible and items never overlap.
- Animate insert/delete/reorder so people can track what changed.

**Don't**
- Don't use a grid for primarily textual content — use a list/table.
- Don't invent a custom layout that confuses or draws undue attention.
- Don't reflow the layout while people are viewing/interacting, except in response to their explicit action.

**Web review checks**
- [ ] Text-dominant content (message history, file lists, search results) renders as a vertical list, not a card grid; grids are reserved for image/thumbnail content.
- [ ] Grid/list items have visible hover and `:focus-visible` states not clipped by neighbors (adequate gap/padding between items).
- [ ] Item insertion/removal/reorder is animated (CSS transitions or FLIP) rather than snapping, so users can track changes.
- [ ] Lists don't reflow or reorder themselves while the user is scrolling/hovering (e.g., streaming updates don't shift items under the pointer without user action).

---

## Lists and tables

**Principles**
- Row-based layout is the best format for scanning and reading text; prefer it whenever content is textual. Use a grid only for images or widely varying item sizes.
- Selection feedback must match semantics: navigation lists *persistently* highlight the selected row (it shows where you are in the hierarchy); option lists highlight briefly and then mark the choice (e.g., a checkmark). Mixing the two confuses "where am I" with "what did I pick".
- Succinct row text minimizes truncation and wrapping; if items are long, show titles only and push full content to a detail view.
- Middle-truncation can beat end-truncation (see shared principles).
- People appreciate reordering lists even when they can't add/remove items.

**Specs**
- Column headings: nouns or short noun phrases, no ending punctuation (shared principle).
- Clicking a sorted column's heading again reverses the sort direction (shared principle).
- Alternating row background colors recommended for wide multicolumn tables (shared principle).

**Do**
- Persistently highlight the selected row in any list used for navigation (master → detail).
- Let people sort by clicking column headings and resize columns in data tables.
- Keep row text short; provide a header/label for context when a single-column table has no column heading.
- Use middle-ellipsis for values whose ends are distinguishing (paths, filenames).

**Don't**
- Don't use an info/detail button for navigation — it reveals metadata about a row; navigation uses a chevron/disclosure indicator.
- Don't stack multiple interactive elements at the trailing edge of rows where they compete for the same hit area.
- Don't display over-large rows full of text; restructure into title + detail view.

**Web review checks**
- [ ] Navigation lists (e.g., a sidebar conversation list) persistently highlight the active item (selected state survives focus loss and reload) with a distinct selected style, not just hover.
- [ ] Option-style lists (pickers, settings) mark the chosen item with a checkmark/indicator rather than a persistent nav-style highlight.
- [ ] Data tables support click-to-sort on column headers with a visible sort-direction indicator, and clicking again reverses direction.
- [ ] Table column headings are short noun phrases with no trailing punctuation; single-column lists without headers have some contextual label.
- [ ] Long identifiers (file names, titles) truncate with ellipsis rather than overflowing; middle-truncation where the string's end is meaningful.
- [ ] Wide multicolumn tables use alternating row backgrounds or strong row delineation in both themes.
- [ ] Trailing-edge row controls (delete, menu, chevron) don't overlap other interactive zones; each has its own adequate hit area.

---

## Outline views (trees)

**Principles**
- An outline view is a table plus disclosure triangles — use it only for genuinely hierarchical data; flat data belongs in a plain table.
- Hierarchy lives in the first column only; other columns carry attributes of that row. Mixing hierarchy into attribute columns destroys scannability.
- Expansion state is user investment: people who dug down to an item expect the app to remember that path. Retain and restore expansion state across navigation and reloads.
- Sorting a hierarchy sorts within each level (folders sorted, then contents within each folder) — preserving the tree while ordering it.

**Specs**
- Column headings: nouns/short noun phrases, no punctuation, no trailing colon; headings are **required** in multicolumn outline views (shared heading principle).
- Modifier convention: click a disclosure triangle expands **one node**; Option/Alt-click expands the node **and all its descendants**.
- Editable cells: **single click edits** the cell content; **double click** may perform a different action (e.g., open).
- Alternating row colors recommended for wide multicolumn outlines (shared principle).

**Do**
- Show the tree structure in the leading column only.
- Persist and restore users' expansion choices across sessions.
- Provide an expand-all affordance (modifier-click or explicit control) for deep trees.
- Let people resize columns and sort by clicking headings (re-click reverses direction).
- Prefer a centered ellipsis over clipping for long cell text.
- Pair a lengthy outline with a search field so people can jump to values.

**Don't**
- Don't use a tree control for flat data.
- Don't put disclosure/hierarchy affordances in more than one column.
- Don't discard expansion state on navigation or reload.

**Web review checks**
- [ ] Tree components (folder/workspace navigation) restore their expansion state after navigation and across reloads (persisted to storage or URL).
- [ ] Hierarchy indentation and disclosure chevrons appear only in the primary column/label, never in metadata columns.
- [ ] Deep trees offer an expand-all/collapse-all affordance (button or alt-click).
- [ ] Long node labels truncate with ellipsis (middle-ellipsis where endings are distinctive) instead of clipping or wrapping badly.
- [ ] Long tree/outline views are paired with a search or filter field.
- [ ] Tree keyboard support: arrow keys expand/collapse and move focus (ARIA tree pattern) or an equivalent accessible interaction exists.

---

## Disclosure controls

**Principles**
- Progressive disclosure: hide detail until relevant. The most-used controls sit at the top of the hierarchy, always visible; advanced options are collapsed by default — essentials stay findable without overwhelming people.
- The chevron/triangle direction is a state language people already know: it must accurately reflect collapsed vs expanded, or the control lies.
- The control must sit next to what it reveals — the spatial link makes cause and effect legible.

**Specs**
- Disclosure triangle (inline chevron): points toward the **leading edge (right in LTR) when collapsed**, points **down when expanded**.
- Disclosure button ("show more" expander): points **down when collapsed, up when expanded**.
- **Maximum one disclosure button per view** — multiple standalone expanders add confusing complexity.

**Do**
- Label disclosure triggers descriptively ("Advanced options"), stating what is hidden.
- Place the disclosure control immediately adjacent to the content it toggles.
- Put likely-used controls above the fold of the disclosure hierarchy; hide only advanced/rare ones.

**Don't**
- Don't use multiple standalone expand/collapse buttons in a single view.
- Don't hide primary or frequently needed functionality behind a disclosure.

**Web review checks**
- [ ] Every collapsible section's chevron rotates to match state (right = collapsed, down = expanded in LTR) and the rotation is consistent app-wide.
- [ ] Collapsible triggers have a text label describing the hidden content, not just an icon.
- [ ] Expanders use `aria-expanded` and the trigger is keyboard-operable (Enter/Space).
- [ ] Frequently used settings/actions are visible by default; only advanced/rare options are collapsed.
- [ ] No panel contains more than one standalone "show more" style disclosure button; sets of collapsibles use a consistent accordion/tree pattern instead.

---

## Split views

**Principles**
- A split view shows multiple levels of one hierarchy at once — selecting in the primary pane drives the secondary pane. A persistent selection highlight in every leading pane keeps people oriented about how the panes relate.
- Split views need horizontal room; at compact widths panes wrap/truncate and become illegible — collapse to single-pane navigation instead.
- Because panes expose multiple hierarchy levels simultaneously, drag-and-drop between panes is a natural, expected way to move content.
- Panes people can hide need multiple, discoverable restore routes (toolbar button + menu/shortcut), or users get stranded.

**Specs**
- Preferred divider: thin style, **1px visual width** — maximizes content space while remaining usable; thicker dividers only when strong linear content on both sides would camouflage a thin one. Make the drag hit area comfortably wider than the visual line.
- Set **minimum and maximum pane sizes** so a resized pane can never shrink to the point the divider "disappears".
- Reference layout ratio: primary pane **1/3** of width, secondary **2/3** (or half-and-half) — panes should look deliberately balanced.
- **Two or three vertical panes** are the supported configurations; more fragments the hierarchy.

**Do**
- Persistently highlight the current selection in each pane that leads to the detail view.
- Let people resize panes via draggable dividers with sane min/max bounds, and hide panes (sidebar, inspector) to reduce distraction.
- Provide multiple ways to restore hidden panes: visible toggle, menu command, and keyboard shortcut.
- Design the layout at multiple window widths; make sure pane-to-pane navigation still works at narrow sizes.

**Don't**
- Don't show multiple panes in a compact-width environment — content wraps and truncates.
- Don't allow pane resizing without minimums — a pane collapsed to ~0 makes the divider unfindable.
- Don't open a new window for supplementary info that could be a pane (keeps user in context).

**Web review checks**
- [ ] The multi-pane split keeps a persistent selection highlight in the leading pane matching the visible detail content.
- [ ] Resizable dividers enforce min/max pane widths in code (min-width on sidebar/panel) so no pane can collapse to an unusable sliver.
- [ ] Divider is visually thin (~1px) but its drag hit area is comfortably wider than its visual width.
- [ ] A collapsed/hidden pane is restorable by at least two routes (visible toggle button + keyboard shortcut or menu).
- [ ] At narrow viewport widths the multi-pane layout collapses to a single pane with clear navigation between levels, rather than squeezing all panes.
- [ ] Hiding/showing a pane preserves the other panes' state and does not reset scroll or selection.

---

## Tab views

**Principles**
- Tabs signal enclosure: people expect every tab's content to be similar/related in kind. Unrelated content under one tab set breaks the model.
- A tab set is efficient because all choices are visible at once and selection costs one click; a dropdown hides choices and costs two clicks — only fall back to a menu when tabs won't fit.
- Panes are mutually exclusive and must be self-contained: a control inside one tab must never affect content in another tab, or users can't reason about cause and effect.

**Specs**
- **Maximum 6 tabs** in a tab view; more overwhelms and causes layout issues — switch to a menu/select pattern beyond that.
- Tab labels: nouns or short noun phrases, title-style capitalization.
- Tab strip sits on the top edge of the content area; inset the tab view with a margin from the window body on all sides (extending to window edges is unusual).
- Efficiency baseline: tabs = **1 click** to switch; menu = **2 clicks**.

**Do**
- Use tabs only for closely related, peer content areas.
- Label each tab so people can predict the pane's content before clicking.
- Keep each pane fully self-contained.
- Hide the tab strip if switching is programmatic only.

**Don't**
- Don't exceed six tabs — use a select/menu instead.
- Don't use a dropdown where tabs fit (slower, hides options).
- Don't let controls in one tab mutate another tab's content.

**Web review checks**
- [ ] No tab group renders more than 6 tabs; overflow cases degrade to a menu or scrollable pattern deliberately, not by wrapping/clipping.
- [ ] Tab labels are short nouns in title case, predictive of content (no icon-only tabs without tooltips/aria-labels).
- [ ] Tab panels are self-contained: state changes inside one panel don't silently alter another panel's content.
- [ ] The selected tab is visually unambiguous in both themes and exposed via `aria-selected`; tablist keyboard navigation (arrow keys) works.
- [ ] Content areas with 2–5 peer views use visible tabs rather than a dropdown switcher.

---

## Sidebars

**Principles**
- A sidebar is for top-level navigation between areas/collections; it trades significant space for persistent orientation. When space is tight, a more compact navigation serves better — or offer both via an adaptive control.
- People treat sidebar order as *their* mental map: let them customize which items appear and in what order.
- Keep hierarchy shallow — deeper data belongs in a split view (sidebar → content list → detail); otherwise the sidebar becomes an unscannable tree.
- Users expect to hide the sidebar to reclaim space, via standard affordances (show/hide button, menu command, shortcut) — but never hide it *by default*, or it stops being discoverable.
- Icon color is semantic: sidebar icons take the app/user accent color by default. A fixed off-accent color must be rare and purposeful (a single flagged/VIP marker) — used sparingly it draws attention; used broadly it means nothing.

**Specs**
- Show **no more than 2 levels of hierarchy** in a sidebar; deeper hierarchies get a split view with an intermediate content list.
- Sidebar rows come in **3 sizes (small / medium / large)** governing row height, text, and glyph size — one consistent size scale per sidebar; respect the user's size preference where one exists.
- Sidebar icons use the accent color by default and must follow a user-changed accent/theme color.

**Do**
- Group long content with collapsible groups to manage vertical space; title each group with a succinct, descriptive label (omit needless words).
- Use familiar, recognizable symbols for sidebar items; prefer scalable vector icons over bitmaps.
- Provide a show/hide sidebar control (button and/or menu command) and consider auto-collapsing the sidebar when the window gets narrow.
- If the sidebar floats above content, extend or mirror content beneath it to reinforce the layering.

**Don't**
- Don't hide the sidebar by default.
- Don't put critical information or actions *only* at the bottom of a sidebar — users often position windows so the bottom edge is offscreen.
- Don't use fixed icon colors broadly; reserve them for one or two meaningful exceptions.
- Don't exceed two levels of nesting or use vague group labels.

**Web review checks**
- [ ] Sidebar can be collapsed/hidden via a visible toggle (and ideally a keyboard shortcut), and it is visible by default on first load.
- [ ] Sidebar nesting is at most 2 levels deep; long sections use collapsible groups with short, descriptive headers.
- [ ] No critical action (settings, account, "new item") exists only at the bottom of the sidebar without another route; bottom-anchored items are non-critical or duplicated elsewhere.
- [ ] Sidebar item icons inherit the theme/accent color consistently; any hard-coded icon color is a deliberate semantic exception, not decoration.
- [ ] At narrow window widths the layout adapts: sidebar auto-collapses or converts to a compact navigation rather than squeezing content.
- [ ] If users can reorder/pin sidebar items, the order persists; if not, evaluate whether customization is warranted.
- [ ] Sidebar row height, text size, and icon size are consistent within the sidebar (one size scale, not mixed).

---

## Tab bars (top-level navigation)

**Principles**
- Navigation tabs are for moving between top-level sections, never for actions — actions belong in a toolbar. Mixing the two breaks the user's model of "where am I" vs. "what can I do".
- Each section preserves its own navigation state, so switching is cheap and non-destructive; that guarantee is why people trust tabbed navigation.
- Keep the navigation visible everywhere in the app (except under temporary modals): hiding it makes people forget which area they're in.
- Fewer tabs are easier to navigate; every added tab dilutes all the others. If sections outgrow the tab bar, switch to (or adapt into) a sidebar rather than overflowing.
- A stable UI is a predictable UI: never disable or hide a nav item because its content is currently unavailable — show it and explain the empty state inside.

**Specs**
- Tab labels: **single words** whenever possible; every tab has **both an icon and a text label**.
- If users can customize the tab set, default to **5 or fewer** tabs to preserve continuity between compact and regular layouts.
- Badge: a **red oval containing white text** (a number or "!"), reserved for critical new/updated information only.
- Avoid overflow ("More") tabs — content behind an overflow item is harder to reach and notice.
- Icon guidance: prefer filled symbols for nav tabs; in compact layouts icons stack above labels, in regular layouts they sit side by side.
- Reference constants (from tvOS, kept for the principle): tab bar height **68px**, top edge **46px** from screen top — nav-bar dimensions are fixed system constants, not per-screen choices. Web takeaway: give the app's nav bar one fixed height everywhere.

**Do**
- Use a badge only for information that genuinely warrants attention; overuse destroys its meaning.
- Prefer a monochromatic tab appearance or a clearly differentiated accent when surrounding content is already bright and colorful — nav labels must not blend into content colors.
- Keep current-section indication persistent and obvious.

**Don't**
- Don't put action buttons in the navigation strip.
- Don't hide the navigation while the user moves through sections.
- Don't disable or remove nav items conditionally — explain empty sections instead.
- Don't let tab count grow until items overflow.

**Web review checks**
- [ ] Top-level navigation controls (sidebar sections, nav rail, tab strip) only navigate; buttons that *do* things (send, new, delete) live in toolbars/headers, not among nav items.
- [ ] The active section is always visibly indicated and the nav remains visible on every section's screen (modals excepted).
- [ ] Switching sections and returning restores the previous scroll position / navigation state of that section.
- [ ] No nav item is disabled or hidden based on data availability; empty sections render an explanatory empty state.
- [ ] Nav labels are one word where possible; each item pairs a label with an icon (icon-only nav requires tooltips + `aria-label` at minimum).
- [ ] Notification badges are red-with-white-text, contain a count or "!", and appear only for genuinely important events (not routine activity).
- [ ] Nav accent/selection color has clear contrast against surrounding content in both light and dark themes.

---

## Search fields

**Principles**
- Search should feel responsive and continuous: results that refine live as the user types make search a conversation, not a form submission.
- Show suggestions (recent searches before typing, predictive suggestions while typing) so people can search faster even when live results aren't feasible — suggestions offload recall onto recognition.
- Default to the broadest search scope, then let people narrow. A broad first pass shows the full result landscape; a narrow default hides results people didn't know existed.
- Search placement encodes its scope: a global search belongs in a persistent, always-reachable location (toolbar/sidebar/nav); an inline field placed directly above a list signals "this filters only what's below", not the whole app.
- Prioritize and categorize results so the most relevant items appear first with minimal scrolling.

**Specs**
- A search field displays **three parts**: a magnifier icon, placeholder text, and a Clear button once text is entered.
- Start search **immediately on the first keystroke** when possible (live filtering).
- Placement: global search at the trailing side of the toolbar; search at the top of the sidebar when it filters the sidebar's own content; inline search directly above the list it filters (may pin to the top on scroll).
- Dedicated search areas: **auto-focus** the field when the person navigates there — except when only an on-screen keyboard is available, where auto-focus would unexpectedly cover content.

**Do**
- Use placeholder text to communicate what can be searched (scope + content type).
- Provide a scope bar to filter among clearly defined categories, moving from broad to narrow.
- Use tokens for common, structured filters (e.g., "from: person", "type: photo") — the visual encapsulation tells people the term is selectable/editable as a unit; pair tokens with suggestions so people discover which tokens exist.
- Keep the search experience consistent across window sizes; in compact widths keep search where it is contextually useful (above the content it filters).

**Don't**
- Don't make users guess a search field's scope — placement and placeholder must communicate it.
- Don't bury the most relevant results or return one flat undifferentiated list when categorization would help.
- Don't auto-focus a search field when doing so pops an on-screen keyboard over the content.

**Web review checks**
- [ ] Search field has a magnifier icon, a meaningful placeholder describing the search scope, and a one-click Clear (x) button that appears when text is present.
- [ ] Results filter live as the user types (debounced), or typed-ahead suggestions appear; there is no "press Enter and wait"-only flow for local filtering.
- [ ] Recent searches or suggestions are offered when the field is focused and empty (for global search surfaces).
- [ ] A search field that filters only one list/panel is rendered directly above that list (inline), not in a global position; a global search lives at a persistent toolbar/sidebar location.
- [ ] Scope filters (tabs/chips/scope bar) default to the broadest scope, with narrowing as an explicit user action.
- [ ] Navigating to a dedicated search view auto-focuses the input on desktop (physical keyboard); auto-focus is suppressed on touch-only viewports.
- [ ] Filter tokens/chips inside search are visually encapsulated, selectable, and removable as single units.

---

## Token fields (chips/tag inputs)

**Principles**
- Converting free text into tokens turns fragile strings into manipulable objects: a token can be selected, dragged, reordered, moved between fields, and edited as a single unit (e.g., mail recipients). This reduces editing errors and makes structured input tangible.
- Suggestions-as-you-type plus "pick a suggestion → becomes a token" teaches people what valid values exist without requiring exact recall.
- A token is a good host for a contextual menu: attach related info and actions (edit, view details) directly to the object it concerns.
- Timing of suggestions matters: suggestions that pop up too eagerly can distract mid-typing — tune the delay to feel helpful, not jumpy.

**Specs**
- Default conversion trigger: typing a **comma** converts the preceding text into a token; additional triggers (e.g., **Enter**) can be added.
- Default suggestion delay: **0 (immediate)**; increase the delay if instant popups distract while typing.
- The pattern is a desktop-native component, but chips/tag inputs transfer directly to web.

**Do**
- Provide a suggestion list while typing and insert selections as tokens.
- Give tokens a contextual menu with token-specific info and editing options.
- Support multiple commit keys (comma, Enter) for tokenization.

**Don't**
- Don't show suggestions so aggressively that they interrupt typing flow.
- Don't leave structured multi-value input as raw comma-separated text when tokens would make items independently editable.

**Web review checks**
- [ ] Multi-value inputs (recipients, tags, filters) render committed values as discrete chips/tokens, not raw delimited text.
- [ ] Both Enter and comma commit the current text into a token; Backspace at the start of the input selects/deletes the last token.
- [ ] Tokens are individually selectable and removable (visible remove affordance + keyboard support), and reorderable where order matters.
- [ ] Typing surfaces matching suggestions; choosing a suggestion inserts it as a token.
- [ ] Token chips expose secondary actions (edit, view details) via context menu or click where relevant.
- [ ] Token visual treatment (pill background, spacing) clearly distinguishes committed tokens from in-progress text.

---

## Path controls (breadcrumbs)

**Principles**
- A path control (web: breadcrumb trail) makes the location of the current item visible and navigable — it answers "where does this live?" for hierarchical content.
- Location indicators belong in the content/body area they describe, not in the app chrome: the path describes the content, so it is not an app-level control. (Apple places the Finder path bar at the bottom of the window body, never in the toolbar or status bar.)

**Specs**
- None numeric. Two styles exist: a standard always-visible bar and a pop-up (dropdown) style.

**Do**
- Place path/breadcrumb controls within the content region whose hierarchy they describe.
- Show the path of the selected item, falling back to the container's path when nothing is selected.

**Don't**
- Don't put path/breadcrumb controls in global toolbars or status bars.

**Web review checks**
- [ ] Hierarchical content (nested projects/folders/threads) exposes a breadcrumb showing the current location, with each ancestor segment clickable to navigate up.
- [ ] The breadcrumb lives inside the content panel it describes (e.g., panel header), not in the global app chrome.
- [ ] Breadcrumb reflects the current selection, and falls back to the containing collection when nothing is selected.

---

## Quick-scan spec table

| Spec | Value | Topic |
|---|---|---|
| Bar chart Y-axis lower bound | 0 (always) | Charts |
| Bounded-domain axis range | Fixed (e.g., 0–100%) | Charts |
| Unbounded-domain axis range | Dynamic; max value near top of plot | Charts |
| Axis tick steps | Familiar sequences (0, 5, 10… / 0, 25, 50…) | Charts |
| Small-mark hit target | Expand to entire plot area + scrubbing | Charts |
| Accessible labels per chart | 1 per mark or meaningful group; 1 total for thumbnails | Charts |
| Stacked segment boundaries | Visible separators required | Charts |
| Label formats | "June 6" not "6/6"; "60 minutes" not "60m" | Charts |
| Animated image frames | All one size/shape; prescaled, no runtime scaling | Image views |
| Semantic text-color levels | 4 (primary/secondary/tertiary/quaternary) | Labels |
| Zoom survival | Layout intact at 200% browser zoom | Text views |
| Box background | 1 step down the surface-token scale | Boxes |
| Box title style | Sentence case, no ending punctuation | Boxes |
| Disclosure triangle direction | Leading edge (right in LTR) collapsed → down expanded | Disclosure controls |
| Disclosure button direction | Down collapsed → up expanded | Disclosure controls |
| Disclosure buttons per view | Max 1 | Disclosure controls |
| Column heading style | Noun phrase, no punctuation; required in multicolumn outlines | Lists and tables / Outline views |
| Sort re-click | Reverses direction | Lists and tables / Outline views |
| Wide multicolumn rows | Alternating backgrounds recommended | Lists and tables / Outline views |
| Expand-all modifier | Alt/Option-click on disclosure triangle | Outline views |
| Cell click semantics | Single click edits; double click = alternate action | Outline views |
| Split-view divider | 1px visual width; wider drag hit area | Split views |
| Pane resize bounds | Min + max enforced (never collapse to 0) | Split views |
| Reference pane ratio | 1/3 primary : 2/3 secondary, or 50/50 | Split views |
| Vertical pane count | 2–3 | Split views |
| Max tabs per tab view | 6 | Tab views |
| Tab switch cost | 1 click (menu alternative = 2 clicks) | Tab views |
| Tab view placement | Tab strip on top edge; inset from window body on all sides | Tab views |
| Tab label style | Noun, title case | Tab views |
| Sidebar hierarchy depth | Max 2 levels | Sidebars |
| Sidebar row sizes | 3 (small/medium/large), one scale per sidebar | Sidebars |
| Sidebar icon color | App/user accent by default; fixed colors rare + semantic | Sidebars |
| Sidebar default visibility | Visible (never hidden by default) | Sidebars |
| Nav tab labels | Single word where possible; icon + label always | Tab bars |
| Customizable tab default count | ≤5 | Tab bars |
| Badge appearance | Red oval, white text (number or "!"), critical info only | Tab bars |
| Nav bar height (platform reference) | 68px height, 46px top inset — fixed constant, not per-screen | Tab bars |
| Search field parts | 3: magnifier icon, placeholder, Clear button | Search fields |
| Search start | First keystroke (live filtering) | Search fields |
| Search auto-focus | On for dedicated search views with physical keyboard; off for on-screen keyboards | Search fields |
| Token commit trigger | Comma (default) + Enter | Token fields |
| Suggestion delay default | 0 (immediate); increase if distracting | Token fields |
