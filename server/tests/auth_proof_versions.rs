//! Real primary proofs remain bound to the credential version they verified.
#![cfg(feature = "integration")]

use std::time::Duration;

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use server::{domain::auth_sessions, infra::crypto::sha256_hex};

#[path = "support/gateway.rs"]
mod gateway;

#[derive(Clone, Copy, Debug)]
enum Adapter {
    Legacy,
    Unified,
}

struct Fixture {
    gateway: gateway::TestGateway,
    base: String,
    client: Client,
    user: String,
    login: String,
    email: String,
    password: String,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let login = format!("proof-{}", Uuid::new_v4());
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, &login, &password).await;
        let user: String = sqlx::query_scalar("SELECT user_id FROM users WHERE username=$1")
            .bind(&login)
            .fetch_one(db)
            .await
            .unwrap();
        let email = format!("{login}@example.com");
        // Account configuration is seeded, while every primary proof below
        // comes from verifying the real bootstrap password over HTTP.
        sqlx::query(
            "UPDATE users SET email=$2,email_2fa_enabled=TRUE,backup_codes=$3 WHERE user_id=$1",
        )
        .bind(&user)
        .bind(&email)
        .bind(json!([
            {"hash":sha256_hex("proof-recovery-one"),"used_at":null},
            {"hash":sha256_hex("proof-recovery-two"),"used_at":null}
        ]))
        .execute(db)
        .await
        .unwrap();
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        Self {
            gateway,
            base,
            client,
            user,
            login,
            email,
            password,
        }
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

    async fn start_unified(&self) -> String {
        let (status, body) = self
            .post(
                "/auth/flows/start",
                json!({"purpose":"login","identifier":self.login,"client":"macos"}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "method_required");
        body["transaction_id"].as_str().unwrap().to_string()
    }

    async fn primary(&self, adapter: Adapter, password: &str) -> String {
        let (status, body) = match adapter {
            Adapter::Legacy => {
                self.post(
                    "/auth/login",
                    json!({"login":self.login,"password":password,"client":"macos"}),
                )
                .await
            }
            Adapter::Unified => {
                let id = self.start_unified().await;
                self.post(
                    &format!("/auth/flows/{id}/password"),
                    json!({"password":password}),
                )
                .await
            }
        };
        assert_eq!(status, StatusCode::OK, "primary proof through {adapter:?}");
        assert_eq!(body["status"], "factor_required");
        assert!(body["access_token"].is_null());
        body["transaction_id"].as_str().unwrap().to_string()
    }

    async fn code(&self, db: &PgPool, purpose: &str, code: &str) {
        let hash = self.gateway.email_code_hash(&self.email, purpose, code);
        // Reusing a deterministic test code must not leave two active rows
        // matching the production verifier's exact single-use UPDATE.
        sqlx::query("UPDATE email_codes SET used=TRUE WHERE email=$1 AND purpose=$2 AND code_hash=$3 AND used=FALSE")
            .bind(&self.email).bind(purpose).bind(&hash).execute(db).await.unwrap();
        sqlx::query("INSERT INTO email_codes(email,code,code_hash,purpose,expires_at) VALUES($1,NULL,$2,$3,clock_timestamp()+INTERVAL '10 minutes')")
            .bind(&self.email).bind(hash).bind(purpose).execute(db).await.unwrap();
    }

    async fn complete_email(&self, adapter: Adapter, id: &str, code: &str) -> (StatusCode, Value) {
        match adapter {
            Adapter::Legacy => self.post("/auth/2fa/login",json!({"transaction_id":id,"code":code,"method":"email","remember_device":true})).await,
            Adapter::Unified => self.post(&format!("/auth/flows/{id}/email/verify"),json!({"code":code,"remember_device":true})).await,
        }
    }

    async fn reset(&self, db: &PgPool) -> String {
        self.code(db, "password_reset", "AB23CD").await;
        let password = Uuid::new_v4().to_string();
        assert_eq!(self.reset_request(&password).await.0, StatusCode::OK);
        password
    }

    async fn reset_request(&self, password: &str) -> (StatusCode, Value) {
        self.post(
            "/auth/reset-password",
            json!({"email":self.email,"code":"AB23CD","new_password":password}),
        )
        .await
    }

    async fn assert_authenticated(&self, db: &PgPool, body: &Value) {
        assert_eq!(body["status"], "authenticated");
        let token = body["access_token"]
            .as_str()
            .expect("successful native proof issues access");
        let refresh = body["refresh_token"]
            .as_str()
            .expect("successful native proof issues refresh");
        let trusted = body["trusted_device"]
            .as_str()
            .expect("remember-device completion issues trust");
        assert!(!refresh.is_empty());
        assert!(
            auth_sessions::trusted_device_is_valid(db, &self.user, Some(trusted))
                .await
                .unwrap()
        );
        let response = self
            .client
            .request(Method::GET, format!("{}/api/v1/users/me", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

async fn issuer_snapshot(db: &PgPool, user: &str) -> Value {
    // Email/recovery codes are independently single-use. This snapshot covers
    // only the promised atomic transaction + session + refresh + trust issue.
    sqlx::query_scalar("SELECT jsonb_build_object(
        'proofs',(SELECT jsonb_agg(jsonb_build_array(transaction_id,status,consumed_at,context_json) ORDER BY transaction_id) FROM auth_transactions WHERE user_id=$1),
        'sessions',(SELECT jsonb_agg(jsonb_build_array(session_id,revoked_at) ORDER BY session_id) FROM auth_sessions WHERE user_id=$1),
        'refresh',(SELECT jsonb_agg(jsonb_build_array(rt.refresh_token_id,rt.session_id,rt.revoked_at) ORDER BY rt.refresh_token_id) FROM auth_refresh_tokens rt JOIN auth_sessions s USING(session_id) WHERE s.user_id=$1),
        'trusted',(SELECT jsonb_agg(jsonb_build_array(trusted_device_id,session_id,revoked_at) ORDER BY trusted_device_id) FROM trusted_devices WHERE user_id=$1))")
        .bind(user).fetch_one(db).await.unwrap()
}

async fn assert_counts(db: &PgPool, user: &str, expected: i64) {
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_sessions WHERE user_id=$1")
        .bind(user)
        .fetch_one(db)
        .await
        .unwrap();
    let refresh: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_refresh_tokens rt JOIN auth_sessions s USING(session_id) WHERE s.user_id=$1")
        .bind(user).fetch_one(db).await.unwrap();
    let trust: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM trusted_devices WHERE user_id=$1")
        .bind(user)
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!((sessions, refresh, trust), (expected, expected, expected));
}

async fn assert_password_proof(db: &PgPool, id: &str, user: &str) {
    let context: Value =
        sqlx::query_scalar("SELECT context_json FROM auth_transactions WHERE transaction_id=$1")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap();
    let version: i32 = sqlx::query_scalar("SELECT token_version FROM users WHERE user_id=$1")
        .bind(user)
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!(context["primary_token_version"], version);
    assert_eq!(context["primary_factor"], "password");
}

async fn wait_for_blocked(db: &PgPool, blocker: i32, count: i64) {
    tokio::time::timeout(Duration::from_secs(10),async {
        loop {
            let blocked: i64 = sqlx::query_scalar("WITH RECURSIVE blocked(pid) AS (
                SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
                UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database() AND a.wait_event_type='Lock'
            ) SELECT COUNT(*) FROM blocked").bind(blocker).fetch_one(db).await.unwrap();
            if blocked >= count { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("actual HTTP proof/reset must reach the held user lock");
}

#[sqlx::test]
async fn legacy_password_factor_proof_cannot_complete_after_reset_but_a_new_proof_can(db: PgPool) {
    let f = Fixture::start(&db).await;
    let old = f.primary(Adapter::Legacy, &f.password).await;
    assert_password_proof(&db, &old, &f.user).await;
    let password = f.reset(&db).await;
    f.code(&db, "auth_flow", "EF45GH").await;
    let before = issuer_snapshot(&db, &f.user).await;
    assert_eq!(
        f.complete_email(Adapter::Legacy, &old, "EF45GH").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(issuer_snapshot(&db, &f.user).await, before);

    let unversioned = f.primary(Adapter::Legacy, &password).await;
    // A real pending challenge from before the versioned-proof protocol has
    // every other property intact, but cannot inherit today's user version.
    sqlx::query("UPDATE auth_transactions SET context_json=context_json-'primary_token_version' WHERE transaction_id=$1")
        .bind(&unversioned).execute(&db).await.unwrap();
    f.code(&db, "auth_flow", "PQ89RS").await;
    let before = issuer_snapshot(&db, &f.user).await;
    assert_eq!(
        f.complete_email(Adapter::Legacy, &unversioned, "PQ89RS")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(issuer_snapshot(&db, &f.user).await, before);
    assert_counts(&db, &f.user, 0).await;

    let fresh = f.primary(Adapter::Legacy, &password).await;
    assert_password_proof(&db, &fresh, &f.user).await;
    f.code(&db, "auth_flow", "JK67MN").await;
    let (status, body) = f.complete_email(Adapter::Legacy, &fresh, "JK67MN").await;
    assert_eq!(status, StatusCode::OK);
    f.assert_authenticated(&db, &body).await;
    assert_counts(&db, &f.user, 1).await;
}

#[sqlx::test]
async fn unified_primary_proof_is_versioned_and_one_method_cannot_count_as_both_factors(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let old = f.primary(Adapter::Unified, &f.password).await;
    assert_password_proof(&db, &old, &f.user).await;
    let password = f.reset(&db).await;
    let before = issuer_snapshot(&db, &f.user).await;
    f.code(&db, "auth_flow", "EF45GH").await;
    assert_eq!(
        f.complete_email(Adapter::Unified, &old, "EF45GH").await.0,
        StatusCode::UNAUTHORIZED
    );
    // Only the stale-transaction precheck is exercised here: no passkey or
    // authenticator verification is fabricated by this integration fixture.
    assert_eq!(
        f.post(&format!("/auth/flows/{old}/passkey/options"), json!({}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(issuer_snapshot(&db, &f.user).await, before);

    // A real linked-provider account may arm password as a second method.
    // That permission cannot turn the same password into two proofs.
    sqlx::query("INSERT INTO auth_external_identities(identity_id,provider,subject,user_id,corp_id) VALUES($1,'github',$2,$3,'')")
        .bind(Uuid::new_v4().to_string()).bind(Uuid::new_v4().to_string()).bind(&f.user).execute(&db).await.unwrap();
    sqlx::query("UPDATE users SET password_2fa_enabled=TRUE WHERE user_id=$1")
        .bind(&f.user)
        .execute(&db)
        .await
        .unwrap();
    let fresh = f.primary(Adapter::Unified, &password).await;
    let before = issuer_snapshot(&db, &f.user).await;
    assert_eq!(
        f.post(
            &format!("/auth/flows/{fresh}/password"),
            json!({"password":password})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(issuer_snapshot(&db, &f.user).await, before);
    f.code(&db, "auth_flow", "JK67MN").await;
    let (status, body) = f.complete_email(Adapter::Unified, &fresh, "JK67MN").await;
    assert_eq!(status, StatusCode::OK);
    f.assert_authenticated(&db, &body).await;

    let email_primary = f.start_unified().await;
    f.code(&db, "auth_flow", "PQ89RS").await;
    assert_eq!(
        f.complete_email(Adapter::Unified, &email_primary, "PQ89RS")
            .await
            .1["status"],
        "factor_required"
    );
    f.code(&db, "auth_flow", "TU23VW").await;
    let before = issuer_snapshot(&db, &f.user).await;
    assert_eq!(
        f.complete_email(Adapter::Unified, &email_primary, "TU23VW")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(issuer_snapshot(&db, &f.user).await, before);
    assert_counts(&db, &f.user, 1).await;
}

#[sqlx::test]
async fn concurrent_completions_with_distinct_valid_codes_issue_one_credential_bundle(db: PgPool) {
    let f = Fixture::start(&db).await;
    for (index, adapter) in [Adapter::Legacy, Adapter::Unified].into_iter().enumerate() {
        let id = f.primary(adapter, &f.password).await;
        f.code(&db, "auth_flow", "EF45GH").await;
        f.code(&db, "auth_flow", "JK67MN").await;
        let (a, b) = tokio::join!(
            f.complete_email(adapter, &id, "EF45GH"),
            f.complete_email(adapter, &id, "JK67MN")
        );
        assert_eq!(
            [a.0, b.0]
                .iter()
                .filter(|status| **status == StatusCode::OK)
                .count(),
            1
        );
        assert_eq!(
            [a.0, b.0]
                .iter()
                .filter(|status| **status == StatusCode::UNAUTHORIZED)
                .count(),
            1
        );
        f.assert_authenticated(&db, if a.0 == StatusCode::OK { &a.1 } else { &b.1 })
            .await;
        assert_counts(&db, &f.user, index as i64 + 1).await;
        let consumed: bool = sqlx::query_scalar("SELECT status='consumed' AND consumed_at IS NOT NULL FROM auth_transactions WHERE transaction_id=$1")
            .bind(&id).fetch_one(&db).await.unwrap();
        assert!(consumed);
    }
}

#[sqlx::test]
async fn issuer_insert_and_commit_failures_preserve_the_primary_proof_for_a_fresh_code_retry(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let mut issued = 0;
    for adapter in [Adapter::Legacy, Adapter::Unified] {
        for deferred in [false, true] {
            let id = f.primary(adapter, &f.password).await;
            f.code(&db, "auth_flow", "EF45GH").await;
            let before = issuer_snapshot(&db, &f.user).await;
            let (table, trigger) = if deferred {
                ("auth_refresh_tokens","CREATE CONSTRAINT TRIGGER fail_proof_issue AFTER INSERT ON auth_refresh_tokens DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_proof_issue()")
            } else {
                ("auth_sessions","CREATE TRIGGER fail_proof_issue BEFORE INSERT ON auth_sessions FOR EACH ROW EXECUTE FUNCTION fail_proof_issue()")
            };
            sqlx::raw_sql(&format!("CREATE FUNCTION fail_proof_issue() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected authentication issuer failure'; END; $$; {trigger};"))
                .execute(&db).await.unwrap();
            assert!(f
                .complete_email(adapter, &id, "EF45GH")
                .await
                .0
                .is_server_error());
            assert_eq!(issuer_snapshot(&db, &f.user).await, before);
            sqlx::raw_sql(&format!(
                "DROP TRIGGER fail_proof_issue ON {table}; DROP FUNCTION fail_proof_issue();"
            ))
            .execute(&db)
            .await
            .unwrap();
            // The failed completion may have consumed its OTP. A fresh real
            // email proof retries the still-unconsumed primary transaction.
            f.code(&db, "auth_flow", "JK67MN").await;
            let (status, body) = f.complete_email(adapter, &id, "JK67MN").await;
            assert_eq!(status, StatusCode::OK);
            f.assert_authenticated(&db, &body).await;
            issued += 1;
            assert_counts(&db, &f.user, issued).await;
        }
    }
}

async fn reset_before_password_proof_capture(db: &PgPool, adapter: Adapter) {
    let f = Fixture::start(db).await;
    let flow = if matches!(adapter, Adapter::Unified) {
        Some(f.start_unified().await)
    } else {
        None
    };
    f.code(db, "password_reset", "AB23CD").await;
    let before = issuer_snapshot(db, &f.user).await;
    let mut blocker = db.begin().await.unwrap();
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("SELECT user_id FROM users WHERE user_id=$1 FOR NO KEY UPDATE")
        .bind(&f.user)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let password = Uuid::new_v4().to_string();
    let reset = f.reset_request(&password);
    tokio::pin!(reset);
    let wait = wait_for_blocked(db, blocker_pid, 1);
    tokio::pin!(wait);
    tokio::select! { result=&mut reset => panic!("reset bypassed the held account lock: {}",result.0), _=&mut wait => {} }
    let old_proof = async {
        match flow.as_deref() {
            Some(id) => {
                f.post(
                    &format!("/auth/flows/{id}/password"),
                    json!({"password":f.password}),
                )
                .await
            }
            None => {
                f.post(
                    "/auth/login",
                    json!({"login":f.login,"password":f.password,"client":"macos"}),
                )
                .await
            }
        }
    };
    tokio::pin!(old_proof);
    let wait = wait_for_blocked(db, blocker_pid, 2);
    tokio::pin!(wait);
    tokio::select! { result=&mut old_proof => panic!("old-password proof must reach the user-version fence: {}",result.0), _=&mut wait => {} }
    blocker.commit().await.unwrap();
    let (reset, old_proof) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::join!(reset, old_proof)
    })
    .await
    .expect("reset and proof capture must complete without deadlock");
    assert_eq!(reset.0, StatusCode::OK);
    assert_eq!(old_proof.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        issuer_snapshot(db, &f.user).await,
        before,
        "old password cannot adopt the new credential version"
    );
    let fresh = f.primary(adapter, &password).await;
    assert_password_proof(db, &fresh, &f.user).await;
    f.code(db, "auth_flow", "JK67MN").await;
    let (status, body) = f.complete_email(adapter, &fresh, "JK67MN").await;
    assert_eq!(status, StatusCode::OK);
    f.assert_authenticated(db, &body).await;
}

#[sqlx::test]
async fn legacy_factor_creation_cannot_capture_a_new_version_for_an_old_password(db: PgPool) {
    reset_before_password_proof_capture(&db, Adapter::Legacy).await;
}

#[sqlx::test]
async fn unified_password_proof_cannot_capture_a_new_version_for_an_old_password(db: PgPool) {
    reset_before_password_proof_capture(&db, Adapter::Unified).await;
}
