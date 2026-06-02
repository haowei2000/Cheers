#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Context;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRecord {
    #[serde(rename = "acpSessionId")]
    pub acp_session_id: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
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
