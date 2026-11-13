#![cfg(feature = "integration")]

use async_trait::async_trait;
use serde_json::json;
use server::resource::{
    artifact_store::{self, ObjectStore},
    artifacts, fs, Principal,
};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use uuid::Uuid;

#[derive(Default)]
struct MemoryStore {
    objects: Mutex<HashMap<(String, String), Vec<u8>>>,
    fail: AtomicBool,
}
#[async_trait]
impl ObjectStore for MemoryStore {
    async fn put(
        &self,
        bucket: &str,
        key: &str,
        _mime: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!self.fail.load(Ordering::SeqCst), "offline");
        self.objects
            .lock()
            .unwrap()
            .insert((bucket.into(), key.into()), bytes);
        Ok(())
    }
    async fn get(&self, bucket: &str, key: &str) -> anyhow::Result<Vec<u8>> {
        anyhow::ensure!(!self.fail.load(Ordering::SeqCst), "offline");
        self.objects
            .lock()
            .unwrap()
            .get(&(bucket.into(), key.into()))
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing"))
    }
    async fn delete(&self, bucket: &str, key: &str) -> anyhow::Result<()> {
        self.objects
            .lock()
            .unwrap()
            .remove(&(bucket.into(), key.into()));
        Ok(())
    }
}

async fn channel(db: &PgPool) -> (Uuid, Principal) {
    let ch = Uuid::new_v4();
    let user = Uuid::new_v4();
    let ws = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Mirror test')")
        .bind(&ws)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'Mirror')")
        .bind(ch.to_string())
        .bind(&ws)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$1,'unused')")
        .bind(user.to_string())
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'owner','active')").bind(&ws).bind(user.to_string()).execute(db).await.unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','owner')").bind(ch.to_string()).bind(user.to_string()).execute(db).await.unwrap();
    (ch, Principal::user(user))
}
async fn text(db: &PgPool, ch: Uuid, p: &Principal, content: &str) -> String {
    artifacts::handle_create(
        db,
        p,
        &json!({"channel_id":ch,"path":"note.md","content":content}),
    )
    .await
    .unwrap()["artifact"]["artifact_id"]
        .as_str()
        .unwrap()
        .into()
}
async fn head(db: &PgPool, id: &str) -> (i64, Option<String>, Option<String>) {
    sqlx::query_as("SELECT version,object_key,sha256 FROM artifacts WHERE artifact_id=$1")
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

#[sqlx::test]
async fn every_revision_is_mirrored_without_an_old_job_replacing_the_head(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let store = MemoryStore::default();
    let id = text(&db, ch, &p, "first ☕").await;
    fs::handle_write(
        &db,
        &p,
        &json!({"channel_id":ch,"path":"note.md","content":"second","if_version":1}),
    )
    .await
    .unwrap();
    assert_eq!(head(&db, &id).await, (2, None, None));
    assert_eq!(
        artifact_store::read_version(&db, &store, "mirror", &id, 1)
            .await
            .unwrap(),
        "first ☕".as_bytes()
    );
    assert!(artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
    assert_eq!(head(&db, &id).await, (2, None, None));
    assert!(artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
    let (version, key, hash) = head(&db, &id).await;
    assert_eq!(version, 2);
    assert_eq!(
        hash.as_deref(),
        Some(artifact_store::sha256(b"second").as_str())
    );
    assert_eq!(store.get("mirror", &key.unwrap()).await.unwrap(), b"second");
    let rows:Vec<(i64,String,String)>=sqlx::query_as("SELECT version,object_key,sha256 FROM artifact_revisions WHERE artifact_id=$1 ORDER BY version").bind(&id).fetch_all(&db).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        store.get("mirror", &rows[0].1).await.unwrap(),
        "first ☕".as_bytes()
    );
    assert_eq!(rows[0].2, artifact_store::sha256("first ☕".as_bytes()));
    assert_eq!(
        artifact_store::read_version(&db, &store, "mirror", &id, 2)
            .await
            .unwrap(),
        b"second"
    );
    // Both public reads and metadata stay on the provider contract in F2.
    let result = artifacts::handle_read(&db, &p, &json!({"channel_id":ch,"artifact_id":id}))
        .await
        .unwrap();
    assert_eq!(result["content"], "second");
    assert!(result["artifact"].get("object_key").is_none());
}

#[sqlx::test]
async fn storage_failure_and_crashed_leases_resume_without_losing_the_revision(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let store = MemoryStore::default();
    let id = text(&db, ch, &p, "").await;
    store.fail.store(true, Ordering::SeqCst);
    assert!(artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
    assert_eq!(head(&db, &id).await, (1, None, None));
    assert!(!artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
    store.fail.store(false, Ordering::SeqCst);
    sqlx::query("UPDATE artifact_object_jobs SET next_attempt_at=NOW(),lease_token='crashed',lease_until=NOW()+INTERVAL '1 hour'").execute(&db).await.unwrap();
    assert!(!artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
    sqlx::query("UPDATE artifact_object_jobs SET lease_until=NOW()-INTERVAL '1 minute'")
        .execute(&db)
        .await
        .unwrap();
    assert!(artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
    assert_eq!(head(&db, &id).await.2, Some(artifact_store::sha256(b"")));
    assert!(!artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
}

#[sqlx::test]
async fn verification_detects_corruption_and_orphans_never_include_retained_versions(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let store = MemoryStore::default();
    let id = text(&db, ch, &p, "keep").await;
    artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap();
    let key = head(&db, &id).await.1.unwrap();
    store
        .put("mirror", &key, "text/plain", b"corrupt".to_vec())
        .await
        .unwrap();
    sqlx::query("UPDATE artifact_revisions SET verified_at=NULL")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(artifact_store::verify_batch(&db, &store).await.unwrap(), 1);
    let error: Option<String> = sqlx::query_scalar(
        "SELECT verification_error FROM artifact_revisions WHERE artifact_id=$1",
    )
    .bind(&id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(error.as_deref(), Some("sha256 mismatch"));
    sqlx::query("UPDATE artifact_object_uploads SET created_at=NOW()-INTERVAL '2 days'")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(artifact_store::sweep_orphans(&db, &store).await.unwrap(), 0);
    sqlx::query("DELETE FROM channels WHERE channel_id=$1")
        .bind(ch.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(artifact_store::sweep_orphans(&db, &store).await.unwrap(), 1);
    assert!(store.get("mirror", &key).await.is_err());
}

#[sqlx::test]
async fn attachment_mirror_uses_the_existing_bucket_and_key(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let store = MemoryStore::default();
    let file = Uuid::new_v4().to_string();
    store
        .put(
            "upload-bucket",
            "uploads/original.bin",
            "application/octet-stream",
            vec![0, 255, 4],
        )
        .await
        .unwrap();
    sqlx::query("INSERT INTO file_records(file_id,channel_id,uploader_id,original_path,object_key,storage_bucket,original_filename,size_bytes,status) VALUES($1,$2,$3,'original.bin','uploads/original.bin','upload-bucket','original.bin',3,'uploaded')")
        .bind(&file).bind(ch.to_string()).bind(p.principal_id.to_string()).execute(&db).await.unwrap();
    artifact_store::mirror_one(&db, &store, "different-default")
        .await
        .unwrap();
    let row: (String, String, String, String) = sqlx::query_as(
        "SELECT object_bucket,object_key,sha256,legacy_id FROM artifacts WHERE source_id=$1",
    )
    .bind(&file)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "upload-bucket".into(),
            "uploads/original.bin".into(),
            artifact_store::sha256(&[0, 255, 4]),
            file
        )
    );
    assert_eq!(store.objects.lock().unwrap().len(), 1);
    let tracked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifact_object_uploads")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(tracked, 0, "attachment cleanup belongs to the provider");
}

#[sqlx::test]
async fn rolled_back_writes_never_leave_copy_intents(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let mut tx = db.begin().await.unwrap();
    sqlx::query("INSERT INTO context_files(file_id,channel_id,path,content,created_by) VALUES($1,$2,'rollback.md','discard',$3)")
        .bind(Uuid::new_v4().to_string()).bind(ch.to_string()).bind(p.principal_id.to_string()).execute(&mut *tx).await.unwrap();
    let during: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifact_object_jobs")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(during, 1);
    tx.rollback().await.unwrap();
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifact_object_jobs")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(after, 0);
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn mirror_round_trips_real_s3_bytes(db: PgPool) {
    use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
    let endpoint =
        std::env::var("INTEGRATION_S3_ENDPOINT").expect("explicit local test S3 endpoint");
    let url = url::Url::parse(&endpoint).unwrap();
    assert!(
        matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        "test must use local object storage"
    );
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::config::Builder::new()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(endpoint)
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new(
                std::env::var("INTEGRATION_S3_ACCESS_KEY").unwrap(),
                std::env::var("INTEGRATION_S3_SECRET_KEY").unwrap(),
                None,
                None,
                "test",
            ))
            .force_path_style(true)
            .build(),
    );
    let bucket = format!("artifact-f2-{}", Uuid::new_v4().simple());
    server::infra::s3::ensure_bucket(&client, &bucket)
        .await
        .unwrap();
    let (ch, p) = channel(&db).await;
    let id = text(&db, ch, &p, "真实 S3\n exact bytes").await;
    artifact_store::mirror_one(&db, &client, &bucket)
        .await
        .unwrap();
    let (_, key, hash) = head(&db, &id).await;
    let key = key.unwrap();
    let bytes = client.get(&bucket, &key).await.unwrap();
    assert_eq!(bytes, "真实 S3\n exact bytes".as_bytes());
    assert_eq!(hash, Some(artifact_store::sha256(&bytes)));
    client.delete(&bucket, &key).await.unwrap();
    client.delete_bucket().bucket(bucket).send().await.unwrap();
}

#[sqlx::test]
async fn concurrent_workers_claim_a_revision_once(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let store = MemoryStore::default();
    text(&db, ch, &p, "one copy").await;
    let (left, right) = tokio::join!(
        artifact_store::mirror_one(&db, &store, "mirror"),
        artifact_store::mirror_one(&db, &store, "mirror")
    );
    assert_ne!(left.unwrap(), right.unwrap());
    assert_eq!(store.objects.lock().unwrap().len(), 1);
}

#[sqlx::test]
async fn expired_attachments_do_not_retry_missing_objects_forever(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let store = MemoryStore::default();
    sqlx::query("INSERT INTO file_records(file_id,channel_id,uploader_id,original_path,object_key,storage_bucket,status,expires_at) VALUES($1,$2,$3,'gone.bin','uploads/gone.bin','mirror','uploaded',NOW()-INTERVAL '1 day')")
        .bind(Uuid::new_v4().to_string()).bind(ch.to_string()).bind(p.principal_id.to_string()).execute(&db).await.unwrap();
    assert!(artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
    assert!(!artifact_store::mirror_one(&db, &store, "mirror")
        .await
        .unwrap());
    let reason: String = sqlx::query_scalar("SELECT verification_error FROM artifact_revisions")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(reason, "expired before copy");
}
