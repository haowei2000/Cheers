# Mobile App Design

> **Language**: English | [中文](MOBILE_APP_DESIGN.zh-CN.md)
>
> **Status**: Draft · **Date**: 2026-07-17 · **Revised**: 2026-07-19 · **Owner**: haowei

> ## ⚠️ Read first — the Expo parts of this document are superseded
>
> This design was written for an Expo (React Native) app at `apps/mobile/`. On
> **2026-07-19** that direction was dropped: the mobile client is the **native SwiftUI
> app at `apps/ios`**, and `apps/mobile/` will not be created. See
> [MOBILE_CLIENT_STRATEGY.md](MOBILE_CLIENT_STRATEGY.md).
>
> | Section | Status |
> |---|---|
> | Product / UX design, screens, information architecture | **Valid** — platform-agnostic, implement in SwiftUI |
> | §5 Push notifications | **Valid** — already revised 2026-07-18 to direct APNs + relay |
> | Codebase table, `apps/mobile/` tree, expo-router, expo-secure-store, NativeWind | **Superseded** — read as "the shape the native app must provide", not as instructions |
>
> Expo-specific mechanics are being replaced section by section as the native app
> catches up, rather than deleted in one sweep — the reasoning in them is still the
> reasoning the SwiftUI implementation has to answer.

Design for the Cheers mobile app. Originally written for a consolidated Expo
(React Native) codebase at `apps/mobile/`; the target is now the native SwiftUI
app at `apps/ios` (see the banner above). Covers product/UX design, app
architecture, and the push notification system (which requires new server work,
specified here and tracked as follow-ups).

Companion interactive prototype: [docs/design/mobile-app-prototype.html](../design/mobile-app-prototype.html)
(open in a browser — 8 key screens plus a light-mode variant).

## 1. Context & Goals

Cheers mobile is **not the web app squeezed onto a phone**. The web frontend
remains the workbench (files, diffs at depth, workbench panels, admin). The
phone is the **companion for humans supervising agents**:

1. **Approve/deny an agent's tool call from anywhere** — the killer use case.
   Your agent hits a permission gate while you're away from your desk; a
   time-sensitive push lets you review the command/diff and resolve it in
   seconds.
2. **Glanceable inbox → fast chat** — read conversations, nudge agents,
   answer DMs, accept invites.
3. **Fleet visibility** — what are my bots doing right now.

The native SwiftUI app (`apps/ios/`) validated the chat skeleton
(conversation list → chat → settings), the DTO↔serde mapping, the `/ws`
reconnect strategy, and a light/dark token mapping. This design keeps that
skeleton and adds the four missing pillars: approvals, workspace context,
fleet visibility, and management flows.

**Non-goals (v1)**: tablets/iPad layouts, offline outbox (failed sends show a
retry affordance instead), E2EE, the workbench/ViewBoard system, admin
consoles (link out to web).

## 2. Decision Summary

| Dimension | Decision | Rationale |
| --- | --- | --- |
| Codebase | Expo (React Native) at `apps/mobile/`, TypeScript | Accepted strategy; one codebase for iOS+Android; React team |
| Navigation model | Drawer-first (Claude-app style): Chats is the only home surface; the left drawer carries workspaces, channels, and the Activity / Agents / Friends / Settings entries — **no bottom tab bar** | One uncluttered chat surface; all navigation behind one edge swipe |
| Workspace switching | Left drawer on Chats (edge swipe / menu button): workspace strip on top, channel list below, function row at bottom | Telegram/Claude-app drawer pattern; replaces the web's rail; the flat "All" list stays home |
| Approvals on mobile | Inline compact card → root-level Approval bottom sheet | Radios don't fit a 360pt bubble; sheet is also the push deep-link target |
| Push transport | **Expo Push Service** behind a Rust `PushTransport` trait | Only approach where self-hosted gateways get push without APNs/FCM credentials |
| Push policy | Server always sends; foregrounded client suppresses display | Server-side "socket open" suppression would let a desktop tab eat phone pushes |
| Router | expo-router (file-based) | Deep links + push-tap routing nearly free; typed routes |
| State | Zustand (session/WS/UI) + TanStack Query (all REST reads) | The target architecture the web is migrating toward; mobile is the reference impl |
| Styling | NativeWind v4, semantic tokens from a shared Tailwind preset | Ports `frontend/DESIGN.md` zinc/indigo system; light mode via `Theme.swift` mapping |
| Code sharing | Extract `packages/core` (DTOs + REST client + WS state machine) | Share logic, not UI (strategy doc); no React/DOM in the package |
| Token storage | expo-secure-store, `AFTER_FIRST_UNLOCK` | Keychain/Keystore; background notification actions must authenticate |
| Offline cache | TanStack Query persister on MMKV (lists + last 50 msgs/channel) | Instant cold start; WatermelonDB-style sync rejected as overweight |

## 3. App Architecture

```
apps/mobile/                  # Expo app (expo-router)
├── app/                      # file-based routes
│   ├── (auth)/login.tsx
│   ├── (tabs)/
│   │   ├── chats/            # list + [channelId] chat + channel-info stack
│   │   ├── activity.tsx      # approval/invite inbox
│   │   ├── agents/           # fleet list + session detail + trace
│   │   └── you/              # profile, friends, appearance, notifications
│   └── _layout.tsx           # auth gate, theme provider, sheet host
├── components/               # RN components (bubbles, cards, sheets, chips)
├── stores/                   # Zustand: auth/session, socket, UI
└── tailwind.config.ts        # consumes the shared token preset

packages/core/                # NEW — framework-agnostic TS (no React, no DOM)
├── types.ts                  # DTOs ported from frontend/src/types/index.ts
├── api.ts                    # REST client (fetch-based, injectable base URL + token)
└── socket.ts                 # /ws protocol state machine (see §4)
```

- **expo-router** gives push-tap and deep-link routing via its linking config;
  every push payload carries a route (§5.4).
- **TanStack Query owns all REST reads** (conversation list, messages pages,
  fleet, approvals). WS frames patch the cache: `message`/`message_done` →
  `setQueryData` append/replace; coarse events (`member_updated`,
  `permission_*`) → targeted invalidation. No hand-rolled
  `useEffect + fetch` (the web's known debt — the strategy doc lists its React
  Query migration as a parallel track; `packages/core` is where the shared
  query key + fetcher conventions live).
- **Zustand** holds what Query must not: auth/session state, socket status,
  draft composer text per channel, UI sheet state.
- **NativeWind v4** with semantic tokens only (`bg-app`, `bg-surface`,
  `bg-raised`, `text-primary`, `text-secondary`, `accent`, …) — no raw
  `zinc-*` literals in components, so light mode is a token swap, not a
  component audit (§7.4).

## 4. Realtime & Data Layer

The app implements [WIRE_PROTOCOL.md](WIRE_PROTOCOL.md) unchanged — RN's
standard `WebSocket` carries the frame protocol as-is.

**`packages/core/socket.ts`** is a state machine ported from the validated
Swift implementation (`apps/ios/Sources/Networking/ChatSocket.swift`):

- connect → first-frame `{type:"auth", token}` → `auth_ok` → `subscribe` per
  visible channel; user-scope frames arrive automatically after `auth_ok`.
- Streaming: `message_stream` deltas dedup by max-`seq` per `msg_id`;
  `message_done` is terminal and self-heals dropped deltas.
- Reconnect: exponential backoff 1s → 30s (max 10 tries), then automatic
  resubscribe and **REST gap-heal** (`?since_seq=` / `after=` cursor per
  [MESSAGE_PAGINATION.md](MESSAGE_PAGINATION.md)) — the realtime layer stays a
  dumb pipe; catch-up is REST.
- `auth_err` or REST 401 → session-expired state (re-login; no refresh token
  today, see §6).

**Mobile WS lifecycle is AppState-driven** — this is the main difference from
the web:

| AppState | Behavior |
| --- | --- |
| `active` | connect, auth, subscribe user scope + the visible channel |
| `background` | close the socket **immediately and gracefully** — don't fight the OS's ~30s socket kill; push covers the gap |
| back to `active` | reconnect + REST gap-heal for the visible channel + refetch Activity badge |

**Offline cache**: TanStack Query persister on MMKV. Persisted: workspace +
channel list, Activity inbox, last 50 messages of recently-viewed channels.
Cold start renders instantly from cache, then revalidates. Failed sends keep
the message in the list with a retry affordance (no outbox/queue in v1).

**Pagination**: `GET /channels/:id/messages?before=<oldest>` on top-reach,
`limit` ≤ 200, exactly as web/iOS.

## 5. Push Notifications

The gateway has **no push infrastructure today** — "notifications" are an
in-app invite inbox (`GET /api/v1/notifications`) plus best-effort user-scope
WS frames emitted via `push_notification()` in `server/src/api/notifications.rs`.
This section specifies the v1 push system. Server work is a follow-up PR
tracked in the roadmap (§8), not part of the app scaffold.

### 5.1 Transport: direct APNs + official relay

> **Revised 2026-07-18** — the client consolidated on the native SwiftUI app
> (not Expo), so the store binary's credentials are ours: the gateway ships a
> `PushTransport` seam with two implementations. **Direct APNs** (ES256
> provider token over HTTP/2; `APNS_KEY_P8`/`APNS_KEY_ID`/`APNS_TEAM_ID`)
> for deployments that own the app credentials, and a **relay client**
> (`PUSH_RELAY_URL`/`PUSH_RELAY_KEY`) so a self-hosted gateway — which cannot
> obtain APNs credentials for a bundle id it doesn't own — POSTs pushes to an
> official Cheers relay holding the key. The relay service itself is a
> separate deployable; its API contract is defined by the gateway's relay
> client (`server/src/notify/relay.rs`). Unconfigured = push disabled,
> in-app WS delivery unaffected. The Expo Push rationale below is retained
> for the record.

#### (superseded) Expo Push Service rationale

The Rust server sends pushes by POSTing to Expo's push API
(`https://exp.host/--/api/v2/push/send`), batched 100 per request, behind a
trait:

```rust
// server/src/notify/transport.rs (new)
trait PushTransport {
    async fn send(&self, batch: &[PushMessage]) -> Result<Vec<PushReceiptId>>;
}
```

**Why Expo Push and not direct APNs/FCM**: platform push credentials (APNs
`.p8` key, FCM service account) are bound to the **app binary's** bundle ID
and belong to whoever signs and ships the store app — a self-hoster running
their own gateway cannot obtain them. With Expo Push, the store-distributed
app carries the platform credentials via Expo's infrastructure, and *any*
gateway can deliver pushes with a plain HTTPS POST using the device's
`ExponentPushToken`. "Clone the repo → run the server → install the store app
→ point it at your server" works with push intact. Direct APNs/FCM remains a
future `PushTransport` impl for operators who build their own binaries.

**Payload privacy**: notification payloads transit Expo's servers, so the
server ships with **payload minimization ON by default**: pushes carry
`{type, channel_id, request_id?, deep_link}` plus generic-but-useful text
("Permission request from claude-code", "New message in #release") — never
message bodies or command contents. Full content is fetched by the app on
tap. A server config flag can relax this for operators who accept the
trade-off.

### 5.2 Server: `notify` service, devices, schema

**Seam**: a new `server/src/notify/` domain service — **not** an extension of
`Fanout` (`server/src/gateway/realtime/fanout.rs`), which stays the wire
protocol's dumb pipe.

- `NotificationEvent` — a typed enum (`PermissionRequest`, `DirectMessage`,
  `Mention`, `Invite`, `PermissionResolved`, …). Emit sites construct one of
  these instead of hand-rolling frames.
- `notify::dispatch(state, event)` does two things: (a) the existing
  `Fanout::broadcast_user` WS frame (behavior-preserving), and (b) evaluates
  the push policy (§5.3) → `PushTransport::send` per registered device.
  Sending is **fire-and-forget async** (spawned task) — never on the message
  hot path. Receipts are polled; `DeviceNotRegistered` prunes the token.
- Migration is cheap: `push_notification()` in `api/notifications.rs` is
  already the single helper behind all three invite emit sites
  (`api/workspaces.rs`, `api/channels.rs`); generalizing it into
  `notify::dispatch` converts the invite path for free. The
  `permission_request` emit in `gateway/ws/agent_bridge.rs` then routes
  through the same service.

**Device registration**:

- `POST /api/v1/users/me/devices` `{push_token, platform, device_name}` —
  idempotent upsert, unique on token.
- `DELETE /api/v1/users/me/devices/:token` — called on logout.
- New `user_devices` table: `(id, user_id, push_token unique, platform,
  device_name, created_at, last_seen_at)`. Rows are pruned on
  `DeviceNotRegistered` receipts and when the user's `token_version` bumps
  (a revoked session must stop receiving pushes).

### 5.3 Event taxonomy → push policy

| Event | Push? | Priority | Collapse key |
| --- | --- | --- | --- |
| `permission_request` | **Always** | High; iOS `interruptionLevel: timeSensitive`; category `acp-approval` | `request_id` |
| DM message | Yes | Default | `channel_id` ("N new messages" replaces) |
| @mention in a channel | Yes | Default | `channel_id` |
| Workspace/channel invite | Yes | Default | `invite:<workspace_id>` |
| Regular channel message | **No** — unread badge only | — | — |
| `message_stream`, `bot_trace`, presence, read receipts | Never | — | — |

**Foreground suppression, not server suppression.** The server always sends
push-worthy events. Suppressing "when a socket is open" is wrong because
socket presence is per-user across all clients — an open desktop web tab
would swallow the phone push and kill the away-from-desk approval flow.
Instead the **foregrounded app suppresses display** (its live WS already
shows the event); a `read` event dismisses delivered notifications for that
channel by collapse key and recomputes the badge.

When a request is resolved elsewhere (`permission_resolve` /
`permission_cancel`), the server sends a follow-up push with the same
collapse key replacing the content ("Already resolved") — Expo exposes no
remote revocation, so replacement is the mechanism. Known limitation: a
device that is offline for both pushes may briefly show a stale approval
notification; tapping it lands on the resolved card.

### 5.4 Client: categories, actions, deep links, badge

- **Category `acp-approval`** carries **Approve / Reject action buttons**.
  The background notification-response handler reads the JWT from
  SecureStore (`AFTER_FIRST_UNLOCK`) and calls
  `POST /channels/:id/permissions/:req/resolve` directly — approving without
  launching the UI. Any failure (expired token, network, already-resolved)
  falls back to launching the app on the Approval sheet. The notification
  body never contains enough to approve blindly — the buttons are for
  requests the user already expects; "Review" (the tap) is the primary path.
- **Deep links**: `cheers://channel/:id?msg=<id>` and
  `cheers://approval/:channelId/:requestId`. Every push `data` payload
  carries the deep link; expo-router's linking config routes it. The
  Approval sheet is a root-level modal, so it can present over any screen.
- **Badge** = pending approvals + channels with unread DMs/mentions. The
  server includes the computed `badge` in each push; the client also
  recomputes locally on read. Badge drift is acceptable and corrected on next
  app open.

## 6. Auth & Security

- JWT (RS256, 24h, no refresh token) stored in **expo-secure-store** with
  `AFTER_FIRST_UNLOCK` accessibility — background approve actions must read
  it while the phone is locked-but-unlocked-once. Non-secret session fields
  (server URL, user id) in MMKV/AsyncStorage, mirroring the iOS app's
  Keychain/UserDefaults split.
- Server URL is a login-screen field (self-hosted-first, as `apps/ios`);
  `/api/v1` appended if missing, WS URL derived. HTTPS required for non-local
  hosts.
- REST 401 / WS `auth_err` → session-expired takeover over the login screen
  (mirrors the web's L-tier takeover). Logout calls `POST /auth/logout`
  (revokes server-side via `token_version`) **and**
  `DELETE /users/me/devices/:token`.
- **Known gap that must be fixed server-side**: the 24h token with no refresh
  mechanism breaks background approve actions daily and forces re-login. The
  design does not silently work around this. Required follow-up: a refresh
  token or a long-lived device-scoped token (scoped to
  notification-resolution endpoints at minimum), with `token_version`
  revocation semantics preserved. Tracked in §8.

## 7. UX & Information Architecture

### 7.1 Navigation

```
Root (auth gate)
├─ Login stack
└─ Chats (home) — conversation list → Chat → Channel info → Members/Files/Invites
   └─ left drawer (edge swipe / badged menu button) — the single navigation hub
      ├─ top:    workspace strip (All · Personal · <workspace> · +)
      ├─ middle: selected workspace's channels & DMs
      └─ bottom: Activity (inbox, badge) · Agents (fleet) · Friends ·
                 profile & settings · New chat
Root-level sheets: Approval · New chat · Session picker ·
                   Model picker · Forward picker · Attachment viewer
```

- **Chats is Telegram-model**: one flat list across all workspaces (each row
  carries a small workspace chip), DMs included — validated by `apps/ios`.
  Slack's workspace-first hierarchy adds a navigation level for the typical
  2–4 workspaces Cheers users have.
- **Activity ≠ Agents.** Activity answers "what needs *me*" (approvals
  first — it is the push landing surface); Agents answers "what are my bots
  *doing*" (observability). Merging them buries the approve action under
  monitoring chrome. Invites fold into Activity — one inbox, no separate
  notification bell.
- **Workspace switching — left drawer** (Telegram / Claude-app pattern): an
  **edge swipe from the left** on the Chats list (or tapping the menu
  button in the header) slides a drawer out over the list, the remaining
  sliver of content dimmed behind it. Three zones, top to bottom:
  1. **Workspace strip** — a horizontal row of workspace squares
     (`All · Personal · <workspace> · +`) with unread counts on the
     squares; the active workspace gets an accent ring. `+` adds or joins a
     workspace. Below the strip, the selected workspace's name, meta
     (channels · bots · members) and a settings gear.
  2. **Channel & DM list** of the selected workspace, with unread/mention
     badges — tapping a channel closes the drawer and opens that chat
     directly. Selecting `All` shows the flat cross-workspace inbox in the
     main list instead.
  3. **Navigation & settings** pinned at the bottom, kept compact: one
     chip row with the remaining top-level destinations (**Activity** with
     its pending badge, **Agents**, **Friends**), then a slim footer with
     the profile avatar, settings, and a prominent **New chat** button.
  There is **no bottom tab bar and no floating buttons** on the home
  screen — the drawer is the app's single navigation hub, replacing both
  the web rail and conventional mobile tabs. The main Chats list stays the
  flat cross-workspace inbox; the home screen's menu button carries the
  pending-approval badge so approvals stay visible without a tab bar.
- **Back model — hierarchy, not history.** The home chat is the root: its
  top-left button is the drawer menu and the left-edge swipe opens the
  drawer. Drawer destinations (Notifications, Fleet, Friends, Settings,
  Channel info) sit exactly **one level deep**: their back button — and the
  same left-edge swipe, which at depth means native swipe-back — returns
  straight to the home chat. **Back returns to the entry point**: a screen
  entered from the drawer pops back into the re-opened drawer (hub
  continuity — Settings → back → drawer → Fleet), while a screen entered
  from the chat's ⋯ menu pops back to the chat with no drawer. Switching
  conversations is **lateral** (it replaces the chat, leaving no back
  trail), and sheets are **modal** (swipe down to dismiss, landing where
  you were). Back never means "undo the last action".

### 7.2 Screen inventory

**Login** — server URL (collapsible "Advanced", dev default), username,
password. Session-expiry reuses this screen with a banner.

**Chats** — one compact row: badged circular menu button (opens the
drawer, §7.1) + search field. No title bar (drawer-first leaves nothing to
title), no tab bar, no floating compose button (New chat lives in the
drawer). Rows: avatar (shared hash
palette from `frontend/src/lib/format.ts`), name + BOT pill, workspace chip
(in "All" only), last-message preview (streaming turns show a typing
indicator), timestamp, unread badge (indigo) / mention badge (rose).
Pull-to-refresh. New conversations (DM / channel / workspace) start from
the drawer's **New chat** button → New chat sheet.

**Chat** — the core surface.
- Header (Claude-app style): circular back button left; **centered**
  channel title with a one-line subtitle — live bot status while an agent
  is active ("● claude-code · running", emerald/amber dot), else
  workspace · member count. All header actions (search, mute, files,
  members, settings) collapse into a single circular **⋯ (more)** button
  top-right that opens a menu sheet; tapping the title opens Channel info.
- Inverted message list; bubbles per the iOS reference: own = indigo
  `#4f46e5` right-aligned, other = raised-surface left, 16pt radius with a
  6pt tail on the last of a group, day separator chips, sender name + BOT
  pill in multi-party channels. Reply-quotes as tinted quote blocks (tap →
  jump). Markdown + fenced code (horizontal scroll, copy button).
  Attachments as thumbnails/file chips; voice as waveform pill +
  transcription below.
- Streaming: partial message renders live with a caret; composer's send
  button becomes **Stop** during a bot turn; typing dots pre-token.
  Autoscroll only while pinned to bottom; otherwise a floating "↓ New
  messages" pill — never yank scroll during a stream.
- Bot trace: a collapsed "Agent steps · N" line under a finished bot turn;
  tap expands ~6 rows inline, "View all steps" pushes the full Trace screen.
- Composer: borderless raised card; `+` accessory (photo/camera/file), text
  field (grows to ~5 lines), mic (hold-to-record, slide-to-cancel, lock for
  hands-free), send/stop. When the channel has bots, a chip row above the
  field: **Session chip** (Auto ▾ / pinned session) and **Model chip**, each
  opening a bottom sheet mirroring `SessionChip.tsx` semantics
  (fetch-on-open, Auto = mention routing).

**Approval flow** — the killer feature, three states:
1. *Inline pending card* (in the message stream): compact — shield glyph +
   bot name, one-line mono command preview, **Review** button. No radios in
   a 360pt bubble.
2. *Approval sheet* (root-level bottom sheet; also the push deep-link
   target): header (bot + "requests permission" + channel link) → mono
   command block in a black inset (scrollable) → for `edit` tool calls the
   agent diff renders inline (capped height, expand to full screen); `git
   commit` offers the lazy "View staged diff" row → radio rows = the
   `allow*` options (first preselected; falls back to all options if the
   connector sent no allow) → sticky footer above the home indicator:
   **Deny** (quiet) · **Approve** (prominent light pill), full-width 48pt
   targets. Post-resolve: "✓ Approved" confirmation; a `delivered: false`
   response shows an amber "not delivered" note — never let the user think
   the agent acted when it didn't.
3. *Resolved card* collapses to one quiet trace-style line (as web).

**Activity** — sections: **Needs approval** (always on top; rows: bot avatar
+ shield, title, mono one-line preview, channel · workspace, age, amber
accent), **Invites** (Accept/Decline inline), **Recent** (resolved items,
quiet). Pull-to-refresh; reached from the drawer, and the pending count
badges the home screen's menu button.

**Agents** — summary strip ("3 running · 1 waiting on approval · 5 idle";
waiting chips link to Activity), then bots with their live sessions (status
dot emerald/zinc/red, session tag, cwd truncated middle-out, channel link,
last activity). **Session detail**: status/model/mode/cwd/channel; actions:
open chat, view trace, stop turn. No file workbench — "Open in Cheers web"
links out.

**Channel info** — hero, action row (Search/Mute/Files), Members (→ member
list: roles, add/remove), Bots (→ bot rows → sessions/permission mode),
Files (→ viewer: images zoomable, PDFs paged, code readonly + highlight,
share-sheet export), Invite links (create/copy/revoke), Danger zone
(leave/delete, soft-red, confirm dialog).

**You** — profile card, Friends (requests badge, add by username, tap →
DM), Appearance (System/Light/Dark, default System), Notifications
(per-category toggles matching §5.3), Server (URL + connection status),
About, Sign out. Admin rows appear for admins and link to web.

### 7.3 Mobile interaction language

- **Long-press a message → native context menu** (UIMenu / Material menu via
  zeego or equivalent) with blurred preview: Reply, Forward, Copy text, Copy
  code (when a code block), Delete (own; destructive-red; confirm). This
  replaces the web's hover toolbar.
- **Swipe right on a bubble = reply** (haptic tick). Conversation rows:
  swipe = Mute / Mark read. **No destructive swipes anywhere.** The
  drawer's edge swipe lives on the Chats *list* screen only, so it never
  conflicts with the bubble reply-swipe inside a chat.
- **`@` mention picker**: inline overlay *above the composer* (keyboard
  stays up), members + bots (bots first in bot channels), fuzzy filter;
  inserts a token chip — indigo tint for bots, rose for people.
- **Keyboard**: interactive dismissal (drag down through the list, iOS
  style) via `react-native-keyboard-controller`; composer pinned above
  keyboard/home indicator; ≥16pt input font.
- **Touch targets**: 44×44pt minimum everywhere; approval Deny/Approve are
  full-width 48pt.
- **Pull-to-refresh** on Chats/Activity/Agents. Chat history loads earlier
  via top-reach pagination — no pull spinner inside chat.
- Attachments stage as chips above the field (dashed = not yet uploaded, per
  web convention).

### 7.4 Visual system

Tokens come from the validated dual-mode mapping in
`apps/ios/Sources/Support/Theme.swift` (the derived light mode for the web's
dark-only `frontend/DESIGN.md` system), expressed as NativeWind semantic
tokens (light / dark):

| Token | Light | Dark |
| --- | --- | --- |
| `bg-app` | `#FAFAFA` zinc-50 | `#09090B` zinc-950 |
| `bg-surface` | `#FFFFFF` | `#18181B` zinc-900 |
| `bg-raised` | `#F4F4F5` zinc-100 | `#27272A` zinc-800 |
| `bg-selected` | `#E4E4E7` zinc-200 | `#3F3F46` zinc-700 |
| `text-primary` | `#18181B` | `#F4F4F5` |
| `text-body` | `#27272A` | `#E4E4E7` |
| `text-secondary` | `#52525B` zinc-600 | `#A1A1AA` zinc-400 |
| `accent` (buttons, own bubble) | `#4F46E5` indigo-600 | `#4F46E5` (constant) |
| `link` | `#4F46E5` | `#818CF8` indigo-400 |
| `danger` | `#DC2626` | `#F87171` |
| success / online | emerald-500 | emerald-500 |
| warning (pending approvals) | amber-600 | amber-400 |
| mention badge | rose-600 | rose-600 |

- **Follows system appearance**; optional override in You → Appearance.
- The web's rules carry over: **contrast floor** (zinc-400 dark / zinc-600
  light is the muted-text floor; zinc-500 never for meaningful text),
  **borderless elevation** (surfaces separate by contrast + shadow; rings
  only for focus/error), avatar colors reuse the exact web hash
  (`frontend/src/lib/format.ts`, already ported in `Theme.swift`).
- Typography: system fonts (SF Pro / Roboto); large-title 28–34 (iOS) / 22
  (Android), screen title 17 semibold, body/message 16, secondary 14, meta
  12, badge floor 11. Mono (Menlo / Roboto Mono) for commands, code, cwd.
  Dynamic Type / font scaling supported for body text.
- Spacing: 4pt grid, 16pt gutters, 12pt bubble padding, 8pt intra-group /
  16pt inter-group bubble gaps.
- **One layout, native interactions**: drawer-first navigation on both
  platforms — no platform fork. Platform-conditional chrome only at the
  interaction layer: context menus, share sheets, haptics, header style
  (large-title + blur on iOS; flat surface + centered title on Android).
  Bottom sheets (`@gorhom/bottom-sheet`) are the workhorse on both.

## 8. Milestones

1. **M1 — chat parity**: scaffold `apps/mobile/` + `packages/core`; login,
   Chats, Chat (streaming, pagination, gap-heal), read state, You basics.
   Parity with `apps/ios` today.
2. **M2 — approvals + push**: Activity screen, Approval sheet, Agents
   screen, session chips; server `notify` service + `PushTransport` + `user_devices`
   + device endpoints; notification categories/actions/deep links.
   *Server prerequisite from §6: refresh/device token follow-up.*
3. **M3 — management + retirement**: channel/workspace management flows,
   friends, files viewer, mention picker; then retire `apps/ios` +
   `apps/android` per the strategy doc.

## 9. Alternatives considered

- **Direct APNs + FCM from Rust** — no third-party transit, but per-deployment
  platform credentials make push impossible for self-hosters using the store
  app; kept as a future `PushTransport` impl.
- **Server-side push suppression when a socket is open** — a desktop tab
  would swallow phone pushes; rejected (§5.3).
- **Slack-style workspace-first navigation** — an extra hierarchy level for
  2–4 workspaces; rejected for the flat list + workspace drawer.
- **Extending `Fanout` for push** — the realtime layer is deliberately a dumb
  pipe; policy-heavy push belongs in a domain service.
- **WatermelonDB/SQLite offline sync** — overweight for v1; Query persister
  on MMKV covers cold-start rendering.
- **Dual-native (keep Swift + Kotlin)** / **PWA-only** — already rejected in
  [MOBILE_CLIENT_STRATEGY.md](MOBILE_CLIENT_STRATEGY.md).

## 10. App Store Release Readiness

Current branch status (2026-07-18): the SwiftUI target at `apps/ios/`
builds for `generic/platform=iOS Simulator`, but it is **not yet ready for
formal App Store submission**. The remaining release gates are:

- **Apple signing**: configure the real Apple Developer Team
  (`DEVELOPMENT_TEAM`) and production provisioning. The project currently uses
  automatic signing but does not record a team id.
- **Final bundle identity**: confirm `PRODUCT_BUNDLE_IDENTIFIER =
  app.cheers.ios` before uploading, because App Store Connect treats the
  bundle id as the app's permanent identity.
- **APNs capability**: add production push notification entitlements
  (`aps-environment`) and matching App Store provisioning. The branch has
  device registration and gateway APNs/relay support, but the iOS target still
  needs the capability/profile side.
- **Production networking**: replace development/local API assumptions with a
  production HTTPS base URL. Remove or tightly justify the current ATS
  exceptions for `localhost` and `127.0.0.1` before the store build.
- **Release archive validation**: run a signed Release archive for
  `generic/platform=iOS`, then validate/upload through Xcode Organizer or
  `xcrun altool`/Transporter.
- **Store metadata**: create the App Store Connect app record with the final
  name, subtitle, category, age rating, description, keywords, support URL,
  pricing, availability, and at least one valid screenshot per required device
  class.
- **Privacy materials**: publish a privacy policy URL and complete App Store
  privacy details for the actual data handled by Cheers (account data,
  messages/content, device push tokens, diagnostics, and any analytics if
  added).
- **Review access**: provide Apple with a stable review environment, demo
  account credentials, and notes for any server-side setup or role-specific
  flows.
- **Account lifecycle**: if the app supports account creation, add an in-app
  account deletion path or documented equivalent that satisfies App Review
  Guideline 5.1.1.
- **Production operations**: deploy the gateway with TLS, APNs credentials or
  the official relay, and the `0050_user_devices.sql` migration. Per project
  migration discipline, rebuild and force-recreate the gateway after the
  migration/code change.

Useful Apple references:

- <https://developer.apple.com/app-store/app-privacy-details/>
- <https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/>
- <https://developer.apple.com/distribute/app-review/>
- <https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/>
- <https://developer.apple.com/app-store/submitting/>

## 11. References

- [MOBILE_CLIENT_STRATEGY.md](MOBILE_CLIENT_STRATEGY.md) — accepted direction this design implements
- [WIRE_PROTOCOL.md](WIRE_PROTOCOL.md) — the `/ws` frame contract
- [MESSAGE_PAGINATION.md](MESSAGE_PAGINATION.md) — cursor pagination the app reuses
- [ACP_APPROVAL_FLOW.md](ACP_APPROVAL_FLOW.md) — permission request/resolve semantics
- `frontend/DESIGN.md` — token system and component recipes the mobile tokens inherit
- `apps/ios/Sources/Support/Theme.swift` — validated light/dark token mapping
- `frontend/src/features/chat/PermissionCard.tsx` — approval card semantics (allow*/reject* options, `delivered`, edit diffs, staged git diff)
- [docs/design/mobile-app-prototype.html](../design/mobile-app-prototype.html) — interactive prototype of the 8 key screens
