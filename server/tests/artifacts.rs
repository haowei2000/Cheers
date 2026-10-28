#![cfg(feature = "integration")]

use serde_json::{json, Value};
use server::resource::{artifacts, fs, Principal};
use sqlx::PgPool;
use uuid::Uuid;

async fn channel(db: &PgPool) -> (Uuid, Principal) {
    let ws = Uuid::new_v4().to_string();
    let channel = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Artifacts test')")
        .bind(&ws)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'Artifacts')")
        .bind(channel.to_string())
        .bind(&ws)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$1,'unused')")
        .bind(user.to_string())
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'owner','active')")
        .bind(&ws).bind(user.to_string()).execute(db).await.unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','owner')")
        .bind(channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
    (channel, Principal::user(user))
}

async fn create(db: &PgPool, ch: Uuid, p: &Principal, path: &str) -> Value {
    artifacts::handle_create(
        db,
        p,
        &json!({"channel_id":ch,"path":path,"content":"first"}),
    )
    .await
    .unwrap()["artifact"]
        .clone()
}

#[sqlx::test]
async fn artifact_create_retries_commit_once_and_recheck_access(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let input = json!({"channel_id": ch, "path": "retry.html", "content": "hello", "idempotency_key": "create-retry"});
    let (first, second) = tokio::join!(
        artifacts::handle_create(&db, &p, &input),
        artifacts::handle_create(&db, &p, &input),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first["artifact"], second["artifact"]);
    assert_eq!(first["channel_seq"], second["channel_seq"]);
    assert_ne!(first["idempotent_replay"], second["idempotent_replay"]);
    assert_eq!(first["artifact"]["version"], 1);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM context_files WHERE channel_id=$1 AND path='retry.html'",
    )
    .bind(ch.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let mut changed = input.clone();
    changed["content"] = json!("different");
    assert_eq!(
        artifacts::handle_create(&db, &p, &changed)
            .await
            .unwrap_err()
            .0,
        "E_IDEMPOTENCY_KEY_REUSED"
    );
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1")
        .bind(ch.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert!(artifacts::handle_create(&db, &p, &input).await.is_err());
}

#[sqlx::test]
async fn artifact_structured_edits_use_identity_and_artifact_versions(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let created = artifacts::handle_create(
        &db,
        &p,
        &json!({"channel_id":ch,"path":"board.yaml","content":"# Keep comment\nvalue: 1\n"}),
    )
    .await
    .unwrap();
    let id = &created["artifact"]["artifact_id"];
    fs::handle_mv(
        &db,
        &p,
        &json!({"channel_id":ch,"from":"board.yaml","to":"renamed.yaml"}),
    )
    .await
    .unwrap();
    let input = json!({"channel_id":ch,"artifact_id":id,"if_version":2,
        "ops":[{"op":"set","path":["value"],"value":2}]});
    let patched = artifacts::handle_patch(&db, &p, &input).await.unwrap();
    assert_eq!(patched["artifact"]["artifact_id"], *id);
    assert_eq!(patched["artifact"]["version"], 3);
    let content = artifacts::handle_read(&db, &p, &json!({"channel_id":ch,"artifact_id":id}))
        .await
        .unwrap();
    assert!(content["content"]
        .as_str()
        .unwrap()
        .contains("# Keep comment"));
    assert_eq!(content["data"]["value"], 2);
    assert_eq!(
        artifacts::handle_patch(&db, &p, &input)
            .await
            .unwrap_err()
            .0,
        "VERSION_CONFLICT"
    );
    // The provider lock also checks identity, even if a replacement has the same version.
    let wrong = fs::handle_patch(
        &db,
        &p,
        &json!({"channel_id":ch,"path":"renamed.yaml",
        "if_version":3,"expected_file_id":"different-file","ops":input["ops"]}),
    )
    .await
    .unwrap_err();
    assert_eq!(wrong.0, "VERSION_CONFLICT");
}

#[sqlx::test]
async fn artifact_literal_paths_do_not_use_locator_syntax(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let path = "Quarterly report #1.html";
    let item = create(&db, ch, &p, path).await;
    let resolved = artifacts::handle_resolve(&db, &p, &json!({"channel_id":ch,"path":path}))
        .await
        .unwrap();
    assert_eq!(resolved["artifact_id"], item["artifact_id"]);
    let ambiguous = artifacts::handle_resolve(
        &db,
        &p,
        &json!({"channel_id":ch,"path":path,"uri":item["uri"]}),
    )
    .await
    .unwrap_err();
    assert_eq!(ambiguous.0, "INVALID_PARAMS");
    let invalid = artifacts::handle_list(&db, &p, &json!({"channel_id":ch,"limit":"50"}))
        .await
        .unwrap_err();
    assert_eq!(invalid.0, "INVALID_PARAMS");
}

#[sqlx::test]
async fn artifact_identity_survives_rename_and_rejects_stale_writes(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let first = create(&db, ch, &p, "page.tsx").await;
    let id = &first["artifact_id"];
    fs::handle_mv(
        &db,
        &p,
        &json!({"channel_id":ch,"from":"page.tsx","to":"renamed.tsx"}),
    )
    .await
    .unwrap();
    let current = artifacts::handle_get(&db, &p, &json!({"channel_id":ch,"artifact_id":id}))
        .await
        .unwrap();
    assert_eq!(current["path"], "renamed.tsx");
    assert_eq!(current["uri"], first["uri"]);
    assert_eq!(current["version"], 2);
    let stale = artifacts::handle_update(
        &db,
        &p,
        &json!({"channel_id":ch,"artifact_id":id,"content":"stale","if_version":1}),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.0, "VERSION_CONFLICT");
    artifacts::handle_update(
        &db,
        &p,
        &json!({"channel_id":ch,"artifact_id":id,"content":"updated","if_version":2}),
    )
    .await
    .unwrap();
    let read = artifacts::handle_read(&db, &p, &json!({"channel_id":ch,"artifact_id":id}))
        .await
        .unwrap();
    assert_eq!(read["content"], "updated");
    assert_eq!(read["artifact"]["version"], 3);
    let snapshot: Value = sqlx::query_scalar(
        "SELECT snapshot FROM artifact_revisions WHERE artifact_id=$1 AND version=1",
    )
    .bind(id.as_str().unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(snapshot["content"], "first");
    // Even if a path is recreated with the same provider version, ID-based writes
    // must reject it under the provider's row lock.
    let other = create(&db, ch, &p, "page.tsx").await;
    let wrong = fs::handle_write(
        &db,
        &p,
        &json!({"channel_id":ch,"path":"page.tsx","content":"wrong",
        "if_version":1,"expected_file_id":first["source_id"]}),
    )
    .await
    .unwrap_err();
    assert_eq!(wrong.0, "VERSION_CONFLICT");
    assert_ne!(id, &other["artifact_id"]);
}

#[sqlx::test]
async fn artifact_catalog_combines_sources_and_preserves_expiry(db: PgPool) {
    let (ch, p) = channel(&db).await;
    create(&db, ch, &p, "report.md").await;
    create(&db, ch, &p, ".workbench.json").await;
    let file = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO file_records(file_id,channel_id,uploader_id,original_path,original_filename,status,expires_at) VALUES($1,$2,$3,'report.pdf','report.pdf','uploaded',NOW()-INTERVAL '1 minute')")
        .bind(&file).bind(ch.to_string()).bind(p.principal_id.to_string()).execute(&db).await.unwrap();
    let page = artifacts::handle_list(&db, &p, &json!({"channel_id":ch}))
        .await
        .unwrap();
    assert_eq!(page["artifacts"].as_array().unwrap().len(), 2);
    let attachment = page["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["source_kind"] == "attachment")
        .unwrap();
    assert_eq!(attachment["availability"], "expired");
    let read = artifacts::handle_read(
        &db,
        &p,
        &json!({"channel_id":ch,"artifact_id":attachment["artifact_id"]}),
    )
    .await
    .unwrap_err();
    assert_eq!(read.0, "ARTIFACT_UNAVAILABLE");
    let legacy = artifacts::handle_resolve(
        &db,
        &p,
        &json!({"channel_id":ch,"uri":format!("cheers:inbox/{file}")}),
    )
    .await
    .unwrap();
    assert_eq!(legacy["artifact_id"], attachment["artifact_id"]);
    // Backfill can be repeated without inventing a new identity or version.
    sqlx::query("SELECT sync_channel_artifact('attachment',to_jsonb(f),FALSE) FROM file_records f WHERE file_id=$1")
        .bind(&file).execute(&db).await.unwrap();
    let again = artifacts::handle_get(
        &db,
        &p,
        &json!({"channel_id":ch,"artifact_id":attachment["artifact_id"]}),
    )
    .await
    .unwrap();
    assert_eq!(again["version"], 1);
}

#[sqlx::test]
async fn artifact_deletion_and_directory_conversion_leave_tombstones(db: PgPool) {
    let (ch, p) = channel(&db).await;
    let first = create(&db, ch, &p, "draft.md").await;
    fs::handle_rm(&db, &p, &json!({"channel_id":ch,"path":"draft.md"}))
        .await
        .unwrap();
    let deleted = artifacts::handle_get(
        &db,
        &p,
        &json!({"channel_id":ch,"artifact_id":first["artifact_id"]}),
    )
    .await
    .unwrap();
    assert_eq!(deleted["availability"], "deleted");
    let next = create(&db, ch, &p, "draft.md").await;
    assert_ne!(next["artifact_id"], first["artifact_id"]);
    fs::handle_write(
        &db,
        &p,
        &json!({"channel_id":ch,"path":"draft.md","is_dir":true}),
    )
    .await
    .unwrap();
    let directory = artifacts::handle_get(
        &db,
        &p,
        &json!({"channel_id":ch,"artifact_id":next["artifact_id"]}),
    )
    .await
    .unwrap();
    assert_eq!(directory["availability"], "deleted");
    assert_eq!(directory["version"], 2);
    let page = artifacts::handle_list(&db, &p, &json!({"channel_id":ch}))
        .await
        .unwrap();
    assert!(page["artifacts"].as_array().unwrap().is_empty());
}

#[sqlx::test]
async fn artifact_pagination_and_authorization_use_channel_scope(db: PgPool) {
    let (ch, p) = channel(&db).await;
    for path in ["a.md", "b.html", "c.tsx"] {
        create(&db, ch, &p, path).await;
    }
    let one = artifacts::handle_list(&db, &p, &json!({"channel_id":ch,"limit":2}))
        .await
        .unwrap();
    let two = artifacts::handle_list(
        &db,
        &p,
        &json!({"channel_id":ch,"limit":2,"before":one["next_cursor"]}),
    )
    .await
    .unwrap();
    assert_eq!(two["artifacts"].as_array().unwrap().len(), 1);
    assert!(two["next_cursor"].is_null());
    let id = &one["artifacts"][0]["artifact_id"];
    assert_ne!(&two["artifacts"][0]["artifact_id"], id);
    let (other_ch, other_p) = channel(&db).await;
    assert_eq!(
        artifacts::handle_get(&db, &other_p, &json!({"channel_id":ch,"artifact_id":id}))
            .await
            .unwrap_err()
            .0,
        "NOT_MEMBER"
    );
    assert_eq!(
        artifacts::handle_get(
            &db,
            &other_p,
            &json!({"channel_id":other_ch,"artifact_id":id})
        )
        .await
        .unwrap_err()
        .0,
        "NOT_FOUND"
    );
    assert!(
        artifacts::handle_list(&db, &p, &json!({"channel_id":ch,"limit":0}))
            .await
            .is_err()
    );
    sqlx::query("UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1")
        .bind(ch.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert!(artifacts::handle_update(
        &db,
        &p,
        &json!({"channel_id":ch,"artifact_id":id,"content":"denied","if_version":1})
    )
    .await
    .is_err());
}
