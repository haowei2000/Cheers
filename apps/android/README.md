# Cheers for Android

Native Android client for the Cheers chat platform — Kotlin, Jetpack Compose,
Material 3. Chat-first (Telegram-style): conversation list → chat with bubbles
→ settings, talking to the Rust gateway's `/api/v1` REST surface and the `/ws`
realtime WebSocket.

## Screens

| Screen | What it does |
|---|---|
| Login | Server URL (defaults to `http://10.0.2.2:30080/api/v1` for the emulator + kind dev stack), username/email + password → `POST /auth/login`; JWT persisted with DataStore |
| Conversations | Workspace chips (personal "Home" + teams), channels + DMs with deterministic avatars, last-message preview, time stamp, indigo unread badge |
| Chat | Telegram-style bubbles (own = indigo `#4F46E5`, other = zinc `#27272A`), day chips, sender names colored with the web app's avatar hash, BOT pills, streaming deltas, typing dots, scroll-up pagination, auto-scroll, growing composer |
| Settings | Profile / server info, sign out (revokes server-side) |

Realtime follows the browser client's protocol exactly
(`frontend/src/features/chat/hooks/useChatRealtime.ts`): `auth` → `auth_ok` →
`subscribe` → `subscribed`, then `message` / `message_stream` / `message_done`
/ `message_deleted` / `presence` frames; reconnect with exponential backoff
1 s → 30 s (max 10 retries) and a REST `?since_seq=` catch-up after every
(re)subscribe ack.

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
./gradlew :app:assembleDebug
./gradlew :app:installDebug   # with an emulator/device attached
```

`sdk.dir` comes from `local.properties` (Android Studio writes it) or the
`ANDROID_HOME` environment variable.

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
│   ├── SessionStore.kt         # DataStore-backed JWT/session persistence
│   ├── api/                    # Retrofit interface + kotlinx.serialization DTOs
│   │   ├── CheersApi.kt        #   (@SerialName == serde names, exactly)
│   │   ├── Dtos.kt
│   │   └── Errors.kt           # {"detail": …} error mapping
│   ├── ws/ChatSocket.kt        # OkHttp WebSocket, backoff + close-code handling
│   └── repo/                   # AuthRepository, ChatRepository
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

## Design language

Colors, typography, radii, and chat metrics follow the repo's design-language
map extracted from the web client: dark theme is canonical
(zinc-950/900/800 surfaces, indigo-600 accent), light theme uses the derived
mapping; avatars use the exact JS color-hash so identities match across
platforms; the app icon is generated from `frontend/public/cheers-icon.svg`.

## Known gaps (v1)

- Text + read-only attachment chips; no file upload/download yet.
- Approval (permission) cards render as a system line pointing to the web app.
- No message long-press actions (delete/reply), no @-mention picker, no
  slash-command palette.
- Conversation previews come from a per-channel `?limit=1` probe (the list
  endpoints don't return last-message snippets).
