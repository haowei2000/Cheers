//! Claim lifecycle state and confirmation metadata share real PostgreSQL commits.
#![cfg(feature = "integration")]

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{json, Value};
use server::{
    domain::{
        sessions,
        task_claims::{self, ClaimDecision, ResolveClaimParams},
    },
    errors::AppError,
    gateway::{
        dispatch_intents,
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        resource_effects::publish_claim_update,
        stream::{self, StreamRegistry, TerminalOutcome},
        task_acceptance,
    },
    resource::{self, Principal},
};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Default)]
struct ReadyBot(Mutex<Vec<Value>>);

#[async_trait]
impl BotLocator for ReadyBot {
    async fn dispatch_task(&self, _bot: Uuid, task: Value) -> bool {
        self.0.lock().unwrap().push(task);
        true
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
struct Events(Mutex<Vec<WireFrame>>);

#[async_trait]
impl Fanout for Events {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        self.0.lock().unwrap().push(frame);
    }

    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}

impl Events {
    fn snapshot(&self) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|frame| {
                json!({
                    "channel_id":frame.channel_id,"type":frame.frame_type,"data":frame.data,
                })
            })
            .collect()
    }
}

struct Fixture {
    user: Uuid,
    bot: Uuid,
    channel: Uuid,
    claim: Uuid,
    confirmation: Uuid,
    locator: Arc<dyn BotLocator>,
    offers: Arc<ReadyBot>,
    registry: Arc<StreamRegistry>,
    events: Arc<Events>,
    fanout: Arc<dyn Fanout>,
}

impl Fixture {
    async fn seed(db: &PgPool) -> Self {
        let (user, bot, workspace, channel, source, evaluation) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'fixture')")
            .bind(user.to_string())
            .bind(format!("lifecycle-user-{user}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Claim lifecycle')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(workspace.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name,next_seq) VALUES($1,$2,'lifecycle',1)")
            .bind(channel.to_string()).bind(workspace.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor,binding_config) VALUES($1,$2,$3,FALSE,$4)")
            .bind(bot.to_string()).bind(format!("lifecycle-bot-{bot}")).bind(user.to_string())
            .bind(json!({"acp_security":{"require_capability":false}})).execute(db).await.unwrap();
        for (member, kind) in [(user, "user"), (bot, "bot")] {
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,$3,'member')")
                .bind(channel.to_string()).bind(member.to_string()).bind(kind).execute(db).await.unwrap();
        }
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,channel_seq) VALUES($1,$2,'user',$3,'Please investigate this lifecycle task','text',FALSE,1)")
            .bind(source.to_string()).bind(channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query(
            "INSERT INTO channel_bot_monitoring(channel_id,bot_id,mode) VALUES($1,$2,'off')",
        )
        .bind(channel.to_string())
        .bind(bot.to_string())
        .execute(db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO task_claim_evaluations(evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to,status,dispatched_at) VALUES($1,$2,$3,1,1,'dispatched',NOW())")
            .bind(evaluation.to_string()).bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        let pending = resource::task_claims::handle_evaluate(
            db,&Principal::bot(bot),
            &json!({"channel_id":channel,"evaluation_id":evaluation,"decision":"claim","confidence":1.0}),
        ).await.unwrap();
        sessions::ensure_primary_session_workspace(
            db,
            bot,
            &bot.to_string(),
            &channel.to_string(),
            Some("/lifecycle-workspace"),
            &[],
        )
        .await
        .unwrap();
        let offers = Arc::new(ReadyBot::default());
        let events = Arc::new(Events::default());
        Self {
            user,
            bot,
            channel,
            claim: pending["claim_id"].as_str().unwrap().parse().unwrap(),
            confirmation: pending["confirmation_message"]["msg_id"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            locator: offers.clone(),
            offers,
            registry: StreamRegistry::new(),
            fanout: events.clone(),
            events,
        }
    }

    fn approval(&self) -> ResolveClaimParams {
        ResolveClaimParams {
            channel_id: self.channel,
            claim_id: self.claim,
            requester_id: self.user,
            decision: ClaimDecision::Accept,
            note: Some("Approved lifecycle task".into()),
        }
    }

    async fn claim_state(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM task_claim_requests r WHERE claim_id=$1")
            .bind(self.claim.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn confirmation_state(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(m) FROM messages m WHERE msg_id=$1")
            .bind(self.confirmation.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn expire(&self, db: &PgPool) {
        sqlx::query("UPDATE task_claim_requests SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE claim_id=$1")
            .bind(self.claim.to_string()).execute(db).await.unwrap();
    }

    async fn prepared(&self, db: &PgPool) -> Value {
        let approved = task_claims::resolve(db, self.locator.as_ref(), self.approval())
            .await
            .unwrap();
        dispatch_intents::deliver_trigger(
            db,
            &self.fanout,
            &self.registry,
            &self.locator,
            approved.trigger_msg_id.unwrap(),
        )
        .await
        .unwrap();
        self.offers
            .0
            .lock()
            .unwrap()
            .pop()
            .expect("the real worker must prepare the approved task")
    }

    async fn cancel(&self, db: &PgPool) -> task_claims::ResolveClaimOutcome {
        task_claims::cancel(
            db,
            self.channel,
            self.claim,
            self.user,
            Some("Stop this task"),
        )
        .await
        .unwrap()
    }

    async fn run(&self, db: &PgPool, task: &Value) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE task_id=$1")
            .bind(task["task_id"].as_str().unwrap())
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn grant(
        &self,
        db: &PgPool,
        task: &Value,
        connection: Uuid,
        execution: Uuid,
    ) -> task_acceptance::Decision {
        task_acceptance::claim(
            db,
            self.bot,
            connection,
            task["task_id"].as_str().unwrap().parse().unwrap(),
            task["placeholder_msg_id"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            self.channel,
            execution,
        )
        .await
        .unwrap()
    }

    fn terminal(&self, task: &Value, execution: Uuid, kind: &str) -> Value {
        let mut result = json!({"type":kind,"v":1,"client_msg_id":Uuid::new_v4(),
            "msg_id":task["placeholder_msg_id"],
            "execution":{"task_id":task["task_id"],"execution_id":execution,"channel_id":self.channel}});
        if kind == "done" {
            result["content"] = json!("Completed the lifecycle task");
        } else {
            result["message"] = json!("The lifecycle task failed");
        }
        result
    }

    async fn assert_projection(&self, db: &PgPool, status: &str, revision: u64) {
        let claim = self.claim_state(db).await;
        let message = self.confirmation_state(db).await;
        assert_eq!(claim["status"], status);
        assert_eq!(message["content_data"]["claim_status"], status);
        assert_eq!(message["content_data"]["resolved"], status != "pending");
        assert_eq!(message["content_data"]["claim_revision"], revision);
    }
}

fn assert_patch(update: &task_claims::ClaimUpdate, fixture: &Fixture, message: &Value) {
    assert_eq!(update.claim_id, fixture.claim);
    assert_eq!(update.channel_id, fixture.channel);
    let patch = update
        .confirmation_message
        .as_ref()
        .expect("valid confirmation must be projected");
    assert_eq!(patch.msg_id, fixture.confirmation);
    assert_eq!(patch.content_data, message["content_data"]);
}

async fn publish(fixture: &Fixture, outcome: &task_claims::ResolveClaimOutcome) {
    if let Some(update) = outcome.update.as_ref() {
        publish_claim_update(fixture.fanout.as_ref(), update).await;
    }
}

#[sqlx::test]
async fn cancelling_a_pending_claim_commits_and_publishes_its_real_confirmation_once(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    fixture.assert_projection(&db, "pending", 1).await;
    let outcome = fixture.cancel(&db).await;
    let update = outcome
        .update
        .as_ref()
        .expect("the first cancel changes state");
    assert_eq!(update.status, "cancelled");
    assert_patch(update, &fixture, &fixture.confirmation_state(&db).await);
    fixture.assert_projection(&db, "cancelled", 2).await;
    publish(&fixture, &outcome).await;
    let events = fixture.events.snapshot();
    let changes: Vec<_> = events
        .iter()
        .filter(|event| event["type"] == "task_claim_updated")
        .collect();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["channel_id"], fixture.channel.to_string());
    assert_eq!(changes[0]["data"]["claim_id"], fixture.claim.to_string());
    assert_eq!(changes[0]["data"]["status"], "cancelled");
    assert_eq!(
        changes[0]["data"]["confirmation_message"]["msg_id"],
        fixture.confirmation.to_string()
    );
    assert_eq!(
        changes[0]["data"]["confirmation_message"]["content_data"]["claim_revision"],
        2
    );
    let before_claim = fixture.claim_state(&db).await;
    let before_message = fixture.confirmation_state(&db).await;
    let repeated = fixture.cancel(&db).await;
    assert!(
        repeated.update.is_none(),
        "no transition means no publication payload"
    );
    publish(&fixture, &repeated).await;
    assert_eq!(fixture.events.snapshot(), events);
    assert_eq!(fixture.claim_state(&db).await, before_claim);
    assert_eq!(fixture.confirmation_state(&db).await, before_message);
}

#[sqlx::test]
async fn expiry_projects_both_pending_and_executing_claims_once(db: PgPool) {
    let pending = Fixture::seed(&db).await;
    let executing = Fixture::seed(&db).await;
    let accepted = task_claims::resolve(&db, executing.locator.as_ref(), executing.approval())
        .await
        .unwrap();
    assert!(accepted.update.is_some());
    executing.assert_projection(&db, "executing", 2).await;
    pending.expire(&db).await;
    executing.expire(&db).await;
    let updates = task_claims::expire(&db).await.unwrap();
    assert_eq!(updates.len(), 2);
    for (fixture, revision) in [(&pending, 2), (&executing, 3)] {
        let update = updates
            .iter()
            .find(|update| update.claim_id == fixture.claim)
            .unwrap();
        assert_eq!(update.status, "failed");
        assert_patch(update, fixture, &fixture.confirmation_state(&db).await);
        fixture.assert_projection(&db, "failed", revision).await;
        publish_claim_update(fixture.fanout.as_ref(), update).await;
    }
    let before_pending = pending.claim_state(&db).await;
    let before_executing = executing.claim_state(&db).await;
    let before_events = pending.events.snapshot();
    for update in task_claims::expire(&db).await.unwrap() {
        publish_claim_update(pending.fanout.as_ref(), &update).await;
        panic!("already expired claims must not generate another transition");
    }
    assert_eq!(pending.claim_state(&db).await, before_pending);
    assert_eq!(executing.claim_state(&db).await, before_executing);
    assert_eq!(pending.events.snapshot(), before_events);
}

#[sqlx::test]
async fn lifecycle_commit_failure_rolls_back_the_claim_and_confirmation_together(db: PgPool) {
    for cancelled in [true, false] {
        let fixture = Fixture::seed(&db).await;
        if !cancelled {
            fixture.expire(&db).await;
        }
        let claim = fixture.claim_state(&db).await;
        let message = fixture.confirmation_state(&db).await;
        sqlx::raw_sql("CREATE FUNCTION reject_lifecycle_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected lifecycle commit failure'; END $$")
            .execute(&db).await.unwrap();
        // Installing after canonical creation makes the fault apply only to the
        // lifecycle write. Deferral exercises COMMIT, not just the UPDATE call.
        sqlx::raw_sql(&format!("CREATE CONSTRAINT TRIGGER reject_lifecycle_commit AFTER UPDATE ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.msg_id='{}') EXECUTE FUNCTION reject_lifecycle_commit()",fixture.confirmation))
            .execute(&db).await.unwrap();
        if cancelled {
            let error =
                task_claims::cancel(&db, fixture.channel, fixture.claim, fixture.user, None)
                    .await
                    .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("injected lifecycle commit failure"),
                "the deferred trigger must be reached, got {error:?}"
            );
        } else {
            let error = task_claims::expire(&db).await.unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("injected lifecycle commit failure"),
                "the deferred trigger must be reached, got {error:?}"
            );
        }
        assert_eq!(fixture.claim_state(&db).await, claim);
        assert_eq!(fixture.confirmation_state(&db).await, message);
        assert!(fixture.events.snapshot().is_empty());
        sqlx::raw_sql("DROP TRIGGER reject_lifecycle_commit ON messages; DROP FUNCTION reject_lifecycle_commit()")
            .execute(&db).await.unwrap();
        if cancelled {
            assert!(fixture.cancel(&db).await.update.is_some());
        } else {
            let updates = task_claims::expire(&db).await.unwrap();
            assert_eq!(updates.len(), 1);
            assert_eq!(updates[0].claim_id, fixture.claim);
        }
        fixture
            .assert_projection(&db, if cancelled { "cancelled" } else { "failed" }, 2)
            .await;
    }
}

#[sqlx::test]
async fn unsafe_confirmation_links_do_not_patch_unrelated_or_invalid_messages(db: PgPool) {
    // Both lifecycle entry points share the trusted confirmation projection.
    // Its absence must never prevent cancellation/expiry from fencing execution.
    for (index, invalid) in [
        "foreign",
        "wrong_bot",
        "wrong_type",
        "wrong_claim",
        "deleted",
        "partial",
        "missing",
    ]
    .into_iter()
    .enumerate()
    {
        let fixture = Fixture::seed(&db).await;
        let foreign = Fixture::seed(&db).await;
        match invalid {
            "foreign" => {
                sqlx::query(
                    "UPDATE task_claim_requests SET confirmation_message_id=$2 WHERE claim_id=$1",
                )
                .bind(fixture.claim.to_string())
                .bind(foreign.confirmation.to_string())
                .execute(&db)
                .await
                .unwrap();
            }
            "wrong_bot" => {
                sqlx::query("UPDATE messages SET sender_id=$2 WHERE msg_id=$1")
                    .bind(fixture.confirmation.to_string())
                    .bind(foreign.bot.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "wrong_type" => {
                sqlx::query("UPDATE messages SET msg_type='text' WHERE msg_id=$1")
                    .bind(fixture.confirmation.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "wrong_claim" => {
                sqlx::query("UPDATE messages SET content_data=content_data||jsonb_build_object('claim_id',$2::text) WHERE msg_id=$1")
                    .bind(fixture.confirmation.to_string()).bind(foreign.claim.to_string()).execute(&db).await.unwrap();
            }
            "deleted" => {
                sqlx::query("UPDATE messages SET is_deleted=TRUE WHERE msg_id=$1")
                    .bind(fixture.confirmation.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "partial" => {
                sqlx::query("UPDATE messages SET is_partial=TRUE WHERE msg_id=$1")
                    .bind(fixture.confirmation.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "missing" => {
                sqlx::query(
                    "UPDATE task_claim_requests SET confirmation_message_id=$2 WHERE claim_id=$1",
                )
                .bind(fixture.claim.to_string())
                .bind(Uuid::new_v4().to_string())
                .execute(&db)
                .await
                .unwrap();
            }
            _ => unreachable!(),
        }
        let original = fixture.confirmation_state(&db).await;
        let foreign_before = foreign.confirmation_state(&db).await;
        let update = if invalid == "wrong_bot" {
            let mut params = fixture.approval();
            params.decision = ClaimDecision::Reject;
            task_claims::resolve(&db, fixture.locator.as_ref(), params)
                .await
                .unwrap()
                .update
                .unwrap()
        } else if index % 2 == 0 {
            fixture.cancel(&db).await.update.unwrap()
        } else {
            fixture.expire(&db).await;
            let mut updates = task_claims::expire(&db).await.unwrap();
            assert_eq!(updates.len(), 1);
            updates.pop().unwrap()
        };
        assert!(
            update.confirmation_message.is_none(),
            "{invalid} confirmation must not become a patch target"
        );
        assert!(matches!(
            fixture.claim_state(&db).await["status"].as_str(),
            Some("cancelled" | "failed" | "rejected")
        ));
        assert_eq!(
            fixture.confirmation_state(&db).await,
            original,
            "invalid {invalid} card was changed"
        );
        assert_eq!(
            foreign.confirmation_state(&db).await,
            foreign_before,
            "foreign {invalid} card was changed"
        );
    }
}

#[sqlx::test]
async fn legacy_null_confirmation_cancels_and_expires_without_fabricating_a_message(db: PgPool) {
    for cancelled in [true, false] {
        let fixture = Fixture::seed(&db).await;
        sqlx::query(
            "UPDATE task_claim_requests SET confirmation_message_id=NULL WHERE claim_id=$1",
        )
        .bind(fixture.claim.to_string())
        .execute(&db)
        .await
        .unwrap();
        let message = fixture.confirmation_state(&db).await;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&db)
            .await
            .unwrap();
        let update = if cancelled {
            fixture.cancel(&db).await.update.unwrap()
        } else {
            fixture.expire(&db).await;
            let mut updates = task_claims::expire(&db).await.unwrap();
            assert_eq!(updates.len(), 1);
            updates.pop().unwrap()
        };
        assert!(update.confirmation_message.is_none());
        publish_claim_update(fixture.fanout.as_ref(), &update).await;
        let event = fixture
            .events
            .snapshot()
            .into_iter()
            .find(|event| event["type"] == "task_claim_updated")
            .unwrap();
        assert!(event["data"]["confirmation_message"].is_null());
        assert_eq!(fixture.confirmation_state(&db).await, message);
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(
            after, count,
            "lifecycle updates never invent a confirmation ID/message"
        );
    }
}

#[sqlx::test]
async fn cancellation_racing_approval_leaves_a_cancelled_claim_and_matching_card(db: PgPool) {
    let fixture = Arc::new(Fixture::seed(&db).await);
    let start = Arc::new(tokio::sync::Barrier::new(3));
    let approve = {
        let fixture = fixture.clone();
        let db = db.clone();
        let start = start.clone();
        tokio::spawn(async move {
            start.wait().await;
            task_claims::resolve(&db, fixture.locator.as_ref(), fixture.approval()).await
        })
    };
    let cancel = {
        let fixture = fixture.clone();
        let db = db.clone();
        let start = start.clone();
        tokio::spawn(async move {
            start.wait().await;
            fixture.cancel(&db).await
        })
    };
    start.wait().await;
    let (approval, cancellation) = tokio::time::timeout(Duration::from_secs(10), async {
        (approve.await.unwrap(), cancel.await.unwrap())
    })
    .await
    .expect("approval/cancel must serialize without a lock cycle");
    assert!(cancellation.update.is_some());
    if let Err(error) = &approval {
        assert!(
            matches!(error, AppError::Conflict(_)),
            "approval may only lose the state race, got {error:?}"
        );
    }
    let revision = if approval.is_ok() { 3 } else { 2 };
    fixture.assert_projection(&db, "cancelled", revision).await;
    let claim = fixture.claim_state(&db).await;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM bot_runs WHERE placeholder_msg_id=$1")
            .bind(claim["execution_msg_id"].as_str())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, if approval.is_ok() { 1 } else { 0 });
    let repeated = fixture.cancel(&db).await;
    assert!(repeated.update.is_none());
    fixture.assert_projection(&db, "cancelled", revision).await;
}

#[sqlx::test]
async fn approval_waiting_on_a_claim_lock_cannot_revive_a_claim_that_expires_during_the_wait(
    db: PgPool,
) {
    let fixture = Arc::new(Fixture::seed(&db).await);
    sqlx::query("UPDATE task_claim_requests SET expires_at=clock_timestamp()+INTERVAL '3 seconds' WHERE claim_id=$1")
        .bind(fixture.claim.to_string()).execute(&db).await.unwrap();
    let mut held = db.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *held)
        .await
        .unwrap();
    sqlx::query("SELECT claim_id FROM task_claim_requests WHERE claim_id=$1 FOR UPDATE")
        .bind(fixture.claim.to_string())
        .execute(&mut *held)
        .await
        .unwrap();
    let approval = {
        let fixture = fixture.clone();
        let db = db.clone();
        tokio::spawn(async move {
            task_claims::resolve(&db, fixture.locator.as_ref(), fixture.approval()).await
        })
    };
    tokio::time::timeout(Duration::from_secs(5),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(blocker).fetch_one(&db).await.unwrap();
            if waiting {break;}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("approval must enter the real row lock wait");
    let live: bool = sqlx::query_scalar(
        "SELECT expires_at>clock_timestamp() FROM task_claim_requests WHERE claim_id=$1",
    )
    .bind(fixture.claim.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(live, "lock contention must begin before expiry");
    sqlx::query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))+0.02) FROM task_claim_requests WHERE claim_id=$1")
        .bind(fixture.claim.to_string()).execute(&db).await.unwrap();
    let expiry = {
        let db = db.clone();
        tokio::spawn(async move { task_claims::expire(&db).await })
    };
    held.rollback().await.unwrap();
    let approval = tokio::time::timeout(Duration::from_secs(5), approval)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(approval, Err(AppError::Conflict(_))),
        "approval must fail the fresh expiry gate, got {approval:?}"
    );
    let mut updates = tokio::time::timeout(Duration::from_secs(5), expiry)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    // A bounded SKIP LOCKED sweep may have observed the held claim. The next
    // sweep must consume it, while the blocked approval cannot have committed.
    updates.extend(task_claims::expire(&db).await.unwrap());
    assert_eq!(
        updates
            .iter()
            .filter(|update| update.claim_id == fixture.claim)
            .count(),
        1
    );
    fixture.assert_projection(&db, "failed", 2).await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_runs")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "an expired approval must create no execution intent"
    );
}

#[sqlx::test]
async fn cancelled_or_expired_accepted_work_cannot_reconfirm_or_finalize_through_live_memory(
    db: PgPool,
) {
    for cancelled in [true, false] {
        let fixture = Fixture::seed(&db).await;
        let task = fixture.prepared(&db).await;
        let connection = Uuid::new_v4();
        let execution = Uuid::new_v4();
        let grant = fixture.grant(&db, &task, connection, execution).await;
        assert!(matches!(
            grant.status,
            cheers_bridge_protocol::TaskAcceptanceStatus::Granted
        ));
        let accepted = fixture.run(&db, &task).await;
        assert!(accepted["dispatch_input"].is_null());
        let msg_id: Uuid = task["placeholder_msg_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            fixture.registry.contains(msg_id),
            "this tests a live in-memory turn, not just DB fallback"
        );
        if cancelled {
            let outcome = fixture.cancel(&db).await;
            publish(&fixture, &outcome).await;
        } else {
            fixture.expire(&db).await;
            for update in task_claims::expire(&db).await.unwrap() {
                publish_claim_update(fixture.fanout.as_ref(), &update).await;
            }
        }
        fixture
            .assert_projection(&db, if cancelled { "cancelled" } else { "failed" }, 3)
            .await;
        let before_claim = fixture.claim_state(&db).await;
        let before_card = fixture.confirmation_state(&db).await;
        let repeated = fixture.grant(&db, &task, connection, execution).await;
        assert!(matches!(
            repeated.status,
            cheers_bridge_protocol::TaskAcceptanceStatus::Rejected
        ));
        let result = fixture.terminal(&task, execution, "done");
        let before_events = fixture.events.snapshot();
        let denied = stream::handle_done(
            &fixture.registry,
            &fixture.fanout,
            &db,
            &fixture.locator,
            fixture.bot,
            &result,
        )
        .await
        .unwrap_err();
        assert_eq!(denied.code, "TERMINAL_FORBIDDEN");
        assert!(!denied.retryable);
        assert_eq!(
            fixture.run(&db, &task).await,
            accepted,
            "denial must not mint a result receipt or clear the old execution fence"
        );
        assert_eq!(fixture.claim_state(&db).await, before_claim);
        assert_eq!(fixture.confirmation_state(&db).await, before_card);
        assert_eq!(
            fixture.events.snapshot(),
            before_events,
            "denied terminal output must not publish success"
        );
    }
}

#[sqlx::test]
async fn committed_done_and_error_project_the_final_status_without_replay_revision_or_fanout(
    db: PgPool,
) {
    for kind in ["done", "error"] {
        let fixture = Fixture::seed(&db).await;
        let task = fixture.prepared(&db).await;
        let execution = Uuid::new_v4();
        let grant = fixture.grant(&db, &task, Uuid::new_v4(), execution).await;
        assert!(matches!(
            grant.status,
            cheers_bridge_protocol::TaskAcceptanceStatus::Granted
        ));
        let result = fixture.terminal(&task, execution, kind);
        let outcome = stream::handle_done(
            &fixture.registry,
            &fixture.fanout,
            &db,
            &fixture.locator,
            fixture.bot,
            &result,
        )
        .await
        .unwrap();
        assert_eq!(outcome, TerminalOutcome::Committed);
        fixture
            .assert_projection(
                &db,
                if kind == "done" {
                    "completed"
                } else {
                    "failed"
                },
                3,
            )
            .await;
        let claim = fixture.claim_state(&db).await;
        let card = fixture.confirmation_state(&db).await;
        let run = fixture.run(&db, &task).await;
        let events = fixture.events.snapshot();
        let updates: Vec<_> = events
            .iter()
            .filter(|event| event["type"] == "task_claim_updated")
            .collect();
        assert_eq!(
            updates.len(),
            1,
            "terminal claim publication belongs to its first committed result"
        );
        assert_eq!(
            updates[0]["data"]["confirmation_message"]["content_data"],
            card["content_data"]
        );
        let replay = stream::handle_done(
            &fixture.registry,
            &fixture.fanout,
            &db,
            &fixture.locator,
            fixture.bot,
            &result,
        )
        .await
        .unwrap();
        assert_eq!(replay, TerminalOutcome::Replayed);
        assert_eq!(fixture.claim_state(&db).await, claim);
        assert_eq!(fixture.confirmation_state(&db).await, card);
        assert_eq!(fixture.run(&db, &task).await, run);
        assert_eq!(fixture.events.snapshot(), events);
    }
}

#[sqlx::test]
async fn an_execution_row_mislinked_as_confirmation_does_not_invert_cancellation_locks(db: PgPool) {
    let fixture = Arc::new(Fixture::seed(&db).await);
    let task = fixture.prepared(&db).await;
    let placeholder = task["placeholder_msg_id"].as_str().unwrap();
    sqlx::query("UPDATE task_claim_requests SET confirmation_message_id=$2 WHERE claim_id=$1")
        .bind(fixture.claim.to_string())
        .bind(placeholder)
        .execute(&db)
        .await
        .unwrap();
    let original_card = fixture.confirmation_state(&db).await;
    let mut execution_lock = db.begin().await.unwrap();
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(m) FROM messages m WHERE msg_id=$1 FOR UPDATE")
            .bind(placeholder)
            .fetch_one(&mut *execution_lock)
            .await
            .unwrap();
    let cancel = {
        let db = db.clone();
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.cancel(&db).await })
    };
    let outcome = tokio::time::timeout(Duration::from_secs(3), cancel)
        .await
        .expect("cancellation must validate the message kind before locking an execution row")
        .unwrap();
    assert!(outcome.update.unwrap().confirmation_message.is_none());
    assert_eq!(fixture.claim_state(&db).await["status"], "cancelled");
    let after: Value = sqlx::query_scalar("SELECT to_jsonb(m) FROM messages m WHERE msg_id=$1")
        .bind(placeholder)
        .fetch_one(&mut *execution_lock)
        .await
        .unwrap();
    assert_eq!(after, before);
    assert_eq!(fixture.confirmation_state(&db).await, original_card);
    execution_lock.rollback().await.unwrap();
}
