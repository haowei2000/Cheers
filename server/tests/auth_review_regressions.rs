//! Authentication failures keep their attempt budget independent of account status.
#![cfg(feature = "integration")]

use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

struct Fixture {
    gateway: gateway::TestGateway,
    base: String,
    client: Client,
    user: String,
    login: String,
    password: String,
    email: String,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let login = format!("review-{}", Uuid::new_v4());
        let password = Uuid::new_v4().to_string();
        let (gateway, base) =
            gateway::TestGateway::start_with_webauthn(db, &login, &password).await;
        let user: String = sqlx::query_scalar("SELECT user_id FROM users WHERE username=$1")
            .bind(&login)
            .fetch_one(db)
            .await
            .unwrap();
        let email = format!("{login}@example.com");
        sqlx::query("UPDATE users SET email=$2 WHERE user_id=$1")
            .bind(&user)
            .bind(&email)
            .execute(db)
            .await
            .unwrap();
        Self {
            gateway,
            base,
            client: Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap(),
            user,
            login,
            password,
            email,
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

    async fn flow(&self) -> String {
        let (status, body) = self
            .post(
                "/auth/flows/start",
                json!({
                    "purpose":"login", "identifier":self.login, "client":"macos"
                }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["transaction_id"].as_str().unwrap().to_owned()
    }

    async fn status(&self, db: &PgPool, suspended: bool, deleted: bool) {
        sqlx::query("UPDATE users SET is_suspended=$2,is_deleted=$3 WHERE user_id=$1")
            .bind(&self.user)
            .bind(suspended)
            .bind(deleted)
            .execute(db)
            .await
            .unwrap();
    }

    async fn email_code(&self, db: &PgPool) {
        let hash = self
            .gateway
            .email_code_hash(&self.email, "auth_flow", "AB23CD");
        sqlx::query("INSERT INTO email_codes(email,code,code_hash,purpose,expires_at) VALUES($1,NULL,$2,'auth_flow',clock_timestamp()+INTERVAL '10 minutes')")
            .bind(&self.email).bind(hash).execute(db).await.unwrap();
    }
}

async fn assert_attempts(db: &PgPool, id: &str, attempts: i16) {
    let row: (i16, String) = sqlx::query_as(
        "SELECT failed_attempts,status FROM auth_transactions WHERE transaction_id=$1",
    )
    .bind(id)
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(row.0, attempts);
    assert_eq!(
        row.1,
        if attempts == 5 {
            "failed"
        } else {
            "method_required"
        }
    );
}

async fn credential_counts(db: &PgPool, user: &str) -> (i64, i64, i64) {
    sqlx::query_as("SELECT
        (SELECT COUNT(*) FROM auth_sessions WHERE user_id=$1),
        (SELECT COUNT(*) FROM auth_refresh_tokens rt JOIN auth_sessions s USING(session_id) WHERE s.user_id=$1),
        (SELECT COUNT(*) FROM trusted_devices WHERE user_id=$1)")
        .bind(user).fetch_one(db).await.unwrap()
}

fn invalid_assertion() -> Value {
    // This is intentionally not a valid assertion. It must reach the real
    // WebAuthn verifier rather than be rejected by request deserialization.
    json!({"credential":{
        "id":"AQ", "rawId":"AQ", "type":"public-key",
        "response":{"authenticatorData":"AQ","clientDataJSON":"e30","signature":"AQ","userHandle":null},
        "clientExtensionResults":{}
    }})
}

#[sqlx::test]
async fn invalid_primary_proofs_keep_identical_errors_and_budgets_for_inactive_accounts(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let mut expected = Vec::new();
    for (state, suspended, deleted) in [
        ("active", false, false),
        ("suspended", true, false),
        ("deleted", false, true),
    ] {
        f.status(&db, false, false).await;
        let flows = [f.flow().await, f.flow().await, f.flow().await];
        f.status(&db, suspended, deleted).await;
        for (index, (method, body)) in [
            ("password", json!({"password":"a-wrong-password"})),
            ("email/verify", json!({"code":"a-wrong-code"})),
            ("passkey/verify", invalid_assertion()),
        ]
        .into_iter()
        .enumerate()
        {
            for attempt in 1..=5 {
                let result = f
                    .post(
                        &format!("/auth/flows/{}/{method}", flows[index]),
                        body.clone(),
                    )
                    .await;
                assert!(
                    result.0.is_client_error(),
                    "invalid {method} must fail for {state}"
                );
                assert!(!result.0.is_server_error());
                if state == "active" && attempt == 1 {
                    expected.push(result.clone());
                } else {
                    assert_eq!(result, expected[index], "{method} must not reveal {state}");
                }
                assert_attempts(&db, &flows[index], attempt).await;
            }
        }
    }
    assert_eq!(credential_counts(&db, &f.user).await, (0, 0, 0));
}

#[sqlx::test]
async fn valid_password_and_email_proofs_cannot_issue_credentials_for_inactive_accounts(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    for (suspended, deleted) in [(true, false), (false, true)] {
        f.status(&db, false, false).await;
        let password_flow = f.flow().await;
        let email_flow = f.flow().await;
        f.email_code(&db).await;
        f.status(&db, suspended, deleted).await;
        assert_eq!(
            f.post(
                &format!("/auth/flows/{password_flow}/password"),
                json!({"password":f.password})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            f.post(
                &format!("/auth/flows/{email_flow}/email/verify"),
                json!({"code":"AB23CD"})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_attempts(&db, &password_flow, 1).await;
        assert_attempts(&db, &email_flow, 1).await;
        if suspended {
            let consumed: bool = sqlx::query_scalar("SELECT used FROM email_codes WHERE email=$1 AND purpose='auth_flow' ORDER BY id DESC LIMIT 1")
                .bind(&f.email).fetch_one(&db).await.unwrap();
            assert!(
                consumed,
                "the valid email proof must be checked before suspension rejection"
            );
        }
        assert_eq!(credential_counts(&db, &f.user).await, (0, 0, 0));
    }
    f.status(&db, false, false).await;
    let id = f.flow().await;
    let (status, body) = f
        .post(
            &format!("/auth/flows/{id}/password"),
            json!({"password":f.password}),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the same real password must work while active: {body}"
    );
    assert_eq!(body["status"], "authenticated");
}

#[sqlx::test]
async fn direct_login_rolls_back_session_and_refresh_when_device_trust_cannot_commit(db: PgPool) {
    let f = Fixture::start(&db).await;
    for deferred in [false, true] {
        let trigger = if deferred {
            "CREATE CONSTRAINT TRIGGER fail_direct_trust AFTER INSERT ON trusted_devices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_direct_trust()"
        } else {
            "CREATE TRIGGER fail_direct_trust BEFORE INSERT ON trusted_devices FOR EACH ROW EXECUTE FUNCTION fail_direct_trust()"
        };
        sqlx::raw_sql(&format!("CREATE FUNCTION fail_direct_trust() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected trusted credential failure'; END; $$; {trigger};"))
            .execute(&db).await.unwrap();
        let (status, _) = f.post("/auth/login",json!({"login":f.login,"password":f.password,"client":"macos","remember_device":true})).await;
        assert!(status.is_server_error());
        assert_eq!(
            credential_counts(&db, &f.user).await,
            (0, 0, 0),
            "failed trust must not leave a session/refresh pair"
        );
        sqlx::raw_sql(
            "DROP TRIGGER fail_direct_trust ON trusted_devices; DROP FUNCTION fail_direct_trust();",
        )
        .execute(&db)
        .await
        .unwrap();
    }
    let (status, body) = f
        .post(
            "/auth/login",
            json!({"login":f.login,"password":f.password,"client":"macos","remember_device":true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "authenticated");
    let refresh = body["refresh_token"].as_str().unwrap();
    assert!(!body["trusted_device"].as_str().unwrap().is_empty());
    assert_eq!(credential_counts(&db, &f.user).await, (1, 1, 1));
    assert_eq!(
        f.post("/auth/refresh", json!({"refresh_token":refresh}))
            .await
            .0,
        StatusCode::OK
    );
}

#[sqlx::test]
async fn direct_login_uses_browser_cookies_and_native_json_without_implicit_native_cookies(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    for client in ["web", "ios", "macos", "android"] {
        for remember in [false, true] {
            let response = f.client.post(format!("{}/api/v1/auth/login",f.base))
                .json(&json!({"login":f.login,"password":f.password,"client":client,"remember_device":remember}))
                .send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let cookies: Vec<String> = response
                .headers()
                .get_all(reqwest::header::SET_COOKIE)
                .iter()
                .map(|value| value.to_str().unwrap().to_owned())
                .collect();
            let body: Value = response.json().await.unwrap();
            if client == "web" {
                assert!(body["refresh_token"].is_null());
                assert!(body["trusted_device"].is_null());
                assert!(cookies
                    .iter()
                    .any(|value| value.starts_with("cheers_refresh=")
                        && value.contains("HttpOnly")
                        && value.contains("Secure")
                        && value.contains("SameSite=Lax")));
                assert!(cookies
                    .iter()
                    .any(|value| value.starts_with("cheers_csrf=") && !value.contains("HttpOnly")));
                assert_eq!(
                    cookies
                        .iter()
                        .any(|value| value.starts_with("cheers_trusted_device=")
                            && value.contains("HttpOnly")),
                    remember
                );
            } else {
                assert!(
                    cookies.is_empty(),
                    "native credentials must be explicit JSON for {client}"
                );
                assert!(!body["refresh_token"].as_str().unwrap().is_empty());
                assert_eq!(body["trusted_device"].is_string(), remember);
            }
        }
    }
}
