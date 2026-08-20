//! Per-channel Voice feature configuration.
//!
//! Before voice landed, the column existed as `{}` with no typed Rust schema —
//! callers read/wrote raw JSON. This module owns the typed shape, so consent,
//! transcription, retention, and moderation policy all read from one place.
//!
//! Existing rows deserialize to `VoiceConfig::default()` (transcription off,
//! no explicit consent, 30-day retention) — no migration needed to backfill.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::errors::AppError;

/// What the transcriber does in this channel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionMode {
    /// No transcription is produced. Rooms are audio-only.
    #[default]
    Off,
    /// Transcription is on but requires each participant's explicit consent
    /// before their mic feeds the STT worker.
    Optional,
    /// Transcription feeds automatically for every published mic; participants
    /// are informed on join but no per-person opt-in gating.
    AlwaysOn,
}

/// How participant consent for transcription is collected.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentMode {
    /// Consent is not collected (transcription forced off or always-on without
    /// gating). Join proceeds directly to mic publish.
    #[default]
    None,
    /// Each participant must accept a disclosure before their mic publishes;
    /// until they do, join completes listen-only. Withdrawing later mutes them.
    Explicit,
}

/// The full, typed shape of the Voice feature config. Defaults are chosen so a
/// legacy `{}` row behaves as "transcription off, no consent, 30-day
/// retention" — matching how voice-less channels historically behaved.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceConfig {
    #[serde(default)]
    pub transcription_mode: TranscriptionMode,
    #[serde(default)]
    pub consent_mode: ConsentMode,
    /// Minutes of silence before the room auto-closes. `None` = no auto-close.
    #[serde(default)]
    pub empty_timeout_minutes: Option<u32>,
    /// Hard cap on concurrent participants. `None` = provider default.
    #[serde(default)]
    pub participant_cap: Option<u32>,
    /// Days to retain final transcript segments; older finals are hidden/expired
    /// but claim audit attribution is never rewritten. `None` = inherit the
    /// workspace's text-channel retention (treated as 30 here until that policy
    /// lands).
    #[serde(default = "default_retention_days")]
    pub retention_days: Option<u32>,
}

fn default_retention_days() -> Option<u32> {
    Some(30)
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            transcription_mode: TranscriptionMode::Off,
            consent_mode: ConsentMode::None,
            empty_timeout_minutes: None,
            participant_cap: None,
            retention_days: default_retention_days(),
        }
    }
}

impl VoiceConfig {
    pub fn validate(&self) -> Result<(), AppError> {
        if self
            .empty_timeout_minutes
            .is_some_and(|minutes| !(1..=1_440).contains(&minutes))
        {
            return Err(AppError::BadRequest(
                "empty_timeout_minutes must be between 1 and 1440".into(),
            ));
        }
        if self
            .participant_cap
            .is_some_and(|participants| !(2..=500).contains(&participants))
        {
            return Err(AppError::BadRequest(
                "participant_cap must be between 2 and 500".into(),
            ));
        }
        if self
            .retention_days
            .is_some_and(|days| !(1..=3_650).contains(&days))
        {
            return Err(AppError::BadRequest(
                "retention_days must be between 1 and 3650".into(),
            ));
        }
        Ok(())
    }

    /// Parse the JSONB config for one channel, falling back to defaults when the
    /// column is absent or malformed (legacy `{}` rows, or a partial write).
    pub fn from_row(raw: Option<&serde_json::Value>) -> Self {
        let Some(raw) = raw else {
            return Self::default();
        };
        serde_json::from_value(raw.clone()).unwrap_or_else(|e| {
            tracing::warn!(err = %e, "voice_config parse failed; using defaults");
            Self::default()
        })
    }

    /// Load the config for a channel from the DB. Returns defaults if the
    /// channel has no Voice feature config yet.
    pub async fn load(db: &PgPool, channel_id: &str) -> Result<Self, AppError> {
        let raw = sqlx::query_scalar::<_, Option<serde_json::Value>>(
            "SELECT COALESCE(
                    (SELECT cf.config FROM channel_features cf
                     WHERE cf.channel_id = channels.channel_id
                       AND cf.feature = 'voice' AND cf.enabled = TRUE),
                    voice_config)
             FROM channels WHERE channel_id = $1",
        )
        .bind(channel_id)
        .fetch_optional(db)
        .await?
        .flatten();
        Ok(Self::from_row(raw.as_ref()))
    }

    /// Persist this config back to the channel. Whole-object replacement — call
    /// `load` → mutate → `save` so concurrent edits don't silently drop fields.
    pub async fn save(&self, db: &PgPool, channel_id: &str) -> Result<(), AppError> {
        let value = serde_json::to_value(self).map_err(|e| AppError::Internal(e.to_string()))?;
        let mut tx = db.begin().await?;
        let updated = sqlx::query(
            "UPDATE channel_features SET config = $1, updated_at = NOW()
             WHERE channel_id = $2 AND feature = 'voice' AND enabled = TRUE",
        )
        .bind(&value)
        .bind(channel_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(AppError::BadRequest(
                "Voice is not enabled for this channel".into(),
            ));
        }
        // Compatibility mirror for gateways rolling across migration 0090.
        sqlx::query("UPDATE channels SET voice_config = $1 WHERE channel_id = $2")
            .bind(value)
            .bind(channel_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unbounded_operational_limits() {
        let mut config = VoiceConfig {
            participant_cap: Some(501),
            ..VoiceConfig::default()
        };
        assert!(config.validate().is_err());

        config.participant_cap = Some(50);
        config.retention_days = Some(0);
        assert!(config.validate().is_err());

        config.retention_days = Some(30);
        config.empty_timeout_minutes = Some(1_441);
        assert!(config.validate().is_err());
    }

    #[test]
    fn accepts_bounded_or_inherited_limits() {
        assert!(VoiceConfig::default().validate().is_ok());
        let config = VoiceConfig {
            empty_timeout_minutes: Some(30),
            participant_cap: Some(50),
            retention_days: None,
            ..VoiceConfig::default()
        };
        assert!(config.validate().is_ok());
    }
}
