//! Public credential recovery retires every old credential in one transaction.
#![cfg(feature = "integration")]

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use server::domain::{auth, auth_sessions};
use server::infra::crypto::sha256_hex;

#[path = "support/gateway.rs"]
mod gateway;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Session {
    id: String,
    token: String,
    refresh: String,
}

struct Fixture {
    gateway: gateway::TestGateway,
    base: String,
    client: Client,
    user: String,
    login: String,
    email: String,
    password: String,
    first: Session,
    second: Session,
    trusted: String,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let login = format!("reset-{}", Uuid::new_v4());
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, &login, &password).await;
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
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        let first = login_session(db, &client, &base, &login, &password).await;
        let second = login_session(db, &client, &base, &login, &password).await;
        assert_ne!(first.id, second.id);
        let trusted = auth_sessions::issue_trusted_device(db, &user, &first.id, Some("Reset test"))
            .await
            .unwrap();
        assert!(
            auth_sessions::trusted_device_is_valid(db, &user, Some(&trusted))
                .await
                .unwrap()
        );
        Self {
            gateway,
            base,
            client,
            user,
            login,
            email,
            password,
            first,
            second,
            trusted,
        }
    }

    async fn code(&self, db: &PgPool, code: &str) {
        let hash = self
            .gateway
            .email_code_hash(&self.email, "password_reset", code);
        sqlx::query("INSERT INTO email_codes(email,code,code_hash,purpose,expires_at,user_id) VALUES($1,NULL,$2,'password_reset',clock_timestamp()+INTERVAL '10 minutes',$3)")
            .bind(&self.email).bind(hash).bind(&self.user).execute(db).await.unwrap();
    }

    async fn reset(&self, code: &str, password: &str) -> (StatusCode, Value) {
        request(
            &self.client,
            &self.base,
            "",
            Method::POST,
            "/auth/reset-password",
            Some(json!({"email":self.email,"code":code,"new_password":password})),
        )
        .await
    }

    async fn socket(&self) -> Socket {
        let mut socket = connect_async(format!("{}/ws", self.base.replacen("http:", "ws:", 1)))
            .await
            .unwrap()
            .0;
        socket
            .send(Message::Text(
                json!({"type":"auth","token":self.first.token}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(
            next_type(&mut socket, "auth_ok").await["user_id"],
            self.user
        );
        socket
    }

    async fn assert_revoked(&self, db: &PgPool) {
        let live: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL",
        )
        .bind(&self.user)
        .fetch_one(db)
        .await
        .unwrap();
        assert_eq!(live, 0, "reset must not leave an old live session");
        let refresh: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_refresh_tokens rt JOIN auth_sessions s USING(session_id) WHERE s.user_id=$1 AND rt.revoked_at IS NULL")
            .bind(&self.user).fetch_one(db).await.unwrap();
        assert_eq!(refresh, 0, "every old refresh credential must be revoked");
        assert!(
            !auth_sessions::trusted_device_is_valid(db, &self.user, Some(&self.trusted))
                .await
                .unwrap()
        );
        for session in [&self.first, &self.second] {
            assert_eq!(
                request(
                    &self.client,
                    &self.base,
                    &session.token,
                    Method::GET,
                    "/users/me",
                    None
                )
                .await
                .0,
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                request(
                    &self.client,
                    &self.base,
                    "",
                    Method::POST,
                    "/auth/refresh",
                    Some(json!({"refresh_token":session.refresh}))
                )
                .await
                .0,
                StatusCode::UNAUTHORIZED
            );
        }
    }
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
    (
        status,
        serde_json::from_str(&text).unwrap_or_else(|_| json!({"raw":text})),
    )
}

async fn login_session(
    db: &PgPool,
    client: &Client,
    base: &str,
    login: &str,
    password: &str,
) -> Session {
    let (status, body) = request(
        client,
        base,
        "",
        Method::POST,
        "/auth/login",
        Some(json!({"login":login,"password":password,"client":"macos"})),
    )
    .await;
    assert!(status.is_success(), "native login failed: {status}");
    assert_eq!(body["status"], "authenticated");
    let token = body["access_token"].as_str().unwrap().to_string();
    let refresh = body["refresh_token"].as_str().unwrap().to_string();
    let id = sqlx::query_scalar("SELECT session_id FROM auth_refresh_tokens WHERE token_hash=$1")
        .bind(sha256_hex(&refresh))
        .fetch_one(db)
        .await
        .unwrap();
    Session { id, token, refresh }
}

async fn next_type(socket: &mut Socket, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket
                .next()
                .await
                .expect("socket remains connected")
                .unwrap()
            {
                Message::Text(text) => {
                    let event: Value = serde_json::from_str(&text).unwrap();
                    if event["type"] == kind {
                        return event;
                    }
                }
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                Message::Close(_) => panic!("socket closed before the expected control receipt"),
                _ => {}
            }
        }
    })
    .await
    .expect("bounded browser control receipt")
}

async fn assert_socket_live(socket: &mut Socket) {
    socket
        .send(Message::Text(json!({"type":"ping"}).to_string()))
        .await
        .unwrap();
    next_type(socket, "pong").await;
}

async fn assert_closed(socket: &mut Socket) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket
                .next()
                .await
                .expect("reset must send an explicit auth close")
                .unwrap()
            {
                Message::Close(Some(close)) => {
                    assert_eq!(u16::from(close.code), 4401);
                    break;
                }
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                _ => {}
            }
        }
    })
    .await
    .expect("reset closes an existing browser connection after commit");
}

async fn security_snapshot(db: &PgPool, user: &str, email: &str) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object(
        'user',(SELECT jsonb_build_array(password_hash,token_version) FROM users WHERE user_id=$1),
        'codes',(SELECT jsonb_agg(jsonb_build_array(id,used) ORDER BY id) FROM email_codes WHERE email=$2),
        'sessions',(SELECT jsonb_agg(jsonb_build_array(session_id,revoked_at,revoke_reason) ORDER BY session_id) FROM auth_sessions WHERE user_id=$1),
        'refresh',(SELECT jsonb_agg(jsonb_build_array(rt.refresh_token_id,rt.consumed_at,rt.replaced_by_id,rt.revoked_at) ORDER BY rt.refresh_token_id) FROM auth_refresh_tokens rt JOIN auth_sessions s USING(session_id) WHERE s.user_id=$1),
        'trusted',(SELECT jsonb_agg(jsonb_build_array(trusted_device_id,revoked_at) ORDER BY trusted_device_id) FROM trusted_devices WHERE user_id=$1))")
        .bind(user).bind(email).fetch_one(db).await.unwrap()
}

async fn wait_for_blocked(db: &PgPool, blocker: i32, count: i64) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let blocked: i64 = sqlx::query_scalar("WITH RECURSIVE blocked(pid) AS (
                SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
                UNION
                SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database() AND a.wait_event_type='Lock'
            ) SELECT COUNT(*) FROM blocked")
                .bind(blocker).fetch_one(db).await.unwrap();
            if blocked >= count { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("actual HTTP commands must reach the expected database lock");
}

#[sqlx::test]
async fn public_reset_revokes_sessions_refresh_and_trust_before_new_credentials_can_be_used(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let mut socket = f.socket().await;
    f.code(&db, "AB23CD").await;
    let password = Uuid::new_v4().to_string();
    let (status, body) = f.reset(" ab23cd ", &password).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert_closed(&mut socket).await;
    f.assert_revoked(&db).await;

    let trusts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM trusted_devices WHERE user_id=$1")
        .bind(&f.user)
        .fetch_one(&db)
        .await
        .unwrap();
    let stale = auth_sessions::issue_trusted_device(
        &db,
        &f.user,
        &f.first.id,
        Some("Stale factor completion"),
    )
    .await;
    assert!(
        matches!(stale, Err(server::errors::AppError::Unauthorized(_))),
        "a revoked originating SID must not issue new device trust"
    );
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM trusted_devices WHERE user_id=$1")
        .bind(&f.user)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(trusts, after);

    assert!(auth::authenticate(&db, &f.login, &f.password)
        .await
        .is_err());
    let replacement = login_session(&db, &f.client, &f.base, &f.login, &password).await;
    assert_ne!(replacement.id, f.first.id);
    sqlx::query("UPDATE users SET email_2fa_enabled=TRUE WHERE user_id=$1")
        .bind(&f.user)
        .execute(&db)
        .await
        .unwrap();
    let (status, body) = request(&f.client, &f.base, "", Method::POST, "/auth/login",
        Some(json!({"login":f.login,"password":password,"client":"macos","trusted_device":f.trusted}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["status"], "factor_required",
        "old trust must not bypass the second factor"
    );
}

#[sqlx::test]
async fn update_and_deferred_commit_faults_roll_back_every_reset_effect_and_allow_same_code_retry(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    f.code(&db, "AB23CD").await;
    let mut socket = f.socket().await;
    let before = security_snapshot(&db, &f.user, &f.email).await;
    let password = Uuid::new_v4().to_string();
    for deferred in [false, true] {
        let (table, trigger) = if deferred {
            ("trusted_devices", "CREATE CONSTRAINT TRIGGER fail_password_reset AFTER UPDATE ON trusted_devices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_password_reset()")
        } else {
            ("auth_refresh_tokens", "CREATE TRIGGER fail_password_reset BEFORE UPDATE ON auth_refresh_tokens FOR EACH ROW EXECUTE FUNCTION fail_password_reset()")
        };
        sqlx::raw_sql(&format!("CREATE FUNCTION fail_password_reset() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'injected credential revocation failure'; END IF; RETURN NEW; END; $$; {trigger};"))
            .execute(&db).await.unwrap();
        let (status, _) = f.reset("AB23CD", &password).await;
        assert!(
            status.is_server_error(),
            "injected revocation failure must reject reset"
        );
        assert_eq!(security_snapshot(&db, &f.user, &f.email).await, before);
        assert_eq!(
            request(
                &f.client,
                &f.base,
                &f.first.token,
                Method::GET,
                "/users/me",
                None
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_socket_live(&mut socket).await;
        sqlx::raw_sql(&format!(
            "DROP TRIGGER fail_password_reset ON {table}; DROP FUNCTION fail_password_reset();"
        ))
        .execute(&db)
        .await
        .unwrap();
    }
    assert_eq!(f.reset("AB23CD", &password).await.0, StatusCode::OK);
    assert_closed(&mut socket).await;
    f.assert_revoked(&db).await;
    assert!(auth::authenticate(&db, &f.login, &password).await.is_ok());
}

#[sqlx::test]
async fn concurrent_public_resets_consume_one_code_once_and_invalidate_other_live_codes(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    f.code(&db, "AB23CD").await;
    f.code(&db, "EF45GH").await;
    let version: i32 = sqlx::query_scalar("SELECT token_version FROM users WHERE user_id=$1")
        .bind(&f.user)
        .fetch_one(&db)
        .await
        .unwrap();
    let first = Uuid::new_v4().to_string();
    let second = Uuid::new_v4().to_string();
    let (a, b) = tokio::join!(f.reset("AB23CD", &first), f.reset("AB23CD", &second));
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
            .filter(|status| **status == StatusCode::BAD_REQUEST)
            .count(),
        1
    );
    let winner = if a.0 == StatusCode::OK {
        &first
    } else {
        &second
    };
    let loser = if a.0 == StatusCode::OK {
        &second
    } else {
        &first
    };
    assert!(auth::authenticate(&db, &f.login, winner).await.is_ok());
    assert!(auth::authenticate(&db, &f.login, loser).await.is_err());
    assert_eq!(f.reset("AB23CD", loser).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.reset("EF45GH", loser).await.0, StatusCode::BAD_REQUEST);
    let after: i32 = sqlx::query_scalar("SELECT token_version FROM users WHERE user_id=$1")
        .bind(&f.user)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(after, version + 1);
    let unused: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM email_codes WHERE email=$1 AND purpose='password_reset' AND used=FALSE")
        .bind(&f.email).fetch_one(&db).await.unwrap();
    assert_eq!(unused, 0);
    f.assert_revoked(&db).await;
}

#[sqlx::test]
async fn reset_retires_a_refresh_that_already_queued_for_the_original_session(db: PgPool) {
    let f = Fixture::start(&db).await;
    f.code(&db, "AB23CD").await;
    let mut blocker = db.begin().await.unwrap();
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("SELECT session_id FROM auth_sessions WHERE session_id=$1 FOR UPDATE")
        .bind(&f.first.id)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let refresh = request(
        &f.client,
        &f.base,
        "",
        Method::POST,
        "/auth/refresh",
        Some(json!({"refresh_token":f.first.refresh})),
    );
    tokio::pin!(refresh);
    // Poll the real request while observing its actual PG wait.
    let refresh_wait = wait_for_blocked(&db, blocker_pid, 1);
    tokio::pin!(refresh_wait);
    tokio::select! { result=&mut refresh => panic!("refresh bypassed the held session lock: {}",result.0), _=&mut refresh_wait => {} }
    let password = Uuid::new_v4().to_string();
    let reset = f.reset("AB23CD", &password);
    tokio::pin!(reset);
    let reset_wait = wait_for_blocked(&db, blocker_pid, 2);
    tokio::pin!(reset_wait);
    tokio::select! { result=&mut reset => panic!("reset bypassed the held session lock: {}",result.0), _=&mut reset_wait => {} }
    blocker.commit().await.unwrap();
    let (refresh, reset) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::join!(refresh, reset)
    })
    .await
    .expect("refresh and reset must finish without a lock-order deadlock");
    assert_eq!(reset.0, StatusCode::OK);
    assert!(refresh.0 == StatusCode::OK || refresh.0 == StatusCode::UNAUTHORIZED);
    if refresh.0 == StatusCode::OK {
        let token = refresh.1["access_token"].as_str().unwrap();
        let rotated = refresh.1["refresh_token"].as_str().unwrap();
        assert_eq!(
            request(&f.client, &f.base, token, Method::GET, "/users/me", None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                &f.client,
                &f.base,
                "",
                Method::POST,
                "/auth/refresh",
                Some(json!({"refresh_token":rotated}))
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    f.assert_revoked(&db).await;
}

#[sqlx::test]
async fn a_password_login_authenticated_before_reset_cannot_create_a_session_after_reset(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    f.code(&db, "AB23CD").await;
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
    let reset = f.reset("AB23CD", &password);
    tokio::pin!(reset);
    let reset_wait = wait_for_blocked(&db, blocker_pid, 1);
    tokio::pin!(reset_wait);
    tokio::select! { result=&mut reset => panic!("reset bypassed the held account lock: {}",result.0), _=&mut reset_wait => {} }
    let login = request(
        &f.client,
        &f.base,
        "",
        Method::POST,
        "/auth/login",
        Some(json!({"login":f.login,"password":f.password,"client":"macos"})),
    );
    tokio::pin!(login);
    let login_wait = wait_for_blocked(&db, blocker_pid, 2);
    tokio::pin!(login_wait);
    tokio::select! { result=&mut login => panic!("login must reach the fresh-user fence before completing: {}",result.0), _=&mut login_wait => {} }
    blocker.commit().await.unwrap();
    let (reset, login) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::join!(reset, login)
    })
    .await
    .expect("queued reset and stale login must finish without deadlock");
    assert_eq!(reset.0, StatusCode::OK);
    assert_eq!(login.0, StatusCode::UNAUTHORIZED);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_sessions WHERE user_id=$1")
        .bind(&f.user)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(sessions, 2, "a stale AuthUser must not insert a third SID");
    f.assert_revoked(&db).await;
}

#[sqlx::test]
async fn a_reset_code_expired_while_its_row_was_locked_cannot_authorize_any_credential_change(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    f.code(&db, "AB23CD").await;
    let before = security_snapshot(&db, &f.user, &f.email).await;
    let mut socket = f.socket().await;
    let mut blocker = db.begin().await.unwrap();
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query(
        "SELECT id FROM email_codes WHERE email=$1 AND purpose='password_reset' FOR UPDATE",
    )
    .bind(&f.email)
    .fetch_all(&mut *blocker)
    .await
    .unwrap();
    let password = Uuid::new_v4().to_string();
    let reset = f.reset("AB23CD", &password);
    tokio::pin!(reset);
    let wait = wait_for_blocked(&db, blocker_pid, 1);
    tokio::pin!(wait);
    tokio::select! { result=&mut reset => panic!("reset bypassed the held code lock: {}",result.0), _=&mut wait => {} }
    sqlx::query("UPDATE email_codes SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE email=$1 AND purpose='password_reset'")
        .bind(&f.email).execute(&mut *blocker).await.unwrap();
    blocker.commit().await.unwrap();
    let (status, _) = tokio::time::timeout(Duration::from_secs(20), reset)
        .await
        .expect("reset must reject promptly after the code lock is released");
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(security_snapshot(&db, &f.user, &f.email).await, before);
    assert_socket_live(&mut socket).await;
    assert!(auth::authenticate(&db, &f.login, &f.password).await.is_ok());
}
