//! Changing or setting a password revokes every session, then reissues the
//! caller's session for the same client so the caller stays signed in.
#![cfg(feature = "integration")]

use std::time::Duration;

use reqwest::{header::SET_COOKIE, Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
}

async fn login(client: &Client, base: &str, password: &str, extra: Value) -> Value {
    let mut body = json!({"login": "rotation-admin", "password": password});
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let response = client
        .post(format!("{base}/api/v1/auth/login"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.json().await.unwrap()
}

async fn sessions_status(client: &Client, base: &str, token: &str) -> StatusCode {
    client
        .get(format!("{base}/api/v1/auth/sessions"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .status()
}

#[sqlx::test]
async fn native_password_change_returns_a_refresh_token_for_the_same_client(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_gateway, base) = gateway::TestGateway::start(&db, "rotation-admin", &password).await;
    let client = client();
    let native = json!({"client": "ios", "device_name": "iPhone integration"});
    let caller = login(&client, &base, &password, native.clone()).await;
    let other = login(&client, &base, &password, native).await;

    let new_password = Uuid::new_v4().to_string();
    let response = client
        .post(format!("{base}/api/v1/auth/change-password"))
        .bearer_auth(caller["access_token"].as_str().unwrap())
        .json(&json!({"current_password": password, "new_password": new_password}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    assert!(!response.headers().contains_key(SET_COOKIE));
    let rotated: Value = response.json().await.unwrap();
    assert_eq!(rotated["status"], "authenticated");
    let refresh_token = rotated["refresh_token"].as_str().unwrap();
    assert_ne!(rotated["refresh_token"], caller["refresh_token"]);

    // The reissued refresh token works; every pre-rotation credential is dead.
    let refresh = client
        .post(format!("{base}/api/v1/auth/refresh"))
        .json(&json!({"refresh_token": refresh_token}))
        .send()
        .await
        .unwrap();
    assert!(refresh.status().is_success());
    let refreshed: Value = refresh.json().await.unwrap();
    for stale in [&caller, &other] {
        let reused = client
            .post(format!("{base}/api/v1/auth/refresh"))
            .json(&json!({"refresh_token": stale["refresh_token"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(reused.status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(
        sessions_status(&client, &base, other["access_token"].as_str().unwrap()).await,
        StatusCode::UNAUTHORIZED
    );

    let summary: Value = client
        .get(format!("{base}/api/v1/auth/sessions"))
        .bearer_auth(refreshed["access_token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sessions = summary.as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["client"], "ios");
    assert_eq!(sessions[0]["device_name"], "iPhone integration");
}

#[sqlx::test]
async fn browser_password_change_sets_fresh_session_cookies(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_gateway, base) = gateway::TestGateway::start(&db, "rotation-admin", &password).await;
    let client = client();
    let caller = login(&client, &base, &password, json!({})).await;

    let response = client
        .post(format!("{base}/api/v1/auth/change-password"))
        .bearer_auth(caller["access_token"].as_str().unwrap())
        .json(&json!({"current_password": password, "new_password": Uuid::new_v4().to_string()}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let cookies: Vec<_> = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect();
    assert!(cookies.iter().any(|c| c.starts_with("cheers_refresh=")));
    assert!(cookies.iter().any(|c| c.starts_with("cheers_csrf=")));
    let rotated: Value = response.json().await.unwrap();
    assert!(rotated.get("refresh_token").is_none());
    assert_eq!(
        sessions_status(&client, &base, rotated["access_token"].as_str().unwrap()).await,
        StatusCode::OK
    );
}
