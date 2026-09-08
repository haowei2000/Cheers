# HIG Foundations — color, dark mode, typography, layout, materials, icons, motion, writing, accessibility

Review-ready distillation of Apple HIG foundation pages for auditing React web frontends: every concrete spec preserved, platform jargon translated to web terms (pt = px 1:1, Dynamic Type = text scaling/200% zoom, VoiceOver = screen reader).

## Contents

- [Layout & adaptivity](#layout--adaptivity)
- [Materials & translucency](#materials--translucency)
- [Branding](#branding)
- [Inclusion](#inclusion)
- [Color](#color)
- [Dark mode](#dark-mode)
- [Typography](#typography)
- [Icons & symbols](#icons--symbols)
- [Images](#images)
- [Motion](#motion)
- [Writing & tone](#writing--tone)
- [Accessibility](#accessibility)
- [Quick-scan spec table](#quick-scan-spec-table)

---

## Layout & adaptivity

**Principles**
- Feel at home on the host platform: a web app should respect web/desktop conventions (selectable text, real links, working browser zoom and back button, hover states, focus rings) rather than importing native-mobile idioms.
- Layout grounds people in content from the first moment. People expect familiar relationships between controls and content; matching those expectations makes features discoverable without instruction.
- People scan in reading order — top to bottom, leading edge to trailing edge — so screen position encodes importance. Reading order flips in RTL locales.
- Alignment and indentation are information: they communicate grouping and hierarchy, ease scanning, and help people keep their place while scrolling.
- Controls and navigation (sidebars, tab bars, toolbars) live on a layer *above* content — content scrolls edge-to-edge underneath the chrome, it doesn't stop where the chrome begins.
- Layouts must adapt to context changes (window resize, text-size changes, locale/RTL, display changes) while staying *recognizably consistent* — people expect familiarity when they resize or switch devices.
- Progressive disclosure: when a collection can't be shown at once, visibly hint that more exists (partially visible items, scroll shadows) so people know to scroll or expand.

**Specs**
- Keep primary content comfortably inset from viewport edges: 60px from top/bottom, 80px from sides (edge content is hard to see).
- Centers of adjacent interactive elements at least 60px apart so targets are easy to distinguish.
- Size classes are binary — regular vs. compact. Design the full/regular layout first, then one compact fallback (desktop-first breakpoints for a desktop app).
- Test layouts at 1/2, 1/3, and 1/4 of a typical display width (window-tiling analog).

**Do**
- Group related items with negative space, background shapes, colors, or separators — keeping content and controls clearly distinct.
- Give essential information the most space; move secondary detail to other views/panels.
- Extend backgrounds and scrollable content to window edges; float chrome above it.
- Stay in the full-size layout as long as it fits before collapsing, so the UI feels stable during resizes.
- Respect safe areas/system margins; use standard margins and restrict text line length for readability.
- Support user text-size changes (browser zoom / root font-size).
- Test largest and smallest layouts first; test LTR, RTL, and long translated strings.
- Scale (never distort) artwork when a container's aspect ratio changes; keep the important region visible.

**Don't**
- Crowd essential information with nonessential details.
- Place unrelated controls close together — people can't tell them apart.
- Make full-width buttons that ignore margins (buttons spanning an entire pane).
- Anchor critical controls solely at the very bottom of a window — short viewports and moved windows push the bottom edge offscreen.
- Cause jarring reflows at intermediate window sizes.

**Web review checks**
- [ ] App doesn't fight the browser: text selectable, links are real `<a>` elements, zoom and back button work; desktop conventions (hover, focus rings) present.
- [ ] Sidebar/panels/headers render as a layer above scrolling content (content scrolls beneath sticky chrome edge-to-edge), not as blocks content merely abuts.
- [ ] Most important content/actions sit top-left (top-right in RTL); layout uses logical CSS properties (`margin-inline-start` etc.) or otherwise mirrors under `dir="rtl"`.
- [ ] Related controls are visually grouped; unrelated controls clearly separated; centers of adjacent interactive controls ≥ ~60px apart or otherwise unambiguous.
- [ ] Resizing from full width to ~1/3 width produces no broken/overlapping layout; layout stays in its "full" arrangement as long as it fits before collapsing.
- [ ] Page usable at 200% browser zoom / increased root font size: no clipped text, no overlapping controls (rem-based sizing). (Full zoom checks: see Accessibility.)
- [ ] Overflowing lists/panels give a visible cue that more exists (scroll shadow, partially visible row, count badge).
- [ ] Elements align to a consistent grid — labels, cards, controls share left edges within a section; indentation reflects hierarchy.
- [ ] Critical actions aren't anchored solely to the bottom edge of a tall scrollable window.

## Materials & translucency

**Principles**
- A material (translucency/blur) creates depth: it separates the *functional layer* (controls, navigation) from the *content layer*, and letting background color pass through preserves the user's sense of place — they can tell what's behind the chrome.
- Chrome floats; content scrolls and "peeks through" beneath it, while blur + luminosity adjustment keeps text on the chrome legible.
- Choose a material by *semantic role and legibility need*, never by the color it happens to impart — dark mode, reduced transparency, and increased contrast all change how materials render.
- Thickness is a legibility dial: more opaque = better contrast for text and fine detail; more translucent = more context about what's behind.

**Specs**
- Translucent chrome over *bright* media/content needs a dark dimming scrim at ~35% opacity behind it; unnecessary if the underlying content is already dark.
- Four standard material thicknesses: ultra-thin, thin, regular (default), thick.
- Foreground-on-material (vibrancy) contrast hierarchy: default (highest) > secondary > tertiary > quaternary (lowest). Never put quaternary-level (lowest-contrast) text on the thinnest materials.
- Two glass variants: regular (blurs + adjusts luminosity; for text-heavy components — alerts, sidebars, popovers) and clear (highly translucent; only over visually rich media backgrounds).

**Do**
- Reserve translucency/blur for navigation and control chrome (sidebars, headers, toolbars, overlays); use sparingly, only on the most important functional elements.
- Use semantic/theme foreground tokens on translucent surfaces so text never goes too dark, too bright, or low-contrast.
- Use a scroll-edge transition (shadow/blur/fade appearing once content scrolls under) where content meets sticky chrome, instead of a permanently hard opaque bar.
- Pick opaque-leaning surfaces for text-dense components; translucent only where background context genuinely helps.

**Don't**
- Use glass/translucency inside the content layer itself (cards, message bubbles) — it muddles the chrome-vs-content hierarchy.
- Overuse blur on custom controls — materials spotlight content; everywhere-glass distracts from it.
- Select a material for its apparent tint — appearance shifts with theme and accessibility settings.

**Web review checks**
- [ ] `backdrop-filter: blur()` / translucent backgrounds appear only on chrome (sticky headers, sidebars, floating panels, modals), never on content cards or message bubbles.
- [ ] Text over any translucent surface meets contrast in BOTH themes, tested with busy content scrolled beneath it.
- [ ] Overlays above bright/media content include a dimming scrim (~35% black or theme equivalent).
- [ ] Sticky headers/toolbars use a scroll-edge treatment that appears only once content scrolls under.
- [ ] App honors `prefers-reduced-transparency` / `prefers-contrast` (or provides an opaque fallback where `backdrop-filter` is unsupported).
- [ ] Foreground colors on translucent surfaces come from semantic tokens, not hand-picked hexes that only work in one theme.

## Branding

**Principles**
- Branding defers to content: screen space that only displays a brand asset steals room from what people came for. People seldom need reminding which app they're in.
- A stylized interface stays approachable *if* it keeps familiar behaviors — components in expected locations, standard symbols for common actions. Consistency, not chrome, creates comfort.
- Brand lives best in the voice/tone of copy, one accent color, and restrained typography — not logos.

**Specs** — none.

**Do**
- Express brand through a consistent voice and tone in all written UI copy.
- Pick one accent color applied to interactive elements (buttons, icons, highlighted text); respect user-chosen accent overrides where offered.
- If using a custom brand font, restrict it to headlines/subheadings, verify legibility at all sizes, and keep legibility-optimized fonts for body and captions; support bold-text and larger-type settings.
- Keep UI components in expected locations; use standard iconography for common actions.

**Don't**
- Sprinkle the logo through the app; show it only where it provides real context.
- Use the launch/loading screen as a branding moment — it disappears too fast to communicate; put brand in an optional, skippable welcome screen instead.
- Let brand elements displace information or controls people need.

**Web review checks**
- [ ] No persistent logo/banner consuming layout space beyond a small identifier in the sidebar/header corner.
- [ ] One accent color applied consistently to primary interactive elements; meets contrast on its backgrounds in both themes.
- [ ] Custom display fonts never appear at body/caption sizes; body text uses a legibility-optimized stack.
- [ ] Splash/loading states show progress or skeletons, not brand showcases.
- [ ] Standard actions (send, search, settings, close) use conventional icons and positions, not brand-invented metaphors.

## Inclusion

**Principles**
- Inclusive is more than inoffensive: the goal is an experience everyone can access and understand, which requires actively examining assumptions about other people's contexts.
- Every disability is a spectrum, and everyone experiences temporary (infection) and situational (noisy train) disability — accessibility work benefits all users.
- Plain, direct language welcomes more people AND translates better; colloquialisms, humor, and undefined jargon each exclude whoever doesn't share the context.
- Decisions based on stereotypes or context-specific assumptions (security questions assuming college, cars, sight) inevitably exclude; prefer universal human experiences.
- An approachable app requires no prior skill or knowledge, and offers a skippable path to deepen understanding over time.

**Specs** — none.

**Do**
- Address people directly as "you/your"; reserve "we/our" for the company/product.
- Define technical terms on first use, or replace with plain language.
- Write gender-neutral copy ("Subscribers can post recipes", not "his or her") — it also survives localization into gendered languages.
- If gender must be collected, offer nonbinary / self-identify / decline options; consider letting people specify pronouns.
- Use people-first language about disability; portray diverse people non-stereotypically in imagery.
- Internationalize: externalize strings, handle RTL, locale-aware date/time/number formatting; verify color meanings per culture (white = purity in some cultures, death/grief in others).
- Support assistive tech (screen readers, captions, keyboard access) as a baseline.

**Don't**
- Refer to "the user"/"the player" in UI copy — it feels distant.
- Use colloquial expressions or culture-bound humor in interface text.
- Assume any disability precludes interest in your product.
- Encode cultural assumptions into flows (required fields, examples, or verification questions presuming a specific life context).

**Web review checks**
- [ ] Grep UI strings for "the user"; copy addresses people as "you/your".
- [ ] Copy free of idioms, insider jargon, and untranslatable jokes; technical terms defined or avoided.
- [ ] All user-facing strings go through an i18n layer (no hardcoded English in components); locale-aware date/time/number formatting.
- [ ] Layout and icons work under `dir="rtl"`; directional navigation icons (arrows, chevrons) flip appropriately.
- [ ] Default avatars/placeholder people are gender-neutral; forms don't require gender (and offer inclusive options if present).
- [ ] Meaning never conveyed by color alone (see Color/Accessibility); app fully operable by keyboard and screen reader (semantic HTML/ARIA on lists, composer, panels).
- [ ] Onboarding/help is skippable; the core flow requires no prior knowledge of app-specific concepts.

## Color

**Principles**
- Color is a communication channel — status, feedback, interactivity, hierarchy, brand. One color must mean one thing: reusing the "interactive" color on non-interactive text teaches a false affordance.
- Semantic (dynamic) colors are defined by *purpose* (background level, label, link, separator), not hex value. Encoding intent instead of appearance is what lets an entire UI adapt to light/dark and increased contrast without per-component fixes.
- Color must never be the only carrier of essential information — color-blind and low-vision users need a redundant channel (text, icon shape, position). This redundant-encoding rule recurs in Inclusion, Icons, Motion, and Accessibility; state findings once against the offending component.
- Colors read differently in context: over translucent surfaces, next to rich artwork, under different lighting, across cultures (red = danger in some, positive in others). Test in context, not on a swatch.
- Accent color works by scarcity: reserve strong color for the one primary action or status indicator; coloring many controls at once destroys the emphasis it was meant to create.

**Specs**
- Provide minimum 2 variants per custom color (light + dark) plus an increased-contrast variant of each — 4 total appearance variants per custom color.
- Background hierarchy: exactly 3 levels — primary (overall view), secondary (grouped content within it), tertiary (groups within secondary). Two parallel sets exist natively ("system" and "grouped" for list layouts); on web, 3 levels of surface tokens is the rule.
- Wide-gamut assets: Display P3 profile at 16 bits/channel, exported as PNG; supply sRGB fallbacks for gradients/close color pairs that clip or merge on sRGB displays.
- Published system color values fluctuate between OS releases — treat them as non-stable; use tokens, never hard-coded literals.

**Do**
- Use semantic color tokens by role (background level, label level, link, separator); apply brand color as a single accent.
- Supply light, dark, and increased-contrast variants for every custom color, even in a single-appearance app.
- Pair color with a text label or glyph whenever color conveys state, status, or interactivity.
- Put emphasis color on the *background* of the one primary action (filled "Done" button), not on its text/icon.
- Prefer monochromatic icon/label treatment in toolbars; keep accent color where the background is calm.
- Embed color profiles in images (sRGB baseline).
- Prefer the platform-native color picker when letting users choose colors.

**Don't**
- Use the same color for different meanings, or different colors for the same meaning.
- Hard-code system color values — they change between releases.
- Repurpose semantic tokens against their meaning (separator color as text, label color as background).
- Rely on color alone to distinguish objects or communicate essential information.
- Apply accent color to many controls at once, or place similarly-colored content directly under colored controls (contrast collapses).

**Web review checks**
- [ ] No raw hex/rgb literals in component code for UI chrome; all colors come from a semantic token layer (CSS variables / theme object) named by role (`--bg-primary`, `--text-secondary`, `--separator`), not hue (`--blue-500` used directly).
- [ ] Every custom token defines both a light and a dark value; grep for tokens defined only once.
- [ ] Accent/brand color marks interactivity consistently: nothing non-interactive (headings, decorative text) uses the same or a confusable color.
- [ ] Backgrounds use at most 3 hierarchy levels (page → panel/card → nested group), each a distinct token; nested surfaces don't reuse the page background token.
- [ ] Any state conveyed by color (error, success, online/offline, unread) also has a non-color signal: icon, label, badge shape, or text.
- [ ] Exactly one filled/accent-background primary action per view region; secondary actions are neutral (bordered/ghost).
- [ ] Colored text/icons on colored or image backgrounds (chat bubbles, banners) still meet contrast at their resting/default scroll position.
- [ ] Semantic tokens not cross-purposed (border/separator variable used as body-text color).

## Dark mode

**Principles**
- Dark mode is a *user-level* preference set once system-wide; an app that ignores the OS setting reads as broken. An app-only toggle adds work.
- Dark palettes are not inverted light palettes: backgrounds dim while foregrounds brighten, and perceptual contrast is deliberately *increased* so foreground content stands out. Naive inversion produces wrong hierarchy and glare.
- In dark mode, depth is communicated by *lightness*, not shadow: elevated surfaces (modals, popovers, foreground panels) use brighter backgrounds than base surfaces so layered UI reads as "closer." Custom backgrounds break this depth signal.
- Appearance can change *while the app runs* (auto mode switches with time of day) — both palettes must be first-class and switchable live, not a build-time choice.
- A permanently dark UI is acceptable only for immersive media contexts where chrome should recede.

**Specs**
- Minimum foreground/background contrast: 4.5:1 in all appearances.
- Target for custom foreground/background pairs: 7:1, especially for small text.
- Dark background system: 2 sets — base (receding layers) and elevated (foreground layers: modals, popovers); elevated is brighter than base.
- Every custom color needs a bright and a dim variant (2 values minimum; 4 combined with increased-contrast variants — see Color).

**Do**
- Follow `prefers-color-scheme`; switch live when it changes mid-session.
- Use adaptive semantic colors; define light+dark pairs for every custom color.
- Make elevated dark surfaces (modals, popovers, floating panels) brighter than the page background to signal depth.
- Slightly dim white-background images in dark mode so they don't "glow."
- Provide separate light/dark icon assets when a glyph needs an outline in one mode; test every full-color image in both modes.
- Test dark mode with increased-contrast and reduced-transparency settings, separately and combined.

**Don't**
- Ship an app-specific appearance setting that ignores the OS preference (a manual override *in addition to* auto is tolerable; ignoring the system default is not).
- Assume dark colors are inverted light colors.
- Hard-code colors that can't adapt.
- Use custom backgrounds that erase the base-vs-elevated depth distinction.
- Let dark-on-dark text pass because "strong-vision users can read it."

**Web review checks**
- [ ] App defaults to OS `prefers-color-scheme`; any manual toggle includes a "System/Auto" option and reacts live to `matchMedia('(prefers-color-scheme: dark)')` changes without reload.
- [ ] Text-on-background contrast ≥ 4.5:1 in BOTH themes (7:1 for small/secondary text with custom colors) — audit chat text, timestamps, placeholders, sidebar labels in dark mode specifically.
- [ ] Dark theme has distinct base vs. elevated surface tokens: modals, popovers, dropdowns, hover cards use a *lighter* background than the page (not the same token, not darker, not shadow-only).
- [ ] Dark palette is authored, not derived by inverting/filtering light values (no `filter: invert()` hacks; foregrounds brighter, backgrounds dimmer).
- [ ] Avatars, logos, embedded images with white backgrounds are dimmed or treated in dark mode so they don't glow.
- [ ] Icons/logos relying on an outline or fill legible in one theme have per-theme variants or theme-aware `currentColor` styling.
- [ ] Legibility verified with `prefers-contrast: more` / forced-colors — dark-gray text on dark backgrounds is the known failure spot.
- [ ] No component hard-codes `white`/`black`/light-theme hexes leaking into dark theme (grep for `#fff`, `#000`, `white`, `black` in component styles).

## Typography

**Principles**
- Legibility first: people read at varying distances, lighting, and vision levels — choose sizes and weights for the worst reasonable reading condition, not the designer's monitor.
- A small, systematic type scale (named size + weight + line-height per role) is how hierarchy is communicated. Users infer importance from consistent size/weight differences; ad-hoc sizes and mixed typefaces obscure that hierarchy.
- Not all content scales equally: when people enlarge text they want the *content they care about* (body/messages) bigger — chrome like tab labels shouldn't grow equally. Scale primary content aggressively, chrome conservatively, and keep relative hierarchy intact at every size.
- Weight is a legibility variable, not just a style variable: light/thin weights vanish at small sizes; heavier "emphasized" variants are the sanctioned way to add one more hierarchy level without a new size.
- Layout adapts to type, not the reverse: at large text sizes prefer stacking (text above timestamps/icons), fewer columns, no truncation of meaningful content; meaning-bearing icons scale with the text they accompany.

**Specs** (pt = px 1:1)
- Body defaults/minimums: iOS 17px default, 11px minimum; macOS 13px default, 10px minimum. Desktop-web rule: ~13px floor for UI labels; never render meaningful text below 10–11px.
- macOS text-style scale (size/line-height px, regular weight → emphasized weight):
  | Style | Size/LH | Weight → Emphasized |
  |---|---|---|
  | Large Title | 26/32 | Regular → Bold |
  | Title 1 | 22/26 | Regular → Bold |
  | Title 2 | 17/22 | Regular → Bold |
  | Title 3 | 15/20 | Regular → Semibold |
  | Headline | 13/16 | Bold → Heavy |
  | Body | 13/16 | Regular → Semibold |
  | Callout | 12/15 | Regular → Semibold |
  | Subheadline | 11/14 | Regular → Semibold |
  | Footnote | 10/13 | Regular → Semibold |
  | Caption 1 | 10/13 | Regular → Medium |
  | Caption 2 | 10/13 | Medium → Semibold |
- iOS scale at the default (Large) setting: Large Title 34/41; Title 1 28/34; Title 2 22/28; Title 3 20/25; Headline 17/22 Semibold; Body 17/22; Callout 16/21; Subhead 15/20; Footnote 13/18; Caption 1 12/16; Caption 2 11/13.
- Line-height ratios implied: ~1.2–1.35× font size for body-range text (17/22 ≈ 1.29, 13/16 ≈ 1.23). Looser leading for long/wide passages; tighter leading only in height-constrained 1–2-line contexts.
- 3+ lines of text: never tight leading, even where height is limited.
- Text-scaling range: body scales from 14px (smallest setting) up to 53px (largest accessibility setting) — a design must survive body text at roughly 2–3× default.
- Weights: prefer Regular, Medium, Semibold, Bold; avoid Ultralight, Thin, Light (invisible at small sizes). Emphasized variants per style: Medium/Semibold/Bold/Heavy per the scale above.
- Tracking (system font): slightly positive below 12px (+0.12px at 10px), 0 at 12px, negative from 13px through ~23px (−0.31px at 16px, −0.43px at 17px), slightly positive again at display sizes 24px+. Web takeaway: small text slightly loose, 13–20px slightly tight, never large positive tracking on body text.

**Do**
- Use a defined type scale (title/body/caption roles) consistently; derive hierarchy from size + weight + color together.
- Minimize typefaces (ideally one family plus a monospace where needed).
- Test legibility in real contexts (both themes, small sizes, long content); bump size or contrast when text is hard to read.
- Scale meaning-bearing icons with adjacent text; match icon stroke weight to text weight.
- Keep primary elements in stable positions and preserve hierarchy when users scale text or zoom.

**Don't**
- Use light/thin weights for small or body text.
- Let chrome (tabs, nav labels) scale as much as content when users increase text size.
- Truncate meaningful text at larger sizes when wrapping or stacking would fit it.
- Use tight line-height for passages of 3+ lines.
- Mix many typefaces or invent one-off sizes outside the scale.

**Web review checks**
- [ ] Body/message text ≥ 13px (prefer 14–17px); no meaningful text below 11px anywhere at 100% zoom.
- [ ] Single documented type scale (small set of font-size/weight/line-height tokens); grep for hard-coded `font-size` outside the token set — each is a finding.
- [ ] Line-height on multi-line text ~1.2–1.45; no `leading-none`/`leading-tight` on any block that can wrap to 3+ lines.
- [ ] No font-weight below 400 in the UI; text ≤ 12px uses weight ≥ 400 and doesn't rely on color alone to stay readable.
- [ ] Hierarchy expressed by at most ~3 levels per view via size/weight (e.g. title 15–17px semibold, body 13–14px regular, caption 11–12px secondary color); headings distinct from body without relying only on color.
- [ ] Page respects browser zoom / OS font scaling: at 200% zoom nothing overlaps, timestamps/badges wrap or stack instead of clipping message text, content order (title above body) preserved.
- [ ] Long labels wrap or use tooltip-backed truncation, never silent clipping; scrollable text regions don't hide content with no way to read the rest.
- [ ] Letter-spacing: no large positive tracking on body text; tightening only ~−0.2 to −0.4px in the 14–20px range; slightly positive below 12px.

## Icons & symbols

**Principles**
- An interface icon expresses a single concept people recognize instantly; excess detail confuses. Familiar metaphors tied directly to the action win — recognition beats decoding.
- All icons in an app must feel like one family: consistent size, detail level, stroke weight, perspective. Visually heavy icons may need dimension tweaks to *appear* the same size as lighter ones — perceived consistency beats geometric equality.
- Size and weight icons *relative to the type system*, not as arbitrary pixel values: mismatched icon/text weight reads as unintended hierarchy; matched weight keeps neither stealing emphasis. (Apple's symbols ship 9 weights mapped 1:1 to font weights and 3 scales relative to cap height for exactly this reason.)
- Optical centering beats geometric centering: asymmetric glyphs (download arrow, play) look misplaced when geometrically centered — bake the optical offset into the asset's padding so containers can center it geometrically.
- Variants are a grammar users learn: outline = default/toolbar (resembles text), fill = selected/emphasis, slash = unavailable, enclosed shapes = legibility at tiny sizes. Use the grammar consistently.
- Build hierarchy inside a glyph or icon stack with opacity tiers of one color, not extra hues; reserve color for semantics (red = destructive/loss, green = success/nature) so the signal stays strong.
- Icon animation exists to communicate, not decorate: bounce = action occurred, pulse/variable-fill = ongoing activity/progress, replace = state change, wiggle = attention.
- Icons must work for everyone: gender-neutral figures, culture-portable metaphors, mirrored/localized glyphs for RTL, and accessible names for screen readers.

**Specs**
- Icons must remain recognizable down to 16×16px; simplify or drop detail (e.g. grid lines) at small sizes.
- Document-icon center image = half the icon canvas (16×16px image inside a 32×32px icon).
- Breathing room: keep a margin of ~10% of the canvas; the glyph occupies ~80% (≈205×205px content in a 256×256px canvas).
- Use vector formats (SVG) so one asset scales everywhere; raster (PNG) requires one asset per scale factor.
- Symbol system reference: 9 weights (ultralight → black) mapped 1:1 to font weights; 3 scales (small, medium = default, large) relative to cap height; 4 rendering modes (monochrome, hierarchical, palette, multicolor); hierarchical/palette use up to 3 layer levels (primary/secondary/tertiary — with only 2 palette colors, secondary and tertiary share one); variable color maps layers to thresholds across 0–100% of a value.

**Do**
- Simplify to the recognizable minimum; use universal metaphors.
- Match stroke weight/detail level across the whole set and with adjacent text.
- Add asymmetric padding for optical centering where needed.
- Use outline variants next to text and in toolbars/lists; fill for selected states and small high-emphasis spots; a slash or equivalent for "unavailable"; enclosures at tiny sizes.
- Verify each symbol treatment against every background it appears on, in both themes.
- Localize characters inside icons; provide horizontally flipped variants for RTL where meaning requires.
- Provide accessible names for every custom icon.

**Don't**
- Overload icons with detail or text (text only when it IS the meaning, e.g. "B" for bold).
- Hand-build selected states for icons inside standard components that already restyle selection.
- Use culturally narrow or gendered imagery; don't depict hardware products (they date quickly).
- Use variable-color/progress fills to fake depth — that's opacity hierarchy's job.
- Pile on animations — each needs a discrete communicative purpose.
- Recreate common variants (badges, enclosures) by hand when the icon system provides composable ones.
- Use platform-trademarked symbols in logos/app icons.

**Web review checks**
- [ ] All icons come from one set (e.g. lucide) or, if mixed, share stroke width, corner style, detail level, and optical size.
- [ ] Icon stroke weight visually matches adjacent label font-weight (e.g. 1.5–2px strokes with 400–500 weight text); no icon looks bolder/lighter than its label.
- [ ] Icons are SVG (inline or sprite), not raster PNGs, so they stay crisp at all DPRs and zoom levels.
- [ ] Icon size ties to the type scale (em-based or tokenized sizes paired with text sizes), not scattered hard-coded px.
- [ ] Asymmetric icons (send, download, play) are optically centered in their buttons — inspect visually, not just `margin: auto`.
- [ ] Every icon-only button has an accessible name (`aria-label` or visually hidden text); decorative icons have `aria-hidden="true"`.
- [ ] Selected vs. unselected uses one consistent grammar app-wide (filled vs. outline, or accent vs. muted); selection in nav/tabs driven by one mechanism, not per-icon bespoke styling.
- [ ] Disabled/unavailable actions visually distinct via a consistent treatment (opacity/slash/muted), not just non-functional.
- [ ] Depth within composite glyphs uses opacity tiers of one color; semantic colors reserved for meaning (red = destructive only, green = success only).
- [ ] Icon colors use theme tokens/`currentColor` so they adapt to dark mode; no hard-coded hex on icons.
- [ ] Icons with Latin characters or directional arrows mirror/localize under `dir="rtl"` where meaning requires.
- [ ] Any animated icon (spinner, pulsing dot, typing indicator) maps to a real ongoing activity or state change and stops when it ends.

## Images

**Principles**
- CSS px abstracts device pixel density; raster assets must be supplied at the densities you support or they render blurry on high-DPI displays.
- Design vectors on a whole-number grid at 1x: integer control points stay crisp at 2x/3x because those are integer multiples; off-grid points produce fuzzy edges at every density.
- Color management is correctness: embed color profiles so colors render as intended across displays.
- What looks fine in the design tool can be pixelated, stretched, or compressed on real devices — testing at real resolutions/DPRs is a required step.
- Transparency costs bytes: if an image always sits on one known solid background, bake the background in — but keep transparency in template-style images the theme must tint or show through.

**Specs**
- Scale factors: @1x = 1:1 pixel:point, @2x = 2:1, @3x = 3:1; supply each raster asset at every factor you support (web: 1x/2x via `srcset`/DPR-aware serving).
- Vector art needs only one asset; rasters need one per density.
- (Layered-image origin, transferable) Composite/layered images: 2–5 layers with an opaque background layer — the portable rule is keep text in the foreground layer for clarity.

**Do**
- Prefer SVG for UI artwork; raster only for photographic content.
- Provide 2x (and 3x where relevant) raster assets; align vector points to whole pixels at base size.
- Use a consistent color profile (sRGB baseline for web) across assets.
- Test images at multiple DPRs and zoom levels on real devices.

**Don't**
- Ship only 1x rasters and let the browser upscale.
- Keep alpha channels in images that always sit on a known solid background (wasted bytes), except template images that get tinted.
- Let important content sit where containers may crop or mask it.

**Web review checks**
- [ ] Raster images (avatars, attachments, logos) use `srcset`/`image-set` or are served at ≥ 2x their CSS size so they're sharp on HiDPI displays.
- [ ] UI artwork (empty states, illustrations, icons) is SVG, not PNG/JPG.
- [ ] `<img>` elements declare width/height (or `aspect-ratio`) to prevent layout shift, and use `object-fit` rather than stretching (no distorted avatars).
- [ ] Images appearing in both themes are checked in dark mode — white-background PNGs/screenshots get a border or container so they don't glare; transparent logos remain visible on dark surfaces.
- [ ] User-uploaded images are constrained (max dimensions, crop strategy) so essential content isn't clipped by fixed-size containers.
- [ ] All exported assets are sRGB; no wide-gamut assets rendering off-color in untagged contexts.

## Motion

**Principles**
- Motion conveys status, provides feedback, and instructs — never exists for its own sake. Gratuitous animation distracts and can cause physical discomfort; every animation must answer "what does this communicate?"
- Motion must be optional: vestibular disorders and reduced-motion settings mean it can never be the *only* channel for important information — pair it with static/text alternatives.
- Feedback motion must match the user's gesture and mental model: a view revealed by sliding down should dismiss by sliding up. Spatially inconsistent motion disorients.
- Brief, precise feedback beats prominent animation. Avoid attention-demanding motion on frequent interactions — the cost is paid on every repetition.
- Never make people wait on an animation: motion must be cancelable/interruptible, especially anything experienced more than once.
- Large moving surfaces feel like the environment moving: reduce contrast/translucency of large animated elements; prefer fades over movement when relocating an element whose path carries no meaning.

**Specs**
- Hold a consistent 60fps for animations (games guidance: 30–60fps sustained); web means animating `transform`/`opacity` only.
- Avoid sustained oscillation around 0.2 Hz (one cycle per ~5s) — people are physiologically sensitive to it; if oscillating, keep amplitude low. Valid vestibular guidance for any large animated surface.
- Transitions on frequent interactions: ≤ ~200ms or absent.

**Do**
- Give every custom animation a communicative purpose (state change, feedback, progress).
- Keep feedback animations brief and tied precisely to the triggering action.
- Honor reduced-motion preferences; supply non-motion equivalents for information carried by animation.
- Use fades instead of positional movement when relocating elements where the path carries no meaning.
- Make animations interruptible — user input never blocked while something animates.

**Don't**
- Animate frequent interactions with attention-demanding motion.
- Force users to wait for an animation to finish — ever, and especially not repeatedly.
- Rely on motion as the sole signal for anything important.
- Run sustained low-frequency pulsing/bobbing (~0.2 Hz) on large or peripheral elements.

**Web review checks**
- [ ] `prefers-reduced-motion: reduce` (media query or JS check) disables/replaces non-essential transitions app-wide; verify by toggling the OS setting.
- [ ] No information conveyed by animation alone — e.g. "message sending" also shows a static state (icon/label), not just a pulse.
- [ ] Enter/exit motion is spatially symmetric: panels sliding in from the right slide out to the right; modals scaling up scale down.
- [ ] Animations run on `transform`/`opacity` (compositor-friendly), not `top/left/width/height`, and hold 60fps during streaming/typing (DevTools performance).
- [ ] Frequent interactions (hover on list items, sending, switching chats) have no slow or attention-grabbing animation; transitions ≤ ~200ms or absent.
- [ ] Nothing blocks input while animating — users can type, click, navigate mid-transition; skeleton/loading animations don't gate interaction with already-loaded content.
- [ ] No infinite pulsing/bobbing loops on large surfaces or in the visual periphery (sidebar-wide shimmer); loading pulses stop when loading completes.

## Writing & tone

**Principles**
- Words are part of the UI: a defined voice (consistent vocabulary reflecting the app's values) plus situational tone (serious for errors/payments, light for celebrations) makes the product cohesive and trustworthy.
- Clarity beats cleverness: every word must earn its place; plain verbs ("Send") beat cute labels ("Let's do it!") because users navigate by scanning action words.
- Consistent language patterns build familiarity: one capitalization style per UI element type, one flow vocabulary ("Get Started" → "Continue"/"Next" → "Done"), the same term for the same concept everywhere.
- Errors are the user's problem to solve, not their fault: place the message next to the problem, say what to do, never blame, never fake-apologize ("oops!"), never emit non-information ("Invalid name"). If words alone can't fix a common error, redesign the interaction.
- Empty states are onboarding: a blank screen must say what it's for and give a next action. Never put crucial info only there — empty states disappear.

**Specs** — none. ("Choose a password with at least 8 characters" is an example of good error copy, not a rule.)

**Do**
- Label buttons and links with active-voice verbs; make link text descriptive ("Learn more about X") — this also serves screen-reader users.
- Put the most important information first on each screen; split multi-idea text across steps.
- Pick one capitalization convention per element type (e.g. sentence case for all headlines) and apply it app-wide.
- Describe what a setting does when ON; let users infer OFF. Link directly to a setting rather than describing its location.
- Give text inputs clear labels plus hint/placeholder examples ("name@example.com"); show validation errors inline next to the field, phrased as instructions ("Use only letters for your name").
- Write plainly for localization and accessibility: no jargon, no gendered terms.

**Don't**
- Use "Click here" links or vague labels.
- Use "we" ("We're having trouble…") — prefer agentless clarity ("Unable to load content").
- Overuse possessives ("Favorites", not "Your Favorites"); never mix my/your perspectives.
- Scold, blame, or add insincere interjections ("oops!", "uh-oh") in errors.
- Say "click" for touch contexts or "tap" for pointer contexts — match the input verb to the device.
- Ship an empty state with no next action.

**Web review checks**
- [ ] Every button/link label is a verb or verb phrase ("Send", "Create workspace"); no "Click here", vagueness, or jokey labels on destructive/serious actions.
- [ ] Multi-step flows use consistent progression labels (one of Continue/Next throughout, "Done" at the end) — audit modals and wizards for mixed vocabulary.
- [ ] One capitalization style per component type app-wide; grep UI strings for mixed Title Case / sentence case within the same component family.
- [ ] Error messages state the fix, sit adjacent to the failing field/control, and contain no "we", "oops", or bare "Invalid X" — audit form validation and toast copy.
- [ ] Empty states (no conversations, no results, empty panel) explain the purpose and include an actionable button or link, not just "No data".
- [ ] Settings toggles labeled by what ON does, with a one-line description only when needed; navigation to a setting is a direct link, not prose directions.
- [ ] Text inputs have visible labels plus format hints where format matters; a placeholder is never the only label.
- [ ] Copy avoids unnecessary possessives and jargon; the same feature has the same name in nav, headings, and messages (build a term list and check it).

## Accessibility

**Principles**
- An accessible interface is **intuitive** (familiar, consistent interactions), **perceivable** (never relies on a single sense/channel), and **adaptable** (respects system settings and personalization). It also helps everyone in bad lighting, noisy rooms, or one-handed use.
- Redundant encoding is the core pattern: color → also shape/icon/text; audio → also captions/visual cues; gesture → also a visible button. People who can't use one channel must still get everything.
- Minimizing complexity benefits everyone: simple consistent interactions, no auto-dismissing UI on timers as the only mechanism, explicit dismissal actions, user control over motion and autoplaying media.
- System/browser settings are the contract: respond to increased contrast, reduced motion, text-size changes, and light/dark appearance instead of fighting them. Semantic colors carry accessible variants automatically.
- Assistive tech (screen readers, voice control, switch/keyboard-only input) all depend on correct element labels — a well-labeled interface makes every one of them work at once.

**Specs**
- Text must be enlargeable to at least 200% (page must remain usable at 200% browser zoom / doubled root font size). (Watch-class exception: 140% — not web-relevant.)
- Contrast: WCAG AA — 4.5:1 for regular text (up to ~17px), 3:1 for large text (≥18px, or bold ≥14px). Must hold in BOTH light and dark themes.
- Spacing: ~12px padding around controls with a bezel (visible border/background); ~24px padding around the visible edges of bezel-less elements (bare icons, plain-text buttons).
- Minimum control size: 44×44px hit area (cross-platform touch baseline).
- Hard-to-recover actions (e.g. deleting a file): confirm twice; simplified/assisted workflows: one interaction per screen.
- If default contrast falls short, provide a higher-contrast scheme under `prefers-contrast: more`.

**Do**
- Support larger text sizes and use recommended default type sizes; size thin-weight fonts larger than default to keep them legible.
- Prefer semantic colors that adapt to light/dark and contrast preferences.
- Convey state and function with shapes/icons/text in addition to color (especially red-green and blue-orange pairs).
- Pair audio cues (success chime, error sound) with visual equivalents; provide captions/subtitles/transcripts for audio and video.
- Use the simplest gesture for frequent interactions, always with an onscreen alternative (swipe-to-dismiss must also have a visible close button).
- Make all core functionality keyboard-operable; keep browser/system shortcuts intact; label elements so screen readers and voice control can target them.
- Dismiss views on explicit user action. Under reduced motion: tighten springs (less bounce), tie animation to the user's gesture, replace x/y/z movement with fades, avoid animating blurs and z-depth changes.
- Provide visible start/stop controls for any audio/video; consider a global autoplay opt-out.

**Don't**
- Rely on color alone to differentiate state or function.
- Communicate crucial information through audio alone.
- Require complex, custom, or multi-finger gestures for frequent actions, or make a gesture the only path to a feature.
- Auto-dismiss views/toasts on a timer as the only mechanism — people who process slowly or use assistive tech need more time.
- Override system-defined keyboard shortcuts.
- Autoplay audio/video without controls; use fast-moving/blinking animation in excess (dizziness, epilepsy risk).
- Let contrast pass in only one theme.

**Web review checks**
- [ ] Text/icon-vs-background contrast ≥ 4.5:1 for body/UI text and ≥ 3:1 for large text (≥18px or ≥14px bold) — verified in BOTH themes (message bubbles, sidebar items, muted/secondary text, placeholders are the common failures).
- [ ] Every state or category distinction (online/offline dots, error vs. success, diff added/removed, unread indicators, chart series) has a non-color cue: icon, label, shape, or weight change.
- [ ] Interactive elements have ≥ 44×44px hit area even when the visual glyph is smaller; sibling controls have adequate gaps (~12px around bordered controls, ~24px effective spacing around bare icon buttons).
- [ ] Layout survives 200% browser zoom / doubled root font size without clipped text, overlapping controls, or unreachable content (rem-based sizing, no fixed-height text containers).
- [ ] Full keyboard path: every action reachable by Tab/Shift-Tab/Enter/Escape with a visible focus indicator; app doesn't hijack browser/system shortcuts; custom widgets (menus, dialogs, sidebar) trap/restore focus correctly.
- [ ] Nothing auto-dismisses as the sole path: timed toasts also persist somewhere or can be paused; every swipe/drag/hover-only interaction has a click/button equivalent.
- [ ] Animations respect `prefers-reduced-motion: reduce` — slide/zoom/scale replaced with fades or nothing; no autoplaying looping motion; media never autoplays without visible stop controls.
- [ ] All interactive elements have accessible names (aria-label / visible text) so screen readers and voice control can address them; icon-only buttons are the first audit target.
- [ ] `prefers-contrast: more` honored (or an in-app high-contrast option exists) if any default color pair sits below AA.

## Quick-scan spec table

| Spec | Value | Topic |
|---|---|---|
| Primary-content inset from viewport top/bottom | 60px | Layout |
| Primary-content inset from viewport sides | 80px | Layout |
| Min center-to-center spacing, adjacent interactive controls | 60px | Layout |
| Size classes | 2 (regular, compact) | Layout |
| Window widths to test | 1/2, 1/3, 1/4 of display | Layout |
| Dimming scrim over bright content under translucent chrome | ~35% opacity dark | Materials |
| Standard material thicknesses | 4 (ultra-thin, thin, regular, thick) | Materials |
| Foreground-on-material contrast tiers | 4 (default > secondary > tertiary > quaternary) | Materials |
| Glass variants | 2 (regular, clear) | Materials |
| Variants per custom color (min) | 2 (light + dark) | Color |
| Variants per custom color (with increased-contrast) | 4 | Color |
| Background hierarchy levels | 3 (primary, secondary, tertiary) | Color |
| Wide-gamut asset format | Display P3, 16 bits/channel, PNG + sRGB fallback | Color |
| Min contrast, all appearances | 4.5:1 | Dark mode / Accessibility |
| Target contrast, custom pairs / small text | 7:1 | Dark mode |
| Dark background sets | 2 (base, elevated; elevated brighter) | Dark mode |
| Body text default | 17px (iOS) / 13px (macOS) | Typography |
| Body text minimum | 11px (iOS) / 10px (macOS); web floor ~13px UI labels, never < 10–11px | Typography |
| macOS Large Title | 26/32, Regular → Bold | Typography |
| macOS Title 1 | 22/26, Regular → Bold | Typography |
| macOS Title 2 | 17/22, Regular → Bold | Typography |
| macOS Title 3 | 15/20, Regular → Semibold | Typography |
| macOS Headline | 13/16, Bold → Heavy | Typography |
| macOS Body | 13/16, Regular → Semibold | Typography |
| macOS Callout | 12/15, Regular → Semibold | Typography |
| macOS Subheadline | 11/14, Regular → Semibold | Typography |
| macOS Footnote | 10/13, Regular → Semibold | Typography |
| macOS Caption 1 | 10/13, Regular → Medium | Typography |
| macOS Caption 2 | 10/13, Medium → Semibold | Typography |
| iOS Large Title (Large setting) | 34/41 | Typography |
| iOS Title 1 | 28/34 | Typography |
| iOS Title 2 | 22/28 | Typography |
| iOS Title 3 | 20/25 | Typography |
| iOS Headline | 17/22 Semibold | Typography |
| iOS Body | 17/22 | Typography |
| iOS Callout | 16/21 | Typography |
| iOS Subhead | 15/20 | Typography |
| iOS Footnote | 13/18 | Typography |
| iOS Caption 1 | 12/16 | Typography |
| iOS Caption 2 | 11/13 | Typography |
| Line-height ratio, body-range text | ~1.2–1.35× (review tolerance 1.2–1.45) | Typography |
| Tight leading forbidden at | 3+ lines | Typography |
| Text-scaling range to survive | body 14px → 53px (≈2–3× default) | Typography |
| Min font weight | 400 (avoid Ultralight/Thin/Light) | Typography |
| Tracking at 10px | +0.12px | Typography |
| Tracking at 12px | 0 | Typography |
| Tracking at 16px | −0.31px | Typography |
| Tracking at 17px | −0.43px | Typography |
| Tracking negative range | 13–23px (positive again 24px+) | Typography |
| Icon recognizable down to | 16×16px | Icons |
| Document-icon center image | 1/2 of canvas (16px in 32px) | Icons |
| Icon canvas margin / glyph area | ~10% margin, ~80% glyph (≈205×205 in 256×256) | Icons |
| Symbol weights | 9 (mapped 1:1 to font weights) | Icons |
| Symbol scales | 3 (small, medium default, large; relative to cap height) | Icons |
| Symbol rendering modes | 4 (monochrome, hierarchical, palette, multicolor) | Icons |
| Hierarchical/palette layer levels | up to 3 (2 palette colors → secondary+tertiary share) | Icons |
| Variable-color value range | 0–100% | Icons |
| Raster scale factors | @1x, @2x, @3x (web: ≥2x via srcset) | Images |
| Layered composite images | 2–5 layers, opaque background, text in foreground | Images |
| Animation frame rate | 60fps (games: sustained 30–60fps) | Motion |
| Oscillation frequency to avoid | ~0.2 Hz (1 cycle per ~5s) | Motion |
| Max transition on frequent interactions | ~200ms | Motion |
| Text enlargeable to | 200% (page usable at 200% zoom) | Accessibility |
| Contrast, regular text (≤ ~17px) | 4.5:1 (WCAG AA) | Accessibility |
| Contrast, large text (≥18px or bold ≥14px) | 3:1 | Accessibility |
| Padding around bezeled controls | ~12px | Accessibility |
| Padding around bezel-less controls | ~24px | Accessibility |
| Min hit area | 44×44px | Accessibility |
| Hard-to-recover action confirmation | 2 confirmations | Accessibility |
| Assisted/simple workflow density | 1 interaction per screen | Accessibility |
