//! Durable scheduled channel messages and their execution lifecycle.

use chrono::{DateTime, Duration, NaiveTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    app_state::AppState,
    domain::messages::{create_message, CreateMessageParams},
    errors::AppError,
};

pub const MIN_INTERVAL_MINUTES: i32 = 5;
pub const MAX_INTERVAL_MINUTES: i32 = 7 * 24 * 60;
const MAX_CONTENT_CHARS: usize = 4_000;
const MAX_TITLE_CHARS: usize = 120;
const MAX_MENTIONS: usize = 16;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleInput {
    pub kind: String,
    #[serde(default)]
    pub run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub every_minutes: Option<i32>,
    #[serde(default)]
    pub start_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub local_time: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledMessageInput {
    pub title: String,
    pub channel_id: Uuid,
    pub content: String,
    #[serde(default)]
    pub mention_ids: Vec<Uuid>,
    pub schedule: ScheduleInput,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default)]
    pub source_extension_id: Option<String>,
    #[serde(default)]
    pub source_automation_id: Option<String>,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDto {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_minutes: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledMessageDto {
    pub id: String,
    pub title: String,
    pub channel_id: String,
    pub channel_name: String,
    pub content: String,
    pub mention_ids: Vec<String>,
    pub schedule: ScheduleDto,
    pub next_run_at: Option<DateTime<Utc>>,
    pub enabled: bool,
    pub source_extension_id: Option<String>,
    pub source_automation_id: Option<String>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub consecutive_failures: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledMessageRunDto {
    pub id: String,
    pub scheduled_for: DateTime<Utc>,
    pub trigger: String,
    pub status: String,
    pub message_id: Option<String>,
    pub error: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct NormalizedSchedule {
    kind: &'static str,
    run_at: Option<DateTime<Utc>>,
    interval_minutes: Option<i32>,
    local_time: Option<NaiveTime>,
    timezone: Option<String>,
    next_run_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct ClaimedTask {
    pub id: String,
    pub created_by: Uuid,
    pub channel_id: Uuid,
    pub content: String,
    pub mention_ids: Vec<Uuid>,
    pub schedule_kind: String,
    pub interval_minutes: Option<i32>,
    pub local_time: Option<NaiveTime>,
    pub timezone: Option<String>,
    pub scheduled_for: DateTime<Utc>,
}

async fn normalize_schedule(
    db: &PgPool,
    input: &ScheduleInput,
    enabled: bool,
) -> Result<NormalizedSchedule, AppError> {
    let now = Utc::now();
    match input.kind.as_str() {
        "once" => {
            let run_at = input
                .run_at
                .ok_or_else(|| AppError::BadRequest("once schedule requires runAt".into()))?;
            if input.every_minutes.is_some()
                || input.start_at.is_some()
                || input.local_time.is_some()
                || input.timezone.is_some()
            {
                return Err(AppError::BadRequest(
                    "once schedule does not accept everyMinutes or startAt".into(),
                ));
            }
            if enabled && run_at <= now {
                return Err(AppError::BadRequest("runAt must be in the future".into()));
            }
            Ok(NormalizedSchedule {
                kind: "once",
                run_at: Some(run_at),
                interval_minutes: None,
                local_time: None,
                timezone: None,
                next_run_at: enabled.then_some(run_at),
            })
        }
        "interval" => {
            let every = input.every_minutes.ok_or_else(|| {
                AppError::BadRequest("interval schedule requires everyMinutes".into())
            })?;
            if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&every) {
                return Err(AppError::BadRequest(format!(
                    "everyMinutes must be between {MIN_INTERVAL_MINUTES} and {MAX_INTERVAL_MINUTES}"
                )));
            }
            if input.run_at.is_some() || input.local_time.is_some() || input.timezone.is_some() {
                return Err(AppError::BadRequest(
                    "interval schedule does not accept runAt".into(),
                ));
            }
            let first = input
                .start_at
                .unwrap_or_else(|| now + Duration::minutes(i64::from(every)));
            if enabled && first <= now {
                return Err(AppError::BadRequest("startAt must be in the future".into()));
            }
            Ok(NormalizedSchedule {
                kind: "interval",
                run_at: None,
                interval_minutes: Some(every),
                local_time: None,
                timezone: None,
                next_run_at: enabled.then_some(first),
            })
        }
        "daily" => {
            if input.run_at.is_some() || input.every_minutes.is_some() || input.start_at.is_some() {
                return Err(AppError::BadRequest(
                    "daily schedule only accepts localTime and timezone".into(),
                ));
            }
            let local_time_text = input
                .local_time
                .as_deref()
                .ok_or_else(|| AppError::BadRequest("daily schedule requires localTime".into()))?;
            let local_time = NaiveTime::parse_from_str(local_time_text, "%H:%M")
                .map_err(|_| AppError::BadRequest("localTime must use HH:MM".into()))?;
            let timezone = input
                .timezone
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 64)
                .ok_or_else(|| AppError::BadRequest("daily schedule requires timezone".into()))?
                .to_string();
            let next_run_at = if enabled {
                Some(next_daily_run(db, local_time, &timezone).await?)
            } else {
                validate_timezone(db, &timezone).await?;
                None
            };
            Ok(NormalizedSchedule {
                kind: "daily",
                run_at: None,
                interval_minutes: None,
                local_time: Some(local_time),
                timezone: Some(timezone),
                next_run_at,
            })
        }
        _ => Err(AppError::BadRequest(
            "schedule kind must be once, interval, or daily".into(),
        )),
    }
}

async fn validate_timezone(db: &PgPool, timezone: &str) -> Result<(), AppError> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
            .bind(timezone)
            .fetch_one(db)
            .await?;
    if exists {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "unknown IANA timezone `{timezone}`"
        )))
    }
}

pub async fn next_daily_run(
    db: &PgPool,
    local_time: NaiveTime,
    timezone: &str,
) -> Result<DateTime<Utc>, AppError> {
    validate_timezone(db, timezone).await?;
    sqlx::query_scalar(
        "SELECT CASE
           WHEN ((CURRENT_DATE + $2::time) AT TIME ZONE $1) > NOW()
             THEN ((CURRENT_DATE + $2::time) AT TIME ZONE $1)
           ELSE (((CURRENT_DATE + 1) + $2::time) AT TIME ZONE $1)
         END",
    )
    .bind(timezone)
    .bind(local_time)
    .fetch_one(db)
    .await
    .map_err(AppError::Db)
}

fn validate_input(input: &ScheduledMessageInput) -> Result<(), AppError> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::BadRequest(
            "title must be between 1 and 120 characters".into(),
        ));
    }
    let content = input.content.trim();
    if content.is_empty() || content.chars().count() > MAX_CONTENT_CHARS {
        return Err(AppError::BadRequest(
            "content must be between 1 and 4000 characters".into(),
        ));
    }
    if input.mention_ids.len() > MAX_MENTIONS {
        return Err(AppError::BadRequest(format!(
            "a scheduled message may mention at most {MAX_MENTIONS} members"
        )));
    }
    let mut unique = input.mention_ids.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != input.mention_ids.len() {
        return Err(AppError::BadRequest(
            "mentionIds contains duplicates".into(),
        ));
    }
    if input.source_extension_id.is_some() != input.source_automation_id.is_some() {
        return Err(AppError::BadRequest(
            "sourceExtensionId and sourceAutomationId must be provided together".into(),
        ));
    }
    let extension_id = Regex::new(r"^[a-z0-9][a-z0-9._-]{0,63}$").expect("static id regex");
    for (kind, value) in [
        ("sourceExtensionId", input.source_extension_id.as_deref()),
        ("sourceAutomationId", input.source_automation_id.as_deref()),
    ] {
        if value.is_some_and(|id| !extension_id.is_match(id)) {
            return Err(AppError::BadRequest(format!("invalid {kind}")));
        }
    }
    Ok(())
}

async fn authorize_targets(
    state: &AppState,
    user_id: Uuid,
    input: &ScheduledMessageInput,
) -> Result<(), AppError> {
    let is_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM channel_memberships
         WHERE channel_id=$1 AND member_id=$2 AND member_type='user')",
    )
    .bind(input.channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_one(&state.db)
    .await?;
    if !is_member {
        return Err(AppError::Forbidden("not a channel member".into()));
    }
    for mention_id in &input.mention_ids {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM channel_memberships
             WHERE channel_id=$1 AND member_id=$2)",
        )
        .bind(input.channel_id.to_string())
        .bind(mention_id.to_string())
        .fetch_one(&state.db)
        .await?;
        if !exists {
            return Err(AppError::BadRequest(format!(
                "mentioned member {mention_id} is not in the channel"
            )));
        }
    }
    crate::api::compliance::ensure_message_consents(
        state,
        &user_id.to_string(),
        input.channel_id,
        &input.mention_ids,
        &[],
        None,
    )
    .await
}

pub async fn create(
    state: &AppState,
    user_id: Uuid,
    input: ScheduledMessageInput,
) -> Result<ScheduledMessageDto, AppError> {
    validate_input(&input)?;
    authorize_targets(state, user_id, &input).await?;
    let schedule = normalize_schedule(&state.db, &input.schedule, input.enabled).await?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO scheduled_messages
         (task_id,created_by,channel_id,title,content,mention_ids,schedule_kind,
          run_at,interval_minutes,local_time,timezone,next_run_at,enabled,
          source_extension_id,source_automation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    )
    .bind(&id)
    .bind(user_id.to_string())
    .bind(input.channel_id.to_string())
    .bind(input.title.trim())
    .bind(input.content.trim())
    .bind(serde_json::json!(input
        .mention_ids
        .iter()
        .map(Uuid::to_string)
        .collect::<Vec<_>>()))
    .bind(schedule.kind)
    .bind(schedule.run_at)
    .bind(schedule.interval_minutes)
    .bind(schedule.local_time)
    .bind(schedule.timezone)
    .bind(schedule.next_run_at)
    .bind(input.enabled)
    .bind(input.source_extension_id)
    .bind(input.source_automation_id)
    .execute(&state.db)
    .await?;
    get(&state.db, user_id, &id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn update(
    state: &AppState,
    user_id: Uuid,
    id: &str,
    input: ScheduledMessageInput,
) -> Result<ScheduledMessageDto, AppError> {
    validate_input(&input)?;
    authorize_targets(state, user_id, &input).await?;
    let schedule = normalize_schedule(&state.db, &input.schedule, input.enabled).await?;
    let result = sqlx::query(
        "UPDATE scheduled_messages SET channel_id=$3,title=$4,content=$5,mention_ids=$6,
         schedule_kind=$7,run_at=$8,interval_minutes=$9,local_time=$10,timezone=$11,
         next_run_at=$12,enabled=$13,source_extension_id=$14,source_automation_id=$15,
         lease_until=NULL,last_error=NULL,
         consecutive_failures=0,updated_at=NOW()
         WHERE task_id=$1 AND created_by=$2",
    )
    .bind(id)
    .bind(user_id.to_string())
    .bind(input.channel_id.to_string())
    .bind(input.title.trim())
    .bind(input.content.trim())
    .bind(serde_json::json!(input
        .mention_ids
        .iter()
        .map(Uuid::to_string)
        .collect::<Vec<_>>()))
    .bind(schedule.kind)
    .bind(schedule.run_at)
    .bind(schedule.interval_minutes)
    .bind(schedule.local_time)
    .bind(schedule.timezone)
    .bind(schedule.next_run_at)
    .bind(input.enabled)
    .bind(input.source_extension_id)
    .bind(input.source_automation_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    get(&state.db, user_id, id).await?.ok_or(AppError::NotFound)
}

pub async fn list(db: &PgPool, user_id: Uuid) -> Result<Vec<ScheduledMessageDto>, AppError> {
    let rows = sqlx::query(
        "SELECT s.*,c.name AS channel_name FROM scheduled_messages s
         JOIN channels c ON c.channel_id=s.channel_id
         WHERE s.created_by=$1 ORDER BY s.enabled DESC,s.next_run_at NULLS LAST,s.created_at DESC",
    )
    .bind(user_id.to_string())
    .fetch_all(db)
    .await?;
    rows.into_iter().map(row_to_dto).collect()
}

pub async fn get(
    db: &PgPool,
    user_id: Uuid,
    id: &str,
) -> Result<Option<ScheduledMessageDto>, AppError> {
    let row = sqlx::query(
        "SELECT s.*,c.name AS channel_name FROM scheduled_messages s
         JOIN channels c ON c.channel_id=s.channel_id
         WHERE s.task_id=$1 AND s.created_by=$2",
    )
    .bind(id)
    .bind(user_id.to_string())
    .fetch_optional(db)
    .await?;
    row.map(row_to_dto).transpose()
}

pub async fn delete(db: &PgPool, user_id: Uuid, id: &str) -> Result<bool, AppError> {
    Ok(
        sqlx::query("DELETE FROM scheduled_messages WHERE task_id=$1 AND created_by=$2")
            .bind(id)
            .bind(user_id.to_string())
            .execute(db)
            .await?
            .rows_affected()
            > 0,
    )
}

pub async fn list_runs(
    db: &PgPool,
    user_id: Uuid,
    id: &str,
) -> Result<Vec<ScheduledMessageRunDto>, AppError> {
    let owns_task: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM scheduled_messages WHERE task_id=$1 AND created_by=$2)",
    )
    .bind(id)
    .bind(user_id.to_string())
    .fetch_one(db)
    .await?;
    if !owns_task {
        return Err(AppError::NotFound);
    }
    let rows = sqlx::query(
        "SELECT r.* FROM scheduled_message_runs r
         JOIN scheduled_messages s ON s.task_id=r.task_id
         WHERE r.task_id=$1 AND s.created_by=$2 ORDER BY r.started_at DESC LIMIT 50",
    )
    .bind(id)
    .bind(user_id.to_string())
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(ScheduledMessageRunDto {
                id: row.try_get("run_id")?,
                scheduled_for: row.try_get("scheduled_for")?,
                trigger: row.try_get("trigger")?,
                status: row.try_get("status")?,
                message_id: row.try_get("message_id")?,
                error: row.try_get("error")?,
                started_at: row.try_get("started_at")?,
                finished_at: row.try_get("finished_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::Db)
}

fn row_to_dto(row: sqlx::postgres::PgRow) -> Result<ScheduledMessageDto, AppError> {
    let mention_value: Value = row.try_get("mention_ids")?;
    let mention_ids = serde_json::from_value::<Vec<String>>(mention_value)
        .map_err(|error| AppError::Internal(format!("invalid stored mention_ids: {error}")))?;
    let kind: String = row.try_get("schedule_kind")?;
    Ok(ScheduledMessageDto {
        id: row.try_get("task_id")?,
        title: row.try_get("title")?,
        channel_id: row.try_get("channel_id")?,
        channel_name: row.try_get("channel_name")?,
        content: row.try_get("content")?,
        mention_ids,
        schedule: ScheduleDto {
            kind,
            run_at: row.try_get("run_at")?,
            every_minutes: row.try_get("interval_minutes")?,
            local_time: row
                .try_get::<Option<NaiveTime>, _>("local_time")?
                .map(|time| time.format("%H:%M").to_string()),
            timezone: row.try_get("timezone")?,
        },
        next_run_at: row.try_get("next_run_at")?,
        enabled: row.try_get("enabled")?,
        source_extension_id: row.try_get("source_extension_id")?,
        source_automation_id: row.try_get("source_automation_id")?,
        last_run_at: row.try_get("last_run_at")?,
        last_error: row.try_get("last_error")?,
        consecutive_failures: row.try_get("consecutive_failures")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub async fn claim_due(db: &PgPool) -> Result<Vec<ClaimedTask>, AppError> {
    let rows = sqlx::query(
        "WITH due AS (
           SELECT task_id FROM scheduled_messages
           WHERE enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at<=NOW()
             AND (lease_until IS NULL OR lease_until<NOW())
           ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 20
         )
         UPDATE scheduled_messages s SET lease_until=NOW()+INTERVAL '2 minutes'
         FROM due WHERE s.task_id=due.task_id
         RETURNING s.task_id,s.created_by,s.channel_id,s.content,s.mention_ids,
                   s.schedule_kind,s.interval_minutes,s.local_time,s.timezone,s.next_run_at",
    )
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            let mention_value: Value = row.try_get("mention_ids")?;
            let mention_ids = serde_json::from_value::<Vec<String>>(mention_value)
                .map_err(|error| {
                    AppError::Internal(format!("invalid stored mention_ids: {error}"))
                })?
                .into_iter()
                .map(|id| {
                    Uuid::parse_str(&id).map_err(|error| {
                        AppError::Internal(format!("invalid stored mention id: {error}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let created_by: String = row.try_get("created_by")?;
            let channel_id: String = row.try_get("channel_id")?;
            Ok(ClaimedTask {
                id: row.try_get("task_id")?,
                created_by: Uuid::parse_str(&created_by)
                    .map_err(|error| AppError::Internal(format!("invalid task owner: {error}")))?,
                channel_id: Uuid::parse_str(&channel_id).map_err(|error| {
                    AppError::Internal(format!("invalid task channel: {error}"))
                })?,
                content: row.try_get("content")?,
                mention_ids,
                schedule_kind: row.try_get("schedule_kind")?,
                interval_minutes: row.try_get("interval_minutes")?,
                local_time: row.try_get("local_time")?,
                timezone: row.try_get("timezone")?,
                scheduled_for: row.try_get("next_run_at")?,
            })
        })
        .collect()
}

fn next_interval_run(
    scheduled_for: DateTime<Utc>,
    every_minutes: i32,
    now: DateTime<Utc>,
) -> DateTime<Utc> {
    let step_seconds = i64::from(every_minutes) * 60;
    let elapsed = (now - scheduled_for).num_seconds().max(0);
    let steps = elapsed / step_seconds + 1;
    scheduled_for + Duration::seconds(step_seconds * steps)
}

async fn finish_schedule(
    db: &PgPool,
    task: &ClaimedTask,
    result: &Result<String, AppError>,
) -> Result<(), AppError> {
    let next = match task.schedule_kind.as_str() {
        "interval" => task
            .interval_minutes
            .map(|minutes| next_interval_run(task.scheduled_for, minutes, Utc::now())),
        "daily" => Some(
            next_daily_run(
                db,
                task.local_time
                    .ok_or_else(|| AppError::Internal("daily task is missing local_time".into()))?,
                task.timezone
                    .as_deref()
                    .ok_or_else(|| AppError::Internal("daily task is missing timezone".into()))?,
            )
            .await?,
        ),
        _ => None,
    };
    match result {
        Ok(_) => {
            sqlx::query(
                "UPDATE scheduled_messages SET next_run_at=$2,enabled=$3,lease_until=NULL,
                 last_run_at=NOW(),last_error=NULL,consecutive_failures=0,updated_at=NOW()
                 WHERE task_id=$1",
            )
            .bind(&task.id)
            .bind(next)
            .bind(next.is_some())
            .execute(db)
            .await?;
        }
        Err(error) => {
            let message = error.to_string();
            sqlx::query(
                "UPDATE scheduled_messages SET next_run_at=$2,enabled=$3,lease_until=NULL,
                 last_run_at=NOW(),last_error=$4,consecutive_failures=consecutive_failures+1,
                 updated_at=NOW() WHERE task_id=$1",
            )
            .bind(&task.id)
            .bind(next)
            .bind(next.is_some())
            .bind(message.chars().take(500).collect::<String>())
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

async fn execute(state: &AppState, task: &ClaimedTask, trigger: &str) -> Result<String, AppError> {
    crate::api::compliance::ensure_message_consents(
        state,
        &task.created_by.to_string(),
        task.channel_id,
        &task.mention_ids,
        &[],
        None,
    )
    .await?;
    let message = create_message(
        &state.db,
        &state.fanout,
        &state.stream_registry,
        &state.bot_locator,
        CreateMessageParams {
            user_id: task.created_by,
            channel_id: task.channel_id,
            content: task.content.clone(),
            msg_type: Some("text".into()),
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: task.mention_ids.clone(),
            mention_names: vec![],
            session_id: None,
            context_bundle: None,
        },
    )
    .await?;
    tracing::info!(task_id=%task.id, message_id=%message.msg_id, trigger, "scheduled message sent");
    Ok(message.msg_id)
}

pub async fn execute_claimed(state: &AppState, task: ClaimedTask) -> Result<(), AppError> {
    let run_id = Uuid::new_v4().to_string();
    let inserted = sqlx::query(
        "INSERT INTO scheduled_message_runs
         (run_id,task_id,scheduled_for,trigger,status) VALUES ($1,$2,$3,'schedule','running')
         ON CONFLICT (task_id,scheduled_for,trigger) DO NOTHING",
    )
    .bind(&run_id)
    .bind(&task.id)
    .bind(task.scheduled_for)
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted == 0 {
        let interrupted = AppError::Internal(
            "a previous scheduled-message run was interrupted; skipped to prevent a duplicate"
                .into(),
        );
        sqlx::query(
            "UPDATE scheduled_message_runs SET status='failed',error=$4,finished_at=NOW()
             WHERE task_id=$1 AND scheduled_for=$2 AND trigger=$3 AND status='running'",
        )
        .bind(&task.id)
        .bind(task.scheduled_for)
        .bind("schedule")
        .bind(interrupted.to_string())
        .execute(&state.db)
        .await?;
        finish_schedule(&state.db, &task, &Err(interrupted)).await?;
        return Ok(());
    }
    let result = execute(state, &task, "schedule").await;
    match &result {
        Ok(message_id) => {
            sqlx::query(
                "UPDATE scheduled_message_runs SET status='succeeded',message_id=$2,
                 finished_at=NOW() WHERE run_id=$1",
            )
            .bind(&run_id)
            .bind(message_id)
            .execute(&state.db)
            .await?;
        }
        Err(error) => {
            sqlx::query(
                "UPDATE scheduled_message_runs SET status='failed',error=$2,
                 finished_at=NOW() WHERE run_id=$1",
            )
            .bind(&run_id)
            .bind(error.to_string().chars().take(500).collect::<String>())
            .execute(&state.db)
            .await?;
        }
    }
    finish_schedule(&state.db, &task, &result).await?;
    result.map(|_| ())
}

pub async fn run_now(state: &AppState, user_id: Uuid, id: &str) -> Result<String, AppError> {
    let row = sqlx::query(
        "SELECT task_id,created_by,channel_id,content,mention_ids,schedule_kind,
                interval_minutes,local_time,timezone
         FROM scheduled_messages WHERE task_id=$1 AND created_by=$2",
    )
    .bind(id)
    .bind(user_id.to_string())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let mention_ids = serde_json::from_value::<Vec<String>>(row.try_get("mention_ids")?)
        .map_err(|error| AppError::Internal(format!("invalid stored mention_ids: {error}")))?
        .into_iter()
        .map(|id| Uuid::parse_str(&id).map_err(|error| AppError::Internal(error.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    let task = ClaimedTask {
        id: row.try_get("task_id")?,
        created_by: user_id,
        channel_id: Uuid::parse_str(&row.try_get::<String, _>("channel_id")?)
            .map_err(|error| AppError::Internal(error.to_string()))?,
        content: row.try_get("content")?,
        mention_ids,
        schedule_kind: row.try_get("schedule_kind")?,
        interval_minutes: row.try_get("interval_minutes")?,
        local_time: row.try_get("local_time")?,
        timezone: row.try_get("timezone")?,
        scheduled_for: Utc::now(),
    };
    let run_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO scheduled_message_runs
         (run_id,task_id,scheduled_for,trigger,status) VALUES ($1,$2,$3,'manual','running')",
    )
    .bind(&run_id)
    .bind(&task.id)
    .bind(task.scheduled_for)
    .execute(&state.db)
    .await?;
    let result = execute(state, &task, "manual").await;
    match &result {
        Ok(message_id) => {
            sqlx::query(
                "UPDATE scheduled_message_runs SET status='succeeded',message_id=$2,
                 finished_at=NOW() WHERE run_id=$1",
            )
            .bind(&run_id)
            .bind(message_id)
            .execute(&state.db)
            .await?;
            sqlx::query(
                "UPDATE scheduled_messages SET last_run_at=NOW(),last_error=NULL,
                 consecutive_failures=0,updated_at=NOW() WHERE task_id=$1",
            )
            .bind(&task.id)
            .execute(&state.db)
            .await?;
        }
        Err(error) => {
            sqlx::query(
                "UPDATE scheduled_message_runs SET status='failed',error=$2,
                 finished_at=NOW() WHERE run_id=$1",
            )
            .bind(&run_id)
            .bind(error.to_string().chars().take(500).collect::<String>())
            .execute(&state.db)
            .await?;
            sqlx::query(
                "UPDATE scheduled_messages SET last_run_at=NOW(),last_error=$2,
                 consecutive_failures=consecutive_failures+1,updated_at=NOW() WHERE task_id=$1",
            )
            .bind(&task.id)
            .bind(error.to_string().chars().take(500).collect::<String>())
            .execute(&state.db)
            .await?;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_skips_missed_ticks_without_bursting() {
        let scheduled = DateTime::parse_from_rfc3339("2026-01-01T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let now = DateTime::parse_from_rfc3339("2026-01-01T08:17:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            next_interval_run(scheduled, 5, now),
            DateTime::parse_from_rfc3339("2026-01-01T08:20:00Z")
                .unwrap()
                .with_timezone(&Utc)
        );
    }

    #[test]
    fn interval_bounds_are_stable() {
        assert!(!(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&1));
        assert!((MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&1440));
    }
}
