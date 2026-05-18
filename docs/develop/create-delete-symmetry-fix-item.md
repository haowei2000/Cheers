# Create/Delete Symmetry Fix Item

> **Language**: English | [中文](create-delete-symmetry-fix-item.zh-CN.md)

## UX-DEL-001: Restore Deletion Paths For User-Created Resources

**Type**: UX + backend cleanup  
**Priority**: P1  
**Status**: Implemented  

## Problem

Several user-visible flows can create or upload resources but do not provide a matching delete, remove, or explicit retention path. This makes mistakes hard to undo and leaves stale data in file libraries, message history, avatar storage, and Agent Bridge observability views.

## Implemented Result

- Added file delete/unlink APIs and delete actions in the personal file library, channel Files panel, and file preview panel.
- Added message soft-delete/tombstone APIs with WebSocket client synchronization; normal messages, topics, and announcements now expose delete actions.
- Added user, Bot, and workspace avatar delete APIs; managed uploads delete the storage object, while external avatar URLs are only cleared.
- Added Agent Bridge Bot session close API and management UI.
- Added self-service account deactivation that clears email codes, keychain items, friendships, and managed avatar data while preserving message ownership references.

## Current Audit

Already covered:

- Workspaces: `POST/DELETE /api/v1/workspaces/{workspace_id}`
- Channels and channel members: `POST/DELETE /api/v1/channels`, `POST/DELETE /members`
- Bots, models, templates: create/update/delete routes and settings UI exist; built-in objects are intentionally protected.
- Memory entries and todos: create/update/delete routes and UI exist.
- Keychain, bulletin issues, friends and blocks: create/delete routes and UI exist.

Gaps confirmed before this fix:

| Area | Create path | Current delete gap |
|---|---|---|
| Uploaded files | `POST /api/v1/files/presign`, storage `PUT`, `POST /api/v1/files/{file_id}/confirm`; Agent Bridge file upload routes also create `FileRecord` rows | No `DELETE /api/v1/files/{file_id}` or unlink endpoint. File library and channel Files panel only preview/download. Pending composer attachments can be removed before send, but confirmed files cannot be removed by users. |
| Messages, topics, announcements, forwarded messages | `POST /api/v1/channels/{channel_id}/messages`, `/messages/forward`, announcement composer | No message delete/tombstone endpoint. Users can create mistaken posts, topics, announcements, and forwards but cannot remove them afterward. |
| Uploaded avatars | `POST /api/v1/avatars/users/me`, `/bots/{bot_id}`, `/workspaces/{workspace_id}` | UI Clear saves `avatar_url = null`, but there is no avatar delete endpoint and uploaded storage objects are not explicitly removed. |
| Agent Bridge sessions | Sessions are created/rotated by Agent Bridge scope mapping and visible in session panels | Admin UI can list sessions and refresh DM sessions, but cannot close or purge stale sessions directly. Treat as a policy decision before implementation. |
| User accounts | `POST /api/v1/auth/register` | No self-service account deletion/deactivation flow. Treat as a separate privacy/retention policy decision. |

## Proposed Scope

1. **Files**
   - Add a backend delete/unlink API for file records.
   - Allow uploader, channel admin, or system admin to remove a file from a personal library or channel scope.
   - Preserve message history safely: if the file is referenced by messages or multiple scopes, unlink from the current scope or show a clear conflict; hard-delete the physical object only when no active references remain.
   - Reuse or extract physical cleanup logic from `FileRetentionService`.
   - Add delete actions in the personal file library, channel Files panel, and file preview panel.

2. **Messages**
   - Add `DELETE /api/v1/channels/{channel_id}/messages/{msg_id}`.
   - Prefer soft deletion/tombstones over hard deletion so replies, topics, unread counts, history pages, and bot traces do not break.
   - Permission rule: sender can delete own messages; channel admin/system admin can delete any non-system message. Decide whether bot messages can be deleted by bot owner or channel admin.
   - Broadcast a message-updated/deleted event over WebSocket and update the frontend message store.
   - Add UI delete affordances for normal messages, topic roots/replies, announcements, and forwarded bundles.

3. **Avatars**
   - Add `DELETE /api/v1/avatars/users/me`, `/bots/{bot_id}`, and `/workspaces/{workspace_id}`.
   - Use the same permission checks as upload.
   - Clear `avatar_url` and delete the fixed avatar object from storage when the current URL points at the managed avatar route.
   - Update existing Clear buttons to call the delete endpoint for managed uploads and keep URL clearing for external image URLs.

4. **Implemented Policy**
   - Agent Bridge sessions use a "Close session" action: closed sessions are marked `closed`, active scope bindings are detached, and audit history is retained.
   - Accounts use deactivation: personal sensitive data is cleared and login is blocked while message rows retain tombstone-style ownership references.

5. **Documentation**
   - Update user/admin manuals to describe delete behavior, permission limits, and retention exceptions.

## Acceptance Criteria

- Every user-visible create/upload action either has a matching delete/remove action or an explicit documented exception.
- Delete actions use confirmation for destructive operations and show success/failure feedback.
- Backend permission checks are covered by tests for owner/uploader, channel admin, system admin, and unrelated users.
- File deletion does not leave broken message rendering or orphaned storage objects.
- Message deletion preserves conversation structure through tombstones and updates clients in real time.
- Avatar deletion clears both database URL state and managed storage objects.
