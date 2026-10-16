//! Unified authentication-flow invariants against a real PostgreSQL database.
#![cfg(feature = "integration")]

use chrono::{Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use server::domain::auth_sessions;

#[path = "support/gateway.rs"]
mod gateway;

async fn auth_request(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    let response = client
        .post(format!("{base}/api/v1{path}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let result = response.json().await.unwrap();
    assert!(status.is_success(), "{path}: {status}: {result}");
    result
}

async fn password_flow(
    client: &reqwest::Client,
    base: &str,
    trusted: Option<&str>,
) -> serde_json::Value {
    let start = auth_request(client, base, "/auth/flows/start", serde_json::json!({
        "purpose": "login", "identifier": "trust-test-admin", "client": "macos", "device_name": "Test Mac"
    })).await;
    auth_request(client, base, &format!("/auth/flows/{}/password", start["transaction_id"].as_str().unwrap()), serde_json::json!({
        "password": "test-password-with-enough-entropy", "trusted_device": trusted, "remember_device": true
    })).await
}

#[sqlx::test]
async fn trusted_login_flows_and_oauth_skip_only_valid_device_challenges(db: PgPool) {
    use serde_json::json;
    use server::infra::crypto::sha256_hex;
    let (_gateway, base) =
        gateway::TestGateway::start(&db, "trust-test-admin", "test-password-with-enough-entropy")
            .await;
    let user_id: String =
        sqlx::query_scalar("SELECT user_id FROM users WHERE username = 'trust-test-admin'")
            .fetch_one(&db)
            .await
            .unwrap();
    // An email factor plus a one-use recovery code exercises the real second
    // factor without depending on external mail or time-sensitive TOTP.
    sqlx::query("UPDATE users SET email = 'test@example.com', email_2fa_enabled = TRUE, backup_codes = $2 WHERE user_id = $1")
        .bind(&user_id).bind(json!([
            { "hash": sha256_hex("recovery-code"), "used_at": null },
            { "hash": sha256_hex("web-recovery-code"), "used_at": null }
        ])).execute(&db).await.unwrap();
    let client = reqwest::Client::new();
    let first = password_flow(&client, &base, None).await;
    assert_eq!(first["status"], "factor_required");
    let verified = auth_request(
        &client,
        &base,
        &format!(
            "/auth/flows/{}/totp/verify",
            first["transaction_id"].as_str().unwrap()
        ),
        json!({
            "code": "recovery-code", "remember_device": true
        }),
    )
    .await;
    let trusted = verified["trusted_device"]
        .as_str()
        .expect("native login must return device trust");
    assert_eq!(
        password_flow(&client, &base, Some(trusted)).await["status"],
        "authenticated"
    );
    assert_eq!(
        password_flow(&client, &base, Some("forged-device")).await["status"],
        "factor_required"
    );

    // Browser trust travels only in an HttpOnly cookie, never in its JSON.
    let web_start = auth_request(
        &client,
        &base,
        "/auth/flows/start",
        json!({
            "purpose": "login", "identifier": "trust-test-admin", "client": "web"
        }),
    )
    .await;
    let path = format!(
        "/auth/flows/{}/password",
        web_start["transaction_id"].as_str().unwrap()
    );
    assert_eq!(
        auth_request(
            &client,
            &base,
            &path,
            json!({ "password": "test-password-with-enough-entropy" })
        )
        .await["status"],
        "factor_required"
    );
    let response = client
        .post(format!(
            "{base}/api/v1/auth/flows/{}/totp/verify",
            web_start["transaction_id"].as_str().unwrap()
        ))
        .json(&json!({ "code": "web-recovery-code", "remember_device": true }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("cheers_trusted_device="))
        .unwrap()
        .to_owned();
    for attribute in ["HttpOnly", "Secure", "SameSite=Lax"] {
        assert!(cookie.contains(attribute));
    }
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["trusted_device"].is_null());
    let web_retry = auth_request(
        &client,
        &base,
        "/auth/flows/start",
        json!({
            "purpose": "login", "identifier": "trust-test-admin", "client": "web"
        }),
    )
    .await;
    let response = client
        .post(format!(
            "{base}/api/v1/auth/flows/{}/password",
            web_retry["transaction_id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, cookie.split(';').next().unwrap())
        .json(&json!({ "password": "test-password-with-enough-entropy", "remember_device": false }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    assert!(!response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.starts_with("cheers_trusted_device=")));
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["status"], "authenticated");

    // Seed the result of provider verification; handoff itself is the real
    // OAuth endpoint and must apply the same device-trust policy.
    for (credential, expected) in [(Some(trusted), "authenticated"), (None, "factor_required")] {
        let code = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO auth_transactions (transaction_id, user_id, kind, status, client_type, handoff_code_hash, expires_at) VALUES ($1, $2, 'oauth', 'verified', 'macos', $3, NOW() + INTERVAL '10 minutes')")
            .bind(Uuid::new_v4().to_string()).bind(&user_id).bind(sha256_hex(&code)).execute(&db).await.unwrap();
        let result = auth_request(
            &client,
            &base,
            "/auth/oauth/handoff",
            json!({ "code": code, "client": "macos", "trusted_device": credential }),
        )
        .await;
        assert_eq!(result["status"], expected);
    }
    sqlx::query("UPDATE trusted_devices SET expires_at = NOW() - INTERVAL '1 second' WHERE credential_hash = $1")
        .bind(sha256_hex(trusted)).execute(&db).await.unwrap();
    assert_eq!(
        password_flow(&client, &base, Some(trusted)).await["status"],
        "factor_required"
    );
    sqlx::query("UPDATE trusted_devices SET expires_at = NOW() + INTERVAL '1 day', revoked_at = NOW() WHERE credential_hash = $1")
        .bind(sha256_hex(trusted)).execute(&db).await.unwrap();
    assert_eq!(
        password_flow(&client, &base, Some(trusted)).await["status"],
        "factor_required"
    );
}

async fn seed_user_and_session(db: &PgPool) -> (String, String) {
    let user_id = Uuid::new_v4().to_string();
    let session_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO users (user_id, username, password_hash, display_name)
         VALUES ($1, $2, 'unused', 'Flow Tester')",
    )
    .bind(&user_id)
    .bind(format!("flow-{user_id}"))
    .execute(db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO auth_sessions
         (session_id, user_id, client_type, token_family_id, authenticated_at,
          absolute_expires_at)
         VALUES ($1, $2, 'web', $3, NOW() - INTERVAL '16 minutes',
                 NOW() + INTERVAL '1 day')",
    )
    .bind(&session_id)
    .bind(&user_id)
    .bind(Uuid::new_v4().to_string())
    .execute(db)
    .await
    .unwrap();
    (user_id, session_id)
}

#[sqlx::test]
async fn step_up_is_session_bound_single_use_and_fixed_window(db: PgPool) {
    let (user_id, session_id) = seed_user_and_session(&db).await;
    let transaction_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO auth_transactions
         (transaction_id, user_id, session_id, kind, status, client_type, expires_at)
         VALUES ($1, $2, $3, 'step_up', 'method_required', 'web', NOW() + INTERVAL '10 minutes')",
    )
    .bind(&transaction_id)
    .bind(&user_id)
    .bind(&session_id)
    .execute(&db)
    .await
    .unwrap();

    let expires_at =
        auth_sessions::complete_step_up(&db, &transaction_id, &user_id, &session_id, "passkey")
            .await
            .unwrap();
    let remaining = expires_at - Utc::now();
    assert!(remaining <= Duration::minutes(15));
    assert!(remaining > Duration::minutes(14));
    auth_sessions::require_recent_auth(&db, &user_id, &session_id)
        .await
        .unwrap();

    assert!(auth_sessions::complete_step_up(
        &db,
        &transaction_id,
        &user_id,
        &session_id,
        "passkey",
    )
    .await
    .is_err());

    sqlx::query(
        "UPDATE auth_sessions SET step_up_at = NOW() - INTERVAL '16 minutes'
         WHERE session_id = $1",
    )
    .bind(&session_id)
    .execute(&db)
    .await
    .unwrap();
    assert!(
        auth_sessions::require_recent_auth(&db, &user_id, &session_id)
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn step_up_cannot_be_consumed_by_another_session(db: PgPool) {
    let (user_id, session_id) = seed_user_and_session(&db).await;
    let other_session_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO auth_sessions
         (session_id, user_id, client_type, token_family_id, absolute_expires_at)
         VALUES ($1, $2, 'web', $3, NOW() + INTERVAL '1 day')",
    )
    .bind(&other_session_id)
    .bind(&user_id)
    .bind(Uuid::new_v4().to_string())
    .execute(&db)
    .await
    .unwrap();
    let transaction_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO auth_transactions
         (transaction_id, user_id, session_id, kind, status, client_type, expires_at)
         VALUES ($1, $2, $3, 'step_up', 'verified', 'web', NOW() + INTERVAL '10 minutes')",
    )
    .bind(&transaction_id)
    .bind(&user_id)
    .bind(&session_id)
    .execute(&db)
    .await
    .unwrap();

    assert!(auth_sessions::complete_step_up(
        &db,
        &transaction_id,
        &user_id,
        &other_session_id,
        "password",
    )
    .await
    .is_err());
}
