# HIG Controls & overlays — buttons, menus, toolbars, alerts, sheets, popovers, inputs, progress

Apple HIG guidance for interactive controls and overlay surfaces, translated to web (pt = px 1:1) for reviewing React frontends: what each component is for, its concrete specs, and pass/fail checks.

## Contents

- [Buttons](#buttons)
- [Context menus](#context-menus)
- [Edit menus & selection editing](#edit-menus--selection-editing)
- [Menus (dropdowns)](#menus-dropdowns)
- [Pop-up buttons (selection dropdowns)](#pop-up-buttons-selection-dropdowns)
- [Pull-down buttons (command menus)](#pull-down-buttons-command-menus)
- [Toolbars](#toolbars)
- [Action sheets (confirmation dialogs)](#action-sheets-confirmation-dialogs)
- [Alerts](#alerts)
- [Page controls (dot indicators)](#page-controls-dot-indicators)
- [Panels & inspectors](#panels--inspectors)
- [Popovers](#popovers)
- [Scroll views](#scroll-views)
- [Sheets (modals)](#sheets-modals)
- [Windows & floating surfaces](#windows--floating-surfaces)
- [Combo boxes (autocomplete inputs)](#combo-boxes-autocomplete-inputs)
- [Pickers](#pickers)
- [Segmented controls](#segmented-controls)
- [Sliders](#sliders)
- [Steppers](#steppers)
- [Text fields](#text-fields)
- [Toggles, checkboxes, radios](#toggles-checkboxes-radios)
- [Progress indicators](#progress-indicators)
- [Gauges (meters)](#gauges-meters)
- [Quick-scan spec table](#quick-scan-spec-table)

Shared principles that recur across sections (stated once here):

- **Prominence is scarce.** One accent/prominent action per view or toolbar. Color-prominent controls are found fastest, so each extra one adds deliberation cost.
- **Destructive = red, last, confirmed.** Destructive items sit in the final group of any menu, render in the destructive color, and get a confirmation step in a *different screen location* — a menu tap is cheap and easily mis-hit. Never bind destruction to the Enter-key default.
- **One transient layer at a time.** One popover, one sheet, one modal. Stacked transient surfaces destroy the "where am I / how do I get back" model.
- **Command menus vs. selection menus are different components.** Choosing a command performs it; choosing a state leaves a visible selection. Never mix the two in one list.

## Buttons

**Principles**
- A button communicates through three aligned attributes: style (size/color/shape), content (icon/label), and role (normal / primary / cancel / destructive). Review all three for agreement.
- Hierarchy among peer choices is signaled by *style*, not *size* — same-size buttons read as a coherent set; mixed sizes read as inconsistency.
- People click visually primary buttons without reading them, so the primary (Enter-key default) role must never attach to a destructive action, even when destruction is the likeliest choice.
- Without a visible press state a button feels unresponsive; people doubt their input registered.

**Specs**
- Minimum effective hit region: 44x44px per control, regardless of visible icon size (padding or an overlay pseudo-element counts).
- Prominent (accent-filled) buttons: 1–2 per view maximum.
- Image buttons: ~10px padding between the image edge and the clickable edge so near-miss clicks still register.
- At most one help affordance per window/context.

**Do**
- Start text labels with a verb ("Add to Cart"); use familiar icons for familiar actions (share = box-with-arrow).
- Wire the primary button to Enter; let dialogs/editable views close on Enter via the primary button.
- Append a trailing ellipsis ("Export…") when the button opens another view requiring further input.
- Show an inline activity state with a changed label ("Checkout" → "Checking out…") for non-instant actions.
- Give every button enough surrounding whitespace to read as visually distinct from its neighbors — a judgment call per layout (no fixed number); crowded buttons merge into one control.

**Don't**
- Don't make the preferred option bigger — express hierarchy via fill/color.
- Don't color button labels similarly to a colorful content background — prefer monochrome labels over busy content.

**Web review checks**
- [ ] Every clickable control has an effective hit area >= 44x44px, even when the visible icon is 16–24px.
- [ ] Each view/panel/modal has at most 1–2 accent-filled buttons; all other actions use secondary/ghost styles.
- [ ] Destructive actions are never the primary/accent button and never the Enter default.
- [ ] All buttons (including divs-as-buttons) have distinct :hover, :active, and :focus-visible styles in light and dark themes.
- [ ] Peer choices (Cancel/Confirm) use equal sizes; hierarchy comes from fill/color.
- [ ] Buttons opening a dialog end their label with "…".
- [ ] Icon-only buttons have an aria-label plus a visible hover tooltip.
- [ ] Async buttons show an in-button loading state and disable re-submission while pending.
- [ ] Every button has enough surrounding whitespace to read as a distinct control — no clusters that merge visually.

## Context menus

**Principles**
- A context menu trades discoverability for convenience: hidden by default, so it holds only the commands most likely needed for the selected item — never the only home for a command, never a dump for rare/advanced items.
- Consistency builds the habit: if right-click works on some items but not similar ones, people conclude it's broken and stop trying.
- Unlike regular menus (which dim unavailable items to teach what's possible), context menus *hide* irrelevant items — the menu is defined by the current selection. (Cut/Copy/Paste on desktop are the traditional dimmed exception.)
- People read from the point nearest the cursor, so frequent items go first — and ordering may need to flip when the menu opens above the trigger.

**Specs**
- Submenus: one level maximum.
- Separator-delimited groups: no more than ~3; total items short enough to scan without scrolling (<= ~10).
- Destructive items: end of the menu, rendered red.
- No keyboard-shortcut hints inside context menus (shortcuts belong in main/app menus).

**Do**
- Mirror every context-menu command somewhere visible (hover toolbar, kebab menu, app menu).
- Add a menu title only when it clarifies scope ("3 messages selected"); give submenus titles that predict their contents.

**Don't**
- Don't provide both a context menu and an edit menu on the same item (ambiguous intent).

**Web review checks**
- [ ] Right-click (contextmenu) handling is uniform: if message bubbles support it, all do, in every lane/panel.
- [ ] Every context-menu action is also reachable from visible UI.
- [ ] Destructive items sit in the last group, styled red in both themes, separated from safe actions.
- [ ] Menus render <= ~10 items, <= 3 groups, at most one submenu level.
- [ ] Inapplicable items are removed, not rendered disabled.
- [ ] No keyboard-shortcut hints in right-click menus.
- [ ] Menu flips gracefully near viewport edges without clipping; frequent items stay nearest the pointer.

## Edit menus & selection editing

**Principles**
- People carry strong muscle memory for Copy/Cut/Paste/Select All: use native mechanisms and standard interactions, not a custom lookalike.
- Edit actions execute without confirmation, so undo/redo is the safety net — every edit action should be undoable.
- Static (noneditable) content still deserves select-and-copy: people paste message text, captions, statuses elsewhere. Content text is copyable; control chrome is not.
- Delete just removes; Cut copies to clipboard then removes — keep the distinction.

**Do / Don't**

- Show only commands relevant to the selection state (no Copy with nothing selected, no Paste with an empty clipboard); place custom commands adjacent to related system commands with short verb labels.
- Don't rebuild standard edit commands in a custom menu, require a custom gesture to reveal editing, or block text selection on readable content.
- Don't add on-screen controls that duplicate standard edit-menu/keyboard functions (Copy/Paste buttons beside selectable text) — that space should host less-discoverable actions; and don't overload the edit surface with many custom commands.

**Web review checks**
- [ ] Message/content text is selectable and copyable (no `user-select: none` on content); button/label chrome is excluded.
- [ ] Native browser context menu on selected text is not hijacked unless the replacement adds value and keeps Copy et al.
- [ ] Cmd/Ctrl+C/X/V/A/Z and Shift+Z work in all editable fields, including the chat composer.
- [ ] Custom "copy" actions give feedback and use the app's standard copy icon.
- [ ] Edit-type actions (rename, edit message) are undoable or re-editable — no silent irreversible mutation.
- [ ] No dedicated Copy/Paste buttons sit beside already-selectable text; visible controls are reserved for actions without a standard shortcut.

## Menus (dropdowns)

**Principles**
- Menus save space by hiding options — which works only if labels, grouping, and ordering match how people scan: top-down, looking for a verb that names their goal.
- In regular menus, unavailable items appear dimmed rather than removed so people can still *discover* capability; even a fully unavailable menu stays openable.
- A toggled item's label must unambiguously describe state vs. action ("HDR On" is ambiguous — write "Turn HDR On", or use one flipping label / a checkmark).
- Every submenu adds complexity; indentation never substitutes for a submenu because it doesn't express the relationship.

**Specs**
- Submenus: max one level deep; a submenu exceeding ~5 items should be promoted to its own menu.
- Consider a submenu when a term repeats in more than 2 sibling items ("Sort by Date/Score/Time" → "Sort by ▸ …").
- Icons within a separator group: all items have one, or none do.
- Ellipsis (…) suffix on any item requiring further input; title-style capitalization, articles dropped (English).
- Long scrolling menus acceptable only for user-generated/dynamic content (history, bookmarks).

**Do**
- Group related commands with separators; keep related commands together even at differing frequencies.
- Use checkmarks for attributes in effect; consider a "reset all" item when toggles stack; use one changeable label for show/hide toggles ("Show Map" ↔ "Hide Map").

**Don't**
- Don't let menus grow unboundedly, indent to fake hierarchy, or add icons that don't clearly represent the item.

**Web review checks**
- [ ] Dropdown items start with a verb, use Title Case, omit articles, and end with "…" if they open a dialog needing input.
- [ ] Within any separator group, either every item has an icon or none does.
- [ ] Unavailable items are rendered disabled (dimmed, aria-disabled), not removed; the trigger stays clickable even when all items are disabled.
- [ ] State toggles use a single flipping label or a checkmark — not two near-duplicate items.
- [ ] No dropdown nests more than one submenu level; submenus hold <= ~5 items.
- [ ] High-frequency actions in the top group; destructive in the final group.
- [ ] The same action uses the same icon in every menu, toolbar, and context menu.

## Pop-up buttons (selection dropdowns)

**Principles**
- A pop-up button (web: select/dropdown picker) chooses ONE state from a flat mutually exclusive list — the closed button then displays the current selection, doubling as a status readout.
- It saves space, but people must *predict* the contents before opening it, via an introductory label or descriptive button text.
- If the list contains actions, allows multi-select, or needs submenus, it's the wrong component — that's a pull-down/menu.

**Specs** — structural: flat list only (no submenus); single selection; shows a default item before any selection.
**Do**
- Provide a sensible default most people will want.
- Add a "Custom…" item for occasional advanced needs instead of cluttering the UI.
- In constrained surfaces (popover/modal rows) prefer an inline select over navigating to a detail view when the option set is small.

**Don't** — mix actions into a selection dropdown; use a pop-up when options should be visible at all times (small critical sets may merit segmented controls/radio groups).
**Web review checks**
- [ ] Selection dropdowns (model picker, theme, language) display the currently selected value when closed.
- [ ] Every selection dropdown has a visible or aria-associated label so options are predictable before opening.
- [ ] Each ships with a sensible default — never a placeholder state the user must resolve, unless a choice is genuinely required.
- [ ] No dropdown mixes state-selection items with command items.
- [ ] Selecting an option closes the menu and updates the trigger immediately.

## Pull-down buttons (command menus)

**Principles**
- A pull-down hides commands behind one press, so it must be worth it: ~3+ items justify the step; 1–2 items should be flattened into direct buttons/toggles.
- It clarifies or parameterizes a single action (Add ▸ what; Sort ▸ by which) — never a warehouse for a view's primary actions, which must stay visible.
- A "More" (…) button trades space for discoverability — the ellipsis says "there's more" but not *what*; weigh that cost deliberately.

**Specs**
- Minimum ~3 menu items to justify a pull-down; 1–2 items → direct controls.
- Destructive items: red text + confirmation in a different screen location than the menu.

**Do** — keep menu length balanced; add a title or item icons only when they add meaning; keep primary actions as visible buttons.
**Don't** — put all of a view's actions into one overflow menu; use a pull-down for mutually exclusive states (use a select); execute a destructive item without confirmation.
**Web review checks**
- [ ] Kebab/ellipsis/"More" menus contain >= 3 items; 1–2-item menus are flattened into visible controls.
- [ ] The view's primary action (Send, New chat) is a standalone visible button, never inside overflow.
- [ ] Destructive items are red and trigger a confirmation dialog before executing.
- [ ] Choosing a command performs it without leaving a "selected" checkmark.
- [ ] Menu triggers signal menu behavior (chevron/ellipsis) rather than looking like one-shot buttons.

## Toolbars

**Principles**
- A toolbar homes frequent commands, navigation, and orientation (title) — its value collapses when overcrowded, so item choice is editorial; lower-priority actions go to overflow.
- Placement is semantic: leading edge = navigation/back/sidebar-toggle + title (always available); center = common commands (collapsible as width shrinks); trailing edge = must-stay-visible items — primary action, search, overflow.
- The toolbar takes its color from the content layer rather than fighting it: minimal tints, monochrome items over colorful content.
- A title exists to confirm location and disambiguate windows — the app name tells people nothing about where they are.

**Specs**
- View/window titles: under 15 characters, to leave room for controls.
- Maximum ~3 logical groups of toolbar items.
- Exactly 1 prominent/tinted primary action, on the trailing edge.
- Fixed spacing between adjacent text-labeled buttons so labels don't merge into one control.
- Overflow: auto-collapse center items as width shrinks; never design layouts that overflow at default sizes.

**Do**
- Prefer recognizable icons; use text where icons represent poorly (e.g., Edit).
- Make every toolbar command reachable elsewhere (menu / command palette) since toolbars can be hidden or customized; if a distraction-free mode hides toolbars, provide a reliable restore.
- Consider a large title that condenses on scroll for scrollable panel headers (keeps orientation).
- Consider letting long-session/power users customize which toolbar items appear (choose contents), not just hide the bar.

**Don't**
- Don't put borders/bezels/outlined-circle chrome around toolbar icons — the bar is the container; hover/selection states convey interactivity.

**Web review checks**
- [ ] Panel/window headers show a concise contextual title (<= ~15 chars target, truncated with ellipsis), never just the app name.
- [ ] Each toolbar has at most one accent-tinted primary action, at the trailing edge.
- [ ] Items form <= 3 clusters ordered leading (nav/title) → center (common) → trailing (primary/search/overflow).
- [ ] At narrow widths, lower-priority items collapse into a single "…" menu instead of wrapping or clipping.
- [ ] Toolbar icon buttons are borderless glyphs with state-driven hover/active backgrounds, not permanent bezels.
- [ ] Adjacent text-labeled buttons have explicit spacing/separators.
- [ ] Back/Close use standard glyphs (chevron-left, X) across all panels and modals.
- [ ] Every toolbar action is duplicated in an always-available surface so hiding the toolbar never orphans a command.

## Action sheets (confirmation dialogs)

**Principles**
- Action sheets present choices related to an action *the person just initiated* — expected interruptions. Alerts are *unexpected* (problem/state change). User-initiated → action sheet; system-initiated → alert.
- Every interruptive surface costs attention; use sparingly so that when one appears, people actually read it.
- Destructive choices get visual prominence and top placement so accidental data loss is harder; Cancel goes at the bottom as the safe escape.

**Specs**
- Titles: fit on a single line (no wrapping/truncation).
- Max ~4 buttons total including Cancel (≈3 real choices + Cancel).
- Destructive buttons: destructive style, top of the stack; Cancel at the bottom.
- All buttons must fit without scrolling (scrolling risks accidental taps).

**Do** — use a choice dialog (not an alert) for choices arising from an intentional user action; always include Cancel when data could be destroyed; keep the message optional (title + context usually suffice).
**Don't** — use for information delivery or non-initiated events; let the sheet scroll or exceed ~4 options; write multi-line titles.
**Web review checks**
- [ ] Confirmations triggered by a user action (delete chat, discard draft) use a choice dialog — not a bare OK/Cancel alert — when there are >2 meaningful outcomes.
- [ ] Every destructive-confirmation dialog includes a Cancel that closes without side effects.
- [ ] Destructive options use the danger color token and are visually distinct from safe options.
- [ ] Dialog titles fit on one line at default font size in a ~400px dialog.
- [ ] No confirmation dialog offers more than ~4 options; more → redesign as a menu or separate view.
- [ ] Message text is present only when the title alone is ambiguous.

## Alerts

**Principles**
- Alerts are for critical, *actionable* information right now. People resent interruptions that only inform — with no action to take, communicate in context (inline indicator, banner, cached state).
- Common + undoable actions don't warrant alerts even when destructive (deleting an email is intentional and reversible). Alert only for uncommon, irreversible actions that may have been accidental — insurance against accident, not friction for intent.
- Button titles carry meaning: "OK" is ambiguous under stress; a verb ("Delete", "Erase") tells people exactly what they're choosing.
- Making no button the default forces reading; making a destructive button the default invites reflexive Enter-key data loss.
- Destructive styling flags a destructive action the person *didn't deliberately choose*. If they explicitly chose "Empty Trash", the confirm button isn't styled destructive — the style signals surprise, not danger per se.

**Specs**
- Up to 3 buttons per alert (more → different presentation).
- Title: max ~2 lines. Complete sentence → sentence case + end punctuation; fragment → title case, no punctuation.
- Button titles: 1–2-word verb phrases, title-style capitalization, no end punctuation.
- Default/confirm button: trailing side of a row (or top of a stack); Cancel: leading side (or bottom of a stack).
- Cancel is always literally titled "Cancel"; single-button informational alerts use "OK"/"Done", never "Cancel".
- Esc must cancel the alert; Enter triggers the default only when the default is safe.
- Compact accessory content inside an alert: max height ~154px, ~16px corner radius (indicative sizing).

**Do**
- Write titles stating what happened, where, and why ("Couldn't save draft — no network"), not "Error".
- Include Cancel whenever a destructive action is offered; never make Cancel the default.

**Don't**
- Don't explain buttons in body text (titles must be self-explanatory), use "Yes"/"No" titles, or let alerts scroll.
- Don't overuse warning iconography (caution triangle) — reserve it for unexpected data loss, or it loses meaning.

**Web review checks**
- [ ] No modal alert fires on initial page load; startup errors render as inline banners or placeholder states.
- [ ] Every alert title conveys the specific situation — flag titles like "Error"/"Warning"/"Notice" with no context.
- [ ] Confirm buttons use action verbs, not "OK"/"Yes", except purely informational alerts.
- [ ] Destructive confirm buttons: destructive style, trailing/top position, NOT the Enter default.
- [ ] Esc closes every alert as Cancel; focus is trapped inside while open.
- [ ] Undoable actions (archive, remove-with-undo-toast) do not raise confirmation alerts.
- [ ] Alerts have at most 3 actions.

## Page controls (dot indicators)

**Principles**
- Page dots communicate "an ordered, flat list of peer pages" — using them for hierarchical or nonsequential navigation lies about structure; complex relationships need a sidebar/split view.
- Predictable placement (horizontally centered, bottom of the paged view) means people never hunt for it.
- Indicators must be countable at a glance; beyond ~10 a grid or list is the honest layout.
- Theme/token colors keep the current-vs-rest contrast that is the control's entire job — custom dot colors reduce it.

**Specs**
- Max ~10 dots before glanceability fails.
- Max 2 distinct indicator images per control (one default + one special page).
- Dots equidistant; current page = the solid/filled dot.
- Background style matches role — 3 variants: background only during interaction (secondary navigation with scrubbing), background always (primary navigation), no background (pure position display, no scrubbing/interaction).
- Animate page transitions only on discrete clicks/taps, not during fast scrubbing/dragging.

**Do / Don't** — use only for ordered peer pages (carousels, onboarding); keep custom dot icons simple (no negative space, text, or inner lines at tiny sizes). Don't show a scrollbar and a page control on the same axis; don't exceed ~10 pages, ~2 icon types, or custom colors.

**Web review checks**
- [ ] Dot indicators appear only for flat ordered lists; hierarchies use sidebar/tabs.
- [ ] Dot count is capped (~10); overflow content switches to grid or list.
- [ ] Active dot has clear contrast against inactive dots in both themes (token colors, not hardcoded brand colors).
- [ ] Indicator is horizontally centered at the bottom of the paged content.
- [ ] Paged regions don't render a scrollbar on the same axis as their dots.
- [ ] Dots are clickable with adequate hit areas despite their visual size.
- [ ] Background treatment matches role: always-on for primary navigation, shown only while interacting for scrubbable secondary navigation, absent (with no hover/click affordance) for display-only dots.

## Panels & inspectors

**Principles**
- A panel floats above the main surface for quick access to controls/info about the *current selection* — a satellite of the active context, visually less prominent so it doesn't compete.
- An inspector tracks the selection and updates live; a surface that freezes its contents is a different component (snapshot/info view). Dynamic-vs-snapshot is the distinction.
- Panels favor direct-manipulation controls (sliders, steppers, toggles) over multi-step input — a floating surface's value is immediacy.
- Panels follow app focus: prominent when their context is active, subdued/hidden when not.
- Dark translucent (HUD) styling is justified only when standard chrome would obscure or clash with immersive/visual content.

**Specs** — structural: short noun title ("Inspector", "Fonts"); referenced by that title in menus ("Show Inspector"); one consistent control-size variant within a panel; one panel style across app modes — never flip between standard chrome and dark-translucent (HUD) styling when entering/leaving full-screen or immersive modes; HUD-style overlays kept small and never obscuring the content they adjust; small high-contrast accents only in dark overlays.
**Web review checks**
- [ ] Inspector-style panels update when the selection changes (no stale data after switching chat/item).
- [ ] Floating panels are visually subordinate to main content (lighter chrome, smaller title) and never fully cover it.
- [ ] Panels tied to a workspace hide or lose prominence when their context is inactive.
- [ ] Panel titles are short noun phrases matching the menu/button labels that open them.
- [ ] Controls within a compact panel use a single consistent size variant.
- [ ] Dark translucent overlays appear only over media/visual content, not as arbitrary styling.
- [ ] Panel styling stays constant across app modes — no standard↔HUD restyle when entering/leaving full-screen, presentation, or immersive views.

## Popovers

**Principles**
- A popover is transient: appears from a control, holds a *small* amount of related functionality, disappears after interaction — temporary screen space without a sidebar's permanent cost.
- The arrow/anchor pointing at the source is the popover's provenance — people track "what opened this" spatially. Covering the source severs that link.
- Dismissal-by-outside-click is accident-prone, so nonmodal popover state must auto-save; only an explicit Cancel discards work.
- Popovers are unreliable for warnings — easily missed or accidentally dismissed. Critical info needs an alert.

**Specs**
- Exactly 1 popover visible at a time; never a cascade or popover-from-popover.
- Nothing renders above a popover except an alert.
- Size: just big enough for content + anchor; on narrow layouts (< ~600px) replace popovers with full-width sheets/modals.
- Multi-select popovers stay open until explicit dismissal or outside click.
- Size changes (condensed ↔ expanded) animate to preserve identity.

**Do** — include Close/Done/Cancel buttons only when save-vs-discard needs disambiguation; otherwise outside-click dismissal with auto-save suffices.
**Web review checks**
- [ ] Popovers position adjacent to (not over) their trigger, with anchoring that flips to stay in viewport.
- [ ] Opening popover B closes popover A — never two simultaneous popovers or a popover spawned from inside one.
- [ ] Edits inside a dismiss-on-outside-click popover persist (auto-save); only explicit Cancel discards.
- [ ] Clicking a second trigger while a popover is open opens the new one in a single click.
- [ ] On viewports < ~600px, popover content presents as a sheet/full-width modal.
- [ ] No warnings/errors delivered via popover or tooltip; those use alert/banner patterns.
- [ ] z-index audit: only alert dialogs layer above an open popover.

## Scroll views

**Principles**
- Scrolling is a systemwide habit: default gestures, wheel behavior, and keyboard scrolling (PgUp/PgDn, Home/End, arrows, space) must work everywhere. Custom scrolling that breaks muscle memory feels broken.
- Scroll indicators are often invisible, so the content must signal scrollability — partially clipped items at an edge say "more this way".
- Nested same-orientation scroll regions create unpredictable capture; cross-axis nesting (horizontal strip in a vertical page) is fine.
- Automatic scrolling is legitimate only to restore lost context (search hit off-screen, typing at a hidden insertion point, drag-selection past the edge) and moves the minimum distance needed — big jumps disorient.
- Edge effects between floating bars and scroll content exist for legibility of the floating controls, not decoration.

**Specs**
- One scroll edge effect per scroll view; in split layouts, sibling panes' edge effects must match in height.
- Zoomable content needs sane min/max scale bounds.
- Page-by-page scrolling: page size = viewport height/width minus one overlap unit (a line of text / row of items) so context carries across pages.
- Never pair a scrollbar and a page indicator on the same axis.

**Web review checks**
- [ ] Chat log and side lists scroll with native wheel/trackpad/keyboard (space, PgUp/PgDn, Home/End) — no scroll-hijacking on reading surfaces.
- [ ] No vertical scroll container nested directly inside another vertical scroll container (audit `overflow-y: auto` within `overflow-y: auto`).
- [ ] Overflowing regions signal continuation: partial item at the fold, or fade/shadow at the clipped edge — especially where scrollbars are hidden.
- [ ] Content inserted off-screen (streaming reply while scrolled up) follows minimal-scroll rules or shows a "jump to latest" affordance rather than yanking the viewport.
- [ ] Sticky headers/toolbars over scroll content have one separation treatment (border/shadow/blur), consistent height across split panes.
- [ ] Search/find scrolls the match into view, moving only as far as needed.
- [ ] Zoomable content (images, canvas) enforces min/max zoom bounds.

## Sheets (modals)

**Principles**
- A sheet hosts one scoped task tied to the current context — gather input or complete a simple task, then return. Long or complex flows deserve a full page/route.
- Modality is a contract: closing a sheet returns people to the parent they remember. Sheet-over-sheet breaks the "where am I" model — close the first before showing the second.
- Exit paths must be honest: a lone "Done" implies completing is the only way out. Always pair Done with Cancel (or Back).
- Nonmodal sheets exist for tools that act on the parent while staying open (e.g., a format bar) — modality should match whether the parent stays interactive.
- Partial-height presentation enables progressive disclosure: most relevant options at half height, expand for the rest; compose-style tasks open at full height.

**Specs**
- One sheet at a time from the main interface.
- Detents (touch): large = full expanded height, medium ≈ half of full height; resizable sheets show a grabber (drag to resize, tap to cycle).
- Button placement: Cancel/Close at the leading edge of the header; Done at the trailing edge. Never Cancel + Done + Back together.
- Desktop: a rounded-corner card over a dimmed parent, sized to content (users don't expect to resize it).
- Swipe/drag-down dismissal on touch; if unsaved changes exist, intercept with a confirm dialog.

**Web review checks**
- [ ] Modals/sheets never stack: opening a second closes the first; closing always returns to the true parent view.
- [ ] Every modal with Done/Save also has Cancel or Close, plus Esc-to-dismiss; a modal with only "Done" is a fail.
- [ ] Cancel on the leading side, Done/Save on the trailing side, consistently across the app.
- [ ] Dismissing a modal with unsaved input (overlay click, Esc) prompts to confirm discard rather than silently losing work.
- [ ] Modal content is a short scoped task; multistep flows inside modals are flagged for promotion to a route/page.
- [ ] The backdrop dims the parent, and the modal doesn't span the full viewport on desktop (context stays visible).
- [ ] Nonmodal tool surfaces (formatting bars acting on the main view) don't block interaction with the parent.

## Windows & floating surfaces

**Principles**
- Two roles: *primary* (main navigation + content) and *auxiliary* (one dedicated task, no app navigation, explicit close). Distinct roles keep users oriented.
- Open a new window/pop-out only when it preserves context or enables multitasking; new-window-by-default creates clutter. Offer "open in new window" as an option, not a habit.
- People rely on standard chrome and active/inactive appearances to know which surface accepts input. If you build custom chrome, you own replicating every state.
- Bottom bars/status strips get occluded or overlooked — never put critical info or actions there; small read-only status summaries only.

**Specs**
- Exactly 1 focused/key (input-accepting) surface at a time; focused surface shows colored/active controls, inactive surfaces appear gray/subdued — distinct visual states are mandatory for custom chrome.
- Window controls sit at the leading edge of the title bar; leading toolbar buttons shift inward so controls never overlap them.
- Reasonable default desktop-app surface size: ~1280x720px.
- Initial window/panel/pop-out size and shape: fit the content with minimal empty space (the ~1280x720px default applies only when content doesn't dictate a size).
- Set minimum and maximum window/panel sizes so layouts can't collapse into overlap or stretch into unusability.

**Web review checks**
- [ ] One clear primary surface for navigation; secondary floating windows/pop-outs do one task each with an explicit close button.
- [ ] Focused vs. unfocused panes are visually distinguishable in both themes (active highlight, subdued inactive chrome).
- [ ] Layout adapts fluidly narrow→wide; panels/sidebars have min/max width constraints so content never overlaps or collapses.
- [ ] Panel sizes and sidebar collapsed/expanded state persist across reloads.
- [ ] Draggable/floating surfaces can't be resized below usable minimums or beyond the viewport.
- [ ] Floating surfaces/pop-outs open at a size and shape fitting their content — no large empty regions or immediate need to resize.
- [ ] No critical actions live only in a bottom status strip.
- [ ] "Open in new window/tab" is an explicit user option, never automatic navigation behavior.

## Combo boxes (autocomplete inputs)

**Principles**
- A combo box merges free text entry with a curated list — serving both users who know what to type and users who need suggestions. Custom entries are not added back; the list stays curated.
- A meaningful default primes the mental model of the hidden choices; the introductory label sets expectations before opening.

**Specs**
- List option text must not be wider than the text field (mid-option truncation is hard to read) — or the popup must be wider than the input.
- Labels: consistent convention app-wide (macOS uses title-style + trailing colon; on the web, consistency matters more than the exact style).

**Web review checks**
- [ ] Every combobox/autocomplete has a visible label (not placeholder-only) describing the expected item type.
- [ ] Defaults to a meaningful value from its list when predictable, rather than empty.
- [ ] Option text fits within the input width or the popup is wider — no mid-option truncation.
- [ ] Typing a custom value works and does not mutate the suggestion list.
- [ ] Proper ARIA combobox semantics (role="combobox", aria-expanded, listbox options).

## Pickers

**Principles**
- Match control weight to option count: short lists deserve lighter controls (segmented/radio), medium lists suit a picker/select, very large sets need a searchable/indexed list. A picker adds too much weight for a few options.
- Hidden values must be predictable and logically ordered (alphabetized, chronological) so users can anticipate what's off-screen.
- Show the picker in context — a popover below/near the field being edited — not a view switch; context switches break the editing flow.

**Specs**
- Minute lists default to 60 values (0–59); a custom minute interval must divide evenly into 60 (quarter-hour: 0, 15, 30, 45).
- Countdown-duration mode maxes at 23 hours 59 minutes.
- Compact date style (space-constrained): current value shown as an accent-colored button opening a modal calendar/time editor allowing multiple edits before dismiss-to-confirm.
- Textual date entry for limited space + specific known dates; graphical calendar for browsing days or picking ranges.

**Web review checks**
- [ ] Date/time pickers open in a popover anchored to the triggering field, not a route change or full-screen takeover (desktop).
- [ ] Option lists sort predictably (alphabetical/logical) so users can guess a value's position before scrolling.
- [ ] Time selectors use sensible step granularity (e.g., 15-min) when precision isn't needed.
- [ ] Choice controls scale with option count: 2–5 → segmented/radio; medium → select; huge → searchable combobox or virtualized list.
- [ ] A collapsed date/time control displays its current value (accent-colored if a button) so state is visible unopened.

## Segmented controls

**Principles**
- A segmented control makes a small set of closely related, mutually exclusive choices scannable at a glance — options and selection state always visible together.
- Mixing behaviors destroys the mental model: all selection-state segments or all momentary action buttons, never both.
- Equal widths and similar-weight content per segment keep the control balanced; uneven content makes segments look broken or falsely important.
- It switches closely related subviews of one context; whole-app section switching belongs to top-level navigation.

**Specs**
- Max ~5–7 segments at desktop widths; max ~5 at phone widths.
- Segments usually equal width; icon and title widths consistent across segments.

**Do / Don't** — noun labels; all text or all icons within one control (tooltips + aria-labels on icon segments). Don't mix stateful and action segments; don't use for switching separate app sections.

**Web review checks**
- [ ] Toggle groups have <= 7 segments at desktop widths (<= 5 at mobile widths).
- [ ] All segments share one content type (all text or all icons); icon-only segments have tooltips + aria-labels.
- [ ] Segments have equal widths (flex: 1 or equivalent) and don't reflow unevenly at narrow widths.
- [ ] Each control is purely a selector or purely actions — no one-shot action inside a selection group.
- [ ] Selected segment is distinguishable by more than color alone (fill/shadow/weight), in both themes.
- [ ] Segmented controls switch subviews within a panel; app-level section switching uses the sidebar/nav.

## Sliders

**Principles**
- Users carry cross-app expectations of direction: minimum on the leading side, maximum trailing (bottom→top vertical). Violating this breaks muscle memory everywhere.
- A slider communicates relative position, not exact value — pair wide ranges with a text field (exact entry) and stepper (whole-value nudges) for both coarse and precise control.
- Live feedback while dragging closes the input→result loop, letting users stop exactly where they want.
- Track fill (min→thumb) color-codes "how much" at a glance; min/max end icons (small image → large image) encode the axis meaning without words.

**Specs**
- Horizontal: min leading, max trailing; vertical: min bottom, max top; percentages run 0% (leading) → 100% (trailing).
- Tick labels: min and max usually suffice; add periodic labels for nonlinear scales.
- Circular sliders for repeating/unbounded values (0–360° rotation; multiple turns, e.g., 4 spins = 1440°); horizontal sliders for fixed ranges.

**Do** — fill the track min→thumb; meaning-bearing end icons; tick marks plus hover value tooltip when specific values matter; introductory label; live preview during drag. **Don't** — reverse min/max; ship a bare slider for wide-range precise values; re-implement OS-level controls (e.g., system volume).
**Web review checks**
- [ ] Sliders run min→max in reading direction (LTR left→right; verify RTL flips); vertical sliders min at bottom.
- [ ] The filled track portion is visually distinct from the unfilled portion in both themes.
- [ ] Wide-range or precision sliders pair with a synced number input (ideally plus stepper buttons).
- [ ] Dragging gives live feedback — readout and/or affected UI updates during drag, not only on release.
- [ ] Keyboard-operable (arrow keys step) with aria-valuemin/max/now and human-readable aria-valuetext.
- [ ] If tick marks exist, at least min and max are labeled; nonlinear scales get periodic labels.

## Steppers

**Principles**
- A stepper displays no value — it only mutates one — so the value must be visibly adjacent and unambiguous, or users can't tell what they're incrementing.
- Steppers suit small adjustments (a few clicks); pair with a text field when large changes are likely so users can jump directly instead of clicking dozens of times.

**Specs**
- Accelerated stepping for wide ranges: Shift+click (or press-and-hold repeat) applies a larger increment, ~10x the default step.
- Ranges wider than ~10–20 steps: the value display should be an editable number input, not read-only text.

**Web review checks**
- [ ] Every +/- stepper sits immediately adjacent to a visible, live-updating value display.
- [ ] Ranges wider than ~10–20 steps use an editable number input as the value display.
- [ ] Shift+click or press-and-hold applies a larger (~10x) increment on wide-range steppers.
- [ ] Stepper buttons disable (and look disabled) at min/max bounds instead of silently doing nothing.
- [ ] Keyboard-reachable; the paired input accepts arrow-key increments.

## Text fields

**Principles**
- Text fields are for small, specific pieces of text; prose belongs in a textarea. Field width itself is a signal — matching width to expected content length helps people gauge how much to enter.
- Placeholder text disappears on typing, so it can never be the only label; a persistent label preserves purpose during and after entry.
- Validation timing follows cost-of-fixing: validate format (email) when focus leaves the field; validate credentials before allowing focus to move on — check while the fix is still cheap.
- Layout communicates grouping: consistent widths and vertical stacking make label→field ownership obvious; tab order must follow the visual/logical sequence.

**Specs**
- Overflow: default is clipping; alternatives are wrap (char/word) or ellipsis truncation (start/middle/end) — choose deliberately and reveal full text via a tooltip on hover.
- Field width ≈ expected content length (name fields one width, address/city another).

**Do**
- Number-format numeric fields (digits only; locale-aware decimals/percent/currency — never hard-code formatting assumptions).
- Leading-edge decorations indicate a field's purpose; the trailing edge offers actions (clear button).

**Web review checks**
- [ ] Every input has a persistent visible label (aria-label at minimum); placeholder is never the sole identifier.
- [ ] Password/API-key/token inputs use type="password" or masked rendering.
- [ ] Input widths roughly match expected content length; grouped fields share widths and vertical spacing.
- [ ] Tab order follows visual order (no positive tabindex hacks).
- [ ] Validation fires at the right moment: on blur for format checks, before submit/next-step for credentials; errors identify the field, not just a global banner.
- [ ] Numeric fields use type/inputmode="numeric" with locale-aware formatting; touch keyboards match content type.
- [ ] Search/filter fields provide a one-click trailing clear affordance.
- [ ] Truncated values (title bars, sidebar items, overflow) expose the full text via title attribute or tooltip.

## Toggles, checkboxes, radios

**Principles**
- A toggle/switch is strictly for a pair of opposing states of one thing (on/off); choosing among items is a different job. Users read a switch as "state of something" — misusing it for actions or choices misleads.
- State must be perceivable without color: fill, background shape, or inner glyph (checkmark/dot) — never color alone.
- Control choice encodes weight: switches carry more visual weight (emphasized settings), checkboxes align/indent well for hierarchies with mixed states, radio buttons expose 2–5 mutually exclusive labeled options.
- Context labels the control: a switch in a settings row needs no extra label (the row is the label); an icon toggle-button relies on its icon plus a clear active background.

**Specs**
- Radio groups: typically 2–5 options; beyond ~5 mutually exclusive options, switch to a select.
- Checkbox states: on (checkmark), off (empty), mixed (dash) — a parent checkbox over subordinates must show mixed when children differ.
- Horizontal radio layouts: size all options to the longest label, spaced consistently.
- Switch accent color must contrast sufficiently with the off appearance to be perceptible.

**Do** — switches inside settings/list rows; checkboxes for setting hierarchies (indent subordinates, mixed state on parent); radios for 2–5 exclusive choices; checkboxes when multiple can be selected; prefer a checkbox over a single lone radio for one on/off setting (checkmark presence reads faster).
**Don't** — use a bare switch outside a list row (use a toggle-style button with a highlighted active background, e.g., a filter chip); communicate on/off by color alone; swap checkboxes for switches just for style.
**Web review checks**
- [ ] Switches appear only in settings/list rows where the row text is the label; standalone on/off affordances in toolbars are toggle buttons with a distinct active background.
- [ ] On/off states differ by more than hue (thumb position, fill vs. outline, glyph), verified in both themes.
- [ ] Multi-select groups use checkboxes; single-select of 2–5 uses radios/segmented; >5 single-select uses a select/combobox.
- [ ] Parent "select all" checkboxes render an indeterminate state when children are mixed (checkbox.indeterminate).
- [ ] Correct semantics: role="switch" with aria-checked, or native input[type=checkbox/radio]; state changes announced.
- [ ] No toggle triggers navigation or a one-shot action — toggles only change state.

## Progress indicators

**Principles**
- Progress UI proves the app isn't stalled and helps people decide: wait, multitask, retry, or abandon. Determinate indicators support that decision; indeterminate ones only prove liveness — prefer determinate whenever duration is knowable, and upgrade indeterminate→determinate mid-task when it becomes knowable.
- A stationary indicator reads as a frozen app. Keep it moving; if the process genuinely stalls, replace motion with an explanation and a way forward.
- Perceived honesty matters: 90% in five seconds then 10% in five minutes feels deceptive — even out the reported pace.
- Consistent placement across the app makes status findable by habit.

**Specs**
- Two types only: determinate (known duration — bar/circle fills leading→trailing, circular fills clockwise) and indeterminate (spinner).
- Indicators are transient — visible only while the operation runs, removed on completion.
- Anti-pattern pacing: 90% complete in 5 seconds, remaining 10% taking 5 minutes.

**Do**
- Determinate progress whenever the task is quantifiable (upload, export); switch indeterminate→determinate once duration is known — never morph spinner↔bar mid-task (different shapes; the transition confuses).
- Small spinner for background operations or tight spaces (inside a field, next to a button).
- Offer Cancel when interruption is safe; Pause when cancel would lose work (partial download); confirm cancellation when progress would be lost.
- Specific descriptions ("Indexing 3 of 12 files"), not vague ("Loading…"); no label needed on a spinner triggered by an obvious user action.
- Keep automatic refreshes running — manual refresh is a supplement, not the mechanism.

**Web review checks**
- [ ] Long operations with knowable size (uploads, exports, batch jobs) show a determinate bar, not just a spinner.
- [ ] Spinners/bars are removed promptly on completion or failure — no orphaned indicators.
- [ ] Progress reporting is smoothed — no jump to ~90% then a long tail stall.
- [ ] Cancellable operations show a Cancel control; destructive cancellation asks for confirmation.
- [ ] Loading indicators appear in a consistent location per context.
- [ ] Status text is specific ("Syncing 3 of 12…"), not "Loading…".
- [ ] role="progressbar" with aria-valuenow (or aria-busy on the region for indeterminate); streaming/typing indicators animate continuously while active.

## Gauges (meters)

**Principles**
- A gauge shows where a current value sits within a known range — answering "how much, relative to what" at a glance, unlike a bare number.
- Labels for the current value and both endpoints are the gauge's accessible description — screen readers speak them, so they're mandatory, not decorative.
- Color along the path can encode severity pre-attentively (gradient, fill turning red near capacity) — but always paired with a text/number cue.

**Specs**
- Two shapes (circular, linear) x two styles: standard (indicator marks the value's position) and capacity (fill stops at the value).
- Discrete capacity segments become uselessly small for large ranges — use continuous fill for large ranges.
- Default capacity fill color: green; change it (whole fill, or tiered multi-color) at significant thresholds (very low, very high, past middle).

**Web review checks**
- [ ] Usage/quota meters (token usage, storage, context-window fill) show min/max endpoint labels or equivalent accessible text (aria-valuetext like "8k of 200k tokens").
- [ ] Threshold coloring (green→amber→red near limits) pairs with a text/number cue, not color alone, and holds contrast in both themes.
- [ ] Meters use role="meter" (or progressbar with valuemin/max/now) so the value-in-range is announced.
- [ ] Large ranges use continuous fill; segmented meters only when segments stay readable.

## Quick-scan spec table

| Spec | Value | Topic |
|---|---|---|
| Minimum effective hit region | 44x44px | Buttons |
| Prominent (accent) buttons per view | 1–2 max | Buttons |
| Image-edge to clickable-edge padding | ~10px | Buttons |
| Help affordances per window | 1 max | Buttons |
| Typical visible icon size inside a 44px target | 16–24px | Buttons |
| Submenu depth (all menu types) | 1 level max | Context menus / Menus |
| Separator groups per context menu | ~3 max | Context menus |
| Items per context menu | <= ~10, no scrolling | Context menus |
| Destructive item position | Last group, red | Context menus / Menus / Pull-downs |
| Submenu size before promoting to own menu | > ~5 items | Menus |
| Repeated term threshold suggesting a submenu | > 2 sibling items | Menus |
| Items to justify a pull-down menu | >= ~3 (1–2 → direct controls) | Pull-down buttons |
| View/window title length | < 15 characters | Toolbars |
| Toolbar item groups | <= ~3 | Toolbars |
| Prominent toolbar actions | Exactly 1, trailing edge | Toolbars |
| Action-sheet title | 1 line, no wrap | Action sheets |
| Action-sheet buttons | <= ~4 incl. Cancel (~3 choices) | Action sheets |
| Reference confirmation-dialog width | ~400px | Action sheets |
| Alert buttons | <= 3 | Alerts |
| Alert title length | <= ~2 lines | Alerts |
| Alert button title length | 1–2 words | Alerts |
| Alert accessory content | <= ~154px tall, ~16px corner radius | Alerts |
| Page-control dots | <= ~10 | Page controls |
| Distinct dot indicator images | <= 2 | Page controls |
| Page-control background styles | 3: on-interaction / always / none (by role) | Page controls |
| Simultaneous popovers | Exactly 1 | Popovers |
| Popover → sheet breakpoint | < ~600px viewport | Popovers |
| Layers above a popover | Alerts only | Popovers |
| Scroll edge effects per scroll view | 1 (heights match across split panes) | Scroll views |
| Page-by-page scroll page size | Viewport minus one overlap unit | Scroll views |
| Simultaneous sheets/modals | 1 | Sheets |
| Medium detent height | ≈ half of full height | Sheets |
| Cancel / Done placement | Leading / trailing | Sheets / Alerts |
| Focused (key) surfaces at a time | Exactly 1, visually distinct | Windows |
| Default desktop-app surface size | ~1280x720px | Windows |
| Combo option text width | <= input width (or wider popup) | Combo boxes |
| Minute picker values | 60 (0–59); interval divides 60 (e.g., 0/15/30/45) | Pickers |
| Countdown duration max | 23 h 59 min | Pickers |
| Segments per control (desktop) | <= ~5–7 | Segmented controls |
| Segments per control (mobile width) | <= ~5 | Segmented controls |
| Slider direction | 0% leading → 100% trailing; vertical min bottom | Sliders |
| Circular slider range | 0–360° per turn (4 spins = 1440°) | Sliders |
| Tick labels | Min + max minimum; periodic if nonlinear | Sliders |
| Accelerated step increment (Shift+click / hold) | ~10x default step | Steppers |
| Stepper range needing editable input | > ~10–20 steps | Steppers |
| Radio group size | 2–5 options (> ~5 → select) | Toggles |
| Checkbox states | 3: on / off / mixed | Toggles |
| Progress indicator types | 2: determinate, indeterminate | Progress indicators |
| Progress pacing anti-pattern | 90% in 5 s, 10% in 5 min | Progress indicators |
| Gauge shapes x styles | 2 shapes (circular, linear) x 2 styles (standard, capacity) | Gauges |
| Default capacity gauge fill | Green, tiered at thresholds | Gauges |
