//! Channel detachment commits its authority cleanup before changing live delivery.
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

struct User {
    id: Uuid,
    token: String,
}

struct Fixture {
    _gateway: gateway::TestGateway,
    base: String,
    client: Client,
    admin: User,
    member: User,
    workspace: Uuid,
    channel: Uuid,
    other_channel: Uuid,
    bot: Uuid,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, "detach-admin", &password).await;
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
            Some(json!({"login":"detach-admin","password":password})),
        )
        .await;
        assert!(status.is_success(), "{auth}");
        let admin = User {
            id: auth["user_id"].as_str().unwrap().parse().unwrap(),
            token: auth["access_token"].as_str().unwrap().into(),
        };
        let mut f = Self {
            _gateway: gateway,
            base,
            client,
            admin,
            member: User {
                id: Uuid::nil(),
                token: String::new(),
            },
            workspace: Uuid::nil(),
            channel: Uuid::nil(),
            other_channel: Uuid::nil(),
            bot: Uuid::new_v4(),
        };
        let workspace = f
            .ok(
                &f.admin.token,
                Method::POST,
                "/workspaces",
                Some(json!({"name":"Atomic detach"})),
            )
            .await;
        f.workspace = workspace["workspace_id"].as_str().unwrap().parse().unwrap();
        f.channel = f.new_channel().await;
        f.other_channel = f.new_channel().await;
        f.member = f.new_user(db).await;
        f.join(db, f.channel, &f.member, "member").await;
        f.join(db, f.other_channel, &f.member, "member").await;
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor) VALUES($1,$2,$3,FALSE)")
            .bind(f.bot.to_string()).bind(format!("detach-{}",f.bot)).bind(f.admin.id.to_string()).execute(db).await.unwrap();
        for channel in [f.channel, f.other_channel] {
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
                .bind(channel.to_string()).bind(f.bot.to_string()).execute(db).await.unwrap();
            f.grant(db, channel, f.member.id).await;
        }
        // These rows are deliberately outside the removed (channel,user) scope.
        sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision) VALUES($1,'','user',$2,'permission_request','respond','allow'),($1,$3,'role','member','tool_call','see','allow'),($1,$3,'group','friends','tool_call','see','allow')")
            .bind(f.bot.to_string()).bind(f.member.id.to_string()).bind(f.channel.to_string()).execute(db).await.unwrap();
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
        let (status, value) = self.call(token, method, path, body).await;
        assert!(status.is_success(), "{path}: {status} {value}");
        value
    }

    async fn new_channel(&self) -> Uuid {
        self.ok(
            &self.admin.token,
            Method::POST,
            "/channels",
            Some(json!({"workspace_id":self.workspace,"name":format!("detach-{}",Uuid::new_v4())})),
        )
        .await["channel_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }

    async fn new_user(&self, db: &PgPool) -> User {
        let login = format!("detach-{}", Uuid::new_v4());
        let password = Uuid::new_v4().to_string();
        let created = self
            .ok(
                &self.admin.token,
                Method::POST,
                "/users",
                Some(json!({"username":login,"password":password,"role":"member"})),
            )
            .await;
        let id = created["user_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        let auth = self
            .ok(
                "",
                Method::POST,
                "/auth/login",
                Some(json!({"login":login,"password":password})),
            )
            .await;
        assert_eq!(auth["role"], "member");
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(self.workspace.to_string()).bind(id.to_string()).execute(db).await.unwrap();
        User {
            id,
            token: auth["access_token"].as_str().unwrap().into(),
        }
    }

    async fn join(&self, db: &PgPool, channel: Uuid, user: &User, role: &str) {
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user',$3)")
            .bind(channel.to_string()).bind(user.id.to_string()).bind(role).execute(db).await.unwrap();
    }

    async fn grant(&self, db: &PgPool, channel: Uuid, user: Uuid) {
        sqlx::query("INSERT INTO approval_delegations(id,bot_id,channel_id,user_id,granted_by) VALUES($1,$2,$3,$4,$5)")
            .bind(Uuid::new_v4().to_string()).bind(self.bot.to_string()).bind(channel.to_string()).bind(user.to_string()).bind(self.admin.id.to_string()).execute(db).await.unwrap();
        for (class, cap) in [
            ("permission_request", "respond"),
            ("tool_call", "see"),
            ("prompt", "initiate"),
        ] {
            sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision) VALUES($1,$2,'user',$3,$4,$5,'allow')")
                .bind(self.bot.to_string()).bind(channel.to_string()).bind(user.to_string()).bind(class).bind(cap).execute(db).await.unwrap();
        }
    }

    async fn socket(&self, user: &User) -> Socket {
        let (mut socket, _) =
            connect_async(format!("{}/ws", self.base.replacen("http:", "ws:", 1)))
                .await
                .unwrap();
        send(&mut socket, json!({"type":"auth","token":user.token})).await;
        assert_eq!(
            next_type(&mut socket, "auth_ok").await["user_id"],
            user.id.to_string()
        );
        socket
    }

    async fn subscribed(&self) -> Socket {
        let mut socket = self.socket(&self.member).await;
        for channel in [self.channel, self.other_channel] {
            subscribe(&mut socket, channel).await;
        }
        socket
    }

    async fn post(&self, channel: Uuid) -> Uuid {
        self.ok(
            &self.admin.token,
            Method::POST,
            &format!("/channels/{channel}/messages"),
            Some(json!({"content":format!("Detach barrier {}",Uuid::new_v4())})),
        )
        .await["msg_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }

    async fn delivery(&self, socket: &mut Socket, visible: bool) {
        let candidate = self.post(self.channel).await;
        let sentinel = self.post(self.other_channel).await;
        let mut observed = false;
        loop {
            let event = frame(socket).await;
            if event["type"] == "message" && event["data"]["msg_id"] == candidate.to_string() {
                observed = true;
            }
            if event["type"] == "message" && event["data"]["msg_id"] == sentinel.to_string() {
                break;
            }
        }
        assert_eq!(
            observed, visible,
            "the same socket must retain only its authorized channel delivery"
        );
    }

    async fn detach(&self, leave: bool) -> (StatusCode, Value) {
        if leave {
            self.call(
                &self.member.token,
                Method::POST,
                &format!("/channels/{}/leave", self.channel),
                None,
            )
            .await
        } else {
            self.call(
                &self.admin.token,
                Method::DELETE,
                &format!("/channels/{}/members/{}", self.channel, self.member.id),
                None,
            )
            .await
        }
    }

    async fn assert_authority(&self, db: &PgPool, present: bool) {
        let (status, body) = self
            .call(
                &self.member.token,
                Method::GET,
                &format!("/channels/{}/messages", self.channel),
                None,
            )
            .await;
        assert_eq!(
            status.is_success(),
            present,
            "HTTP channel authority: {status} {body}"
        );
        assert_eq!(
            server::domain::approval::is_approver(
                db,
                self.bot,
                self.channel,
                self.member.id,
                "execute"
            )
            .await
            .unwrap(),
            present
        );
        let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM bot_event_access WHERE channel_id=$1 AND subject_kind='user' AND subject_id=$2")
            .bind(self.channel.to_string()).bind(self.member.id.to_string()).fetch_one(db).await.unwrap();
        assert_eq!(count, if present { 3 } else { 0 });
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
    .expect("expected bounded channel/sentinel event")
}
async fn next_type(socket: &mut Socket, kind: &str) -> Value {
    loop {
        let event = frame(socket).await;
        if event["type"] == kind {
            return event;
        }
    }
}
async fn subscribe(socket: &mut Socket, channel: Uuid) {
    send(socket, json!({"type":"subscribe","channel_id":channel})).await;
    assert_eq!(
        next_type(socket, "subscribed").await["channel_id"],
        channel.to_string()
    );
}

async fn authority_snapshot(db: &PgPool, channel: Uuid, user: Uuid) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object('membership',(SELECT to_jsonb(m) FROM channel_memberships m WHERE channel_id=$1 AND member_id=$2),'invites',(SELECT jsonb_agg(to_jsonb(i)) FROM channel_invites i WHERE channel_id=$1 AND user_id=$2),'delegations',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM approval_delegations d WHERE channel_id=$1 AND user_id=$2),'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY bot_id,event_class,capability) FROM bot_event_access r WHERE channel_id=$1 AND subject_kind='user' AND subject_id=$2))")
        .bind(channel.to_string()).bind(user.to_string()).fetch_one(db).await.unwrap()
}

async fn install_fault(db: &PgPool, table: &str, deferred: bool) {
    sqlx::raw_sql("CREATE FUNCTION fail_channel_detach() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected detach failure'; END; $$;").execute(db).await.unwrap();
    let statement = if deferred {
        format!("CREATE CONSTRAINT TRIGGER fail_channel_detach AFTER DELETE ON {table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_channel_detach()")
    } else {
        format!("CREATE TRIGGER fail_channel_detach BEFORE DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION fail_channel_detach()")
    };
    sqlx::raw_sql(&statement).execute(db).await.unwrap();
}

async fn remove_fault(db: &PgPool, table: &str) {
    sqlx::raw_sql(&format!(
        "DROP TRIGGER fail_channel_detach ON {table}; DROP FUNCTION fail_channel_detach();"
    ))
    .execute(db)
    .await
    .unwrap();
}

#[sqlx::test]
async fn remove_and_leave_commit_scoped_authority_cleanup_before_cutting_only_that_subscription(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let outside = authority_snapshot(&db, f.other_channel, f.member.id).await;
    let mut socket = f.subscribed().await;
    for leave in [false, true] {
        f.delivery(&mut socket, true).await;
        let (status, body) = f.detach(leave).await;
        assert!(status.is_success(), "leave={leave}: {status} {body}");
        f.assert_authority(&db, false).await;
        f.delivery(&mut socket, false).await;
        assert_eq!(
            authority_snapshot(&db, f.other_channel, f.member.id).await,
            outside
        );
        let preserved:i64=sqlx::query_scalar("SELECT COUNT(*) FROM bot_event_access WHERE bot_id=$1 AND (channel_id='' OR (channel_id=$2 AND subject_kind IN ('role','group')))")
            .bind(f.bot.to_string()).bind(f.channel.to_string()).fetch_one(&db).await.unwrap();
        assert_eq!(
            preserved, 3,
            "bot-wide, role and group rules are outside the detach scope"
        );
        if !leave {
            f.join(&db, f.channel, &f.member, "member").await;
            f.grant(&db, f.channel, f.member.id).await;
            subscribe(&mut socket, f.channel).await;
        }
    }
}

#[sqlx::test]
async fn authority_delete_errors_roll_back_membership_and_leave_live_http_authority_usable(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let mut socket = f.subscribed().await;
    for (table, leave) in [("approval_delegations", false), ("bot_event_access", true)] {
        let before = authority_snapshot(&db, f.channel, f.member.id).await;
        install_fault(&db, table, false).await;
        let (status, body) = f.detach(leave).await;
        assert!(status.is_server_error(), "{table}: {status} {body}");
        assert_eq!(
            authority_snapshot(&db, f.channel, f.member.id).await,
            before,
            "the entire detach must roll back on a cleanup error"
        );
        f.assert_authority(&db, true).await;
        f.delivery(&mut socket, true).await;
        remove_fault(&db, table).await;
        let (status, body) = f.detach(leave).await;
        assert!(status.is_success(), "retry: {status} {body}");
        f.assert_authority(&db, false).await;
        f.delivery(&mut socket, false).await;
        if !leave {
            f.join(&db, f.channel, &f.member, "member").await;
            f.grant(&db, f.channel, f.member.id).await;
            subscribe(&mut socket, f.channel).await;
        }
    }
}

#[sqlx::test]
async fn deferred_commit_failure_keeps_every_authority_row_and_does_not_unsubscribe(db: PgPool) {
    let f = Fixture::start(&db).await;
    let mut socket = f.subscribed().await;
    let before = authority_snapshot(&db, f.channel, f.member.id).await;
    install_fault(&db, "channel_memberships", true).await;
    let (status, body) = f.detach(false).await;
    assert!(status.is_server_error(), "{status} {body}");
    assert_eq!(
        authority_snapshot(&db, f.channel, f.member.id).await,
        before
    );
    f.assert_authority(&db, true).await;
    f.delivery(&mut socket, true).await;
    remove_fault(&db, "channel_memberships").await;
    let (status, body) = f.detach(false).await;
    assert!(status.is_success(), "{status} {body}");
    f.assert_authority(&db, false).await;
    f.delivery(&mut socket, false).await;
}

async fn resolved_until(socket: &mut Socket, sentinel: Uuid) -> Vec<String> {
    let mut resolved = Vec::new();
    loop {
        let event = frame(socket).await;
        if event["type"] == "notification_resolved" {
            resolved.push(event["data"]["id"].as_str().unwrap().to_string());
        }
        if event["type"] == "message" && event["data"]["msg_id"] == sentinel.to_string() {
            return resolved;
        }
    }
}

#[sqlx::test]
async fn pending_invites_resolve_only_their_actual_recipient_after_a_successful_commit(db: PgPool) {
    let f = Fixture::start(&db).await;
    let invitee = f.new_user(&db).await;
    f.join(&db, f.other_channel, &invitee, "member").await;
    let outside = f.new_channel().await;
    let bot = Uuid::new_v4();
    sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor) VALUES($1,$2,$3,FALSE)")
        .bind(bot.to_string()).bind(format!("pending-{bot}")).bind(f.member.id.to_string()).execute(&db).await.unwrap();
    for channel in [f.channel, outside] {
        sqlx::query("INSERT INTO channel_invites(channel_id,user_id,role,invited_by) VALUES($1,$2,'member',$3)")
            .bind(channel.to_string()).bind(invitee.id.to_string()).bind(f.admin.id.to_string()).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO bot_channel_invites(channel_id,bot_id,owner_user_id,invited_by) VALUES($1,$2,$3,$4)")
            .bind(channel.to_string()).bind(bot.to_string()).bind(f.member.id.to_string()).bind(f.admin.id.to_string()).execute(&db).await.unwrap();
    }
    let mut human_socket = f.socket(&invitee).await;
    let mut owner_socket = f.socket(&f.member).await;
    subscribe(&mut human_socket, f.other_channel).await;
    subscribe(&mut owner_socket, f.other_channel).await;
    let human_id = format!("channel:{}", f.channel);
    let bot_id = format!("bot-channel:{}:{bot}", f.channel);
    for (token, id) in [(&invitee.token, &human_id), (&f.member.token, &bot_id)] {
        let notifications = f.ok(token, Method::GET, "/notifications", None).await;
        assert!(
            notifications
                .as_array()
                .unwrap()
                .iter()
                .any(|n| n["id"] == *id),
            "{notifications}"
        );
    }
    install_fault(&db, "channel_invites", false).await;
    let (status, body) = f
        .call(
            &f.admin.token,
            Method::DELETE,
            &format!("/channels/{}/members/{}", f.channel, invitee.id),
            None,
        )
        .await;
    assert!(status.is_server_error(), "{status} {body}");
    let sentinel = f.post(f.other_channel).await;
    assert!(resolved_until(&mut human_socket, sentinel).await.is_empty());
    assert!(resolved_until(&mut owner_socket, sentinel).await.is_empty());
    let pending:i64=sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM channel_invites WHERE channel_id=$1)+(SELECT COUNT(*) FROM bot_channel_invites WHERE channel_id=$1)")
        .bind(f.channel.to_string()).fetch_one(&db).await.unwrap();
    assert_eq!(
        pending, 2,
        "failed cleanup preserves both durable invitation sources"
    );
    remove_fault(&db, "channel_invites").await;
    f.ok(
        &f.admin.token,
        Method::DELETE,
        &format!("/channels/{}/members/{}", f.channel, invitee.id),
        None,
    )
    .await;
    let sentinel = f.post(f.other_channel).await;
    assert_eq!(
        resolved_until(&mut human_socket, sentinel).await,
        vec![human_id]
    );
    assert!(resolved_until(&mut owner_socket, sentinel).await.is_empty());
    f.ok(
        &f.admin.token,
        Method::DELETE,
        &format!("/channels/{}/members/{bot}", f.channel),
        None,
    )
    .await;
    let sentinel = f.post(f.other_channel).await;
    assert_eq!(
        resolved_until(&mut owner_socket, sentinel).await,
        vec![bot_id]
    );
    assert!(resolved_until(&mut human_socket, sentinel).await.is_empty());
    let outside_pending:i64=sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM channel_invites WHERE channel_id=$1)+(SELECT COUNT(*) FROM bot_channel_invites WHERE channel_id=$1)")
        .bind(outside.to_string()).fetch_one(&db).await.unwrap();
    assert_eq!(
        outside_pending, 2,
        "removal cannot consume another channel's invites"
    );
}

#[sqlx::test]
async fn concurrent_remove_leave_and_demote_never_remove_both_active_channel_owners(db: PgPool) {
    let f = Fixture::start(&db).await;
    let peer = f.new_user(&db).await;
    for race in ["remove_leave", "remove_demote", "leave_demote"] {
        let channel = f.new_channel().await;
        f.join(&db, channel, &f.member, "owner").await;
        f.join(&db, channel, &peer, "owner").await;
        sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
            .bind(channel.to_string())
            .bind(f.admin.id.to_string())
            .execute(&db)
            .await
            .unwrap();
        let (first_token, first_method, first_path) = if race == "leave_demote" {
            (
                &f.member.token,
                Method::POST,
                format!("/channels/{channel}/leave"),
            )
        } else {
            (
                &f.admin.token,
                Method::DELETE,
                format!("/channels/{channel}/members/{}", f.member.id),
            )
        };
        let (second_token, second_method, second_path, second_body) = if race == "remove_leave" {
            (
                &peer.token,
                Method::POST,
                format!("/channels/{channel}/leave"),
                None,
            )
        } else {
            (
                &f.admin.token,
                Method::PATCH,
                format!("/channels/{channel}/members/{}", peer.id),
                Some(json!({"role":"member"})),
            )
        };
        let (first, second) = tokio::time::timeout(Duration::from_secs(15), async {
            tokio::join!(
                f.call(first_token, first_method, &first_path, None),
                f.call(second_token, second_method, &second_path, second_body)
            )
        })
        .await
        .expect("owner writers must serialize without deadlock");
        assert_eq!(
            usize::from(first.0.is_success()) + usize::from(second.0.is_success()),
            1,
            "{race}: {first:?} {second:?}"
        );
        for status in [first.0, second.0] {
            assert!(
                status.is_success()
                    || matches!(status, StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN),
                "{race}: {status}"
            );
        }
        let owners:i64=sqlx::query_scalar("SELECT COUNT(*) FROM channel_memberships WHERE channel_id=$1 AND member_type='user' AND role='owner'")
            .bind(channel.to_string()).fetch_one(&db).await.unwrap();
        assert_eq!(
            owners, 1,
            "{race}: one owner must survive both completed transactions"
        );
    }
}

#[sqlx::test]
async fn last_owner_dm_and_archived_contracts_do_not_clear_another_channels_authority(db: PgPool) {
    let f = Fixture::start(&db).await;
    let before = authority_snapshot(&db, f.channel, f.member.id).await;
    let (status, _) = f
        .call(
            &f.admin.token,
            Method::DELETE,
            &format!("/channels/{}/members/{}", f.channel, f.admin.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = f
        .call(
            &f.admin.token,
            Method::POST,
            &format!("/channels/{}/leave", f.channel),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let dm = server::domain::dms::open_dm(
        &db,
        server::domain::dms::Participant::User(f.admin.id),
        server::domain::dms::Participant::User(f.member.id),
    )
    .await
    .unwrap()
    .channel_id;
    let dm_before = authority_snapshot(&db, dm, f.member.id).await;
    let (status, _) = f
        .call(
            &f.member.token,
            Method::POST,
            &format!("/channels/{dm}/leave"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(authority_snapshot(&db, dm, f.member.id).await, dm_before);
    let archived = f.new_channel().await;
    sqlx::query("UPDATE channels SET archived_at=NOW() WHERE channel_id=$1")
        .bind(archived.to_string())
        .execute(&db)
        .await
        .unwrap();
    f.ok(
        &f.admin.token,
        Method::DELETE,
        &format!("/channels/{archived}/members/{}", f.admin.id),
        None,
    )
    .await;
    let owners: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM channel_memberships WHERE channel_id=$1 AND role='owner'",
    )
    .bind(archived.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        owners, 0,
        "an already archived channel retains its existing removal contract"
    );
    assert_eq!(
        authority_snapshot(&db, f.channel, f.member.id).await,
        before
    );
}

async fn wait_for_guard(db: &PgPool, blocker: i32) {
    tokio::time::timeout(Duration::from_secs(10),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(blocker).fetch_one(db).await.unwrap();
            if waiting {break;}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("the HTTP mutation must actually wait for the channel guard");
}

#[sqlx::test]
async fn an_admin_revoked_while_waiting_cannot_remove_or_change_another_member(db: PgPool) {
    let f = Fixture::start(&db).await;
    let target = f.new_user(&db).await;
    f.join(&db, f.channel, &target, "member").await;
    f.grant(&db, f.channel, target.id).await;
    for remove in [true, false] {
        sqlx::query(
            "UPDATE channel_memberships SET role='admin' WHERE channel_id=$1 AND member_id=$2",
        )
        .bind(f.channel.to_string())
        .bind(f.member.id.to_string())
        .execute(&db)
        .await
        .unwrap();
        let before = authority_snapshot(&db, f.channel, target.id).await;
        let mut blocker = db.begin().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *blocker)
            .await
            .unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(1128811842,hashtext($1))")
            .bind(f.channel.to_string())
            .execute(&mut *blocker)
            .await
            .unwrap();
        let (client, base, token, path) = (
            f.client.clone(),
            f.base.clone(),
            f.member.token.clone(),
            format!("/channels/{}/members/{}", f.channel, target.id),
        );
        let pending = tokio::spawn(async move {
            request(
                &client,
                &base,
                &token,
                if remove {
                    Method::DELETE
                } else {
                    Method::PATCH
                },
                &path,
                if remove {
                    None
                } else {
                    Some(json!({"role":"readonly"}))
                },
            )
            .await
        });
        wait_for_guard(&db, pid).await;
        sqlx::query(
            "UPDATE channel_memberships SET role='member' WHERE channel_id=$1 AND member_id=$2",
        )
        .bind(f.channel.to_string())
        .bind(f.member.id.to_string())
        .execute(&mut *blocker)
        .await
        .unwrap();
        blocker.commit().await.unwrap();
        let (status, body) = tokio::time::timeout(Duration::from_secs(10), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "remove={remove}: lock-wait authorization must be current: {body}"
        );
        assert_eq!(authority_snapshot(&db, f.channel, target.id).await, before);
    }
}

#[sqlx::test]
async fn workspace_detach_racing_owner_leave_preserves_live_channel_invariants_and_outside_access(
    db: PgPool,
) {
    let f = Fixture::start(&db).await;
    let peer = f.new_user(&db).await;
    f.join(&db, f.channel, &peer, "owner").await;
    sqlx::query("UPDATE channel_memberships SET role='owner' WHERE channel_id=$1 AND member_id=$2")
        .bind(f.channel.to_string())
        .bind(f.member.id.to_string())
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
        .bind(f.channel.to_string())
        .bind(f.admin.id.to_string())
        .execute(&db)
        .await
        .unwrap();
    let outside_workspace = f
        .ok(
            &f.admin.token,
            Method::POST,
            "/workspaces",
            Some(json!({"name":"Outside detach scope"})),
        )
        .await["workspace_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let outside_channel = f
        .ok(
            &f.admin.token,
            Method::POST,
            "/channels",
            Some(json!({"workspace_id":outside_workspace,"name":"outside"})),
        )
        .await["channel_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
        .bind(outside_workspace.to_string()).bind(f.member.id.to_string()).execute(&db).await.unwrap();
    f.join(&db, outside_channel, &f.member, "member").await;
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
        .bind(outside_channel.to_string()).bind(f.bot.to_string()).execute(&db).await.unwrap();
    f.grant(&db, outside_channel, f.member.id).await;
    let outside_before = authority_snapshot(&db, outside_channel, f.member.id).await;
    let channel_before = authority_snapshot(&db, f.channel, f.member.id).await;
    let other_before = authority_snapshot(&db, f.other_channel, f.member.id).await;
    let mut socket = f.subscribed().await;
    subscribe(&mut socket, outside_channel).await;
    let detach_path = format!("/workspaces/{}/members/{}", f.workspace, f.member.id);
    let leave_path = format!("/channels/{}/leave", f.channel);
    let (detach, leave) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(
            f.call(&f.admin.token, Method::DELETE, &detach_path, None),
            f.call(&peer.token, Method::POST, &leave_path, None)
        )
    })
    .await
    .expect("workspace/channel owner writers must share a deadlock-free guard order");
    assert_eq!(
        usize::from(detach.0.is_success()) + usize::from(leave.0.is_success()),
        1,
        "exactly one writer can remove an owner: {detach:?} {leave:?}"
    );
    for status in [detach.0, leave.0] {
        assert!(
            status.is_success() || status == StatusCode::FORBIDDEN,
            "the losing owner writer must reject without side effects: {detach:?} {leave:?}"
        );
    }
    let detached = detach.0.is_success();
    let valid:bool=sqlx::query_scalar("SELECT archived_at IS NULL AND (SELECT COUNT(*) FROM channel_memberships WHERE channel_id=$1 AND member_type='user' AND role='owner')=1 FROM channels WHERE channel_id=$1")
        .bind(f.channel.to_string()).fetch_one(&db).await.unwrap();
    assert!(
        valid,
        "the winning transaction must leave exactly one owner of the active channel"
    );
    for (channel, before) in [(f.channel, channel_before), (f.other_channel, other_before)] {
        let snapshot = authority_snapshot(&db, channel, f.member.id).await;
        let expected = if detached {
            json!({"membership":null,"invites":null,"delegations":null,"rules":null})
        } else {
            before
        };
        assert_eq!(
            snapshot, expected,
            "workspace cleanup must commit entirely or leave both channel scopes intact"
        );
        let (status, body) = f
            .call(
                &f.member.token,
                Method::GET,
                &format!("/channels/{channel}/messages"),
                None,
            )
            .await;
        assert_eq!(status.is_success(), !detached, "{status} {body}");
    }
    assert_eq!(
        authority_snapshot(&db, outside_channel, f.member.id).await,
        outside_before
    );
    // A successful detach cuts the workspace's subscriptions. A rejected one
    // leaves them intact. Both outcomes retain the same socket's outside scope.
    let candidate = f.post(f.other_channel).await;
    let sentinel = f.post(outside_channel).await;
    let mut observed = false;
    loop {
        let event = frame(&mut socket).await;
        if event["type"] == "message" && event["data"]["msg_id"] == candidate.to_string() {
            observed = true;
        }
        if event["type"] == "message" && event["data"]["msg_id"] == sentinel.to_string() {
            break;
        }
    }
    assert_eq!(
        observed, !detached,
        "the live subscription must match the committed workspace winner"
    );
    f.ok(
        &f.member.token,
        Method::GET,
        &format!("/channels/{outside_channel}/messages"),
        None,
    )
    .await;
}
