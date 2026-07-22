# iOS App Store Submission Packet

This packet is the release owner’s source of truth for the official Cheers iOS
app. Complete the owner-only fields immediately before submission; do not put
review credentials, passwords, tokens, or private server addresses in Git.

## Public URLs

| App Store Connect field | Production value | Verification |
| --- | --- | --- |
| Privacy Policy URL | `https://www.tocheers.com/privacy.html` | Opens without sign-in, including on mobile |
| Support URL | `https://www.tocheers.com/support.html` | Opens without sign-in; `tocheers@icloud.com` is monitored |
| Privacy contact | `tocheers@icloud.com` | Mailbox is monitored |

The iOS login and Settings screens link to the first two URLs. Do not submit
until the deployed domain serves these exact paths over HTTPS and the mailbox is
live.

## App Privacy questionnaire

Answer for the official hosted service and every SDK included in the submitted
archive. The current iOS target has no analytics or advertising SDKs. Sign in
with Apple uses Apple's system AuthenticationServices framework. Data below is collected by the Cheers service, linked to the user,
used for **App Functionality**, and **not used for Tracking**:

| Apple data type | Data | Why |
| --- | --- | --- |
| Contact Info | Email Address; Name | Account identity and support |
| User Content | Other User Content; Photos or Videos; Audio Data | Messages and files a user chooses to upload |
| Identifiers | User ID | Authentication, workspace authorization, account operations |
| Device ID | APNs device token and device name | Notification registration, only after permission is granted |

### iOS system permissions in the current source

| Permission | Current use | Release decision |
| --- | --- | --- |
| Notifications | Optional approvals, mentions, direct-message and invite alerts | Keep optional; request only after sign-in, never gate core use on it |
| Camera | Not used | Do not add `NSCameraUsageDescription` |
| Photo Library | Not used | Do not add `NSPhotoLibraryUsageDescription` |
| Microphone | Not used | Do not add `NSMicrophoneUsageDescription` |
| Location, Contacts, Calendar, Bluetooth, Health, Tracking | Not used | Do not add the corresponding purpose strings or entitlements |

Network access is not an iOS consent dialog. The app communicates with the
configured Cheers server over HTTPS/WSS; the only HTTP exception is loopback
development. It does not have iOS-level permission to control the user’s phone,
camera, microphone, or files outside its own sandbox.

Before submission, release owner must reconfirm this list against the final
binary and production services. If a crash reporter, analytics SDK, advertising
SDK, voice capture, payment SDK, or new provider is added, update both the
App Privacy questionnaire and `website/privacy.html` first.

### External AI and remote-operation release gate

Cheers can forward channel content to an external agent selected by a workspace
owner. Apple requires clear disclosure and explicit permission before personal
data is shared with a third-party AI. Before enabling an external agent in a
channel with personal data, obtain and record participant consent, identify the
agent/provider, link its terms, and state the data scope. This is a release
implemented as a versioned per-user/channel/bot consent. The gateway enforces it
at dispatch time and iOS lets the user review or revoke it in Settings.

The iOS client retains urgent lock-screen Approve / Deny actions. Both require
device authentication, the action label says it approves a remote action, and
the APNs alert warns users to approve only recognized requests. The gateway
still verifies the owner/designated-approver role and pending request before it
relays a decision. In-app approval shows the command/diff, warns of remote
impact, and requires a second confirmation. Keep the remote-operation policy at
`https://www.tocheers.com/remote-operations.html` publicly available and link
it from the release website.

## App Review Information

The iOS app offers first-party username/email and password authentication plus
Sign in with Apple on official gateways that advertise a complete Apple server
configuration. Self-hosted gateways without the official private key remain
password-only. Review must cover both paths and in-app account deletion.

In App Store Connect, provide a non-expiring review account and exact setup
instructions in **App Review Information**:

```text
Review account username/email: [create immediately before submission]
Review account password: [enter only in App Store Connect]
Server URL: https://www.tocheers.com/api/v1
Steps: Open the app, keep the prefilled server URL, sign in, open a channel,
send a message, and open Settings > Sign in with Apple / Delete account /
Privacy Policy / Help & Support. A separate Apple reviewer account may also use
the native Sign in with Apple button on the official server.
```

The review account must have ordinary-member permissions, access to a populated
test workspace/channel, and no MFA, IP allowlist, invite, or email-verification
step that blocks Apple reviewers. Do not include a production administrator
account or any real user data. Describe any test-only bot or privileged feature
in review notes with precise steps.

## Security release gate

Block submission until all items below are evidenced for production:

- HTTPS and WSS are enforced at the public gateway; iOS now rejects non-local
  `http://` server URLs so credentials cannot be sent over a clear-text remote
  connection.
- `CORS_ALLOWED_ORIGINS` is set to the exact production frontend origin, not a
  development fallback.
- Production secrets are unique and held in a secret manager: administrator
  password, PostgreSQL password, JWT RS256 keys, `SECRET_STORE_KEY`, S3 keys,
  APNs `.p8` credentials, and email-provider credentials. No development
  credentials or private key is present in the image, repository, logs, or
  review notes.
- The legacy `JWT_SECRET_KEY`/HS256 migration path is disabled after all active
  tokens have been migrated or expired.
- For internet-facing bot connectors, ACP capability delegation is required and
  connectors use a minimal environment allowlist and bounded workspace roots.
- A release candidate has passed the gateway test suite and a real-device smoke
  test: login, logout, session expiry, websocket reconnect, a file upload and
  download, push opt-in/out, Apple sign-in/link/revoke, and direct account deletion.
- `tocheers@icloud.com` has an owner and a tested response process. Account
  deletion requests must be verified and tracked.

## Findings from the 2026-07-21 pre-release audit

The current codebase has meaningful controls: RS256 bearer-token authentication,
rate-limited login and registration, channel/file authorization checks,
gateway-proxied object storage, file response hardening, Keychain token storage,
and explicit CORS/WebSocket-origin controls. The two past M1 vulnerabilities
recorded in `docs/SECURITY_REVIEW_M1.md` are fixed, but that review is historical
and must not be treated as a production sign-off.

The release-blocking risks are operational configuration and agent execution
boundaries, not an excuse for a compatibility shim: a weak or leaked production
secret, permissive CORS, absent TLS, retained HS256 secret, or an overly broad
connector environment would undermine the existing code safeguards. The gates
above are therefore required evidence before GA.
