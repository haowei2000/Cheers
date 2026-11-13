//! F2 durable asynchronous mirror. Provider transactions enqueue immutable revisions;
//! reads still use the providers. A short lease survives crashes and keeps S3 I/O out
//! of database transactions. Completing an old revision never advances the head.
use std::{sync::Arc, time::Duration};

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

#[async_trait]
pub trait ObjectStore: Send + Sync {
    async fn put(
        &self,
        bucket: &str,
        key: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<()>;
    async fn get(&self, bucket: &str, key: &str) -> anyhow::Result<Vec<u8>>;
    async fn delete(&self, bucket: &str, key: &str) -> anyhow::Result<()>;
}

#[async_trait]
impl ObjectStore for aws_sdk_s3::Client {
    async fn put(
        &self,
        bucket: &str,
        key: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<()> {
        crate::infra::s3::put_object(self, bucket, key, content_type, bytes).await
    }
    async fn get(&self, bucket: &str, key: &str) -> anyhow::Result<Vec<u8>> {
        crate::infra::s3::get_object(self, bucket, key).await
    }
    async fn delete(&self, bucket: &str, key: &str) -> anyhow::Result<()> {
        crate::infra::s3::delete_object(self, bucket, key).await
    }
}

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

struct Job {
    artifact_id: String,
    version: i64,
    channel_id: String,
    source_kind: String,
    snapshot: Option<Value>,
}

struct Stored {
    bucket: String,
    key: String,
    hash: String,
}

async fn copy_revision(
    db: &PgPool,
    store: &dyn ObjectStore,
    bucket: &str,
    job: &Job,
) -> anyhow::Result<Stored> {
    let snapshot = job.snapshot.as_ref().context("revision snapshot missing")?;
    if job.source_kind == "text" {
        let bytes = snapshot
            .get("content")
            .and_then(Value::as_str)
            .context("text revision content missing")?
            .as_bytes()
            .to_vec();
        let hash = sha256(&bytes);
        let key = format!(
            "artifacts/{}/{}/{}-{}",
            job.channel_id, job.artifact_id, job.version, hash
        );
        sqlx::query!("INSERT INTO artifact_object_uploads(object_bucket,object_key,artifact_id,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", bucket, &key, &job.artifact_id, job.version).execute(db).await?;
        store
            .put(bucket, &key, "text/plain; charset=utf-8", bytes)
            .await?;
        // Verify the remote copy before publishing its metadata.
        if sha256(&store.get(bucket, &key).await?) != hash {
            return Err(anyhow!("uploaded object hash mismatch"));
        }
        Ok(Stored {
            bucket: bucket.to_owned(),
            key,
            hash,
        })
    } else {
        let key = snapshot
            .get("object_key")
            .and_then(Value::as_str)
            .context("attachment key missing")?;
        let bucket = snapshot
            .get("storage_bucket")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or(bucket);
        let bytes = store.get(bucket, key).await?;
        if let Some(size) = snapshot.get("size_bytes").and_then(Value::as_u64) {
            anyhow::ensure!(bytes.len() as u64 == size, "attachment size mismatch");
        }
        Ok(Stored {
            bucket: bucket.to_owned(),
            key: key.to_owned(),
            hash: sha256(&bytes),
        })
    }
}

/// Copies at most one due revision. Failed copies retain their intent with bounded
/// backoff; `Ok(true)` means a job was attempted, not necessarily completed.
pub async fn mirror_one(
    db: &PgPool,
    store: &dyn ObjectStore,
    bucket: &str,
) -> anyhow::Result<bool> {
    let token = Uuid::new_v4().to_string();
    let job = sqlx::query_as!(Job,
        r#"WITH candidate AS (
           SELECT artifact_id,version FROM artifact_object_jobs
           WHERE next_attempt_at <= NOW() AND (lease_until IS NULL OR lease_until < NOW())
           ORDER BY next_attempt_at,artifact_id,version FOR UPDATE SKIP LOCKED LIMIT 1
         ), claimed AS (
           UPDATE artifact_object_jobs j SET lease_token=$1,lease_until=NOW()+INTERVAL '2 minutes',attempts=attempts+1
           FROM candidate c WHERE (j.artifact_id,j.version)=(c.artifact_id,c.version) RETURNING j.artifact_id,j.version
         ) SELECT c.artifact_id AS "artifact_id!",c.version AS "version!",a.channel_id,a.source_kind,r.snapshot FROM claimed c
           JOIN artifacts a USING(artifact_id) JOIN artifact_revisions r ON r.artifact_id=c.artifact_id AND r.version=c.version"#, &token).fetch_optional(db).await?;
    let Some(job) = job else {
        return Ok(false);
    };
    let expired = job.source_kind == "attachment"
        && job
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.get("expires_at"))
            .and_then(Value::as_str)
            .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
            .is_some_and(|time| time <= Utc::now());
    if expired {
        let mut tx = db.begin().await?;
        let owned = sqlx::query!("DELETE FROM artifact_object_jobs WHERE artifact_id=$1 AND version=$2 AND lease_token=$3", &job.artifact_id, job.version, &token).execute(&mut *tx).await?.rows_affected();
        if owned == 1 {
            sqlx::query!("UPDATE artifact_revisions SET verification_error='expired before copy' WHERE artifact_id=$1 AND version=$2", &job.artifact_id, job.version).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        return Ok(true);
    }
    let result = tokio::time::timeout(
        Duration::from_secs(60),
        copy_revision(db, store, bucket, &job),
    )
    .await;
    let stored = match result {
        Ok(Ok(stored)) => stored,
        failure => {
            // Detailed storage errors can contain endpoint credentials; persist only a
            // stable operational message. The immutable snapshot remains recoverable.
            let reason = if failure.is_err() {
                "object mirror timed out"
            } else {
                "object mirror failed; retry scheduled"
            };
            sqlx::query!(
                "UPDATE artifact_object_jobs SET lease_token=NULL,lease_until=NULL,last_error=$4,
                next_attempt_at=NOW()+make_interval(secs => LEAST(attempts,60)*10)
                WHERE artifact_id=$1 AND version=$2 AND lease_token=$3",
                &job.artifact_id,
                job.version,
                &token,
                reason
            )
            .execute(db)
            .await?;
            tracing::warn!(artifact_id=%job.artifact_id,version=job.version,reason,"artifact object mirror retry");
            return Ok(true);
        }
    };
    let mut tx = db.begin().await?;
    // Deleting a provider/channel or a newer lease may have invalidated this claim.
    let owned = sqlx::query!(
        "DELETE FROM artifact_object_jobs WHERE artifact_id=$1 AND version=$2 AND lease_token=$3",
        &job.artifact_id,
        job.version,
        &token
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if owned == 1 {
        sqlx::query!("UPDATE artifact_revisions SET object_key=$3,object_bucket=$4,sha256=$5,verified_at=NOW(),verification_error=NULL WHERE artifact_id=$1 AND version=$2", &job.artifact_id, job.version, &stored.key, &stored.bucket, &stored.hash).execute(&mut *tx).await?;
        sqlx::query!("UPDATE artifacts SET object_key=$3,object_bucket=$4,sha256=$5,legacy_id=source_id WHERE artifact_id=$1 AND version=$2", &job.artifact_id, job.version, &stored.key, &stored.bucket, &stored.hash).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// Storage primitive for the later read switch. Callers must authorize the artifact
/// before using it; no public resource handler uses this in F2. A missing mirror
/// falls back to the captured provider revision, never a newer mutable file.
pub async fn read_version(
    db: &PgPool,
    store: &dyn ObjectStore,
    default_bucket: &str,
    artifact_id: &str,
    version: i64,
) -> anyhow::Result<Vec<u8>> {
    let row = sqlx::query!(
        "SELECT r.object_key,r.object_bucket,r.sha256,r.snapshot,a.source_kind FROM artifact_revisions r JOIN artifacts a USING(artifact_id) WHERE r.artifact_id=$1 AND r.version=$2", artifact_id, version).fetch_one(db).await?;
    if let (Some(key), Some(bucket), Some(hash)) =
        (&row.object_key, &row.object_bucket, &row.sha256)
    {
        let bytes = store.get(bucket, key).await?;
        anyhow::ensure!(sha256(&bytes) == *hash, "revision object hash mismatch");
        return Ok(bytes);
    }
    let snapshot = row.snapshot.context("revision provider snapshot missing")?;
    if row.source_kind == "text" {
        return Ok(snapshot
            .get("content")
            .and_then(Value::as_str)
            .context("revision content missing")?
            .as_bytes()
            .to_vec());
    }
    let key = snapshot
        .get("object_key")
        .and_then(Value::as_str)
        .context("attachment key missing")?;
    let bucket = snapshot
        .get("storage_bucket")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .unwrap_or(default_bucket);
    store.get(bucket, key).await
}

struct VerifyRow {
    artifact_id: String,
    version: i64,
    source_kind: String,
    object_key: String,
    object_bucket: String,
    sha256: String,
    snapshot: Option<Value>,
    expires_at: Option<DateTime<Utc>>,
}

/// Bounded round-robin verification. A mismatch never modifies the provider or
/// silently blesses the changed bytes. Expired human attachments are unavailable
/// by contract and may already have been removed by the existing expiry process.
pub async fn verify_batch(db: &PgPool, store: &dyn ObjectStore) -> anyhow::Result<usize> {
    let rows = sqlx::query_as!(VerifyRow, r#"SELECT r.artifact_id,r.version,a.source_kind,r.object_key AS "object_key!",r.object_bucket AS "object_bucket!",r.sha256 AS "sha256!",r.snapshot,a.expires_at
        FROM artifact_revisions r JOIN artifacts a USING(artifact_id)
        WHERE r.object_key IS NOT NULL AND r.object_bucket IS NOT NULL AND r.sha256 IS NOT NULL
          AND (r.verified_at IS NULL OR r.verified_at < NOW()-INTERVAL '1 hour')
        ORDER BY r.verified_at NULLS FIRST,r.artifact_id,r.version LIMIT 10"#)
        .fetch_all(db).await?;
    for row in &rows {
        let expired = row.source_kind == "attachment"
            && row.expires_at.is_some_and(|time| time <= Utc::now());
        let problem = if expired {
            None
        } else {
            match tokio::time::timeout(
                Duration::from_secs(30),
                store.get(&row.object_bucket, &row.object_key),
            )
            .await
            {
                Ok(Ok(bytes)) => {
                    let actual = sha256(&bytes);
                    let source_hash = if row.source_kind == "text" {
                        row.snapshot
                            .as_ref()
                            .and_then(|v| v.get("content"))
                            .and_then(Value::as_str)
                            .map(|text| sha256(text.as_bytes()))
                    } else {
                        Some(row.sha256.clone())
                    };
                    if actual != row.sha256 || source_hash.as_deref() != Some(row.sha256.as_str()) {
                        Some("sha256 mismatch")
                    } else {
                        None
                    }
                }
                _ => Some("object unavailable"),
            }
        };
        sqlx::query!("UPDATE artifact_revisions SET verified_at=NOW(),verification_error=$3 WHERE artifact_id=$1 AND version=$2", &row.artifact_id, row.version, problem).execute(db).await?;
        if let Some(problem) = problem {
            tracing::error!(artifact_id=%row.artifact_id,version=row.version,problem,"artifact object verification failed");
        }
    }
    Ok(rows.len())
}

/// Only delete worker-owned keys whose revision AND pending intent have gone away,
/// after a full day's grace. Never touches retained revisions or attachment keys.
pub async fn sweep_orphans(db: &PgPool, store: &dyn ObjectStore) -> anyhow::Result<usize> {
    let rows = sqlx::query!("SELECT u.object_bucket,u.object_key FROM artifact_object_uploads u
        WHERE u.created_at < NOW()-INTERVAL '1 day'
          AND NOT EXISTS(SELECT 1 FROM artifact_revisions r WHERE r.artifact_id=u.artifact_id AND r.version=u.version)
          AND NOT EXISTS(SELECT 1 FROM artifact_object_jobs j WHERE j.artifact_id=u.artifact_id AND j.version=u.version)
        ORDER BY u.created_at LIMIT 10").fetch_all(db).await?;
    let mut count = 0;
    for row in rows {
        let (bucket, key) = (row.object_bucket, row.object_key);
        if matches!(
            tokio::time::timeout(Duration::from_secs(30), store.delete(&bucket, &key)).await,
            Ok(Ok(()))
        ) {
            sqlx::query!(
                "DELETE FROM artifact_object_uploads WHERE object_bucket=$1 AND object_key=$2",
                &bucket,
                &key
            )
            .execute(db)
            .await?;
            count += 1;
        }
    }
    Ok(count)
}

/// Disable with ARTIFACT_OBJECT_MIRROR=false to roll back to provider-only writes.
/// Intents continue accumulating so re-enabling the worker resumes without loss.
pub fn spawn(db: PgPool, store: aws_sdk_s3::Client, bucket: String) {
    if std::env::var("ARTIFACT_OBJECT_MIRROR").is_ok_and(|v| v == "false" || v == "0") {
        return;
    }
    let store = Arc::new(store);
    let mirror_db = db.clone();
    let mirror_store = store.clone();
    tokio::spawn(async move {
        // Startup may have happened during a storage outage. Retry bucket bootstrap
        // too, otherwise a new installation would keep retrying NoSuchBucket forever.
        loop {
            if matches!(
                tokio::time::timeout(
                    Duration::from_secs(30),
                    crate::infra::s3::ensure_bucket(mirror_store.as_ref(), &bucket)
                )
                .await,
                Ok(Ok(()))
            ) {
                break;
            }
            tracing::warn!("artifact mirror waiting for object bucket");
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        loop {
            match mirror_one(&mirror_db, mirror_store.as_ref(), &bucket).await {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => tracing::warn!(%error,"artifact mirror database operation failed"),
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = verify_batch(&db, store.as_ref()).await {
                tracing::warn!(%error,"artifact verifier failed");
            }
            if let Err(error) = sweep_orphans(&db, store.as_ref()).await {
                tracing::warn!(%error,"artifact orphan sweep failed");
            }
        }
    });
}
