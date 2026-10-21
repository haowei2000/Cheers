//! Human admission and dispatch recovery share the real PostgreSQL transaction.
#![cfg(feature = "integration")]

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::{Notify, Semaphore};
use uuid::Uuid;

use server::domain::{
    messages::{self, CreateMessageParams},
    sessions, task_chains,
};
use server::gateway::{
    dispatch_intents,
    realtime::{fanout::Fanout, frame::WireFrame},
    registry::{BotLocator, BotRegistry, InProcessBotLocator},
    stream::StreamRegistry,
};

struct Fixture {
    user: Uuid,
    channel: Uuid,
    bots: Vec<Uuid>,
}

impl Fixture {
    async fn seed(db: &PgPool, count: usize) -> Self {
        let user = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'fixture')")
            .bind(user.to_string())
            .bind(format!("intent-{user}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Durable intents')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(workspace.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query(
            "INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'intent recovery')",
        )
        .bind(channel.to_string())
        .bind(workspace.to_string())
        .execute(db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')")
            .bind(channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        let mut bots = Vec::new();
        for _ in 0..count {
            let bot = Uuid::new_v4();
            sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor,binding_config) VALUES($1,$2,$3,FALSE,$4)")
                .bind(bot.to_string()).bind(format!("intent-bot-{bot}"))
                .bind(user.to_string()).bind(json!({"acp_security":{"require_capability":false}}))
                .execute(db).await.unwrap();
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
                .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
            bots.push(bot);
        }
        Self {
            user,
            channel,
            bots,
        }
    }

    fn message(&self, msg_id: Uuid) -> CreateMessageParams {
        CreateMessageParams {
            user_id: self.user,
            channel_id: self.channel,
            content: "The original admitted instruction".into(),
            msg_type: None,
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: self.bots.clone(),
            mention_names: vec![],
            session_id: None,
            context_bundle: None,
            msg_id: Some(msg_id),
        }
    }
}

/// Admission sees a ready connector. A failed delivery is a different event:
/// it must retain an admitted offer rather than rejecting the human message.
struct Locator {
    online: AtomicBool,
    capable: AtomicBool,
    block: AtomicBool,
    entered: Notify,
    release: Semaphore,
    offers: Mutex<Vec<Value>>,
}

impl Locator {
    fn ready() -> Arc<Self> {
        Arc::new(Self {
            online: AtomicBool::new(true),
            capable: AtomicBool::new(true),
            block: AtomicBool::new(false),
            entered: Notify::new(),
            release: Semaphore::new(0),
            offers: Mutex::new(Vec::new()),
        })
    }

    fn offers(&self) -> Vec<Value> {
        self.offers.lock().unwrap().clone()
    }
}

#[async_trait]
impl BotLocator for Locator {
    async fn dispatch_task(&self, _bot: Uuid, frame: Value) -> bool {
        self.offers.lock().unwrap().push(frame);
        if self.block.load(Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
        }
        false
    }
    async fn send_data(&self, _bot: Uuid, _frame: Value) -> bool {
        true
    }
    async fn is_online(&self, _bot: Uuid) -> bool {
        self.online.load(Ordering::SeqCst)
    }
    async fn supports_task_acceptance(&self, _bot: Uuid) -> bool {
        self.capable.load(Ordering::SeqCst)
    }
}

/// This is an actual await after commit, not a timing guess or HTTP disconnect.
/// Cancelling it reproduces process loss before the request's delivery step.
struct PostCommitBarrier {
    entered: Notify,
    release: Semaphore,
}

impl PostCommitBarrier {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: Notify::new(),
            release: Semaphore::new(0),
        })
    }
}

#[async_trait]
impl Fanout for PostCommitBarrier {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        if frame.frame_type == "message" && frame.data["sender_type"] == "user" {
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
        }
    }
    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}

fn fanout() -> Arc<dyn Fanout> {
    server::gateway::realtime::fanout::InProcessFanout::new()
}

async fn interrupt_after_commit(db: &PgPool, fixture: &Fixture, params: CreateMessageParams) {
    let bot_ids = fixture
        .bots
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let busy_before: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cheers_sessions WHERE bot_id = ANY($1) AND status='busy'",
    )
    .bind(&bot_ids)
    .fetch_one(db)
    .await
    .unwrap();
    let barrier = PostCommitBarrier::new();
    let entered = barrier.clone();
    let publisher: Arc<dyn Fanout> = barrier;
    let locator: Arc<dyn BotLocator> = Locator::ready();
    let request_db = db.clone();
    let request = tokio::spawn(async move {
        messages::create_message(
            &request_db,
            &publisher,
            &StreamRegistry::new(),
            &locator,
            params,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), entered.entered.notified())
        .await
        .expect("human fanout must be reached after commit");
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    // Admission may reuse a legitimately BUSY session, but must not make an
    // idle chosen session BUSY before any offer is actually prepared.
    let busy: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cheers_sessions WHERE bot_id = ANY($1) AND status='busy'",
    )
    .bind(&bot_ids)
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(
        busy, busy_before,
        "admission must not strand an unstarted BUSY session"
    );
}

async fn runs(db: &PgPool, trigger: Uuid) -> Vec<Value> {
    sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE trigger_msg_id=$1 ORDER BY bot_id")
        .bind(trigger.to_string())
        .fetch_all(db)
        .await
        .unwrap()
}

async fn make_due(db: &PgPool, trigger: Uuid) {
    sqlx::query("UPDATE bot_runs SET next_offer_at=NOW()-INTERVAL '1 second',dispatch_lease_until=NOW()-INTERVAL '1 second' WHERE trigger_msg_id=$1")
        .bind(trigger.to_string()).execute(db).await.unwrap();
}

async fn transaction_failure(db: &PgPool, deferred: bool) {
    let fixture = Fixture::seed(db, 2).await;
    let trigger = Uuid::new_v4();
    // Fail only the second target, so the first bot's intent/session/placeholder
    // must roll back with the human message, mentions, chain and sequence.
    sqlx::query(&format!("CREATE FUNCTION reject_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.bot_id='{}' THEN RAISE EXCEPTION 'injected intent failure'; END IF; RETURN NEW; END $$",fixture.bots[1]))
        .execute(db).await.unwrap();
    let ddl = if deferred {
        "CREATE CONSTRAINT TRIGGER reject_intent AFTER INSERT ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_intent()"
    } else {
        "CREATE TRIGGER reject_intent BEFORE INSERT ON bot_runs FOR EACH ROW EXECUTE FUNCTION reject_intent()"
    };
    sqlx::query(ddl).execute(db).await.unwrap();
    let locator: Arc<dyn BotLocator> = Locator::ready();
    let result = messages::create_message(
        db,
        &fanout(),
        &StreamRegistry::new(),
        &locator,
        fixture.message(trigger),
    )
    .await;
    assert!(result.is_err(), "intent failure must fail human admission");
    for table in [
        "messages",
        "message_mentions",
        "bot_runs",
        "task_chains",
        "cheers_sessions",
        "cheers_session_bindings",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(db)
            .await
            .unwrap();
        assert_eq!(count, 0, "{table} leaked across the failed transaction");
    }
    let clock: i64 = sqlx::query_scalar("SELECT next_seq FROM channels WHERE channel_id=$1")
        .bind(fixture.channel.to_string())
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!(clock, 0);
    sqlx::query("DROP TRIGGER reject_intent ON bot_runs")
        .execute(db)
        .await
        .unwrap();
    messages::create_message(
        db,
        &fanout(),
        &StreamRegistry::new(),
        &locator,
        fixture.message(trigger),
    )
    .await
    .unwrap();
    assert_eq!(
        runs(db, trigger).await.len(),
        2,
        "a clean retry admits both intents"
    );
}

#[sqlx::test]
async fn human_message_and_all_intents_roll_back_on_insert_failure(db: PgPool) {
    transaction_failure(&db, false).await;
}

#[sqlx::test]
async fn human_message_and_all_intents_roll_back_on_commit_failure(db: PgPool) {
    transaction_failure(&db, true).await;
}

#[sqlx::test]
async fn failed_session_creation_rolls_back_the_human_message_and_intent(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    sqlx::query("CREATE FUNCTION reject_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected session failure'; END $$")
        .execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_session BEFORE INSERT ON cheers_sessions FOR EACH ROW EXECUTE FUNCTION reject_session()")
        .execute(&db).await.unwrap();
    let locator: Arc<dyn BotLocator> = Locator::ready();
    let result = messages::create_message(
        &db,
        &fanout(),
        &StreamRegistry::new(),
        &locator,
        fixture.message(Uuid::new_v4()),
    )
    .await;
    assert!(
        result.is_err(),
        "the chosen session is part of admission, not a best-effort postcommit side effect"
    );
    for table in ["messages", "message_mentions", "bot_runs", "task_chains"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0, "session failure leaked {table}");
    }
}

#[sqlx::test]
async fn cancellation_after_human_commit_retains_recoverable_turn(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let trigger = Uuid::new_v4();
    interrupt_after_commit(&db, &fixture, fixture.message(trigger)).await;
    let before = runs(&db, trigger).await;
    assert_eq!(before.len(), 1);
    assert_eq!(before[0]["status"], "pending");
    assert!(before[0]["dispatch_input"].is_object());
    let placeholder = before[0]["placeholder_msg_id"].as_str().unwrap();
    let linked: (bool, Option<String>) =
        sqlx::query_as("SELECT is_partial,chain_id FROM messages WHERE msg_id=$1")
            .bind(placeholder)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(linked.0);
    assert!(
        linked.1.is_some(),
        "pending work remains reachable by existing chain cancellation"
    );
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    let offers = capture.offers();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0]["task_id"], before[0]["task_id"]);
    assert_eq!(
        offers[0]["placeholder_msg_id"],
        before[0]["placeholder_msg_id"]
    );
    assert_eq!(
        offers[0]["trigger_message"]["text"],
        "The original admitted instruction"
    );
    assert_eq!(
        offers[0]["trigger_message"]["sender_name"],
        format!("intent-{}", fixture.user)
    );
    let after = runs(&db, trigger).await;
    assert_eq!(after[0]["task_frame"], offers[0]);
    assert_eq!(after[0]["status"], "prepared");
}

#[sqlx::test]
async fn cancelled_pending_chain_never_offers_a_task(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let trigger = Uuid::new_v4();
    interrupt_after_commit(&db, &fixture, fixture.message(trigger)).await;
    let chain: String = sqlx::query_scalar("SELECT chain_id FROM messages WHERE msg_id=$1")
        .bind(
            runs(&db, trigger).await[0]["placeholder_msg_id"]
                .as_str()
                .unwrap(),
        )
        .fetch_one(&db)
        .await
        .unwrap();
    let cancelled = task_chains::cancel_chain(&db, &chain, fixture.user)
        .await
        .unwrap();
    assert_eq!(
        cancelled.len(),
        1,
        "the ordinary cancel path finds a pending placeholder"
    );
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    assert!(capture.offers().is_empty());
    assert!(runs(&db, trigger).await[0]["dispatch_input"].is_null());
}

#[sqlx::test]
async fn recovery_keeps_the_session_selected_at_admission_after_primary_promotion(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let bot = fixture.bots[0];
    let primary = sessions::ensure_primary_session_workspace(
        &db,
        bot,
        &bot.to_string(),
        &fixture.channel.to_string(),
        Some("/original"),
        &[],
    )
    .await
    .unwrap();
    let other = sessions::create_channel_session(
        &db,
        bot,
        &bot.to_string(),
        &fixture.channel.to_string(),
        "other",
        Some("/promoted"),
        &[],
    )
    .await
    .unwrap();
    let trigger = Uuid::new_v4();
    interrupt_after_commit(&db, &fixture, fixture.message(trigger)).await;
    sessions::set_primary_session(&db, bot, &fixture.channel.to_string(), other.session_id)
        .await
        .unwrap();
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    let offers = capture.offers();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0]["session_id"], primary.session_id.to_string());
    assert_eq!(
        offers[0]["provider_session_key"],
        primary.provider_session_key
    );
}

#[sqlx::test]
async fn an_explicit_other_session_keeps_its_exact_identity_during_recovery(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let bot = fixture.bots[0];
    let target = sessions::create_channel_session(
        &db,
        bot,
        &bot.to_string(),
        &fixture.channel.to_string(),
        "other",
        Some("/target"),
        &[],
    )
    .await
    .unwrap();
    let trigger = Uuid::new_v4();
    let mut params = fixture.message(trigger);
    params.mention_ids.clear();
    params.session_id = Some(target.session_id);
    interrupt_after_commit(&db, &fixture, params).await;
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    let offers = capture.offers();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0]["session_id"], target.session_id.to_string());
    assert_eq!(
        offers[0]["provider_session_key"],
        target.provider_session_key
    );
}

#[sqlx::test]
async fn an_admitted_ui_request_keeps_its_original_action_after_the_source_changes(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let bot = fixture.bots[0];
    let principal = server::resource::Principal::bot(bot);
    let mut document: Value =
        serde_json::from_str(cheers_mcp_server::interactive::EXAMPLE).unwrap();
    let action =
        &mut document["messages"][1]["updateComponents"]["components"][6]["action"]["event"];
    action["name"] = json!("cheers.request");
    action["context"]["botId"] = json!(bot);
    server::resource::fs::handle_write(&db, &principal, &json!({"channel_id":fixture.channel,"path":"forms/report.a2ui.json","content":document.to_string(),"if_version":0})).await.unwrap();
    let event = json!({"v":1,"sourceUri":"cheers:desk/forms/report.a2ui.json","sourceVersion":1,
        "surfaceId":"report","componentId":"prepare","actionId":"report.prepare","botId":bot,
        "invocationId":Uuid::new_v4(),"input":{"topic":"Original accepted topic","includeSources":false}});
    let trigger = Uuid::new_v4();
    let mut params = fixture.message(trigger);
    params.context_bundle = Some(json!({"items":[],"interaction":event}));
    interrupt_after_commit(&db, &fixture, params).await;
    // The valid source now declares a different required payload. It was
    // validated at admission; recovery does not reinterpret the accepted input.
    document["messages"][1]["updateComponents"]["components"][6]["action"]["event"]["context"]
        ["payload"]["includeSources"] = json!(true);
    server::resource::fs::handle_write(&db, &principal, &json!({"channel_id":fixture.channel,"path":"forms/report.a2ui.json","content":document.to_string(),"if_version":1})).await.unwrap();
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    let offers = capture.offers();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0]["context_bundle"]["interaction"], event);
}

#[sqlx::test]
async fn recovery_rechecks_authorization_instead_of_running_a_revoked_human_intent(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let trigger = Uuid::new_v4();
    interrupt_after_commit(&db, &fixture, fixture.message(trigger)).await;
    sqlx::query(
        "UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(fixture.channel.to_string())
    .bind(fixture.user.to_string())
    .execute(&db)
    .await
    .unwrap();
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    assert!(capture.offers().is_empty());
    assert!(runs(&db, trigger).await[0]["dispatch_input"].is_null());
}

#[sqlx::test]
async fn recovery_cannot_offer_context_after_the_target_loses_source_access(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let source = Uuid::new_v4();
    sqlx::query("INSERT INTO channels(channel_id,workspace_id,name) SELECT $2,workspace_id,'Context source' FROM channels WHERE channel_id=$1")
        .bind(fixture.channel.to_string()).bind(source.to_string()).execute(&db).await.unwrap();
    for (id, kind) in [(fixture.user, "user"), (fixture.bots[0], "bot")] {
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,$3,'member')")
            .bind(source.to_string()).bind(id.to_string()).bind(kind).execute(&db).await.unwrap();
    }
    let trigger = Uuid::new_v4();
    let mut params = fixture.message(trigger);
    params.context_bundle = Some(
        json!({"items":[{"verb":"channel.info","params":{"channel_id":source},"label":"Private source"}]}),
    );
    interrupt_after_commit(&db, &fixture, params).await;
    assert_eq!(
        runs(&db, trigger).await[0]["dispatch_input"]["params"]["context_bundle"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
        .bind(source.to_string())
        .bind(fixture.bots[0].to_string())
        .execute(&db)
        .await
        .unwrap();
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    assert!(
        capture.offers().is_empty(),
        "a frozen reference must not preserve revoked source authority"
    );
    assert!(runs(&db, trigger).await[0]["dispatch_input"].is_null());
}

#[sqlx::test]
async fn overlapping_recoverers_share_one_lease_and_retry_the_frozen_offer(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let trigger = Uuid::new_v4();
    interrupt_after_commit(&db, &fixture, fixture.message(trigger)).await;
    let capture = Locator::ready();
    capture.block.store(true, Ordering::SeqCst);
    let locator: Arc<dyn BotLocator> = capture.clone();
    let first = {
        let db = db.clone();
        let locator = locator.clone();
        tokio::spawn(async move {
            dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
                .await
                .unwrap()
        })
    };
    tokio::time::timeout(Duration::from_secs(5), capture.entered.notified())
        .await
        .unwrap();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    assert_eq!(
        capture.offers().len(),
        1,
        "the second worker cannot steal a live lease"
    );
    let frozen = capture.offers()[0].clone();
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    capture.block.store(false, Ordering::SeqCst);
    make_due(&db, trigger).await;
    sqlx::query("UPDATE messages SET content='Edited after the offer was frozen' WHERE msg_id=$1")
        .bind(trigger.to_string())
        .execute(&db)
        .await
        .unwrap();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    assert_eq!(
        capture.offers(),
        vec![frozen.clone(), frozen],
        "lease recovery must not regenerate task IDs or mutable context"
    );
    assert_eq!(runs(&db, trigger).await.len(), 1);
}

#[sqlx::test]
async fn default_bot_offline_at_admission_does_not_create_delayed_work(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    sqlx::query("UPDATE channels SET default_bot_id=$2 WHERE channel_id=$1")
        .bind(fixture.channel.to_string())
        .bind(fixture.bots[0].to_string())
        .execute(&db)
        .await
        .unwrap();
    let capture = Locator::ready();
    capture.online.store(false, Ordering::SeqCst);
    capture.capable.store(false, Ordering::SeqCst);
    let locator: Arc<dyn BotLocator> = capture.clone();
    let trigger = Uuid::new_v4();
    let mut params = fixture.message(trigger);
    params.mention_ids.clear();
    messages::create_message(&db, &fanout(), &StreamRegistry::new(), &locator, params)
        .await
        .unwrap();
    assert!(runs(&db, trigger).await.is_empty());
    capture.online.store(true, Ordering::SeqCst);
    capture.capable.store(true, Ordering::SeqCst);
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    assert!(
        capture.offers().is_empty(),
        "bringing an offline default online must not queue an old human message"
    );
}

#[sqlx::test]
async fn historical_run_tombstones_without_new_input_are_never_recreated(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let task = Uuid::new_v4();
    let placeholder = Uuid::new_v4();
    sqlx::query("INSERT INTO bot_runs(bot_run_id,task_id,channel_id,trigger_msg_id,bot_id,placeholder_msg_id,binding_type,status,next_offer_at) VALUES($1,$2,$3,$4,$5,$6,'acp','prepared',NOW()-INTERVAL '1 day')")
        .bind(Uuid::new_v4().to_string()).bind(task.to_string()).bind(fixture.channel.to_string())
        .bind(Uuid::new_v4().to_string()).bind(fixture.bots[0].to_string()).bind(placeholder.to_string())
        .execute(&db).await.unwrap();
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    assert!(capture.offers().is_empty());
    let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE msg_id=$1")
        .bind(placeholder.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(messages, 0, "an old tombstone is not a recoverable intent");
}

#[sqlx::test]
async fn a_pinned_context_read_failure_retains_input_instead_of_freezing_an_incomplete_prompt(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db, 1).await;
    let principal = server::resource::Principal::bot(fixture.bots[0]);
    for (path, content) in [
        (
            "prompts/convention.md",
            "The required persisted convention.",
        ),
        (
            ".workbench.json",
            "{\"pinned\":[\"prompts/convention.md\"]}",
        ),
    ] {
        server::resource::fs::handle_write(
            &db,
            &principal,
            &json!({"channel_id":fixture.channel,"path":path,"content":content,"if_version":0}),
        )
        .await
        .unwrap();
    }
    let trigger = Uuid::new_v4();
    interrupt_after_commit(&db, &fixture, fixture.message(trigger)).await;
    sqlx::query("ALTER TABLE context_files RENAME TO unavailable_context_files")
        .execute(&db)
        .await
        .unwrap();
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::deliver_trigger(&db, &fanout(), &StreamRegistry::new(), &locator, trigger)
        .await
        .unwrap();
    assert!(capture.offers().is_empty());
    let failed = runs(&db, trigger).await.remove(0);
    assert_eq!(failed["status"], "pending");
    assert!(failed["dispatch_input"].is_object());
    assert!(
        failed["task_frame"].is_null(),
        "a metadata failure must not become a permanent empty prompt snapshot"
    );
    sqlx::query("ALTER TABLE unavailable_context_files RENAME TO context_files")
        .execute(&db)
        .await
        .unwrap();
    make_due(&db, trigger).await;
    dispatch_intents::deliver_trigger(&db, &fanout(), &StreamRegistry::new(), &locator, trigger)
        .await
        .unwrap();
    let offers = capture.offers();
    assert_eq!(offers.len(), 1);
    assert!(offers[0]["pinned"].as_array().unwrap().iter().any(|pin| pin
        .as_str()
        .unwrap()
        .contains("The required persisted convention.")));
    assert_eq!(runs(&db, trigger).await[0]["task_frame"], offers[0]);
}

#[sqlx::test]
async fn both_reclaimers_preserve_pending_and_prepared_intents_until_acceptance(db: PgPool) {
    use server::gateway::{reclaimer, task_acceptance};
    let fixture = Fixture::seed(&db, 1).await;
    let pending = Uuid::new_v4();
    let prepared = Uuid::new_v4();
    interrupt_after_commit(&db, &fixture, fixture.message(pending)).await;
    interrupt_after_commit(&db, &fixture, fixture.message(prepared)).await;
    let sender: Arc<dyn BotLocator> = Locator::ready();
    dispatch_intents::deliver_trigger(&db, &fanout(), &StreamRegistry::new(), &sender, prepared)
        .await
        .unwrap();
    let prepared_run = runs(&db, prepared).await.remove(0);
    assert_eq!(prepared_run["status"], "prepared");
    sqlx::query("UPDATE messages SET created_at=NOW()-INTERVAL '1 day' WHERE is_partial=TRUE")
        .execute(&db)
        .await
        .unwrap();

    let transport = InProcessBotLocator::new();
    let generation = Uuid::new_v4();
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let _supersede = transport.bind_control(fixture.bots[0], generation, tx);
    assert!(transport.unbind_if_connection(fixture.bots[0], generation));
    let locator: Arc<dyn BotLocator> = transport;
    let registry = StreamRegistry::new();
    assert_eq!(reclaimer::sweep_once(&db, &registry, &fanout(), 1).await, 0);
    let disconnected = reclaimer::sweep_bot(
        &db,
        &registry,
        &fanout(),
        &locator,
        fixture.bots[0],
        generation,
    )
    .await;
    assert_eq!(disconnected.reclaimed, 0);
    assert!(!disconnected.retry);
    let partials: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE is_partial=TRUE")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        partials, 2,
        "neither recovery path may erase an unaccepted durable intent"
    );

    let decision = task_acceptance::claim(
        &db,
        fixture.bots[0],
        generation,
        prepared_run["task_id"].as_str().unwrap().parse().unwrap(),
        prepared_run["placeholder_msg_id"]
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
        decision.status,
        cheers_bridge_protocol::TaskAcceptanceStatus::Granted
    ));
    let accepted = runs(&db, prepared).await.remove(0);
    assert!(accepted["dispatch_input"].is_null());
    assert!(accepted["task_frame"].is_null());
    let accepted_cleanup = reclaimer::sweep_bot(
        &db,
        &registry,
        &fanout(),
        &locator,
        fixture.bots[0],
        generation,
    )
    .await;
    assert_eq!(
        accepted_cleanup.reclaimed, 1,
        "accepted work returns to the ordinary offline cleanup policy"
    );
    assert!(!accepted_cleanup.retry);
    assert_eq!(
        reclaimer::sweep_once(&db, &registry, &fanout(), 1).await,
        0,
        "the other pending intent is still recoverable"
    );
}

async fn cancel_prepared_session(db: &PgPool, other_active: bool) {
    let fixture = Fixture::seed(db, 1).await;
    let trigger = Uuid::new_v4();
    interrupt_after_commit(db, &fixture, fixture.message(trigger)).await;
    let locator: Arc<dyn BotLocator> = Locator::ready();
    dispatch_intents::deliver_trigger(db, &fanout(), &StreamRegistry::new(), &locator, trigger)
        .await
        .unwrap();
    let run = runs(db, trigger).await.remove(0);
    let session = run["dispatch_input"]["params"]["session_id"]
        .as_str()
        .unwrap();
    if other_active {
        let other = Uuid::new_v4();
        interrupt_after_commit(db, &fixture, fixture.message(other)).await;
        dispatch_intents::deliver_trigger(db, &fanout(), &StreamRegistry::new(), &locator, other)
            .await
            .unwrap();
        let other_run = runs(db, other).await.remove(0);
        assert_eq!(other_run["dispatch_input"]["params"]["session_id"], session);
        let grant = server::gateway::task_acceptance::claim(
            db,
            fixture.bots[0],
            Uuid::new_v4(),
            other_run["task_id"].as_str().unwrap().parse().unwrap(),
            other_run["placeholder_msg_id"]
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
    }
    let before: String =
        sqlx::query_scalar("SELECT status FROM cheers_sessions WHERE session_id=$1")
            .bind(session)
            .fetch_one(db)
            .await
            .unwrap();
    assert_eq!(before, "busy");
    task_chains::cancel_chain(db, run["chain_id"].as_str().unwrap(), fixture.user)
        .await
        .unwrap();
    make_due(db, trigger).await;
    dispatch_intents::deliver_trigger(db, &fanout(), &StreamRegistry::new(), &locator, trigger)
        .await
        .unwrap();
    let after: String =
        sqlx::query_scalar("SELECT status FROM cheers_sessions WHERE session_id=$1")
            .bind(session)
            .fetch_one(db)
            .await
            .unwrap();
    assert_eq!(after, if other_active { "busy" } else { "idle" });
    assert!(runs(db, trigger).await[0]["dispatch_input"].is_null());
}

#[sqlx::test]
async fn cancelling_prepared_work_returns_its_unused_session_to_idle(db: PgPool) {
    cancel_prepared_session(&db, false).await;
}

#[sqlx::test]
async fn cancelling_one_prepared_turn_preserves_another_accepted_turns_busy_session(db: PgPool) {
    cancel_prepared_session(&db, true).await;
}

#[sqlx::test]
async fn previously_persisted_v1_human_input_still_recovers_and_accepts(db: PgPool) {
    let fixture = Fixture::seed(&db, 1).await;
    let trigger = Uuid::new_v4();
    interrupt_after_commit(&db, &fixture, fixture.message(trigger)).await;
    let current = runs(&db, trigger).await.remove(0);
    assert_eq!(current["dispatch_input"]["version"], 2);
    let input = &current["dispatch_input"];
    let historical = json!({"version":1,"author_id":input["actor"]["author_id"],
        "params":input["params"],"trigger_message":input["trigger_message"],"file_ids":input["file_ids"]});
    sqlx::query("UPDATE bot_runs SET dispatch_input=$2 WHERE trigger_msg_id=$1")
        .bind(trigger.to_string())
        .bind(historical)
        .execute(&db)
        .await
        .unwrap();
    let capture = Locator::ready();
    let locator: Arc<dyn BotLocator> = capture.clone();
    dispatch_intents::recover_once(&db, &fanout(), &StreamRegistry::new(), &locator)
        .await
        .unwrap();
    let task = capture.offers().remove(0);
    assert_eq!(task["task_id"], current["task_id"]);
    assert_eq!(
        task["trigger_message"]["text"],
        "The original admitted instruction"
    );
    let grant = server::gateway::task_acceptance::claim(
        &db,
        fixture.bots[0],
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
}
