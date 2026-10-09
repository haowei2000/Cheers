//! Direct messages are two-member `type='dm'` channels.  Their workspace is an
//! internal personal-workspace anchor only; access is always membership-driven.

use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::workspaces;
use crate::errors::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Participant {
    User(Uuid),
    Bot(Uuid),
}

impl Participant {
    fn id(self) -> Uuid {
        match self {
            Self::User(id) | Self::Bot(id) => id,
        }
    }

    fn member_type(self) -> &'static str {
        match self {
            Self::User(_) => "user",
            Self::Bot(_) => "bot",
        }
    }

    fn tag(self) -> String {
        format!(
            "{}:{}",
            if matches!(self, Self::Bot(_)) {
                "b"
            } else {
                "u"
            },
            self.id()
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub struct DmOpenResult {
    pub channel_id: Uuid,
    pub created: bool,
}

fn dm_key(a: Participant, b: Participant) -> Result<String, AppError> {
    if a == b {
        return Err(AppError::BadRequest("cannot DM yourself".into()));
    }
    if matches!((a, b), (Participant::Bot(_), Participant::Bot(_))) {
        return Err(AppError::BadRequest(
            "bot-to-bot DMs are not supported".into(),
        ));
    }
    let mut tags = [a.tag(), b.tag()];
    tags.sort();
    Ok(tags.join("|"))
}

async fn find_by_key(db: &PgPool, key: &str) -> Result<Option<Uuid>, AppError> {
    match sqlx::query_scalar!(
        "SELECT channel_id FROM channels WHERE type = 'dm' AND dm_key = $1 LIMIT 1",
        key,
    )
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    {
        Some(value) => Uuid::parse_str(&value)
            .map(Some)
            .map_err(|_| AppError::Internal("invalid channel_id".into())),
        None => Ok(None),
    }
}

pub async fn open_dm(
    db: &PgPool,
    initiator: Participant,
    target: Participant,
) -> Result<DmOpenResult, AppError> {
    let key = dm_key(initiator, target)?;
    if let Some(channel_id) = find_by_key(db, &key).await? {
        return Ok(DmOpenResult {
            channel_id,
            created: false,
        });
    }

    let anchor_user = match (initiator, target) {
        (Participant::User(user), _) | (_, Participant::User(user)) => user,
        _ => unreachable!("bot-bot rejected above"),
    };
    let workspace_id = workspaces::get_or_create_personal_workspace(db, anchor_user).await?;
    let proposed_channel_id = Uuid::new_v4();
    let mut tx = db.begin().await.map_err(AppError::Db)?;
    let created = sqlx::query_scalar!(
        "INSERT INTO channels (channel_id, workspace_id, name, type, dm_key)
         VALUES ($1, $2, '', 'dm', $3)
         ON CONFLICT (dm_key) WHERE type = 'dm' DO NOTHING
         RETURNING channel_id",
        proposed_channel_id.to_string(),
        workspace_id.to_string(),
        &key,
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::Db)?;

    let Some(channel_id) = created else {
        tx.rollback().await.ok();
        let channel_id = find_by_key(db, &key)
            .await?
            .ok_or_else(|| AppError::Internal("dm vanished after conflict".into()))?;
        return Ok(DmOpenResult {
            channel_id,
            created: false,
        });
    };

    for participant in [initiator, target] {
        sqlx::query!(
            "INSERT INTO channel_memberships
                (channel_id, member_id, member_type, role, added_by)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
            &channel_id,
            participant.id().to_string(),
            participant.member_type(),
            if matches!(participant, Participant::User(_)) {
                "owner"
            } else {
                "member"
            },
            initiator.id().to_string(),
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::Db)?;
    }
    tx.commit().await.map_err(AppError::Db)?;
    Ok(DmOpenResult {
        channel_id: Uuid::parse_str(&channel_id)
            .map_err(|_| AppError::Internal("invalid channel_id".into()))?,
        created: true,
    })
}

/// Compatibility wrapper for existing human REST callers and integration tests.
pub async fn find_or_create_dm(
    db: &PgPool,
    me: Uuid,
    target_id: &str,
    target_is_bot: bool,
) -> Result<Uuid, AppError> {
    let target = Uuid::parse_str(target_id)
        .map_err(|_| AppError::BadRequest("target id must be a uuid".into()))?;
    Ok(open_dm(
        db,
        Participant::User(me),
        if target_is_bot {
            Participant::Bot(target)
        } else {
            Participant::User(target)
        },
    )
    .await?
    .channel_id)
}
