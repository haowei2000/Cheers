//! Other membership writers share channel detachment's transaction guard.
#![cfg(feature = "integration")]

use std::time::Duration;

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use server::domain::integrations::{
    bindings::{self, ExternalCollaborator},
    projection::RoleProjection,
};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

async fn wait_for_guard(db: &PgPool, blocker: i32, expected: i64) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pg_stat_activity
                 WHERE datname=current_database() AND wait_event='advisory'
                   AND $1=ANY(pg_blocking_pids(pid))",
            )
            .bind(blocker)
            .fetch_one(db)
            .await
            .unwrap();
            if waiting >= expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the real writer must reach the channel guard before the barrier is released");
}

#[sqlx::test]
async fn integration_sync_waits_before_snapshotting_a_new_manual_owner(db: PgPool) {
    let (actor, member, workspace, channel) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    for user in [actor, member] {
        sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'unused')")
            .bind(user.to_string())
            .bind(format!("projection-{user}"))
            .execute(&db)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Projection authority')")
        .bind(workspace.to_string())
        .execute(&db)
        .await
        .unwrap();
    for user in [actor, member] {
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(workspace.to_string()).bind(user.to_string()).execute(&db).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'Projection authority')",
    )
    .bind(channel.to_string())
    .bind(workspace.to_string())
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role,projected_from) VALUES($1,$2,'user','owner',NULL),($1,$3,'user','admin','fixture-projection')")
        .bind(channel.to_string()).bind(actor.to_string()).bind(member.to_string()).execute(&db).await.unwrap();
    let subject = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO auth_external_identities(identity_id,provider,subject,user_id,corp_id) VALUES($1,'github',$2,$3,'fixture')")
        .bind(Uuid::new_v4().to_string()).bind(&subject).bind(member.to_string()).execute(&db).await.unwrap();

    let mut manual = db.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *manual)
        .await
        .unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(1128811842,hashtext($1))")
        .bind(channel.to_string())
        .execute(&mut *manual)
        .await
        .unwrap();
    let sync_db = db.clone();
    let syncing = tokio::spawn(async move {
        let projection = RoleProjection::new(vec![("pull".into(), "readonly".into())]).unwrap();
        bindings::sync_members(
            &sync_db,
            &channel.to_string(),
            "fixture-projection",
            "github",
            &projection,
            &[ExternalCollaborator {
                subject,
                role: "pull".into(),
            }],
            &actor.to_string(),
        )
        .await
    });
    wait_for_guard(&db, pid, 1).await;
    // The canonical manual-role SQL runs while this transaction owns the guard.
    // The sync must read the released marker after this commit, not rewrite a
    // projected role it read before waiting.
    sqlx::query(include_str!("../queries/set_human_role.sql"))
        .bind(channel.to_string())
        .bind(member.to_string())
        .bind("owner")
        .execute(&mut *manual)
        .await
        .unwrap();
    manual.commit().await.unwrap();
    let report = tokio::time::timeout(Duration::from_secs(10), syncing)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(report.preserved_manual, 1);
    assert_eq!(report.rewritten, 0);
    let membership: (String, Option<String>) = sqlx::query_as(
        "SELECT role,projected_from FROM channel_memberships WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(channel.to_string())
    .bind(member.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(membership, ("owner".into(), None));
}

async fn request(
    client: &Client,
    base: &str,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = client.request(method, format!("{base}/api/v1{path}"));
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    let body = serde_json::from_str(&text).unwrap_or_else(|_| json!({"raw":text}));
    (status, body)
}

#[sqlx::test]
async fn account_deletion_serializes_its_owner_transfer_with_a_real_owner_leave(db: PgPool) {
    let admin_password = Uuid::new_v4().to_string();
    let (_gateway, base) =
        gateway::TestGateway::start(&db, "participants-admin", &admin_password).await;
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let (status, auth) = request(
        &client,
        &base,
        "",
        Method::POST,
        "/auth/login",
        Some(json!({"login":"participants-admin","password":admin_password})),
    )
    .await;
    assert!(status.is_success(), "{status} {auth}");
    let admin_token = auth["access_token"].as_str().unwrap().to_owned();
    let admin = auth["user_id"].as_str().unwrap().to_owned();
    let (status, workspace) = request(
        &client,
        &base,
        &admin_token,
        Method::POST,
        "/workspaces",
        Some(json!({"name":"Deletion owner race"})),
    )
    .await;
    assert!(status.is_success(), "{status} {workspace}");
    let workspace = workspace["workspace_id"].as_str().unwrap().to_owned();
    let (status, channel) = request(
        &client,
        &base,
        &admin_token,
        Method::POST,
        "/channels",
        Some(json!({"workspace_id":workspace,"name":"Deletion owner race"})),
    )
    .await;
    assert!(status.is_success(), "{status} {channel}");
    let channel = channel["channel_id"].as_str().unwrap().to_owned();
    let login = format!("deleting-owner-{}", Uuid::new_v4());
    let password = Uuid::new_v4().to_string();
    let (status, user) = request(
        &client,
        &base,
        &admin_token,
        Method::POST,
        "/users",
        Some(json!({"username":login,"password":password,"role":"member"})),
    )
    .await;
    assert!(status.is_success(), "{status} {user}");
    let user = user["user_id"].as_str().unwrap().to_owned();
    let (status, auth) = request(
        &client,
        &base,
        "",
        Method::POST,
        "/auth/login",
        Some(json!({"login":login,"password":password})),
    )
    .await;
    assert!(status.is_success(), "{status} {auth}");
    assert_eq!(
        auth["role"], "member",
        "delete an independent non-admin owner"
    );
    let token = auth["access_token"].as_str().unwrap().to_owned();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
        .bind(&workspace).bind(&user).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','owner')")
        .bind(&channel).bind(&user).execute(&db).await.unwrap();

    let mut barrier = db.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(1128811842,hashtext($1))")
        .bind(&channel)
        .execute(&mut *barrier)
        .await
        .unwrap();
    let (delete_client, delete_base) = (client.clone(), base.clone());
    let deleting = tokio::spawn(async move {
        request(
            &delete_client,
            &delete_base,
            &token,
            Method::POST,
            "/users/me/delete",
            Some(json!({"confirmation":"DELETE","current_password":password})),
        )
        .await
    });
    wait_for_guard(&db, pid, 1).await;
    let (leave_client, leave_base, leave_token, leave_channel) =
        (client.clone(), base.clone(), admin_token, channel.clone());
    let leaving = tokio::spawn(async move {
        request(
            &leave_client,
            &leave_base,
            &leave_token,
            Method::POST,
            &format!("/channels/{leave_channel}/leave"),
            None,
        )
        .await
    });
    wait_for_guard(&db, pid, 2).await;
    barrier.commit().await.unwrap();
    let (deletion, leave) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(deleting, leaving)
    })
    .await
    .expect("account cleanup and channel leave must not invert their lock order");
    let (status, body) = deletion.unwrap();
    assert!(status.is_success(), "account deletion: {status} {body}");
    let (status, body) = leave.unwrap();
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the remaining owner cannot leave: {body}"
    );
    let state: (bool, i64, i64, bool) = sqlx::query_as(
        "SELECT (SELECT is_deleted FROM users WHERE user_id=$1),
                (SELECT COUNT(*) FROM channel_memberships WHERE member_id=$1 AND member_type='user'),
                (SELECT COUNT(*) FROM channel_memberships WHERE channel_id=$2 AND member_type='user' AND role='owner'),
                (SELECT archived_at IS NULL FROM channels WHERE channel_id=$2)",
    )
    .bind(&user)
    .bind(&channel)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(state, (true, 0, 1, true));
    let remaining: String = sqlx::query_scalar("SELECT member_id FROM channel_memberships WHERE channel_id=$1 AND member_type='user' AND role='owner'")
        .bind(&channel).fetch_one(&db).await.unwrap();
    assert_eq!(remaining, admin);
}
