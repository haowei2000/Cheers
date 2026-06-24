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
