//! Direct messages. A DM is NOT a separate subsystem — it's a `type='dm'` channel with
//! exactly two members, anchored in the initiator's personal workspace. Everything else
//! (messages, channel_seq, files, channel.* resources, sessions) reuses the channel
//! machinery. See docs/arch/CONVERSATION_MODEL.md.

use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::workspaces;
use crate::errors::AppError;

/// Canonical, order-independent key for the participant pair, so find-or-create dedups a
/// DM regardless of who starts it: members are tagged (`u:`/`b:`), sorted, and joined.
fn dm_key(me: Uuid, target_id: &str, target_is_bot: bool) -> String {
    let mut tags = vec![
        format!("u:{me}"),
        format!("{}:{target_id}", if target_is_bot { "b" } else { "u" }),
    ];
    tags.sort();
    tags.join("|")
}

async fn find_by_key(db: &PgPool, key: &str) -> Result<Option<Uuid>, AppError> {
    match sqlx::query_scalar::<_, String>(
        "SELECT channel_id FROM channels WHERE type = 'dm' AND dm_key = $1 LIMIT 1",
    )
    .bind(key)
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    {
        Some(s) => Uuid::parse_str(&s)
            .map(Some)
            .map_err(|_| AppError::Internal("invalid channel_id".into())),
        None => Ok(None),
    }
}

/// Find the DM between `me` (a user) and the target (user or bot), or create it. Idempotent
/// and race-safe via `uq_channels_dm_key`. Returns the dm channel's id.
pub async fn find_or_create_dm(
    db: &PgPool,
    me: Uuid,
    target_id: &str,
    target_is_bot: bool,
) -> Result<Uuid, AppError> {
    let target_id = target_id.trim();
    if target_id.is_empty() {
        return Err(AppError::BadRequest("target id required".into()));
    }
    if !target_is_bot && target_id == me.to_string() {
        return Err(AppError::BadRequest("cannot DM yourself".into()));
    }
    let key = dm_key(me, target_id, target_is_bot);

    if let Some(id) = find_by_key(db, &key).await? {
        return Ok(id); // reuse — no new workspace, no new members
    }

    // create, anchored to the initiator's personal workspace (FK anchor only; access is by
    // channel membership, so the other participant still reaches it).
    let ws = workspaces::get_or_create_personal_workspace(db, me).await?;
    let channel_id = Uuid::new_v4().to_string();
    let mut tx = db.begin().await.map_err(AppError::Db)?;
    let created = sqlx::query_scalar::<_, String>(
        "INSERT INTO channels (channel_id, workspace_id, name, type, dm_key)
         VALUES ($1, $2, '', 'dm', $3)
         ON CONFLICT (dm_key) WHERE type = 'dm' DO NOTHING
         RETURNING channel_id",
    )
    .bind(&channel_id)
    .bind(ws.to_string())
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::Db)?;

    let Some(channel_id) = created else {
        // lost a concurrent race — the winner created it with its members; re-select.
        tx.rollback().await.ok();
        return find_by_key(db, &key)
            .await?
            .ok_or_else(|| AppError::Internal("dm vanished after conflict".into()));
    };

    // both participants are members; user peers are 'owner' (symmetric), a bot is 'member'.
    sqlx::query(
        "INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by)
         VALUES ($1, $2, 'user', 'owner', $2) ON CONFLICT DO NOTHING",
    )
    .bind(&channel_id)
    .bind(me.to_string())
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    sqlx::query(
        "INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    )
    .bind(&channel_id)
    .bind(target_id)
    .bind(if target_is_bot { "bot" } else { "user" })
    .bind(if target_is_bot { "member" } else { "owner" })
    .bind(me.to_string())
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    tx.commit().await.map_err(AppError::Db)?;

    Uuid::parse_str(&channel_id).map_err(|_| AppError::Internal("invalid channel_id".into()))
}
