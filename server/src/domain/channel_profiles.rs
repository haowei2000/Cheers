//! Structured workflow profiles layered on top of ordinary channels.
//!
//! Code profiles contain project metadata only. Repository credentials remain
//! in the integration credential store and never enter this table.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodeRemoteSource {
    Github {
        installation_id: String,
        repository: String,
        branch: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CodeExecutionTarget {
    pub bot_id: String,
    pub host_id: String,
    /// Opaque checkout identity. The primary Cheers session owns the host-local cwd.
    pub checkout_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CodeProfileConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_source: Option<CodeRemoteSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_target: Option<CodeExecutionTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CodeProfileStatus {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl Default for CodeProfileStatus {
    fn default() -> Self {
        Self {
            state: "unconfigured".into(),
            head_commit: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChannelProfile {
    pub profile: String,
    pub config: Value,
    pub status: Value,
}

pub async fn get(db: &PgPool, channel_id: &str) -> Result<Option<ChannelProfile>, sqlx::Error> {
    let row =
        sqlx::query("SELECT profile, config, status FROM channel_profiles WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_optional(db)
            .await?;
    row.map(|row| {
        Ok(ChannelProfile {
            profile: row.try_get("profile")?,
            config: row.try_get("config")?,
            status: row.try_get("status")?,
        })
    })
    .transpose()
}

pub async fn put_code(
    db: &PgPool,
    channel_id: &str,
    config: &CodeProfileConfig,
    actor_id: &str,
) -> Result<ChannelProfile, sqlx::Error> {
    let config = serde_json::to_value(config).expect("code profile config serializes");
    let status = json!(CodeProfileStatus {
        state: if config.get("execution_target").is_some() {
            "pending".into()
        } else {
            "unconfigured".into()
        },
        ..CodeProfileStatus::default()
    });
    let row = sqlx::query(
        "INSERT INTO channel_profiles (channel_id, profile, config, status, created_by)
         VALUES ($1, 'code', $2, $3, $4)
         ON CONFLICT (channel_id) DO UPDATE
           SET profile = 'code', config = EXCLUDED.config, status = EXCLUDED.status,
               updated_at = NOW()
         RETURNING profile, config, status",
    )
    .bind(channel_id)
    .bind(config)
    .bind(status)
    .bind(actor_id)
    .fetch_one(db)
    .await?;
    Ok(ChannelProfile {
        profile: row.try_get("profile")?,
        config: row.try_get("config")?,
        status: row.try_get("status")?,
    })
}

pub async fn update_code_status(
    db: &PgPool,
    channel_id: &str,
    status: &CodeProfileStatus,
) -> Result<Option<ChannelProfile>, sqlx::Error> {
    let status = serde_json::to_value(status).expect("code profile status serializes");
    let row = sqlx::query(
        "UPDATE channel_profiles
            SET status = $2, updated_at = NOW()
          WHERE channel_id = $1 AND profile = 'code'
          RETURNING profile, config, status",
    )
    .bind(channel_id)
    .bind(status)
    .fetch_optional(db)
    .await?;
    row.map(|row| {
        Ok(ChannelProfile {
            profile: row.try_get("profile")?,
            config: row.try_get("config")?,
            status: row.try_get("status")?,
        })
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_code_profile_never_claims_a_ready_workspace() {
        let status = CodeProfileStatus::default();
        assert_eq!(status.state, "unconfigured");
        assert!(status.head_commit.is_none());
    }

    #[test]
    fn remote_source_and_execution_target_are_independent() {
        let config = CodeProfileConfig {
            remote_source: Some(CodeRemoteSource::Github {
                installation_id: "installation".into(),
                repository: "owner/repo".into(),
                branch: "main".into(),
            }),
            execution_target: None,
        };
        let value = serde_json::to_value(config).unwrap();
        assert_eq!(value["remote_source"]["kind"], "github");
        assert!(value.get("execution_target").is_none());
    }
}
