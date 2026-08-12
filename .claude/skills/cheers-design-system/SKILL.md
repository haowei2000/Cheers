---
name: cheers-design-system
description: Apply and audit the Cheers Editorial Correspondence design system across React Web, SwiftUI, Compose, the public website, and policy pages. Use when building, migrating, reviewing, or fixing UI items, lists, collections, typography, icons, spacing, control sizes, corners, borders, message details, responsive behavior, accessibility, or component-gallery coverage in the Cheers repository.
---

# Cheers Design System

Apply the repository's canonical cross-platform design contract. Do not invent a
feature-local visual recipe when a shared semantic component or token exists.

## Load the contract

Before changing UI, read these files completely:

1. `../../../design-system/DESIGN_LANGUAGE.zh-CN.md` for canonical visual and interaction decisions.
2. `../../../design-system/item-contract.json` for item types, states, levels, and platform availability.
3. `../../../design-system/COLLECTION_MANAGER.zh-CN.md` when the surface contains Search, Add, Edit, Delete, Revoke, members, claims, links, grants, passkeys, or sessions.
4. `../../../frontend/DESIGN.md` for Web implementation details only after reading the canonical cross-platform contract.
5. `references/review-checklist.md` before final verification.

Treat the canonical design language as higher priority than legacy mockups,
feature-local classes, historical docs, or stale recipes later in the Web guide.

## Classify before implementing

Identify both independent axes for every component:

- Set `PresentationLevel` to `max`, `medium`, or `minimal` for information density.
- Set `ControlSize` to `comfortable`, `regular`, or `compact` for physical height.
- Set `ContentSize` to `small`, `regular`, or `large` for avatars, semantic icons,
  presence, unread, and progress glyphs; never use it to shrink a hit target.
- Default to `medium / regular`; never create a fourth level or arbitrary height.
- Default content to `regular`; change the ContentSize tier instead of overriding
  shared Avatar, PresenceDot, or EditorialIcon width/height classes.
- Size vertical identity rails from the shared ContentSize 64/96/128px mapping;
  never add a feature-local rail width.
- Preserve critical status and the touch-target floor at every level.

Classify each row as EntityItem, NavigationItem, OperationsItem, WorkbenchItem,
or a justified specialized tree/diff/table/canvas/editor structure. Use an
`ItemList` or `ItemSection` inheritance boundary instead of repeating item props.

## Implement shared structure

- Keep browse items single-line with `min-width: 0` and truncation.
- Give peer text controls the shared width slot or explicit fill mode; never size them from label length.
- Never override a shared control's horizontal padding from a business `className`; change the primitive or a registered variant.
- Never add local `p-*` to a shared control. Use `square` with ControlSize for icon actions and the primitive-owned padding for text actions.
- Flex rows and headers in the control rhythm must use 28/36/44px; do not create 32/40/48/56px tiers.
- Semantic icons must resolve through 14/16/20px and identity marks through 20/28/36px shared mappings. Keep every CI ceiling for these rules at zero.
- Use `leading -> title -> critical status/status -> actions` anatomy.
- Use a row action only for a single-action row; use an actions slot for composite rows.
- Never nest buttons or put interactive controls in a non-interactive trailing slot.
- Use `CollectionManager` for managed lists. Keep exactly one Add entry, edit in place,
  and replace a row with confirmation before Delete or Revoke.
- Keep resting surfaces borderless, ordinary rectangular radius at 4px, and spacing on
  the 4/8 system. Do not add neon glow, decorative gradients, boxed-card walls, or
  arbitrary shadows.
- Use display serif for major publishing headings, reading serif for message/long-form
  copy, and utility sans for entity names, navigation, controls, warnings, and trace.
- Render Chat, Discussion, and Reply with the same regular message identity:
  28px Avatar, 96px identity rail, sender name only, with no visible timestamp
  or BOT label.
- Use only four typography sizes everywhere: minimal 10px, compact 12px,
  regular 14px, and comfortable 16px. Dense panels, code, Diff, charts,
  mastheads, and empty states receive no exception.
- Use the shared semantic icon mapping. Keep glyphs simple and distinguishable.

Preserve native platform behavior and accessibility. Do not make unsupported Android
features into placeholder pages. Do not change API or DTO contracts for visual work.

## Audit the result

Inspect source first, then verify the running UI or platform preview when available.
Run the design-system scanner, type checking, tests, and build appropriate to the
changed platform. Add or update gallery/previews for every affected level, size, and
critical state.

Report the root cause, the shared component or token adopted, any specialized exception,
and the verification performed. Do not claim full migration while unclassified local
row/card recipes or scanner violations remain.
