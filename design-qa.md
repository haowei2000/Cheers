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

- Fonts and typography: existing Cheers system sans is retained; the source preview uses the established 11 px metadata scale, semibold source name, 20 px line height, and a single truncated excerpt.
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
