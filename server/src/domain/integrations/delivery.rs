//! Turning stored webhook events into channel messages.
//!
//! Ingress (`api::integrations::receive`) does the minimum: verify, store,
//! answer `202`. A provider that waits on our message fan-out before considering
//! the delivery successful would time out and start redelivering. So mapping
//! happens here, on a worker draining
//! `integration_webhook_events WHERE processed_at IS NULL`.
//!
//! # Not dropping and not duplicating
//!
//! Issue #570 asks for both, and they pull in opposite directions across a
//! crash. The resolution is that delivery is *idempotent* rather than
//! carefully-once:
//!
//! - The message id is derived from the provider's own delivery id
//!   ([`message_id_for`]), so re-running a mapping after a crash hits
//!   `messages_pkey` instead of posting the event a second time. A unique
//!   violation is therefore success — the message is already there.
//! - `processed_at` is only stamped after the post returns, so an event whose
//!   worker died mid-flight is picked up again rather than silently lost.
//! - Every attempt increments `process_attempts` before the work, so a mapping
//!   that panics the same way forever stops after [`MAX_ATTEMPTS`] instead of
//!   spinning. `last_error` keeps the reason visible.
//!
//! # Who the message comes from
//!
//! The user who bound the channel, which is the convention
//! `domain::scheduled_messages` already uses for out-of-band posting. That
//! keeps the integration inside the existing permission model — the post goes
//! through `create_message`, which checks channel membership, resolves
//! `mention_names` through the same path bots use, and drives fan-out and bot
//! triggering. An integration therefore cannot say anything in a channel that
//! the person who connected it could not.

use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{bindings, catalog, mapper};
use crate::{
    app_state::AppState,
    domain::messages::{create_message, CreateMessageParams},
    errors::AppError,
};

/// Give up after this many failures. High enough to ride out a restart or a
/// transient database error, low enough that a genuinely broken mapping stops
/// re-rendering forever.
pub const MAX_ATTEMPTS: i16 = 5;

/// How many events one drain pass takes.
const BATCH: i64 = 32;

/// Namespace for delivery-derived message ids. A fixed v4, generated once — the
/// value does not matter, only that it never changes: it is what makes the
/// derived id stable across restarts and deploys.
const DELIVERY_NAMESPACE: Uuid = Uuid::from_u128(0x7f3c_1c2e_9c48_4d5a_9b1f_2a6d_84e7_0c31);

/// The message id an event will always map to.
pub fn message_id_for(integration_id: &str, installation_id: &str, event_id: &str) -> Uuid {
    Uuid::new_v5(
        &DELIVERY_NAMESPACE,
        format!("{integration_id}\u{1f}{installation_id}\u{1f}{event_id}").as_bytes(),
    )
}

/// One event claimed for processing.
#[derive(Debug, Clone)]
pub struct ClaimedEvent {
    pub integration_id: String,
    pub installation_id: String,
    pub event_id: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub attempt: i16,
}

/// What one drain pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DrainReport {
    pub posted: usize,
    /// Already delivered — a retry that lost the race with its own earlier run.
    pub already_delivered: usize,
    /// No mapping for the event type, or a gate said skip. Marked processed:
    /// there is nothing to retry.
    pub ignored: usize,
    /// No channel is bound to the event's resource yet.
    pub unbound: usize,
    pub failed: usize,
}

/// Take up to [`BATCH`] pending events, incrementing their attempt counter.
///
/// `FOR UPDATE SKIP LOCKED` is what lets a second gateway replica drain the same
/// queue without both claiming one event.
pub async fn claim(db: &PgPool) -> Result<Vec<ClaimedEvent>, AppError> {
    let rows = sqlx::query(
        "UPDATE integration_webhook_events AS e
            SET process_attempts = e.process_attempts + 1
          WHERE (e.integration_id, e.installation_id, e.event_id) IN (
                SELECT c.integration_id, c.installation_id, c.event_id
                  FROM integration_webhook_events c
                 WHERE c.processed_at IS NULL
                   AND c.process_attempts < $1
                 ORDER BY c.received_at
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED
          )
      RETURNING e.integration_id, e.installation_id, e.event_id, e.event_type,
                e.payload, e.process_attempts",
    )
    .bind(MAX_ATTEMPTS)
    .bind(BATCH)
    .fetch_all(db)
    .await?;

    rows.into_iter()
        .map(|row| {
            Ok(ClaimedEvent {
                integration_id: row.try_get("integration_id")?,
                installation_id: row.try_get("installation_id")?,
                event_id: row.try_get("event_id")?,
                event_type: row.try_get("event_type")?,
                payload: row.try_get("payload")?,
                attempt: row.try_get("process_attempts")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::Db)
}

async fn mark_processed(
    db: &PgPool,
    event: &ClaimedEvent,
    posted_msg_id: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE integration_webhook_events
            SET processed_at = NOW(), last_error = NULL, posted_msg_id = $4
          WHERE integration_id = $1 AND installation_id = $2 AND event_id = $3",
    )
    .bind(&event.integration_id)
    .bind(&event.installation_id)
    .bind(&event.event_id)
    .bind(posted_msg_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn mark_failed(db: &PgPool, event: &ClaimedEvent, error: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE integration_webhook_events
            SET last_error = $4
          WHERE integration_id = $1 AND installation_id = $2 AND event_id = $3",
    )
    .bind(&event.integration_id)
    .bind(&event.installation_id)
    .bind(&event.event_id)
    .bind(error.chars().take(500).collect::<String>())
    .execute(db)
    .await?;
    Ok(())
}

/// True when this error means "the message is already there".
fn is_duplicate(error: &AppError) -> bool {
    matches!(error, AppError::Db(sqlx::Error::Database(db)) if db.is_unique_violation())
}

/// Which channel an event belongs to.
///
/// The external resource is read from the payload at the path the integration
/// declares (`repository.full_name` for GitHub), then resolved through the
/// binding's unique key.
async fn resolve_channel(
    db: &PgPool,
    descriptor: &catalog::IntegrationDescriptor,
    event: &ClaimedEvent,
) -> Result<Option<bindings::Binding>, AppError> {
    let path: Vec<String> = descriptor
        .resource_path
        .split('.')
        .map(str::to_string)
        .collect();
    let Some(external_id) = super::template::lookup(&event.payload, &path).and_then(|v| v.as_str())
    else {
        return Ok(None);
    };
    bindings::for_external(
        db,
        &event.integration_id,
        &event.installation_id,
        descriptor.resource_kind,
        external_id,
    )
    .await
    .map_err(|err| AppError::Internal(err.to_string()))
}

/// Process one claimed event.
async fn deliver(state: &AppState, event: &ClaimedEvent) -> Result<Outcome, AppError> {
    let Some(descriptor) = catalog::find(&event.integration_id) else {
        // The integration was removed from the catalog after the event landed.
        // Nothing will ever map it, so retrying is pointless.
        return Ok(Outcome::Ignored);
    };
    let compiled = descriptor.compiled_events().map_err(AppError::Internal)?;
    let Some(mapping) = mapper::find(compiled, &event.event_type) else {
        return Ok(Outcome::Ignored);
    };
    let Some(mapped) = mapping.render(&event.payload) else {
        return Ok(Outcome::Ignored);
    };
    if !mapped.missing.is_empty() {
        tracing::warn!(
            integration_id = %event.integration_id,
            event_type = %event.event_type,
            missing = ?mapped.missing,
            "integration mapping referenced fields the payload does not have"
        );
    }

    let Some(binding) = resolve_channel(&state.db, descriptor, event).await? else {
        return Ok(Outcome::Unbound);
    };
    let channel_id: Uuid = binding
        .channel_id
        .parse()
        .map_err(|_| AppError::Internal("binding has a malformed channel_id".into()))?;
    let author: Uuid = binding
        .created_by
        .parse()
        .map_err(|_| AppError::Internal("binding has a malformed created_by".into()))?;

    let msg_id = message_id_for(
        &event.integration_id,
        &event.installation_id,
        &event.event_id,
    );
    let result = create_message(
        &state.db,
        &state.fanout,
        &state.stream_registry,
        &state.bot_locator,
        CreateMessageParams {
            user_id: author,
            channel_id,
            content: mapped.content,
            msg_type: Some("text".into()),
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: vec![],
            mention_names: mapped.mention_names,
            session_id: None,
            context_bundle: None,
            msg_id: Some(msg_id),
        },
    )
    .await;

    match result {
        Ok(message) => Ok(Outcome::Posted(message.msg_id)),
        Err(error) if is_duplicate(&error) => Ok(Outcome::AlreadyDelivered(msg_id.to_string())),
        Err(error) => Err(error),
    }
}

enum Outcome {
    Posted(String),
    AlreadyDelivered(String),
    Ignored,
    Unbound,
}

/// Claim and process one batch. Returns what it did.
pub async fn drain_once(state: &AppState) -> Result<DrainReport, AppError> {
    let mut report = DrainReport::default();
    for event in claim(&state.db).await? {
        match deliver(state, &event).await {
            Ok(Outcome::Posted(msg_id)) => {
                mark_processed(&state.db, &event, Some(&msg_id)).await?;
                report.posted += 1;
            }
            Ok(Outcome::AlreadyDelivered(msg_id)) => {
                mark_processed(&state.db, &event, Some(&msg_id)).await?;
                report.already_delivered += 1;
            }
            Ok(Outcome::Ignored) => {
                mark_processed(&state.db, &event, None).await?;
                report.ignored += 1;
            }
            Ok(Outcome::Unbound) => {
                // Deliberately *not* marked processed: binding the channel is
                // the fix, and when it happens the queued events should flow.
                // `MAX_ATTEMPTS` keeps that from retrying forever.
                mark_failed(&state.db, &event, "no channel is bound to this resource").await?;
                report.unbound += 1;
            }
            Err(error) => {
                tracing::warn!(
                    integration_id = %event.integration_id,
                    event_id = %event.event_id,
                    attempt = event.attempt,
                    %error,
                    "integration event delivery failed"
                );
                mark_failed(&state.db, &event, &error.to_string()).await?;
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_id_is_stable_for_one_delivery() {
        // The whole retry story rests on this: the same delivery must always
        // map to the same message id, across restarts and across replicas.
        let first = message_id_for("github", "inst1", "delivery-1");
        let second = message_id_for("github", "inst1", "delivery-1");
        assert_eq!(first, second);
    }

    #[test]
    fn different_deliveries_do_not_collide() {
        let base = message_id_for("github", "inst1", "delivery-1");
        assert_ne!(base, message_id_for("github", "inst1", "delivery-2"));
        assert_ne!(base, message_id_for("github", "inst2", "delivery-1"));
        assert_ne!(base, message_id_for("gitlab", "inst1", "delivery-1"));
    }

    #[test]
    fn field_boundaries_cannot_be_forged_by_a_provider_id() {
        // Joining on a printable separator would let an installation id ending
        // in that character impersonate another event's key. The unit separator
        // cannot appear in any of these ids.
        assert_ne!(
            message_id_for("github", "a", "b-c"),
            message_id_for("github", "a-b", "c")
        );
    }
}
