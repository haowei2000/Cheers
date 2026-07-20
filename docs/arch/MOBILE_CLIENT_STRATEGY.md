# Mobile Client Strategy

> **Language**: English | [中文](MOBILE_CLIENT_STRATEGY.zh-CN.md)
>
> **Status**: Accepted · **Date**: 2026-07-06 · **Revised**: 2026-07-19 · **Owner**: haowei

Decision record for how Cheers ships to phones: how the three mobile branches
land, and where native vs. cross-platform goes from here.

> ## ⚠️ Revised 2026-07-19 — Expo is dropped; native Swift is the mobile client
>
> **Decision 2 below (consolidate onto Expo) is superseded.** The new direction:
>
> 1. **iOS = native SwiftUI (`apps/ios`), and it is a long-term client, not a
>    transitional one.** All mobile investment goes here. The roadmap item "retire
>    `apps/ios` + `apps/android` once Expo reaches parity" is void.
> 2. **Android = frozen.** `apps/android` (Kotlin + Compose) stays at its current
>    functionality and receives fixes only — no new features. Android users are served
>    by the PWA / mobile web.
> 3. **`apps/mobile/` (Expo) will not be created.**
>
> ### Why the 2026-07-06 decision did not survive
>
> - **Revealed preference.** In the 13 days after it was accepted, the Expo scaffold
>   (roadmap step 3) was never started — there is still zero Expo/React Native code in
>   the repo — while `apps/ios` received three commits, including touch-input, scroll,
>   and channel-management work. The team kept choosing native; the document did not
>   describe what was actually happening.
> - **The native app has already out-run the plan.** The push design was revised on
>   2026-07-18 to direct APNs + an official relay *precisely because* the shipping
>   client is the native SwiftUI app and the store binary's credentials are ours (see
>   [MOBILE_APP_DESIGN.md](MOBILE_APP_DESIGN.md) §5.1). An Expo rewrite would have to
>   re-earn features that already work.
> - **The cost argument changed shape.** The original case against native was 2×
>   maintenance for Swift **and** Kotlin. Freezing Android removes that multiplier
>   without a rewrite: one native client plus the PWA is a smaller surface than either
>   two native clients or a from-scratch Expo port.
>
> ### What this costs us — accepted knowingly
>
> - **No native Android feature velocity.** Android users get the PWA, which lags the
>   native experience (no share sheet, weaker notification affordances). If that becomes
>   unacceptable, the decision to revisit is *Android's client*, not iOS's.
> - **No React-team leverage on mobile.** Mobile work needs Swift, which is a narrower
>   skill pool on this team than TypeScript. This is the real, ongoing price.
> - **`MOBILE_APP_DESIGN.md` is partly stale.** Its Expo-shaped sections (expo-router,
>   expo-secure-store, the `apps/mobile/` tree) describe a codebase that will not exist;
>   its product/UX and push sections remain valid. That doc carries its own banner.
>
> The 2026-07-06 analysis is kept below unedited — the branch-landing decision (Decision
> 1) was carried out and is still accurate history.

## Context

Three mobile branches were built in parallel (see the 2026-07-04 build note) and
pushed to `origin`. All target the same Rust gateway (`server/`) — REST +
the `/ws` frame protocol (`auth → auth_ok → subscribe → subscribed`, then
`message`/`message_stream`/`message_done`/`presence`).

| Branch | What | Lands in | Merges into `develop` |
| --- | --- | --- | --- |
| `feat/android-app` | Native Android — Kotlin + Jetpack Compose (Material 3), ~4130 LoC | `apps/android/` | **Clean** (additive; no overlap) |
| `feat/ios-app` | Native iOS — SwiftUI, zero deps, ~3373 LoC | `apps/ios/` | **Clean** (additive; no overlap) |
| `feat/mobile-web-adapt` | Responsive pass on the React web app, +394/−91 | `frontend/` | **6 conflicts** (develop moved on) |

Verified with `git merge-tree`: the two native branches are purely additive
(`develop` has no `apps/` yet) and do not overlap each other or the frontend.
`feat/mobile-web-adapt` conflicts on `package.json`, `package-lock.json`,
`ChannelView.tsx`, `ChatLayout.tsx`, `Sidebar.tsx`, `SettingsPage.tsx` — because
`develop` advanced (e.g. #86 folded DMs into the personal workspace, touching
`Sidebar`/`ChatLayout`).

## Decision

**1 — Land all three branches now, in this order.**

1. `feat/android-app` → `develop` (clean, independent, additive)
2. `feat/ios-app` → `develop` (clean, independent, additive)
3. `feat/mobile-web-adapt` → `develop` — resolve the 6 conflicts:
   - `package.json` / `package-lock.json`: keep `develop`'s side. The branch only
     added `@types/node ^22`; `develop` already carries `^26`, so drop the
     downgrade.
   - the four `.tsx`: manual — re-apply the mobile-responsive changes on top of
     develop's newer logic. Then `typecheck` + `build` + phone-width smoke.

Native branches land first so they are immune to whatever the web merge touches,
and `develop` stops drifting from three long-lived branches.

**2 — (SUPERSEDED 2026-07-19 — see the banner at the top; retained for the record)
Strategic direction: consolidate mobile onto one Expo (React Native)
codebase; keep the two native branches as the verified API/protocol reference.**

Rationale — the team is React/TypeScript-centric and small. Maintaining Swift +
Kotlin as two separate native codebases is 2× the surface for a chat app. Expo:

- one TS/React codebase for **both** iOS and Android;
- reuses the team's React mental model and the `frontend/src/types` + API/WS logic
  (the shared layer is logic, **not** UI — RN uses `View`/`Text`, not the DOM;
  Tailwind → NativeWind);
- the custom `/ws` frame protocol runs over RN's standard `WebSocket` unchanged;
- EAS Build (cloud `.ipa`/`.apk`) and EAS Update (OTA JS pushes) speed iteration.

The native branches are **not** wasted: their DTO↔serde mapping, WS reconnect
logic (backoff + `?since_seq=` gap-heal), and design tokens are the tested
reference an Expo rewrite copies from.

## Consequences

- After step 1, Cheers has **four clients**: desktop web, mobile web, native iOS,
  native Android — all on one gateway. ~~This is transitional, not the end state.~~
  **(2026-07-19)** This *is* the end state, minus the Expo consolidation: desktop web,
  PWA/mobile web, native iOS (active), native Android (frozen).
- ~~Native apps ship value immediately; Expo replaces them over time. When Expo
  reaches parity, `apps/ios` + `apps/android` are deleted.~~ **(2026-07-19)** Void.
  `apps/ios` is the long-term mobile client and is invested in accordingly; `apps/android`
  is frozen but kept (fixes only).
- **Frontend cleanups** surfaced during the review, tracked separately from this
  decision but relevant to the mobile-web line:
  - React Query is configured but **unused** (0 `useQuery`, 19 files hand-roll
    `useEffect` + `apiJson`) — highest-value refactor, no bundle cost.
  - Near-zero test coverage (1 test file in the whole frontend).
  - `highlight.js` ships full (969 KB) — switch to `lib/core` + registered langs.
  - Oversized components (`RemoteWorkspaceDialog.tsx` 1309 LoC).

## Alternatives considered

- **Stay dual-native (keep Swift + Kotlin as the product).** Best platform feel,
  but 2× ongoing maintenance in two languages for a small React-first team.
  Rejected as the default; revisit if native-only features demand it.
- **Mobile web (PWA) only, no app.** Cheapest; ship `feat/mobile-web-adapt` and
  stop. Kept as the immediate step, but a real app is wanted, so not the end.
- **Don't merge the native branches (Expo replaces them, so why land them).**
  Rejected: they are done, clean, and ship value now; Expo is a multi-week effort,
  and landing them costs ~nothing to reverse later.

## Roadmap

1. ✅ Decision recorded (this doc).
2. ✅ Merge the three branches into `develop` (order above).
3. ~~Scaffold `apps/mobile/` with Expo~~ — **cancelled 2026-07-19, never started.**
4. ~~Reach feature parity, then retire `apps/ios` + `apps/android`.~~ — **void.**
5. In parallel, migrate the web data layer to React Query (benefits mobile web too).

**Revised roadmap (2026-07-19)**

1. `apps/ios` is the mobile client — feature work continues there (next up: the
   Workbench, currently a placeholder sheet).
2. `apps/android` frozen: fixes only, no new features. Revisit only if Android demand
   makes the PWA gap unacceptable.
3. Prune the Expo-shaped sections of [MOBILE_APP_DESIGN.md](MOBILE_APP_DESIGN.md) as
   the native app supersedes them, rather than in one sweep.

## References

- [Architecture Overview](ARCHITECTURE_OVERVIEW.md)
- [Wire Protocol](WIRE_PROTOCOL.md) — the `/ws` frame protocol both native apps implement
- `apps/ios/README.md` — native iOS notes (DTO↔serde, reconnect, theming)
- 2026-07-04 build note (Obsidian) — how the three branches were built
