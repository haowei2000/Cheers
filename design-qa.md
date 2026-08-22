# macOS Seamless Titlebar Design QA

- Source visual truth: `/var/folders/tn/l7kr202d20q7j7rcxdy62pwc0000gn/T/codex-clipboard-cf23355d-7414-4b39-8ea1-b974986d12ab.png`
- Implementation screenshot: `/private/tmp/cheers-titlebar-final-window.png`
- Combined focused comparison: `/private/tmp/cheers-titlebar-comparison.png`
- Capture size: 2048 × 1280 px; dark mode, authenticated channel, native macOS window

## Evidence reviewed

- The native traffic lights and the React toolbar controls now share the same optical center.
- The toolbar bottom rule is removed. Its left surface continues the rail/sidebar tone, while the channel portion continues the main-content tone.
- The workspace rail and channel sidebar use one continuous surface only in macOS titlebar placement; Web keeps its existing rail contrast.
- The remaining transitions are tonal section boundaries and the native outer window stroke, not added divider lines.

## Comparison history

- Pass 1 [P2]: traffic lights remained about 7 px above the React toolbar controls. Adjusted the native Tauri traffic-light inset from y=15 to y=22.
- Pass 1 [P2]: using one toolbar background produced a hard horizontal transition across the main content. Replaced it with column-aligned titlebar surfaces matching the content below.
- Pass 2: the focused source/implementation comparison shows aligned controls and no toolbar bottom rule; no P0, P1, or P2 issue remains in the tested state.

final result: passed

---

# Adaptive Floating Panel Controls QA

- Implementation screenshot: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-adaptive-controls.png`
- Preview: `http://127.0.0.1:5173/dev/workbench-preview.html`
- State: local Workbench preview with Scene and item navigation visible during hover

## Evidence

- The Panel and Content client rectangles matched at `1040 x 560` and again after resizing, confirming that Content is full-bleed rather than offset by desktop chrome.
- At `1040px`, Scene navigation used icon + text. At `574px`, it changed to text and Panel actions changed to icons. At `374px`, Scene navigation changed to icons and item navigation collapsed to a current-item dropdown.
- The title, navigation, actions, and context islands had opacity `0` at rest and opacity `1` while the pointer was inside the Panel.
- Scene item tabs are rendered through the Panel context portal, outside the Content surface, while retaining selection and context-menu actions.
- Panel chrome uses a higher stacking layer than business-content overlays, keeping promoted controls visible and interactive over drawers and canvases.

## Verification

- Vitest: 84 files, 484 tests passed.
- TypeScript, ESLint, design-system check, and production build passed. ESLint reported existing warnings and no errors.

final result: passed

---

# Floating Panel Full-size Content Design QA

## Target

- Source reference: `/var/folders/tn/l7kr202d20q7j7rcxdy62pwc0000gn/T/codex-clipboard-a8d05af5-9388-4351-aeb6-9df5610646db.png`
- Wide implementation: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-full-content-after.png`
- Compact implementation: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-reference-sized-after.png`
- Mobile sheet: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-mobile-sheet-after.png`
- Same-size comparison: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-reference-comparison.png`
- Comparison viewport: 1028 x 984 CSS pixels.

## Geometry And Interaction Evidence

- The wide ViewBoard measured 1061 x 686 px; its Content rect was exactly the same 1061 x 686 px at the same x/y origin.
- Resizing to 554 px switched primary Board tabs to the current-board dropdown, moved Add to context into More, and kept Minimize and Close visible. Content still matched the complete 554 x 686 px Panel rect; the caller-owned safe zone changed from 3.5rem to 5.5rem.
- The compact dropdown changed the active Board, and More exposed the structured secondary action. Remote Workspace exposed Refresh through the same overflow mechanism.
- ViewBoard moved from x=871 to x=1007 through the title island grip. Resize, lane bounds, persisted geometry, z-order raising, and simultaneous Remote Workspace / ViewBoard / Workbench / Channel Files windows remained functional.
- Remote Workspace, ViewBoard, Workbench, and Channel Files all reported exact Content/Panel rect equality. Workbench and Channel Files correctly rendered no empty navigation surface.
- At 390 x 844, the ViewBoard rendered as a fixed 390 x 844 full-screen sheet, used its inline mobile header, kept Content relative, and hid desktop floating chrome. Desktop persisted width, height, and position no longer leak into mobile geometry.

## Visual Comparison

- The implementation follows the reference hierarchy: content owns the complete window surface while identity, navigation, and actions sit in independent always-visible translucent islands.
- The narrow state keeps the title and universal window controls on the first row and moves the current primary view to a centered second-row island, avoiding collisions without shrinking business content.
- Product-specific colors, typography, and density remain Cheers-native rather than copying the media player's artwork or playback controls.
- The local WebSocket reconnect banner is an unrelated runtime-state difference visible behind the non-modal Panel.

## Validation

- TypeScript passed.
- 82 Vitest files and 475 tests passed.
- ESLint passed with existing repository warnings and no errors.
- Production build passed.
- Design-system check and design-system audit tests passed.
- Authenticated in-app browser regression covered wide, compact, overflow, drag, resize, multi-window, and mobile sheet states.

final result: passed

## Activity Control Follow-up

- Implementation screenshot: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-activity-controls-after.png`
- Refresh is registered as a panel-level action and rendered in the persistent top-right action island.
- The duplicate content-level Activity heading was removed; the remaining Activity label is the primary navigation selection.
- Flow, Highlights, All, and Filter remain content-owned controls, now rendered as two bottom overlay islands so the content surface extends behind them.
- Browser geometry confirmed the bottom controls are absolutely overlaid within the panel and Refresh is inside the action island.
- Production build, full Vitest suite (475 tests), TypeScript, design-system checks, health checks, and browser-console verification passed. ESLint reported 105 existing warnings and no errors.

follow-up result: passed

## Adaptive Control Group Follow-up

- Source reference: `/var/folders/tn/l7kr202d20q7j7rcxdy62pwc0000gn/T/codex-clipboard-cbbe20a5-5717-42dc-9638-736576c34fcd.png`
- Four-mode component evidence: `/Users/haowei/Projects/Cheers/artifacts/design-qa/adaptive-control-group-modes.png`
- Wide FloatingPanel evidence: `/Users/haowei/Projects/Cheers/artifacts/design-qa/adaptive-floating-panel-wide.png`
- Compact FloatingPanel evidence: `/Users/haowei/Projects/Cheers/artifacts/design-qa/adaptive-floating-panel-compact.png`

### Responsive Evidence

- The same five-item group rendered icon + text at 440 px, text at 330 px, icons at 200 px, and a current-item selector at 136 px. Each decision used measured intrinsic control widths rather than viewport breakpoints.
- A production `FloatingPanel` preview resized from 1040 px to 428 px without reload. Navigation changed from the full scene strip to the current-scene selector; panel actions changed from direct controls to primary icon + More. Resizing back to 1040 px restored both full groups.
- At 428 px the compact scene selector exposed all four scenes and selecting Tasks updated the trigger. At both widths, the Content and Panel client rects were identical.
- Desktop chrome remained hidden by default, appeared on panel hover, and the narrow navigation moved to row two without colliding with the title or right action island.
- The authenticated product route was redirected to local login during this pass, so browser interaction used the production `FloatingPanel` and `SceneWorkbench` components through the repository's isolated Workbench preview. The preview produced no browser warnings or errors.

### Validation

- 83 Vitest files and 480 tests passed.
- TypeScript, production build, design-system check, and ESLint passed. ESLint retained existing repository warnings and introduced no adaptive-control warnings.

adaptive follow-up result: passed

---

# iOS Composer Design QA

- Source visual truth: `/var/folders/tn/l7kr202d20q7j7rcxdy62pwc0000gn/T/codex-clipboard-4c4431fc-a7be-44e7-9d9c-8f730233927d.png`
- Implementation screenshot: unavailable; the signed build is installed and running on the connected iPhone, but CoreDevice does not expose screen capture
- Target viewport: connected iPhone 17, portrait
- Source pixels: 580 × 186
- State: empty, focused ChatGPT-style message composer

## Full-view comparison evidence

Blocked. The source was inspected at original resolution and the production SwiftUI implementation was built, installed, and launched on the connected iPhone. A matching implementation screenshot cannot be captured through CoreDevice, and the simulator does not contain the authenticated channel state.

## Code-level structure check

- Overall shell uses SwiftUI's native `Capsule()` with `.regularMaterial`.
- Composer is presented from the chat screen's bottom `safeAreaInset`; the surrounding area is transparent and no full-width toolbar background is drawn.
- The message timeline reserves the floating control's height so the final message can scroll above it instead of being obscured.
- Controls use native `Menu`, multiline `TextField`, `Button`, and SF Symbols.
- Control order is `plus`, input, `@`, `mic`, and `arrow.up`; each button uses the same 44 pt hit region and the row aligns them on the capsule's vertical center.
- Only one voice control remains. The blue primary action is exclusively the send button and is disabled for an empty draft.
- The input field uses `.textFieldStyle(.plain)` so no second nested outline appears inside the capsule.
- Existing attachment, mention, dictation, send, loading, and disabled behaviors remain connected.

## Findings

- [P2] True-device floating spacing, vertical centering, and material contrast are not visually proven.
  - Location: the full Composer capsule.
  - Evidence: source visual is available; matching implementation screenshot is unavailable.
  - Impact: the system material may need a small contrast adjustment against the channel background.
  - Fix: capture the installed channel screen in the empty Composer state and compare it with the source.

## Required fidelity surfaces

- Shape: native capsule, not a fixed-radius rounded rectangle.
- Icons: SF Symbols only; no custom icon assets required.
- Spacing: compact internal spacing with 44 pt minimum control targets.
- Interaction: `@` inserts a mention token and focuses the field; `mic` controls dictation; `arrow.up` sends a non-empty draft.
- Placement: floating above the bottom safe area rather than occupying a row in the main chat stack.

final result: blocked

---

# iOS Git Trace Design QA

- Source visual truth: `/Users/haowei/.codex/generated_images/019fca9d-8cb9-7132-902c-8b3ab0f45542/exec-b169790d-d7d3-4068-a2c9-42232557ef7c.png`
- Implementation screenshot: `/tmp/cheers-git-trace-no-new-font/5CCED4C7-AA37-4D15-BCAD-0CCB75AC2386.png`
- Target viewport: iPhone 17 Pro simulator, portrait, 1206 × 2622 px (@3x)
- State: dark mode, completed `git_status` event with staged, unstaged, and untracked files

## Full-view comparison evidence

The implementation preserves the source hierarchy—navigation title, outcome summary, branch and counts, changed files, command context, then the secondary action—using spacing and semantic color instead of cards or dividers. The final simulator screenshot was captured by the UI test from the production SwiftUI view and compared at original resolution.

## Comparison history

- Pass 1 [P2]: long paths used body-sized text and wrapped, making the file section visually dense. Fixed with the existing system caption style, one-line layout, and middle truncation.
- Pass 1 [P2]: a single bottom toolbar action was rendered by iOS as a prominent centered circular control. Fixed by moving Copy command into the scroll content as a native borderless 44 pt action.
- Intentional difference: View diff is not shown because the authoritative `git_status` event currently contains status entries but no diff payload or queryable repository context. Adding a non-functional action would violate the backend contract.

## Final findings

No P0, P1, or P2 visual issues remain in the tested state. File rows scan cleanly, status is distinguished by color plus the Git status letter, and the screen contains no custom cards or separators.

final result: passed

---

# Cheers Editorial Correspondence Rollout Design QA

## Target

- Source visual truth: `/Users/haowei/.codex/visualizations/2026/08/10/019feacf-15ac-75a1-ac89-60ca0814cb87/cheers-editorial/gallery-reference-1280x720.png`
- Browser implementation screenshot: `/Users/haowei/.codex/visualizations/2026/08/10/019feacf-15ac-75a1-ac89-60ca0814cb87/cheers-editorial/website-implementation-1280x720.png`
- Combined comparison: `/Users/haowei/.codex/visualizations/2026/08/10/019feacf-15ac-75a1-ac89-60ca0814cb87/cheers-editorial/gallery-vs-website-1280x1440.png`
- Mobile implementation: `/Users/haowei/.codex/visualizations/2026/08/10/019feacf-15ac-75a1-ac89-60ca0814cb87/cheers-editorial/website-mobile-settled-390x844.png`
- Policy implementation: `/Users/haowei/.codex/visualizations/2026/08/10/019feacf-15ac-75a1-ac89-60ca0814cb87/cheers-editorial/terms-mobile-390x844.png`
- Desktop comparison viewport: 1280 × 720 CSS pixels at standard density; source and implementation are both 1280 × 720 pixels and required no density normalization.
- Mobile viewport: 390 × 844 CSS pixels at standard density; the page content width is 375 pixels after browser scrollbar allocation and has no horizontal overflow.
- State: dark editorial edition, homepage hero settled after its entrance motion; Terms of Service at the first content section.

## Full-view comparison evidence

The gallery and website use the same Source Serif 4 display/reading family, neutral ink palette, dark field, near-square controls, compact utility labels, and absence of boxed marketing cards. The homepage intentionally scales the display role beyond the gallery masthead because it is a product introduction, while preserving the same optical character and neutral tracking. Primary actions use a firm light field; secondary actions stay borderless.

## Focused responsive and policy evidence

The 390 px homepage keeps the masthead readable, retains both primary actions, fits the product screenshot without horizontal overflow, and collapses the navigation to language plus download. The policy page uses the same display title and reading face with a narrower measure and section rhythm. Its controls remain utility sans, and the long-form content does not inherit product trace styling.

## Required fidelity surfaces

- Fonts and typography: Source Serif 4 is loaded locally and used at separate display and text optical sizes. Web utility labels, controls, warnings, and trace semantics use the paired Source Sans 3 face; native clients retain their platform sans and code remains monospace.
- Spacing and layout rhythm: the implementation uses compact 4/8 item spacing, generous publication-level section rhythm, restrained 4 px radii, and hairline rules only where they establish a register or document section.
- Colors and visual tokens: both views use zinc-black surfaces and neutral ink hierarchy. Indigo, amber, red, and emerald remain restricted to product interaction or critical state.
- Image quality and assets: the homepage reuses the supplied product screenshots at their intended aspect ratios with `object-fit: contain`; no placeholder asset is visible in the checked states.
- Copy and content: website, policy, and product-specific copy remains unchanged apart from visual hierarchy. The footer continues to state the current MIT license.

## Interaction and accessibility checks

- The deployment tabs switch their selected state and reveal the corresponding panel.
- Desktop, mobile homepage, and policy page produced no browser console errors.
- Reduced-motion CSS disables the entrance animation and all transitions.
- The mobile homepage and Terms page have no horizontal overflow.

## Findings

No actionable P0, P1, or P2 visual mismatch remains in the checked website, mobile, and policy states. Platform-native differences in SwiftUI and Compose are intentional and governed by the shared anatomy rather than desktop pixel fidelity.

## Comparison history

- Pass 1: the settled desktop comparison had no P0/P1/P2 mismatch. A capture taken before the 700 ms hero entrance completed appeared empty; recapturing the intended settled state confirmed that this was animation timing, not a responsive layout defect.

## Follow-up polish

- P3: add automated screenshot baselines for authenticated Web chat and the native galleries when stable fixture data becomes available.

final result: passed

---

# Web Chat Discord-Style Reply Preview Design QA

## Target

- Source visual truth: `/var/folders/tn/l7kr202d20q7j7rcxdy62pwc0000gn/T/codex-clipboard-efebc850-f286-4147-94db-b4b436766dc2.png`
- Browser implementation screenshot: `/Users/haowei/.codex/visualizations/2026/08/08/019fe02c-a025-70f1-acac-7c7d0aa1f26c/chat-discord-reply-implementation.png`
- Focused implementation crop: `/Users/haowei/.codex/visualizations/2026/08/08/019fe02c-a025-70f1-acac-7c7d0aa1f26c/chat-discord-reply-implementation-focus.png`
- Combined comparison: `/Users/haowei/.codex/visualizations/2026/08/08/019fe02c-a025-70f1-acac-7c7d0aa1f26c/chat-discord-reply-comparison.png`
- Browser viewport: 1280 × 720 CSS pixels at standard density
- Source pixels: 1820 × 524
- Focused implementation source crop: 860 × 380, normalized to 1280 × 566 for comparison
- State: dark-mode Chat channel with both right-aligned current-user and left-aligned bot replies

## Full-view comparison evidence

The implementation preserves Cheers' existing channel frame while matching the reference reply hierarchy: a compact source row sits above the reply author header, a small real member avatar and semibold author precede a single-line excerpt, and a muted elbow connector joins the preview to the reply row. Current-user replies mirror the connector to the right without reversing the source text. Discuss retains its separate nested-thread presentation.

## Focused comparison evidence

The combined comparison shows the reference above and the normalized Chat message region below. The focused bot state matches the source's left-to-right sequence of connector, source avatar, source author, excerpt, then the reply author's normal header and body. The right-aligned state is an intentional Cheers-specific adaptation required by Chat mode.

## Required fidelity surfaces

- Fonts and typography: the source preview uses the shared utility sans role, the established 11 px metadata scale, semibold source name, 20 px line height, and a single truncated excerpt.
- Spacing and layout rhythm: 16 px source avatar, 6 px inline gaps, 32 px elbow width, and a tight preview-to-header transition reproduce the compact Discord rhythm without adding a card.
- Colors and visual tokens: existing zinc metadata, border, hover, and focus tokens preserve dark-mode contrast and match the source's subdued reply context.
- Image quality and asset fidelity: the existing production `Avatar` component renders real user/bot avatars or the established identity fallback; no placeholder or generated image asset is required.
- Copy and content: the preview shows the resolved source author and up to 120 characters of source text, with attachment and out-of-view fallbacks.

## Interaction and responsive checks

- The preview is keyboard focusable and clicking it smoothly returns to the loaded source message.
- Long source text truncates within the message content width rather than expanding the timeline.
- The source content remains left-to-right when the current user's reply is mirrored to the right.
- The local production build, authenticated channel route, Chat chronology, and bot reply state were exercised in the in-app browser.

## Findings

No actionable P0, P1, or P2 differences remain. Different message copy, avatar identities, and the mirrored current-user state are intentional product adaptations rather than visual drift. No focused asset-quality issue remains because the preview reuses the production avatar pipeline.

## Comparison history

- Pass 1: no P0/P1/P2 mismatch was found. The reference hierarchy and spacing were reproduced without requiring a post-comparison correction.

## Follow-up polish

- P3: a future message-focus flash could make the click-to-source jump more noticeable in very long channels.

final result: passed

---

# Web Workbench Design QA

## Target

- Source visual: `/Users/haowei/.codex/generated_images/019fcbb5-7c0d-7733-abe7-1a405c90e286/exec-5f15d5cc-3f4a-47da-9e1e-526352fe0f64.png`
- Implementation: `frontend/dev/workbench-preview.html`
- Captured implementation: `/Users/haowei/.codex/visualizations/2026/08/04/019fcbb5-7c0d-7733-abe7-1a405c90e286/web-workbench-implementation-final.png`
- Combined comparison: `/Users/haowei/.codex/visualizations/2026/08/04/019fcbb5-7c0d-7733-abe7-1a405c90e286/web-workbench-comparison-final.png`
- Comparison frame: 1280 × 720 CSS pixels, standard density, Code project / Codemap / Gateway fs.patch selected.

## Evidence reviewed

- Full Workbench frame: existing outer drawer header and controls remain intact.
- Focused interior: scene navigation, item tabs, Codemap canvas, selected-node inspector, status legend, and graph controls.
- Narrow state: horizontal scene navigation and dismissible inspector overlay.
- Interaction checks: scene switch, item switch, node selection, and graph zoom.
- Browser console: no warnings or errors in a fresh preview tab.

## Findings and resolution

1. **P1 — Wide Codemap incorrectly opened a modal-like bottom inspector.** The resize observer mounted before asynchronous content created its target. Fixed by observing again when the parsed document becomes available; wide panels now use the persistent right inspector.
2. **P2 — Redundant scene title row reduced canvas height and diverged from the selected layout.** Removed; content tabs now align directly above the renderer canvas.
3. **P2 — Codemap nodes collapsed into one vertical column because layout was based on dotted identifier depth.** Replaced with deterministic graph-depth layers derived from edges, producing meaningful branches and convergence.
4. **P3 — Preview emitted a duplicate React root warning after hot updates.** The preview now reuses its root.

## Result

passed

---

# Web Chat Editorial Three-Column Design QA

## Target

- Source visual truth: `/Users/haowei/.codex/visualizations/2026/08/10/019feacf-15ac-75a1-ac89-60ca0814cb87/chat-three-column-audit/03-three-column-before.png`
- Implementation screenshot: `/Users/haowei/.codex/visualizations/2026/08/10/019feacf-15ac-75a1-ac89-60ca0814cb87/chat-three-column-audit/05-three-column-final.png`
- Combined comparison: `/Users/haowei/.codex/visualizations/2026/08/10/019feacf-15ac-75a1-ac89-60ca0814cb87/chat-three-column-audit/06-before-after.png`
- Browser viewport: 1440 × 900 CSS pixels at standard density; both screenshots are 1440 × 900 pixels and required no normalization.
- State: authenticated dark Chat route, `claim_test` selected, ViewBoard open and user-resized to a narrow width.

## Full-view comparison evidence

The implementation removes the selected channel's leading border and row separators, reduces the reading size without discarding the serif role, and changes ViewBoard from a rounded floating card to a near-square editorial work panel. The implementation capture additionally contains an existing WebSocket reconnect banner; it is a runtime-state difference rather than a visual implementation target.

## Focused comparison evidence

The full frame keeps all three targets legible at original resolution, so a separate crop was not required. In the left rail, the selected channel retains a neutral fill but has no resting border. In the timeline, the same message wraps less like a heading. In ViewBoard, all five tabs remain named by wrapping onto a second line in the narrow user-resized panel.

## Required fidelity surfaces

- Fonts and typography: message copy remains Source Serif 4 at 15px, normal weight, 1.55 line height, and slightly restrained tracking. Utility metadata, status, panel tabs, and controls use Source Sans 3 on Web.
- Spacing and layout rhythm: sidebar items retain compact 4/8 spacing; ViewBoard uses 2px radii and hairline rules instead of large rounded subcontainers.
- Colors and visual tokens: the neutral zinc palette and semantic warning/error colors are unchanged. Selected navigation state remains visible through fill and text contrast.
- Image quality and assets: no product image or custom raster asset is involved; existing platform/library icons remain sharp and unchanged.
- Copy and content: all messages, labels, tabs, and status copy remain intact.

## Interaction and accessibility checks

- Sidebar selected semantics and button behavior remain unchanged.
- ViewBoard tabs remain buttons and all labels are visible after narrow-panel wrapping.
- TypeScript checks and all 165 Vitest tests passed.
- Browser console contained no errors.

## Findings and comparison history

- Pass 1 [P2]: selected sidebar Item looked like a bordered card. Fixed with a scoped `border-0` override while preserving selection fill and focus state.
- Pass 1 [P2]: 16px serif message copy with relaxed leading looked heading-like. Fixed at 15px, normal weight, 1.55 leading.
- Pass 1 [P2]: ViewBoard retained a 12px card radius and filled segmented controls. Fixed with 2px chrome, editorial rules, underline tabs, and lighter elevation.
- Pass 2 [P2]: all five ViewBoard tabs clipped when the user-resized panel was narrow. Fixed by wrapping the named tabs; the final screenshot shows Plan, Cost, Sessions, Audit, and Activity.
- Runtime limitation: the final capture contains an unrelated reconnect banner; manual retry did not restore the local WebSocket during this audit.

No actionable P0, P1, or P2 visual mismatch remains in the three requested areas.

final result: passed

---

# Floating Panel Design QA

- Source reference: `/var/folders/tn/l7kr202d20q7j7rcxdy62pwc0000gn/T/codex-clipboard-9fcb62d0-2c9a-49e0-97d7-1a56a2efc03c.png`
- Implementation screenshot: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-after.png`
- Side-by-side comparison: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-comparison.png`
- Browser viewport: 1235 x 1243 CSS px at device pixel ratio 2
- State: authenticated local channel with the shared ViewBoard/Workbench floating-panel host open

## Evidence

- The prior right lane occupied 555 px and compressed the channel content. The floating canvas now spans the complete 939 x 1191 px central workspace without changing chat width.
- A panel was dragged from x=300 to the right boundary at x=824, then resized from 411 x 444 to 341 x 384. It remained fully inside the canvas.
- A free drag stopped at the released coordinates instead of snapping to a grid zone.
- Opening ViewBoard raised it above Workbench; closing and reopening Workbench raised Workbench above ViewBoard.
- The source and implementation comparison confirms the intended independent-window treatment: strong elevation, rounded window surface, persistent title chrome, visible drag affordance, and a stable resize control.

## QA History

1. Baseline: right-side lane clipped movement and reduced the chat region to a narrow column.
2. First implementation: full-workspace overlay restored chat width and removed sidebar obstruction.
3. Interaction refinement: mandatory drop snapping was removed; smart first-open placement remains.
4. Multi-window refinement: mounted-but-closed panels now rise to front whenever reopened.

final result: passed

---

# Floating Control Glass Material QA

- Implementation screenshot: `/Users/haowei/Projects/Cheers/artifacts/design-qa/floating-panel-glass-controls.png`
- Preview: `http://127.0.0.1:5173/dev/workbench-preview.html`
- State: local Workbench preview with floating chrome revealed on hover

## Evidence

- Shared title, navigation, action, context, Activity lens, and Activity filter islands use the semantic `floating-control-surface` material.
- Supported browsers resolve the material to the themed Panel surface at 55% opacity with backdrop blur and saturation; unsupported browsers use a 95% opaque fallback.
- `prefers-reduced-transparency: reduce` disables backdrop effects and restores the 95% opaque surface.
- Portal-provided item navigation is content-width and centered instead of spanning the Panel. Direct selectors such as Scope retain the available wide layout.
- Context island whitespace uses `pointer-events: none`; browser hit testing confirmed that only the promoted controls intercept interaction.
- Default-hidden and hover/focus reveal behavior remains unchanged.

## Verification

- Vitest: 84 files, 484 tests passed.
- TypeScript, ESLint, design-system check, and production build passed. ESLint reported existing warnings and no errors.

final result: passed
