//! Unified authentication-flow invariants against a real PostgreSQL database.
#![cfg(feature = "integration")]

use chrono::{Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use server::domain::auth_sessions;

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
