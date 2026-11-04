//! Browser connections follow the committed lifecycle of their exact auth session.
#![cfg(feature = "integration")]

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

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
    admin_token: String,
    user: Uuid,
    login: String,
    password: String,
    channel: Uuid,
    first: Session,
    second: Session,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, "session-admin", &password).await;
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
            Some(json!({"login":"session-admin","password":password})),
        )
        .await;
        assert!(status.is_success(), "{status} {auth}");
        let admin_token = auth["access_token"].as_str().unwrap().to_string();
        let login = format!("session-{}", Uuid::new_v4());
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
        let user = user["user_id"].as_str().unwrap().parse::<Uuid>().unwrap();
        let mut f = Self {
            gateway,
            base,
            client,
            admin_token,
            user,
            login,
            password,
            channel: Uuid::nil(),
            first: Session {
                id: String::new(),
                token: String::new(),
                refresh: String::new(),
            },
            second: Session {
                id: String::new(),
                token: String::new(),
                refresh: String::new(),
            },
        };
        let workspace = f
            .ok(
                &f.admin_token,
                Method::POST,
                "/workspaces",
                Some(json!({"name":"Browser sessions"})),
            )
            .await;
        let workspace = workspace["workspace_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        f.channel = f
            .ok(
                &f.admin_token,
                Method::POST,
                "/channels",
                Some(json!({"workspace_id":workspace,"name":"sessions"})),
            )
            .await["channel_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(workspace.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')")
            .bind(f.channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        f.first = f.login().await;
        f.second = f.login().await;
        assert_ne!(
            f.first.id, f.second.id,
            "two real sign-ins must create different sessions"
        );
        f
    }

    async fn call(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        request(&self.client, &self.base, token, method, path, body).await
    }

    async fn ok(&self, token: &str, method: Method, path: &str, body: Option<Value>) -> Value {
        let (status, body) = self.call(token, method, path, body).await;
        assert!(status.is_success(), "{path}: {status} {body}");
        body
    }

    async fn login(&self) -> Session {
        // Native token transport exposes the refresh credential without relying
        // on browser-cookie state shared by otherwise independent sign-ins.
        let auth = self
            .ok(
                "",
                Method::POST,
                "/auth/login",
                Some(json!({"login":self.login,"password":self.password,"client":"macos"})),
            )
            .await;
        assert_eq!(auth["role"], "member");
        let token = auth["access_token"].as_str().unwrap().to_string();
        let sessions = self.ok(&token, Method::GET, "/auth/sessions", None).await;
        let id = sessions
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["current"] == true)
            .unwrap()["session_id"]
            .as_str()
            .unwrap()
            .to_string();
        Session {
            id,
            token,
            refresh: auth["refresh_token"].as_str().unwrap().to_string(),
        }
    }

    async fn socket(&self, token: &str) -> Socket {
        let mut socket = self.unauthed_socket().await;
        send(&mut socket, json!({"type":"auth","token":token})).await;
        assert_eq!(
            next_type(&mut socket, "auth_ok").await["user_id"],
            self.user.to_string()
        );
        send(
            &mut socket,
            json!({"type":"subscribe","channel_id":self.channel}),
        )
        .await;
        assert_eq!(
            next_type(&mut socket, "subscribed").await["channel_id"],
            self.channel.to_string()
        );
        socket
    }

    async fn unauthed_socket(&self) -> Socket {
        connect_async(format!("{}/ws", self.base.replacen("http:", "ws:", 1)))
            .await
            .unwrap()
            .0
    }

    async fn healthy(&self, session: &Session, socket: &mut Socket) {
        let (status, body) = self
            .call(&session.token, Method::GET, "/users/me", None)
            .await;
        assert!(
            status.is_success(),
            "surviving session HTTP: {status} {body}"
        );
        let posted = self
            .ok(
                &self.admin_token,
                Method::POST,
                &format!("/channels/{}/messages", self.channel),
                Some(json!({"content":format!("Session barrier {}",Uuid::new_v4())})),
            )
            .await;
        loop {
            let event = frame(socket).await;
            if event["type"] == "message" && event["data"]["msg_id"] == posted["msg_id"] {
                break;
            }
        }
        let id = Uuid::new_v4().to_string();
        send(socket,json!({"type":"resource_req","req_id":id,"resource":"fs.ls","params":{"channel_id":self.channel,"path":""}})).await;
        loop {
            let response = frame(socket).await;
            if response["type"] == "resource_res" && response["req_id"] == id {
                assert_eq!(response["ok"], true, "{response}");
                break;
            }
        }
    }

    async fn rejected(&self, session: &Session) {
        let (status, body) = self
            .call(&session.token, Method::GET, "/users/me", None)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }

    async fn revoke(&self, acting: &Session, target: &Session) {
        self.ok(
            &acting.token,
            Method::DELETE,
            &format!("/auth/sessions/{}", target.id),
            None,
        )
        .await;
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
    let mut req = client.request(method, format!("{base}/api/v1{path}"));
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req.send().await.unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    (
        status,
        serde_json::from_str(&text).unwrap_or_else(|_| json!({"raw":text})),
    )
}

async fn send(socket: &mut Socket, value: Value) {
    socket.send(Message::Text(value.to_string())).await.unwrap();
}

async fn frame(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket.next().await.expect("socket remains open").unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                Message::Close(close) => panic!("unexpected socket close: {close:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("expected a bounded live session event")
}

async fn next_type(socket: &mut Socket, kind: &str) -> Value {
    loop {
        let event = frame(socket).await;
        if event["type"] == kind {
            return event;
        }
    }
}

async fn closed(socket: &mut Socket, forbidden_request: Option<&str>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket
                .next()
                .await
                .expect("expected an explicit authentication close")
                .unwrap()
            {
                Message::Close(Some(close)) => {
                    assert_eq!(u16::from(close.code), 4401, "{close:?}");
                    return;
                }
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if let Some(id) = forbidden_request {
                        assert!(
                            !(value["type"] == "resource_res" && value["req_id"] == id),
                            "revocation must suppress the blocked resource response: {value}"
                        );
                    }
                }
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                _ => {}
            }
        }
    })
    .await
    .expect("revocation must close without waiting for a client reauthentication");
}

async fn install_commit_fault(db: &PgPool, session: &str) {
    sqlx::raw_sql(&format!(r#"
        CREATE FUNCTION fail_session_revocation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.session_id = '{session}' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
                RAISE EXCEPTION 'injected session revocation COMMIT failure';
            END IF;
            RETURN NULL;
        END;
        $$;
        CREATE CONSTRAINT TRIGGER fail_session_revocation AFTER UPDATE ON auth_sessions
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_session_revocation();
    "#)).execute(db).await.unwrap();
}

async fn remove_commit_fault(db: &PgPool) {
    sqlx::raw_sql("DROP TRIGGER fail_session_revocation ON auth_sessions; DROP FUNCTION fail_session_revocation();").execute(db).await.unwrap();
}

#[sqlx::test]
async fn targeted_delete_and_logout_current_close_only_the_committed_target_session(db: PgPool) {
    let f = Fixture::start(&db).await;
    let mut first = f.socket(&f.first.token).await;
    let mut first_peer = f.socket(&f.first.token).await;
    let mut second = f.socket(&f.second.token).await;
    let (status, _) = f
        .call(
            &f.admin_token,
            Method::DELETE,
            &format!("/auth/sessions/{}", f.first.id),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a different user cannot revoke the target session"
    );
    install_commit_fault(&db, &f.first.id).await;
    let (status, body) = f
        .call(
            &f.second.token,
            Method::DELETE,
            &format!("/auth/sessions/{}", f.first.id),
            None,
        )
        .await;
    assert!(status.is_server_error(), "{status} {body}");
    let active: bool =
        sqlx::query_scalar("SELECT revoked_at IS NULL FROM auth_sessions WHERE session_id=$1")
            .bind(&f.first.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(active, "COMMIT failure must roll back the revocation");
    f.healthy(&f.first, &mut first).await;
    f.healthy(&f.first, &mut first_peer).await;
    f.healthy(&f.second, &mut second).await;
    remove_commit_fault(&db).await;
    f.revoke(&f.second, &f.first).await;
    closed(&mut first, None).await;
    closed(&mut first_peer, None).await;
    f.rejected(&f.first).await;
    f.healthy(&f.second, &mut second).await;
    let current = f.login().await;
    let mut current_socket = f.socket(&current.token).await;
    f.ok(&current.token, Method::POST, "/auth/logout-current", None)
        .await;
    closed(&mut current_socket, None).await;
    f.rejected(&current).await;
    f.healthy(&f.second, &mut second).await;
}

#[sqlx::test]
async fn logout_all_and_account_suspension_still_close_every_session_for_the_account(db: PgPool) {
    let f = Fixture::start(&db).await;
    let mut first = f.socket(&f.first.token).await;
    let mut second = f.socket(&f.second.token).await;
    f.ok(&f.first.token, Method::POST, "/auth/logout-all", None)
        .await;
    closed(&mut first, None).await;
    closed(&mut second, None).await;
    f.rejected(&f.first).await;
    f.rejected(&f.second).await;
    let third = f.login().await;
    let fourth = f.login().await;
    let mut third_socket = f.socket(&third.token).await;
    let mut fourth_socket = f.socket(&fourth.token).await;
    f.ok(
        &f.admin_token,
        Method::POST,
        &format!("/users/{}/suspend", f.user),
        None,
    )
    .await;
    closed(&mut third_socket, None).await;
    closed(&mut fourth_socket, None).await;
    f.rejected(&third).await;
    f.rejected(&fourth).await;
}

#[sqlx::test]
async fn refresh_token_reuse_revokes_only_its_session_and_closes_its_existing_socket(db: PgPool) {
    let f = Fixture::start(&db).await;
    let mut first = f.socket(&f.first.token).await;
    let mut second = f.socket(&f.second.token).await;
    let rotated = f
        .ok(
            "",
            Method::POST,
            "/auth/refresh",
            Some(json!({"refresh_token":f.first.refresh})),
        )
        .await;
    let token = rotated["access_token"].as_str().unwrap();
    let sessions = f.ok(token, Method::GET, "/auth/sessions", None).await;
    assert_eq!(
        sessions
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["current"] == true)
            .unwrap()["session_id"],
        f.first.id
    );
    let (status, body) = f
        .call(
            "",
            Method::POST,
            "/auth/refresh",
            Some(json!({"refresh_token":f.first.refresh})),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "native refresh reuse is not the web concurrency grace: {body}"
    );
    closed(&mut first, None).await;
    f.rejected(&f.first).await;
    f.healthy(&f.second, &mut second).await;
    let events:i64=sqlx::query_scalar("SELECT COUNT(*) FROM auth_security_events WHERE user_id=$1 AND session_id=$2 AND event_type='refresh_token_reuse'")
        .bind(f.user.to_string()).bind(&f.first.id).fetch_one(&db).await.unwrap();
    assert_eq!(
        events, 1,
        "the committed reuse receipt identifies the exact revoked session"
    );
}

#[sqlx::test]
async fn identity_unlink_and_other_session_revocation_commit_together_before_live_kicks(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    sqlx::query("INSERT INTO auth_external_identities(identity_id,provider,subject,user_id,corp_id) VALUES($1,'google',$2,$3,'')")
        .bind(Uuid::new_v4().to_string()).bind(Uuid::new_v4().to_string()).bind(f.user.to_string()).execute(&db).await.unwrap();
    let mut first = f.socket(&f.first.token).await;
    let mut second = f.socket(&f.second.token).await;
    install_commit_fault(&db, &f.second.id).await;
    let (status, body) = f
        .call(
            &f.first.token,
            Method::DELETE,
            "/users/me/external-identities/google",
            None,
        )
        .await;
    assert!(status.is_server_error(), "{status} {body}");
    let linked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_external_identities WHERE user_id=$1 AND provider='google')")
        .bind(f.user.to_string()).fetch_one(&db).await.unwrap();
    assert!(
        linked,
        "a failed revocation COMMIT cannot leave the identity unlinked"
    );
    f.healthy(&f.first, &mut first).await;
    f.healthy(&f.second, &mut second).await;
    remove_commit_fault(&db).await;
    f.ok(
        &f.first.token,
        Method::DELETE,
        "/users/me/external-identities/google",
        None,
    )
    .await;
    closed(&mut second, None).await;
    f.rejected(&f.second).await;
    f.healthy(&f.first, &mut first).await;
    let linked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_external_identities WHERE user_id=$1 AND provider='google')")
        .bind(f.user.to_string()).fetch_one(&db).await.unwrap();
    assert!(!linked);
}

#[sqlx::test]
async fn same_user_cross_session_reauthentication_moves_the_connection_to_the_new_session(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let mut rebound = f.socket(&f.first.token).await;
    let mut original = f.socket(&f.first.token).await;
    let mut second = f.socket(&f.second.token).await;
    send(&mut rebound, json!({"type":"auth","token":f.second.token})).await;
    assert_eq!(
        next_type(&mut rebound, "auth_ok").await["user_id"],
        f.user.to_string()
    );
    f.revoke(&f.second, &f.first).await;
    closed(&mut original, None).await;
    f.rejected(&f.first).await;
    f.healthy(&f.second, &mut rebound).await;
    f.healthy(&f.second, &mut second).await;
    f.revoke(&f.second, &f.second).await;
    closed(&mut rebound, None).await;
    closed(&mut second, None).await;
    f.rejected(&f.second).await;
}

async fn wait_until(epoch_seconds: u64) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while chrono::Utc::now().timestamp() < epoch_seconds as i64 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the short test credential deadline must be bounded");
}

#[sqlx::test]
async fn same_session_refresh_replaces_the_old_deadline_and_absolute_expiry_closes_idle_sockets(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let old_deadline = chrono::Utc::now().timestamp() as u64 + 3;
    let short = f
        .gateway
        .access_token_with_expiry(&f.first.token, old_deadline);
    let mut renewed = f.socket(&short).await;
    let rotated = f
        .ok(
            "",
            Method::POST,
            "/auth/refresh",
            Some(json!({"refresh_token":f.first.refresh})),
        )
        .await;
    let full_token = rotated["access_token"].as_str().unwrap();
    let sessions = f.ok(full_token, Method::GET, "/auth/sessions", None).await;
    assert_eq!(
        sessions
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["current"] == true)
            .unwrap()["session_id"],
        f.first.id
    );
    let new_deadline = old_deadline + 4;
    let longer = f.gateway.access_token_with_expiry(full_token, new_deadline);
    send(&mut renewed, json!({"type":"auth","token":longer})).await;
    assert_eq!(
        next_type(&mut renewed, "auth_ok").await["user_id"],
        f.user.to_string()
    );
    wait_until(old_deadline + 1).await;
    f.healthy(&f.first, &mut renewed).await;
    closed(&mut renewed, None).await;
    let expired = Session {
        id: f.first.id.clone(),
        token: longer,
        refresh: String::new(),
    };
    f.rejected(&expired).await;
    // A JWT deadline ends this connection's credentials, not the underlying
    // still-active session. Its actual refreshed token can authenticate again.
    let mut reconnected = f.socket(full_token).await;
    f.healthy(&f.first, &mut reconnected).await;
    sqlx::query("UPDATE auth_sessions SET absolute_expires_at=clock_timestamp()+INTERVAL '3 seconds' WHERE session_id=$1")
        .bind(&f.second.id).execute(&db).await.unwrap();
    let mut absolute = f.socket(&f.second.token).await;
    closed(&mut absolute, None).await;
    f.rejected(&f.second).await;
}

async fn wait_for_blocked(db: &PgPool, blocker: i32, event: &str) {
    tokio::time::timeout(Duration::from_secs(10),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event=$2 AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(blocker).bind(event).fetch_one(db).await.unwrap();
            if waiting {break;}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("the real gateway query must be waiting on the held PG barrier");
}

async fn install_auth_trap(db: &PgPool, session: &str) {
    // The first read of this real SID retains its pre-revocation MVCC snapshot.
    // A session advisory marker lets later reads/updates of that SID skip the
    // gate, so the actual authenticated HTTP revoke can commit while it waits.
    sqlx::raw_sql(&format!(
        r#"
        CREATE FUNCTION browser_auth_snapshot_trap() RETURNS BOOLEAN
        LANGUAGE plpgsql VOLATILE COST 1000000 AS $$
        BEGIN
            IF pg_try_advisory_lock(1128813139, 2) THEN
                PERFORM pg_advisory_lock(1128813139, 1);
                PERFORM pg_advisory_unlock(1128813139, 1);
                PERFORM pg_advisory_unlock(1128813139, 2);
            END IF;
            RETURN TRUE;
        END;
        $$;
        ALTER TABLE auth_sessions RENAME TO browser_auth_sessions_backing;
        CREATE VIEW auth_sessions AS SELECT * FROM browser_auth_sessions_backing
            WHERE session_id <> '{session}' OR browser_auth_snapshot_trap();
    "#
    ))
    .execute(db)
    .await
    .unwrap();
}

async fn remove_auth_trap(db: &PgPool) {
    sqlx::raw_sql("DROP VIEW auth_sessions; ALTER TABLE browser_auth_sessions_backing RENAME TO auth_sessions; DROP FUNCTION browser_auth_snapshot_trap();")
        .execute(db).await.unwrap();
}

#[sqlx::test]
async fn registration_and_rebinding_recheck_revocation_after_the_initial_auth_snapshot(db: PgPool) {
    let f = Fixture::start(&db).await;
    for rebind in [false, true] {
        let target = f.login().await;
        let mut socket = if rebind {
            f.socket(&f.second.token).await
        } else {
            f.unauthed_socket().await
        };
        let mut barrier = db.begin().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *barrier)
            .await
            .unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(1128813139,1)")
            .execute(&mut *barrier)
            .await
            .unwrap();
        install_auth_trap(&db, &target.id).await;
        send(&mut socket, json!({"type":"auth","token":target.token})).await;
        wait_for_blocked(&db, pid, "advisory").await;
        f.revoke(&f.second, &target).await;
        let revoked: bool = sqlx::query_scalar(
            "SELECT revoked_at IS NOT NULL FROM browser_auth_sessions_backing WHERE session_id=$1",
        )
        .bind(&target.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(
            revoked,
            "revocation must commit before the stale auth snapshot is released"
        );
        barrier.commit().await.unwrap();
        closed(&mut socket, None).await;
        f.rejected(&target).await;
        remove_auth_trap(&db).await;
        let mut survivor = f.socket(&f.second.token).await;
        f.healthy(&f.second, &mut survivor).await;
    }
}

#[sqlx::test]
async fn revocation_cancels_a_blocked_resource_without_waiting_for_its_database_lock(db: PgPool) {
    let f = Fixture::start(&db).await;
    let mut first = f.socket(&f.first.token).await;
    let mut second = f.socket(&f.second.token).await;
    let mut barrier = db.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("LOCK TABLE context_files IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *barrier)
        .await
        .unwrap();
    let request_id = Uuid::new_v4().to_string();
    send(&mut first,json!({"type":"resource_req","req_id":request_id,"resource":"fs.ls","params":{"channel_id":f.channel,"path":""}})).await;
    wait_for_blocked(&db, pid, "relation").await;
    f.revoke(&f.second, &f.first).await;
    // The barrier remains held: this can succeed only if revocation interrupts
    // the handler rather than waiting for fs.ls to return and leak its response.
    closed(&mut first, Some(&request_id)).await;
    barrier.commit().await.unwrap();
    f.rejected(&f.first).await;
    f.healthy(&f.second, &mut second).await;
}

#[sqlx::test]
async fn password_change_preserves_native_refresh_and_revokes_other_sessions(db: PgPool) {
    let f = Fixture::start(&db).await;
    let mut other_socket = f.socket(&f.second.token).await;
    let new_password = Uuid::new_v4().to_string();
    let changed = f
        .ok(
            &f.first.token,
            Method::POST,
            "/auth/change-password",
            Some(json!({"new_password": new_password})),
        )
        .await;
    let token = changed["access_token"].as_str().unwrap();
    f.ok(token, Method::GET, "/users/me", None).await;
    closed(&mut other_socket, None).await;
    f.rejected(&f.second).await;
    let refreshed = f
        .ok(
            "",
            Method::POST,
            "/auth/refresh",
            Some(json!({"refresh_token": f.first.refresh})),
        )
        .await;
    let sessions = f
        .ok(
            refreshed["access_token"].as_str().unwrap(),
            Method::GET,
            "/auth/sessions",
            None,
        )
        .await;
    assert_eq!(sessions.as_array().unwrap().len(), 1);
    assert_eq!(sessions[0]["session_id"], f.first.id);
    assert_eq!(sessions[0]["client"], "macos");
    assert!(
        server::domain::auth::authenticate(&db, &f.login, &new_password)
            .await
            .is_ok()
    );
    assert!(
        server::domain::auth::authenticate(&db, &f.login, &f.password)
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn password_change_preserves_web_refresh_cookies(db: PgPool) {
    let f = Fixture::start(&db).await;
    let response = f
        .client
        .post(format!("{}/api/v1/auth/login", f.base))
        .json(&json!({"login": f.login, "password": f.password, "client":"web"}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let cookies = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .map(|header| {
            header
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("; ");
    let auth: Value = response.json().await.unwrap();
    let changed = f
        .ok(
            auth["access_token"].as_str().unwrap(),
            Method::POST,
            "/auth/change-password",
            Some(json!({"new_password": Uuid::new_v4().to_string()})),
        )
        .await;
    f.ok(
        changed["access_token"].as_str().unwrap(),
        Method::GET,
        "/users/me",
        None,
    )
    .await;
    let response = f
        .client
        .post(format!("{}/api/v1/auth/refresh", f.base))
        .header(reqwest::header::COOKIE, cookies)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "web refresh after password change: {}",
        response.text().await.unwrap()
    );
}

#[sqlx::test]
async fn initial_password_preserves_ios_session_and_refresh(db: PgPool) {
    let f = Fixture::start(&db).await;
    let auth = f
        .ok(
            "",
            Method::POST,
            "/auth/login",
            Some(json!({"login": f.login, "password": f.password, "client":"ios"})),
        )
        .await;
    sqlx::query("UPDATE users SET password_hash=NULL WHERE user_id=$1")
        .bind(f.user.to_string())
        .execute(&db)
        .await
        .unwrap();
    let new_password = Uuid::new_v4().to_string();
    let changed = f
        .ok(
            auth["access_token"].as_str().unwrap(),
            Method::POST,
            "/auth/set-password",
            Some(json!({"new_password": new_password})),
        )
        .await;
    f.ok(
        changed["access_token"].as_str().unwrap(),
        Method::GET,
        "/users/me",
        None,
    )
    .await;
    let refreshed = f
        .ok(
            "",
            Method::POST,
            "/auth/refresh",
            Some(json!({"refresh_token":auth["refresh_token"]})),
        )
        .await;
    let sessions = f
        .ok(
            refreshed["access_token"].as_str().unwrap(),
            Method::GET,
            "/auth/sessions",
            None,
        )
        .await;
    assert_eq!(sessions.as_array().unwrap().len(), 1);
    assert_eq!(sessions[0]["client"], "ios");
    assert!(
        server::domain::auth::authenticate(&db, &f.login, &new_password)
            .await
            .is_ok()
    );
}

#[sqlx::test]
async fn stale_sessions_need_confirmation_to_set_password_or_unlink(db: PgPool) {
    let f = Fixture::start(&db).await;
    sqlx::query("INSERT INTO auth_external_identities(identity_id,provider,subject,user_id,corp_id) VALUES($1,'google',$2,$3,'')")
        .bind(Uuid::new_v4().to_string()).bind(Uuid::new_v4().to_string()).bind(f.user.to_string()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO auth_external_identities(identity_id,provider,subject,user_id,corp_id) VALUES($1,'github',$2,$3,'')")
        .bind(Uuid::new_v4().to_string()).bind(Uuid::new_v4().to_string()).bind(f.user.to_string()).execute(&db).await.unwrap();
    for provider in ["google", "github"] {
        let identity = f
            .ok(
                &f.first.token,
                Method::GET,
                &format!("/users/me/external-identities/{provider}"),
                None,
            )
            .await;
        assert_eq!(identity["linked"], true);
    }
    sqlx::query("UPDATE auth_sessions SET authenticated_at=NOW()-INTERVAL '16 minutes',step_up_at=NULL WHERE session_id=$1")
        .bind(&f.first.id).execute(&db).await.unwrap();
    for (method, path, body) in [
        (
            Method::POST,
            "/auth/set-password",
            Some(json!({"new_password":Uuid::new_v4().to_string()})),
        ),
        (
            Method::POST,
            "/auth/change-password",
            Some(json!({"new_password":Uuid::new_v4().to_string()})),
        ),
        (Method::DELETE, "/users/me/external-identities/google", None),
    ] {
        let (status, body) = f.call(&f.first.token, method, path, body).await;
        assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body}");
        assert_eq!(body["code"], "recent_authentication_required");
    }
    let flow = f
        .ok(
            &f.first.token,
            Method::POST,
            "/auth/flows/start",
            Some(json!({"purpose":"step_up","client":"macos"})),
        )
        .await;
    let proof = f
        .ok(
            &f.first.token,
            Method::POST,
            &format!(
                "/auth/flows/{}/password",
                flow["transaction_id"].as_str().unwrap()
            ),
            Some(json!({"password":f.password})),
        )
        .await;
    assert_eq!(proof["status"], "verified");
    f.ok(
        &f.first.token,
        Method::DELETE,
        "/users/me/external-identities/google",
        None,
    )
    .await;
    let remaining = f
        .ok(
            &f.first.token,
            Method::GET,
            "/users/me/external-identities/github",
            None,
        )
        .await;
    assert_eq!(
        remaining["linked"], true,
        "unlinking one provider must retain the other"
    );
}

#[sqlx::test]
async fn password_change_rolls_back_when_revocation_commit_fails(db: PgPool) {
    let f = Fixture::start(&db).await;
    install_commit_fault(&db, &f.second.id).await;
    let new_password = Uuid::new_v4().to_string();
    let (status, _) = f
        .call(
            &f.first.token,
            Method::POST,
            "/auth/change-password",
            Some(json!({"new_password":new_password})),
        )
        .await;
    assert!(status.is_server_error());
    assert!(
        server::domain::auth::authenticate(&db, &f.login, &f.password)
            .await
            .is_ok()
    );
    assert!(
        server::domain::auth::authenticate(&db, &f.login, &new_password)
            .await
            .is_err()
    );
    f.ok(&f.first.token, Method::GET, "/users/me", None).await;
    f.ok(&f.second.token, Method::GET, "/users/me", None).await;
    remove_commit_fault(&db).await;
}

#[sqlx::test]
async fn oauth_account_link_handoff_is_client_bound_and_single_use(db: PgPool) {
    let f = Fixture::start(&db).await;
    let code = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO auth_transactions(transaction_id,kind,status,client_type,provider,handoff_code_hash,context_json,expires_at) VALUES($1,'oauth','verified','ios','github',$2,$3,NOW()+INTERVAL '10 minutes')")
        .bind(Uuid::new_v4().to_string()).bind(server::infra::crypto::sha256_hex(&code))
        .bind(json!({"account_link_required":"github"})).execute(&db).await.unwrap();
    let (status, _) = f
        .call(
            "",
            Method::POST,
            "/auth/oauth/handoff",
            Some(json!({"code":code,"client":"macos"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = f
        .call(
            "",
            Method::POST,
            "/auth/oauth/handoff",
            Some(json!({"code":code,"client":"ios"})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "account_link_required");
    assert_eq!(body["provider"], "github");
    let (status, _) = f
        .call(
            "",
            Method::POST,
            "/auth/oauth/handoff",
            Some(json!({"code":code,"client":"ios"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
