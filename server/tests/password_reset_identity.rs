//! Reset proof remains bound to its issued account when mailboxes are ambiguous or change.
#![cfg(feature = "integration")]

use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use server::domain::auth;

#[path = "support/gateway.rs"]
mod gateway;

struct Fixture {
    gateway: gateway::TestGateway,
    base: String,
    client: Client,
    password: String,
    password_hash: String,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let login = format!("reset-owner-{}", Uuid::new_v4());
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, &login, &password).await;
        let password_hash = sqlx::query_scalar("SELECT password_hash FROM users WHERE username=$1")
            .bind(&login)
            .fetch_one(db)
            .await
            .unwrap();
        Self {
            gateway,
            base,
            client: Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap(),
            password,
            password_hash,
        }
    }

    async fn user(&self, db: &PgPool, email: &str) -> String {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO users(user_id,username,email,password_hash,role) VALUES($1,$2,$3,$4,'member')")
            .bind(&id).bind(format!("owner-{id}")).bind(email).bind(&self.password_hash)
            .execute(db).await.unwrap();
        id
    }

    async fn code(&self, db: &PgPool, owner: &str, email: &str, code: &str) -> i32 {
        let email = email.to_lowercase();
        let hash = self.gateway.email_code_hash(&email, "password_reset", code);
        sqlx::query_scalar("INSERT INTO email_codes(email,code,code_hash,purpose,expires_at,user_id) VALUES($1,NULL,$2,'password_reset',clock_timestamp()+INTERVAL '10 minutes',$3) RETURNING id")
            .bind(email).bind(hash).bind(owner).fetch_one(db).await.unwrap()
    }

    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .client
            .post(format!("{}/api/v1{path}", self.base))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or_else(|_| json!({"raw":text})),
        )
    }

    async fn reset(&self, email: &str, code: &str, password: &str) -> (StatusCode, Value) {
        self.post(
            "/auth/reset-password",
            json!({"email":email,"code":code,"new_password":password}),
        )
        .await
    }
}

async fn snapshot(db: &PgPool, user: &str) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object(
        'credential',(SELECT jsonb_build_array(password_hash,token_version) FROM users WHERE user_id=$1),
        'codes',(SELECT jsonb_agg(jsonb_build_array(id,email,used) ORDER BY id) FROM email_codes WHERE user_id=$1))")
        .bind(user).fetch_one(db).await.unwrap()
}

async fn assert_password(db: &PgPool, user: &str, password: &str) {
    let login: String = sqlx::query_scalar("SELECT username FROM users WHERE user_id=$1")
        .bind(user)
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!(
        auth::authenticate(db, &login, password).await.unwrap().id,
        user
    );
}

#[sqlx::test]
async fn separately_bound_codes_reset_only_their_owner_among_casefold_duplicate_mailboxes(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let email = format!("Shared-{}@Example.com", Uuid::new_v4());
    let a = f.user(&db, &email).await;
    let b = f.user(&db, &email.to_lowercase()).await;
    f.code(&db, &a, &email, "AB23CD").await;
    let b_code = f.code(&db, &b, &email, "EF45GH").await;
    let before_b = snapshot(&db, &b).await;
    let a_password = Uuid::new_v4().to_string();
    assert_eq!(
        f.reset(&email, "AB23CD", &a_password).await.0,
        StatusCode::OK
    );
    assert_eq!(
        snapshot(&db, &b).await,
        before_b,
        "another account's password/version/code must stay unchanged"
    );
    assert_password(&db, &a, &a_password).await;
    assert_password(&db, &b, &f.password).await;
    let b_used: bool = sqlx::query_scalar("SELECT used FROM email_codes WHERE id=$1")
        .bind(b_code)
        .fetch_one(&db)
        .await
        .unwrap();
    assert!(!b_used);
    let before_a = snapshot(&db, &a).await;
    let b_password = Uuid::new_v4().to_string();
    assert_eq!(
        f.reset(&email, "EF45GH", &b_password).await.0,
        StatusCode::OK
    );
    assert_eq!(snapshot(&db, &a).await, before_a);
    assert_password(&db, &a, &a_password).await;
    assert_password(&db, &b, &b_password).await;
}

#[sqlx::test]
async fn issued_code_cannot_follow_a_reassigned_mailbox_or_a_deleted_original_account(db: PgPool) {
    let f = Fixture::start(&db).await;
    let email = format!("transfer-{}@example.com", Uuid::new_v4());
    let owner = f.user(&db, &email).await;
    f.code(&db, &owner, &email, "AB23CD").await;
    sqlx::query("UPDATE users SET email=$2 WHERE user_id=$1")
        .bind(&owner)
        .bind(format!("moved-{}@example.com", Uuid::new_v4()))
        .execute(&db)
        .await
        .unwrap();
    let replacement = f.user(&db, &email).await;
    let before_owner = snapshot(&db, &owner).await;
    let before_replacement = snapshot(&db, &replacement).await;
    assert_eq!(
        f.reset(&email, "AB23CD", &Uuid::new_v4().to_string())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(snapshot(&db, &owner).await, before_owner);
    assert_eq!(snapshot(&db, &replacement).await, before_replacement);
    assert_password(&db, &replacement, &f.password).await;

    let email = format!("deleted-{}@example.com", Uuid::new_v4());
    let owner = f.user(&db, &email).await;
    f.code(&db, &owner, &email, "EF45GH").await;
    sqlx::query("UPDATE users SET is_deleted=TRUE WHERE user_id=$1")
        .bind(&owner)
        .execute(&db)
        .await
        .unwrap();
    let replacement = f.user(&db, &email.to_uppercase()).await;
    let before_owner = snapshot(&db, &owner).await;
    let before_replacement = snapshot(&db, &replacement).await;
    assert_eq!(
        f.reset(&email, "EF45GH", &Uuid::new_v4().to_string())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(snapshot(&db, &owner).await, before_owner);
    assert_eq!(snapshot(&db, &replacement).await, before_replacement);
    assert_password(&db, &replacement, &f.password).await;
}

#[sqlx::test]
async fn the_same_matching_code_bound_to_two_owners_is_rejected_without_choosing_an_account(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let email = format!("Ambiguous-{}@Example.com", Uuid::new_v4());
    let a = f.user(&db, &email).await;
    let b = f.user(&db, &email.to_lowercase()).await;
    f.code(&db, &a, &email, "AB23CD").await;
    f.code(&db, &b, &email, "AB23CD").await;
    let before_a = snapshot(&db, &a).await;
    let before_b = snapshot(&db, &b).await;
    assert_eq!(
        f.reset(&email, "AB23CD", &Uuid::new_v4().to_string())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(snapshot(&db, &a).await, before_a);
    assert_eq!(snapshot(&db, &b).await, before_b);
}

#[sqlx::test]
async fn forgot_password_returns_one_public_shape_and_issues_only_a_unique_uid_bound_code(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let ambiguous = format!("Ambiguous-{}@Example.com", Uuid::new_v4());
    f.user(&db, &ambiguous).await;
    f.user(&db, &ambiguous.to_lowercase()).await;
    let unknown = format!("unknown-{}@example.com", Uuid::new_v4());
    let unique = format!("unique-{}@example.com", Uuid::new_v4());
    let owner = f.user(&db, &unique).await;
    for email in [&ambiguous, &unknown, &unique] {
        let (status, body) = f
            .post("/auth/forgot-password", json!({"email":email}))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"ok":true}));
    }
    let unissued: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM email_codes WHERE purpose='password_reset' AND email=ANY($1)",
    )
    .bind(vec![ambiguous.to_lowercase(), unknown])
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        unissued, 0,
        "ambiguous/unknown addresses must not mint recovery proof"
    );
    let rows: Vec<(Option<String>, String)> = sqlx::query_as(
        "SELECT user_id,email FROM email_codes WHERE purpose='password_reset' AND email=$1",
    )
    .bind(&unique)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(rows, vec![(Some(owner), unique)]);
}

#[sqlx::test]
async fn owner_binding_migration_rerun_retires_only_unbound_password_reset_codes(db: PgPool) {
    let user = Uuid::new_v4().to_string();
    let email = format!("migration-{user}@example.com");
    sqlx::query("INSERT INTO users(user_id,username,email,password_hash,role) VALUES($1,$2,$3,NULL,'member')")
        .bind(&user).bind(format!("migration-{user}")).bind(&email).execute(&db).await.unwrap();
    let mut ids = Vec::new();
    for (purpose, owner, used) in [
        ("password_reset", None, false),
        ("password_reset", Some(user.as_str()), false),
        ("auth_flow", None, false),
        ("register", None, false),
        ("password_reset", None, true),
    ] {
        let id: i32 = sqlx::query_scalar("INSERT INTO email_codes(email,code,code_hash,purpose,expires_at,user_id,used) VALUES($1,NULL,$2,$3,clock_timestamp()+INTERVAL '10 minutes',$4,$5) RETURNING id")
            .bind(&email).bind(server::infra::crypto::sha256_hex(&Uuid::new_v4().to_string()))
            .bind(purpose).bind(owner).bind(used).fetch_one(&db).await.unwrap();
        ids.push(id);
    }
    for _ in 0..2 {
        sqlx::raw_sql(include_str!(
            "../migrations/0112_password_reset_code_owner.sql"
        ))
        .execute(&db)
        .await
        .unwrap();
        let rows: Vec<(i32, bool, Option<String>)> =
            sqlx::query_as("SELECT id,used,user_id FROM email_codes WHERE id=ANY($1) ORDER BY id")
                .bind(&ids)
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(
            rows,
            vec![
                (ids[0], true, None),
                (ids[1], false, Some(user.clone())),
                (ids[2], false, None),
                (ids[3], false, None),
                (ids[4], true, None),
            ]
        );
    }
}
