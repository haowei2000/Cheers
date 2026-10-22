//! Immutable pending terminal results. Execution ownership stays in PostgreSQL.

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::bridge::{DataInbound, DataOutbound, BRIDGE_PROTOCOL_VERSION};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Scope {
    account_id: String,
    control_url: String,
    data_url: String,
    bot_id: String,
    host_id: Option<String>,
}

impl Scope {
    pub(crate) fn new(
        account_id: String,
        control_url: &str,
        data_url: &str,
        bot_id: String,
        host_id: Option<String>,
    ) -> anyhow::Result<Self> {
        fn endpoint(value: &str) -> anyhow::Result<String> {
            let mut url = reqwest::Url::parse(value).context("invalid terminal outbox endpoint")?;
            url.set_fragment(None);
            // Query routing remains part of authority without copying URL
            // credentials into the result file. A changed endpoint fails closed.
            Ok(digest(url.as_str().as_bytes()))
        }
        Ok(Self {
            account_id,
            control_url: endpoint(control_url)?,
            data_url: endpoint(data_url)?,
            bot_id,
            host_id,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Record {
    version: u32,
    scope: Scope,
    pub(crate) frame: DataOutbound,
}

impl Record {
    pub(crate) fn client_msg_id(&self) -> &str {
        terminal_ids(&self.frame)
            .expect("validated terminal record")
            .0
    }

    pub(crate) fn matches_ack(&self, ack: &DataInbound) -> bool {
        let (client_id, message_id) = terminal_ids(&self.frame).expect("validated terminal record");
        matches!(ack, DataInbound::TerminalAck { v, client_msg_id, msg_id, ok, .. }
            if *v == BRIDGE_PROTOCOL_VERSION && client_msg_id == client_id
                && msg_id.as_deref().map_or(!ok, |message| message == message_id))
    }
}

pub(crate) struct TerminalOutbox {
    directory: PathBuf,
    scope: Scope,
    in_flight: Mutex<HashSet<String>>,
    rejected: Mutex<HashSet<String>>,
    cursor: Mutex<Option<PathBuf>>,
    pub(crate) wake: Notify,
    #[cfg(test)]
    pub(crate) scans: std::sync::atomic::AtomicUsize,
}

impl TerminalOutbox {
    pub(crate) fn new(state_path: &Path, scope: Scope) -> anyhow::Result<Arc<Self>> {
        let name = state_path
            .file_name()
            .ok_or_else(|| anyhow!("state path has no filename"))?;
        let root = state_path.with_file_name(format!("{}.terminal-outbox", name.to_string_lossy()));
        let directory = root.join(digest(&serde_json::to_vec(&scope)?));
        Ok(Arc::new(Self {
            directory,
            scope,
            in_flight: Mutex::new(HashSet::new()),
            rejected: Mutex::new(HashSet::new()),
            cursor: Mutex::new(None),
            wake: Notify::new(),
            #[cfg(test)]
            scans: std::sync::atomic::AtomicUsize::new(0),
        }))
    }

    pub(crate) fn claim(self: &Arc<Self>, client_msg_id: &str) -> Option<DeliveryGuard> {
        if self
            .rejected
            .lock()
            .expect("terminal rejections poisoned")
            .contains(client_msg_id)
        {
            return None;
        }
        if !self
            .in_flight
            .lock()
            .expect("terminal deliveries poisoned")
            .insert(client_msg_id.to_string())
        {
            return None;
        }
        Some(DeliveryGuard {
            outbox: self.clone(),
            client_msg_id: client_msg_id.into(),
        })
    }

    pub(crate) fn reject_until_restart(&self, record: &Record) {
        self.rejected
            .lock()
            .expect("terminal rejections poisoned")
            .insert(record.client_msg_id().into());
    }

    /// Publish before any network write. Hard-link publication is atomic and
    /// cannot replace an existing correlation ID with conflicting content.
    pub(crate) async fn persist(&self, frame: DataOutbound) -> anyhow::Result<Record> {
        let record = Record {
            version: 1,
            scope: self.scope.clone(),
            frame,
        };
        validate(&record, &self.scope)?;
        let directory = self.directory.clone();
        let persisted = tokio::task::spawn_blocking(move || -> anyhow::Result<Record> {
            private_directory(&directory)?;
            let target = record_path(&directory, record.client_msg_id());
            if target.exists() {
                ensure_same(&target, &record)?;
                File::open(&target)?.sync_all()?;
                File::open(&directory)?.sync_all()?;
                return Ok(record);
            }
            let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let result = (|| -> anyhow::Result<()> {
                let mut file = options.open(&temporary)?;
                file.write_all(&serde_json::to_vec(&record)?)?;
                file.sync_all()?;
                match fs::hard_link(&temporary, &target) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        ensure_same(&target, &record)?
                    }
                    Err(error) => return Err(error.into()),
                }
                File::open(&directory)?.sync_all()?;
                Ok(())
            })();
            let _ = fs::remove_file(&temporary);
            result.context("could not durably persist terminal result")?;
            Ok(record)
        })
        .await??;
        self.wake.notify_one();
        Ok(persisted)
    }

    pub(crate) async fn pending(&self) -> anyhow::Result<Vec<Record>> {
        let (directory, scope) = (self.directory.clone(), self.scope.clone());
        let cursor = self
            .cursor
            .lock()
            .expect("terminal cursor poisoned")
            .clone();
        let excluded: HashSet<String> = self
            .in_flight
            .lock()
            .expect("terminal deliveries poisoned")
            .iter()
            .chain(
                self.rejected
                    .lock()
                    .expect("terminal rejections poisoned")
                    .iter(),
            )
            .map(|id| digest(id.as_bytes()))
            .collect();
        let (records, cursor) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), None)),
                Err(error) => return Err(error.into()),
            };
            let mut paths = entries.map(|entry| entry.map(|entry| entry.path())).collect::<Result<Vec<_>, _>>()?;
            paths.sort();
            if let Some(cursor) = cursor {
                let start = paths.partition_point(|path| path <= &cursor);
                paths.rotate_left(start);
            }
            let mut records = Vec::new();
            let mut cursor = None;
            for path in paths {
                if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
                if path.file_stem().and_then(|name| name.to_str()).is_some_and(|name| excluded.contains(name)) { continue; }
                let record = match read_record(&path).and_then(|record| { validate(&record, &scope)?; Ok(record) }) {
                    Ok(record) => record,
                    Err(error) => { tracing::error!(path = %path.display(), %error, "invalid terminal result retained on disk"); continue; }
                };
                records.push(record);
                cursor = Some(path);
                if records.len() == 32 { break; }
            }
            Ok((records, cursor))
        }).await??;
        if cursor.is_some() {
            *self.cursor.lock().expect("terminal cursor poisoned") = cursor;
        }
        #[cfg(test)]
        self.scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(records)
    }

    /// No negative, queued, synthetic, stale, or miscorrelated ACK deletes data.
    pub(crate) async fn acknowledge(
        &self,
        record: &Record,
        ack: &DataInbound,
    ) -> anyhow::Result<bool> {
        validate(record, &self.scope)?;
        let Some((client_id, message_id)) = terminal_ids(&record.frame) else {
            return Ok(false);
        };
        if !matches!(ack, DataInbound::TerminalAck {
            v, client_msg_id, ok: true, msg_id: Some(msg_id), queued, job_id, ..
        } if *v == BRIDGE_PROTOCOL_VERSION && client_msg_id == client_id && msg_id == message_id
            && *queued != Some(true) && job_id.is_none())
        {
            return Ok(false);
        }
        let (directory, record) = (self.directory.clone(), record.clone());
        tokio::task::spawn_blocking(move || {
            let path = record_path(&directory, record.client_msg_id());
            match ensure_same(&path, &record) {
                Ok(()) => {}
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    return Ok(true)
                }
                Err(error) => return Err(error),
            }
            match fs::remove_file(&path) {
                Ok(()) => File::open(&directory)?.sync_all()?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            Ok(true)
        })
        .await?
    }
}

pub(crate) struct DeliveryGuard {
    outbox: Arc<TerminalOutbox>,
    client_msg_id: String,
}

impl Drop for DeliveryGuard {
    fn drop(&mut self) {
        self.outbox
            .in_flight
            .lock()
            .expect("terminal deliveries poisoned")
            .remove(&self.client_msg_id);
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn record_path(directory: &Path, client_msg_id: &str) -> PathBuf {
    directory.join(format!("{}.json", digest(client_msg_id.as_bytes())))
}

pub(crate) fn terminal_ids(frame: &DataOutbound) -> Option<(&str, &str)> {
    match frame {
        DataOutbound::Done {
            client_msg_id,
            msg_id,
            ..
        }
        | DataOutbound::Error {
            client_msg_id,
            msg_id,
            ..
        } => Some((client_msg_id, msg_id)),
        _ => None,
    }
}

fn validate(record: &Record, scope: &Scope) -> anyhow::Result<()> {
    if record.version != 1 || &record.scope != scope {
        return Err(anyhow!("terminal outbox scope/version mismatch"));
    }
    match &record.frame {
        DataOutbound::Done {
            execution: Some(_),
            acp_capability: None,
            client_msg_id,
            msg_id,
            ..
        }
        | DataOutbound::Error {
            execution: Some(_),
            acp_capability: None,
            client_msg_id,
            msg_id,
            ..
        } if !client_msg_id.is_empty() && !msg_id.is_empty() => Ok(()),
        _ => Err(anyhow!(
            "terminal outbox requires an unsigned execution-owned Done/Error"
        )),
    }
}

fn read_record(path: &Path) -> anyhow::Result<Record> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn ensure_same(path: &Path, expected: &Record) -> anyhow::Result<()> {
    if serde_json::to_value(read_record(path)?)? != serde_json::to_value(expected)? {
        return Err(anyhow!("conflicting terminal outbox correlation ID"));
    }
    Ok(())
}

fn private_directory(path: &Path) -> anyhow::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    // Persist newly created directory links as well as the result's own link.
    let mut current = Some(path);
    while let Some(directory) = current {
        File::open(directory)?.sync_all()?;
        current = directory
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::TaskExecution;

    fn scope(account: &str, control: &str, bot: &str, host: &str) -> Scope {
        Scope::new(
            account.into(),
            control,
            "wss://example.test/data",
            bot.into(),
            Some(host.into()),
        )
        .unwrap()
    }

    fn base_scope() -> Scope {
        scope("account", "wss://example.test/control", "bot", "host")
    }

    fn frame(client: &str) -> DataOutbound {
        DataOutbound::Done {
            v: BRIDGE_PROTOCOL_VERSION,
            client_msg_id: client.into(),
            msg_id: "message".into(),
            execution: Some(TaskExecution {
                task_id: "task".into(),
                execution_id: "execution".into(),
                channel_id: "channel".into(),
            }),
            content: Some("exact terminal result".into()),
            file_ids: vec!["file".into()],
            mention_ids: vec!["mention".into()],
            provider_session_key: Some("provider".into()),
            provider_session_id: Some("acp".into()),
            session_id: Some("session".into()),
            acp_capability: None,
        }
    }

    fn ack(client: &str) -> DataInbound {
        DataInbound::TerminalAck {
            v: BRIDGE_PROTOCOL_VERSION,
            client_msg_id: client.into(),
            ok: true,
            msg_id: Some("message".into()),
            queued: None,
            job_id: None,
            error: None,
            code: None,
            retryable: None,
        }
    }

    #[tokio::test]
    async fn immutable_results_survive_restart_and_only_committed_exact_ack_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let outbox = TerminalOutbox::new(&path, base_scope()).unwrap();
        let original = frame("result");
        let record = outbox.persist(original.clone()).await.unwrap();
        let restarted = TerminalOutbox::new(&path, base_scope()).unwrap();
        assert_eq!(
            serde_json::to_value(&restarted.pending().await.unwrap()[0].frame).unwrap(),
            serde_json::to_value(original).unwrap()
        );
        let good = serde_json::to_value(ack("result")).unwrap();
        for patch in [
            serde_json::json!({"v":2}),
            serde_json::json!({"client_msg_id":"other"}),
            serde_json::json!({"msg_id":"other"}),
            serde_json::json!({"msg_id":null}),
            serde_json::json!({"ok":false,"retryable":false}),
            serde_json::json!({"queued":true}),
            serde_json::json!({"job_id":"queued-job"}),
        ] {
            let mut value = good.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(!restarted
                .acknowledge(&record, &serde_json::from_value(value).unwrap())
                .await
                .unwrap());
            assert_eq!(restarted.pending().await.unwrap().len(), 1);
        }
        assert!(restarted
            .acknowledge(&record, &ack("result"))
            .await
            .unwrap());
        assert!(outbox.pending().await.unwrap().is_empty());
        assert!(outbox.acknowledge(&record, &ack("result")).await.unwrap());
    }

    #[tokio::test]
    async fn endpoint_account_bot_host_scopes_never_cross_and_secrets_are_hashed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let protected = scope(
            "account",
            "wss://user:secret@example.test/control?tenant=one&token=private",
            "bot",
            "host",
        );
        let outbox = TerminalOutbox::new(&path, protected.clone()).unwrap();
        let record = outbox.persist(frame("shared-id")).await.unwrap();
        let text = fs::read_to_string(record_path(&outbox.directory, "shared-id")).unwrap();
        assert!(!text.contains("secret") && !text.contains("private") && !text.contains("tenant="));
        for other in [
            scope(
                "other",
                "wss://user:secret@example.test/control?tenant=one&token=private",
                "bot",
                "host",
            ),
            scope(
                "account",
                "wss://user:secret@example.test/control?tenant=two&token=private",
                "bot",
                "host",
            ),
            scope(
                "account",
                "wss://other:secret@example.test/control?tenant=one&token=private",
                "bot",
                "host",
            ),
            scope(
                "account",
                "wss://user:secret@example.test/control?tenant=one&token=private",
                "other-bot",
                "host",
            ),
            scope(
                "account",
                "wss://user:secret@example.test/control?tenant=one&token=private",
                "bot",
                "other-host",
            ),
        ] {
            let foreign = TerminalOutbox::new(&path, other).unwrap();
            assert!(foreign.pending().await.unwrap().is_empty());
            assert!(foreign
                .acknowledge(&record, &ack("shared-id"))
                .await
                .is_err());
        }
        assert_eq!(outbox.pending().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn conflicting_payloads_and_concurrent_publishers_cannot_replace_results() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let a = TerminalOutbox::new(&path, base_scope()).unwrap();
        let b = TerminalOutbox::new(&path, base_scope()).unwrap();
        let (one, two) = tokio::join!(a.persist(frame("one")), b.persist(frame("two")));
        one.unwrap();
        two.unwrap();
        a.persist(frame("one")).await.unwrap();
        let mut changed = frame("one");
        if let DataOutbound::Done { content, .. } = &mut changed {
            *content = Some("conflict".into());
        }
        assert!(b.persist(changed).await.is_err());
        assert_eq!(a.pending().await.unwrap().len(), 2);
        let malformed = a.directory.join("corrupt.json");
        fs::write(&malformed, "broken").unwrap();
        assert_eq!(a.pending().await.unwrap().len(), 2);
        assert!(malformed.exists());
    }

    #[tokio::test]
    async fn transient_first_batch_does_not_starve_later_persisted_results() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = TerminalOutbox::new(&dir.path().join("state.json"), base_scope()).unwrap();
        for number in 0..40 {
            outbox
                .persist(frame(&format!("result-{number}")))
                .await
                .unwrap();
        }
        let first = outbox.pending().await.unwrap();
        assert_eq!(first.len(), 32);
        // No ACK removes these retryable results. Cursor still advances.
        let second = outbox.pending().await.unwrap();
        assert_eq!(second.len(), 32);
        let attempted: HashSet<_> = first
            .iter()
            .chain(second.iter())
            .map(|record| record.client_msg_id())
            .collect();
        assert_eq!(attempted.len(), 40);
        for record in &first {
            outbox.reject_until_restart(record);
        }
        assert_eq!(outbox.pending().await.unwrap().len(), 8);
        let reopened = TerminalOutbox::new(&dir.path().join("state.json"), base_scope()).unwrap();
        assert_eq!(
            reopened.pending().await.unwrap().len(),
            32,
            "permanent rejects are retained across restart"
        );
    }

    #[tokio::test]
    async fn failed_append_cannot_report_success_or_publish_a_partial_result() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("file");
        fs::write(&blocker, "not a directory").unwrap();
        let outbox = TerminalOutbox::new(&blocker.join("state.json"), base_scope()).unwrap();
        assert!(outbox.persist(frame("cannot-persist")).await.is_err());
        assert_eq!(fs::read_to_string(blocker).unwrap(), "not a directory");
    }
}
