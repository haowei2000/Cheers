# HIG Patterns — feedback, loading, entering data, modality, search, settings, onboarding, undo, files, collaboration

Behavioral UX patterns from Apple's Human Interface Guidelines, translated for reviewing React web frontends: what the app should do at runtime, why, and pass/fail checks for auditing it.

## Contents

- [Cross-cutting principles](#cross-cutting-principles)
- [Feedback](#feedback)
- [Loading](#loading)
- [Launching](#launching)
- [Entering data](#entering-data)
- [Modality](#modality)
- [Searching](#searching)
- [Settings](#settings)
- [Offering help](#offering-help)
- [Onboarding](#onboarding)
- [Charting data](#charting-data)
- [Drag and drop](#drag-and-drop)
- [File management](#file-management)
- [Undo and redo](#undo-and-redo)
- [Managing accounts](#managing-accounts)
- [Collaboration and sharing](#collaboration-and-sharing)
- [Quick-scan spec table](#quick-scan-spec-table)

## Cross-cutting principles

These recur across multiple HIG pattern pages; treat each topic below as a specialization of them.

1. **The best version of the pattern is invisible.** The best loading finishes before it's noticed, the best help is never needed, the best setting is a good default, the best onboarding is a learnable UI. Pattern UI is damage control — design to avoid needing it before decorating it.
2. **Match intrusiveness to significance.** Interrupt (modal, alert, tip, permission prompt) only when the interruption buys something critical; everything else is passive, in-context, and dismissible. Over-interrupting devalues real warnings.
3. **Persist and restore.** Reopening an app is "resuming": restore scroll, selection, panel state, last settings pane; persist tutorial skips and tip eligibility. Making people retrace steps reads as data loss.
4. **Every gesture path needs a non-gesture path.** Drag and drop, hover tooltips, keyboard shortcuts, and swipe-style dismissal are shortcuts — a button, menu item, or command must exist for keyboard and assistive-tech users.
5. **Ask at the moment of value.** Sign-in, permissions, ratings, and setup questions come when the user needs the dependent feature and can see the benefit — never as an upfront wall.

## Feedback

**Principles**
- Feedback is the app's ongoing conversation: what's happening, what the action produced, what to do next. Without it the UI feels opaque and untrustworthy.
- Match delivery to significance: passive in-context status for ambient info, interruptive alerts only for critical or destructive situations.
- People expect actions to succeed by default. Confirm success only for genuinely significant tasks (a payment, a consequential send); routine successes stay silent — but failures must always surface with a reason.
- Redundant channels (color + text + icon/animation) are an accessibility strategy: users who look away, mute, or use a screen reader still receive the message.

**Specs**
- None numeric on this topic.

**Do**
- Put status feedback near the items it describes (unread count and last-synced line in the relevant toolbar), so people get it without leaving context.
- Reserve alerts/modals for critical, ideally actionable information.
- Warn before actions causing unexpected AND irreversible data loss.
- When a command can't be carried out, say so and explain why ("can't route to and from the same location" style).
- Make every piece of feedback perceivable through more than one channel — never color alone.

**Don't**
- Don't warn when data loss is the expected result (no confirmation for every move-to-trash).
- Don't overuse alerts for unimportant info — they lose impact.
- Don't show an indeterminate spinner that demands watching when a completion notification would serve a long background job better.

**Web review checks**
- [ ] Every async user action (send, save, delete, rename) has visible in-context feedback for pending, success-when-significant, and failure — failures are never silent (verify `.catch`/error branches update UI, not just `console.error`).
- [ ] Error/status feedback appears adjacent to the element it describes (inline under the field/message), not only as a detached global toast; toasts are never the sole channel for critical errors.
- [ ] Destructive irreversible actions (delete conversation, clear history) show a confirmation dialog; expected/reversible removals (archive, close panel) do not.
- [ ] Modal alerts are reserved for blocking/critical situations; informational updates use passive inline status (badge, timestamp, subtle banner).
- [ ] Status conveyed by color (red border, green dot) is also conveyed by text or a labeled icon; dynamic error messages carry `aria-live` or `role="alert"` so screen readers announce them.
- [ ] When an operation is disallowed, the UI explains why (tooltip or inline message) — not just a disabled control with no explanation.
- [ ] Success confirmations are limited to significant operations; autosaves and background syncs don't spawn a toast per success.

## Loading

**Principles**
- The first goal is to shorten or hide the wait, not decorate it — loading UI is damage control.
- A blank screen reads as breakage. Show something immediately (skeleton, placeholder, cached content) and replace it as data arrives.
- Loading one region must not block interaction elsewhere: load in background so people can navigate, read, or queue actions.
- Communicate duration honestly: determinate progress when the length is knowable, indeterminate when not. A progress bar that lies (stalls at 90%) is worse than a spinner.

**Specs**
- If content needs ~1–2 s to load, show a loading indicator/placeholder rather than a blank region.
- Show any progress indicator only when the wait exceeds "a moment or two"; debounce spinner appearance ~300 ms–1 s so sub-second fetches don't flicker.
- Determinate indicator when duration/size is known (uploads); indeterminate when unknown.

**Do**
- Render skeletons/placeholders immediately; replace as content arrives.
- For unavoidably long loads, give people something useful (tips, feature intros) and gauge remaining time accurately so filler content isn't cut off or forced to loop.
- Prefetch large assets at nondisruptive times (after install, during idle) so later interactions feel instant.

**Don't**
- Don't show a blank screen or make people wait for a full load before displaying anything.
- Don't block the whole app for a load that affects one region.
- Don't fake a determinate progress bar.

**Web review checks**
- [ ] Initial fetches render a skeleton/placeholder in the affected region immediately — no blank panel or layout collapse mid-query.
- [ ] Loading one pane (sidebar, chat history, instrument panel) never blocks the others; spinners are region-scoped, not full-screen overlays, unless the whole app truly cannot function.
- [ ] Known-size operations (uploads) show determinate progress; unknown-duration fetches show indeterminate — none faked.
- [ ] Sub-second fetches don't flash a spinner (indicator debounced ~300 ms–1 s); no flicker on every keystroke or tab switch.
- [ ] Every loading state has a terminal state: error and empty branches exist, so a failed fetch can't leave an infinite spinner.
- [ ] Skeletons match real-content dimensions — no layout shift (CLS) when data arrives.
- [ ] Streaming responses (assistant messages) render partial content as it arrives rather than waiting for completion.

## Launching

**Principles**
- Launch is the first impression: everything in the sequence should create the perception of instant readiness. The launch/splash placeholder exists purely to make the app feel fast — not to brand or entertain.
- The placeholder must be visually near-identical to the first real screen; any mismatch produces a flash that makes the app feel slower than showing nothing extra.
- State restoration is a core expectation: people treat reopening as resuming, so restore granular details (scroll position, panel/window state) instead of making them retrace steps.
- The launch gap is not a canvas: static text can't be localized, and branding belongs in onboarding or the app itself.

**Specs**
- Target interactive first screen within ~2 s ("a couple of seconds").

**Do**
- Defer noncritical work past first paint; code-split heavy panels.
- Design the pre-hydration shell (index.html background, static loader) to match the first screen exactly, including the current light/dark mode.
- Restore previous session state on reload: last conversation, route, scroll position, sidebar collapse, window layout.
- If branding is needed, put it in onboarding, not in the load gap.

**Don't**
- Don't put text, logos, or advertising on the launch placeholder.
- Don't ship a launch shell whose color/layout differs from the first screen (flash on swap).
- Don't make people retrace navigation after a reload.

**Web review checks**
- [ ] The pre-JS shell background matches the first-screen background in BOTH themes — no white flash when loading in dark mode (`color-scheme`/initial background set before the bundle executes).
- [ ] Time-to-interactive for the main shell is ~2 s or less on a typical connection; heavy panels and data are code-split/deferred, not blocking first render.
- [ ] Reloading restores prior state: selected conversation, route, sidebar collapse, chat scroll position — verify persistence (localStorage/URL) round-trips.
- [ ] No hardcoded marketing text or logo-only splash in the initial loading state; any static loader is a neutral shell resembling the real layout.
- [ ] No double-flash on startup: static shell → skeleton → content transitions without jarring color/layout jumps.
- [ ] Deep links and refreshes on inner routes render that route directly, without bouncing through the home screen.

## Entering data

**Principles**
- Data entry is inherently tedious: minimize it. Pre-gather what the system knows, prefill sensible defaults, never ask for information you can derive.
- Choosing beats typing: pickers, menus, and selection lists are faster and less error-prone than free text whenever the value space is enumerable.
- Validate as the user goes, not at the end — immediate per-field feedback lets people fix errors while context is fresh instead of correcting a pile after submit.
- Make requirements explicit before failure: labels/placeholders state expected format; the submit path makes required-ness unmistakable (Continue enables only once required data is present).
- Respect secrets: obscure password-type input; never prepopulate a password field.

**Specs**
- None numeric; format examples ("username@company.com") are qualitative.

**Do**
- Pull data from context instead of asking (locale, timezone, known account info, prior settings).
- Label every field and/or show a format-example placeholder.
- Prefer pickers/menus/segmented choices over free text for enumerable options; constrain numeric fields to numeric input with formatting (decimals, %, currency).
- Support paste and drag-and-drop into inputs.
- Gate Next/Continue/Submit on required fields being valid, with requirements discoverable up front.

**Don't**
- Don't defer all validation to submit time on a long form.
- Don't prepopulate password fields.
- Don't force typing when selection would do.
- Don't silently clip entered text with no way to see the full value (desktop: recover via tooltip/expansion on hover).

**Web review checks**
- [ ] Every input has a visible label (or programmatic label + format placeholder); placeholder alone is not the label, and `<label for>`/`aria-label` is wired.
- [ ] Fields validate on blur/change with inline error text adjacent to the field; errors say what's wrong and how to fix it — not submit-only validation.
- [ ] Submit/Continue is disabled (or clearly gated with explanation) until required fields are valid; required fields are marked before the user fails.
- [ ] Values the app already knows (username, email, defaults, prior entries) are prefilled; the user is never re-asked for stored data.
- [ ] Enumerable choices use select/menu/segmented controls (model picker, language choice), not free text.
- [ ] Numeric fields use `inputmode`/type constraints or formatters so non-numeric input is impossible or immediately corrected.
- [ ] Password/token fields use `type="password"`, are never prefilled with real values, and secrets aren't echoed into the DOM in plain text.
- [ ] Paste works in all inputs (nothing blocks onPaste); truncated values are recoverable via tooltip/`title` on hover.

## Modality

**Principles**
- Modality trades context for focus: it blocks the parent view, so it's only justified when the interruption buys something — critical info, confirmation of a destructive action, a narrowly scoped task, or focus on a complex one.
- Entering a modal suspends the user's mental context; the longer or deeper the modal task, the more likely they lose the thread. Modal tasks must be short, simple, streamlined.
- A modal with its own view hierarchy becomes "an app within the app." If subviews are unavoidable, provide one linear path and no buttons confusable with the dismiss control.
- Stacked modals multiply cognitive load and read as disorganized.

**Specs**
- Maximum ONE alert visible at any time — never stack alerts.
- One modal layer at a time; dismiss before presenting the next.
- Dismiss affordance follows platform convention — for desktop web: a button in the dialog content (macOS-style), plus Escape.

**Do**
- Give every modal a title naming its task (plus optional guidance text) so people keep their place.
- Confirm before closing a modal if closing loses user-generated content, and offer a resolution path (save option).
- Use full-screen/large modal style only for genuinely in-depth content (media viewing, multistep editing) where minimizing distraction helps.

**Don't**
- Don't build multi-level navigation inside a modal.
- Don't present a modal atop another modal, or more than one alert at once.
- Don't make modal tasks long or complicated.
- Don't include buttons confusable with the dismiss button.

**Web review checks**
- [ ] Every dialog has a visible title naming its task.
- [ ] Every modal has an obvious, conventional dismiss control (X and/or Cancel, plus Escape handling); dismissal is never hidden or gesture-only.
- [ ] No code path opens a modal atop an open modal; alerts never stack (audit for a single modal slot or a queue, not concurrent renders).
- [ ] Closing a modal with unsaved input (draft, settings form) triggers a save/discard confirmation, not silent loss.
- [ ] Modal content is one shallow task; any steps form a single linear wizard with distinct back/next vs. dismiss.
- [ ] Non-critical flows (filters, view options, quick actions) use inline/popover UI, not blocking modals.
- [ ] The backdrop blocks parent interaction: focus trap present, background inert/`aria-hidden`.

## Searching

**Principles**
- People expect one clearly identified place to find anything; fragmented search erodes trust that a search was exhaustive. Local search is acceptable only for clearly distinct sections, and then acts as a filter on the current view.
- If search matters, it deserves primary placement (persistent field or palette), not burial in a menu.
- Users must always know WHAT they're searching: placeholder, scope control, or title states the scope.
- Suggestions (recents, completions, corrections) reduce typing; personalize from prior behavior.
- Search history is privacy-sensitive — it needs a clear-history affordance.

**Specs**
- None numeric on this topic.

**Do**
- Funnel all app content through one canonical search location; keep local searches visibly scoped as filters.
- Show recent searches before typing and predictive suggestions while typing.
- State the current scope via placeholder text, scope bar, or title.
- Provide a way to clear search history.

**Don't**
- Don't scatter equivalent search entry points without a canonical one.
- Don't leave scope ambiguous (one conversation vs. everything).
- Don't display history without user-controlled clearing.

**Web review checks**
- [ ] Exactly one canonical, prominent search entry point (sidebar field or Cmd/Ctrl+K palette) covers all app content; per-panel search is visibly scoped as a filter of that panel.
- [ ] The placeholder or an adjacent scope control states what is searched ("Search all chats", "Search in this conversation") — not bare "Search".
- [ ] Focusing an empty search field shows recents; typing shows live suggestions.
- [ ] Recent-search history has a visible Clear action.
- [ ] Where content types differ (chats, files, settings), search supports scoping/filters and the active scope is visible in results.
- [ ] Keyboard access: a shortcut focuses search, arrows traverse suggestions, Enter executes, Escape clears/closes.

## Settings

**Principles**
- The best setting is never needed: pick defaults that serve most people (auto-detect capability instead of asking). Every avoidable setting is deferred work dumped on the user; too many settings bury the one someone actually needs.
- Placement follows change frequency: task-scoped options live in the task's own view (discoverable, immediate feedback); the settings area holds general, infrequently changed options. Moving a task option into settings disconnects it from its context.
- Systemwide choices (appearance, accessibility, reduced motion) must be respected everywhere. Duplicating a global setting in-app implies the global one might not apply — detect, don't ask.
- Settings layout must be stable and predictable, with the active section always indicated.

**Specs**
- Standard shortcut Cmd/Ctrl+Comma opens settings on desktop.
- Reopen settings to the most recently viewed section (people adjust related settings more than once).
- Settings navigation is fixed/non-customizable, with the active section persistently indicated; the window/page title reflects the current section.

**Do**
- Ship defaults good enough that most people never open settings.
- Keep view-scoped options (show/hide panel, sort, filter) inline in the view they affect.
- Auto-detect environment (`prefers-color-scheme`, `prefers-reduced-motion`) instead of forcing upfront choices.

**Don't**
- Don't duplicate systemwide/browser-level settings inside the app.
- Don't use settings to collect setup info you can detect automatically.
- Don't bury frequently used view options in settings, away from their context.
- Don't offer so many settings that finding one becomes a search problem.

**Web review checks**
- [ ] Theme defaults to `prefers-color-scheme` (auto); a manual override exists but auto is default — no forced first-run choice.
- [ ] View-scoped options (sidebar collapse, panel visibility, sort/filter, density) are controlled inline in that view, not exiled to settings.
- [ ] The settings page contains only general, infrequently changed options; any setting toggled routinely mid-task is flagged for relocation to its task context.
- [ ] Settings nav highlights the active section persistently, and reopening restores the last-viewed section.
- [ ] No setting duplicates something the OS/browser governs (reduced motion, font smoothing, scrollbars); if a motion toggle exists it defaults to the system value.
- [ ] A fresh account can use every core flow with zero settings changes (test with a clean profile).
- [ ] Cmd/Ctrl+Comma (or a documented equivalent) opens settings.

## Offering help

**Principles**
- The best help is unnecessary — design approachably first; help is contextual backup tied to the exact action underway, always dismissible.
- Match form to complexity: 1–2 step tasks get a succinct inline hint; a tip is too weak for anything over ~3 actions, which needs a fuller affordance (docs, guided flow).
- Never explain standard components or platform conventions — explain only what YOUR app does with them.
- Tips must reach only people who benefit: eligibility rules (skip users who already used the feature) plus rate limits keep tips from becoming noise.
- Tooltip psychology: a person hovering a control wants that ONE control's action — not neighbors, not the larger workflow.

**Specs**
- Tooltip text: max 60–75 characters (localization lengthens text, so budget below).
- Tip suitability threshold: features needing more than 3 actions are too complicated for a tip.
- Tip length: 1–2 sentences, action-oriented.
- Tip frequency: reasonable cadence, e.g. at most one tip per 24 hours.
- Tip icons: prefer the filled symbol variant; don't repeat the same image in tip and adjacent UI.

**Do**
- Choose popover tips to preserve content flow, inline tips when surrounding info must stay visible; anchor annotation tips to the specific element.
- Start tooltip text with a verb ("Restore default settings"); sentence case; no ending punctuation on fragments.
- Add a button in a tip when it can jump straight to relevant settings or a learn-more flow.
- Prefer animation/graphics over lengthy text for orienting people to unique controls.
- Use platform terminology: "click" on desktop, "tap" on touch.

**Don't**
- Don't repeat the control's name inside its tooltip.
- Don't put promotional/upsell content in tips.
- Don't describe nearby controls or the larger task in a tooltip.
- Don't show a tip about a feature to someone who already uses it.

**Web review checks**
- [ ] Every icon-only button has a tooltip (or aria-label + tooltip); text is ≤ 75 chars, sentence case, starts with a verb, and doesn't repeat the visible name.
- [ ] Tooltips describe only the hovered control's action — no multi-control or workflow explanations.
- [ ] Discovery tips/coach marks are dismissible, frequency-capped (e.g. max one per session/day), and suppressed once the user has used the feature (persisted eligibility flags, not just "shown once").
- [ ] Tips are 1–2 sentences, action-oriented, promotion-free.
- [ ] Help copy uses desktop terminology and matches actual UI labels exactly.
- [ ] Any feature over ~3 steps has a fuller help affordance (docs link, guided flow), not a lone tip.
- [ ] Tips referencing settings/setup include a direct-link button to that location.

## Onboarding

**Principles**
- The ideal app is learnable by using it; onboarding is a fast, fun, optional fallback. Forced long tutorials overwhelm and are poorly retained.
- People learn by doing: interactive, safe-to-try moments beat instructional slides.
- Contextual just-in-time tips near the relevant UI, one concept at a time, usually beat one monolithic upfront flow.
- First-run momentum is sacred: don't block on downloads, licensing text, configuration, or permission walls — ship defaults and postpone nonessential setup.
- Ask at the moment of value: permissions with a shown benefit at onboarding or first feature use; ratings/purchases only after genuine engagement.

**Specs**
- A skipped tutorial must NOT re-present on later launches — persist the skip.
- Any splash displays only long enough to absorb at a glance; never artificially delay entry.
- Onboarding runs after launch completes — it is not part of the launch/loading experience.

**Do**
- Make tutorials skippable, and keep a skipped tutorial reachable later (help/settings entry).
- Teach through interactive try-it moments, not static screens.
- Tie each permission request to a demonstrated benefit.

**Don't**
- Don't teach the browser/system — only your own experience.
- Don't front-load licensing/legal text.
- Don't require memorizing information across many screens.
- Don't re-show a tutorial the user skipped or completed.
- Don't prompt for ratings/upgrades before engagement.

**Web review checks**
- [ ] Any first-run tour has a visible Skip on every step; skip/completion state persists (localStorage/server) and never auto-reappears.
- [ ] A skipped tutorial remains reachable later (help menu or settings).
- [ ] A brand-new user reaches the core action (first chat message) with zero required configuration — no forced profile/workspace/preference wizard.
- [ ] Feature education is contextual tips anchored near real UI, one concept at a time — not a many-screen slideshow.
- [ ] Permission-style requests (notifications, clipboard) fire on first use of the dependent feature with an in-app explanation first — never on page load.
- [ ] No blocking splash beyond actual load time; onboarding UI appears only after the shell has loaded.
- [ ] Rating/upgrade/feedback prompts are gated on engagement signals (N sessions or M messages), not first run.

## Charting data

**Principles**
- Charts are visually prominent; use one only to highlight or explain something about a dataset. To merely provide data, a scrollable/sortable/searchable table is better.
- Too much data in one chart obscures the relationships it should convey — keep charts simple and let people progressively reveal detail (levels of detail, subsets, expanded versions).
- Prefer common chart types (bar, line) that need no learning; novel forms need explicit teaching (e.g. an intro animation mapping visuals to metrics).
- Consistency is a comprehension tool: same type/colors/annotations signal "same data"; a deliberately different style signals a real difference. A preview chart and its expanded version must share style, colors, marks, annotations.
- Descriptive text (title, headline takeaway, annotations) makes charts glanceable — but never substitutes for accessibility labels.

**Specs**
- None numeric on this topic.

**Do**
- Add a headline sentence stating the actionable takeaway.
- Size the chart to its function: large enough to read labels and support interactivity; small charts only for glanceable previews of a bigger view.
- Provide accessibility labels describing values and components, plus accessible interaction elements.
- Offer macro (totals/averages), mid-level (subsets), and point-level (specific values) perspectives when the data supports it.

**Don't**
- Don't pack maximum data into one chart.
- Don't chart data that doesn't need analysis — use a table.
- Don't style related charts differently for variety.
- Don't rely on a visible headline in place of accessibility labels.

**Web review checks**
- [ ] Every chart has an accessible text alternative (aria-label / visually-hidden summary of values and trend), not just visible axes.
- [ ] Same-type data uses one chart type and one consistent color mapping app-wide; compact and expanded views are visually identical in style/colors/annotations.
- [ ] Each dashboard/usage chart has a title or one-line takeaway, not just raw axes.
- [ ] Lookup-only data is a sortable/searchable table or list, not a chart.
- [ ] Dense charts offer progressive disclosure (time-range selector, drill-down, expand-to-detail) instead of rendering everything at once.
- [ ] Chart text is legible at rendered size; small-panel charts drop detail rather than shrinking text below readability.

## Drag and drop

**Principles**
- Drag and drop is a learned universal expectation — people try it everywhere, so support it broadly; native text inputs give it for free.
- Move vs. copy must match expectations: same container = move; across containers = copy; between apps = always copy. Default to whichever least risks frustration or data loss.
- It's a dynamic multi-outcome process; continuous feedback at every stage (drag image, valid/invalid destination cues, failure animation) keeps people in control.
- It's a shortcut, never the only path — always provide non-drag alternatives for keyboard and assistive-tech users.
- Mistakes are expected: let people undo a drop, or confirm before an un-undoable one.

**Specs**
- Show the drag image once the pointer has moved the selection about 3px — near-immediate feedback.
- Drag image is translucent (web: opacity ~0.5–0.8) so destinations stay visible beneath it.
- Multi-item drag shows a count badge (small filled oval); update the count if the destination accepts only a subset.
- Alt/Option held at drop time (not drag start) forces a same-container drag to copy instead of move.

**Do**
- Highlight a destination (insertion point or container highlight) only while dragged content is over it AND it can accept the drop; clear the cue when content moves away.
- On invalid drop or failure, animate the item back to source (or fade it out) so the failure is visible.
- Auto-scroll a scrolling container when an item is dragged near its edge.
- Support multi-item drag where grouping items is natural (multi-select sidebar conversations or files, then drag them together as one operation).
- Offer multiple content fidelities when providing drag data (native object → PNG → JPEG); accept the richest representation you support; extract only the relevant portion of dropped content (a contact into a recipient field yields name + email).
- Keep dropped content selected in the destination so people can act immediately; deselect in the source when moving across containers.
- Show progress (and a placeholder row at the drop location) when transferred content takes time to arrive.

**Don't**
- Don't make dragging the only way to accomplish an action.
- Don't constantly morph the drag image — distracting.
- Don't leave destination highlights on when nothing hovers.
- Don't silently discard a failed drop.

**Web review checks**
- [ ] Every drag operation (reorder sidebar items, drop files into chat, move panels) has a non-drag equivalent: context-menu action, button, or keyboard command.
- [ ] Drag feedback appears within ~3px of pointer movement; the preview is semi-transparent (opacity 0.5–0.8) so targets stay visible.
- [ ] Drop targets highlight only while a valid item hovers; the cue clears on dragleave; invalid targets show nothing or an explicit not-allowed cursor.
- [ ] An invalid drop animates the item back or fades it — it never just vanishes.
- [ ] After a drop, the item is selected in its new location; slow transfers (file upload via drop) show progress plus a placeholder row at the drop position.
- [ ] Scrollable lists auto-scroll when an item is dragged near the top/bottom edge.
- [ ] Un-undoable drops are confirmed beforehand or reversible (undo/cancel affordance after).

## File management

**Principles**
- People expect work preserved without explicit action — autosave periodically and on close/switch. A Save button is a legacy burden. The goal: confidence that "work is always preserved unless I cancel or delete it."
- Custom file browsers must not trap people in one folder: open at the most relevant location but allow navigating elsewhere.
- Unsaved-changes indicators are only meaningful when autosave is off; showing them alongside autosave falsely implies action is required and erodes trust.
- Previews (Quick Look pattern) let people inspect files the app can't open, without leaving it.
- Creation must be convenient: familiar menu commands, keyboard shortcuts, and a visible Add (+) button.

**Specs**
- Hide file extensions by default; let people opt in, and reflect the choice consistently in all open/save UIs.
- New document default title is "Untitled" until renamed.
- When autosave is off: show an unsaved-changes dot on the close control and next to the document name; optionally append "Edited" to the title, removed the moment changes save.

**Do**
- Autosave periodically and on close/app-switch.
- Offer "Open Recent" alongside "Open"; allow filtering and multi-select in file-open UIs.
- Let people change name, format, and location when saving; default the browser to a logical location; let people pick or create a destination folder when exporting.
- In an import/attach picker, show only files valid for the current context, plus useful metadata (modified date, size, local/remote).
- Customize the picker's confirm button to the task ("Insert" instead of "Open").

**Don't**
- Don't require explicit save for routine work.
- Don't show unsaved-changes markers while autosave is active.
- Don't add a second toolbar inside a modal file picker that already has one.
- Don't lock a custom browser to a single directory.

**Web review checks**
- [ ] Drafts and edits (chat input, settings forms, document panels) persist automatically — reload or conversation switch never loses typed content; no routine flow depends on a manual Save.
- [ ] If a manual-save mode exists, unsaved state is visibly marked (dot/"Edited") and cleared immediately on save; no such marker appears under autosave.
- [ ] Attach/upload pickers filter to accepted types (`accept` attribute or server-driven filter) and show name, size, date where relevant.
- [ ] Files the app can't render inline still get a preview affordance (thumbnail, first-page preview, metadata card), not a bare filename.
- [ ] New-item creation is reachable via a visible "+" button AND a keyboard shortcut.
- [ ] Export/download flows offer format choice when multiple are supported; confirm buttons name the action ("Insert", "Attach", "Export"), not "OK".

## Undo and redo

**Principles**
- Undo is the safety net that enables exploration: people experiment when they trust actions are reversible.
- People undo repeatedly "until something changes" and can't remember the stack order — labeled undo ("Undo Typing", "Undo Bold") helps predict the outcome, and the UI must show the result.
- If the undone change is off-screen, people conclude undo did nothing and keep pressing — scroll/navigate to reveal restored content.
- Undo depth should match the user's mental session: every action since opening the document or the last logical checkpoint, not an arbitrary small limit.

**Specs**
- Shortcuts: Cmd/Ctrl-Z (undo), Cmd/Ctrl-Shift-Z (redo).
- Undo/redo live at the top of the Edit menu (if the app has menus).
- Undo/redo labels: 1–2 words describing the target ("Undo Name", "Redo Address Change").
- Dedicated buttons, if needed at all, use standard undo/redo symbols in a toolbar.

**Do**
- Label undo/redo commands with what they will affect.
- Highlight or scroll to the result of every undo/redo.
- Support unlimited (or session-deep) undo; consider batch undo for clusters of related micro-adjustments and a "revert to opened/saved" command.

**Don't**
- Don't cap the undo stack at an arbitrary small size.
- Don't redefine standard undo shortcuts.
- Don't add undo/redo buttons when the shortcut/menu path suffices.

**Web review checks**
- [ ] Destructive or hard-to-reconstruct actions (delete conversation/message, clear panel, bulk ops) offer undo (toast with Undo, or Cmd/Ctrl-Z) — or explicit confirmation if truly irreversible.
- [ ] Cmd/Ctrl-Z and Cmd/Ctrl-Shift-Z work in all rich-editing surfaces; app-level key handlers don't swallow them inside inputs/contenteditable.
- [ ] Undo affordances name the action ("Message deleted — Undo", "Undo delete"), not bare "Undo".
- [ ] Undoing off-screen changes scrolls the content into view or highlights it — the user always sees evidence the undo happened.
- [ ] Multi-step edits support more than one level of undo within the session.

## Managing accounts

**Principles**
- An account is a barrier: require one only when core functionality truly needs it, and delay sign-in as long as possible — people abandon apps that demand sign-in before showing value (let a shopper browse; sign in at purchase).
- Explain the why: the sign-in view briefly states the account's benefits, not just demands credentials.
- Name the auth method precisely and offer only methods available in the current context ("Sign in with passkey", not generic "Sign In") — mislabeled auth erodes trust.
- Account deletion is a first-class obligation, not deactivation.
- Prefer credential-less mechanisms (passkeys, federated sign-in) over passwords; if passwords remain, add two-factor auth.

**Specs**
- Hard rules (non-numeric): real deletion must be offered if in-app account creation exists; the deletion path must not be buried in Privacy Policy/ToS pages; in-app and web deletion flows must be equally simple; if scheduled deletion is offered, immediate deletion must be too. Web check target: deletion reachable from account/settings in ≤ 2 clicks.

**Do**
- State account benefits in the sign-in view.
- Gate only the features needing identity; let everything else work signed-out.
- Tell people when deletion will complete and notify them when done; explain billing/subscription consequences and how to cancel; if legal retention applies, say exactly what is kept and why.

**Don't**
- Don't force sign-in before the user has experienced value.
- Don't use generic auth labels or reference unavailable methods.
- Don't duplicate system-level security choices in-app.
- Don't make deletion harder than sign-up.

**Web review checks**
- [ ] The app shows meaningful content or a functional preview before auth, OR the sign-in screen explains in 1–2 sentences why an account is required and what it provides.
- [ ] Auth buttons name the method ("Sign in with Google", "Sign in with passkey"); shown options are actually available in the current deployment/config.
- [ ] Account deletion (not sign-out or deactivate) is reachable from account/settings in ≤ 2 clicks, with completion timing communicated and a confirmation on finish.
- [ ] Settings don't duplicate browser/OS security toggles (no in-app "enable password autofill" switch).
- [ ] Session-expiry re-auth preserves in-progress work — drafts survive a forced re-login.

## Collaboration and sharing

**Principles**
- Sharing is initiated mid-work, so entry points must be conventional and convenient: a Share button in a predictable chrome location (toolbar).
- Permission state must be readable at a glance: a one-line summary of current permissions ("Only invited people can edit") doubles as the button opening the full options; the options stay few and grouped.
- Once content is shared, the UI must continuously signal shared state: a persistent collaboration/participants indicator next to Share, showing who is in and opening management + communication actions.
- The collaboration surface has a hierarchy: participants + communication first, minimal app-specific actions second, management last.
- Collaboration events (mentions, edits, membership changes) deserve notifications that deep-link to the relevant view.

**Specs**
- Collaboration popover = 3 sections: collaborators + communication buttons / custom app items / manage-sharing button (default title "Manage Shared File", customizable).
- Permission summary is a short one-line phrase used as the button label.
- Web check target: ≤ ~4 grouped permission choices (access scope, edit vs. read, re-invite rights).

**Do**
- Put Share in the toolbar; place the participants indicator next to it as soon as sharing starts.
- Support "send a copy" as an alternative to live collaboration.
- Notify on mentions, content changes, and joins/leaves, with a link opening the relevant location.

**Don't**
- Don't hide shared state after setup — the indicator must persist.
- Don't overload the collaboration menu with nonessential custom actions.
- Don't offer sprawling permission matrices when a few grouped choices cover the real cases.

**Web review checks**
- [ ] Shared resources display a persistent indicator (avatars or shared badge) adjacent to the Share control — not only inside a settings dialog.
- [ ] The share dialog shows current permissions as a plain-language summary line; full options are ≤ ~4 grouped choices.
- [ ] Sharing offers both "invite to collaborate" and "send/export a copy" where both make sense.
- [ ] Mentions and membership changes generate notifications deep-linking to the exact message/section, not the app root.
- [ ] The participants popover leads with people (list + contact actions), keeps custom actions minimal, and ends with a manage-sharing action.

## Quick-scan spec table

| Spec | Value | Topic |
|---|---|---|
| Loading indicator threshold | Show placeholder/indicator if content needs ~1–2 s | Loading |
| Progress indicator trigger | Any wait "more than a moment or two" | Loading |
| Spinner debounce | ~300 ms–1 s before showing, so fast fetches don't flicker | Loading |
| Determinate vs. indeterminate | Determinate when duration/size known; indeterminate otherwise; never faked | Loading |
| Time-to-interactive target | ~2 s to interactive first screen | Launching |
| Simultaneous alerts | Max 1 — never stack | Modality |
| Simultaneous modal layers | 1 — dismiss before presenting the next | Modality |
| Settings shortcut | Cmd/Ctrl + Comma | Settings |
| Settings reopen behavior | Restore most recently viewed section | Settings |
| Tooltip length | ≤ 60–75 characters (budget below for localization) | Offering help |
| Tip complexity ceiling | > 3 actions = too complex for a tip; needs fuller help | Offering help |
| Tip length | 1–2 sentences, action-oriented | Offering help |
| Tip frequency cap | ≤ 1 tip per 24 hours | Offering help |
| Tip icon style | Filled symbol variant; no image repeated in adjacent UI | Offering help |
| Tutorial skip persistence | Skipped tutorial never re-presents (persist the flag) | Onboarding |
| Drag-start distance | Drag image appears after ~3px of pointer movement | Drag and drop |
| Drag preview opacity | Translucent, ~0.5–0.8 | Drag and drop |
| Multi-item drag badge | Count badge; update if destination accepts a subset | Drag and drop |
| Copy modifier | Alt/Option held at drop time forces same-container copy | Drag and drop |
| Default document title | "Untitled" | File management |
| Unsaved marker (autosave off) | Dot on close control + next to name; optional "Edited" suffix, cleared on save | File management |
| File extensions | Hidden by default, user-opt-in, consistent everywhere | File management |
| Undo / redo shortcuts | Cmd/Ctrl-Z / Cmd/Ctrl-Shift-Z | Undo and redo |
| Undo menu placement | Top of the Edit menu | Undo and redo |
| Undo label length | 1–2 words naming the target ("Undo Typing") | Undo and redo |
| Account deletion depth | Reachable from account/settings in ≤ 2 clicks | Managing accounts |
| Collaboration popover structure | 3 sections: people+communication / custom items / manage-sharing | Collaboration and sharing |
| Permission summary | One-line phrase, doubles as the options button label | Collaboration and sharing |
| Permission option count | ≤ ~4 grouped choices | Collaboration and sharing |
