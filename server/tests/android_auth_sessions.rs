//! Android uses the native session protocol without impersonating another client.
#![cfg(feature = "integration")]

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn frame(socket: &mut Socket) -> Message {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                message => return message,
            }
        }
    })
    .await
    .expect("expected a bounded authentication event")
}

async fn socket(base: &str, token: &str) -> Socket {
    let (mut socket, _) = connect_async(format!("{}/ws", base.replacen("http:", "ws:", 1)))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({"type":"auth","token":token}).to_string(),
        ))
        .await
        .unwrap();
    let Message::Text(text) = frame(&mut socket).await else {
        panic!("expected auth_ok")
    };
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["type"],
        "auth_ok"
    );
    socket
}

#[sqlx::test]
async fn android_native_login_refresh_and_reuse_keep_exact_session_scope(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_gateway, base) = gateway::TestGateway::start(&db, "android-admin", &password).await;
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let mut sessions = Vec::new();
    for _ in 0..2 {
        let response = client.post(format!("{base}/api/v1/auth/login"))
            .json(&json!({"login":"android-admin","password":password,"client":"android","device_name":"Android integration"}))
            .send().await.unwrap();
        assert!(response.status().is_success());
        assert!(!response.headers().contains_key(reqwest::header::SET_COOKIE));
        let auth: Value = response.json().await.unwrap();
        assert_eq!(auth["status"], "authenticated");
        assert!(auth["expires_in"].as_i64().unwrap() > 0);
        assert!(!auth["refresh_token"].as_str().unwrap().is_empty());
        let summary: Value = client
            .get(format!("{base}/api/v1/auth/sessions"))
            .bearer_auth(auth["access_token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let current = summary
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["current"] == true)
            .unwrap();
        assert_eq!(current["client"], "android");
        sessions.push((auth, current["session_id"].as_str().unwrap().to_owned()));
    }
    let (first, first_id) = &sessions[0];
    let (second, _) = &sessions[1];
    let mut first_socket = socket(&base, first["access_token"].as_str().unwrap()).await;
    let mut second_socket = socket(&base, second["access_token"].as_str().unwrap()).await;
    let refresh = client
        .post(format!("{base}/api/v1/auth/refresh"))
        .json(&json!({"refresh_token":first["refresh_token"]}))
        .send()
        .await
        .unwrap();
    assert!(refresh.status().is_success());
    assert!(!refresh.headers().contains_key(reqwest::header::SET_COOKIE));
    let rotated: Value = refresh.json().await.unwrap();
    assert_ne!(rotated["refresh_token"], first["refresh_token"]);
    let summary: Value = client
        .get(format!("{base}/api/v1/auth/sessions"))
        .bearer_auth(rotated["access_token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(summary
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["current"] == true && row["session_id"] == *first_id));
    let reused = client
        .post(format!("{base}/api/v1/auth/refresh"))
        .json(&json!({"refresh_token":first["refresh_token"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(reused.status(), StatusCode::UNAUTHORIZED);
    let Message::Close(Some(close)) = frame(&mut first_socket).await else {
        panic!("expected exact-session close")
    };
    assert_eq!(u16::from(close.code), 4401);
    second_socket
        .send(Message::Text(json!({"type":"ping"}).to_string()))
        .await
        .unwrap();
    let Message::Text(text) = frame(&mut second_socket).await else {
        panic!("unrelated session must survive")
    };
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["type"],
        "pong"
    );
    let response = client
        .get(format!("{base}/api/v1/auth/sessions"))
        .bearer_auth(rotated["access_token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .get(format!("{base}/api/v1/auth/sessions"))
        .bearer_auth(second["access_token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
}

#[sqlx::test]
async fn android_client_migration_is_repeatable_and_preserves_existing_clients(db: PgPool) {
    let user = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(user_id,username) VALUES($1,$2)")
        .bind(&user)
        .bind(format!("client-migration-{user}"))
        .execute(&db)
        .await
        .unwrap();
    for client in ["web", "ios", "macos", "android"] {
        sqlx::query("INSERT INTO auth_sessions(session_id,user_id,client_type,token_family_id,absolute_expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '1 day')")
            .bind(Uuid::new_v4().to_string()).bind(&user).bind(client).bind(Uuid::new_v4().to_string()).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO auth_transactions(transaction_id,user_id,kind,client_type,expires_at) VALUES($1,$2,'login',$3,NOW()+INTERVAL '1 day')")
            .bind(Uuid::new_v4().to_string()).bind(&user).bind(client).execute(&db).await.unwrap();
    }
    sqlx::raw_sql(include_str!("../migrations/0111_android_auth_client.sql"))
        .execute(&db)
        .await
        .unwrap();
    for table in ["auth_sessions", "auth_transactions"] {
        let clients: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT client_type FROM {table} ORDER BY client_type"
        ))
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(clients, ["android", "ios", "macos", "web"]);
    }
    let invalid = sqlx::query("INSERT INTO auth_sessions(session_id,user_id,client_type,token_family_id,absolute_expires_at) VALUES($1,$2,'unknown',$3,NOW()+INTERVAL '1 day')")
        .bind(Uuid::new_v4().to_string()).bind(&user).bind(Uuid::new_v4().to_string()).execute(&db).await.unwrap_err();
    assert!(
        matches!(invalid,sqlx::Error::Database(ref error) if error.code().as_deref()==Some("23514"))
    );
    let invalid = sqlx::query("INSERT INTO auth_transactions(transaction_id,user_id,kind,client_type,expires_at) VALUES($1,$2,'login','unknown',NOW()+INTERVAL '1 day')")
        .bind(Uuid::new_v4().to_string()).bind(&user).execute(&db).await.unwrap_err();
    assert!(
        matches!(invalid,sqlx::Error::Database(ref error) if error.code().as_deref()==Some("23514"))
    );
}
