//! Instance-level runtime settings: admin-edited overrides of env-configured
//! defaults, stored in `system_settings` under `runtime.<key>` and applied
//! without a restart.
//!
//! Every change is written to `system_setting_revisions` in the same transaction
//! as the value, with its author and reason, so the review trail cannot drift
//! from what is live. Secrets do not belong here: revisions store plaintext.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::errors::AppError;

const KEY_PREFIX: &str = "runtime.";
const MAX_REASON_CHARS: usize = 500;
const MAX_REVISIONS: i64 = 50;
/// How often the gateway re-reads overrides, so a change made by another
/// process or directly in the database still reaches the in-memory snapshot.
const RELOAD_INTERVAL: Duration = Duration::from_secs(10);

/// The current value of every runtime setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeValues {
    pub approval_card_ttl_secs: u64,
}

impl RuntimeValues {
    pub fn from_config(config: &Config) -> Self {
        Self {
            approval_card_ttl_secs: config.approval_card_ttl_secs,
        }
    }
}

/// One editable setting. Bounds apply to admin overrides only; the env-configured
/// default is the deployer's own choice and is left as it is.
pub struct SettingDef {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub unit: &'static str,
    pub min: u64,
    pub max: u64,
    field: fn(&mut RuntimeValues) -> &mut u64,
}

/// Adding a setting: a `RuntimeValues` field, its `from_config` line, and an
/// entry here. Its consumer must read the store on each use, not cache the value.
pub const SETTINGS: &[SettingDef] = &[SettingDef {
    key: "approval_card_ttl_secs",
    label: "Approval card expiry",
    description: "Unresolved approval cards older than this are expired by the next sweep. \
                  Keep it above the connector's permission wait (15 minutes by default) so \
                  the sweep only catches cards whose connector died.",
    unit: "seconds",
    min: 1200,
    max: 86_400,
    field: |values| &mut values.approval_card_ttl_secs,
}];

fn find_def(key: &str) -> Result<&'static SettingDef, AppError> {
    SETTINGS
        .iter()
        .find(|def| def.key == key)
        .ok_or(AppError::NotFound)
}

fn storage_key(def: &SettingDef) -> String {
    format!("{KEY_PREFIX}{}", def.key)
}

fn validate_value(def: &SettingDef, value: u64) -> Result<(), AppError> {
    if (def.min..=def.max).contains(&value) {
        return Ok(());
    }
    Err(AppError::BadRequest(format!(
        "{} must be between {} and {} {}",
        def.key, def.min, def.max, def.unit
    )))
}

fn validate_reason(reason: &str) -> Result<&str, AppError> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(AppError::BadRequest("reason is required".into()));
    }
    if reason.chars().count() > MAX_REASON_CHARS {
        return Err(AppError::BadRequest(format!(
            "reason must be at most {MAX_REASON_CHARS} characters"
        )));
    }
    Ok(reason)
}

fn apply_overrides(defaults: RuntimeValues, overrides: &HashMap<&str, u64>) -> RuntimeValues {
    let mut values = defaults;
    for def in SETTINGS {
        if let Some(value) = overrides.get(def.key) {
            *(def.field)(&mut values) = *value;
        }
    }
    values
}

/// Read every valid override. A row that fails validation can only come from a
/// manual database edit; it is ignored with a log so the default stays in force.
async fn load_overrides(db: &PgPool) -> Result<HashMap<&'static str, u64>, AppError> {
    let rows = sqlx::query!("SELECT key, value FROM system_settings WHERE key LIKE 'runtime.%'")
        .fetch_all(db)
        .await?;

    let mut overrides = HashMap::new();
    for row in rows {
        let key = row.key.strip_prefix(KEY_PREFIX);
        let Some(def) = SETTINGS.iter().find(|def| Some(def.key) == key) else {
            tracing::warn!(key = row.key, "ignoring unknown runtime setting");
            continue;
        };
        match row.value.as_u64() {
            Some(value) if validate_value(def, value).is_ok() => {
                overrides.insert(def.key, value);
            }
            _ => tracing::warn!(key = row.key, "ignoring invalid runtime setting value"),
        }
    }
    Ok(overrides)
}

/// In-memory snapshot read by background workers on every use.
pub struct RuntimeSettingsStore {
    defaults: RuntimeValues,
    current: RwLock<RuntimeValues>,
}

impl RuntimeSettingsStore {
    pub fn new(defaults: RuntimeValues) -> Self {
        Self {
            defaults,
            current: RwLock::new(defaults),
        }
    }

    pub fn values(&self) -> RuntimeValues {
        *self.current.read().expect("runtime settings lock poisoned")
    }

    pub async fn reload(&self, db: &PgPool) -> Result<(), AppError> {
        let values = apply_overrides(self.defaults, &load_overrides(db).await?);
        *self
            .current
            .write()
            .expect("runtime settings lock poisoned") = values;
        Ok(())
    }

    /// Admin-UI DTO: each setting with its bounds, default, and live value.
    pub async fn list(&self, db: &PgPool) -> Result<Value, AppError> {
        let overrides = load_overrides(db).await?;
        let values = apply_overrides(self.defaults, &overrides);
        let mut defaults = self.defaults;
        let mut effective = values;
        let settings: Vec<Value> = SETTINGS
            .iter()
            .map(|def| {
                json!({
                    "key": def.key,
                    "label": def.label,
                    "description": def.description,
                    "unit": def.unit,
                    "min": def.min,
                    "max": def.max,
                    "default_value": *(def.field)(&mut defaults),
                    "override_value": overrides.get(def.key),
                    "effective_value": *(def.field)(&mut effective),
                })
            })
            .collect();
        Ok(json!({ "settings": settings }))
    }

    /// Set (`Some`) or remove (`None`) an override and record the revision.
    pub async fn update(
        &self,
        db: &PgPool,
        key: &str,
        value: Option<u64>,
        actor_id: &str,
        reason: &str,
    ) -> Result<(), AppError> {
        let def = find_def(key)?;
        if let Some(value) = value {
            validate_value(def, value)?;
        }
        let reason = validate_reason(reason)?;
        let storage_key = storage_key(def);
        let new_value = value.map(|value| json!(value));

        let mut tx = db.begin().await?;
        // A row lock cannot cover a key with no row yet, and concurrent admins
        // must each record the true `old_value`.
        sqlx::query!(
            "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
            storage_key,
        )
        .execute(&mut *tx)
        .await?;
        let old_value = sqlx::query_scalar!(
            "SELECT value FROM system_settings WHERE key = $1",
            storage_key,
        )
        .fetch_optional(&mut *tx)
        .await?;
        if old_value == new_value {
            return Err(AppError::BadRequest(format!(
                "{key} is already set to that"
            )));
        }

        match &new_value {
            Some(value) => {
                sqlx::query!(
                    "INSERT INTO system_settings (key, value) VALUES ($1, $2)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                    storage_key,
                    value,
                )
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query!("DELETE FROM system_settings WHERE key = $1", storage_key)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        sqlx::query!(
            "INSERT INTO system_setting_revisions (id, key, old_value, new_value, actor_id, reason)
             VALUES ($1, $2, $3, $4, $5, $6)",
            Uuid::new_v4().to_string(),
            storage_key,
            old_value,
            new_value,
            actor_id,
            reason,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        self.reload(db).await
    }
}

/// Newest-first change history for one setting.
pub async fn revisions(db: &PgPool, key: &str) -> Result<Value, AppError> {
    let def = find_def(key)?;
    let rows = sqlx::query!(
        r#"SELECT r.id, r.old_value, r.new_value, r.actor_id, r.reason, r.created_at,
                  COALESCE(u.display_name, u.username) AS "actor_name?"
           FROM system_setting_revisions r
           LEFT JOIN users u ON u.user_id = r.actor_id
           WHERE r.key = $1
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT $2"#,
        storage_key(def),
        MAX_REVISIONS,
    )
    .fetch_all(db)
    .await?;

    let revisions: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.id,
                "old_value": row.old_value,
                "new_value": row.new_value,
                "actor_id": row.actor_id,
                "actor_name": row.actor_name,
                "reason": row.reason,
                "created_at": row.created_at.to_rfc3339(),
            })
        })
        .collect();
    Ok(json!({ "revisions": revisions }))
}

/// Keep the snapshot current for the life of the process.
pub fn spawn_reloader(db: PgPool, store: Arc<RuntimeSettingsStore>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RELOAD_INTERVAL);
        tick.tick().await; // first tick is immediate — startup already loaded.
        loop {
            tick.tick().await;
            if let Err(e) = store.reload(&db).await {
                tracing::warn!(err = %e, "runtime settings reload failed; keeping last values");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULTS: RuntimeValues = RuntimeValues {
        approval_card_ttl_secs: 1800,
    };

    #[test]
    fn override_replaces_only_its_own_default() {
        assert_eq!(apply_overrides(DEFAULTS, &HashMap::new()), DEFAULTS);
        let overrides = HashMap::from([("approval_card_ttl_secs", 3600)]);
        assert_eq!(
            apply_overrides(DEFAULTS, &overrides).approval_card_ttl_secs,
            3600
        );
    }

    #[test]
    fn value_bounds_are_inclusive() {
        let def = find_def("approval_card_ttl_secs").unwrap();
        assert!(validate_value(def, def.min).is_ok());
        assert!(validate_value(def, def.max).is_ok());
        assert!(validate_value(def, def.min - 1).is_err());
        assert!(validate_value(def, def.max + 1).is_err());
    }

    #[test]
    fn reason_is_trimmed_and_required() {
        assert_eq!(validate_reason("  why  ").unwrap(), "why");
        assert!(validate_reason("   ").is_err());
        assert!(validate_reason(&"x".repeat(MAX_REASON_CHARS + 1)).is_err());
    }

    #[test]
    fn unknown_key_is_not_found() {
        assert!(matches!(find_def("nope"), Err(AppError::NotFound)));
    }
}
