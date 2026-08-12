# Cheers design review checklist

Use this checklist after reading the canonical files named in `SKILL.md`.

## Structure

- Every semantic row uses a shared Item family or a documented specialized structure.
- Every business ItemList declares both PresentationLevel and ControlSize at its boundary.
- Browse items are single-line; long content truncates instead of overflowing.
- Composite rows have no row click and no nested buttons.
- Critical states remain visible in max, medium, and minimal.
- Sidebar group labels are static ItemSection dividers; only a separate labeled action is interactive.
- Selected NavigationItems retain a visible neutral fill and expose current-page semantics in borderless placements.
- Avatar, semantic icon, Presence/Unread/Progress content uses only small, regular, or large ContentSize.
- Checkbox keeps a 16px glyph inside a ControlSize-governed label hit target.
- FileTree and Diff rows declare ControlSize; canvas, gutter, editor, and panel geometry use specialized layout tokens.
- Shared content primitives have no business-level width/height overrides.
- Vertical identity rails use only the ContentSize 64/96/128px width mapping.

## Managed collections

- Members, claims, links, grants, passkeys, and sessions use CollectionManager behavior.
- Search and exactly one Add action appear at collection level.
- Add inserts an editor; Edit replaces its row; Delete/Revoke enters inline confirmation.
- Empty state does not repeat Add; no-result state offers Clear search.
- Unsupported service capabilities are omitted instead of simulated.

## Visual language

- Ordinary rectangular radius resolves to 4px/pt/dp.
- Resting surfaces have no four-sided decorative border.
- Hairlines are directional and structural.
- No neon glow, decorative gradient, saturated shadow, or boxed-card wall remains.
- Spacing follows the 4/8 system and controls use only the three shared sizes.
- Peer text controls use the shared width slot or fill mode, never content-derived width.
- Business call sites do not override shared horizontal padding with px/pl/pr utilities.
- Composer context items and Add context share regular height; nested item actions use compact controls without increasing the outer row.

## Typography and icons

- Display, reading, and utility are the only semantic font roles.
- Entity and navigation names use utility sans; message and long-form copy use reading serif.
- Chinese reading/display text resolves to Source Han Serif CN or the approved localized fallback.
- Every visible text run uses minimal, compact, regular, or comfortable; no
  arbitrary or legacy Tailwind size remains, including code, Diff, charts,
  dense panels, mastheads, and empty states.
- Semantic icons use the shared mapping; utility icons follow platform convention.
- Personal workspace uses the Cheers system mark.

## Interaction and accessibility

- Desktop compact visuals preserve at least 44px/pt or 48dp touch targets on touch devices.
- Icon controls have accessible names and visible focus.
- Keyboard, VoiceOver, TalkBack, Dynamic Type, 200% zoom, and reduced motion are preserved.
- Error, approval, unread, mention, online, disabled, loading, and destructive states are explicit.

## Verification

- Gallery or previews cover affected presentation levels, control sizes, and states.
- Web is checked at 390px, 768px, and 1280px without clipping or horizontal overflow.
- The design scanner, typecheck, tests, build, and `git diff --check` pass for the changed scope.
- Any exception has a narrow semantic reason recorded in the audit source.
