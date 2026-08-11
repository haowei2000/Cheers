# Cheers cross-platform item design system

> **Language**: English | [中文](DESIGN_LANGUAGE.zh-CN.md)

`item-contract.json` is the platform-independent contract for reusable UI items.
It defines information density, semantic actions, cross-platform availability,
and the states that must remain perceivable at every presentation level.
`INVENTORY.md` is the human-readable migration ledger for the full product.
`DESIGN_LANGUAGE.zh-CN.md` records the product-facing decisions, usage rules,
and phased migration boundary in Chinese.

## Platform mapping

| Contract concept | Web | iOS | Android |
|---|---|---|---|
| inherited level | `PresentationProvider` | `EnvironmentValues.presentationLevel` | `LocalPresentationLevel` |
| local override | `presentationLevel` prop | `.presentationLevel(_:)` | `presentationLevel` parameter |
| generic item | `ItemRow` | `CheersItemRow` | `CheersItemRow` |
| component gallery | `dev/item-gallery.html` | SwiftUI previews | Compose previews |

The three platforms intentionally do not share rendered UI code. They must
share anatomy, state meaning, and level behavior while preserving React,
SwiftUI, and Compose conventions.

## Editorial visual grammar

Shared items use a formal, newspaper-inspired treatment across platforms:

- near-square 2px corners for rows, chips, and icon controls;
- compact 4/8px spacing inside items while preserving 44pt/48dp hit targets;
- Source Sans 3 on Web and native platform sans-serif on mobile for entity names and navigation labels, with Source Serif 4 plus Source Han Serif CN reserved for reading content;
- hairline rules instead of shadows to separate content;
- restrained neutral surfaces, with color reserved for semantic state.

Typography has exactly three semantic roles:

- `display`: Source Serif 4 Display/Semibold (`opsz` 60 on Web) for Latin,
  Greek, and Cyrillic, and Source Han Serif CN Semibold for Chinese product
  introductions, hero copy, and major headings;
- `reading`: Source Serif 4 Text/Regular or Semibold (`opsz` 14 on Web) plus
  Source Han Serif CN Regular/Semibold for Chinese
  message copy, previews, and long-form content at a compact 14px Web / 16pt iOS / 15sp Android base size
  and approximately 1.55 line height;
- `utility`: Source Sans 3 on Web and the native platform sans face on iOS and
  Android for entity names, navigation labels, controls, trace labels,
  warnings, status, and metadata. CJK falls through to the native platform
  sans. Monospace remains a technical sub-role only for code, commands, paths,
  and identifiers.

Large product mastheads may use the shared `masthead` display variant (`opsz`
32 on Web with neutral tracking). It is broader and sturdier than ordinary
display headings but does not introduce another font role.

The resolver selects one family for a complete text run so Chinese never mixes
Source Serif metrics with per-glyph fallback. Japanese and Korean retain their
locale-correct native serif; utility text keeps the multilingual native sans
fallback on mobile.

Circles remain valid only when they carry meaning, such as avatars, presence,
or unread dots. Presentation level changes information density, not touch size.

## Web gallery

The gallery is a Vite entry and cannot be rendered directly with a `file://`
URL because its React, TypeScript, and Tailwind imports require transformation.
Start it from the repository root with:

```bash
cd frontend && npm run item-gallery
```

Then open <http://127.0.0.1:4175/dev/item-gallery.html>. If the HTML file is
opened directly, it shows this recovery instruction instead of a blank page.

## Migration rule

Migrate a complete semantic item at a time. Once all call sites for an item use
the shared primitive, remove the old local recipe. Do not keep compatibility
wrappers that preserve two visual contracts.

Run `node scripts/check-design-system.mjs` to validate the contract and the
platform presentation registries. The check also ratchets the current direct
Web/SwiftUI/Compose control counts: new work must use shared primitives, and
each migration should lower the recorded ceiling.
