//! Human approval, durable claim offers and terminal results share real PG invariants.
#![cfg(feature = "integration")]

use async_trait::async_trait;
use serde_json::{json, Value};
use server::{
    domain::{
        messages::{self, CreateMessageParams},
        sessions,
        task_claims::{self, ClaimDecision, ResolveClaimParams},
    },
    gateway::{
        dispatch_intents,
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        stream::{self, StreamRegistry, TerminalOutcome},
        task_acceptance,
    },
    resource::Principal,
};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Default)]
struct Offers(Mutex<Vec<Value>>);
#[async_trait]
impl BotLocator for Offers {
    async fn dispatch_task(&self, _bot: Uuid, task: Value) -> bool {
        self.0.lock().unwrap().push(task);
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
struct Events(Mutex<Vec<WireFrame>>);
#[async_trait]
impl Fanout for Events {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        self.0.lock().unwrap().push(frame);
    }
    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}
struct Fixture {
    user: Uuid,
    bot: Uuid,
    channel: Uuid,
    claim: Uuid,
    confirmation: Uuid,
    session: sessions::SessionHandle,
    registry: Arc<StreamRegistry>,
    offers: Arc<Offers>,
    locator: Arc<dyn BotLocator>,
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
            .bind(format!("claim-user-{user}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Claim execution')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(workspace.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query(
            "INSERT INTO channels(channel_id,workspace_id,name,next_seq) VALUES($1,$2,'claims',1)",
        )
        .bind(channel.to_string())
        .bind(workspace.to_string())
        .execute(db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor,binding_config) VALUES($1,$2,$3,FALSE,$4)")
            .bind(bot.to_string()).bind(format!("claim-bot-{bot}")).bind(user.to_string())
            .bind(json!({"acp_security":{"require_capability":false}})).execute(db).await.unwrap();
        for (member, kind) in [(user, "user"), (bot, "bot")] {
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,$3,'member')")
                .bind(channel.to_string()).bind(member.to_string()).bind(kind).execute(db).await.unwrap();
        }
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,channel_seq) VALUES($1,$2,'user',$3,'The approved source instruction','text',FALSE,1)")
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
        let pending=server::resource::task_claims::handle_evaluate(db,&Principal::bot(bot),
            &json!({"channel_id":channel,"evaluation_id":evaluation,"decision":"claim","confidence":1.0})).await.unwrap();
        let session = sessions::ensure_primary_session_workspace(
            db,
            bot,
            &bot.to_string(),
            &channel.to_string(),
            Some("/claim-workspace"),
            &[],
        )
        .await
        .unwrap();
        let offers = Arc::new(Offers::default());
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
            session,
            registry: StreamRegistry::new(),
            locator: offers.clone(),
            offers,
            fanout: events.clone(),
            events,
        }
    }
    fn params(&self) -> ResolveClaimParams {
        ResolveClaimParams {
            channel_id: self.channel,
            claim_id: self.claim,
            requester_id: self.user,
            decision: ClaimDecision::Accept,
            note: Some("Approved by requester".into()),
        }
    }
    async fn approve(&self, db: &PgPool) -> task_claims::ResolveClaimOutcome {
        task_claims::resolve(db, self.locator.as_ref(), self.params())
            .await
            .unwrap()
    }
    async fn offer(&self, db: &PgPool, trigger: Uuid) -> Value {
        dispatch_intents::deliver_trigger(db, &self.fanout, &self.registry, &self.locator, trigger)
            .await
            .unwrap();
        self.offers
            .0
            .lock()
            .unwrap()
            .pop()
            .expect("the real worker must prepare an offer")
    }
    async fn grant(&self, db: &PgPool, task: &Value) -> Uuid {
        let execution = Uuid::new_v4();
        let grant = task_acceptance::claim(
            db,
            self.bot,
            Uuid::new_v4(),
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
        .unwrap();
        assert!(matches!(
            grant.status,
            cheers_bridge_protocol::TaskAcceptanceStatus::Granted
        ));
        execution
    }
    fn result(&self, task: &Value, execution: Uuid, kind: &str) -> Value {
        let mut frame = json!({"type":kind,"v":1,"client_msg_id":Uuid::new_v4(),"msg_id":task["placeholder_msg_id"],
            "execution":{"task_id":task["task_id"],"execution_id":execution,"channel_id":self.channel}});
        if kind == "done" {
            frame["content"] = json!("The approved result");
        } else {
            frame["message"] = json!("The approved execution failed");
        }
        frame
    }
    async fn claim_state(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM task_claim_requests r WHERE claim_id=$1")
            .bind(self.claim.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }
    async fn run(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE placeholder_msg_id=(SELECT execution_msg_id FROM task_claim_requests WHERE claim_id=$1)")
        .bind(self.claim.to_string()).fetch_one(db).await.unwrap()
    }
    async fn session_status(&self, db: &PgPool) -> String {
        sqlx::query_scalar("SELECT status FROM cheers_sessions WHERE session_id=$1")
            .bind(self.session.session_id.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }
}

async fn approval_rollback(db: &PgPool, deferred: bool) {
    let fixture = Fixture::seed(db).await;
    let before = fixture.claim_state(db).await;
    let session_before: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM cheers_sessions s WHERE session_id=$1")
            .bind(fixture.session.session_id.to_string())
            .fetch_one(db)
            .await
            .unwrap();
    sqlx::raw_sql("CREATE FUNCTION reject_claim_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected claim admission failure'; END $$").execute(db).await.unwrap();
    let ddl = if deferred {
        "CREATE CONSTRAINT TRIGGER reject_claim_intent AFTER INSERT ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_claim_intent()"
    } else {
        "CREATE TRIGGER reject_claim_intent BEFORE INSERT ON bot_runs FOR EACH ROW EXECUTE FUNCTION reject_claim_intent()"
    };
    sqlx::raw_sql(ddl).execute(db).await.unwrap();
    assert!(
        task_claims::resolve(db, fixture.locator.as_ref(), fixture.params())
            .await
            .is_err()
    );
    assert_eq!(
        fixture.claim_state(db).await,
        before,
        "approval must remain retryable after a failed transaction"
    );
    let confirmation: Value =
        sqlx::query_scalar("SELECT content_data FROM messages WHERE msg_id=$1")
            .bind(fixture.confirmation.to_string())
            .fetch_one(db)
            .await
            .unwrap();
    assert_eq!(confirmation["resolved"], false);
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT COUNT(*) FROM messages WHERE channel_id=$1),(SELECT COUNT(*) FROM bot_runs WHERE channel_id=$1),(SELECT next_seq FROM channels WHERE channel_id=$1)")
        .bind(fixture.channel.to_string()).fetch_one(db).await.unwrap();
    assert_eq!(
        counts,
        (2, 0, 2),
        "no private trigger, partial, run or channel sequence may escape rollback"
    );
    let session_after: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM cheers_sessions s WHERE session_id=$1")
            .bind(fixture.session.session_id.to_string())
            .fetch_one(db)
            .await
            .unwrap();
    assert_eq!(session_after, session_before);
    assert!(fixture.offers.0.lock().unwrap().is_empty());
    sqlx::raw_sql(
        "DROP TRIGGER reject_claim_intent ON bot_runs; DROP FUNCTION reject_claim_intent()",
    )
    .execute(db)
    .await
    .unwrap();
    let approved = fixture.approve(db).await;
    assert_eq!(approved.status, "executing");
    assert!(approved.execution_msg_id.is_some());
    assert!(approved.trigger_msg_id.is_some());
    assert_eq!(fixture.run(db).await["status"], "pending");
    assert_eq!(
        fixture.session_status(db).await,
        "idle",
        "approval alone does not start the turn"
    );
}
#[sqlx::test]
async fn approval_insert_failure_rolls_back_confirmation_trigger_and_intent(db: PgPool) {
    approval_rollback(&db, false).await;
}
#[sqlx::test]
async fn approval_commit_failure_rolls_back_confirmation_trigger_and_intent(db: PgPool) {
    approval_rollback(&db, true).await;
}

#[sqlx::test]
async fn done_and_error_settle_the_claim_with_the_receipt_or_roll_back_together(db: PgPool) {
    for kind in ["done", "error"] {
        let fixture = Fixture::seed(&db).await;
        let approved = fixture.approve(&db).await;
        let task = fixture.offer(&db, approved.trigger_msg_id.unwrap()).await;
        let execution = fixture.grant(&db, &task).await;
        let frame = fixture.result(&task, execution, kind);
        sqlx::raw_sql("CREATE FUNCTION reject_claim_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected claim terminal commit failure'; END $$; CREATE CONSTRAINT TRIGGER reject_claim_terminal AFTER UPDATE ON task_claim_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status='executing' AND NEW.status IN ('completed','failed')) EXECUTE FUNCTION reject_claim_terminal()")
            .execute(&db).await.unwrap();
        let error = stream::handle_done(
            &fixture.registry,
            &fixture.fanout,
            &db,
            &fixture.locator,
            fixture.bot,
            &frame,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INTERNAL_ERROR");
        assert!(error.retryable);
        assert_eq!(fixture.claim_state(&db).await["status"], "executing");
        let run = fixture.run(&db).await;
        assert_eq!(run["status"], "accepted");
        assert!(run["terminal_committed_at"].is_null());
        let state:(bool,Option<i64>,i64)=sqlx::query_as("SELECT m.is_partial,m.channel_seq,c.next_seq FROM messages m JOIN channels c USING(channel_id) WHERE m.msg_id=$1")
            .bind(task["placeholder_msg_id"].as_str().unwrap()).fetch_one(&db).await.unwrap();
        assert_eq!(state, (true, None, 2));
        assert_eq!(fixture.session_status(&db).await, "busy");
        assert!(fixture
            .events
            .0
            .lock()
            .unwrap()
            .iter()
            .all(|e| e.frame_type != "message_done" && e.frame_type != "task_claim_updated"));
        sqlx::raw_sql("DROP TRIGGER reject_claim_terminal ON task_claim_requests; DROP FUNCTION reject_claim_terminal()").execute(&db).await.unwrap();
        assert_eq!(
            stream::handle_done(
                &fixture.registry,
                &fixture.fanout,
                &db,
                &fixture.locator,
                fixture.bot,
                &frame
            )
            .await
            .unwrap(),
            TerminalOutcome::Committed
        );
        let settled = fixture.claim_state(&db).await;
        assert_eq!(
            settled["status"],
            if kind == "done" {
                "completed"
            } else {
                "failed"
            }
        );
        assert_eq!(fixture.session_status(&db).await, "idle");
        let run = fixture.run(&db).await;
        assert_eq!(run["last_event_type"], kind);
        assert!(!run["terminal_committed_at"].is_null());
        let before = fixture.events.0.lock().unwrap().len();
        assert_eq!(
            stream::handle_done(
                &fixture.registry,
                &fixture.fanout,
                &db,
                &fixture.locator,
                fixture.bot,
                &frame
            )
            .await
            .unwrap(),
            TerminalOutcome::Replayed
        );
        assert_eq!(fixture.claim_state(&db).await, settled);
        assert_eq!(
            fixture.events.0.lock().unwrap().len(),
            before,
            "receipt replay cannot repeat completion effects"
        );
    }
}

#[sqlx::test]
async fn cancellation_or_requester_revocation_after_preparation_prevents_grant(db: PgPool) {
    for cancelled in [true, false] {
        let fixture = Fixture::seed(&db).await;
        let approved = fixture.approve(&db).await;
        let task = fixture.offer(&db, approved.trigger_msg_id.unwrap()).await;
        if cancelled {
            task_claims::cancel(
                &db,
                fixture.channel,
                fixture.claim,
                fixture.user,
                Some("no longer needed"),
            )
            .await
            .unwrap();
        } else {
            sqlx::query("UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2 AND member_type='user'")
            .bind(fixture.channel.to_string()).bind(fixture.user.to_string()).execute(&db).await.unwrap();
        }
        let decision = task_acceptance::claim(
            &db,
            fixture.bot,
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
            decision.status,
            cheers_bridge_protocol::TaskAcceptanceStatus::Rejected
        ));
        let run = fixture.run(&db).await;
        assert!(run["execution_id"].is_null());
        assert!(run["accepted_at"].is_null());
        assert!(run["terminal_committed_at"].is_null());
    }
}

#[sqlx::test]
async fn finishing_a_claim_keeps_a_shared_session_busy_until_the_other_real_turn_finishes(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    let approved = fixture.approve(&db).await;
    let claim_task = fixture.offer(&db, approved.trigger_msg_id.unwrap()).await;
    let claim_execution = fixture.grant(&db, &claim_task).await;
    let human = messages::create_message(
        &db,
        &fixture.fanout,
        &fixture.registry,
        &fixture.locator,
        CreateMessageParams {
            user_id: fixture.user,
            channel_id: fixture.channel,
            content: "A separate human turn".into(),
            msg_type: None,
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: vec![fixture.bot],
            mention_names: vec![],
            session_id: Some(fixture.session.session_id),
            context_bundle: None,
            msg_id: None,
        },
    )
    .await
    .unwrap();
    let human_task = fixture.offers.0.lock().unwrap().pop().unwrap();
    assert_eq!(human_task["trigger_msg_id"], human.msg_id);
    assert_eq!(human_task["session_id"], claim_task["session_id"]);
    let human_execution = fixture.grant(&db, &human_task).await;
    let foreign = sessions::create_channel_session(
        &db,
        fixture.bot,
        &fixture.bot.to_string(),
        &fixture.channel.to_string(),
        "other",
        Some("/unrelated"),
        &[],
    )
    .await
    .unwrap();
    sessions::touch_session(&db, foreign.session_id)
        .await
        .unwrap();
    let mut claim_result = fixture.result(&claim_task, claim_execution, "done");
    // The frame cannot choose which session is finalized; only persisted turn
    // metadata owns that transition.
    claim_result["session_id"] = json!(foreign.session_id);
    claim_result["provider_session_key"] = json!(foreign.provider_session_key);
    assert_eq!(
        stream::handle_done(
            &fixture.registry,
            &fixture.fanout,
            &db,
            &fixture.locator,
            fixture.bot,
            &claim_result
        )
        .await
        .unwrap(),
        TerminalOutcome::Committed
    );
    assert_eq!(
        fixture.session_status(&db).await,
        "busy",
        "another granted partial owns this same session"
    );
    assert_eq!(fixture.claim_state(&db).await["status"], "completed");
    let foreign_status: String =
        sqlx::query_scalar("SELECT status FROM cheers_sessions WHERE session_id=$1")
            .bind(foreign.session_id.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        foreign_status, "busy",
        "an untrusted result session_id cannot idle another session"
    );
    let human_result = fixture.result(&human_task, human_execution, "done");
    assert_eq!(
        stream::handle_done(
            &fixture.registry,
            &fixture.fanout,
            &db,
            &fixture.locator,
            fixture.bot,
            &human_result
        )
        .await
        .unwrap(),
        TerminalOutcome::Committed
    );
    assert_eq!(fixture.session_status(&db).await, "idle");
}

#[sqlx::test]
async fn an_accepted_claim_cannot_reconfirm_its_grant_after_cancel_or_expiry(db: PgPool) {
    for cancel in [true, false] {
        let fixture = Fixture::seed(&db).await;
        let approved = fixture.approve(&db).await;
        let task = fixture.offer(&db, approved.trigger_msg_id.unwrap()).await;
        let connection = Uuid::new_v4();
        let execution = Uuid::new_v4();
        let task_id = task["task_id"].as_str().unwrap().parse().unwrap();
        let placeholder = task["placeholder_msg_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let first = task_acceptance::claim(
            &db,
            fixture.bot,
            connection,
            task_id,
            placeholder,
            fixture.channel,
            execution,
        )
        .await
        .unwrap();
        assert!(matches!(
            first.status,
            cheers_bridge_protocol::TaskAcceptanceStatus::Granted
        ));
        let accepted = fixture.run(&db).await;
        assert!(accepted["dispatch_input"].is_null());
        assert!(accepted["task_frame"].is_null());
        if cancel {
            task_claims::cancel(
                &db,
                fixture.channel,
                fixture.claim,
                fixture.user,
                Some("stop accepted work"),
            )
            .await
            .unwrap();
        } else {
            sqlx::query("UPDATE task_claim_requests SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE claim_id=$1")
            .bind(fixture.claim.to_string()).execute(&db).await.unwrap();
        }
        let repeated = task_acceptance::claim(
            &db,
            fixture.bot,
            connection,
            task_id,
            placeholder,
            fixture.channel,
            execution,
        )
        .await
        .unwrap();
        assert!(
            matches!(
                repeated.status,
                cheers_bridge_protocol::TaskAcceptanceStatus::Rejected
            ),
            "an accepted run's cleared input cannot bypass current claim authority"
        );
        let after = fixture.run(&db).await;
        assert_eq!(
            after, accepted,
            "denied reconfirmation must not alter the original execution or write a receipt"
        );
    }
}

#[sqlx::test]
async fn a_grant_blocked_on_the_claim_row_rechecks_time_after_the_lock_wait(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    let approved = fixture.approve(&db).await;
    let task = fixture.offer(&db, approved.trigger_msg_id.unwrap()).await;
    sqlx::query("UPDATE task_claim_requests SET expires_at=clock_timestamp()+INTERVAL '3 seconds' WHERE claim_id=$1")
        .bind(fixture.claim.to_string()).execute(&db).await.unwrap();
    let mut lock = db.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    sqlx::query("SELECT claim_id FROM task_claim_requests WHERE claim_id=$1 FOR UPDATE")
        .bind(fixture.claim.to_string())
        .execute(&mut *lock)
        .await
        .unwrap();
    let request = {
        let db = db.clone();
        let bot = fixture.bot;
        let channel = fixture.channel;
        let task_id = task["task_id"].as_str().unwrap().parse().unwrap();
        let placeholder = task["placeholder_msg_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        tokio::spawn(async move {
            task_acceptance::claim(
                &db,
                bot,
                Uuid::new_v4(),
                task_id,
                placeholder,
                channel,
                Uuid::new_v4(),
            )
            .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(blocker).fetch_one(&db).await.unwrap();
            if blocked {break;}
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("grant must wait on the held claim row before expiry");
    let still_live: bool = sqlx::query_scalar(
        "SELECT clock_timestamp()<expires_at FROM task_claim_requests WHERE claim_id=$1",
    )
    .bind(fixture.claim.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(
        still_live,
        "the observed lock wait must begin before the original deadline"
    );
    // Let the original deadline pass without changing the locked row. A clock
    // projection or transaction NOW captured before the wait would be stale.
    sqlx::query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))+0.02) FROM task_claim_requests WHERE claim_id=$1")
        .bind(fixture.claim.to_string()).execute(&db).await.unwrap();
    lock.rollback().await.unwrap();
    let decision = tokio::time::timeout(std::time::Duration::from_secs(5), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(
        decision.status,
        cheers_bridge_protocol::TaskAcceptanceStatus::Rejected
    ));
    let run = fixture.run(&db).await;
    assert!(run["execution_id"].is_null());
    assert!(run["accepted_at"].is_null());
}
