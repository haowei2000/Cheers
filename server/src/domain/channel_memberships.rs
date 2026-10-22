//! Atomic channel membership changes and their committed notification effects.
//!
//! Membership writers serialize independently of the channel's message clock:
//! locking `channels` here would invert claim completion's membership → seq order.

use sqlx::{PgPool, Postgres, Transaction};

use crate::errors::AppError;

#[derive(Clone, Copy)]
pub struct Actor<'a> {
    pub user_id: &'a str,
    pub platform_admin: bool,
}

pub struct NotificationResolution {
    pub user_id: String,
    pub dedupe_key: String,
}

pub struct DetachOutcome {
    pub notifications: Vec<NotificationResolution>,
}

/// Shared by membership writers before reading channel authority or invitations.
/// The fixed CHMB namespace is separate from single-key advisory locks used by
/// pairing. Hash collisions only serialize otherwise unrelated channel changes.
/// This does not validate channel existence or lock the message sequence row.
pub(crate) async fn lock_channel(
    tx: &mut Transaction<'_, Postgres>,
    channel_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::Executor::execute(
        &mut **tx,
        sqlx::query!(
            "SELECT pg_advisory_xact_lock(1128811842, hashtext($1))",
            channel_id,
        ),
    )
    .await?;
    Ok(())
}

async fn require_admin(
    tx: &mut Transaction<'_, Postgres>,
    channel_id: &str,
    actor: Actor<'_>,
) -> Result<Option<String>, AppError> {
    let role = sqlx::query_scalar!(
        "SELECT role FROM channel_memberships
         WHERE channel_id=$1 AND member_id=$2 AND member_type='user' FOR SHARE",
        channel_id,
        actor.user_id,
    )
    .fetch_optional(&mut **tx)
    .await?;
    if !actor.platform_admin && !matches!(role.as_deref(), Some("owner" | "admin")) {
        return Err(AppError::Forbidden("channel admin required".into()));
    }
    Ok(role)
}

async fn owner_count(
    tx: &mut Transaction<'_, Postgres>,
    channel_id: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "count!" FROM channel_memberships
           WHERE channel_id=$1 AND member_type='user' AND role='owner'"#,
        channel_id,
    )
    .fetch_one(&mut **tx)
    .await
}

enum DetachKind {
    Remove,
    Leave,
}

pub async fn remove_member(
    db: &PgPool,
    channel_id: &str,
    member_id: &str,
    actor: Actor<'_>,
) -> Result<DetachOutcome, AppError> {
    detach(db, channel_id, member_id, actor, DetachKind::Remove).await
}

pub async fn leave(
    db: &PgPool,
    channel_id: &str,
    actor: Actor<'_>,
) -> Result<DetachOutcome, AppError> {
    detach(db, channel_id, actor.user_id, actor, DetachKind::Leave).await
}

async fn detach(
    db: &PgPool,
    channel_id: &str,
    member_id: &str,
    actor: Actor<'_>,
    kind: DetachKind,
) -> Result<DetachOutcome, AppError> {
    let mut tx = db.begin().await?;
    lock_channel(&mut tx, channel_id).await?;
    if matches!(kind, DetachKind::Remove) {
        require_admin(&mut tx, channel_id, actor).await?;
    }
    let membership = sqlx::query!(
        "SELECT role,member_type FROM channel_memberships
         WHERE channel_id=$1 AND member_id=$2 FOR UPDATE",
        channel_id,
        member_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let channel = sqlx::query!(
        "SELECT type,archived_at FROM channels WHERE channel_id=$1",
        channel_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    match kind {
        DetachKind::Leave => {
            let membership = membership
                .as_ref()
                .filter(|membership| membership.member_type == "user")
                .ok_or(AppError::NotFound)?;
            if channel
                .as_ref()
                .is_some_and(|channel| channel.r#type == "dm")
            {
                return Err(AppError::BadRequest("cannot leave a direct message".into()));
            }
            if membership.role == "owner" && owner_count(&mut tx, channel_id).await? <= 1 {
                return Err(AppError::Forbidden(
                    "you are the last owner — transfer ownership or delete the channel first"
                        .into(),
                ));
            }
        }
        DetachKind::Remove => {
            let removing_active_owner = membership.as_ref().is_some_and(|membership| {
                membership.member_type == "user" && membership.role == "owner"
            }) && channel
                .as_ref()
                .is_some_and(|channel| channel.r#type != "dm" && channel.archived_at.is_none());
            if removing_active_owner && owner_count(&mut tx, channel_id).await? <= 1 {
                return Err(AppError::BadRequest(
                    "transfer channel ownership or delete the channel first".into(),
                ));
            }
        }
    }

    // Remove remains idempotent for an absent member/invitation, including a
    // platform admin's request for an already deleted channel.
    sqlx::query!(
        "DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2",
        channel_id,
        member_id,
    )
    .execute(&mut *tx)
    .await?;
    let user_invite = sqlx::query!(
        "DELETE FROM channel_invites WHERE channel_id=$1 AND user_id=$2 RETURNING user_id",
        channel_id,
        member_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let bot_invite = sqlx::query!(
        "DELETE FROM bot_channel_invites WHERE channel_id=$1 AND bot_id=$2 RETURNING owner_user_id",
        channel_id,
        member_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM approval_delegations WHERE channel_id=$1 AND user_id=$2",
        channel_id,
        member_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM bot_event_access
         WHERE channel_id=$1 AND subject_kind='user' AND subject_id=$2",
        channel_id,
        member_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut notifications = Vec::new();
    if let Some(invite) = user_invite {
        notifications.push(NotificationResolution {
            user_id: invite.user_id,
            dedupe_key: format!("channel:{channel_id}"),
        });
    }
    if let Some(invite) = bot_invite {
        notifications.push(NotificationResolution {
            user_id: invite.owner_user_id,
            dedupe_key: format!("bot-channel:{channel_id}:{member_id}"),
        });
    }
    Ok(DetachOutcome { notifications })
}

/// Role writes share detach's guard and re-read both actor and target after it.
pub async fn set_role(
    db: &PgPool,
    channel_id: &str,
    member_id: &str,
    role: &str,
    actor: Actor<'_>,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    lock_channel(&mut tx, channel_id).await?;
    let actor_role = require_admin(&mut tx, channel_id, actor).await?;
    if member_id == actor.user_id {
        return Err(AppError::BadRequest(
            "use leave or transfer ownership to change your own role".into(),
        ));
    }
    if !matches!(role, "owner" | "admin" | "member" | "readonly") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, member, or readonly".into(),
        ));
    }
    let member = sqlx::query!(
        "SELECT role,member_type FROM channel_memberships
         WHERE channel_id=$1 AND member_id=$2 FOR UPDATE",
        channel_id,
        member_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if member.member_type == "bot" {
        if !matches!(role, "member" | "readonly") {
            return Err(AppError::BadRequest(
                "a bot's channel role must be member or readonly".into(),
            ));
        }
        sqlx::query!(
            "UPDATE channel_memberships SET role=$3
             WHERE channel_id=$1 AND member_id=$2 AND member_type='bot'",
            channel_id,
            member_id,
            role,
        )
        .execute(&mut *tx)
        .await?;
    } else {
        if (role == "owner" || member.role == "owner")
            && !actor.platform_admin
            && actor_role.as_deref() != Some("owner")
        {
            return Err(AppError::Forbidden(
                "only an owner or a system admin can grant or change the owner role".into(),
            ));
        }
        if member.role == "owner" && role != "owner" && owner_count(&mut tx, channel_id).await? <= 1
        {
            return Err(AppError::Forbidden(
                "can't demote the last owner — promote another owner first".into(),
            ));
        }
        sqlx::Executor::execute(
            &mut *tx,
            sqlx::query_file!("queries/set_human_role.sql", channel_id, member_id, role),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
