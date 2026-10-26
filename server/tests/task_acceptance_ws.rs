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
    host: Uuid,
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
            .timeout(Duration::from_secs(20))
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
                host: Uuid::nil(),
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

    async fn mcp_post(&self, arguments: Value) -> Value {
        // Exchange the host credential against the current process's keys, so
        // the same authenticated command can be retried after a gateway restart.
        let metadata: Value = self
            .client
            .get(format!(
                "{}/.well-known/oauth-protected-resource/mcp",
                self.base
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let response = self.client.post(format!("{}/oauth/token", self.base)).json(&json!({
            "grant_type":"client_credentials","client_id":self.bot.host,"client_secret":self.bot.credential,
            "resource":metadata["resource"],"scope":"cheers:read cheers:messages:write","cheers_channel":self.channel,
        })).send().await.unwrap();
        let status = response.status();
        let token: Value = response.json().await.unwrap();
        assert!(status.is_success(), "{status}: {token}");
        let response = self.client.post(format!("{}/mcp", self.base))
            .bearer_auth(token["access_token"].as_str().unwrap())
            .header("MCP-Protocol-Version", "2025-11-25").header("Accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":Uuid::new_v4(),"method":"tools/call","params":{"name":"post_message","arguments":arguments}}))
            .send().await.unwrap();
        let status = response.status();
        let rpc: Value = response.json().await.unwrap();
        assert!(status.is_success(), "{status}: {rpc}");
        assert_eq!(rpc["result"]["isError"], false, "{rpc}");
        rpc["result"]["structuredContent"].clone()
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
        Bot {
            id,
            host,
            credential,
        }
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

    /// Recovery may offer immediately after Ready, before its Pong barrier.
    /// Unlike a fresh admission fixture, receiving that offer is expected here.
    async fn recovering_bridge(&self) -> Bridge {
        self.recovering_bot_bridge(&self.bot).await
    }

    async fn recovering_bot_bridge(&self, bot: &Bot) -> Bridge {
        let mut control = self.socket(bot, "control").await;
        let data = self.socket(bot, "data").await;
        send(
            &mut control,
            json!({"type":"ready","v":1,"connector_capabilities":{
            "task_acceptance":true,"terminal_replay":true}}),
        )
        .await;
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
    next_type_with_timeout(socket, expected, Duration::from_secs(10)).await
}

async fn next_recovered_task(socket: &mut Socket) -> Value {
    // Startup can first observe the connector offline. Recovery then combines
    // a five-second retry delay with a five-second polling loop; allow two
    // recovery windows while retaining the normal protocol deadline above.
    next_type_with_timeout(socket, "task", Duration::from_secs(20)).await
}

async fn next_type_with_timeout(socket: &mut Socket, expected: &str, timeout: Duration) -> Value {
    tokio::time::timeout(timeout, async {
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

async fn assert_no_task_for(control: &mut Socket, duration: Duration) {
    let result = tokio::time::timeout(duration, async {
        loop {
            match control.next().await.expect("control remains open").unwrap() {
                Message::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    assert_ne!(
                        frame["type"], "task",
                        "an accepted task was offered again: {frame}"
                    );
                }
                Message::Ping(bytes) => control.send(Message::Pong(bytes)).await.unwrap(),
                Message::Close(reason) => panic!("control closed: {reason:?}"),
                _ => {}
            }
        }
    })
    .await;
    assert!(result.is_err(), "the observation interval must complete");
}

async fn age_unaccepted_intent(db: &PgPool, task: &Value) {
    sqlx::query("UPDATE bot_runs SET created_at=NOW()-INTERVAL '1 day',updated_at=NOW()-INTERVAL '1 day',next_offer_at=NOW()-INTERVAL '1 second',dispatch_lease_id=NULL,dispatch_lease_until=NULL WHERE task_id=$1")
        .bind(task["task_id"].as_str().unwrap()).execute(db).await.unwrap();
    sqlx::query("UPDATE messages SET created_at=NOW()-INTERVAL '1 day' WHERE msg_id=$1")
        .bind(task["placeholder_msg_id"].as_str().unwrap())
        .execute(db)
        .await
        .unwrap();
}

#[sqlx::test]
async fn real_startup_preserves_old_unaccepted_work_and_reoffers_the_exact_frozen_task(db: PgPool) {
    let mut fixture = Fixture::start(&db).await;
    let session = server::domain::sessions::ensure_primary_session_workspace(
        &db,
        fixture.bot.id,
        &fixture.bot.id.to_string(),
        &fixture.channel.to_string(),
        Some("/original-workspace"),
        &[],
    )
    .await
    .unwrap();
    sqlx::query("UPDATE cheers_sessions SET metadata=metadata || $2 WHERE session_id=$1")
        .bind(session.session_id.to_string())
        .bind(json!({"session_config":{"config_options":{"model":"original-model"}}}))
        .execute(&db)
        .await
        .unwrap();
    let mut bridge = fixture.bridge(true).await;
    let reference = json!({"verb":"channel.info","params":{"channel_id":fixture.channel},
        "label":"Original reference","preview":{"text":"Never persist this inline body"}});
    fixture
        .post(
            &format!("/channels/{}/messages", fixture.channel),
            json!({
        "content":"The frozen human instruction","mention_ids":[fixture.bot.id],
        "context_bundle":{"origin":"spoofed","items":[reference]}}),
        )
        .await;
    let original = next_type(&mut bridge.control, "task").await;
    assert_eq!(
        original["trigger_message"]["text"],
        "The frozen human instruction"
    );
    assert_eq!(original["cwd"], "/original-workspace");
    assert_eq!(
        original["session_config"]["config_options"]["model"],
        "original-model"
    );
    assert_eq!(original["context_bundle"]["origin"], "human");
    assert!(original["context_bundle"]["items"][0]
        .get("preview")
        .is_none());
    assert!(!ledger(&db, &original)
        .await
        .to_string()
        .contains("Never persist this inline body"));
    assert_eq!(ledger(&db, &original).await["task_frame"], original);

    drop(fixture.gateway.take());
    drop(bridge);
    age_unaccepted_intent(&db, &original).await;
    sqlx::query("UPDATE messages SET content='A later edit must not replace admitted work',context_bundle=NULL WHERE msg_id=$1")
        .bind(original["trigger_msg_id"].as_str().unwrap()).execute(&db).await.unwrap();
    sqlx::query("UPDATE cheers_sessions SET metadata=$2 WHERE session_id=$1")
        .bind(session.session_id.to_string())
        .bind(json!({"workspace":{"cwd":"/later-workspace"},"session_config":{"config_options":{"model":"later-model"}}}))
        .execute(&db).await.unwrap();
    fixture.restart(&db).await;
    let mut restarted = fixture.recovering_bridge().await;
    let recovered = next_recovered_task(&mut restarted.control).await;
    // This goes through main's actual startup worker and orphan reclaimer. No
    // test calls recover_once, so missing production wiring cannot pass.
    assert_eq!(recovered, original);
    let partial: bool = sqlx::query_scalar("SELECT is_partial FROM messages WHERE msg_id=$1")
        .bind(original["placeholder_msg_id"].as_str().unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert!(
        partial,
        "the startup orphan scan must preserve recoverable work regardless of age"
    );

    let execution = Uuid::new_v4();
    accept(
        &mut restarted.control,
        acceptance(&recovered, execution),
        "granted",
    )
    .await;
    let accepted = ledger(&db, &recovered).await;
    assert!(
        accepted["dispatch_input"].is_null(),
        "acceptance releases retained input"
    );
    assert!(
        accepted["task_frame"].is_null(),
        "acceptance releases the frozen payload"
    );
    // Make recovery immediately eligible by time alone; accepted ownership must
    // still exclude it on every worker pass after a real process restart.
    drop(fixture.gateway.take());
    drop(restarted);
    sqlx::query("UPDATE bot_runs SET next_offer_at=NOW()-INTERVAL '1 day' WHERE task_id=$1")
        .bind(original["task_id"].as_str().unwrap())
        .execute(&db)
        .await
        .unwrap();
    // Keep accepted work within the normal orphan grace. It is not a recoverable
    // offer and retains the existing terminal-result/reclamation contract.
    sqlx::query("UPDATE messages SET created_at=NOW() WHERE msg_id=$1")
        .bind(original["placeholder_msg_id"].as_str().unwrap())
        .execute(&db)
        .await
        .unwrap();
    fixture.restart(&db).await;
    let mut accepted_restart = fixture.recovering_bridge().await;
    assert_no_task_for(&mut accepted_restart.control, Duration::from_secs(7)).await;
    accept(
        &mut accepted_restart.control,
        acceptance(&original, execution),
        "owned",
    )
    .await;
    accept(
        &mut accepted_restart.control,
        acceptance(&original, Uuid::new_v4()),
        "owned",
    )
    .await;
}

#[sqlx::test]
async fn a_process_crash_after_human_commit_recovers_the_pending_input_without_a_second_message(
    db: PgPool,
) {
    let mut fixture = Fixture::start(&db).await;
    let bridge = fixture.bridge(true).await;
    // Stop the first preparation at an actual database await after admission.
    // Killing the gateway here tests its production recovery startup rather
    // than relying on client disconnect to cancel an HTTP handler.
    let lock_key: i64 = 6_742_019;
    let mut blocker = db.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(lock_key)
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE FUNCTION pause_preparation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.task_frame IS NULL AND NEW.task_frame IS NOT NULL THEN PERFORM pg_advisory_xact_lock({lock_key}::bigint); END IF; RETURN NEW; END $$"))
        .execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER pause_preparation BEFORE UPDATE ON bot_runs FOR EACH ROW EXECUTE FUNCTION pause_preparation()")
        .execute(&db).await.unwrap();
    let request = {
        let client = fixture.client.clone();
        let endpoint = format!(
            "{}/api/v1/channels/{}/messages",
            fixture.base, fixture.channel
        );
        let token = fixture.token.clone();
        let bot = fixture.bot.id;
        tokio::spawn(async move {
            client
                .post(endpoint)
                .bearer_auth(token)
                .json(&json!({
                "content":"Committed before the process disappeared","mention_ids":[bot]}))
                .send()
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted AND objid=$1::bigint::oid)")
                .bind(lock_key).fetch_one(&db).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("preparation must reach the injected postcommit barrier");
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE channel_id=$1")
            .bind(fixture.channel.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(before["status"], "pending");
    assert!(before["task_frame"].is_null());
    assert!(before["dispatch_input"].is_object());
    assert_eq!(
        before["dispatch_input"]["trigger_message"]["text"],
        "Committed before the process disappeared"
    );
    drop(fixture.gateway.take());
    drop(bridge);
    let _ = request.await;
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(lock_key)
        .execute(&mut *blocker)
        .await
        .unwrap();
    drop(blocker);
    sqlx::query("DROP TRIGGER pause_preparation ON bot_runs")
        .execute(&db)
        .await
        .unwrap();
    let identity =
        json!({"task_id":before["task_id"],"placeholder_msg_id":before["placeholder_msg_id"]});
    age_unaccepted_intent(&db, &identity).await;
    fixture.restart(&db).await;
    let mut recovered = fixture.recovering_bridge().await;
    let task = next_recovered_task(&mut recovered.control).await;
    assert_eq!(task["task_id"], before["task_id"]);
    assert_eq!(task["placeholder_msg_id"], before["placeholder_msg_id"]);
    assert_eq!(
        task["trigger_message"]["text"],
        "Committed before the process disappeared"
    );
    let humans: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id=$1 AND sender_type='user'",
    )
    .bind(fixture.channel.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        humans, 1,
        "recovery delivers the committed message's offer without posting the human twice"
    );
    accept(
        &mut recovered.control,
        acceptance(&task, Uuid::new_v4()),
        "granted",
    )
    .await;
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
async fn terminal_results_require_execution_but_protocol_errors_are_not_results(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let result = terminal(&task, execution, Uuid::new_v4(), "Granted completion");
    let before = partial_and_clock(&db, &task).await;

    // An unscoped connector diagnostic has no result/receipt identity. The Pong
    // confirms it was handled without accidentally answering with a terminal ACK.
    send(
        &mut bridge.data,
        json!({"type":"error","v":1,"client_msg_id":Uuid::new_v4(),
            "message":"connector protocol diagnostic"}),
    )
    .await;
    let barrier = Uuid::new_v4().as_bytes().to_vec();
    bridge
        .data
        .send(Message::Ping(barrier.clone()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match bridge
                .data
                .next()
                .await
                .expect("data remains open")
                .unwrap()
            {
                Message::Text(text) => panic!("unexpected diagnostic response: {text}"),
                Message::Ping(bytes) => bridge.data.send(Message::Pong(bytes)).await.unwrap(),
                Message::Pong(bytes) if bytes == barrier => break,
                Message::Close(reason) => panic!("data closed: {reason:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("data ping must confirm the preceding diagnostic completed");

    for kind in ["done", "error"] {
        for execution_value in [None, Some(Value::Null)] {
            let mut unscoped = result.clone();
            unscoped["type"] = json!(kind);
            if kind == "error" {
                unscoped["message"] = unscoped["content"].take();
                unscoped.as_object_mut().unwrap().remove("content");
            }
            match execution_value {
                Some(value) => unscoped["execution"] = value,
                None => {
                    unscoped.as_object_mut().unwrap().remove("execution");
                }
            }
            let ack = terminal_ack(&mut bridge.data, &unscoped).await;
            assert_terminal_rejection(&ack, "INVALID_FRAME", false);
            assert_eq!(partial_and_clock(&db, &task).await, before);
            assert!(ledger(&db, &task).await["terminal_client_msg_id"].is_null());
        }
    }
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

    // The retired alias is rejected independently of execution/capability fields.
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
    send(&mut bridge.data, reply.clone()).await;
    let rejected = next_type(&mut bridge.data, "send_ack").await;
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["code"], "INVALID_FRAME");
    reply.as_object_mut().unwrap().remove("client_msg_id");
    send(&mut bridge.data, reply).await;
    let rejected = next_type(&mut bridge.data, "error").await;
    assert_eq!(rejected["code"], "INVALID_FRAME");
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

#[sqlx::test]
async fn committed_parent_and_pending_child_recover_together_after_a_real_gateway_crash(
    db: PgPool,
) {
    let mut fixture = Fixture::start(&db).await;
    let child = fixture.seed_bot(&db).await;
    let child_session = server::domain::sessions::ensure_primary_session_workspace(
        &db,
        child.id,
        &child.id.to_string(),
        &fixture.channel.to_string(),
        Some("/original-child"),
        &[],
    )
    .await
    .unwrap();
    let mut parent_bridge = fixture.bridge(true).await;
    let mut child_control = fixture.socket(&child, "control").await;
    let child_data = fixture.socket(&child, "data").await;
    ready(&mut child_control, true).await;
    let parent = fixture.dispatch(&mut parent_bridge.control).await;
    let execution = Uuid::new_v4();
    accept(
        &mut parent_bridge.control,
        acceptance(&parent, execution),
        "granted",
    )
    .await;
    let mut result = terminal(
        &parent,
        execution,
        Uuid::new_v4(),
        "Committed parent handoff",
    );
    result["mention_ids"] = json!([child.id]);
    let mut blocker = db.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(104731,84)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE FUNCTION pause_child_preparation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.bot_id='{}' AND OLD.task_frame IS NULL AND NEW.task_frame IS NOT NULL THEN PERFORM pg_advisory_xact_lock(104731,84); END IF; RETURN NEW; END $$",child.id))
        .execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER pause_child_preparation BEFORE UPDATE ON bot_runs FOR EACH ROW EXECUTE FUNCTION pause_child_preparation()")
        .execute(&db).await.unwrap();
    send(&mut parent_bridge.data, result.clone()).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let blocked:bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=104731 AND objid=84 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))")
                .fetch_one(&db).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("parent commit must reach the child's first preparation");
    let receipt = ledger(&db, &parent).await;
    assert!(!receipt["terminal_committed_at"].is_null());
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE trigger_msg_id=$1")
            .bind(parent["placeholder_msg_id"].as_str().unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(before["status"], "pending");
    assert!(before["task_frame"].is_null());
    assert_eq!(before["dispatch_input"]["actor"]["type"], "bot");
    drop(fixture.gateway.take());
    drop(parent_bridge);
    drop(child_control);
    drop(child_data);
    // A killed PG client can remain blocked until the advisory lock is granted.
    // Release it before waiting for the trigger's relation lock to disappear.
    blocker.rollback().await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(10),
        sqlx::query("DROP TRIGGER pause_child_preparation ON bot_runs").execute(&db),
    )
    .await
    .unwrap()
    .unwrap();
    let identity =
        json!({"task_id":before["task_id"],"placeholder_msg_id":before["placeholder_msg_id"]});
    age_unaccepted_intent(&db, &identity).await;
    let later = server::domain::sessions::create_channel_session(
        &db,
        child.id,
        &child.id.to_string(),
        &fixture.channel.to_string(),
        "other",
        Some("/later-child"),
        &[],
    )
    .await
    .unwrap();
    server::domain::sessions::set_primary_session(
        &db,
        child.id,
        &fixture.channel.to_string(),
        later.session_id,
    )
    .await
    .unwrap();
    fixture.restart(&db).await;
    let mut recovered = fixture.recovering_bot_bridge(&child).await;
    let task = next_recovered_task(&mut recovered.control).await;
    assert_eq!(task["task_id"], before["task_id"]);
    assert_eq!(task["placeholder_msg_id"], before["placeholder_msg_id"]);
    assert_eq!(task["trigger_message"]["text"], "Committed parent handoff");
    assert_eq!(task["session_id"], child_session.session_id.to_string());
    assert_eq!(
        task["provider_session_key"],
        child_session.provider_session_key
    );
    assert_eq!(task["depth"], 1);
    assert_eq!(
        task["context_bundle"],
        before["dispatch_input"]["params"]["context_bundle"]
    );
    accept(
        &mut recovered.control,
        acceptance(&task, Uuid::new_v4()),
        "granted",
    )
    .await;
    let mut parent_reconnected = fixture.recovering_bridge().await;
    assert_eq!(
        terminal_ack(&mut parent_reconnected.data, &result).await["ok"],
        true
    );
    accept(
        &mut parent_reconnected.control,
        acceptance(&parent, execution),
        "rejected",
    )
    .await;
    assert_no_task_for(&mut recovered.control, Duration::from_secs(7)).await;
    let children: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_runs WHERE trigger_msg_id=$1")
        .bind(parent["placeholder_msg_id"].as_str().unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(children, 1);
    let audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM acp_event_log WHERE channel_id=$1 AND name='dispatch'",
    )
    .bind(fixture.channel.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audits, 1);
}

/// Independent wire fixture: lexical object keys are part of the documented
/// capability signature, including the original Error kind and execution IDs.
fn canonical_frame(value: &Value) -> String {
    match value {
        Value::Object(fields) => {
            let sorted = fields.iter().collect::<std::collections::BTreeMap<_, _>>();
            format!(
                "{{{}}}",
                sorted
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_frame(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_frame)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

#[sqlx::test]
async fn mcp_and_bridge_sends_share_one_idempotent_command_and_child(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let child = fixture.seed_bot(&db).await;
    let mut author = fixture.bridge(true).await;
    let mut control = fixture.socket(&child, "control").await;
    let _data = fixture.socket(&child, "data").await;
    ready(&mut control, true).await;
    let created = fixture
        .mcp_post(
            json!({"channel_id":fixture.channel,"text":"One command across transports",
        "mention_ids":[child.id],"idempotency_key":"bridge.send:shared-mcp-send"}),
        )
        .await;
    let task = next_type(&mut control, "task").await;
    assert_eq!(task["trigger_msg_id"], created["msg_id"]);
    send(&mut author.data, json!({"type":"send","v":1,"client_msg_id":"shared-mcp-send",
        "channel_id":fixture.channel,"content":"One command across transports","mention_ids":[child.id]})).await;
    let replay = next_type(&mut author.data, "send_ack").await;
    assert_eq!(replay["ok"], true, "{replay}");
    assert_eq!(replay["message_id"], created["msg_id"]);
    accept(&mut control, acceptance(&task, Uuid::new_v4()), "granted").await;
    let parents: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id=$1 AND sender_id=$2 AND is_partial=FALSE",
    )
    .bind(fixture.channel.to_string())
    .bind(fixture.bot.id.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(parents, 1);
    let children: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_runs WHERE trigger_msg_id=$1")
        .bind(created["msg_id"].as_str().unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(children, 1);
    let audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM acp_event_log WHERE channel_id=$1 AND name='dispatch'",
    )
    .bind(fixture.channel.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audits, 1);
}

async fn proactive_child_crash(db: PgPool, resource_post: bool) {
    let mut fixture = Fixture::start(&db).await;
    let child = fixture.seed_bot(&db).await;
    let mut author = fixture.bridge(true).await;
    let mut control = fixture.socket(&child, "control").await;
    let data = fixture.socket(&child, "data").await;
    ready(&mut control, true).await;
    let mut blocker = db.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(104733,86)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE FUNCTION pause_proactive_preparation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.bot_id='{}' AND OLD.task_frame IS NULL AND NEW.task_frame IS NOT NULL THEN PERFORM pg_advisory_xact_lock(104733,86); END IF; RETURN NEW; END $$", child.id))
        .execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER pause_proactive_preparation BEFORE UPDATE ON bot_runs FOR EACH ROW EXECUTE FUNCTION pause_proactive_preparation()")
        .execute(&db).await.unwrap();
    let arguments = json!({"channel_id":fixture.channel,"text":"Durable proactive handoff","mention_ids":[child.id],"idempotency_key":"proactive-resource-key"});
    let frame = json!({"type":"send","v":1,"client_msg_id":"proactive-send-key","channel_id":fixture.channel,"content":"Durable proactive handoff","mention_ids":[child.id]});
    if resource_post {
        fixture.mcp_post(arguments.clone()).await;
    } else {
        send(&mut author.data, frame.clone()).await;
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=104733 AND objid=86 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))")
                .fetch_one(&db).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("the real producer must commit its child before preparation");
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE channel_id=$1 AND bot_id=$2")
            .bind(fixture.channel.to_string())
            .bind(child.id.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(before["dispatch_input"]["actor"]["type"], "bot_message");
    assert!(before["dispatch_input"]["actor"]
        .get("parent_execution_id")
        .is_none());
    let source = before["trigger_msg_id"].as_str().unwrap().to_string();
    let proof: (Option<String>, i64) = sqlx::query_as("SELECT task_id,(SELECT COUNT(*) FROM bot_runs WHERE placeholder_msg_id=m.msg_id) FROM messages m WHERE msg_id=$1")
        .bind(&source).fetch_one(&db).await.unwrap();
    assert_eq!(proof, (None, 0));
    drop(fixture.gateway.take());
    drop(author);
    drop(control);
    drop(data);
    blocker.rollback().await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(10),
        sqlx::query("DROP TRIGGER pause_proactive_preparation ON bot_runs").execute(&db),
    )
    .await
    .unwrap()
    .unwrap();
    sqlx::query("DROP FUNCTION pause_proactive_preparation()")
        .execute(&db)
        .await
        .unwrap();
    age_unaccepted_intent(
        &db,
        &json!({"task_id":before["task_id"],"placeholder_msg_id":before["placeholder_msg_id"]}),
    )
    .await;
    fixture.restart(&db).await;
    let mut recovered = fixture.recovering_bot_bridge(&child).await;
    let task = next_recovered_task(&mut recovered.control).await;
    assert_eq!(task["task_id"], before["task_id"]);
    assert_eq!(task["placeholder_msg_id"], before["placeholder_msg_id"]);
    assert_eq!(task["trigger_message"]["text"], "Durable proactive handoff");
    accept(
        &mut recovered.control,
        acceptance(&task, Uuid::new_v4()),
        "granted",
    )
    .await;
    if resource_post {
        let replay = fixture.mcp_post(arguments).await;
        assert_eq!(replay["idempotent_replay"], true);
        assert_eq!(replay["msg_id"], source);
    } else {
        let mut reconnected = fixture.recovering_bridge().await;
        send(&mut reconnected.data, frame).await;
        let replay = next_type(&mut reconnected.data, "send_ack").await;
        assert_eq!(replay["ok"], true, "{replay}");
        assert_eq!(replay["message_id"], source);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_runs WHERE trigger_msg_id=$1")
        .bind(&source)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "replaying the producer cannot admit another child"
    );
}

#[sqlx::test]
async fn a_proactive_send_child_recovers_after_real_process_loss(db: PgPool) {
    proactive_child_crash(db, false).await;
}

#[sqlx::test]
async fn a_resource_post_child_recovers_after_real_process_loss(db: PgPool) {
    proactive_child_crash(db, true).await;
}

#[sqlx::test]
async fn a_valid_signed_error_with_mentions_commits_without_admitting_child_work(db: PgPool) {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Keypair, PublicKey, SecretKey, Signer};
    let fixture = Fixture::start(&db).await;
    sqlx::query("UPDATE bot_accounts SET binding_config=jsonb_set(binding_config,'{acp_security,require_capability}','true') WHERE bot_id=$1")
        .bind(fixture.bot.id.to_string()).execute(&db).await.unwrap();
    let child = fixture.seed_bot(&db).await;
    let mut child_control = fixture.socket(&child, "control").await;
    let _child_data = fixture.socket(&child, "data").await;
    ready(&mut child_control, true).await;
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let secret = SecretKey::from_bytes(&[42; 32]).unwrap();
    let public = PublicKey::from(&secret);
    let key = Keypair { secret, public };
    let delegation = Uuid::new_v4();
    sqlx::query("INSERT INTO acp_capability_delegations(delegation_id,bot_id,scope_type,allowed_actions,allowed_resources,public_key,granted_by,expires_at) VALUES($1,$2,'global',$3,ARRAY['*']::text[],$4,$5,NOW()+INTERVAL '1 hour')")
        .bind(delegation.to_string()).bind(fixture.bot.id.to_string()).bind(vec!["stream"])
        .bind(STANDARD.encode(key.public.to_bytes())).bind(fixture.user.to_string()).execute(&db).await.unwrap();
    let mut result = terminal(
        &task,
        execution,
        Uuid::new_v4(),
        "A signed Error is a result, not a new instruction",
    );
    result["type"] = json!("error");
    result["message"] = result["content"].take();
    result.as_object_mut().unwrap().remove("content");
    result["mention_ids"] = json!([child.id]);
    let timestamp = chrono::Utc::now().timestamp();
    let nonce = Uuid::new_v4().to_string();
    let request = Uuid::new_v4().to_string();
    let signable=format!("anx-cap|v1|type=error|kid={delegation}|ts={timestamp}|nonce={nonce}|request={request}|payload={}",canonical_frame(&result));
    result["acp_capability"] = json!({"delegation_id":delegation,"ts":timestamp,"nonce":nonce,
        "request_id":request,"signature":STANDARD.encode(key.sign(signable.as_bytes()).to_bytes())});
    let signed_ack = terminal_ack(&mut bridge.data, &result).await;
    assert_eq!(signed_ack["ok"], true, "{signed_ack}");
    let receipt = ledger(&db, &task).await;
    assert_eq!(receipt["last_event_type"], "error");
    assert!(!receipt["terminal_committed_at"].is_null());
    let uses: i32 = sqlx::query_scalar(
        "SELECT use_count FROM acp_capability_delegations WHERE delegation_id=$1",
    )
    .bind(delegation.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        uses, 1,
        "the gateway verified the real capability rather than taking the opt-out path"
    );
    let children: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_runs WHERE trigger_msg_id=$1")
        .bind(task["placeholder_msg_id"].as_str().unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(children, 0);
    assert_no_task_before_pong(&mut child_control).await;
}

impl Fixture {
    /// Keep the real human source, but seed the scheduler reservation so tests
    /// do not need to wait for debounce or run an ACP process.
    async fn dispatched_claim_evaluation(&self, db: &PgPool) -> Uuid {
        let source = self
            .post(
                &format!("/channels/{}/messages", self.channel),
                json!({"content":"Please perform this approved claim"}),
            )
            .await;
        let seq = source["channel_seq"].as_i64().unwrap();
        sqlx::query("INSERT INTO channel_bot_monitoring(channel_id,bot_id,mode,next_eligible_at) VALUES($1,$2,'text',NOW()+INTERVAL '1 day') ON CONFLICT(channel_id,bot_id) DO UPDATE SET mode='text',next_eligible_at=EXCLUDED.next_eligible_at")
            .bind(self.channel.to_string()).bind(self.bot.id.to_string()).execute(db).await.unwrap();
        let evaluation = Uuid::new_v4();
        sqlx::query("INSERT INTO task_claim_evaluations(evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to,status,dispatched_at) VALUES($1,$2,$3,$4,$4,'dispatched',NOW())")
            .bind(evaluation.to_string()).bind(self.channel.to_string()).bind(self.bot.id.to_string()).bind(seq).execute(db).await.unwrap();
        evaluation
    }

    /// Derive requester, source and confirmation through the production writer.
    async fn pending_claim(&self, db: &PgPool) -> Value {
        let evaluation = self.dispatched_claim_evaluation(db).await;
        server::domain::sessions::ensure_primary_session_workspace(
            db,
            self.bot.id,
            &self.bot.id.to_string(),
            &self.channel.to_string(),
            Some("/approved-workspace"),
            &[],
        )
        .await
        .unwrap();
        server::resource::task_claims::handle_evaluate(db,&server::resource::Principal::bot(self.bot.id),
            &json!({"channel_id":self.channel,"evaluation_id":evaluation,"decision":"claim","confidence":1.0})).await.unwrap()
    }
    async fn claim_status(&self, db: &PgPool, claim: &Value) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM task_claim_requests r WHERE claim_id=$1")
            .bind(claim["claim_id"].as_str().unwrap())
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn evaluation_state(&self, db: &PgPool, evaluation: Uuid) -> Value {
        sqlx::query_scalar(
            "SELECT to_jsonb(e) FROM task_claim_evaluations e WHERE evaluation_id=$1",
        )
        .bind(evaluation.to_string())
        .fetch_one(db)
        .await
        .unwrap()
    }

    async fn evaluation_publication_counts(
        &self,
        db: &PgPool,
        evaluation: Uuid,
    ) -> (i64, i64, i64, i64) {
        sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM task_claim_requests WHERE evaluation_id=$1),
                    (SELECT COUNT(*) FROM messages WHERE channel_id=$2 AND msg_type='task_claim_confirmation'),
                    (SELECT COUNT(*) FROM message_mentions mm JOIN messages m ON m.msg_id=mm.msg_id
                     WHERE m.channel_id=$2 AND m.msg_type='task_claim_confirmation'),
                    next_seq FROM channels WHERE channel_id=$2",
        )
        .bind(evaluation.to_string())
        .bind(self.channel.to_string())
        .fetch_one(db)
        .await
        .unwrap()
    }
}

async fn evaluation_ack(data: &mut Socket, frame: &Value) -> Value {
    send(data, frame.clone()).await;
    let ack = next_type(data, "task_claim_ack").await;
    assert_eq!(ack["v"], 1);
    assert_eq!(ack["evaluation_id"], frame["evaluation_id"]);
    ack
}

#[sqlx::test]
async fn claim_evaluation_ws_rejects_foreign_bots_and_preserves_the_owners_committed_decision(
    db: PgPool,
) {
    let fixture = Fixture::start(&db).await;
    let evaluation = fixture.dispatched_claim_evaluation(&db).await;
    let peer = fixture.seed_bot(&db).await;
    let mut foreign_data = fixture.socket(&peer, "data").await;
    let mut owner_data = fixture.socket(&fixture.bot, "data").await;
    let decision = json!({"type":"claim_evaluation_result","v":1,"evaluation_id":evaluation,
        "content":json!({"decision":"claim","confidence":1.0}).to_string()});
    let failure = json!({"type":"claim_evaluation_result","v":1,"evaluation_id":evaluation,
        "error":"late ACP runtime failure"});
    let dispatched = fixture.evaluation_state(&db, evaluation).await;
    let before = fixture.evaluation_publication_counts(&db, evaluation).await;
    assert_eq!(dispatched["status"], "dispatched");
    assert_eq!((before.0, before.1, before.2), (0, 0, 0));
    for forged in [&decision, &failure] {
        let ack = evaluation_ack(&mut foreign_data, forged).await;
        assert_eq!(ack["ok"], false, "{ack}");
        assert!(ack["error"].is_string(), "{ack}");
        assert_eq!(fixture.evaluation_state(&db, evaluation).await, dispatched);
        assert_eq!(
            fixture.evaluation_publication_counts(&db, evaluation).await,
            before,
            "the WS error boundary cannot fail another bot's evaluation"
        );
    }

    let ack = evaluation_ack(&mut owner_data, &decision).await;
    assert_eq!(ack["ok"], true, "{ack}");
    assert_eq!(ack["data"]["status"], "pending");
    let committed = fixture.evaluation_state(&db, evaluation).await;
    assert_eq!(committed["status"], "completed");
    let claim = fixture.claim_status(&db, &ack["data"]).await;
    assert_eq!(claim["bot_id"], fixture.bot.id.to_string());
    let counts = fixture.evaluation_publication_counts(&db, evaluation).await;
    assert_eq!(counts, (1, 1, 1, before.3 + 1));

    let late = evaluation_ack(&mut owner_data, &failure).await;
    assert_eq!(late["ok"], true, "{late}");
    assert_eq!(late["data"]["duplicate"], true);
    assert_eq!(fixture.evaluation_state(&db, evaluation).await, committed);
    assert_eq!(fixture.claim_status(&db, &ack["data"]).await, claim);
    assert_eq!(
        fixture.evaluation_publication_counts(&db, evaluation).await,
        counts,
        "a late runtime error cannot downgrade the decision or publish another confirmation"
    );
}

#[sqlx::test]
async fn claim_evaluation_ws_commit_failure_nacks_without_consuming_the_evaluation(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let evaluation = fixture.dispatched_claim_evaluation(&db).await;
    let mut data = fixture.socket(&fixture.bot, "data").await;
    let decision = json!({"type":"claim_evaluation_result","v":1,"evaluation_id":evaluation,
        "content":json!({"decision":"claim","confidence":1.0}).to_string()});
    let dispatched = fixture.evaluation_state(&db, evaluation).await;
    let before = fixture.evaluation_publication_counts(&db, evaluation).await;
    sqlx::raw_sql("CREATE FUNCTION reject_claim_confirmation_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected claim confirmation commit failure'; END $$; CREATE CONSTRAINT TRIGGER reject_claim_confirmation_commit AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.msg_type='task_claim_confirmation') EXECUTE FUNCTION reject_claim_confirmation_commit()")
        .execute(&db).await.unwrap();
    let ack = evaluation_ack(&mut data, &decision).await;
    assert_eq!(ack["ok"], false, "{ack}");
    assert!(ack["error"].is_string(), "{ack}");
    assert_eq!(
        fixture.evaluation_state(&db, evaluation).await,
        dispatched,
        "the WS NACK must not convert a rolled-back write into a failed evaluation"
    );
    assert_eq!(
        fixture.evaluation_publication_counts(&db, evaluation).await,
        before,
        "claim, confirmation, mentions and channel sequence must all roll back"
    );
    sqlx::raw_sql("DROP TRIGGER reject_claim_confirmation_commit ON messages; DROP FUNCTION reject_claim_confirmation_commit()")
        .execute(&db).await.unwrap();
    let retried = evaluation_ack(&mut data, &decision).await;
    assert_eq!(retried["ok"], true, "{retried}");
    assert_eq!(retried["data"]["status"], "pending");
    assert_eq!(
        fixture.evaluation_state(&db, evaluation).await["status"],
        "completed"
    );
    let counts = fixture.evaluation_publication_counts(&db, evaluation).await;
    assert_eq!(counts, (1, 1, 1, before.3 + 1));
    let repeated = evaluation_ack(&mut data, &decision).await;
    assert_eq!(repeated["ok"], true, "{repeated}");
    assert_eq!(repeated["data"]["duplicate"], true);
    assert_eq!(
        fixture.evaluation_publication_counts(&db, evaluation).await,
        counts
    );
}

#[sqlx::test]
async fn an_approved_claim_recovers_after_process_loss_with_its_original_private_trigger_and_session(
    db: PgPool,
) {
    let mut fixture = Fixture::start(&db).await;
    let pending = fixture.pending_claim(&db).await;
    let bridge = fixture.bridge(true).await;
    let key: i64 = 6_742_029;
    let mut blocker = db.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(key)
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE FUNCTION pause_claim_preparation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.task_frame IS NULL AND NEW.task_frame IS NOT NULL THEN PERFORM pg_advisory_xact_lock({key}::bigint); END IF; RETURN NEW; END $$"))
        .execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER pause_claim_preparation BEFORE UPDATE ON bot_runs FOR EACH ROW EXECUTE FUNCTION pause_claim_preparation()")
        .execute(&db).await.unwrap();
    let approval = {
        let client = fixture.client.clone();
        let token = fixture.token.clone();
        let endpoint = format!(
            "{}/api/v1/channels/{}/task-claims/{}/resolve",
            fixture.base,
            fixture.channel,
            pending["claim_id"].as_str().unwrap()
        );
        tokio::spawn(async move {
            client
                .post(endpoint)
                .bearer_auth(token)
                .json(&json!({"decision":"accept"}))
                .send()
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(10),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted AND objid=$1::bigint::oid)")
                .bind(key).fetch_one(&db).await.unwrap();
            if waiting {break;} tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("claim preparation must wait after approval commit");
    let committed = fixture.claim_status(&db, &pending).await;
    assert_eq!(committed["status"], "executing");
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE placeholder_msg_id=$1")
            .bind(committed["execution_msg_id"].as_str().unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(before["status"], "pending");
    assert!(before["task_frame"].is_null());
    let params = &before["dispatch_input"]["params"];
    let original_session = params["session_id"].clone();
    let original_key = params["provider_session_key"].clone();
    let original_text = before["dispatch_input"]["trigger_message"]["text"].clone();
    let private: (bool, Option<i64>, String) =
        sqlx::query_as("SELECT is_secret,channel_seq,msg_type FROM messages WHERE msg_id=$1")
            .bind(before["trigger_msg_id"].as_str().unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(private, (true, None, "task_claim".into()));
    drop(fixture.gateway.take());
    drop(bridge);
    let _ = approval.await;
    // A killed backend may still wait on its advisory lock; release before DDL.
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(key)
        .execute(&mut *blocker)
        .await
        .unwrap();
    drop(blocker);
    sqlx::raw_sql(
        "DROP TRIGGER pause_claim_preparation ON bot_runs; DROP FUNCTION pause_claim_preparation()",
    )
    .execute(&db)
    .await
    .unwrap();
    let identity =
        json!({"task_id":before["task_id"],"placeholder_msg_id":before["placeholder_msg_id"]});
    age_unaccepted_intent(&db, &identity).await;
    let later = server::domain::sessions::create_channel_session(
        &db,
        fixture.bot.id,
        &fixture.bot.id.to_string(),
        &fixture.channel.to_string(),
        "other",
        Some("/later-primary"),
        &[],
    )
    .await
    .unwrap();
    server::domain::sessions::set_primary_session(
        &db,
        fixture.bot.id,
        &fixture.channel.to_string(),
        later.session_id,
    )
    .await
    .unwrap();
    fixture.restart(&db).await;
    let mut recovered = fixture.recovering_bridge().await;
    let task = next_recovered_task(&mut recovered.control).await;
    assert_eq!(task["task_id"], before["task_id"]);
    assert_eq!(task["placeholder_msg_id"], before["placeholder_msg_id"]);
    assert_eq!(task["session_id"], original_session);
    assert_eq!(task["provider_session_key"], original_key);
    assert_eq!(task["trigger_message"]["text"], original_text);
    assert_eq!(task["cwd"], "/approved-workspace");
    assert_eq!(
        task["trigger_seq"], 0,
        "the private approval trigger never pretends to be a published human sequence"
    );
    let execution = Uuid::new_v4();
    accept(
        &mut recovered.control,
        acceptance(&task, execution),
        "granted",
    )
    .await;
    let result = terminal(&task, execution, Uuid::new_v4(), "Recovered approved work");
    assert_eq!(terminal_ack(&mut recovered.data, &result).await["ok"], true);
    assert_eq!(
        fixture.claim_status(&db, &pending).await["status"],
        "completed"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_runs WHERE trigger_msg_id=$1")
        .bind(task["trigger_msg_id"].as_str().unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    drop(fixture.gateway.take());
    drop(recovered);
    fixture.restart(&db).await;
    let mut replay = fixture.recovering_bridge().await;
    assert_eq!(terminal_ack(&mut replay.data, &result).await["ok"], true);
    assert_no_task_for(&mut replay.control, Duration::from_secs(7)).await;
    assert_eq!(
        fixture.claim_status(&db, &pending).await["status"],
        "completed"
    );
}

#[sqlx::test]
async fn task_claim_http_errors_match_persisted_state_and_fast_results_are_not_overwritten(
    db: PgPool,
) {
    let fixture = Fixture::start(&db).await;
    let mut pending = fixture.pending_claim(&db).await;
    let endpoint = |claim: &Value| {
        format!(
            "{}/api/v1/channels/{}/task-claims/{}/resolve",
            fixture.base,
            fixture.channel,
            claim["claim_id"].as_str().unwrap()
        )
    };
    let response = fixture
        .client
        .post(endpoint(&pending))
        .bearer_auth(&fixture.token)
        .json(&json!({"decision":"accept"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::CONFLICT,
        "offline approval remains retryable"
    );
    assert_eq!(
        fixture.claim_status(&db, &pending).await["status"],
        "pending"
    );
    let mut bridge = fixture.bridge(true).await;
    for kind in ["done", "error"] {
        if kind == "error" {
            pending = fixture.pending_claim(&db).await;
        }
        let approval = {
            let client = fixture.client.clone();
            let token = fixture.token.clone();
            let url = endpoint(&pending);
            tokio::spawn(async move {
                client
                    .post(url)
                    .bearer_auth(token)
                    .json(&json!({"decision":"accept"}))
                    .send()
                    .await
                    .unwrap()
            })
        };
        let task = next_type(&mut bridge.control, "task").await;
        let execution = Uuid::new_v4();
        accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
        let mut result = terminal(&task, execution, Uuid::new_v4(), "Immediate claim result");
        if kind == "error" {
            result["type"] = json!("error");
            result["message"] = json!("Immediate claim failure");
            result.as_object_mut().unwrap().remove("content");
        }
        assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);
        let response = approval.await.unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert!(status.is_success(), "{status}: {body}");
        assert_eq!(body["execution_msg_id"], task["placeholder_msg_id"]);
        let expected = if kind == "done" {
            "completed"
        } else {
            "failed"
        };
        assert_eq!(
            fixture.claim_status(&db, &pending).await["status"],
            expected,
            "late approval work cannot overwrite a terminal result"
        );
        let list: Value = fixture
            .client
            .get(format!(
                "{}/api/v1/channels/{}/task-claims",
                fixture.base, fixture.channel
            ))
            .bearer_auth(&fixture.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let row = list["claims"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["claim_id"] == pending["claim_id"])
            .unwrap();
        assert_eq!(row["status"], expected);
        assert_eq!(terminal_ack(&mut bridge.data, &result).await["ok"], true);
        assert_eq!(
            fixture.claim_status(&db, &pending).await["status"],
            expected
        );
    }
    let failed = fixture.pending_claim(&db).await;
    sqlx::raw_sql("CREATE FUNCTION reject_approved_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected approval DB failure'; END $$; CREATE CONSTRAINT TRIGGER reject_approved_claim AFTER INSERT ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_approved_claim()")
        .execute(&db).await.unwrap();
    let response = fixture
        .client
        .post(endpoint(&failed))
        .bearer_auth(&fixture.token)
        .json(&json!({"decision":"accept"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body: Value = response.json().await.unwrap();
    assert!(
        !body.to_string().to_lowercase().contains("offline"),
        "a DB failure cannot be reported as a connector outage: {body}"
    );
    let state = fixture.claim_status(&db, &failed).await;
    assert_eq!(state["status"], "pending");
    assert!(state["execution_msg_id"].is_null());
    assert!(state["resolution_note"].is_null());
    assert_no_task_before_pong(&mut bridge.control).await;
}

/// A capability-enforced stream whose execution is granted, plus the delegation
/// key that signs its frames. `max_uses` of None means unlimited.
async fn signed_stream(
    db: &PgPool,
    max_uses: Option<i32>,
) -> (Fixture, Bridge, Value, Uuid, Uuid, ed25519_dalek::Keypair) {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Keypair, PublicKey, SecretKey};
    let fixture = Fixture::start(db).await;
    sqlx::query("UPDATE bot_accounts SET binding_config=jsonb_set(binding_config,'{acp_security,require_capability}','true') WHERE bot_id=$1")
        .bind(fixture.bot.id.to_string()).execute(db).await.unwrap();
    let mut bridge = fixture.bridge(true).await;
    let task = fixture.dispatch(&mut bridge.control).await;
    let execution = Uuid::new_v4();
    accept(&mut bridge.control, acceptance(&task, execution), "granted").await;
    let secret = SecretKey::from_bytes(&[42; 32]).unwrap();
    let public = PublicKey::from(&secret);
    let key = Keypair { secret, public };
    let delegation = Uuid::new_v4();
    sqlx::query("INSERT INTO acp_capability_delegations(delegation_id,bot_id,scope_type,allowed_actions,allowed_resources,public_key,granted_by,expires_at,max_uses) VALUES($1,$2,'global',$3,ARRAY['*']::text[],$4,$5,NOW()+INTERVAL '1 hour',$6)")
        .bind(delegation.to_string()).bind(fixture.bot.id.to_string()).bind(vec!["stream"])
        .bind(STANDARD.encode(key.public.to_bytes())).bind(fixture.user.to_string()).bind(max_uses)
        .execute(db).await.unwrap();
    (fixture, bridge, task, execution, delegation, key)
}

fn sign_frame(frame: &mut Value, delegation: Uuid, key: &ed25519_dalek::Keypair) {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::Signer;
    let frame_type = frame["type"].as_str().unwrap().to_string();
    let timestamp = chrono::Utc::now().timestamp();
    let nonce = Uuid::new_v4().to_string();
    let request = Uuid::new_v4().to_string();
    let signable = format!("anx-cap|v1|type={frame_type}|kid={delegation}|ts={timestamp}|nonce={nonce}|request={request}|payload={}", canonical_frame(frame));
    frame["acp_capability"] = json!({"delegation_id":delegation,"ts":timestamp,"nonce":nonce,
        "request_id":request,"signature":STANDARD.encode(key.sign(signable.as_bytes()).to_bytes())});
}

fn stream_delta(task: &Value, seq: u64) -> Value {
    json!({"type":"delta","v":1,"msg_id":task["placeholder_msg_id"],"seq":seq,"delta":"x",
        "provider_session_key":task["provider_session_key"],"session_id":task["session_id"]})
}

/// Send frames, then a ping; return every error the gateway sent before the pong.
/// Delta are processed in order on the data loop, so the pong fences them.
async fn delta_errors(data: &mut Socket, frames: Vec<Value>) -> Vec<Value> {
    for frame in frames {
        send(data, frame).await;
    }
    send(data, json!({"type":"ping","v":1})).await;
    let mut errors = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match data.next().await.expect("bridge must remain open").unwrap() {
                Message::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    match frame["type"].as_str() {
                        Some("pong") => return,
                        Some("error") => errors.push(frame),
                        _ => {}
                    }
                }
                Message::Ping(bytes) => data.send(Message::Pong(bytes)).await.unwrap(),
                Message::Close(reason) => panic!("bridge closed: {reason:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("pong");
    errors
}

async fn delegation_uses(db: &PgPool, delegation: Uuid) -> i32 {
    sqlx::query_scalar("SELECT use_count FROM acp_capability_delegations WHERE delegation_id=$1")
        .bind(delegation.to_string())
        .fetch_one(db)
        .await
        .unwrap()
}

#[sqlx::test]
async fn unsigned_delta_ride_the_streams_verified_signature_within_max_uses(db: PgPool) {
    let (_fixture, mut bridge, task, _execution, delegation, key) =
        signed_stream(&db, Some(4)).await;
    let msg_id = task["placeholder_msg_id"].clone();

    let errors = delta_errors(&mut bridge.data, vec![stream_delta(&task, 1)]).await;
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(errors[0]["code"], "DELTA_CAPABILITY_REQUIRED");
    assert_eq!(
        errors[0]["msg_id"], msg_id,
        "the rejection names the stream so the connector re-signs it"
    );

    let mut first = stream_delta(&task, 2);
    sign_frame(&mut first, delegation, &key);
    let frames = vec![
        first,
        stream_delta(&task, 3),
        stream_delta(&task, 4),
        stream_delta(&task, 5),
    ];
    let errors = delta_errors(&mut bridge.data, frames).await;
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(
        delegation_uses(&db, delegation).await,
        4,
        "one signed Delta plus three prepaid unsigned Delta"
    );

    let errors = delta_errors(&mut bridge.data, vec![stream_delta(&task, 6)]).await;
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(errors[0]["code"], "DELTA_CAPABILITY_REQUIRED");
    assert_eq!(errors[0]["msg_id"], msg_id);
    assert_eq!(
        delegation_uses(&db, delegation).await,
        4,
        "max_uses is exact"
    );
}

#[sqlx::test]
async fn revoking_the_delegation_stops_a_bound_stream_within_the_recheck_window(db: PgPool) {
    let (_fixture, mut bridge, task, _execution, delegation, key) = signed_stream(&db, None).await;
    let mut first = stream_delta(&task, 1);
    sign_frame(&mut first, delegation, &key);
    let errors = delta_errors(&mut bridge.data, vec![first, stream_delta(&task, 2)]).await;
    assert!(errors.is_empty(), "{errors:?}");

    sqlx::query("UPDATE acp_capability_delegations SET revoked=TRUE,status='revoked',revoked_at=NOW() WHERE delegation_id=$1")
        .bind(delegation.to_string()).execute(&db).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;

    let in_flight = vec![
        stream_delta(&task, 3),
        stream_delta(&task, 4),
        stream_delta(&task, 5),
    ];
    let errors = delta_errors(&mut bridge.data, in_flight).await;
    assert_eq!(
        errors.len(),
        1,
        "the lapse names the stream once, not once per in-flight Delta: {errors:?}"
    );
    assert_eq!(errors[0]["code"], "DELTA_CAPABILITY_REQUIRED");
    assert_eq!(errors[0]["msg_id"], task["placeholder_msg_id"]);
}

#[sqlx::test]
async fn an_unsigned_delta_cannot_change_the_signed_scope_fields(db: PgPool) {
    let (_fixture, mut bridge, task, _execution, delegation, key) = signed_stream(&db, None).await;
    let mut first = stream_delta(&task, 1);
    sign_frame(&mut first, delegation, &key);
    let errors = delta_errors(&mut bridge.data, vec![first, stream_delta(&task, 2)]).await;
    assert!(errors.is_empty(), "{errors:?}");

    let mut moved = stream_delta(&task, 3);
    moved["session_id"] = json!(Uuid::new_v4());
    let errors = delta_errors(&mut bridge.data, vec![moved]).await;
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(errors[0]["code"], "DELTA_CAPABILITY_REQUIRED");
    assert_eq!(errors[0]["msg_id"], task["placeholder_msg_id"]);
}

#[sqlx::test]
async fn a_finished_stream_refunds_prepaid_delta_uses(db: PgPool) {
    let (_fixture, mut bridge, task, execution, delegation, key) = signed_stream(&db, None).await;
    let mut first = stream_delta(&task, 1);
    sign_frame(&mut first, delegation, &key);
    let errors = delta_errors(&mut bridge.data, vec![first, stream_delta(&task, 2)]).await;
    assert!(errors.is_empty(), "{errors:?}");

    let mut done = terminal(&task, execution, Uuid::new_v4(), "finished");
    sign_frame(&mut done, delegation, &key);
    let ack = terminal_ack(&mut bridge.data, &done).await;
    assert_eq!(ack["ok"], true, "{ack}");

    // Signed Delta + unsigned Delta + signed Done; the unspent prepaid batch is
    // refunded asynchronously after the stream ends.
    tokio::time::timeout(Duration::from_secs(5), async {
        while delegation_uses(&db, delegation).await != 3 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("use_count settles at frames actually sent"));
}
