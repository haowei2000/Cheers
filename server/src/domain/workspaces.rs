//! Workspace helpers. A workspace is either a shared `team` space or a per-user
//! `personal` space (the user's private area + the FK anchor for DMs they start).
//! See docs/arch/CONVERSATION_MODEL.md.

use uuid::Uuid;

use crate::errors::AppError;
use sqlx::PgPool;

/// The user's personal workspace, creating it on first use (lazy provision — there is no
/// signup hook, and this also covers users that predate the personal-workspace concept).
/// Idempotent + race-safe via the `uq_workspaces_personal_owner` partial unique index.
pub async fn get_or_create_personal_workspace(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Uuid, AppError> {
    let uid = user_id.to_string();

    if let Some(existing) = sqlx::query_scalar::<_, String>(
        "SELECT workspace_id FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal' LIMIT 1",
    )
    .bind(&uid)
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    {
        return parse_ws(existing);
    }

    // Create; on a concurrent winner, DO NOTHING returns no row → re-select the winner.
    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO workspaces (workspace_id, name, kind, owner_user_id)
         VALUES ($1, 'Personal', 'personal', $2)
         ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING
         RETURNING workspace_id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&uid)
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?;

    if let Some(id) = inserted {
        return parse_ws(id);
    }

    let existing = sqlx::query_scalar::<_, String>(
        "SELECT workspace_id FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal' LIMIT 1",
    )
    .bind(&uid)
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?;
    parse_ws(existing)
}

fn parse_ws(s: String) -> Result<Uuid, AppError> {
    Uuid::parse_str(&s).map_err(|_| AppError::Internal("invalid workspace_id".into()))
}

/// Channel invite ⇒ workspace membership (Slack semantics): pulling a user into a
/// channel of a TEAM workspace makes them an active member of that workspace, so
/// the channel lands under the workspace on their rail instead of being orphaned.
/// PERSONAL workspaces are deliberately excluded — they are private, unlisted, and
/// unjoinable by design, so a personal-space channel share stays a guest membership
/// (surfaced by the sidebar's "shared with you" section via `/channels?guest=true`).
/// Never downgrades: an existing member keeps their role; a pending invite is
/// activated (being added to a channel is a stronger signal than the invite).
pub async fn ensure_member_for_channel_invite<'e, E>(
    db: E,
    channel_id: &str,
    user_id: &str,
) -> Result<(), AppError>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         SELECT c.workspace_id, $2, 'member', 'active'
         FROM channels c
         JOIN workspaces w ON w.workspace_id = c.workspace_id
         WHERE c.channel_id = $1 AND w.kind <> 'personal'
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'active'",
    )
    .bind(channel_id)
    .bind(user_id)
    .execute(db)
    .await
    .map_err(AppError::Db)?;
    Ok(())
}
