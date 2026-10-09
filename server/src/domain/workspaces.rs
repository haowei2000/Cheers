//! Workspace helpers. A workspace is either a shared `team` space or a per-user
//! `personal` space (the user's private area + the FK anchor for DMs they start).
//! See docs/arch/CONVERSATION_MODEL.md.

use uuid::Uuid;

use crate::errors::AppError;
use sqlx::PgPool;

/// Database-side result of removing a workspace member. Realtime subscription
/// revocation and notification fanout stay in the API layer, after commit.
pub struct DetachedWorkspaceMember {
    pub channel_ids: Vec<String>,
    pub invite_channel_ids: Vec<String>,
}

/// The user's personal workspace, creating it on first use (lazy provision — there is no
/// signup hook, and this also covers users that predate the personal-workspace concept).
/// Idempotent + race-safe via the `uq_workspaces_personal_owner` partial unique index.
pub async fn get_or_create_personal_workspace(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Uuid, AppError> {
    let uid = user_id.to_string();

    if let Some(existing) = sqlx::query_scalar!(
        "SELECT workspace_id FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal' LIMIT 1",
        &uid,
    )
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    {
        return parse_ws(existing);
    }

    // Create; on a concurrent winner, DO NOTHING returns no row → re-select the winner.
    let inserted = sqlx::query_scalar!(
        "INSERT INTO workspaces (workspace_id, name, kind, owner_user_id)
         VALUES ($1, 'Personal', 'personal', $2)
         ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING
         RETURNING workspace_id",
        Uuid::new_v4().to_string(),
        &uid,
    )
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?;

    if let Some(id) = inserted {
        return parse_ws(id);
    }

    let existing = sqlx::query_scalar!(
        "SELECT workspace_id FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal' LIMIT 1",
        &uid,
    )
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?;
    parse_ws(existing)
}

/// Decline a still-pending workspace invitation and consume any channel
/// invitations queued behind it. Keeping both deletes in one transaction makes
/// a stale decline harmless when another device has already accepted the
/// workspace invitation.
pub async fn decline_pending_invite(
    db: &PgPool,
    workspace_id: &str,
    user_id: &str,
) -> Result<Vec<String>, AppError> {
    let mut tx = db.begin().await.map_err(AppError::Db)?;
    let deleted = sqlx::query!(
        "DELETE FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 AND status = 'pending'",
        workspace_id,
        user_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?
    .rows_affected();
    if deleted == 0 {
        return Err(AppError::NotFound);
    }

    let channel_ids: Vec<String> = sqlx::query_scalar!(
        "SELECT ci.channel_id
         FROM channel_invites ci
         JOIN channels c ON c.channel_id = ci.channel_id
         WHERE ci.user_id = $1 AND c.workspace_id = $2",
        user_id,
        workspace_id,
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    sqlx::query!(
        "DELETE FROM channel_invites
         WHERE user_id = $1
           AND channel_id IN (SELECT channel_id FROM channels WHERE workspace_id = $2)",
        user_id,
        workspace_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    tx.commit().await.map_err(AppError::Db)?;

    Ok(channel_ids)
}

/// Remove a human's workspace-scoped access in one transaction.
///
/// Locking the workspace row serializes owner leaves/removals with role changes.
/// The second of two concurrent owner leaves therefore observes the first commit
/// and cannot remove the workspace's final active owner. Pending channel invites
/// are consumed in the same transaction so a crash cannot leave an invite that
/// becomes usable after the user later rejoins the workspace.
pub async fn detach_member(
    db: &PgPool,
    workspace_id: &str,
    user_id: &str,
) -> Result<DetachedWorkspaceMember, AppError> {
    let mut tx = db.begin().await.map_err(AppError::Db)?;

    let workspace_exists: Option<String> = sqlx::query_scalar!(
        "SELECT workspace_id FROM workspaces WHERE workspace_id = $1 FOR UPDATE",
        workspace_id,
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    if workspace_exists.is_none() {
        return Err(AppError::NotFound);
    }

    let membership = sqlx::query!(
        "SELECT role, status FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2",
        workspace_id,
        user_id,
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    let removing_active_owner = membership.as_ref().is_some_and(|row| {
        Some(row.role.clone()).as_deref() == Some("owner")
            && Some(row.status.clone()).as_deref() == Some("active")
    });
    if removing_active_owner {
        let owner_count: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "value!" FROM workspace_memberships
             WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'"#,
            workspace_id,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::Db)?;
        if owner_count <= 1 {
            return Err(AppError::Forbidden(
                "you are the last owner — transfer ownership or delete the workspace first".into(),
            ));
        }
    }

    let last_owned = sqlx::query!(
        "SELECT c.channel_id, c.name
         FROM channels c
         JOIN channel_memberships mine
           ON mine.channel_id = c.channel_id
          AND mine.member_id = $2 AND mine.member_type = 'user' AND mine.role = 'owner'
         WHERE c.workspace_id = $1 AND c.type <> 'dm' AND c.archived_at IS NULL
           AND NOT EXISTS (
               SELECT 1 AS present FROM channel_memberships other
               WHERE other.channel_id = c.channel_id AND other.member_type = 'user'
                 AND other.role = 'owner' AND other.member_id <> $2
           )",
        workspace_id,
        user_id,
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    if let Some(row) = last_owned.first() {
        let name: String = row.name.clone();
        return Err(AppError::Forbidden(format!(
            "transfer or delete #{name} before removing its last owner"
        )));
    }

    let channel_ids: Vec<String> = sqlx::query_scalar!(
        "SELECT cm.channel_id
         FROM channel_memberships cm
         JOIN channels c ON c.channel_id = cm.channel_id
         WHERE c.workspace_id = $1 AND c.type <> 'dm'
           AND cm.member_id = $2 AND cm.member_type = 'user'",
        workspace_id,
        user_id,
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    let invite_channel_ids: Vec<String> = sqlx::query_scalar!(
        "SELECT ci.channel_id FROM channel_invites ci
         JOIN channels c ON c.channel_id = ci.channel_id
         WHERE ci.user_id = $1 AND c.workspace_id = $2",
        user_id,
        workspace_id,
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(AppError::Db)?;

    sqlx::query!(
        "DELETE FROM approval_delegations ad
         USING channels c
         WHERE ad.channel_id = c.channel_id AND c.workspace_id = $1
           AND c.type <> 'dm' AND ad.user_id = $2",
        workspace_id,
        user_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    sqlx::query!(
        "DELETE FROM bot_event_access bea
         USING channels c
         WHERE bea.channel_id = c.channel_id AND c.workspace_id = $1
           AND c.type <> 'dm' AND bea.subject_kind = 'user' AND bea.subject_id = $2",
        workspace_id,
        user_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    sqlx::query!(
        "DELETE FROM channel_memberships cm
         USING channels c
         WHERE cm.channel_id = c.channel_id AND c.workspace_id = $1
           AND c.type <> 'dm' AND cm.member_id = $2 AND cm.member_type = 'user'",
        workspace_id,
        user_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    sqlx::query!(
        "DELETE FROM channel_invites
         WHERE user_id = $1
           AND channel_id IN (SELECT channel_id FROM channels WHERE workspace_id = $2)",
        user_id,
        workspace_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    sqlx::query!(
        "DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
        workspace_id,
        user_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    tx.commit().await.map_err(AppError::Db)?;

    Ok(DetachedWorkspaceMember {
        channel_ids,
        invite_channel_ids,
    })
}

fn parse_ws(s: String) -> Result<Uuid, AppError> {
    Uuid::parse_str(&s).map_err(|_| AppError::Internal("invalid workspace_id".into()))
}
