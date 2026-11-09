//! Runtime settings apply without a restart and every change leaves a review trail.
#![cfg(feature = "integration")]

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use server::domain::runtime_settings::{self, RuntimeSettingsStore, RuntimeValues};
use server::errors::AppError;

#[path = "support/gateway.rs"]
mod gateway;

const KEY: &str = "approval_card_ttl_secs";
const DEFAULTS: RuntimeValues = RuntimeValues {
    approval_card_ttl_secs: 1800,
};

fn ttl(store: &RuntimeSettingsStore) -> u64 {
    store.values().approval_card_ttl_secs
}

#[sqlx::test]
async fn change_is_live_and_recorded_then_reset_returns_to_default(db: PgPool) {
    let store = RuntimeSettingsStore::new(DEFAULTS);
    let actor = Uuid::new_v4().to_string();

    store
        .update(&db, KEY, Some(3600), &actor, "  slow reviewers  ")
        .await
        .unwrap();
    assert_eq!(ttl(&store), 3600);

    store
        .update(&db, KEY, None, &actor, "back to default")
        .await
        .unwrap();
    assert_eq!(ttl(&store), 1800);
    let stored: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM system_settings WHERE key LIKE 'runtime.%'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(stored, 0);

    let history = runtime_settings::revisions(&db, KEY).await.unwrap();
    let revisions = history["revisions"].as_array().unwrap();
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0]["old_value"], json!(3600));
    assert_eq!(revisions[0]["new_value"], Value::Null);
    assert_eq!(revisions[1]["old_value"], Value::Null);
    assert_eq!(revisions[1]["new_value"], json!(3600));
    assert_eq!(revisions[1]["actor_id"], json!(actor));
    assert_eq!(revisions[1]["reason"], json!("slow reviewers"));
}

#[sqlx::test]
async fn rejected_changes_leave_value_and_history_untouched(db: PgPool) {
    let store = RuntimeSettingsStore::new(DEFAULTS);
    store
        .update(&db, KEY, Some(3600), "a", "why")
        .await
        .unwrap();

    for (key, value, reason) in [
        (KEY, Some(60), "below the connector wait"),
        (KEY, Some(3600), "same value"),
        (KEY, Some(7200), "   "),
        ("unknown", Some(7200), "why"),
    ] {
        assert!(store.update(&db, key, value, "a", reason).await.is_err());
    }

    assert_eq!(ttl(&store), 3600);
    let history = runtime_settings::revisions(&db, KEY).await.unwrap();
    assert_eq!(history["revisions"].as_array().unwrap().len(), 1);
    assert!(matches!(
        runtime_settings::revisions(&db, "unknown").await,
        Err(AppError::NotFound)
    ));
}

#[sqlx::test]
async fn reload_picks_up_other_writers_and_ignores_invalid_rows(db: PgPool) {
    let writer = RuntimeSettingsStore::new(DEFAULTS);
    let reader = RuntimeSettingsStore::new(DEFAULTS);

    writer
        .update(&db, KEY, Some(3600), "a", "why")
        .await
        .unwrap();
    assert_eq!(ttl(&reader), 1800);
    reader.reload(&db).await.unwrap();
    assert_eq!(ttl(&reader), 3600);

    sqlx::query(
        "UPDATE system_settings SET value = '5' WHERE key = 'runtime.approval_card_ttl_secs'",
    )
    .execute(&db)
    .await
    .unwrap();
    reader.reload(&db).await.unwrap();
    assert_eq!(ttl(&reader), 1800);
}

#[sqlx::test]
async fn http_api_applies_changes_for_admins_and_refuses_members(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_gateway, base) = gateway::TestGateway::start(&db, "runtime-admin", &password).await;
    let client = Client::new();
    let login = |login: &'static str, password: String| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let auth: Value = client
                .post(format!("{base}/api/v1/auth/login"))
                .json(&json!({"login": login, "password": password}))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            auth["access_token"].as_str().unwrap().to_string()
        }
    };
    let admin = login("runtime-admin", password.clone()).await;
    let url = format!("{base}/api/v1/admin/settings/runtime");

    let response = client
        .put(format!("{url}/{KEY}"))
        .bearer_auth(&admin)
        .json(&json!({"value": 3600, "reason": "slow reviewers"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["settings"][0]["effective_value"], json!(3600));
    assert_eq!(body["settings"][0]["override_value"], json!(3600));

    let response = client
        .put(format!("{url}/{KEY}"))
        .bearer_auth(&admin)
        .json(&json!({"value": 60, "reason": "too low"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let history: Value = client
        .get(format!("{url}/{KEY}/revisions"))
        .bearer_auth(&admin)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history["revisions"].as_array().unwrap().len(), 1);
    assert!(history["revisions"][0]["actor_name"].is_string());

    // Demote the same account: role is re-read from a freshly issued token.
    sqlx::query("UPDATE users SET role = 'member' WHERE username = 'runtime-admin'")
        .execute(&db)
        .await
        .unwrap();
    let member = login("runtime-admin", password).await;
    for request in [
        client.get(&url),
        client.get(format!("{url}/{KEY}/revisions")),
        client
            .put(format!("{url}/{KEY}"))
            .json(&json!({"value": 7200, "reason": "not allowed"})),
    ] {
        let response = request.bearer_auth(&member).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
