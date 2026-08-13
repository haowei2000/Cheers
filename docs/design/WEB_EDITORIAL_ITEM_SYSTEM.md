# Cheers Web Editorial Item System

> Status: current Web design contract. Updated 2026-08-13.
>
> This document is the source of truth for reusable Web item anatomy, typography,
> controls, text overflow, message operational state, and ViewBoard Audit. Product
> capability documents may add domain data requirements, but must not redefine
> these visual and interaction rules.

## Scope and ownership

This contract applies to Web production surfaces, Component Gallery, and static
website UI where the rule is relevant. It does not change server DTOs, APIs, or
routes. React implements the contract with shared primitives; iOS and Android
use the same semantics with native platform components.

Related documents:

- [Message Trace Experience](MESSAGE_TRACE_EXPERIENCE.md): durable trace data,
  event detail and accessibility.
- [Tool Presentation](TOOL_PRESENTATION.md): gateway-owned tool classification.
- [Resource Context](RESOURCE_CONTEXT.md): context resource semantics.

## Foundation

### Typography

Only four font-size tokens are allowed in product UI:

| Token | px | Typical use |
| --- | ---: | --- |
| `minimal` | 10 | timestamps, counts, internal identifiers |
| `compact` | 12 | secondary metadata, section labels, status |
| `regular` | 14 | controls, item titles, navigation, utility UI |
| `comfortable` | 16 | readable long-form and major labels |

- `display` font: product introduction and mastheads only.
- `reading` font: message body and sustained prose; it must not turn metadata,
  bot/channel names, controls, tracing, warnings, or identifiers into headings.
- `utility` font: all operational UI, including button labels, names, status,
  forms, paths, tracing, and warnings.
- No dense-panel, Diff, code, Workbench, or tracing exception may introduce a
  fifth font-size token.

### Geometry and colour

- Standard rectangular surfaces use `4px` (`rounded-sm`) corners.
- Resting surfaces are borderless. Use fill, whitespace, selected state, focus
  ring, or directional hairlines where separation is necessary.
- `rounded-full` is reserved for identity, presence, unread, progress, and drag
  semantics; it is not a generic container style.
- Green means a successful or allowed outcome, amber means action is pending,
  red means a failure or denial, and indigo is reserved for focus/selection.

## Controls

`ControlSize` is fixed and refers to hit-area height, not font size:

| Size | Height | Typical use |
| --- | ---: | --- |
| `compact` | 28px | dense auxiliary control |
| `regular` | 36px | default control and list action |
| `comfortable` | 44px | touch-first or primary interaction |

All Button labels use the shared `regular` utility type token, regardless of
control height. A control must not override its shared height, font size, width,
or horizontal padding locally.

### Button contract

Buttons have three content forms and three approved width slots:

| Form | Width | Rule |
| --- | --- | --- |
| `icon` | square | icon only; accessible label is required |
| `text` | medium text slot | short ActionKey label |
| `iconText` | wide text slot | icon square and text area are separate slots |

- Actions use the shared `ActionKey` label dictionary. Object names, counts, and
  long context belong in an adjacent status or `aria-label`, never in the label.
- Button text must not wrap, ellipsize, or determine width.
- Navigation, tabs, selectors, menus, inline links, and disclosures are not
  actions. They use `ControlTrigger`, `TabOption`, `MenuOption`, an inline link,
  or the relevant native semantic primitive.
- An edit/save operation belongs beside the object being edited and uses an
  `IconButton` where a concise object-local action is appropriate. Whole-form
  submission is the only allowed detached save action.

## Items and collections

An ordinary browse item is one line. Its priority is:

`leading → title → critical status → optional status → actions`

- Leading identity, critical status, and actions never shrink.
- Title consumes remaining width.
- Optional status leaves the row before a critical state or action is hidden.
- Management collections use `ItemList` / `ItemSection` / `CollectionManager`:
  search, add, one-line item, object-local edit/delete, and explicit empty state.
- Sidebar headings such as Channels and Direct Messages are text separators, not
  disclosure buttons. Selected destinations have a visible selected state.
- Tables, file trees, diff lines, canvas nodes, and code editors retain their
  native structure but consume the same typography, density, focus, and colour
  tokens.

## Text overflow

`OverflowText` is the shared solution for operational text.

- Single-line titles, paths, IDs, and session labels may visually truncate only
  after real overflow is detected; hover/focus reveals full text and touch gets
  an information disclosure.
- Explanations, errors, and field labels wrap.
- Commands, IDs, and paths use a horizontal-scroll or expanded detail view when
  their exact content is required.
- Buttons, tabs, and action labels never truncate. A narrow tab uses an approved
  short label or horizontal navigation rather than a second line or ellipsis.

## Messages, tracing, and approvals

The message surface has a fixed hierarchy:

`message body → current operational state → message actions`

- Chat and Discussion share the same avatar/identity anatomy. The identity rail
  uses utility type and does not duplicate Bot labels or timestamps.
- Workspace paths and message references render as readable, clickable inline
  references; they must not be replaced by generic `Open` buttons.
- Message body uses reading type; status, trace, command, and controls use
  utility type.

### Trace ownership

There are two intentionally different trace surfaces:

| Surface | Content |
| --- | --- |
| Message inline | only the latest running step and unresolved approval |
| Message Record | complete durable trace history, failures, input/output and audit evidence |

Completed, non-actionable history must not appear under the message and in the
Message Record at the same time. A pending approval is never hidden.

### Approval presentation

When an approval is pending, it is the single highest-priority message state:

- Inline view: operation summary, one-line command, and the ACP-provided direct
  options (for example Allow once, Always allow, Deny).
- Do not add a second Approve/Reject confirmation layer.
- Do not repeat tool title, impact explanation, option descriptions, diff, or an
  earlier failure beneath the same message. Full evidence belongs in Message
  Record/detail.
- If no approval is pending, a failed state may appear inline with a compact
  Message Record icon action.

## ViewBoard Audit

Audit is an operational timeline, not a stack of expanded cards.

- A default row is one line: `outcome icon · actor · concrete operation summary
  · time · disclosure`.
- The concrete command, file, or tool summary is the title; generic permission
  labels and raw option values are secondary details.
- Only one detail row is open at a time (accordion). The newest record may be
  opened by an explicit user choice; the list must not default to every record
  expanded.
- Detail contains exact command, paths, cwd, request ID, and raw decision only
  when needed for review.
- Jumping to the source message uses an icon link with an accessible label, not
  an `Open` action button. Disclosure is one icon control, not a separate arrow
  plus `Collapse` text button.
- ViewBoard navigation remains on one horizontal rail; narrow layouts scroll or
  use an overflow menu and never wrap a board tab onto a second line.
- Audit has one header. Refresh is an icon action in that header rather than a
  competing text button.

## Enforcement and verification

The design-system scanner is the regression guard. It rejects unregistered
control geometry, typography, local button overrides, ordinary resting borders,
unapproved full rounding, detached edits, direct business-native controls, and
ActionKey violations. Component Gallery covers control sizes, presentation
levels, long text, interaction state, and touch/keyboard disclosure.

Before release, verify at 390px, 768px, 1280px, and 200% zoom; test keyboard
focus, Escape, screen-reader labels, Dynamic Type equivalents on mobile, and
44px touch targets where interaction is touch-first.
