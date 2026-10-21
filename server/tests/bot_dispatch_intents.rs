//! A terminal receipt and its admitted bot children share one PG commit.
#![cfg(feature = "integration")]

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::Notify;
use uuid::Uuid;

use server::{
    domain::{sessions, task_chains},
    gateway::{
        dispatch_intents,
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        stream::{self, StreamEntry, StreamRegistry, TerminalError, TerminalOutcome},
    },
};

struct Locator {
    ready: AtomicBool,
    offers: Mutex<Vec<Value>>,
}

impl Locator {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            ready: AtomicBool::new(true),
            offers: Mutex::new(vec![]),
        })
    }
    fn take(&self) -> Vec<Value> {
        std::mem::take(&mut *self.offers.lock().unwrap())
    }
}

#[async_trait]
impl BotLocator for Locator {
    async fn dispatch_task(&self, _bot: Uuid, frame: Value) -> bool {
        self.offers.lock().unwrap().push(frame);
        false // admitted while ready, disconnected before the actual enqueue
    }
    async fn send_data(&self, _bot: Uuid, _frame: Value) -> bool {
        true
    }
    async fn is_online(&self, _bot: Uuid) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    async fn supports_task_acceptance(&self, _bot: Uuid) -> bool {
        self.ready.load(Ordering::SeqCst)
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

struct PostCommitBarrier {
    entered: Notify,
}

#[async_trait]
impl Fanout for PostCommitBarrier {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        if frame.frame_type == "message_done" {
            self.entered.notify_one();
            std::future::pending::<()>().await;
        }
    }
    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}

struct Turn {
    channel: Uuid,
    author: Uuid,
    targets: Vec<Uuid>,
    parent: Uuid,
    task: Uuid,
    execution: Uuid,
    chain: Uuid,
    session: sessions::SessionHandle,
    registry: Arc<StreamRegistry>,
    capture: Arc<Locator>,
    locator: Arc<dyn BotLocator>,
    recorded: Arc<RecordingFanout>,
    fanout: Arc<dyn Fanout>,
}

impl Turn {
    async fn seed(db: &PgPool, targets: usize) -> Self {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let trigger = Uuid::new_v4();
        let parent = Uuid::new_v4();
        let task = Uuid::new_v4();
        let execution = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Durable bot handoff')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name,next_seq) VALUES($1,$2,'handoffs',1)")
            .bind(channel.to_string()).bind(workspace.to_string()).execute(db).await.unwrap();
        let mut bots = Vec::new();
        for _ in 0..=targets {
            let bot = Uuid::new_v4();
            sqlx::query("INSERT INTO bot_accounts(bot_id,username,external_processor,binding_config) VALUES($1,$2,FALSE,$3)")
                .bind(bot.to_string()).bind(format!("handoff-{bot}"))
                .bind(json!({"acp_security":{"require_capability":false}})).execute(db).await.unwrap();
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
                .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
            bots.push(bot);
        }
        let author = bots.remove(0);
        let session = sessions::ensure_primary_session_workspace(
            db,
            author,
            &author.to_string(),
            &channel.to_string(),
            Some("/parent"),
            &[],
        )
        .await
        .unwrap();
        sessions::touch_session(db, session.session_id)
            .await
            .unwrap();
        // No human trigger is needed for this fixture's terminal contract; the
        // parent has an actual accepted run, channel clock and cancellable chain.
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_type,sender_id,content,msg_type,channel_seq) VALUES($1,$2,'bot',$3,'The previous instruction','text',1)")
            .bind(trigger.to_string()).bind(channel.to_string()).bind(author.to_string()).execute(db).await.unwrap();
        let chain = task_chains::start_chain(db, channel, task, trigger)
            .await
            .unwrap();
        sqlx::query("INSERT INTO messages(msg_id,task_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,depth,chain_id,in_reply_to_msg_id,content_data,context_bundle) VALUES($1,$2,$3,'bot',$4,'','text',TRUE,0,$5,$6,$7,$8)")
            .bind(parent.to_string()).bind(task.to_string()).bind(channel.to_string()).bind(author.to_string())
            .bind(chain.to_string()).bind(trigger.to_string())
            .bind(json!({"session_id":session.session_id}))
            .bind(json!({"origin":"bot","items":[{"verb":"channel.info","params":{"channel_id":channel},"label":"Manual pick"}]}))
            .execute(db).await.unwrap();
        sqlx::query("INSERT INTO bot_runs(bot_run_id,task_id,channel_id,trigger_msg_id,bot_id,placeholder_msg_id,binding_type,status,chain_id,execution_id,execution_connection_id,accepted_at) VALUES($1,$1,$2,$3,$4,$5,'acp','accepted',$6,$7,$8,NOW())")
            .bind(task.to_string()).bind(channel.to_string()).bind(trigger.to_string())
            .bind(author.to_string()).bind(parent.to_string()).bind(chain.to_string())
            .bind(execution.to_string()).bind(Uuid::new_v4().to_string()).execute(db).await.unwrap();
        let registry = StreamRegistry::new();
        registry.register(StreamEntry {
            msg_id: parent,
            bot_id: author,
            channel_id: channel,
            task_id: task,
            trigger_msg_id: trigger,
            session_id: Some(session.session_id),
            finalized: false,
            last_touched_ms: Default::default(),
        });
        let capture = Locator::new();
        let recorded = Arc::new(RecordingFanout::default());
        Self {
            channel,
            author,
            targets: bots,
            parent,
            task,
            execution,
            chain,
            session,
            registry,
            locator: capture.clone(),
            capture,
            fanout: recorded.clone(),
            recorded,
        }
    }

    fn frame(&self) -> Value {
        json!({"type":"done","v":1,"client_msg_id":self.parent,"msg_id":self.parent,
            "content":"The immutable parent result","mention_ids":self.targets,
            "provider_session_key":self.session.provider_session_key,"session_id":self.session.session_id,
            "execution":{"task_id":self.task,"execution_id":self.execution,"channel_id":self.channel}})
    }

    async fn submit(&self, db: &PgPool, frame: &Value) -> Result<TerminalOutcome, TerminalError> {
        stream::handle_done(
            &self.registry,
            &self.fanout,
            db,
            &self.locator,
            self.author,
            &self.author.to_string(),
            frame,
        )
        .await
    }

    async fn done(&self, db: &PgPool) -> Result<TerminalOutcome, TerminalError> {
        self.submit(db, &self.frame()).await
    }

    async fn children(&self, db: &PgPool) -> Vec<Value> {
        sqlx::query_scalar(
            "SELECT to_jsonb(r) FROM bot_runs r WHERE trigger_msg_id=$1 ORDER BY bot_id",
        )
        .bind(self.parent.to_string())
        .fetch_all(db)
        .await
        .unwrap()
    }

    async fn parent_run(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE task_id=$1")
            .bind(self.task.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn audit(&self, db: &PgPool) -> Vec<Value> {
        sqlx::query_scalar("SELECT payload FROM acp_event_log WHERE channel_id=$1 AND name='dispatch' ORDER BY bot_id")
            .bind(self.channel.to_string()).fetch_all(db).await.unwrap()
    }

    async fn due(&self, db: &PgPool) {
        sqlx::query("UPDATE bot_runs SET next_offer_at=NOW()-INTERVAL '1 second',dispatch_lease_id=NULL,dispatch_lease_until=NULL WHERE trigger_msg_id=$1")
            .bind(self.parent.to_string()).execute(db).await.unwrap();
    }

    async fn recover(&self, db: &PgPool) {
        self.due(db).await;
        dispatch_intents::deliver_trigger(
            db,
            &self.fanout,
            &self.registry,
            &self.locator,
            self.parent,
        )
        .await
        .unwrap();
    }
}

async fn pause_after_commit(db: &PgPool, turn: &mut Turn) {
    let barrier = Arc::new(PostCommitBarrier {
        entered: Notify::new(),
    });
    let (registry, fanout, locator, db, author, frame) = (
        turn.registry.clone(),
        barrier.clone() as Arc<dyn Fanout>,
        turn.locator.clone(),
        db.clone(),
        turn.author,
        turn.frame(),
    );
    let request = tokio::spawn(async move {
        stream::handle_done(
            &registry,
            &fanout,
            &db,
            &locator,
            author,
            &author.to_string(),
            &frame,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), barrier.entered.notified())
        .await
        .expect("terminal fanout follows the shared commit");
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
}

async fn fault_child_admission(db: &PgPool, deferred: bool) {
    let turn = Turn::seed(db, 2).await;
    sqlx::query(&format!("CREATE FUNCTION reject_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.trigger_msg_id='{}' THEN RAISE EXCEPTION 'injected child admission failure'; END IF; RETURN NEW; END $$",turn.parent))
        .execute(db).await.unwrap();
    sqlx::query(if deferred {
        "CREATE CONSTRAINT TRIGGER reject_child AFTER INSERT ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_child()"
    } else {
        "CREATE TRIGGER reject_child BEFORE INSERT ON bot_runs FOR EACH ROW EXECUTE FUNCTION reject_child()"
    }).execute(db).await.unwrap();
    for _ in 0..2 {
        assert!(turn.done(db).await.is_err());
        let parent: (bool, Option<i64>) =
            sqlx::query_as("SELECT is_partial,channel_seq FROM messages WHERE msg_id=$1")
                .bind(turn.parent.to_string())
                .fetch_one(db)
                .await
                .unwrap();
        assert_eq!(parent, (true, None));
        let clock: i64 = sqlx::query_scalar("SELECT next_seq FROM channels WHERE channel_id=$1")
            .bind(turn.channel.to_string())
            .fetch_one(db)
            .await
            .unwrap();
        assert_eq!(clock, 1);
        assert!(turn.parent_run(db).await["terminal_committed_at"].is_null());
        assert!(turn.children(db).await.is_empty());
        assert!(
            turn.audit(db).await.is_empty(),
            "audit is part of admission, not a precommit side effect"
        );
        assert!(turn.recorded.0.lock().unwrap().is_empty());
        let target_sessions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM cheers_sessions WHERE bot_id=ANY($1)")
                .bind(
                    turn.targets
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>(),
                )
                .fetch_one(db)
                .await
                .unwrap();
        assert_eq!(target_sessions, 0);
        assert!(
            turn.registry.contains(turn.parent),
            "failed child admission releases the parent finalization claim"
        );
    }
    sqlx::query("DROP TRIGGER reject_child ON bot_runs")
        .execute(db)
        .await
        .unwrap();
    assert!(matches!(
        turn.done(db).await.unwrap(),
        TerminalOutcome::Committed
    ));
    assert_eq!(turn.children(db).await.len(), 2);
    assert_eq!(turn.audit(db).await.len(), 2);
    assert!(!turn.parent_run(db).await["terminal_committed_at"].is_null());
    let mut remaining = 0;
    while server::infra::ratelimit::bot_dispatch_limiter().try_hit(&turn.channel.to_string()) {
        remaining += 1;
    }
    assert_eq!(
        remaining, 28,
        "two stable children consume two slots across failed and successful attempts"
    );
}

#[sqlx::test]
async fn child_insert_failure_rolls_back_parent_result_receipt_and_every_child(db: PgPool) {
    fault_child_admission(&db, false).await;
}

#[sqlx::test]
async fn child_commit_failure_rolls_back_parent_result_receipt_and_every_child(db: PgPool) {
    fault_child_admission(&db, true).await;
}

#[sqlx::test]
async fn cancelling_after_parent_commit_leaves_a_recoverable_fixed_child(db: PgPool) {
    let mut turn = Turn::seed(&db, 1).await;
    let target = turn.targets[0];
    let original = sessions::ensure_primary_session_workspace(
        &db,
        target,
        &target.to_string(),
        &turn.channel.to_string(),
        Some("/child-original"),
        &[],
    )
    .await
    .unwrap();
    sqlx::query("UPDATE messages SET chain_id=NULL WHERE msg_id=$1")
        .bind(turn.parent.to_string())
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE bot_runs SET chain_id=NULL WHERE task_id=$1")
        .bind(turn.task.to_string())
        .execute(&db)
        .await
        .unwrap();
    pause_after_commit(&db, &mut turn).await;
    let before = turn.children(&db).await.remove(0);
    let parent_chain: String = sqlx::query_scalar("SELECT chain_id FROM messages WHERE msg_id=$1")
        .bind(turn.parent.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(turn.parent_run(&db).await["chain_id"], parent_chain);
    assert_eq!(before["chain_id"], parent_chain);
    assert_ne!(
        parent_chain,
        turn.chain.to_string(),
        "an untracked parent gains a new cancellable root"
    );
    assert_eq!(before["status"], "pending");
    assert_eq!(before["dispatch_input"]["actor"]["type"], "bot");
    assert_eq!(
        before["dispatch_input"]["actor"]["parent_task_id"],
        turn.task.to_string()
    );
    assert_eq!(
        before["dispatch_input"]["actor"]["parent_execution_id"],
        turn.execution.to_string()
    );
    assert!(!turn.parent_run(&db).await["terminal_committed_at"].is_null());
    assert!(turn.capture.take().is_empty());
    let later = sessions::create_channel_session(
        &db,
        target,
        &target.to_string(),
        &turn.channel.to_string(),
        "other",
        Some("/later"),
        &[],
    )
    .await
    .unwrap();
    sessions::set_primary_session(&db, target, &turn.channel.to_string(), later.session_id)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE messages SET content='Changed parent text',context_bundle=NULL WHERE msg_id=$1",
    )
    .bind(turn.parent.to_string())
    .execute(&db)
    .await
    .unwrap();
    turn.recover(&db).await;
    let frame = turn.capture.take().remove(0);
    assert_eq!(frame["task_id"], before["task_id"]);
    assert_eq!(frame["placeholder_msg_id"], before["placeholder_msg_id"]);
    assert_eq!(
        frame["trigger_message"]["text"],
        "The immutable parent result"
    );
    assert_eq!(frame["session_id"], original.session_id.to_string());
    assert_eq!(frame["provider_session_key"], original.provider_session_key);
    assert_eq!(frame["context_bundle"]["origin"], "handoff");
    let items = frame["context_bundle"]["items"].as_array().unwrap();
    assert_eq!(items[0]["label"], "Manual pick");
    assert!(items.iter().any(|item| item["verb"] == "channel.plan.read"));
    assert!(items
        .iter()
        .any(|item| item["verb"] == "channel.activity.read"));
    assert_eq!(turn.audit(&db).await.len(), 1);
}

#[sqlx::test]
async fn terminal_replay_and_offer_retries_do_not_re_admit_or_spend_more_loop_budget(db: PgPool) {
    let mut turn = Turn::seed(&db, 1).await;
    pause_after_commit(&db, &mut turn).await;
    let original = turn.children(&db).await.remove(0);
    let audit = turn.audit(&db).await;
    assert!(matches!(
        turn.done(&db).await.unwrap(),
        TerminalOutcome::Replayed
    ));
    assert!(turn.capture.take().is_empty());
    for _ in 0..3 {
        turn.recover(&db).await;
    }
    let offers = turn.capture.take();
    assert_eq!(offers.len(), 3);
    assert!(offers.iter().all(|offer| offer == &offers[0]));
    assert_eq!(offers[0]["task_id"], original["task_id"]);
    assert_eq!(turn.children(&db).await.len(), 1);
    assert_eq!(turn.audit(&db).await, audit);
    let limiter = server::infra::ratelimit::bot_dispatch_limiter();
    let mut remaining = 0;
    while limiter.try_hit(&turn.channel.to_string()) {
        remaining += 1;
    }
    assert_eq!(
        remaining, 29,
        "only the original child admission consumes a loop-budget slot"
    );
}

async fn deny_dispatch(db: &PgPool, turn: &Turn) {
    sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision) VALUES($1,$2,'bot',$3,'prompt','dispatch','deny')")
        .bind(turn.targets[0].to_string()).bind(turn.channel.to_string()).bind(turn.author.to_string()).execute(db).await.unwrap();
}

#[sqlx::test]
async fn dispatch_denial_at_admission_commits_parent_with_only_one_deny_audit(db: PgPool) {
    let turn = Turn::seed(&db, 1).await;
    deny_dispatch(&db, &turn).await;
    assert!(matches!(
        turn.done(&db).await.unwrap(),
        TerminalOutcome::Committed
    ));
    assert!(turn.children(&db).await.is_empty());
    let audit = turn.audit(&db).await;
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0]["decision"], "deny");
    assert!(matches!(
        turn.done(&db).await.unwrap(),
        TerminalOutcome::Replayed
    ));
    assert_eq!(turn.audit(&db).await, audit);
}

#[sqlx::test]
async fn pending_children_recheck_dispatch_author_target_and_chain_authority(db: PgPool) {
    for denial in ["dispatch", "author", "target", "chain"] {
        let mut turn = Turn::seed(&db, 1).await;
        pause_after_commit(&db, &mut turn).await;
        let audit = turn.audit(&db).await;
        match denial {
            "dispatch" => deny_dispatch(&db, &turn).await,
            "author" | "target" => {
                let bot = if denial == "author" {
                    turn.author
                } else {
                    turn.targets[0]
                };
                sqlx::query("UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2 AND member_type='bot'")
                    .bind(turn.channel.to_string()).bind(bot.to_string()).execute(&db).await.unwrap();
            }
            "chain" => {
                task_chains::cancel_chain(&db, &turn.chain.to_string(), Uuid::new_v4())
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        turn.recover(&db).await;
        assert!(
            turn.capture.take().is_empty(),
            "{denial} revocation must not offer a child"
        );
        assert!(
            turn.children(&db).await[0]["dispatch_input"].is_null(),
            "{denial} denial ends recovery"
        );
        assert_eq!(
            turn.audit(&db).await,
            audit,
            "a worker check is not a new admission decision"
        );
    }
}

#[sqlx::test]
async fn self_mentions_depth_limit_and_unready_targets_never_admit_children(db: PgPool) {
    for gate in ["self", "depth", "offline", "closed_primary"] {
        let turn = Turn::seed(&db, 1).await;
        let mut frame = turn.frame();
        match gate {
            "self" => frame["mention_ids"] = json!([turn.author]),
            "depth" => {
                sqlx::query("UPDATE messages SET depth=5 WHERE msg_id=$1")
                    .bind(turn.parent.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "offline" => turn.capture.ready.store(false, Ordering::SeqCst),
            "closed_primary" => {
                let target = turn.targets[0];
                let session = sessions::ensure_primary_session_workspace(
                    &db,
                    target,
                    &target.to_string(),
                    &turn.channel.to_string(),
                    None,
                    &[],
                )
                .await
                .unwrap();
                sqlx::query("UPDATE cheers_sessions SET status='terminated' WHERE session_id=$1")
                    .bind(session.session_id.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(matches!(
            turn.submit(&db, &frame).await.unwrap(),
            TerminalOutcome::Committed
        ));
        assert!(
            turn.children(&db).await.is_empty(),
            "{gate} must not admit child work"
        );
        if gate == "closed_primary" {
            let audit = turn.audit(&db).await;
            assert_eq!(audit.len(), 1);
            assert_eq!(audit[0]["reason"], "session_unavailable");
        } else {
            assert!(turn.audit(&db).await.is_empty());
        }
        let sessions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM cheers_sessions WHERE bot_id=ANY($1)")
                .bind(
                    turn.targets
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>(),
                )
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(
            sessions,
            i64::from(gate == "closed_primary"),
            "{gate} must not allocate a target session"
        );
    }
}

#[sqlx::test]
async fn accepted_children_are_excluded_from_recovery_and_cannot_gain_a_second_execution(
    db: PgPool,
) {
    let mut turn = Turn::seed(&db, 1).await;
    pause_after_commit(&db, &mut turn).await;
    turn.recover(&db).await;
    let child = turn.capture.take().remove(0);
    let execution = Uuid::new_v4();
    let connection = Uuid::new_v4();
    let task = child["task_id"].as_str().unwrap().parse().unwrap();
    let placeholder = child["placeholder_msg_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let grant = server::gateway::task_acceptance::claim(
        &db,
        turn.targets[0],
        connection,
        task,
        placeholder,
        turn.channel,
        execution,
    )
    .await
    .unwrap();
    assert!(matches!(
        grant.status,
        cheers_bridge_protocol::TaskAcceptanceStatus::Granted
    ));
    assert!(turn.children(&db).await[0]["dispatch_input"].is_null());
    turn.recover(&db).await;
    assert!(turn.capture.take().is_empty());
    let duplicate = server::gateway::task_acceptance::claim(
        &db,
        turn.targets[0],
        Uuid::new_v4(),
        task,
        placeholder,
        turn.channel,
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert!(matches!(
        duplicate.status,
        cheers_bridge_protocol::TaskAcceptanceStatus::Owned
    ));
    assert!(matches!(
        turn.done(&db).await.unwrap(),
        TerminalOutcome::Replayed
    ));
    assert_eq!(turn.children(&db).await.len(), 1);
    assert_eq!(turn.audit(&db).await.len(), 1);
}

#[sqlx::test]
async fn a_prepared_child_cannot_accept_after_dispatch_permission_is_revoked(db: PgPool) {
    let mut turn = Turn::seed(&db, 1).await;
    pause_after_commit(&db, &mut turn).await;
    turn.recover(&db).await;
    let frame = turn.capture.take().remove(0);
    deny_dispatch(&db, &turn).await;
    let grant = server::gateway::task_acceptance::claim(
        &db,
        turn.targets[0],
        Uuid::new_v4(),
        frame["task_id"].as_str().unwrap().parse().unwrap(),
        frame["placeholder_msg_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
        turn.channel,
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert!(matches!(
        grant.status,
        cheers_bridge_protocol::TaskAcceptanceStatus::Rejected
    ));
    assert!(turn.children(&db).await[0]["execution_id"].is_null());
    assert_eq!(
        turn.audit(&db).await.len(),
        1,
        "grant reauthorization is not another admission audit"
    );
}

#[sqlx::test]
async fn a_bot_intent_requires_the_original_parent_task_execution_and_done_receipt(db: PgPool) {
    for corrupted in ["parent_task_id", "parent_execution_id", "receipt"] {
        let mut turn = Turn::seed(&db, 1).await;
        pause_after_commit(&db, &mut turn).await;
        if corrupted == "receipt" {
            sqlx::query("UPDATE bot_runs SET terminal_committed_at=NULL WHERE task_id=$1")
                .bind(turn.task.to_string())
                .execute(&db)
                .await
                .unwrap();
        } else {
            let mut input = turn.children(&db).await[0]["dispatch_input"].clone();
            input["actor"][corrupted] = json!(Uuid::new_v4());
            sqlx::query("UPDATE bot_runs SET dispatch_input=$2 WHERE trigger_msg_id=$1")
                .bind(turn.parent.to_string())
                .bind(input)
                .execute(&db)
                .await
                .unwrap();
        }
        turn.recover(&db).await;
        assert!(
            turn.capture.take().is_empty(),
            "invalid {corrupted} must not offer a child"
        );
        assert!(turn.children(&db).await[0]["dispatch_input"].is_null());
        assert_eq!(turn.audit(&db).await.len(), 1);
    }
}
