//! Abandonment is a real execution settlement, without inventing a bot result.
#![cfg(feature = "integration")]

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use cheers_bridge_protocol::TaskAcceptanceStatus;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::mpsc;
use uuid::Uuid;

use server::{
    domain::{
        messages::{self, CreateMessageParams},
        sessions,
        task_claims::{self, ClaimDecision, ResolveClaimParams},
    },
    gateway::{
        dispatch_intents,
        realtime::{fanout::Fanout, frame::WireFrame},
        reclaimer::{self, ReclaimReport},
        registry::{BotLocator, BotRegistry, InProcessBotLocator},
        stream::{self, StreamRegistry, TerminalError, TerminalOutcome},
        task_acceptance,
    },
    resource::{self, Principal},
};

#[derive(Default)]
struct Events(Mutex<Vec<WireFrame>>);

#[async_trait]
impl Fanout for Events {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        self.0.lock().unwrap().push(frame);
    }

    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}

impl Events {
    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }

    fn snapshot(&self) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|frame| {
                json!({"type":frame.frame_type,"channel_id":frame.channel_id,"data":frame.data})
            })
            .collect()
    }

    fn count(&self, kind: &str) -> usize {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame.frame_type == kind)
            .count()
    }
}

struct Turn {
    message: Uuid,
    task: Uuid,
    execution: Option<Uuid>,
    claim: Option<Uuid>,
    confirmation: Option<Uuid>,
}

struct Fixture {
    user: Uuid,
    bot: Uuid,
    channel: Uuid,
    source: Uuid,
    session: Uuid,
    connection: Uuid,
    binding: Arc<InProcessBotLocator>,
    locator: Arc<dyn BotLocator>,
    control_rx: tokio::sync::Mutex<mpsc::Receiver<Value>>,
    _data_rx: mpsc::Receiver<Value>,
    registry: Arc<StreamRegistry>,
    events: Arc<Events>,
    fanout: Arc<dyn Fanout>,
}

impl Fixture {
    async fn seed(db: &PgPool) -> Self {
        let (user, bot, workspace, channel, source, connection) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'fixture')")
            .bind(user.to_string())
            .bind(format!("abandoned-user-{user}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Abandoned executions')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(workspace.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name,next_seq) VALUES($1,$2,'abandoned',1)")
            .bind(channel.to_string()).bind(workspace.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor,binding_type,binding_config) VALUES($1,$2,$3,FALSE,'acp',$4)")
            .bind(bot.to_string()).bind(format!("abandoned-bot-{bot}")).bind(user.to_string())
            .bind(json!({"acp_security":{"require_capability":false}})).execute(db).await.unwrap();
        for (member, kind) in [(user, "user"), (bot, "bot")] {
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,$3,'member')")
                .bind(channel.to_string()).bind(member.to_string()).bind(kind).execute(db).await.unwrap();
        }
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,channel_seq) VALUES($1,$2,'user',$3,'Please investigate this abandoned execution','text',FALSE,1)")
            .bind(source.to_string()).bind(channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        let session = sessions::ensure_primary_session_workspace(
            db,
            bot,
            &bot.to_string(),
            &channel.to_string(),
            Some("/abandoned-workspace"),
            &[],
        )
        .await
        .unwrap()
        .session_id;
        let binding = InProcessBotLocator::new();
        let (control_tx, control_rx) = mpsc::channel(16);
        let (data_tx, data_rx) = mpsc::channel(16);
        let _supersede = binding.bind_control(bot, connection, control_tx);
        binding.bind_data(bot, Uuid::new_v4(), data_tx);
        assert!(binding.set_task_acceptance(bot, connection, true));
        let events = Arc::new(Events::default());
        Self {
            user,
            bot,
            channel,
            source,
            session,
            connection,
            locator: binding.clone(),
            binding,
            control_rx: tokio::sync::Mutex::new(control_rx),
            _data_rx: data_rx,
            registry: StreamRegistry::new(),
            fanout: events.clone(),
            events,
        }
    }

    async fn offered(&self) -> Value {
        tokio::time::timeout(Duration::from_secs(5), self.control_rx.lock().await.recv())
            .await
            .expect("the real worker must offer the task")
            .unwrap()
    }

    async fn human(&self, db: &PgPool, accept: bool) -> Turn {
        messages::create_message(
            db,
            &self.fanout,
            &self.registry,
            &self.locator,
            CreateMessageParams {
                user_id: self.user,
                channel_id: self.channel,
                content: "Please complete a normal human task".into(),
                msg_type: None,
                reply_to_msg_id: None,
                file_ids: vec![],
                mention_ids: vec![self.bot],
                mention_names: vec![],
                session_id: Some(self.session),
                context_bundle: None,
                msg_id: None,
            },
        )
        .await
        .unwrap();
        let frame = self.offered().await;
        let mut turn = Turn {
            message: frame["placeholder_msg_id"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            task: frame["task_id"].as_str().unwrap().parse().unwrap(),
            execution: None,
            claim: None,
            confirmation: None,
        };
        if accept {
            self.accept(db, &mut turn).await;
        }
        self.age(db, turn.message).await;
        turn
    }

    async fn legacy_partial(&self, db: &PgPool) -> Turn {
        let message = Uuid::new_v4();
        // Historical partials without a run remain reclaimable. Their real
        // channel-bound session is not an invented execution grant.
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,is_partial,in_reply_to_msg_id,content_data,created_at) VALUES($1,$2,$3,'bot','','text',TRUE,$4,$5,NOW()-INTERVAL '1 hour')")
            .bind(message.to_string()).bind(self.channel.to_string()).bind(self.bot.to_string())
            .bind(self.source.to_string()).bind(json!({"session_id":self.session}))
            .execute(db).await.unwrap();
        sessions::touch_session(db, self.session).await.unwrap();
        Turn {
            message,
            task: Uuid::new_v4(),
            execution: None,
            claim: None,
            confirmation: None,
        }
    }

    async fn claim(&self, db: &PgPool, prepare: bool, accept: bool) -> Turn {
        let evaluation = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channel_bot_monitoring(channel_id,bot_id,mode,next_eligible_at) VALUES($1,$2,'text',NOW()+INTERVAL '1 day')",
        )
        .bind(self.channel.to_string())
        .bind(self.bot.to_string())
        .execute(db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO task_claim_evaluations(evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to,status,dispatched_at) VALUES($1,$2,$3,1,1,'dispatched',NOW())")
            .bind(evaluation.to_string()).bind(self.channel.to_string()).bind(self.bot.to_string()).execute(db).await.unwrap();
        let pending = resource::task_claims::handle_evaluate(
            db,
            &Principal::bot(self.bot),
            &json!({"channel_id":self.channel,"evaluation_id":evaluation,"decision":"claim","confidence":1.0}),
        )
        .await
        .unwrap();
        let claim = pending["claim_id"].as_str().unwrap().parse().unwrap();
        let approved = task_claims::resolve(
            db,
            self.locator.as_ref(),
            ResolveClaimParams {
                channel_id: self.channel,
                claim_id: claim,
                requester_id: self.user,
                decision: ClaimDecision::Accept,
                note: Some("Approve real recovery fixture".into()),
            },
        )
        .await
        .unwrap();
        let message = approved.execution_msg_id.unwrap();
        let task: String =
            sqlx::query_scalar("SELECT task_id FROM bot_runs WHERE placeholder_msg_id=$1")
                .bind(message.to_string())
                .fetch_one(db)
                .await
                .unwrap();
        let mut turn = Turn {
            message,
            task: task.parse().unwrap(),
            execution: None,
            claim: Some(claim),
            confirmation: Some(
                pending["confirmation_message"]["msg_id"]
                    .as_str()
                    .unwrap()
                    .parse()
                    .unwrap(),
            ),
        };
        if prepare {
            assert_eq!(
                dispatch_intents::deliver_trigger(
                    db,
                    &self.fanout,
                    &self.registry,
                    &self.locator,
                    approved.trigger_msg_id.unwrap()
                )
                .await
                .unwrap(),
                1
            );
            let offered = self.offered().await;
            assert_eq!(offered["task_id"], turn.task.to_string());
        }
        if accept {
            assert!(prepare);
            self.accept(db, &mut turn).await;
        }
        self.age(db, message).await;
        turn
    }

    async fn accept(&self, db: &PgPool, turn: &mut Turn) {
        let execution = Uuid::new_v4();
        let decision = self.grant(db, turn, execution).await;
        assert_eq!(decision.status, TaskAcceptanceStatus::Granted);
        turn.execution = Some(execution);
    }

    async fn grant(&self, db: &PgPool, turn: &Turn, execution: Uuid) -> task_acceptance::Decision {
        task_acceptance::claim(
            db,
            self.bot,
            self.connection,
            turn.task,
            turn.message,
            self.channel,
            execution,
        )
        .await
        .unwrap()
    }

    async fn age(&self, db: &PgPool, message: Uuid) {
        sqlx::query("UPDATE messages SET created_at=NOW()-INTERVAL '1 hour' WHERE msg_id=$1")
            .bind(message.to_string())
            .execute(db)
            .await
            .unwrap();
    }

    fn offline(&self) {
        assert!(self.binding.unbind_if_connection(self.bot, self.connection));
    }

    async fn sweep(&self, db: &PgPool) -> ReclaimReport {
        reclaimer::sweep_bot(
            db,
            &self.registry,
            &self.fanout,
            &self.locator,
            self.bot,
            self.connection,
        )
        .await
    }

    async fn periodic(&self, db: &PgPool) -> usize {
        reclaimer::sweep_once(db, &self.registry, &self.fanout, 900).await
    }

    fn terminal(&self, turn: &Turn) -> Value {
        json!({"type":"done","v":1,"client_msg_id":Uuid::new_v4(),"msg_id":turn.message,
            "content":"Completed the actual accepted task",
            "execution":{"task_id":turn.task,"execution_id":turn.execution.unwrap(),"channel_id":self.channel}})
    }

    async fn done(&self, db: &PgPool, turn: &Turn) -> Result<TerminalOutcome, TerminalError> {
        stream::handle_done(
            &self.registry,
            &self.fanout,
            db,
            &self.locator,
            self.bot,
            &self.terminal(turn),
        )
        .await
    }

    async fn snapshot(&self, db: &PgPool, turn: &Turn) -> Value {
        sqlx::query_scalar(
            "SELECT jsonb_build_object(
                'message',(SELECT to_jsonb(m) FROM messages m WHERE m.msg_id=$1),
                'run',(SELECT to_jsonb(r) FROM bot_runs r WHERE r.placeholder_msg_id=$1),
                'claim',(SELECT to_jsonb(c) FROM task_claim_requests c WHERE c.claim_id=$3),
                'confirmation',(SELECT to_jsonb(m) FROM messages m WHERE m.msg_id=$4),
                'session',(SELECT to_jsonb(s) FROM cheers_sessions s WHERE s.session_id=$2),
                'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.binding_id) FROM cheers_session_bindings b WHERE b.session_id=$2),
                'next_seq',(SELECT next_seq FROM channels WHERE channel_id=$5))",
        )
        .bind(turn.message.to_string())
        .bind(self.session.to_string())
        .bind(turn.claim.map(|id| id.to_string()))
        .bind(turn.confirmation.map(|id| id.to_string()))
        .bind(self.channel.to_string())
        .fetch_one(db)
        .await
        .unwrap()
    }
}

#[sqlx::test]
async fn accepted_claim_reclamation_atomically_settles_every_projection_without_a_terminal_receipt(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    let turn = fixture.claim(&db, true, true).await;
    let before = fixture.snapshot(&db, &turn).await;
    assert_eq!(before["run"]["status"], "accepted");
    assert_eq!(before["claim"]["status"], "executing");
    assert_eq!(before["session"]["status"], "busy");
    fixture.events.clear();
    fixture.offline();
    let report = fixture.sweep(&db).await;
    assert_eq!(report.reclaimed, 1);
    assert!(!report.retry);
    let after = fixture.snapshot(&db, &turn).await;
    assert!(after["message"].is_null());
    assert_eq!(after["run"]["status"], "failed");
    assert_eq!(after["run"]["last_event_type"], "reclaimed");
    assert_eq!(after["run"]["error_message"], "task placeholder reclaimed");
    for key in [
        "task_id",
        "execution_id",
        "execution_connection_id",
        "accepted_at",
    ] {
        assert_eq!(after["run"][key], before["run"][key]);
    }
    for key in [
        "terminal_client_msg_id",
        "terminal_fingerprint",
        "terminal_committed_at",
    ] {
        assert!(
            after["run"][key].is_null(),
            "reclaim must not manufacture a terminal receipt: {key}"
        );
    }
    assert_eq!(after["claim"]["status"], "failed");
    assert_eq!(
        after["confirmation"]["content_data"]["claim_status"],
        "failed"
    );
    assert_eq!(after["confirmation"]["content_data"]["claim_revision"], 3);
    assert_eq!(after["session"]["status"], "idle");
    assert!(after["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .all(|binding| !binding["detached_at"].is_null()));
    assert_eq!(after["next_seq"], before["next_seq"]);
    assert!(!fixture.registry.contains(turn.message));
    assert_eq!(fixture.events.count("bot_unavailable"), 1);
    assert_eq!(fixture.events.count("task_claim_updated"), 1);
    assert_eq!(fixture.events.count("message_done"), 0);
    let event = fixture
        .events
        .snapshot()
        .into_iter()
        .find(|event| event["type"] == "task_claim_updated")
        .unwrap();
    assert_eq!(
        event["data"]["confirmation_message"]["content_data"],
        after["confirmation"]["content_data"]
    );

    let events = fixture.events.snapshot();
    let error = fixture.done(&db, &turn).await.unwrap_err();
    assert!(
        !error.retryable,
        "reclaimed work has a definitive negative terminal disposition"
    );
    for execution in [turn.execution.unwrap(), Uuid::new_v4()] {
        assert_eq!(
            fixture.grant(&db, &turn, execution).await.status,
            TaskAcceptanceStatus::Rejected
        );
    }
    assert_eq!(fixture.sweep(&db).await.reclaimed, 0);
    assert_eq!(fixture.periodic(&db).await, 0);
    assert_eq!(fixture.snapshot(&db, &turn).await, after);
    assert_eq!(fixture.events.snapshot(), events);
}

#[sqlx::test]
async fn ordinary_accepted_runs_and_no_run_legacy_partials_share_cleanup(db: PgPool) {
    let ordinary = Fixture::seed(&db).await;
    let turn = ordinary.human(&db, true).await;
    ordinary.registry.remove(turn.message);
    ordinary.events.clear();
    assert_eq!(ordinary.periodic(&db).await, 1);
    let after = ordinary.snapshot(&db, &turn).await;
    assert!(after["message"].is_null());
    assert!(after["claim"].is_null());
    assert_eq!(after["run"]["status"], "failed");
    assert_eq!(after["session"]["status"], "idle");
    assert_eq!(ordinary.events.count("bot_unavailable"), 1);
    assert_eq!(ordinary.events.count("task_claim_updated"), 0);

    let legacy = Fixture::seed(&db).await;
    let turn = legacy.legacy_partial(&db).await;
    assert_eq!(legacy.periodic(&db).await, 1);
    let after = legacy.snapshot(&db, &turn).await;
    assert!(after["message"].is_null());
    assert!(after["run"].is_null());
    assert!(after["claim"].is_null());
    assert_eq!(after["session"]["status"], "idle");
    assert_eq!(legacy.events.count("bot_unavailable"), 1);
    assert_eq!(legacy.events.count("task_claim_updated"), 0);
}

#[sqlx::test]
async fn both_sweeps_preserve_durable_pending_and_prepared_claim_intents(db: PgPool) {
    for prepared in [false, true] {
        let fixture = Fixture::seed(&db).await;
        let turn = fixture.claim(&db, prepared, false).await;
        let before = fixture.snapshot(&db, &turn).await;
        assert_eq!(
            before["run"]["status"],
            if prepared { "prepared" } else { "pending" }
        );
        assert!(!before["run"]["dispatch_input"].is_null());
        fixture.offline();
        fixture.events.clear();
        assert_eq!(fixture.sweep(&db).await.reclaimed, 0);
        assert_eq!(fixture.periodic(&db).await, 0);
        assert_eq!(fixture.snapshot(&db, &turn).await, before);
        assert_eq!(fixture.registry.contains(turn.message), prepared);
        assert!(fixture.events.snapshot().is_empty());
    }
}

#[sqlx::test]
async fn reclamation_preserves_existing_cancelled_and_completed_claim_decisions(db: PgPool) {
    let cancelled = Fixture::seed(&db).await;
    let turn = cancelled.claim(&db, true, true).await;
    task_claims::cancel(
        &db,
        cancelled.channel,
        turn.claim.unwrap(),
        cancelled.user,
        Some("Explicit cancellation wins"),
    )
    .await
    .unwrap();
    let before = cancelled.snapshot(&db, &turn).await;
    cancelled.offline();
    cancelled.events.clear();
    assert_eq!(cancelled.sweep(&db).await.reclaimed, 1);
    let after = cancelled.snapshot(&db, &turn).await;
    assert_eq!(after["run"]["status"], "failed");
    assert_eq!(after["claim"], before["claim"]);
    assert_eq!(after["confirmation"], before["confirmation"]);
    assert_eq!(cancelled.events.count("task_claim_updated"), 0);

    let completed = Fixture::seed(&db).await;
    let turn = completed.claim(&db, true, true).await;
    assert_eq!(
        completed.done(&db, &turn).await.unwrap(),
        TerminalOutcome::Committed
    );
    let before = completed.snapshot(&db, &turn).await;
    assert_eq!(before["claim"]["status"], "completed");
    completed.offline();
    completed.events.clear();
    assert_eq!(completed.sweep(&db).await.reclaimed, 0);
    assert_eq!(completed.periodic(&db).await, 0);
    assert_eq!(completed.snapshot(&db, &turn).await, before);
    assert!(completed.events.snapshot().is_empty());
}

#[sqlx::test]
async fn reclaiming_one_turn_does_not_idle_another_turn_using_its_session(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    let old = fixture.human(&db, true).await;
    let active = fixture.human(&db, true).await;
    fixture.registry.remove(old.message);
    fixture.events.clear();
    assert_eq!(fixture.periodic(&db).await, 1);
    let abandoned = fixture.snapshot(&db, &old).await;
    let still_running = fixture.snapshot(&db, &active).await;
    assert_eq!(abandoned["run"]["status"], "failed");
    assert_eq!(still_running["run"]["status"], "accepted");
    assert_eq!(still_running["message"]["is_partial"], true);
    assert_eq!(still_running["session"]["status"], "busy");
    assert!(still_running["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .all(|binding| binding["detached_at"].is_null()));
    assert!(fixture.registry.contains(active.message));
    assert_eq!(fixture.events.count("bot_unavailable"), 1);
}

#[sqlx::test]
async fn abandonment_does_not_reopen_a_closed_session(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    let turn = fixture.human(&db, true).await;
    sessions::close_channel_session(&db, &fixture.channel.to_string(), fixture.session)
        .await
        .unwrap();
    let before = fixture.snapshot(&db, &turn).await;
    fixture.offline();
    fixture.events.clear();
    assert_eq!(fixture.sweep(&db).await.reclaimed, 1);
    let after = fixture.snapshot(&db, &turn).await;
    assert_eq!(after["run"]["status"], "failed");
    assert_eq!(after["session"], before["session"]);
    assert_eq!(after["bindings"], before["bindings"]);
}

async fn assert_reclaim_fault_rolls_back(db: &PgPool, deferred: bool) {
    let fixture = Fixture::seed(db).await;
    let turn = fixture.claim(db, true, true).await;
    let before = fixture.snapshot(db, &turn).await;
    fixture.offline();
    fixture.events.clear();
    sqlx::raw_sql("CREATE FUNCTION reject_abandoned_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected abandoned settlement failure'; END $$")
        .execute(db).await.unwrap();
    let trigger = if deferred {
        "CREATE CONSTRAINT TRIGGER reject_abandoned_settlement AFTER UPDATE ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.last_event_type='reclaimed') EXECUTE FUNCTION reject_abandoned_settlement()"
    } else {
        "CREATE TRIGGER reject_abandoned_settlement BEFORE UPDATE ON bot_runs FOR EACH ROW WHEN (NEW.last_event_type='reclaimed') EXECUTE FUNCTION reject_abandoned_settlement()"
    };
    sqlx::raw_sql(trigger).execute(db).await.unwrap();
    let report = fixture.sweep(db).await;
    assert_eq!(report.reclaimed, 0);
    assert!(report.retry);
    assert_eq!(fixture.snapshot(db, &turn).await, before);
    assert!(fixture.registry.contains(turn.message));
    assert_eq!(
        fixture.registry.active_channels(fixture.bot),
        vec![fixture.channel]
    );
    assert!(fixture.events.snapshot().is_empty());
    sqlx::raw_sql("DROP TRIGGER reject_abandoned_settlement ON bot_runs; DROP FUNCTION reject_abandoned_settlement()")
        .execute(db).await.unwrap();
    assert_eq!(fixture.sweep(db).await.reclaimed, 1);
    assert_eq!(fixture.events.count("bot_unavailable"), 1);
    assert_eq!(fixture.events.count("task_claim_updated"), 1);
}

#[sqlx::test]
async fn settlement_update_failure_rolls_back_message_run_claim_session_and_memory(db: PgPool) {
    assert_reclaim_fault_rolls_back(&db, false).await;
}

#[sqlx::test]
async fn settlement_commit_failure_rolls_back_message_run_claim_session_and_memory(db: PgPool) {
    assert_reclaim_fault_rolls_back(&db, true).await;
}

#[sqlx::test]
async fn a_real_terminal_commit_wins_an_in_flight_sweep_without_extra_notifications(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    let turn = fixture.claim(&db, true, true).await;
    fixture.events.clear();
    fixture.offline();
    let mut blocker = db.begin().await.unwrap();
    sqlx::query("SELECT msg_id FROM messages WHERE msg_id=$1 FOR UPDATE")
        .bind(turn.message.to_string())
        .execute(&mut *blocker)
        .await
        .unwrap();
    let (terminal_db, registry, fanout, locator, bot, frame) = (
        db.clone(),
        fixture.registry.clone(),
        fixture.fanout.clone(),
        fixture.locator.clone(),
        fixture.bot,
        fixture.terminal(&turn),
    );
    let terminal = tokio::spawn(async move {
        stream::handle_done(&registry, &fanout, &terminal_db, &locator, bot, &frame).await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fixture.registry.active_channels(fixture.bot).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the terminal frame must claim its stream before waiting for the message lock");
    let report = fixture.sweep(&db).await;
    assert_eq!(report.reclaimed, 0);
    assert!(report.retry);
    assert!(fixture.events.snapshot().is_empty());
    blocker.rollback().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), terminal)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        TerminalOutcome::Committed
    );
    let after = fixture.snapshot(&db, &turn).await;
    assert_eq!(after["message"]["is_partial"], false);
    assert_eq!(after["run"]["status"], "completed");
    assert!(!after["run"]["terminal_committed_at"].is_null());
    assert_eq!(after["claim"]["status"], "completed");
    assert_eq!(after["session"]["status"], "idle");
    assert_eq!(fixture.events.count("message_done"), 1);
    assert_eq!(fixture.events.count("task_claim_updated"), 1);
    assert_eq!(fixture.events.count("bot_unavailable"), 0);
    let events = fixture.events.snapshot();
    assert_eq!(fixture.sweep(&db).await.reclaimed, 0);
    assert_eq!(fixture.snapshot(&db, &turn).await, after);
    assert_eq!(fixture.events.snapshot(), events);
}

#[sqlx::test]
async fn reconnect_while_reclamation_waits_for_the_session_rolls_back_tentative_settlement(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    let turn = fixture.claim(&db, true, true).await;
    let before = fixture.snapshot(&db, &turn).await;
    fixture.events.clear();
    fixture.offline();
    let mut blocker = db.begin().await.unwrap();
    sqlx::query("SELECT session_id FROM cheers_sessions WHERE session_id=$1 FOR UPDATE")
        .bind(fixture.session.to_string())
        .execute(&mut *blocker)
        .await
        .unwrap();
    let (reclaim_db, registry, fanout, locator, bot, generation) = (
        db.clone(),
        fixture.registry.clone(),
        fixture.fanout.clone(),
        fixture.locator.clone(),
        fixture.bot,
        fixture.connection,
    );
    let pending = tokio::spawn(async move {
        reclaimer::sweep_bot(&reclaim_db, &registry, &fanout, &locator, bot, generation).await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                 AND wait_event_type='Lock' AND query LIKE '%SELECT s.session_id FROM cheers_sessions s%')",
            ).fetch_one(&db).await.unwrap();
            if waiting { break; }
            tokio::task::yield_now().await;
        }
    }).await.expect("reclamation must reach the session lock after its tentative run/claim/message writes");
    let fresh = Uuid::new_v4();
    let (control_tx, _control_rx) = mpsc::channel(1);
    let (data_tx, _data_rx) = mpsc::channel(1);
    let _supersede = fixture.binding.bind_control(fixture.bot, fresh, control_tx);
    fixture
        .binding
        .bind_data(fixture.bot, Uuid::new_v4(), data_tx);
    assert_eq!(
        fixture.locator.control_generation(fixture.bot).await,
        Some(fresh)
    );
    assert!(fixture.locator.is_online(fixture.bot).await);
    blocker.rollback().await.unwrap();
    let report = tokio::time::timeout(Duration::from_secs(10), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(report.reclaimed, 0);
    assert!(!report.retry);
    assert_eq!(fixture.snapshot(&db, &turn).await, before);
    assert!(fixture.registry.contains(turn.message));
    assert_eq!(
        fixture.registry.active_channels(fixture.bot),
        vec![fixture.channel]
    );
    assert!(fixture.events.snapshot().is_empty());
}

#[sqlx::test]
async fn every_partial_terminal_receipt_protects_its_placeholder_and_stream(db: PgPool) {
    for field in [
        "terminal_client_msg_id",
        "terminal_fingerprint",
        "terminal_committed_at",
    ] {
        let fixture = Fixture::seed(&db).await;
        let turn = fixture.human(&db, true).await;
        // Deliberately inconsistent historical state: a receipt fragment is
        // not proof that this still-partial execution may be destroyed.
        match field {
            "terminal_client_msg_id" => {
                sqlx::query("UPDATE bot_runs SET terminal_client_msg_id=$2 WHERE task_id=$1")
                    .bind(turn.task.to_string())
                    .bind(Uuid::new_v4().to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "terminal_fingerprint" => {
                sqlx::query("UPDATE bot_runs SET terminal_fingerprint=$2 WHERE task_id=$1")
                    .bind(turn.task.to_string())
                    .bind("a".repeat(64))
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => {
                sqlx::query(
                    "UPDATE bot_runs SET terminal_committed_at=clock_timestamp() WHERE task_id=$1",
                )
                .bind(turn.task.to_string())
                .execute(&db)
                .await
                .unwrap();
            }
        }
        let before = fixture.snapshot(&db, &turn).await;
        fixture.offline();
        fixture.events.clear();
        let report = fixture.sweep(&db).await;
        assert_eq!(report.reclaimed, 0, "receipt fragment: {field}");
        assert!(!report.retry);
        assert_eq!(fixture.snapshot(&db, &turn).await, before);
        assert!(fixture.registry.contains(turn.message));
        assert_eq!(
            fixture.registry.active_channels(fixture.bot),
            vec![fixture.channel]
        );
        assert!(fixture.events.snapshot().is_empty());
    }
}

#[sqlx::test]
async fn foreign_session_is_untouched_and_a_foreign_claim_marker_rolls_back_settlement(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    let turn = fixture.human(&db, true).await;
    let foreign = Fixture::seed(&db).await;
    let foreign_turn = foreign.human(&db, true).await;
    let foreign_before = foreign.snapshot(&db, &foreign_turn).await;
    sqlx::query("UPDATE messages SET content_data=jsonb_set(content_data,'{session_id}',$2) WHERE msg_id=$1")
        .bind(turn.message.to_string()).bind(json!(foreign.session)).execute(&db).await.unwrap();
    fixture.offline();
    fixture.events.clear();
    assert_eq!(fixture.sweep(&db).await.reclaimed, 1);
    let after = fixture.snapshot(&db, &turn).await;
    assert!(after["message"].is_null());
    assert_eq!(after["run"]["status"], "failed");
    assert_eq!(foreign.snapshot(&db, &foreign_turn).await, foreign_before);
    assert_eq!(
        after["session"]["status"], "busy",
        "untrusted metadata cannot select a current-primary fallback"
    );
    assert_eq!(fixture.events.count("bot_unavailable"), 1);

    let claimed = Fixture::seed(&db).await;
    let own_claim = claimed.claim(&db, true, true).await;
    let foreign_claim = foreign.claim(&db, true, true).await;
    sqlx::query("UPDATE messages SET content_data=jsonb_set(content_data,'{task_claim_id}',$2) WHERE msg_id=$1")
        .bind(own_claim.message.to_string()).bind(json!(foreign_claim.claim.unwrap()))
        .execute(&db).await.unwrap();
    let before = claimed.snapshot(&db, &own_claim).await;
    let foreign_before = foreign.snapshot(&db, &foreign_claim).await;
    claimed.offline();
    claimed.events.clear();
    let report = claimed.sweep(&db).await;
    assert_eq!(report.reclaimed, 0);
    assert!(
        report.retry,
        "a strong claim identity conflict must roll back rather than guess"
    );
    assert_eq!(claimed.snapshot(&db, &own_claim).await, before);
    assert_eq!(foreign.snapshot(&db, &foreign_claim).await, foreign_before);
    assert!(claimed.registry.contains(own_claim.message));
    assert_eq!(
        claimed.registry.active_channels(claimed.bot),
        vec![claimed.channel]
    );
    assert!(claimed.events.snapshot().is_empty());
}
