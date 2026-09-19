# Editorial Correspondence — style contract

Extracted from the Cheers repository, not invented: `frontend/src/index.css`
(channel tokens), `frontend/tailwind.config.ts` (scales and the ink remap),
`frontend/DESIGN.md` (rules of engagement), and the real primitives in
`frontend/src/components/ui/` (`button.tsx`, `input.tsx`, `control-size.tsx`).
Where the written guide and the shipped code disagree, the code wins and the
divergence is recorded at the bottom.

| # | Axis | Decision |
|---|------|----------|
| 1 | Shape | **One rectangle: 10px.** Controls, fields, cards, items, composer surfaces — all of it. Nested overlays stay concentric: outer = 10px + the actual content inset. `border-radius: 9999px` is reserved for avatars, presence dots, unread dots and progress, where the shape carries meaning. `corner-shape: squircle` as a progressive enhancement. Never a second fixed radius. |
| 2 | Border | **Borderless everywhere.** `border` is banned on buttons, fields, cards, chips and popovers alike; layers separate by surface contrast, shadow and deliberate spacing. The only boundaries are *inset rings* — neutral (field at rest), focus, error, selected — which cost no layout. Hairline 1px rules are reserved for dense register rows and editorial section breaks; tabs keep an underline indicator. |
| 3 | Elevation | **Solid paper stacking.** Opaque fills, a 1px hairline perimeter, controlled shadow: raised for cards, overlay for anchored popovers, floating for draggable windows. No `backdrop-filter`, no glassmorphism on any interactive surface. |
| 4 | Density | **Three registered tiers and no fourth:** compact 28px, regular 36px, comfortable 44px — with every tier collapsing to a 44px touch floor below the `md` breakpoint. Icon slots 14 / 16 / 20 follow the tier. A text button owns a 96px slot, a leading-icon button 128px; label length never sets a peer control's width. |
| 5 | Colour | **The accent is not a hue.** Tailwind's `indigo` is remapped onto a neutral ink scale, and a primary action is `bg-content-strong` — near-white ink on dark, near-black ink on paper, with inverted copy. Greyscale is `zinc` only. Hue is spent exclusively on status (vermilion danger, seal-wax amber, emerald, sky) and on identity badges; never on interactive chrome, focus rings or buttons. |
| 6 | Surface | **Dark is the default**, warm paper is the override. Five layers back to front: rail → sidebar → canvas → panel → control, with separate selected and emphasis layers on top. |
| 7 | Type pairing | Source Sans 3 for all UI chrome, Source Serif 4 for display and reading, SF Mono for code — each with Source Han / Noto CJK fallbacks so Chinese sets in the same voice. |
| 8 | Scale | **Four registered tiers:** minimal 10px, compact 12px, regular 14px, comfortable 16px. That is the whole UI scale — it is deliberately compact, and supporting copy drops to the next quieter tier rather than inventing a size. Three larger display sizes exist for serif mastheads only. |
| 9 | Micro-labels | A tracking ladder instead of uppercase shouting: label 0.025em, section 0.05em, overline 0.1em, display −0.015em, masthead leading 0.98. Sentence case throughout. |
| 10 | Iconography | Lucide, 2px stroke, sized to the control tier (14/16/20). Icons are semantic: the same glyph always means the same action. |
| 11 | Motion | `transition-colors` at 100ms on every interactive element, 150ms for shadow and outline, one 0.98 press scale, a 150ms fade-in with a 4px rise. No bounce, no travel, nothing decorative. |
| 12 | Focus | A 2px ring at `content-strong / 50%`, outside the control; fields take the same colour as a 1px *inset* ring so the boundary never shifts. Selection is a separate 2px inset rail on the leading edge. Never a border swap. |

## Voice

Terse, registered, and never chatty. Visible action labels come from the
`ActionKey` registry — object names and context belong in `aria-label` or in
adjacent supporting text, not in the button. Latin labels fit a 68px slot: at
most eight characters, at most two words. Errors state what failed and what to
do; no apologies.

## Deliberate non-goals

No neon accent. No glassmorphism or `backdrop-blur` on interactive surfaces. No
boxed cards or decorative borders. No second radius. No fourth control height
(in particular, no 32px icon-button tier). No `gray` / `slate` / `neutral` /
`stone` — `zinc` only. No `rose` for errors; rose is mentions and nothing else.
No feature-local horizontal padding on shared controls.

## Where this kit departs from the repo, and why

1. **Focus ring unified.** `button.tsx` focuses with `ring-zinc-700/60
   dark:ring-zinc-300/60`, but the zinc scale is itself inverted under
   `[data-theme="light"]`, so the pair double-inverts and the light-theme ring
   lands on a near-invisible warm grey. The kit uses the field's own signature —
   `content-strong / 50%` — for every control, which is high-contrast in both
   themes by construction.
2. **Field ring follows the written 3:1 rule.** `input.tsx` ships
   `ring-zinc-700/60`, which is roughly 1.3:1 against the field fill. DESIGN.md
   requires a field boundary to hold at least 3:1, so the kit uses `zinc-600` at
   full opacity — the value DESIGN.md itself names — measuring 3.2:1 on dark and
   4.6:1 on paper.
3. **DESIGN.md's colour table is stale.** It still says "Buttons `indigo-600`,
   focus rings `indigo-500`, links `indigo-400`". The config remaps `indigo` to
   the ink scale and `button.tsx` fills with `content-strong`, so the kit
   follows the code: no hue in interactive chrome.
4. **`--accent-500` / `--accent-600` are undefined** in `index.css` even though
   the workbench annotation rules reference them. The kit does not reproduce
   that; a separate task tracks fixing it in the product.
