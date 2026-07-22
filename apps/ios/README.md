# Cheers iOS

Native SwiftUI client for the Cheers Rust gateway. Chat-first, Telegram-style:
conversation list → chat with bubbles → settings. LiveKit supplies realtime
voice media; the rest of the client uses Apple platform frameworks.

- **Deployment target:** iOS 17.0+
- **Architecture:** MVVM with `@Observable` models, async/await `URLSession`
  networking, `Codable` DTOs whose coding keys match the gateway's serde field
  names exactly (`server/src/api/*`, `server/src/infra/db/models.rs`)
- **Realtime:** `URLSessionWebSocketTask` against `GET /ws` with the gateway's
  frame protocol (`auth` → `auth_ok` → `subscribe` → `subscribed`, then
  `message` / `message_stream` / `message_done` / `message_deleted` /
  `presence` envelopes), exponential-backoff reconnect (1 s → 30 s, max 10
  retries) with automatic resubscribe and `?since_seq=` gap healing
- **Auth:** JWT stored in the Keychain (`Sources/Support/KeychainStore.swift`);
  non-secret session fields in `UserDefaults`
- **Theming:** follows the system light/dark appearance. Dark is the canonical
  web palette (zinc + indigo); light is the derived mapping from the design
  language map (§1.4). Avatar colors reuse the exact web hash
  (`frontend/src/lib/format.ts`) so identities match across platforms.
- **Local cache:** SwiftData is accessed only through a `@ModelActor`. Container
  opening, message JSON encoding, SQLite writes, and trimming never run on the
  main actor.

## Performance invariants

These are architectural contracts, not optional micro-optimizations:

- Text-field draft/focus/dictation state belongs to `ComposerView`. Do not bind
  keystrokes to `ChatModel` or another ancestor that owns the timeline.
- The active transcript is bounded to 200 messages. Older/newer pages are
  replaced through gateway pagination instead of accumulating indefinitely.
- Streaming bot output stays plain text until `message_done`; Markdown parsing
  is cached and runs only for finalized content.
- Message presentation values (day labels, timestamps, grouping, reply lookup)
  are rebuilt only when the message collection changes, never from a row body.
- SwiftData access goes through `MessageStoreWorker`; never use
  `ModelContainer.mainContext` for chat persistence.
- User-driven animations must respect Reduce Motion. Interactive controls use
  native `Button`/`TextField` semantics and at least 44×44 pt hit regions.

## Layout

```
apps/ios/
├── Cheers.xcodeproj/           # hand-authored project (one app target)
├── Sources/
│   ├── CheersApp.swift         # @main + RootView (login vs. main switch)
│   ├── Info.plist              # ATS exceptions for localhost HTTP
│   ├── Support/                # Theme tokens, Keychain wrapper, time formats
│   ├── Models/                 # Codable DTOs (auth, workspaces, channels, messages)
│   ├── Networking/             # APIClient (REST), ChatSocket (WebSocket)
│   ├── State/                  # AppModel, ConversationListModel, ChatModel
│   └── Views/                  # Login, ConversationList, Chat, Composer, Settings
└── README.md
```

## Build & run

Requirements: Xcode 15+ (tested with Xcode 26.6), iOS 17 simulator runtime.

### Xcode

```bash
open apps/ios/Cheers.xcodeproj
```

Select the `Cheers` scheme and an iOS simulator, then Run. Code signing is not
required for simulator builds.

### Command line

```bash
cd apps/ios

# Typecheck only (no project needed)
xcrun -sdk iphonesimulator swiftc -typecheck \
  -target arm64-apple-ios17.0-simulator $(find Sources -name "*.swift")

# Full build for the simulator
xcodebuild -project Cheers.xcodeproj -scheme Cheers \
  -destination "generic/platform=iOS Simulator" build CODE_SIGNING_ALLOWED=NO

# Build + install + launch on a booted simulator
xcodebuild -project Cheers.xcodeproj -scheme Cheers \
  -destination "platform=iOS Simulator,name=iPhone 16" build CODE_SIGNING_ALLOWED=NO
xcrun simctl install booted <DerivedData>/Build/Products/Debug-iphonesimulator/Cheers.app
xcrun simctl launch booted app.cheers.ios
```

## Pointing at a server

The login screen has a server URL field, defaulting to
`http://localhost:30080/api/v1` — the local kind/Helm dev stack's frontend
NodePort, which proxies `/api` and `/ws` to the gateway and is reachable from
the iOS simulator on the same Mac. Sign in with the dev credentials
(`admin` / `admin12345`).

Any base URL works; `/api/v1` is appended automatically if missing, and the
websocket URL is derived from it (`ws(s)://host[:port]/ws`). `Info.plist`
carries ATS exceptions for `localhost`/`127.0.0.1` HTTP only — remote servers
should use HTTPS.

## Feature notes

- **Conversation list:** flat list across all workspaces (workspace shown as a
  chip) plus DMs, sorted by last activity; unread badges from the gateway's
  `unread_count` plus live socket bumps; pull-to-refresh; last-message preview
  is fetched per channel (`?limit=1`).
- **Chat:** own bubbles indigo `#4f46e5`, other bubbles zinc surface, 16 pt
  radius with a 6 pt tail on the last bubble of a group; sender names (colored
  with the shared avatar hash) and BOT pills in multi-party channels; day
  separator chips; "load earlier" pagination via `?before=<oldest msg_id>`;
  auto-scroll to bottom on new messages; bot typing dots for `is_partial`
  placeholders and live token streaming via `message_stream` deltas.
- **Read state:** `POST /channels/:id/read` on open and on incoming messages
  while the channel is on screen.
- **Session:** revoked/expired tokens (REST 401 or socket `auth_err`) sign the
  user out locally; logout also calls `POST /auth/logout` to revoke
  server-side.

## Not yet implemented

File **upload** is not implemented yet (download/preview works). Since the last
update the app gained a mention picker, actionable approval
cards, workspace switching, channel management (settings, member roles, direct
+ link invites), and the five-board ViewBoard (Plan/Cost/Sessions/Audit/Activity
— four boards ride the gateway's WS `resource_req` verbs). See the repo roadmap.
