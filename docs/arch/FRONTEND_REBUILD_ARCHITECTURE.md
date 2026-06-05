# Frontend Rebuild Architecture

> Status: finalized decision
> Date: 2026-06-02
> Scope: AgentNexus browser frontend rebuild

This document fixes the frontend rebuild direction after the Rust Backend and
Rust local daemon architecture decisions.

## 1. Decision

The new AgentNexus frontend will be rebuilt as:

```text
TypeScript + React + Vite
```

Supporting choices:

| Layer | Decision |
|---|---|
| Language | TypeScript |
| UI framework | React |
| Build/dev tool | Vite |
| Router | TanStack Router |
| Server state | TanStack Query |
| Realtime | A dedicated Browser WS client that patches or invalidates server state |
| Local UI state | Zustand or small React contexts, chosen per feature |
| Styling | CSS variables + Tailwind utilities + headless primitives |
| Backend boundary | Rust Backend remains the only API, permission, file, session, and Agent Bridge authority |

The current `frontend/` package is a deprecated legacy frontend. It may receive
short-term fixes required to keep deployments usable, but new product work should
move to `frontend-next/`.

## 2. Why This Stack

AgentNexus is an authenticated realtime workbench, not a public marketing site.
The first-class workflows are:

- workspace and channel navigation
- chat and streaming message state
- bot configuration and runtime status
- approval cards and permission resolution
- Agent Bridge setup and diagnostics
- files, memory, docs, settings, and operational panels

These workflows need fast UI iteration, rich component composition, typed API
models, predictable client routing, and clear server-state synchronization.
TypeScript + React + Vite is the most direct fit for that shape.

## 3. Non-Goals

### 3.1 Not Next.js

Next.js is not the default rebuild target because AgentNexus already has a Rust
Backend that owns API, WebSocket, auth, permissions, files, sessions, and Agent
Bridge. Adding a Node full-stack layer would blur that boundary.

Use Next.js only if a future requirement explicitly needs SSR, public SEO pages,
or a Node-side BFF. Those are not current requirements.

### 3.2 Not Rust as the Main Frontend Language

Rust remains the right choice for the gateway, local daemon, ACP adapter, MCP
server, and protocol-heavy code. It is not the best primary browser UI language
for this product because the main work is high-iteration interaction design,
forms, routing, virtualized lists, rich text, and realtime UI state.

Rust/WASM can still be used for isolated modules such as cryptography, protocol
validation, or performance-sensitive transforms.

### 3.3 Not a Component-Library-First Rewrite

The rebuild should not begin by importing a heavy visual component suite and
forcing the product into it. AgentNexus needs a dense operational workbench, so
the design system should start with tokens, layout rules, interaction states,
and focused primitives.

## 4. Runtime Boundary

The frontend must not become a platform authority.

```text
Browser UI
  -> REST commands
  -> Browser WebSocket events
  -> local rendering and interaction state

Rust Backend
  -> auth
  -> permissions and grants
  -> message/file/session persistence
  -> browser fanout
  -> Agent Bridge control/data
  -> permission_resolution routing
```

Examples:

- Approval buttons may hide or show based on user context, but Backend decides
  who is authorized to approve.
- WebSocket events may optimistically patch UI state, but Backend remains the
  source of persisted truth.
- Agent Bridge configuration screens may edit local-facing settings, but Backend
  owns connector control snapshots and dispatch.

## 5. Target Directory

## 5. Design Language

The `frontend-next/` design language is:

```text
dynamic but grounded, icon-first, layered, always oriented
```

AgentNexus should feel like a realtime agent operations workbench. The main
content stays calm and readable; every changing piece of state is visibly alive.

### 5.1 Static Structure, Dynamic State

Stable content should be quiet. Changing information must be obvious.

Examples:

- streaming agent output uses a visible streaming cursor or progressive reveal
- running tasks use animated status marks, progress tracks, or live timers
- approval waits use a distinct pending state, not just static text
- online/offline/runtime transitions animate or visibly pulse for a short time
- newly changed rows, messages, or counters get a brief highlight

Motion must communicate state, not decorate the page. Use 150-250ms transitions,
avoid layout-shifting animation, and respect `prefers-reduced-motion`.

### 5.2 Icon-First, Hover-Revealed Detail

Primary navigation and tool surfaces should favor icons, compact labels, and
hover/tooltips instead of large blocks of explanatory text.

Rules:

- Use one icon family, preferably lucide, with consistent stroke weight.
- Icon-only controls must have `aria-label`, visible focus state, and tooltip.
- Hover can reveal names, descriptions, previews, or secondary actions.
- Critical actions must still be reachable by click, keyboard, and mobile tap;
  hover is an enhancement, not the only path.
- Long prose should move to docs, inspectors, or expandable detail panels, not
  dominate the main workbench.

### 5.3 Layered Workbench Surfaces

The main content is the base layer. Operational controls float above it.

The base content layer must fill the full available workspace. The primary
chat/timeline/workbench surface is not a centered card or panel; it is the
deepest full-space canvas. Sidebars, composer, route header, inspector,
popovers, and modals sit above that canvas.

Layer model:

| Layer | Purpose |
|---|---|
| Base content | Chat, timeline, workbench canvas, primary page content |
| Persistent chrome | workspace rail, channel list, route header |
| Floating controls | composer, action bars, search, command palette trigger |
| Inspectors | right panels for bot status, approval detail, file/context, trace |
| Popovers | icon hover details, menus, quick settings |
| Modals/sheets | rare blocking workflows and mobile detail views |

This keeps the conversation or primary work surface visually deepest and most
stable, while sidebars, composer, top bars, and dialogs read as higher layers.

Do not bury the main content inside decorative cards or centered panels. Use
floating panels only when they add operational control or context.

### 5.4 Orientation Contract

Every view must constantly answer three questions:

1. Where am I?
2. How do I go back?
3. What can I do here?

Required UI signals:

- current workspace, channel, route, and session are visible or one click away
- back/breadcrumb/history affordance is predictable
- available actions are shown as an action rail, toolbar, command menu, or
  contextual floating controls
- disabled or unavailable actions explain why through hover/detail text
- realtime state shows whether the user is looking at live, stale, paused, or
  failed data

This orientation contract applies more strongly than visual minimalism. If a
minimal screen makes the user lose their place, it is not acceptable.

## 6. Target Directory

New code should start under `frontend-next/`:

```text
frontend-next/
  src/
    app/
      App.tsx
      router.tsx
      providers.tsx
    routes/
    features/
      auth/
      workspaces/
      channels/
      messages/
      approvals/
      bots/
      agent-bridge/
      files/
      memory/
      settings/
    shared/
      api/
      realtime/
      ui/
      model/
      config/
```

## 7. Data Flow

```text
Route loader / component
  -> shared/api REST client
  -> TanStack Query cache
  -> feature component

Browser WebSocket
  -> shared/realtime event normalizer
  -> query cache patch or invalidate
  -> feature component rerender

User command
  -> API mutation
  -> Backend writes state
  -> Browser WS confirms state transition
```

Do not scatter raw `fetch` calls or WebSocket handlers throughout feature
components. Keep transport in `shared/api` and `shared/realtime`.

## 8. First Feature Slices

Build the new frontend in vertical slices:

1. App shell, auth bootstrap, workspace/channel route frame.
2. Message list, composer, and browser WS message updates.
3. Approval cards and Backend `permission_resolution` workflow.
4. Bot settings, connector status, and Agent Bridge diagnostics.
5. Files, memory, docs, and admin/settings panels.

Approval cards should be early because they validate the most important boundary:
Backend decides the approver and sends `permission_resolution`; frontend only
renders and submits user intent.

## 9. Migration Rule

Until `frontend-next/` replaces `frontend/`:

- `frontend/` remains the legacy deployed frontend.
- new frontend architecture and new product surfaces go to `frontend-next/`.
- shared API contracts should be documented before copying old UI behavior.
- do not port legacy components blindly; rebuild feature-by-feature around the
  Rust Backend and Agent Bridge contracts.
