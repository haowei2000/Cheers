//! Execution grants and terminal receipts cross the real authenticated bridge and PG commit.
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
    ready_capabilities(control, acceptance, true).await;
}

async fn ready_capabilities(control: &mut Socket, acceptance: bool, replay: bool) {
    send(
        control,
        json!({"type":"ready","v":1,"connector_capabilities":{"task_acceptance":acceptance,"terminal_replay":replay}}),
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

fn terminal(task: &Value, execution: Uuid, client_msg_id: Uuid, content: &str) -> Value {
    json!({"type":"done","v":1,"client_msg_id":client_msg_id,
        "msg_id":task["placeholder_msg_id"],"content":content,
        "execution":{"task_id":task["task_id"],"execution_id":execution,
            "channel_id":task["channel_id"]},
        "provider_session_key":task["provider_session_key"],"session_id":task["session_id"]})
}

async fn terminal_ack(data: &mut Socket, frame: &Value) -> Value {
    send(data, frame.clone()).await;
    let ack = next_type(data, "terminal_ack").await;
    assert_eq!(ack["client_msg_id"], frame["client_msg_id"]);
    if ack["ok"] == true {
        assert_eq!(ack["msg_id"], frame["msg_id"]);
    }
    ack
}

fn assert_terminal_rejection(ack: &Value, code: &str, retryable: bool) {
    assert_eq!(ack["ok"], false, "{ack}");
    assert_eq!(ack["code"], code, "{ack}");
    assert_eq!(ack["retryable"], retryable, "{ack}");
}

async fn partial_and_clock(db: &PgPool, task: &Value) -> (bool, i64) {
    sqlx::query_as("SELECT m.is_partial,c.next_seq FROM messages m JOIN channels c ON c.channel_id=m.channel_id WHERE m.msg_id=$1")
        .bind(task["placeholder_msg_id"].as_str().unwrap())
        .fetch_one(db).await.unwrap()
}

async fn wait_for_terminal_commit(db: &PgPool, task: &Value) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !partial_and_clock(db, task).await.0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the result must commit even when its ACK is not read");
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
    let ack = terminal_ack(
        &mut bridge.data,
        &terminal(&task, execution, client_msg_id, "Completed once"),
    )
    .await;
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
    for (acceptance, replay) in [(false, true), (true, false)] {
        ready_capabilities(&mut bridge.control, acceptance, replay).await;
        let response = fixture.client
            .post(format!("{}/api/v1/channels/{}/messages", fixture.base, fixture.channel))
            .bearer_auth(&fixture.token)
            .json(&json!({"content":"This connector cannot obtain a grant","mention_ids":[fixture.bot.id]}))
            .send()
            .await.unwrap();
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
    }
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

#[sqlx::test]
async fn lost_terminal_ack_can_be_replayed_after_reconnect_and_gateway_restart(db: PgPool) {
    let mut fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let result = terminal(&task, execution, Uuid::new_v4(), "Durable result");
    // Deliberately discard the ACK after observing the real database commit.
    send(&mut bridge.data, result.clone()).await;
    wait_for_terminal_commit(&db, &task).await;
    let committed = partial_and_clock(&db, &task).await;
    drop(bridge);

    let mut reconnected = fixture.bridge(true).await;
    assert_eq!(
        terminal_ack(&mut reconnected.data, &result).await["ok"],
        true
    );
    assert_eq!(partial_and_clock(&db, &task).await, committed);
    drop(reconnected);
    fixture.restart(&db).await;
    let mut restarted = fixture.bridge(true).await;
    assert_eq!(terminal_ack(&mut restarted.data, &result).await["ok"], true);
    assert_eq!(partial_and_clock(&db, &task).await, committed);
}

#[sqlx::test]
async fn a_live_accepted_execution_can_finish_after_its_control_connection_is_replaced(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut original = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut original.control).await;
    let execution = Uuid::new_v4();
    accept(
        &mut original.control,
        acceptance(&task, execution),
        "granted",
    )
    .await;
    drop(original);

    let mut reconnected = fixture.bridge(true).await;
    accept(
        &mut reconnected.control,
        acceptance(&task, execution),
        "owned",
    )
    .await;
    // Completion carries the original grant, although no new execution is allowed.
    let result = terminal(&task, execution, Uuid::new_v4(), "Finished after reconnect");
    let ack = terminal_ack(&mut reconnected.data, &result).await;
    assert_eq!(ack["ok"], true, "{ack}");
    assert!(!partial_and_clock(&db, &task).await.0);
    assert_eq!(
        ledger(&db, &task).await["execution_id"],
        execution.to_string()
    );
}

#[sqlx::test]
async fn committed_terminal_receipt_rejects_changed_content_kind_and_client_identity(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let result = terminal(&task, execution, Uuid::new_v4(), "Immutable result");
    assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);
    let committed = partial_and_clock(&db, &task).await;
    let mut content = result.clone();
    content["content"] = json!("Changed result");
    let mut kind = result.clone();
    kind["type"] = json!("error");
    kind["message"] = kind["content"].take();
    kind.as_object_mut().unwrap().remove("content");
    let mut client = result.clone();
    client["client_msg_id"] = json!(Uuid::new_v4());
    let mut mentions = result.clone();
    mentions["mention_ids"] = json!([fixture.user]);
    for changed in [content, kind, client, mentions] {
        let ack = terminal_ack(&mut bridge.data, &changed).await;
        assert_terminal_rejection(&ack, "TERMINAL_CONFLICT", false);
        assert_eq!(partial_and_clock(&db, &task).await, committed);
    }
    assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);
}

#[sqlx::test]
async fn wrong_execution_tuple_or_authenticated_bot_cannot_commit_another_result(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let result = terminal(
        &task,
        execution,
        Uuid::new_v4(),
        "Only this owner can finish",
    );
    let before = partial_and_clock(&db, &task).await;
    for field in ["task_id", "execution_id", "channel_id"] {
        let mut forged = result.clone();
        forged["execution"][field] = json!(Uuid::new_v4());
        let ack = terminal_ack(&mut bridge.data, &forged).await;
        assert_terminal_rejection(&ack, "TERMINAL_FORBIDDEN", false);
    }
    let mut missing = result.clone();
    missing.as_object_mut().unwrap().remove("execution");
    let ack = terminal_ack(&mut bridge.data, &missing).await;
    assert_terminal_rejection(&ack, "INVALID_FRAME", false);
    let peer = fixture.seed_bot(&db).await;
    let mut peer_data = fixture.socket(&peer, "data").await;
    let ack = terminal_ack(&mut peer_data, &result).await;
    assert_terminal_rejection(&ack, "TERMINAL_FORBIDDEN", false);
    assert_eq!(partial_and_clock(&db, &task).await, before);
    assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);
}

#[sqlx::test]
async fn a_reclaimed_placeholder_cannot_be_recreated_by_terminal_delivery(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let result = terminal(
        &task,
        execution,
        Uuid::new_v4(),
        "Too late to restore the turn",
    );
    let clock = partial_and_clock(&db, &task).await.1;
    sqlx::query("DELETE FROM messages WHERE msg_id=$1")
        .bind(task["placeholder_msg_id"].as_str().unwrap())
        .execute(&db)
        .await
        .unwrap();
    let ack = terminal_ack(&mut bridge.data, &result).await;
    assert_terminal_rejection(&ack, "TERMINAL_GONE", false);
    let mut unknown = result.clone();
    unknown["msg_id"] = json!(Uuid::new_v4());
    let ack = terminal_ack(&mut bridge.data, &unknown).await;
    assert_terminal_rejection(&ack, "TERMINAL_GONE", false);
    let after: (i64, bool) = sqlx::query_as("SELECT next_seq,EXISTS(SELECT 1 FROM messages WHERE msg_id=$2) FROM channels WHERE channel_id=$1")
        .bind(fixture.channel.to_string()).bind(task["placeholder_msg_id"].as_str().unwrap())
        .fetch_one(&db).await.unwrap();
    assert_eq!(after, (clock, false));
    assert_eq!(
        ledger(&db, &task).await["execution_id"],
        execution.to_string()
    );
}

#[sqlx::test]
async fn first_terminal_result_rechecks_role_but_replay_does_not_touch_a_new_busy_session(
    db: PgPool,
) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let result = terminal(&task, execution, Uuid::new_v4(), "Authorized completion");
    let before = partial_and_clock(&db, &task).await;
    sqlx::query(
        "UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(fixture.channel.to_string())
    .bind(fixture.bot.id.to_string())
    .execute(&db)
    .await
    .unwrap();
    let ack = terminal_ack(&mut bridge.data, &result).await;
    assert_terminal_rejection(&ack, "TERMINAL_FORBIDDEN", false);
    assert_eq!(partial_and_clock(&db, &task).await, before);

    sqlx::query(
        "UPDATE channel_memberships SET role='member' WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(fixture.channel.to_string())
    .bind(fixture.bot.id.to_string())
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);

    let session = task["session_id"]
        .as_str()
        .expect("HTTP dispatch binds a primary session");
    // A newer task could now own this session. An old receipt must be ACK-only.
    sqlx::query("UPDATE cheers_sessions SET status='busy' WHERE session_id=$1")
        .bind(session)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
        .bind(fixture.channel.to_string())
        .bind(fixture.bot.id.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);
    let status: String =
        sqlx::query_scalar("SELECT status FROM cheers_sessions WHERE session_id=$1")
            .bind(session)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(status, "busy", "receipt replay must not idle a newer turn");
}

#[sqlx::test]
async fn terminal_receipt_commit_failure_returns_retryable_ack_and_rolls_back_the_message(
    db: PgPool,
) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let result = terminal(
        &task,
        execution,
        Uuid::new_v4(),
        "Commit result and receipt together",
    );
    let before = partial_and_clock(&db, &task).await;
    sqlx::raw_sql("CREATE FUNCTION reject_terminal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected terminal receipt commit failure'; END $$; CREATE CONSTRAINT TRIGGER reject_terminal_receipt AFTER UPDATE ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.terminal_client_msg_id IS NULL AND NEW.terminal_client_msg_id IS NOT NULL) EXECUTE FUNCTION reject_terminal_receipt()")
        .execute(&db).await.unwrap();
    let ack = terminal_ack(&mut bridge.data, &result).await;
    assert_terminal_rejection(&ack, "INTERNAL_ERROR", true);
    assert_eq!(partial_and_clock(&db, &task).await, before);
    assert!(ledger(&db, &task).await["terminal_client_msg_id"].is_null());
    sqlx::raw_sql(
        "DROP TRIGGER reject_terminal_receipt ON bot_runs; DROP FUNCTION reject_terminal_receipt()",
    )
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);
    let committed = partial_and_clock(&db, &task).await;
    assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);
    assert_eq!(partial_and_clock(&db, &task).await, committed);
}

#[sqlx::test]
async fn error_results_require_capability_authorization_and_keep_their_kind_during_replay(
    db: PgPool,
) {
    let fixture = Fixture::start(&db).await;
    sqlx::query("UPDATE bot_accounts SET binding_config=jsonb_set(binding_config,'{acp_security,require_capability}','true') WHERE bot_id=$1")
        .bind(fixture.bot.id.to_string()).execute(&db).await.unwrap();
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let mut result = terminal(&task, execution, Uuid::new_v4(), "Agent failed safely");
    result["type"] = json!("error");
    result["message"] = result["content"].take();
    result.as_object_mut().unwrap().remove("content");
    let before = partial_and_clock(&db, &task).await;
    let ack = terminal_ack(&mut bridge.data, &result).await;
    assert_terminal_rejection(&ack, "TERMINAL_FORBIDDEN", false);
    assert_eq!(partial_and_clock(&db, &task).await, before);

    // Legacy aliases must not route an execution-owned result around capability checks.
    let mut reply = result.clone();
    reply["type"] = json!("reply");
    reply["text"] = reply["message"].take();
    reply.as_object_mut().unwrap().remove("message");
    send(&mut bridge.data, reply.clone()).await;
    let rejected = next_type(&mut bridge.data, "send_ack").await;
    assert_eq!(rejected["client_msg_id"], reply["client_msg_id"]);
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["code"], "INVALID_FRAME");
    reply.as_object_mut().unwrap().remove("execution");
    send(&mut bridge.data, reply).await;
    let rejected = next_type(&mut bridge.data, "send_ack").await;
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["code"], "REPLY_REJECTED");
    assert_eq!(partial_and_clock(&db, &task).await, before);

    // Disabling the opt-in capability requirement takes effect on a newly
    // authenticated connection; the original granted execution stays the owner.
    sqlx::query("UPDATE bot_accounts SET binding_config=jsonb_set(binding_config,'{acp_security,require_capability}','false') WHERE bot_id=$1")
        .bind(fixture.bot.id.to_string()).execute(&db).await.unwrap();
    drop(bridge);
    let mut reconnected = fixture.bridge(true).await;
    assert_eq!(
        terminal_ack(&mut reconnected.data, &result).await["ok"],
        true
    );
    assert_eq!(
        terminal_ack(&mut reconnected.data, &result).await["ok"],
        true
    );
    let mut kind = result.clone();
    kind["type"] = json!("done");
    kind["content"] = kind["message"].take();
    kind.as_object_mut().unwrap().remove("message");
    let ack = terminal_ack(&mut reconnected.data, &kind).await;
    assert_terminal_rejection(&ack, "TERMINAL_CONFLICT", false);
}
