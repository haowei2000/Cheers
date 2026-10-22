//! Proactive bridge sends and resource messages use the same durable admission.
#![cfg(feature = "integration")]

use async_trait::async_trait;
use serde_json::{json, Value};
use server::{
    domain::{sessions, task_chains},
    gateway::{
        dispatch_intents,
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        stream::{self, StreamRegistry},
    },
    resource::{self, Principal},
};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum Producer {
    Send,
    Resource,
}

#[derive(Default)]
struct Locator(Mutex<Vec<Value>>);
#[async_trait]
impl BotLocator for Locator {
    async fn dispatch_task(&self, _bot: Uuid, frame: Value) -> bool {
        self.0.lock().unwrap().push(frame);
        false
    }
    async fn send_data(&self, _bot: Uuid, _frame: Value) -> bool {
        true
    }
    async fn is_online(&self, _bot: Uuid) -> bool {
        true
    }
    async fn supports_task_acceptance(&self, _bot: Uuid) -> bool {
        true
    }
}

#[derive(Default)]
struct RecordingFanout(Mutex<Vec<WireFrame>>);
#[async_trait]
impl Fanout for RecordingFanout {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        self.0.lock().unwrap().push(frame);
    }
    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}

struct PostCommitBarrier(Notify);
#[async_trait]
impl Fanout for PostCommitBarrier {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        if frame.frame_type == "message" && frame.data["is_partial"] == false {
            self.0.notify_one();
            std::future::pending::<()>().await;
        }
    }
    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}

struct Fixture {
    channel: Uuid,
    author: Uuid,
    target: Uuid,
    recorded: Arc<RecordingFanout>,
    fanout: Arc<dyn Fanout>,
    capture: Arc<Locator>,
    locator: Arc<dyn BotLocator>,
    registry: Arc<StreamRegistry>,
}

impl Fixture {
    async fn seed(db: &PgPool) -> Self {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let author = Uuid::new_v4();
        let target = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Proactive admission')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'proactive')")
            .bind(channel.to_string())
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        for bot in [author, target] {
            sqlx::query("INSERT INTO bot_accounts(bot_id,username,external_processor,binding_config) VALUES($1,$2,FALSE,$3)")
                .bind(bot.to_string()).bind(format!("proactive-{bot}")).bind(json!({"acp_security":{"require_capability":false}})).execute(db).await.unwrap();
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
                .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        }
        let recorded = Arc::new(RecordingFanout::default());
        let capture = Arc::new(Locator::default());
        Self {
            channel,
            author,
            target,
            fanout: recorded.clone(),
            recorded,
            locator: capture.clone(),
            capture,
            registry: StreamRegistry::new(),
        }
    }

    fn params(&self) -> Value {
        json!({"channel_id":self.channel,"content":"The original proactive instruction","mention_ids":[self.target],
            "idempotency_key":"proactive-stable-key","context_bundle":{"origin":"spoofed","items":[
                {"verb":"channel.info","params":{"channel_id":self.channel},"label":"Manual context"}]}})
    }

    fn send_frame(&self) -> Value {
        let mut params = self.params();
        params.as_object_mut().unwrap().remove("idempotency_key");
        params["type"] = json!("send");
        params["v"] = json!(1);
        params["client_msg_id"] = json!("proactive-stable-client");
        params
    }

    async fn post(&self, db: &PgPool, producer: Producer) -> Result<Value, String> {
        match producer {
            Producer::Resource => resource::messages::handle_create(
                db,
                &Principal::bot(self.author),
                &self.params(),
                &self.locator,
            )
            .await
            .map_err(|error| format!("{error:?}")),
            Producer::Send => {
                let sent = stream::handle_send(
                    &self.registry,
                    &self.fanout,
                    db,
                    &self.locator,
                    self.author,
                    &self.send_frame(),
                )
                .await
                .map_err(str::to_string)?;
                let mut response: Value = sqlx::query_scalar("SELECT jsonb_build_object('msg_id',msg_id,'channel_seq',channel_seq) FROM messages WHERE msg_id=$1")
                    .bind(sent.msg_id.to_string()).fetch_one(db).await.map_err(|error|error.to_string())?;
                response["idempotent_replay"] = json!(sent.replayed);
                Ok(response)
            }
        }
    }

    async fn source(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(m) FROM messages m WHERE channel_id=$1 AND sender_id=$2 AND NOT is_partial")
            .bind(self.channel.to_string()).bind(self.author.to_string()).fetch_one(db).await.unwrap()
    }

    async fn child(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE channel_id=$1 AND bot_id=$2")
            .bind(self.channel.to_string())
            .bind(self.target.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn due_and_deliver(&self, db: &PgPool) {
        sqlx::query("UPDATE bot_runs SET next_offer_at=NOW()-INTERVAL '1 second',dispatch_lease_id=NULL,dispatch_lease_until=NULL WHERE channel_id=$1")
            .bind(self.channel.to_string()).execute(db).await.unwrap();
        dispatch_intents::recover_once(db, &self.fanout, &self.registry, &self.locator)
            .await
            .unwrap();
    }

    fn offers(&self) -> Vec<Value> {
        std::mem::take(&mut *self.capture.0.lock().unwrap())
    }

    async fn audit_count(&self, db: &PgPool) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM acp_event_log WHERE channel_id=$1 AND name='dispatch'",
        )
        .bind(self.channel.to_string())
        .fetch_one(db)
        .await
        .unwrap()
    }
}

async fn fault(db: &PgPool, producer: Producer, deferred: bool) {
    let fixture = Fixture::seed(db).await;
    sqlx::query(&format!("CREATE FUNCTION reject_proactive_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.bot_id='{}' THEN RAISE EXCEPTION 'injected child failure'; END IF; RETURN NEW; END $$",fixture.target)).execute(db).await.unwrap();
    sqlx::query(if deferred {"CREATE CONSTRAINT TRIGGER reject_proactive_child AFTER INSERT ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_proactive_child()"}
        else {"CREATE TRIGGER reject_proactive_child BEFORE INSERT ON bot_runs FOR EACH ROW EXECUTE FUNCTION reject_proactive_child()"}).execute(db).await.unwrap();
    let attempts = if matches!(producer, Producer::Resource) && !deferred {
        31
    } else {
        2
    };
    for _ in 0..attempts {
        assert!(
            fixture.post(db, producer).await.is_err(),
            "{producer:?} must fail as one command"
        );
        for table in [
            "messages",
            "message_mentions",
            "task_chains",
            "bot_runs",
            "cheers_sessions",
            "resource_idempotency_keys",
            "acp_event_log",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(db)
                .await
                .unwrap();
            assert_eq!(count, 0, "{producer:?} failed transaction leaked {table}");
        }
        let clock: i64 = sqlx::query_scalar("SELECT next_seq FROM channels WHERE channel_id=$1")
            .bind(fixture.channel.to_string())
            .fetch_one(db)
            .await
            .unwrap();
        assert_eq!(clock, 0);
        assert!(fixture.recorded.0.lock().unwrap().is_empty());
    }
    sqlx::query("DROP TRIGGER reject_proactive_child ON bot_runs")
        .execute(db)
        .await
        .unwrap();
    let first = fixture.post(db, producer).await.unwrap();
    let child = fixture.child(db).await;
    assert_eq!(child["dispatch_input"]["actor"]["type"], "bot_message");
    assert!(child["dispatch_input"]["actor"]
        .get("parent_execution_id")
        .is_none());
    let retry = fixture.post(db, producer).await.unwrap();
    assert_eq!(retry["msg_id"], first["msg_id"]);
    assert_eq!(retry["idempotent_replay"], true);
    assert_eq!(fixture.audit_count(db).await, 1);
    let mut remaining = 0;
    while server::infra::ratelimit::bot_dispatch_limiter().try_hit(&fixture.channel.to_string()) {
        remaining += 1;
    }
    assert_eq!(
        remaining, 29,
        "{producer:?} uses one admission slot despite rolled-back random parent IDs"
    );
}

#[sqlx::test]
async fn bridge_send_child_insert_failure_rolls_back_the_entire_command(db: PgPool) {
    fault(&db, Producer::Send, false).await;
}
#[sqlx::test]
async fn bridge_send_child_commit_failure_rolls_back_the_entire_command(db: PgPool) {
    fault(&db, Producer::Send, true).await;
}
#[sqlx::test]
async fn resource_create_child_insert_failure_rolls_back_the_idempotency_receipt(db: PgPool) {
    fault(&db, Producer::Resource, false).await;
}
#[sqlx::test]
async fn resource_create_child_commit_failure_rolls_back_the_idempotency_receipt(db: PgPool) {
    fault(&db, Producer::Resource, true).await;
}

#[sqlx::test]
async fn cancellation_after_send_commit_leaves_a_real_proactive_source_and_recoverable_child(
    db: PgPool,
) {
    let mut fixture = Fixture::seed(&db).await;
    let barrier = Arc::new(PostCommitBarrier(Notify::new()));
    fixture.fanout = barrier.clone();
    let (registry, fanout, locator, author, frame, request_db) = (
        fixture.registry.clone(),
        fixture.fanout.clone(),
        fixture.locator.clone(),
        fixture.author,
        fixture.send_frame(),
        db.clone(),
    );
    let request = tokio::spawn(async move {
        stream::handle_send(&registry, &fanout, &request_db, &locator, author, &frame).await
    });
    tokio::time::timeout(Duration::from_secs(5), barrier.0.notified())
        .await
        .unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    let source = fixture.source(&db).await;
    let child = fixture.child(&db).await;
    assert!(source["task_id"].is_null());
    assert_eq!(child["status"], "pending");
    fixture.fanout = fixture.recorded.clone();
    fixture.due_and_deliver(&db).await;
    let task = fixture.offers().remove(0);
    assert_eq!(task["task_id"], child["task_id"]);
    let grant = server::gateway::task_acceptance::claim(
        &db,
        fixture.target,
        Uuid::new_v4(),
        task["task_id"].as_str().unwrap().parse().unwrap(),
        task["placeholder_msg_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
        fixture.channel,
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert!(matches!(
        grant.status,
        cheers_bridge_protocol::TaskAcceptanceStatus::Granted
    ));
    fixture.due_and_deliver(&db).await;
    assert!(fixture.offers().is_empty());
    assert_eq!(
        fixture.post(&db, Producer::Send).await.unwrap()["msg_id"],
        source["msg_id"]
    );
}

#[sqlx::test]
async fn raw_resource_commit_is_recoverable_and_keeps_session_handoff_and_replay_identity(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    let original = sessions::ensure_primary_session_workspace(
        &db,
        fixture.target,
        &fixture.target.to_string(),
        &fixture.channel.to_string(),
        Some("/original"),
        &[],
    )
    .await
    .unwrap();
    let response = fixture.post(&db, Producer::Resource).await.unwrap();
    let before = fixture.child(&db).await;
    assert_eq!(before["status"], "pending");
    assert!(fixture.offers().is_empty());
    let later = sessions::create_channel_session(
        &db,
        fixture.target,
        &fixture.target.to_string(),
        &fixture.channel.to_string(),
        "other",
        Some("/later"),
        &[],
    )
    .await
    .unwrap();
    sessions::set_primary_session(
        &db,
        fixture.target,
        &fixture.channel.to_string(),
        later.session_id,
    )
    .await
    .unwrap();
    fixture.due_and_deliver(&db).await;
    let first = fixture.offers().remove(0);
    assert_eq!(first["session_id"], original.session_id.to_string());
    assert_eq!(first["provider_session_key"], original.provider_session_key);
    assert_eq!(
        first["trigger_message"]["text"],
        "The original proactive instruction"
    );
    assert_eq!(first["context_bundle"]["origin"], "handoff");
    assert_eq!(
        first["context_bundle"]["items"][0]["label"],
        "Manual context"
    );
    sqlx::query(
        "UPDATE messages SET content='Changed after freezing',context_bundle=NULL WHERE msg_id=$1",
    )
    .bind(response["msg_id"].as_str().unwrap())
    .execute(&db)
    .await
    .unwrap();
    fixture.due_and_deliver(&db).await;
    assert_eq!(fixture.offers(), vec![first.clone()]);
    let replay = fixture.post(&db, Producer::Resource).await.unwrap();
    assert_eq!(replay["idempotent_replay"], true);
    assert_eq!(replay["msg_id"], response["msg_id"]);
    assert_eq!(fixture.audit_count(&db).await, 1);
    assert_eq!(fixture.child(&db).await["task_id"], before["task_id"]);
    sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision) VALUES($1,$2,'bot',$3,'prompt','dispatch','deny')")
        .bind(fixture.target.to_string()).bind(fixture.channel.to_string()).bind(fixture.author.to_string()).execute(&db).await.unwrap();
    let grant = server::gateway::task_acceptance::claim(
        &db,
        fixture.target,
        Uuid::new_v4(),
        first["task_id"].as_str().unwrap().parse().unwrap(),
        first["placeholder_msg_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
        fixture.channel,
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert!(matches!(
        grant.status,
        cheers_bridge_protocol::TaskAcceptanceStatus::Rejected
    ));
}

#[sqlx::test]
async fn an_inherited_cancelled_chain_cannot_be_replaced_by_a_fresh_proactive_root(db: PgPool) {
    for producer in [Producer::Send, Producer::Resource] {
        let fixture = Fixture::seed(&db).await;
        let root = Uuid::new_v4();
        let chain = task_chains::start_chain(&db, fixture.channel, root, root)
            .await
            .unwrap();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,is_partial,chain_id) VALUES($1,$2,$3,'bot','',TRUE,$4)")
            .bind(root.to_string()).bind(fixture.channel.to_string()).bind(fixture.author.to_string()).bind(chain.to_string()).execute(&db).await.unwrap();
        task_chains::cancel_chain(&db, &chain.to_string(), Uuid::new_v4())
            .await
            .unwrap();
        fixture.post(&db, producer).await.unwrap();
        assert_eq!(fixture.source(&db).await["chain_id"], chain.to_string());
        let children: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_runs WHERE channel_id=$1")
            .bind(fixture.channel.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(
            children, 0,
            "{producer:?} cannot restart a cancelled inherited cascade"
        );
    }
}

#[sqlx::test]
async fn a_proactive_actor_cannot_hide_an_execution_source_or_its_ledger(db: PgPool) {
    for ledger in [false, true] {
        let fixture = Fixture::seed(&db).await;
        let response = fixture.post(&db, Producer::Resource).await.unwrap();
        let source = response["msg_id"].as_str().unwrap();
        if ledger {
            sqlx::query("INSERT INTO bot_runs(bot_run_id,task_id,channel_id,trigger_msg_id,bot_id,placeholder_msg_id,binding_type,status) VALUES($1,$1,$2,$3,$4,$3,'acp','prepared')")
                .bind(Uuid::new_v4().to_string()).bind(fixture.channel.to_string()).bind(source).bind(fixture.author.to_string()).execute(&db).await.unwrap();
        } else {
            sqlx::query("UPDATE messages SET task_id=$2 WHERE msg_id=$1")
                .bind(source)
                .bind(Uuid::new_v4().to_string())
                .execute(&db)
                .await
                .unwrap();
        }
        fixture.due_and_deliver(&db).await;
        assert!(fixture.offers().is_empty());
        assert!(fixture.child(&db).await["dispatch_input"].is_null());
    }
}

#[sqlx::test]
async fn both_producers_hide_foreign_attachment_metadata_but_keep_same_channel_user_uploads(
    db: PgPool,
) {
    for producer in [Producer::Send, Producer::Resource] {
        let fixture = Fixture::seed(&db).await;
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'fixture')")
            .bind(user.to_string())
            .bind(format!("uploader-{user}"))
            .execute(&db)
            .await
            .unwrap();
        let other = Uuid::new_v4();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name) SELECT $2,workspace_id,'Foreign attachment' FROM channels WHERE channel_id=$1")
            .bind(fixture.channel.to_string()).bind(other.to_string()).execute(&db).await.unwrap();
        let local = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        for (id, channel, name, summary) in [
            (
                local,
                fixture.channel,
                "local-note.txt",
                "Visible local summary",
            ),
            (
                foreign,
                other,
                "Private-foreign.txt",
                "Private foreign synopsis",
            ),
        ] {
            sqlx::query("INSERT INTO file_records(file_id,channel_id,uploader_id,original_path,original_filename,content_type,object_key,status,summary_3lines) VALUES($1,$2,$3,$4,$4,'text/plain',$4,'uploaded',$5)")
                .bind(id.to_string()).bind(channel.to_string()).bind(user.to_string()).bind(name).bind(summary)
                .execute(&db).await.unwrap();
        }
        let mut params = fixture.params();
        params["mention_ids"] = json!([]);
        params["file_ids"] = json!([local, foreign]);
        let response = match producer {
            Producer::Resource => resource::messages::handle_create(
                &db,
                &Principal::bot(fixture.author),
                &params,
                &fixture.locator,
            )
            .await
            .unwrap(),
            Producer::Send => {
                params["client_msg_id"] = json!("attachment-visibility");
                stream::handle_send(
                    &fixture.registry,
                    &fixture.fanout,
                    &db,
                    &fixture.locator,
                    fixture.author,
                    &params,
                )
                .await
                .unwrap();
                fixture
                    .recorded
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|frame| frame.frame_type == "message")
                    .unwrap()
                    .data
                    .clone()
            }
        };
        let files = response["files"].as_array().unwrap();
        let visible = files
            .iter()
            .find(|file| file["file_id"] == local.to_string())
            .unwrap();
        assert_eq!(visible["original_filename"], "local-note.txt");
        assert_eq!(visible["summary"], "Visible local summary");
        let hidden = files
            .iter()
            .find(|file| file["file_id"] == foreign.to_string())
            .unwrap();
        assert_eq!(hidden["status"], "missing");
        assert!(hidden["original_filename"].is_null());
        assert!(hidden["content_type"].is_null());
        assert!(hidden["summary"].is_null());
        assert!(
            !response["files"].to_string().contains("Private"),
            "{producer:?} leaked foreign metadata"
        );
        assert_eq!(
            fixture.source(&db).await["file_ids"],
            json!([local, foreign])
        );
    }
}
