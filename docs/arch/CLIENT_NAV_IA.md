# Shared client navigation IA (iOS · Mac / web)

> **Status**: decision for #355 — source of truth for converging iOS and
> desktop/Mac settings & navigation. Chrome may differ (drawer vs rail,
> page vs popover); **destinations, jobs, and nesting must match**.

Related: [MOBILE_APP_DESIGN.md](./MOBILE_APP_DESIGN.md) §7.1 (drawer model),
frontend `WorkspaceRail` / `SettingsPage`, iOS `DrawerView` / `SettingsView`.

---

## 1. Principles

1. **Same product map on every client.** A user who learns Mac Settings must
   find the same capabilities under the same names on iPhone (and vice
   versa). Layout density may change; hierarchy may not.
2. **Separate “needs me” from “my bots”.** Approvals/invites are not the
   same job as fleet observability — but they share a primary-nav tier.
3. **One primary home per capability.** Secondary deep links are fine;
   duplicate owners (Fleet *and* Settings → Bots as peers) are not.
4. **Platform-only surfaces are explicit exceptions**, never silent gaps in
   the shared map.

---

## 2. Shell & primary destinations

**Chat is home** on every client: conversation list → channel/DM. No bottom
tab bar as the app’s main IA (iOS drawer-first; desktop workspace rail +
sidebar).

| Destination | Job (one sentence) | Badge | iOS chrome | Desktop chrome |
| --- | --- | --- | --- | --- |
| **Activity** | Things that need *me*: pending approvals + invites | Pending count | Full page from drawer chip | Rail control → page **or** popover with the **same sections** |
| **Fleet** | Personal bot cockpit: status, create/manage, hosts, audit | Optional “waiting on me” (mirrors Activity) | Full page from drawer chip | Rail → `/fleet` |
| **Friends** | People graph: friends, requests, add, blocked | Incoming requests | Full page from drawer chip | Rail → `/friends` |
| **Settings** | Me, account security, legal, server, platform prefs | — | Full page from drawer footer | Rail → `/settings` |

### Naming lock

| Canonical (shared) | Do not use as primary label |
| --- | --- |
| **Activity** | “Notifications” alone (invites-only), “Inbox” |
| **Fleet** | “Agents”, “Bots” as the *primary-nav* label |
| **Friends** | “Contacts” |
| **Settings** | “You”, “Profile” as the *primary-nav* label |

Shipped iOS currently labels the chip **Notifications** and keeps approvals
inside **Fleet**. Convergence target: move approvals (+ invites) under
**Activity**; keep Fleet as bot roster / status / add-bot. Until both
clients ship Activity, treat iOS Notifications + Fleet-approvals as a
known transitional split documented in #355.

### Workspace scope

| Control | Shared behavior |
| --- | --- |
| Workspace switcher | Personal · team workspaces · create/join |
| **All conversations** | Allowed on iOS (flat cross-workspace home). Desktop may keep “always one selected workspace”; document as intentional if not ported. |
| **Workspace admin gear** | On the **workspace header** (drawer bar / sidebar header), opens the same **Manage workspace** surface (rename, invites, roles, leave/delete). Must not be Settings-only. |

---

## 3. Settings IA (shared sections)

Settings is a **sectioned surface**. Section ids are stable across clients
(`profile`, `account`, …). Desktop keeps URL `/settings/:section`; iOS uses
the same section list (push or grouped list).

### 3.1 Shared (must exist on iOS and Mac/web)

| Section | Contents |
| --- | --- |
| **Profile** | Editable display name, status, bio, avatar. Read-only summary is a bug relative to this IA. |
| **Account** | Password · 2FA · Passkeys · linked identity providers (Apple **and** Google where the gateway supports them) · **Devices & sessions** (list + revoke) · **Push** preference (in-app toggle where the platform allows; otherwise deep-link to OS Settings + status) · **External AI permissions** (list + revoke) · Sign out · Delete account |
| **Server** | Current API base (display) · Switch server (= clear session + re-pick; same semantics as today’s Tauri “Switch server”) |
| **Legal & support** | Privacy · Terms · Help & Support · Account deletion help · Remote Operation Safety — **same link set on every client** |

### 3.2 Not a Settings peer: Bots

**Bot create / catalog / onboarding primary home = Fleet.**

- Desktop `Settings → Bots` becomes a **secondary entry** that navigates to
  Fleet (or a Fleet deep-link), not a parallel manager.
- Channel membership / permission mode for bots in a channel stays under
  **Channel settings**, not global Settings.

### 3.3 Desktop / admin only (intentional exceptions)

| Section | Audience |
| --- | --- |
| **Connector** | Tauri desktop (local daemon) |
| **About** | Tauri: app updates, launch at login (server switch lives under **Server**, not only here) |
| **Workbench** (templates) | Admin |
| **Members** (global) | Admin |
| **Speech-to-text** | Admin |
| **Safety reports** | Admin |

iOS does **not** reimplement admin consoles in v1; admins use web/desktop.
Optional: quiet “Open in browser” rows for admins — never half-ported forms.

---

## 4. Channel-scoped surfaces (shared)

Entered from chat header **⋯** / channel title — not from primary nav:

- Channel settings (mute, leave, danger zone, …)
- Members
- Files / workbench (desktop-rich; iOS may be thinner but same entry)
- Invite links (where role allows)

---

## 5. Activity vs Fleet (content contract)

```
Activity                         Fleet
─────────────────────            ────────────────────────────
Needs approval (top)             Overview / attention summary
Invites (Accept/Decline)         Bot-centric roster (Mine / Shared)
Recent resolutions              Cross-bot hosts
                                 Unified owner audit
                                 Add bot / host
```

Approvals may appear as compact cards in chat and as push targets; the
**list home** for “what needs me” is Activity, not Settings.

---

## 6. Convergence checklist (from this IA)

Use this as the implementation order for #355:

1. [x] Rename/merge iOS Notifications → **Activity**; include approvals + invites.
2. [x] Desktop Notification popover (or page) matches Activity sections.
3. [x] Point desktop Settings → Bots at **Fleet**; keep Add bot on Fleet on both.
4. [x] iOS Profile editable (+ display name / status / bio) to match desktop.
5. [x] Desktop Account gains **Devices & sessions** and **External AI permissions**.
6. [x] Unify **Legal & support** link set; add **Server** section semantics on both.
7. [x] Workspace admin gear on iOS drawer header opens Manage workspace (same as desktop sidebar gear).
8. [x] Document exceptions: Connector, About extras, admin sections, optional All conversations.

Remaining polish (not blocking the IA lock):
- [x] iOS avatar upload parity with desktop Profile.
- [x] Desktop Fleet bot detail / token issuance (primary create + manage on Fleet).
- [x] Google identity management on iOS Settings (status + unlink; link via login).

---

## 7. Non-goals

- Pixel-identical chrome (drawer ≠ rail is fine).
- Porting admin / Connector / autostart to iOS.
- Merging non-bot invitations into Fleet. Activity remains the personal inbox;
  Fleet mirrors bot attention and deep-links to Activity.
- Putting bot catalog back under Settings as the primary owner.
