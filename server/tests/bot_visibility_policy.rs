//! Current SEE decisions agree across the authenticated bridge and HTTP readers.
//! Every negative live assertion drains through a later, ordinary channel message:
//! the bridge Pong first proves the candidate was processed, and fanout FIFO puts
//! that message after any candidate delivery. No sleep stands in for non-delivery.
#![cfg(feature = "integration")]

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use server::domain::trace::{self, TraceEvent};
use sqlx::PgPool;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Fixture {
    _gateway: gateway::TestGateway,
    base: String,
    client: Client,
    admin_token: String,
    admin: Uuid,
    token: String,
    user: Uuid,
    owner: Uuid,
    workspace: Uuid,
    channel: Uuid,
    bot: Uuid,
    credential: String,
    card: Uuid,
    tool_trace: Uuid,
    approval_trace: Uuid,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, "visibility-admin", &password).await;
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        let (_, auth) = request(
            &client,
            &base,
            "",
            Method::POST,
            "/auth/login",
            Some(json!({"login":"visibility-admin","password":password})),
        )
        .await;
        let admin_token = auth["access_token"].as_str().unwrap().to_string();
        let admin = auth["user_id"].as_str().unwrap().parse().unwrap();
        let username = format!("viewer-{}", Uuid::new_v4());
        let password = Uuid::new_v4().to_string();
        let (status, created) = request(
            &client,
            &base,
            &admin_token,
            Method::POST,
            "/users",
            Some(json!({"username":username,"password":password,"role":"member"})),
        )
        .await;
        assert!(status.is_success(), "{created}");
        let user = created["user_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        let (_, auth) = request(
            &client,
            &base,
            "",
            Method::POST,
            "/auth/login",
            Some(json!({"login":username,"password":password})),
        )
        .await;
        assert_eq!(
            auth["role"], "member",
            "the observer must not bypass SEE as an admin"
        );
        let token = auth["access_token"].as_str().unwrap().to_string();
        let (_, workspace) = request(
            &client,
            &base,
            &admin_token,
            Method::POST,
            "/workspaces",
            Some(json!({"name":"Visibility"})),
        )
        .await;
        let workspace = workspace["workspace_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        let (_, channel) = request(
            &client,
            &base,
            &admin_token,
            Method::POST,
            "/channels",
            Some(json!({"workspace_id":workspace,"name":"visibility"})),
        )
        .await;
        let channel = channel["channel_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(workspace.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')")
            .bind(channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        let owner = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'unused-owner-login')",
        )
        .bind(owner.to_string())
        .bind(format!("owner-{owner}"))
        .execute(db)
        .await
        .unwrap();
        let bot = Uuid::new_v4();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor,binding_config) VALUES($1,$2,$3,FALSE,$4)")
            .bind(bot.to_string()).bind(format!("visibility-{bot}")).bind(owner.to_string())
            .bind(json!({"acp_security":{"require_capability":false}})).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
            .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        let credential = server::infra::crypto::generate_host_credential();
        sqlx::query("INSERT INTO connector_hosts(host_id,bot_id,device_name,status,credential_hash) VALUES($1,$2,'Visibility fixture','active',$3)")
            .bind(Uuid::new_v4().to_string()).bind(bot.to_string())
            .bind(server::infra::crypto::hash_host_credential(&credential)).execute(db).await.unwrap();
        let card = Uuid::new_v4();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,content_data,channel_seq) VALUES($1,$2,'bot',$3,'A private approval','permission',FALSE,$4,1)")
            .bind(card.to_string()).bind(channel.to_string()).bind(bot.to_string())
            .bind(json!({"kind":"agent_bridge_permission_request","request_id":card,"resolved":false,"tool":{"kind":"execute"},"options":[{"optionId":"allow","kind":"allow_once","name":"Allow"}]}))
            .execute(db).await.unwrap();
        sqlx::query("UPDATE channels SET next_seq=1 WHERE channel_id=$1")
            .bind(channel.to_string())
            .execute(db)
            .await
            .unwrap();
        let tool_trace = Uuid::new_v4();
        let approval_trace = Uuid::new_v4();
        for (id, kind, phase) in [
            (tool_trace, "trace", "tool_call"),
            (approval_trace, "approval", "approval"),
        ] {
            trace::record(
                db,
                TraceEvent {
                    id: Some(id.to_string()),
                    msg_id: card.to_string(),
                    channel_id: channel.to_string(),
                    bot_id: Some(bot.to_string()),
                    kind,
                    phase: phase.into(),
                    title: Some("Private detail".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        Self {
            _gateway: gateway,
            base,
            client,
            admin_token,
            admin,
            token,
            user,
            owner,
            workspace,
            channel,
            bot,
            credential,
            card,
            tool_trace,
            approval_trace,
        }
    }

    async fn get(&self, token: &str, path: &str) -> (StatusCode, Value) {
        request(&self.client, &self.base, token, Method::GET, path, None).await
    }

    async fn rule(
        &self,
        subject_kind: &str,
        subject: &str,
        class: &str,
        cap: &str,
        decision: &str,
        expiry: Option<String>,
    ) {
        let (status, body) = request(&self.client,&self.base,&self.admin_token,Method::PUT,&format!("/bots/{}/event-access",self.bot),Some(json!({"channel_id":self.channel,"subject_kind":subject_kind,"subject_id":subject,"event_class":class,"capability":cap,"decision":decision,"expires_at":expiry}))).await;
        assert!(status.is_success(), "rule write: {status} {body}");
    }

    async fn see_rules(&self, subject_kind: &str, subject: &str, decision: &str) {
        for class in ["tool_call", "permission_request"] {
            self.rule(subject_kind, subject, class, "see", decision, None)
                .await;
        }
    }

    async fn delete_user_see(&self) {
        for class in ["tool_call", "permission_request"] {
            let query = [
                ("channel_id", self.channel.to_string()),
                ("subject_kind", "user".to_string()),
                ("subject_id", self.user.to_string()),
                ("event_class", class.to_string()),
                ("capability", "see".to_string()),
            ];
            let response = self
                .client
                .delete(format!(
                    "{}/api/v1/bots/{}/event-access",
                    self.base, self.bot
                ))
                .bearer_auth(&self.admin_token)
                .query(&query)
                .send()
                .await
                .unwrap();
            assert!(
                response.status().is_success(),
                "delete user grant: {}",
                response.text().await.unwrap()
            );
        }
    }

    async fn browser(&self, token: &str) -> Socket {
        let (mut socket, _) =
            connect_async(format!("{}/ws", self.base.replacen("http:", "ws:", 1)))
                .await
                .unwrap();
        send(&mut socket, json!({"type":"auth","token":token})).await;
        next_type(&mut socket, "auth_ok").await;
        send(
            &mut socket,
            json!({"type":"subscribe","channel_id":self.channel}),
        )
        .await;
        next_type(&mut socket, "subscribed").await;
        socket
    }

    async fn bridge(&self) -> Socket {
        let (mut socket, _) = connect_async(format!(
            "{}/ws/agent-bridge/data",
            self.base.replacen("http:", "ws:", 1)
        ))
        .await
        .unwrap();
        send(
            &mut socket,
            json!({"type":"auth","token":self.credential,"bridge_protocol_version":1}),
        )
        .await;
        assert_eq!(
            next_type(&mut socket, "hello").await["bot_id"],
            self.bot.to_string()
        );
        socket
    }

    async fn live_probe(
        &self,
        browser: &mut Socket,
        bridge: &mut Socket,
        phase: &str,
        visible: bool,
    ) {
        let id = Uuid::new_v4();
        send(bridge,json!({"type":"trace","id":id,"channel_id":self.channel,"msg_id":self.card,"phase":phase,"status":"running","title":"SEE probe"})).await;
        send(bridge, json!({"type":"ping"})).await;
        next_type(bridge, "pong").await;
        let sentinel = self.sentinel().await;
        let mut observed = false;
        loop {
            let frame = frame(browser).await;
            if frame["type"] == "bot_trace" && frame["data"]["id"] == id.to_string() {
                observed = true;
            }
            if frame["type"] == "message" && frame["data"]["msg_id"] == sentinel {
                break;
            }
        }
        assert_eq!(
            observed, visible,
            "live phase={phase} must use the current SEE policy"
        );
    }

    async fn sentinel(&self) -> Value {
        let (status, body) = request(
            &self.client,
            &self.base,
            &self.admin_token,
            Method::POST,
            &format!("/channels/{}/messages", self.channel),
            Some(json!({"content":format!("Visibility barrier {}",Uuid::new_v4())})),
        )
        .await;
        assert!(status.is_success(), "sentinel: {status} {body}");
        body["msg_id"].clone()
    }

    async fn assert_http(&self, token: &str, tool: bool, approval: bool, actionable: bool) {
        for path in [
            format!("/channels/{}/messages/{}/trace", self.channel, self.card),
            format!("/channels/{}/traces", self.channel),
        ] {
            let (status, body) = self.get(token, &path).await;
            assert!(status.is_success(), "trace: {status} {body}");
            let events = body["events"].as_array().unwrap();
            assert_eq!(
                events
                    .iter()
                    .any(|e| e["id"] == self.tool_trace.to_string()),
                tool,
                "tool trace {body}"
            );
            assert_eq!(
                events
                    .iter()
                    .any(|e| e["id"] == self.approval_trace.to_string()),
                approval,
                "approval trace {body}"
            );
        }
        for path in [
            "/fleet".to_string(),
            format!("/workspaces/{}/fleet", self.workspace),
        ] {
            let (status, body) = self.get(token, &path).await;
            assert!(status.is_success(), "fleet: {status} {body}");
            let card = body["approvals"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["message_id"] == self.card.to_string());
            assert_eq!(card.is_some(), approval, "fleet: {body}");
            if let Some(card) = card {
                assert_eq!(
                    card["actionable"], actionable,
                    "SEE must not supply RESPOND: {card}"
                );
            }
        }
        let (status, badge) = self.get(token, "/fleet/badge").await;
        assert!(status.is_success(), "badge: {status} {badge}");
        assert_eq!(badge["count"], if approval && actionable { 1 } else { 0 });
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
    let value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"raw":text}));
    (status, value)
}

async fn send(socket: &mut Socket, value: Value) {
    socket.send(Message::Text(value.to_string())).await.unwrap();
}

async fn frame(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket.next().await.expect("socket stays open").unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                Message::Close(close) => panic!("unexpected socket close: {close:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("expected bounded visibility frame/barrier")
}

async fn next_type(socket: &mut Socket, kind: &str) -> Value {
    loop {
        let value = frame(socket).await;
        if value["type"] == kind {
            return value;
        }
    }
}

#[sqlx::test]
async fn allow_deny_and_grant_revocation_apply_to_the_next_live_and_http_operation(db: PgPool) {
    let f = Fixture::start(&db).await;
    f.see_rules("role", "member", "deny").await;
    f.see_rules("user", &f.user.to_string(), "allow").await;
    f.rule(
        "user",
        &f.user.to_string(),
        "permission_request",
        "respond",
        "allow",
        None,
    )
    .await;
    let mut browser = f.browser(&f.token).await;
    let mut bridge = f.bridge().await;
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", true)
        .await;
    f.assert_http(&f.token, true, true, true).await;
    f.see_rules("user", &f.user.to_string(), "deny").await;
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", false)
        .await;
    f.live_probe(&mut browser, &mut bridge, "approval", false)
        .await;
    f.assert_http(&f.token, false, false, false).await;
    f.see_rules("user", &f.user.to_string(), "allow").await;
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", true)
        .await;
    f.delete_user_see().await;
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", false)
        .await;
    f.assert_http(&f.token, false, false, false).await;
}

#[sqlx::test]
async fn an_expired_allow_cannot_outlive_its_database_deadline_in_a_warm_reader(db: PgPool) {
    let f = Fixture::start(&db).await;
    f.see_rules("role", "member", "deny").await;
    f.see_rules("user", &f.user.to_string(), "allow").await;
    let mut browser = f.browser(&f.token).await;
    let mut bridge = f.bridge().await;
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", true)
        .await;
    // Set the deadline after warming the operation, so expiry is not a cold-load test.
    let deadline:chrono::DateTime<chrono::Utc>=sqlx::query_scalar("UPDATE bot_event_access SET expires_at=clock_timestamp()+INTERVAL '150 milliseconds' WHERE bot_id=$1 AND subject_kind='user' AND capability='see' RETURNING expires_at")
        .bind(f.bot.to_string()).fetch_one(&db).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !sqlx::query_scalar::<_, bool>("SELECT clock_timestamp()>$1")
            .bind(deadline)
            .fetch_one(&db)
            .await
            .unwrap()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", false)
        .await;
    f.assert_http(&f.token, false, false, false).await;
}

#[sqlx::test]
async fn dynamic_friend_channel_and_workspace_memberships_are_rechecked_without_a_ttl(db: PgPool) {
    let f = Fixture::start(&db).await;
    let group_workspace = Uuid::new_v4();
    let group_channel = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Group scope')")
        .bind(group_workspace.to_string())
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'Group scope')")
        .bind(group_channel.to_string())
        .bind(group_workspace.to_string())
        .execute(&db)
        .await
        .unwrap();
    let pair = if f.owner < f.user {
        format!("{}:{}", f.owner, f.user)
    } else {
        format!("{}:{}", f.user, f.owner)
    };
    f.see_rules("role", "member", "deny").await;
    let mut browser = f.browser(&f.token).await;
    let mut bridge = f.bridge().await;
    for group in [
        "friends".to_string(),
        format!("channel:{group_channel}"),
        format!("workspace:{group_workspace}"),
    ] {
        f.see_rules("group", &group, "allow").await;
        if group == "friends" {
            sqlx::query("INSERT INTO friendships(friendship_id,user_id,friend_id,pair_key,status) VALUES($1,$2,$3,$4,'accepted')").bind(Uuid::new_v4().to_string()).bind(f.owner.to_string()).bind(f.user.to_string()).bind(&pair).execute(&db).await.unwrap();
        } else {
            sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')").bind(group_workspace.to_string()).bind(f.user.to_string()).execute(&db).await.unwrap();
            if group.starts_with("channel:") {
                sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')").bind(group_channel.to_string()).bind(f.user.to_string()).execute(&db).await.unwrap();
            }
        }
        f.live_probe(&mut browser, &mut bridge, "visibility_probe", true)
            .await;
        f.assert_http(&f.token, true, true, false).await;
        if group == "friends" {
            sqlx::query("UPDATE friendships SET status='rejected' WHERE pair_key=$1")
                .bind(&pair)
                .execute(&db)
                .await
                .unwrap();
        } else {
            sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
                .bind(group_channel.to_string())
                .bind(f.user.to_string())
                .execute(&db)
                .await
                .unwrap();
            sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
                .bind(group_workspace.to_string())
                .bind(f.user.to_string())
                .execute(&db)
                .await
                .unwrap();
        }
        f.live_probe(&mut browser, &mut bridge, "visibility_probe", false)
            .await;
        f.assert_http(&f.token, false, false, false).await;
        sqlx::query("DELETE FROM bot_event_access WHERE bot_id=$1 AND subject_kind='group'")
            .bind(f.bot.to_string())
            .execute(&db)
            .await
            .unwrap();
    }
}

#[sqlx::test]
async fn policy_and_dynamic_group_read_failures_never_fall_back_to_a_warm_allow(db: PgPool) {
    let f = Fixture::start(&db).await;
    f.see_rules("role", "member", "deny").await;
    f.see_rules("group", "friends", "allow").await;
    let pair = if f.owner < f.user {
        format!("{}:{}", f.owner, f.user)
    } else {
        format!("{}:{}", f.user, f.owner)
    };
    sqlx::query("INSERT INTO friendships(friendship_id,user_id,friend_id,pair_key,status) VALUES($1,$2,$3,$4,'accepted')").bind(Uuid::new_v4().to_string()).bind(f.owner.to_string()).bind(f.user.to_string()).bind(pair).execute(&db).await.unwrap();
    let mut browser = f.browser(&f.token).await;
    let mut bridge = f.bridge().await;
    for table in ["bot_event_access", "friendships"] {
        f.live_probe(&mut browser, &mut bridge, "visibility_probe", true)
            .await;
        f.assert_http(&f.token, true, true, false).await;
        sqlx::raw_sql(&format!(
            "ALTER TABLE {table} RENAME TO unavailable_visibility_table"
        ))
        .execute(&db)
        .await
        .unwrap();
        f.live_probe(&mut browser, &mut bridge, "visibility_probe", false)
            .await;
        for path in [
            format!("/channels/{}/messages/{}/trace", f.channel, f.card),
            format!("/channels/{}/traces", f.channel),
        ] {
            let (status, body) = f.get(&f.token, &path).await;
            assert!(
                status.is_server_error() || body["events"].as_array().is_some_and(Vec::is_empty),
                "policy failure must not return trace data: {status} {body}"
            );
        }
        for path in [
            "/fleet".to_string(),
            format!("/workspaces/{}/fleet", f.workspace),
        ] {
            let (status, body) = f.get(&f.token, &path).await;
            assert!(
                status.is_server_error() || body["approvals"].as_array().is_some_and(Vec::is_empty),
                "policy failure must not return cards: {status} {body}"
            );
        }
        let (status, badge) = f.get(&f.token, "/fleet/badge").await;
        assert!(
            status.is_server_error() || badge["count"] == 0,
            "{status} {badge}"
        );
        sqlx::raw_sql(&format!(
            "ALTER TABLE unavailable_visibility_table RENAME TO {table}"
        ))
        .execute(&db)
        .await
        .unwrap();
        f.live_probe(&mut browser, &mut bridge, "visibility_probe", true)
            .await;
    }
}

#[sqlx::test]
async fn message_trace_anchor_must_belong_to_the_requested_channel_even_for_an_admin(db: PgPool) {
    let f = Fixture::start(&db).await;
    let foreign = Uuid::new_v4();
    let anchor = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'Foreign traces')",
    )
    .bind(foreign.to_string())
    .bind(f.workspace.to_string())
    .execute(&db)
    .await
    .unwrap();
    for bot_id in [Some(f.bot.to_string()), None] {
        trace::record(
            &db,
            TraceEvent {
                msg_id: anchor.to_string(),
                channel_id: foreign.to_string(),
                bot_id,
                kind: "trace",
                phase: "tool_call".into(),
                title: Some("Must never cross channel".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    for token in [&f.token, &f.admin_token] {
        let (status, body) = f
            .get(
                token,
                &format!("/channels/{}/messages/{anchor}/trace", f.channel),
            )
            .await;
        assert!(
            status == StatusCode::NOT_FOUND
                || (status.is_success() && body["events"].as_array().is_some_and(Vec::is_empty)),
            "route channel must constrain the anchor, including system traces: {status} {body}"
        );
    }
    let (status, _) = f
        .get(
            &f.token,
            &format!("/channels/{foreign}/messages/{anchor}/trace"),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn admin_see_bypass_does_not_grant_respond_and_live_bypass_uses_current_role(db: PgPool) {
    let f = Fixture::start(&db).await;
    f.see_rules("role", "*", "deny").await;
    let mut browser = f.browser(&f.admin_token).await;
    let mut bridge = f.bridge().await;
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", true)
        .await;
    f.assert_http(&f.admin_token, true, true, false).await;
    let (status, body) = request(
        &f.client,
        &f.base,
        &f.admin_token,
        Method::POST,
        &format!("/channels/{}/permissions/{}/resolve", f.channel, f.card),
        Some(json!({"option_id":"allow"})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "admin SEE cannot answer another owner's card: {body}"
    );
    sqlx::query("UPDATE users SET role='member' WHERE user_id=$1")
        .bind(f.admin.to_string())
        .execute(&db)
        .await
        .unwrap();
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", false)
        .await;
    // The pre-existing HTTP token deliberately retains its admin claims. Trace/Fleet
    // preserve their claims-based bypass; the existing live connection uses DB role.
    f.assert_http(&f.admin_token, true, true, false).await;
}

#[sqlx::test]
async fn a_stale_subscriber_without_membership_is_not_a_default_live_seer(db: PgPool) {
    let f = Fixture::start(&db).await;
    let mut browser = f.browser(&f.token).await;
    let mut bridge = f.bridge().await;
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", true)
        .await;
    // Direct DB removal intentionally leaves the subscription registered, exercising
    // authorization's membership backstop independently of API unsubscribe effects.
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='user'").bind(f.channel.to_string()).bind(f.user.to_string()).execute(&db).await.unwrap();
    f.live_probe(&mut browser, &mut bridge, "visibility_probe", false)
        .await;
    let (status, _) = f
        .get(
            &f.token,
            &format!("/channels/{}/messages/{}/trace", f.channel, f.card),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, fleet) = f.get(&f.token, "/fleet").await;
    assert!(status.is_success(), "{fleet}");
    assert!(fleet["approvals"].as_array().unwrap().is_empty());
    let (_, badge) = f.get(&f.token, "/fleet/badge").await;
    assert_eq!(badge["count"], 0);
}

#[sqlx::test]
async fn repeated_cards_share_complete_group_rules_across_see_respond_and_event_classes(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    f.rule("role", "member", "tool_call", "see", "deny", None)
        .await;
    f.rule(
        "group",
        &format!("channel:{}", f.channel),
        "permission_request",
        "see",
        "allow",
        None,
    )
    .await;
    // This group appears only in RESPOND. Loading groups for the first SEE
    // decision must still retain it for later decisions in this same batch.
    f.rule(
        "group",
        "friends",
        "permission_request",
        "respond",
        "allow",
        None,
    )
    .await;
    for seq in 2..=12_i64 {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,content_data,channel_seq) VALUES($1,$2,'bot',$3,'Repeated approval','permission',FALSE,$4,$5)")
            .bind(id.to_string()).bind(f.channel.to_string()).bind(f.bot.to_string())
            .bind(json!({"request_id":id,"resolved":false,"tool":{"kind":if seq%2==0 {"read"}else{"execute"}}})).bind(seq).execute(&db).await.unwrap();
        trace::record(
            &db,
            TraceEvent {
                msg_id: f.card.to_string(),
                channel_id: f.channel.to_string(),
                bot_id: Some(f.bot.to_string()),
                kind: if seq % 2 == 0 { "trace" } else { "approval" },
                phase: if seq % 2 == 0 {
                    "tool_call".into()
                } else {
                    "approval".into()
                },
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    sqlx::query("UPDATE channels SET next_seq=12 WHERE channel_id=$1")
        .bind(f.channel.to_string())
        .execute(&db)
        .await
        .unwrap();
    let pair = if f.owner < f.user {
        format!("{}:{}", f.owner, f.user)
    } else {
        format!("{}:{}", f.user, f.owner)
    };
    for allowed in [false, true, false] {
        if allowed {
            sqlx::query("INSERT INTO friendships(friendship_id,user_id,friend_id,pair_key,status) VALUES($1,$2,$3,$4,'accepted')").bind(Uuid::new_v4().to_string()).bind(f.owner.to_string()).bind(f.user.to_string()).bind(&pair).execute(&db).await.unwrap();
        } else {
            sqlx::query("DELETE FROM friendships WHERE pair_key=$1")
                .bind(&pair)
                .execute(&db)
                .await
                .unwrap();
        }
        for path in [
            "/fleet".to_string(),
            format!("/workspaces/{}/fleet", f.workspace),
        ] {
            let (status, body) = f.get(&f.token, &path).await;
            assert!(status.is_success(), "{status} {body}");
            let cards = body["approvals"].as_array().unwrap();
            assert_eq!(cards.len(), 12, "same-bot rows must all remain SEE-visible");
            assert!(
                cards.iter().all(
                    |card| card["bot_id"] == f.bot.to_string() && card["actionable"] == allowed
                ),
                "RESPOND-only group must apply to every card: {body}"
            );
        }
        let (_, badge) = f.get(&f.token, "/fleet/badge").await;
        assert_eq!(badge["count"], if allowed { 12 } else { 0 });
        for path in [
            format!("/channels/{}/messages/{}/trace", f.channel, f.card),
            format!("/channels/{}/traces", f.channel),
        ] {
            let (status, body) = f.get(&f.token, &path).await;
            assert!(status.is_success(), "{status} {body}");
            let events = body["events"].as_array().unwrap();
            assert_eq!(events.len(), 6);
            assert!(
                events.iter().all(|event| event["kind"] == "approval"),
                "tool-call denial cannot be reused for the approval class: {body}"
            );
        }
    }
}

#[sqlx::test]
async fn policy_read_budget_is_per_operation_bot_and_distinct_live_viewer(db: PgPool) {
    let f = Fixture::start(&db).await;
    f.rule(
        "group",
        "friends",
        "permission_request",
        "see",
        "allow",
        None,
    )
    .await;
    for seq in 2..=12_i64 {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,content_data,channel_seq) VALUES($1,$2,'bot',$3,'Budget approval','permission',FALSE,$4,$5)")
            .bind(id.to_string()).bind(f.channel.to_string()).bind(f.bot.to_string())
            .bind(json!({"request_id":id,"resolved":false,"tool":{"kind":"execute"}})).bind(seq).execute(&db).await.unwrap();
        trace::record(
            &db,
            TraceEvent {
                msg_id: f.card.to_string(),
                channel_id: f.channel.to_string(),
                bot_id: Some(f.bot.to_string()),
                kind: if seq % 2 == 0 { "trace" } else { "approval" },
                phase: if seq % 2 == 0 {
                    "tool_call".into()
                } else {
                    "approval".into()
                },
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    sqlx::query("UPDATE channels SET next_seq=12 WHERE channel_id=$1")
        .bind(f.channel.to_string())
        .execute(&db)
        .await
        .unwrap();

    let username = format!("second-viewer-{}", Uuid::new_v4());
    let password = Uuid::new_v4().to_string();
    let (status, created) = request(
        &f.client,
        &f.base,
        &f.admin_token,
        Method::POST,
        "/users",
        Some(json!({"username":username,"password":password,"role":"member"})),
    )
    .await;
    assert!(status.is_success(), "{created}");
    let second_user = created["user_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let (status, auth) = request(
        &f.client,
        &f.base,
        "",
        Method::POST,
        "/auth/login",
        Some(json!({"login":username,"password":password})),
    )
    .await;
    assert!(status.is_success(), "{auth}");
    assert_eq!(auth["role"], "member");
    let second_token = auth["access_token"].as_str().unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
        .bind(f.workspace.to_string()).bind(second_user.to_string()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')")
        .bind(f.channel.to_string()).bind(second_user.to_string()).execute(&db).await.unwrap();
    for user in [f.user, second_user] {
        let pair = if f.owner < user {
            format!("{}:{user}", f.owner)
        } else {
            format!("{user}:{}", f.owner)
        };
        sqlx::query("INSERT INTO friendships(friendship_id,user_id,friend_id,pair_key,status) VALUES($1,$2,$3,$4,'accepted')")
            .bind(Uuid::new_v4().to_string()).bind(f.owner.to_string()).bind(user.to_string()).bind(pair).execute(&db).await.unwrap();
    }
    let mut first_browser = f.browser(&f.token).await;
    let mut second_browser = f.browser(second_token).await;
    let mut bridge = f.bridge().await;

    // Install before the first policy read. Each bot has exactly one rule and
    // each viewer one qualifying friendship, so row reads measure repeat loads.
    // High function cost leaves cheap bot/pair predicates ahead of the recorder;
    // VOLATILE prevents the optimizer from folding away its observable writes.
    sqlx::raw_sql(
        r#"
        CREATE TABLE visibility_policy_reads(kind TEXT NOT NULL);
        CREATE FUNCTION record_visibility_policy_read(read_kind TEXT) RETURNS BOOLEAN
        LANGUAGE plpgsql VOLATILE COST 1000000 AS $$
        BEGIN
            INSERT INTO visibility_policy_reads(kind) VALUES(read_kind);
            RETURN TRUE;
        END;
        $$;
        ALTER TABLE bot_event_access RENAME TO visibility_rules_backing;
        CREATE VIEW bot_event_access AS
            SELECT * FROM visibility_rules_backing WHERE record_visibility_policy_read('rules');
        ALTER TABLE friendships RENAME TO visibility_friends_backing;
        CREATE VIEW friendships AS
            SELECT * FROM visibility_friends_backing WHERE record_visibility_policy_read('groups');
    "#,
    )
    .execute(&db)
    .await
    .unwrap();

    for path in [
        format!("/channels/{}/messages/{}/trace", f.channel, f.card),
        format!("/channels/{}/traces", f.channel),
        "/fleet".to_string(),
        format!("/workspaces/{}/fleet", f.workspace),
        "/fleet/badge".to_string(),
    ] {
        sqlx::query("TRUNCATE visibility_policy_reads")
            .execute(&db)
            .await
            .unwrap();
        let (status, body) = f.get(&f.token, &path).await;
        assert!(status.is_success(), "{path}: {status} {body}");
        if path.ends_with("/badge") {
            assert_eq!(body["count"], 0, "SEE alone cannot grant RESPOND");
        } else if path.contains("trace") {
            assert_eq!(body["events"].as_array().unwrap().len(), 13);
        } else {
            let cards = body["approvals"].as_array().unwrap();
            assert_eq!(cards.len(), 12);
            assert!(cards.iter().all(|card| card["actionable"] == false));
        }
        assert_eq!(
            visibility_read_counts(&db).await,
            (1, 1),
            "{path}: repeated rows and SEE/RESPOND must share bot rules and viewer groups"
        );
    }

    sqlx::query("TRUNCATE visibility_policy_reads")
        .execute(&db)
        .await
        .unwrap();
    for operation in 1..=3_i64 {
        let id = Uuid::new_v4();
        send(&mut bridge,json!({"type":"trace","id":id,"channel_id":f.channel,"msg_id":f.card,"phase":"approval","status":"running","title":"Read budget"})).await;
        send(&mut bridge, json!({"type":"ping"})).await;
        next_type(&mut bridge, "pong").await;
        assert_eq!(
            visibility_read_counts(&db).await,
            (operation, 2 * operation),
            "each new broadcast reloads rules once and groups once per distinct viewer"
        );
        let sentinel = f.sentinel().await;
        for browser in [&mut first_browser, &mut second_browser] {
            let mut observed = false;
            loop {
                let event = frame(browser).await;
                if event["type"] == "bot_trace" && event["data"]["id"] == id.to_string() {
                    observed = true;
                }
                if event["type"] == "message" && event["data"]["msg_id"] == sentinel {
                    break;
                }
            }
            assert!(
                observed,
                "both distinct authorized viewers receive the broadcast being counted"
            );
        }
    }
}

async fn visibility_read_counts(db: &PgPool) -> (i64, i64) {
    sqlx::query_as("SELECT COUNT(*) FILTER (WHERE kind='rules'),COUNT(*) FILTER (WHERE kind='groups') FROM visibility_policy_reads")
        .fetch_one(db).await.unwrap()
}
