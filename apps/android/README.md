# Cheers for Android

Native Android client for the Cheers chat platform — Kotlin, Jetpack Compose,
Material 3. Chat-first (Telegram-style): conversation list → chat with bubbles
→ settings, talking to the Rust gateway's `/api/v1` REST surface and the `/ws`
realtime WebSocket.

## Screens

| Screen | What it does |
|---|---|
| Login | Server URL (defaults to `http://10.0.2.2:30080/api/v1` for the emulator + kind dev stack), username/email + password → `POST /auth/login` with `client=android`; native access and refresh credentials persisted with DataStore and Android Keystore encryption |
| Conversations | Workspace chips (personal "Home" + teams), channels + DMs with deterministic avatars, last-message preview, time stamp, indigo unread badge |
| Chat | Telegram-style bubbles (own = indigo `#4F46E5`, other = zinc `#27272A`), day chips, sender names colored with the web app's avatar hash, BOT pills, streaming deltas, typing dots, scroll-up pagination, auto-scroll, growing composer |
| Settings | Profile / server info, sign out (retires the local login and revokes that server session) |
| Artifacts | One paginated library for authored documents and delivered files; message attachments, resource cards and Cheers links open the same detail; read-only source preview, availability, copy link and authenticated Save file through Android's system picker |


Realtime follows the browser client's protocol exactly
(`frontend/src/lib/realtimeTransport.ts` and
[`WIRE_PROTOCOL.md`](../../docs/arch/WIRE_PROTOCOL.md)): `auth` → `auth_ok` →
`subscribe` → `subscribed`, then `message` / `message_stream` / `message_done`
/ `message_deleted` / `presence` frames; reconnect with exponential backoff
1 s → 30 s until the session or channel stops, and a REST `?since_seq=` catch-up after every
(re)subscribe ack.

The same socket correlates `resource_req`/`resource_res` with request IDs, limits
pending requests, pins `channel_id` to the open conversation, and fails pending
calls on disconnect. Artifacts refresh after reconnect and `board_signal(files)`.
HTML/TSX is displayed as inert source; interactive rendering and editing remain
Web/macOS capabilities rather than being simulated in a WebView.

## Requirements

- **Android Studio** Ladybug (2024.2) or newer — bundles a JDK 17+ and the
  Android SDK (compileSdk 35).
- Or a command-line setup: JDK 17, Android SDK with platform 35 +
  build-tools, and Gradle 8.9+.

## Building

### Android Studio (recommended)

1. *Open* → select `apps/android`.
2. Let Gradle sync (Studio generates the wrapper jar and downloads
   dependencies from the version catalog).
3. Run the `app` configuration on an emulator (API 26+).

### Command line

This repo intentionally does **not** commit the binary
`gradle-wrapper.jar`. Generate it once with any local Gradle (8.9+), then use
the wrapper:

```bash
cd apps/android
gradle wrapper            # reads gradle/wrapper/gradle-wrapper.properties (8.11.1)
./gradlew :app:testDebugUnitTest :app:assembleDebug
./gradlew :app:installDebug   # with an emulator/device attached
```

`sdk.dir` comes from `local.properties` (Android Studio writes it) or the
`ANDROID_HOME` environment variable.

The SDK package installation requires acceptance of Google's Android SDK license.
AGP 8.7.3 selects Build-Tools 34.0.0 by default; the compile platform remains 35.
Do not report APK or Compose validation as passed when the SDK is unavailable.

### Protocol and state tests without an Android SDK

With JDK 17 and Gradle 8.11.1 available:

```bash
gradle -p protocol-tests test
```

This standalone JVM target compiles production resource requests, DTOs and the artifact
controller directly, then runs their focused tests under `app/src/test/java`. It covers
request correlation, cancellation, timeout,
disconnect, pagination, expiry, stale selection responses and malformed cards.
The session-aware WebSocket integration test runs in the Android unit-test target
alongside authentication recovery tests. The standalone target does not compile Compose or replace `:app:assembleDebug` / `:app:testDebugUnitTest`.

## Pointing it at a backend

Run the dev stack from the repo root (kind + Helm, see the top-level
`CLAUDE.md` / chart README), which exposes the frontend NodePort on
`http://localhost:30080` and proxies `/api` + `/ws` to the gateway:

- **Emulator**: keep the default `http://10.0.2.2:30080/api/v1`
  (`10.0.2.2` = host loopback from inside the emulator).
- **Physical device**: use your machine's LAN IP, e.g.
  `http://192.168.1.10:30080/api/v1` (same Wi-Fi network).
- Sign in with the dev credentials (`admin` / `admin12345` by default).

The manifest sets `android:usesCleartextTraffic="true"` because dev servers
are plain HTTP; remove it (or add a network security config) for an
HTTPS-only production build.

## Architecture

```
app/src/main/java/com/cheers/android/
├── CheersApplication.kt        # owns the AppContainer
├── MainActivity.kt             # edge-to-edge, single Compose activity
├── di/AppContainer.kt          # manual DI: Json, OkHttp, Retrofit, session state
├── data/
│   ├── SessionStore.kt         # encrypted credentials + atomic login identity updates
│   ├── auth/                  # Keystore codec, scoped REST auth, refresh outcomes
│   ├── api/                    # Retrofit interface + kotlinx.serialization DTOs
│   │   ├── CheersApi.kt        #   (@SerialName == serde names, exactly)
│   │   ├── Dtos.kt
│   │   └── Errors.kt           # {"detail": …} error mapping
│   ├── ws/ChatSocket.kt        # OkHttp WebSocket, backoff + close-code handling
│   └── repo/AuthRepository.kt  # one refresh coordinator for REST and WebSocket
├── ui/
│   ├── CheersApp.kt            # session gate + NavHost
│   ├── theme/                  # zinc/indigo Material 3 dark + light themes
│   ├── components/             # CheersAvatar (web-identical hash), badges
│   ├── login/  conversations/  chat/  settings/
│   │   └── *Screen.kt + *ViewModel.kt (StateFlow + sealed/immutable UI state)
└── util/Format.kt              # times, day labels, initials, avatar hash
```

MVVM: each screen has a `ViewModel` exposing a `StateFlow` of an immutable UI
state (sealed hierarchy where the screen has distinct Loading/Error/Ready
phases); no business logic in composables.

`AuthRepository` owns native refresh rotation. REST calls and WebSocket authentication
share one in-flight refresh request for the rejected access token. Access credentials
are refreshed before expiry; REST `401`, WebSocket `4401`, and `auth_err` use the same
coordinator. A successful refresh retains the current navigation and chat state.
Transient refresh failures keep the local login for retry; an authoritative refresh
`401` clears only the login that made that request. Channel `4403` and permission
subscription errors stop that channel without signing out the account.

Every protected REST client, socket, and screen belongs to a server, user, and local
login epoch. Signing out or switching logins retires that identity before awaiting
network work, so late responses cannot restore credentials or populate a later login.
Raw login/refresh/logout transport carries no implicit bearer token; protected clients
restrict credentials to their fixed server and API base path. A rejected GET may be
retried once after refresh. Writes are never automatically replayed, including after
a connection failure or a `503` with `Retry-After: 0`.

Access and refresh tokens are encrypted with an Android Keystore AES-GCM key before
being written to DataStore. DataStore files are excluded from cloud backup and device
transfer. Older access-only records and credentials whose key is unavailable require
signing in again. JVM tests exercise real DataStore, Retrofit, OkHttp, and
MockWebServer HTTP/WebSocket exchanges; they do not exercise the device Keystore.

## Design language

Colors, typography, radii, and chat metrics follow the repo's design-language
map extracted from the web client: dark theme is canonical
(zinc-950/900/800 surfaces, indigo-600 accent), light theme uses the derived
mapping; avatars use the exact JS color-hash so identities match across
platforms; the app icon is generated from `frontend/public/cheers-icon.svg`.

## Known gaps (v1)

- Password sign-in only; OAuth and two-factor sign-in UI are not implemented.
- No file upload yet. Existing attachments can be opened through Artifacts and saved with the system file picker.
- Artifact previews are read-only; interactive HTML/TSX rendering, editing and composer resource-context selection are not yet available on Android.

- Approval (permission) cards render as a system line pointing to the web app.
- No message long-press actions (delete/reply), no @-mention picker, no
  slash-command palette.
- Conversation previews come from a per-channel `?limit=1` probe (the list
  endpoints don't return last-message snippets).
