# Cross-platform item inventory

This ledger records the current migration state. `item-contract.json` is the
machine-readable source of truth; this file explains duplication and drift.

Status: **shared** uses the cross-platform anatomy, **partial** has a native
primitive but remaining local recipes, **legacy** is still feature-owned, and
**unavailable** means the product capability does not exist on that client.

| Family | Web | iOS | Android | Current drift / next migration |
|---|---|---|---|---|
| Presentation environment | shared | shared | shared | Explicit level overrides responsive/container defaults on every client. |
| Button | partial | partial | partial | Web `IconButton` is shared; direct controls are ratcheted and should migrate by semantic action. Native system buttons remain appropriate but feature-owned visual wrappers must move into primitives. |
| Choice / segmented selection | shared | partial | unavailable | Web `ChoiceGroup` owns radio semantics, roving focus, icon-text anatomy, and selected state. iOS currently uses platform toggles in channel creation but has no registered shared choice anatomy. |
| Input / search | shared | partial | partial | Web `Input`, `InputWithLeadingIcon`, and `SearchInput` own field anatomy, icon geometry, focus/error state, and mobile sizing. Native clients retain platform fields but still lack shared error/help slots. |
| Select / toggle | partial | legacy | legacy | Web primitives exist. Native clients correctly use system controls but do not yet share the registered field anatomy. |
| Menu / popover / dialog / sheet | partial | partial | partial | Preserve platform-native presentation. Normalize titles, actions, destructive state, and dismissal semantics next. |
| Chip / badge / presence | partial | partial | shared | Context chips migrated on Web; avatar and unread patterns already exist natively. Consolidate Web's remaining hand-written status chips. |
| User / member / friend | shared | shared | partial | Web and iOS identity, friend, member, candidate, blocked-user, and workspace-member rows use their shared entity anatomy. Friend management is unavailable on Android. |
| Bot / fleet bot | shared | shared | unavailable | Web and iOS Fleet, bot management, and bot pickers use shared entity/navigation anatomy. |
| Workspace | partial | partial | shared | Android workspace chips migrated. Web rail and iOS workspace menu retain platform-specific chrome but inherit the global level. |
| Channel / DM | shared | shared | shared | Web sidebar and both native conversation lists use the shared anatomy. |
| Voice channel | shared | partial | unavailable | Web channel rows and participant identity rows share navigation/entity anatomy. Android remains unavailable. |
| Message | shared | shared | shared | Message chrome reads the inherited level; minimal removes non-critical timestamps/details while preserving body, failed state, and approvals. |
| Reply / thread | partial | partial | unavailable | Thread-specific hierarchy remains feature-owned; migrate after the base message rollout settles. |
| System / tool / trace message | partial | partial | partial | System messages exist on all clients; tool/trace detail is unavailable on Android. Preserve approval/error state at every level. |
| Attachment / mention / typing / failed send | partial | partial | partial | Business behavior is aligned, but attachment anatomy and retry actions remain local. |
| Context bundle | partial | partial | unavailable | Web read-only Context chips use `ItemChip`; pending/removable chips and iOS context details are the next wave. |
| Session / task claim / approval | shared | shared | unavailable | Web and iOS pickers, claims, approvals, and Session controllers use shared navigation/operations anatomy. Approval is critical at every level. |
| Notification / invite | shared | shared | unavailable | Web and iOS use operations anatomy with critical state and primary/overflow actions. |
| Permission / grant / report | shared | partial | unavailable | Web repeated grants and reports use `OperationsItem` without DTO changes. |
| File / folder / diff | specialized | specialized | unavailable | Web and iOS use dedicated file-tree and diff-line items to preserve hierarchy, disclosure, text selection, and diff semantics. |
| Scene / ViewBoard / plan / audit / activity | shared | shared | unavailable | Web and iOS plan, session, audit, activity, template, and scene rows use workbench anatomy; panel containers remain native. No Android placeholders. |
| Loading / empty / error | partial | partial | partial | Web primitives exist; native screens still repeat local states. |
| Offline / degraded / confirmation / warning | partial | partial | partial | Critical state contract is shared; visual containers remain native. |

## Ratchet baseline

The validator prevents legacy direct-control counts from increasing. This is a
temporary migration ceiling, not permission to keep the old recipes. Every
follow-up item-family migration lowers the corresponding number in
`item-contract.json` and deletes the local implementation in the same change.
