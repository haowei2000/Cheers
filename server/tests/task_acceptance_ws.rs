//! Standard task execution grants cross the real authenticated bridge and PG commit.
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

struct Bot {
    id: Uuid,
    credential: String,
}

struct Bridge {
    control: Socket,
    data: Socket,
}

struct Fixture {
    gateway: Option<gateway::TestGateway>,
    base: String,
    password: String,
    client: Client,
    token: String,
    user: Uuid,
    channel: Uuid,
    bot: Bot,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let password = Uuid::new_v4().to_string();
        let (gateway, base) =
            gateway::TestGateway::start(db, "task-acceptance-admin", &password).await;
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let response = client
            .post(format!("{base}/api/v1/auth/login"))
            .json(&json!({"login":"task-acceptance-admin","password":password}))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let auth: Value = response.json().await.unwrap();
        let mut fixture = Self {
            gateway: Some(gateway),
            base,
            password,
            client,
            token: auth["access_token"].as_str().unwrap().to_string(),
            user: auth["user_id"].as_str().unwrap().parse().unwrap(),
            channel: Uuid::nil(),
            bot: Bot {
                id: Uuid::nil(),
                credential: String::new(),
            },
        };
        let workspace = fixture
            .post("/workspaces", json!({"name":"Task acceptance"}))
            .await;
        let channel = fixture
            .post(
                "/channels",
                json!({"workspace_id":workspace["workspace_id"],"name":"receipts"}),
            )
            .await;
        fixture.channel = channel["channel_id"].as_str().unwrap().parse().unwrap();
        fixture.bot = fixture.seed_bot(db).await;
        fixture
    }

    async fn post(&self, path: &str, body: Value) -> Value {
        let response = self
            .client
            .post(format!("{}/api/v1{path}", self.base))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert!(status.is_success(), "{status}: {body}");
        body
    }

    async fn seed_bot(&self, db: &PgPool) -> Bot {
        let id = Uuid::new_v4();
        let host = Uuid::new_v4();
        let credential = server::infra::crypto::generate_host_credential();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor,binding_config) VALUES($1,$2,$3,FALSE,$4)")
            .bind(id.to_string())
            .bind(format!("acceptance-{id}"))
            .bind(self.user.to_string())
            .bind(json!({"acp_security":{"require_capability":false}}))
            .execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
            .bind(self.channel.to_string()).bind(id.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO connector_hosts(host_id,bot_id,device_name,status,credential_hash) VALUES($1,$2,'Receipt fixture','active',$3)")
            .bind(host.to_string()).bind(id.to_string())
            .bind(server::infra::crypto::hash_host_credential(&credential))
            .execute(db).await.unwrap();
        Bot { id, credential }
    }

    async fn socket(&self, bot: &Bot, stream: &str) -> Socket {
        let url = format!(
            "{}/ws/agent-bridge/{stream}",
            self.base.replacen("http:", "ws:", 1)
        );
        let (mut socket, _) = connect_async(url).await.unwrap();
        send(
            &mut socket,
            json!({"type":"auth","token":bot.credential,"bridge_protocol_version":1}),
        )
        .await;
        let hello = next_type(&mut socket, "hello").await;
        assert_eq!(hello["bot_id"], bot.id.to_string());
        socket
    }

    async fn bridge(&self, acceptance: bool) -> Bridge {
        let mut control = self.socket(&self.bot, "control").await;
        let data = self.socket(&self.bot, "data").await;
        ready(&mut control, acceptance).await;
        Bridge { control, data }
    }

    async fn dispatch(&self, control: &mut Socket) -> Value {
        self.post(
            &format!("/channels/{}/messages", self.channel),
            json!({"content":"A durable execution grant","mention_ids":[self.bot.id]}),
        )
        .await;
        let task = next_type(control, "task").await;
        assert_eq!(task["channel_id"], self.channel.to_string());
        assert_eq!(task["acceptance_required"], true);
        task
    }

    async fn restart(&mut self, db: &PgPool) {
        drop(self.gateway.take());
        let (gateway, base) =
            gateway::TestGateway::start(db, "task-acceptance-admin", &self.password).await;
        self.gateway = Some(gateway);
        self.base = base;
    }
}

async fn send(socket: &mut Socket, frame: Value) {
    socket.send(Message::Text(frame.to_string())).await.unwrap();
}

async fn next_type(socket: &mut Socket, expected: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket
                .next()
                .await
                .expect("bridge must remain open")
                .unwrap()
            {
                Message::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    if frame["type"] == expected {
                        return frame;
                    }
                }
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                Message::Close(reason) => panic!("bridge closed: {reason:?}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("expected bridge frame {expected}"))
}

/// Ready and subsequent dispatch are ordered by the control loop, rather than a sleep.
async fn ready(control: &mut Socket, acceptance: bool) {
    send(
        control,
        json!({"type":"ready","v":1,"connector_capabilities":{"task_acceptance":acceptance}}),
    )
    .await;
    assert_no_task_before_pong(control).await;
}

async fn assert_no_task_before_pong(control: &mut Socket) {
    let barrier = Uuid::new_v4().as_bytes().to_vec();
    control.send(Message::Ping(barrier.clone())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match control.next().await.expect("control remains open").unwrap() {
                Message::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    assert_ne!(frame["type"], "task", "unexpected task delivery: {frame}");
                }
                Message::Ping(bytes) => control.send(Message::Pong(bytes)).await.unwrap(),
                Message::Pong(bytes) if bytes == barrier => return,
                Message::Close(reason) => panic!("control closed: {reason:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("control ping must confirm the preceding operation completed");
}

fn acceptance(task: &Value, execution: Uuid) -> Value {
    json!({"type":"task_accept","v":1,"task_id":task["task_id"],
        "placeholder_msg_id":task["placeholder_msg_id"],"channel_id":task["channel_id"],
        "execution_id":execution})
}

async fn accept(control: &mut Socket, request: Value, expected: &str) -> Value {
    send(control, request.clone()).await;
    let response = next_type(control, "task_acceptance").await;
    assert_eq!(response["v"], 1);
    for id in [
        "task_id",
        "placeholder_msg_id",
        "channel_id",
        "execution_id",
    ] {
        assert_eq!(response[id], request[id], "mismatched acceptance {id}");
    }
    assert_eq!(response["status"], expected, "{response}");
    response
}

async fn ledger(db: &PgPool, task: &Value) -> Value {
    sqlx::query_scalar("SELECT to_jsonb(run) FROM bot_runs AS run WHERE task_id=$1")
        .bind(task["task_id"].as_str().unwrap())
        .fetch_one(db)
        .await
        .unwrap()
}

#[sqlx::test]
async fn dispatched_task_requires_one_durable_execution_owner_before_completion(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    assert!(ledger(&db, &task).await["execution_id"].is_null());
    let execution = Uuid::new_v4();
    let request = acceptance(&task, execution);
    accept(&mut bridge.control, request.clone(), "granted").await;
    let row = ledger(&db, &task).await;
    assert_eq!(row["execution_id"], execution.to_string());
    assert!(row["execution_connection_id"].is_string());
    assert!(row["accepted_at"].is_string());
    // A lost response can be confirmed by the same execution, while a new
    // connector attempt must not gain a second permission to prompt ACP.
    accept(&mut bridge.control, request.clone(), "granted").await;
    accept(
        &mut bridge.control,
        acceptance(&task, Uuid::new_v4()),
        "owned",
    )
    .await;
    assert_eq!(
        ledger(&db, &task).await["execution_id"],
        row["execution_id"]
    );

    let client_msg_id = Uuid::new_v4();
    send(&mut bridge.data, json!({"type":"done","v":1,"client_msg_id":client_msg_id,"msg_id":task["placeholder_msg_id"],"content":"Completed once"})).await;
    let ack = next_type(&mut bridge.data, "terminal_ack").await;
    assert_eq!(ack["client_msg_id"], client_msg_id.to_string());
    assert_eq!(ack["ok"], true, "{ack}");
    accept(&mut bridge.control, request, "rejected").await;
    let completed: (bool, String) =
        sqlx::query_as("SELECT is_partial,content FROM messages WHERE msg_id=$1")
            .bind(task["placeholder_msg_id"].as_str().unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(completed, (false, "Completed once".into()));
}

#[sqlx::test]
async fn forged_task_identity_and_other_bots_cannot_consume_an_execution_grant(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    for field in ["task_id", "placeholder_msg_id", "channel_id"] {
        let mut forged = acceptance(&task, Uuid::new_v4());
        forged[field] = json!(Uuid::new_v4());
        accept(&mut bridge.control, forged, "rejected").await;
    }
    let peer = fixture.seed_bot(&db).await;
    let mut peer_control = fixture.socket(&peer, "control").await;
    ready(&mut peer_control, true).await;
    accept(
        &mut peer_control,
        acceptance(&task, Uuid::new_v4()),
        "rejected",
    )
    .await;
    assert!(ledger(&db, &task).await["execution_id"].is_null());
    accept(
        &mut bridge.control,
        acceptance(&task, Uuid::new_v4()),
        "granted",
    )
    .await;
}

#[sqlx::test]
async fn a_failed_claim_commit_never_returns_a_grant_and_can_be_retried(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    sqlx::raw_sql("CREATE FUNCTION reject_task_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected acceptance commit failure'; END $$; CREATE CONSTRAINT TRIGGER reject_task_acceptance AFTER UPDATE ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.execution_id IS NULL AND NEW.execution_id IS NOT NULL) EXECUTE FUNCTION reject_task_acceptance()")
        .execute(&db).await.unwrap();
    let request = acceptance(&task, Uuid::new_v4());
    accept(&mut bridge.control, request.clone(), "rejected").await;
    assert!(ledger(&db, &task).await["execution_id"].is_null());
    sqlx::raw_sql(
        "DROP TRIGGER reject_task_acceptance ON bot_runs; DROP FUNCTION reject_task_acceptance()",
    )
    .execute(&db)
    .await
    .unwrap();
    accept(&mut bridge.control, request.clone(), "granted").await;
    assert_eq!(
        ledger(&db, &task).await["execution_id"],
        request["execution_id"]
    );
}

#[sqlx::test]
async fn reconnect_and_gateway_restart_cannot_reuse_a_previous_connections_grant(db: PgPool) {
    let mut fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    drop(bridge);
    let mut reconnected = fixture.bridge(true).await;
    for attempt in [execution, Uuid::new_v4()] {
        accept(
            &mut reconnected.control,
            acceptance(&task, attempt),
            "owned",
        )
        .await;
    }
    drop(reconnected);
    fixture.restart(&db).await;
    let mut restarted = fixture.bridge(true).await;
    // A persisted owner remains fenced even when the process registry is empty.
    for attempt in [execution, Uuid::new_v4()] {
        accept(&mut restarted.control, acceptance(&task, attempt), "owned").await;
    }
    assert_eq!(
        ledger(&db, &task).await["execution_id"],
        execution.to_string()
    );
}

#[sqlx::test]
async fn a_connector_without_acceptance_capability_is_not_sent_standard_tasks(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(false).await;
    const CHANNEL_STATE: &str = "SELECT next_seq,(SELECT COUNT(*) FROM messages WHERE channel_id=$1 AND sender_type='user') FROM channels WHERE channel_id=$1";
    let before: (i64, i64) = sqlx::query_as(CHANNEL_STATE)
        .bind(fixture.channel.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    let response = fixture.client
        .post(format!("{}/api/v1/channels/{}/messages", fixture.base, fixture.channel))
        .bearer_auth(&fixture.token)
        .json(&json!({"content":"This connector cannot obtain a grant","mention_ids":[fixture.bot.id]}))
        .send()
        .await;
    let response = response.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let error: Value = response.json().await.unwrap();
    assert!(
        error.to_string().contains("not ready to accept tasks"),
        "{error}"
    );
    let after: (i64, i64) = sqlx::query_as(CHANNEL_STATE)
        .bind(fixture.channel.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        after, before,
        "rejected requests cannot persist or consume a sequence"
    );
    assert_no_task_before_pong(&mut bridge.control).await;
    let partials: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE sender_id=$1 AND is_partial=TRUE")
            .bind(fixture.bot.id.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        partials, 0,
        "an unsupported connector must not gain a live turn"
    );
    ready(&mut bridge.control, true).await;
    fixture.dispatch(&mut bridge.control).await;
}
