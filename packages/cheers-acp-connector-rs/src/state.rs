//! Durable mapping between Cheers provider keys and ACP session identifiers.
//!
//! State writes use an atomic replacement strategy so a daemon interruption
//! cannot leave a partially serialized session database.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Context;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use tokio::fs;

/// How long an unused channel session mapping is kept.
///
/// A bot belongs to every channel it was invited to, and each one pins an ACP
/// session the agent is asked to keep loadable. Without an upper bound, a bot in
/// a few hundred channels drags a few hundred sessions behind it forever,
/// including channels that went quiet a year ago. Dropping the mapping costs
/// only a `session/new` the next time that channel speaks — the conversation
/// itself lives in Cheers, not in the agent's session.
///
/// A month is long enough that a channel used even occasionally keeps its
/// session, and short enough to bound the tail.
const SESSION_TTL_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRecord {
    #[serde(rename = "acpSessionId")]
    pub acp_session_id: String,
    /// When this mapping was last used, RFC 3339. Refreshed on reuse, not only
    /// on creation, so the TTL measures idleness rather than age — otherwise a
    /// channel in daily use would still lose its session once a month.
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

impl SessionRecord {
    /// Whether this record has gone unused past [`SESSION_TTL_DAYS`].
    ///
    /// An unparseable timestamp counts as expired: it cannot be shown to be
    /// fresh, and the cost of being wrong is one extra `session/new`.
    fn is_expired(&self, now: DateTime<Utc>) -> bool {
        match DateTime::parse_from_rfc3339(&self.updated_at) {
            Ok(updated) => {
                now.signed_duration_since(updated.with_timezone(&Utc))
                    > ChronoDuration::days(SESSION_TTL_DAYS)
            }
            Err(_) => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StateFile {
    pub version: u32,
    pub sessions: BTreeMap<String, BTreeMap<String, SessionRecord>>,
}

impl Default for StateFile {
    fn default() -> Self {
        Self {
            version: 1,
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionStateStore {
    path: PathBuf,
    state: StateFile,
    loaded: bool,
}

impl SessionStateStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            state: StateFile::default(),
            loaded: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn load(&mut self) -> anyhow::Result<()> {
        if self.loaded {
            return Ok(());
        }
        match fs::read_to_string(&self.path).await {
            Ok(text) => {
                let parsed: StateFile = serde_json::from_str(&text)
                    .with_context(|| format!("failed to parse state {}", self.path.display()))?;
                if parsed.version == 1 {
                    self.state = parsed;
                    self.expire_stale(Utc::now());
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err)
                    .with_context(|| format!("failed to read state {}", self.path.display()))
            }
        }
        self.loaded = true;
        Ok(())
    }

    /// Drop every mapping that has gone unused past the TTL.
    ///
    /// Runs at load, which is the one moment the whole file is in hand and no
    /// turn is relying on any entry. Sweeping on write instead would put a scan
    /// on the hot path to remove entries nobody was about to read.
    fn expire_stale(&mut self, now: DateTime<Utc>) {
        let mut expired = 0usize;
        for items in self.state.sessions.values_mut() {
            let before = items.len();
            items.retain(|_, record| !record.is_expired(now));
            expired += before - items.len();
        }
        self.state.sessions.retain(|_, items| !items.is_empty());
        if expired > 0 {
            tracing::info!(
                expired,
                ttl_days = SESSION_TTL_DAYS,
                "dropped session mappings unused past the TTL"
            );
        }
    }

    pub fn get(&self, account_id: &str, provider_session_key: &str) -> Option<String> {
        self.state
            .sessions
            .get(account_id)
            .and_then(|items| items.get(provider_session_key))
            .map(|record| record.acp_session_id.clone())
    }

    pub async fn set(
        &mut self,
        account_id: &str,
        provider_session_key: &str,
        acp_session_id: &str,
    ) -> anyhow::Result<()> {
        self.state
            .sessions
            .entry(account_id.to_string())
            .or_default()
            .insert(
                provider_session_key.to_string(),
                SessionRecord {
                    acp_session_id: acp_session_id.to_string(),
                    updated_at: Utc::now().to_rfc3339(),
                },
            );
        self.save().await
    }

    pub async fn remove(
        &mut self,
        account_id: &str,
        provider_session_key: &str,
    ) -> anyhow::Result<()> {
        if let Some(items) = self.state.sessions.get_mut(account_id) {
            items.remove(provider_session_key);
            if items.is_empty() {
                self.state.sessions.remove(account_id);
            }
        }
        self.save().await
    }

    async fn save(&self) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create state dir {}", parent.display()))?;
        }
        let tmp = self.path.with_extension(format!(
            "{}.{}.tmp",
            self.path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("json"),
            uuid::Uuid::new_v4()
        ));
        let text = serde_json::to_string_pretty(&self.state)?;
        fs::write(&tmp, format!("{text}\n"))
            .await
            .with_context(|| format!("failed to write temp state {}", tmp.display()))?;
        fs::rename(&tmp, &self.path).await.with_context(|| {
            format!(
                "failed to atomically replace state {} with {}",
                self.path.display(),
                tmp.display()
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TTL 内的映射照常保留——常用频道不该每月丢一次会话。
    #[test]
    fn records_within_the_ttl_survive() {
        let record = SessionRecord {
            acp_session_id: "s1".to_string(),
            updated_at: (Utc::now() - ChronoDuration::days(SESSION_TTL_DAYS - 1)).to_rfc3339(),
        };
        assert!(!record.is_expired(Utc::now()));
    }

    /// 超过 TTL 未被使用 → 过期。
    #[test]
    fn records_unused_past_the_ttl_expire() {
        let record = SessionRecord {
            acp_session_id: "s1".to_string(),
            updated_at: (Utc::now() - ChronoDuration::days(SESSION_TTL_DAYS + 1)).to_rfc3339(),
        };
        assert!(record.is_expired(Utc::now()));
    }

    /// 时间戳坏掉 → 当作过期：无法证明它新鲜，代价只是多一次 session/new。
    #[test]
    fn records_with_an_unreadable_stamp_expire() {
        let record = SessionRecord {
            acp_session_id: "s1".to_string(),
            updated_at: "not a timestamp".to_string(),
        };
        assert!(record.is_expired(Utc::now()));
    }

    /// 清扫掉过期项，保留新鲜项；账号下清空后连账号一并移除。
    #[tokio::test]
    async fn loading_sweeps_expired_mappings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let fresh = (Utc::now() - ChronoDuration::days(1)).to_rfc3339();
        let stale = (Utc::now() - ChronoDuration::days(SESSION_TTL_DAYS + 5)).to_rfc3339();
        let contents = format!(
            r#"{{"version":1,"sessions":{{
                "acct":{{
                    "cheers:channel:live:bot:b":{{"acpSessionId":"s-live","updatedAt":"{fresh}"}},
                    "cheers:channel:quiet:bot:b":{{"acpSessionId":"s-quiet","updatedAt":"{stale}"}}
                }},
                "gone":{{
                    "cheers:channel:old:bot:b":{{"acpSessionId":"s-old","updatedAt":"{stale}"}}
                }}
            }}}}"#
        );
        tokio::fs::write(&path, contents).await.unwrap();

        let mut store = SessionStateStore::new(&path);
        store.load().await.unwrap();

        assert_eq!(
            store.get("acct", "cheers:channel:live:bot:b").as_deref(),
            Some("s-live")
        );
        assert_eq!(store.get("acct", "cheers:channel:quiet:bot:b"), None);
        // 账号下全部过期时，账号条目本身也不该留下。
        assert_eq!(store.get("gone", "cheers:channel:old:bot:b"), None);
        assert!(!store.state.sessions.contains_key("gone"));
    }

    #[tokio::test]
    async fn state_store_loads_missing_file_as_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = SessionStateStore::new(dir.path().join("state.json"));
        store.load().await.expect("load");
        assert_eq!(store.get("acct", "provider"), None);
    }

    #[tokio::test]
    async fn state_store_sets_gets_and_removes_sessions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let mut store = SessionStateStore::new(&path);
        store.load().await.expect("load");
        store
            .set("acct", "provider-key", "acp-session-1")
            .await
            .expect("set");
        assert_eq!(
            store.get("acct", "provider-key").as_deref(),
            Some("acp-session-1")
        );

        let mut reloaded = SessionStateStore::new(&path);
        reloaded.load().await.expect("reload");
        assert_eq!(
            reloaded.get("acct", "provider-key").as_deref(),
            Some("acp-session-1")
        );

        reloaded
            .remove("acct", "provider-key")
            .await
            .expect("remove");
        assert_eq!(reloaded.get("acct", "provider-key"), None);
    }
}
