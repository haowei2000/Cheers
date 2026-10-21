//! Real-Postgres fault injection around terminal message commits.
//! Run with `DATABASE_URL=... cargo test --features integration --test terminal_recovery`.
#![cfg(feature = "integration")]

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use server::gateway::{
    realtime::{fanout::Fanout, frame::WireFrame},
    registry::{BotLocator, InProcessBotLocator},
    stream::{self, StreamEntry, StreamRegistry, TerminalError, TerminalOutcome},
};

#[derive(Default)]
struct RecordingFanout(Mutex<Vec<WireFrame>>);

#[async_trait]
impl Fanout for RecordingFanout {
    async fn broadcast_channel(&self, _channel_id: Uuid, frame: WireFrame) {
        self.0.lock().unwrap().push(frame);
    }
    async fn broadcast_user(&self, _user_id: Uuid, _frame: WireFrame) {}
}

impl RecordingFanout {
    fn terminal_count(&self) -> usize {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame.frame_type == "message_done")
            .count()
    }
}

/// Pause the terminal delivery path after recording its invocation, so a task
/// can be cancelled after its commit while it still awaits external IO.
struct PausedTerminalFanout {
    recorded: Arc<RecordingFanout>,
    entered: tokio::sync::Notify,
}

#[async_trait]
impl Fanout for PausedTerminalFanout {
    async fn broadcast_channel(&self, channel_id: Uuid, frame: WireFrame) {
        let terminal = frame.frame_type == "message_done";
        self.recorded.broadcast_channel(channel_id, frame).await;
        if terminal {
            self.entered.notify_one();
            std::future::pending::<()>().await;
        }
    }

    async fn broadcast_user(&self, _user_id: Uuid, _frame: WireFrame) {}
}

struct Turn {
    channel: Uuid,
    bot: Uuid,
    placeholder: Uuid,
    trigger: Uuid,
    task_id: Uuid,
    execution_id: Option<Uuid>,
    terminal_client_msg_id: Uuid,
    registry: Arc<StreamRegistry>,
    recorded: Arc<RecordingFanout>,
    fanout: Arc<dyn Fanout>,
    locator: Arc<dyn BotLocator>,
}

impl Turn {
    async fn seed(db: &PgPool, registered: bool) -> Self {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let user = Uuid::new_v4();
        let bot = Uuid::new_v4();
        let trigger = Uuid::new_v4();
        let placeholder = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (workspace_id,name) VALUES ($1,'Terminal recovery')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels (channel_id,workspace_id,name,next_seq) VALUES ($1,$2,'terminal',1)")
            .bind(channel.to_string()).bind(workspace.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO users (user_id,username,password_hash) VALUES ($1,$2,'x')")
            .bind(user.to_string())
            .bind(format!("terminal-user-{user}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO bot_accounts (bot_id,username) VALUES ($1,$2)")
            .bind(bot.to_string())
            .bind(format!("terminal-bot-{bot}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channel_memberships (channel_id,member_id,member_type) VALUES ($1,$2,'bot')")
            .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        // Keep the real same-channel reply/thread and channel-clock invariants.
        sqlx::query("INSERT INTO messages (msg_id,channel_id,sender_type,sender_id,content,msg_type,channel_seq) VALUES ($1,$2,'user',$3,'trigger','text',1)")
            .bind(trigger.to_string()).bind(channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO messages (msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,in_reply_to_msg_id,content_data,task_id) VALUES ($1,$2,'bot',$3,'','text',TRUE,$4,$5,$6)")
            .bind(placeholder.to_string()).bind(channel.to_string()).bind(bot.to_string())
            .bind(trigger.to_string())
            .bind(json!({"pending_cards":[{"v":1,"kind":"resource_ref","uri":"cheers:desk/report.md"}]}))
            .bind(task_id.to_string())
            .execute(db).await.unwrap();
        let registry = StreamRegistry::new();
        if registered {
            registry.register(StreamEntry {
                msg_id: placeholder,
                bot_id: bot,
                channel_id: channel,
                task_id,
                trigger_msg_id: trigger,
                session_id: None,
                finalized: false,
                last_touched_ms: Default::default(),
            });
        }
        let recorded = Arc::new(RecordingFanout::default());
        Self {
            channel,
            bot,
            placeholder,
            trigger,
            task_id,
            execution_id: None,
            terminal_client_msg_id: Uuid::new_v4(),
            registry,
            fanout: recorded.clone(),
            recorded,
            locator: InProcessBotLocator::new(),
        }
    }

    fn frame(&self) -> Value {
        let mut frame = json!({"msg_id":self.placeholder,"content":"terminal result"});
        if let Some(execution_id) = self.execution_id {
            frame["type"] = json!("done");
            frame["client_msg_id"] = json!(self.terminal_client_msg_id);
            frame["execution"] = json!({"task_id":self.task_id,"execution_id":execution_id,"channel_id":self.channel});
        }
        frame
    }

    async fn accepted(db: &PgPool, registered: bool) -> Self {
        let mut turn = Self::seed(db, registered).await;
        let execution = Uuid::new_v4();
        sqlx::query("INSERT INTO bot_runs(bot_run_id,task_id,channel_id,trigger_msg_id,bot_id,placeholder_msg_id,binding_type,status) VALUES($1,$1,$2,$3,$4,$5,'acp','prepared')")
            .bind(turn.task_id.to_string()).bind(turn.channel.to_string())
            .bind(turn.trigger.to_string())
            .bind(turn.bot.to_string()).bind(turn.placeholder.to_string())
            .execute(db).await.unwrap();
        let grant = server::gateway::task_acceptance::claim(
            db,
            turn.bot,
            Uuid::new_v4(),
            turn.task_id,
            turn.placeholder,
            turn.channel,
            execution,
        )
        .await
        .unwrap();
        assert!(matches!(
            grant.status,
            cheers_bridge_protocol::TaskAcceptanceStatus::Granted
        ));
        turn.execution_id = Some(execution);
        turn
    }

    async fn done(&self, db: &PgPool) -> Result<TerminalOutcome, TerminalError> {
        self.submit(db, &self.frame()).await
    }

    async fn submit(&self, db: &PgPool, frame: &Value) -> Result<TerminalOutcome, TerminalError> {
        stream::handle_done(
            &self.registry,
            &self.fanout,
            db,
            &self.locator,
            self.bot,
            frame,
        )
        .await
    }

    fn spawn_done(
        &self,
        db: &PgPool,
    ) -> tokio::task::JoinHandle<Result<TerminalOutcome, TerminalError>> {
        let (db, registry, fanout, locator, bot, frame) = (
            db.clone(),
            self.registry.clone(),
            self.fanout.clone(),
            self.locator.clone(),
            self.bot,
            self.frame(),
        );
        tokio::spawn(async move {
            stream::handle_done(&registry, &fanout, &db, &locator, bot, &frame).await
        })
    }

    async fn assert_partial(&self, db: &PgPool) {
        let row: (bool, Option<i64>, String, Option<Value>) = sqlx::query_as(
            "SELECT is_partial,channel_seq,content,content_data FROM messages WHERE msg_id=$1",
        )
        .bind(self.placeholder.to_string())
        .fetch_one(db)
        .await
        .unwrap();
        assert!(row.0);
        assert_eq!(row.1, None);
        assert_eq!(row.2, "");
        assert!(
            row.3.unwrap().get("pending_cards").is_some(),
            "rolled-back card promotion must stay pending"
        );
        assert_eq!(
            self.next_seq(db).await,
            1,
            "failed/cancelled finalize cannot consume a channel sequence"
        );
        assert_eq!(
            self.recorded.terminal_count(),
            0,
            "a terminal frame must follow its DB commit"
        );
        assert!(
            self.registry.contains(self.placeholder),
            "a recoverable registered turn must remain available"
        );
    }

    async fn assert_final(&self, db: &PgPool) {
        let row: (bool, Option<i64>, String, Option<Value>) = sqlx::query_as(
            "SELECT is_partial,channel_seq,content,content_data FROM messages WHERE msg_id=$1",
        )
        .bind(self.placeholder.to_string())
        .fetch_one(db)
        .await
        .unwrap();
        assert!(!row.0);
        assert_eq!(row.1, Some(2));
        assert_eq!(row.2, "terminal result");
        let metadata = row.3.unwrap();
        assert!(metadata.get("pending_cards").is_none());
        assert!(metadata.get("cards").is_some());
        assert_eq!(self.next_seq(db).await, 2);
        assert_eq!(self.recorded.terminal_count(), 1);
        assert!(!self.registry.contains(self.placeholder));
    }

    async fn next_seq(&self, db: &PgPool) -> i64 {
        sqlx::query_scalar("SELECT next_seq FROM channels WHERE channel_id=$1")
            .bind(self.channel.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn assert_no_receipt(&self, db: &PgPool) {
        let receipt: Value = sqlx::query_scalar(
            "SELECT to_jsonb(bot_runs) FROM bot_runs WHERE placeholder_msg_id=$1",
        )
        .bind(self.placeholder.to_string())
        .fetch_one(db)
        .await
        .unwrap();
        assert!(receipt["terminal_client_msg_id"].is_null());
        assert!(receipt["terminal_fingerprint"].is_null());
        assert!(receipt["terminal_committed_at"].is_null());
        assert_eq!(receipt["status"], "accepted");
    }
}

async fn install_failure(db: &PgPool, deferred: bool) {
    sqlx::raw_sql("CREATE FUNCTION reject_terminal_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected terminal write failure'; END $$")
        .execute(db).await.unwrap();
    let trigger = if deferred {
        "CREATE CONSTRAINT TRIGGER reject_terminal_write AFTER UPDATE ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.is_partial AND NOT NEW.is_partial) EXECUTE FUNCTION reject_terminal_write()"
    } else {
        "CREATE TRIGGER reject_terminal_write BEFORE UPDATE OF is_partial ON messages FOR EACH ROW WHEN (OLD.is_partial AND NOT NEW.is_partial) EXECUTE FUNCTION reject_terminal_write()"
    };
    sqlx::raw_sql(trigger).execute(db).await.unwrap();
}

async fn remove_failure(db: &PgPool) {
    sqlx::raw_sql(
        "DROP TRIGGER reject_terminal_write ON messages; DROP FUNCTION reject_terminal_write()",
    )
    .execute(db)
    .await
    .unwrap();
}

/// The lock is scoped to this test's isolated database, and transaction Drop also
/// releases it if the test fails. Observe pg_locks instead of relying on a sleep.
async fn block_terminal_update(db: &PgPool) -> Transaction<'_, Postgres> {
    let mut blocker = db.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(104729, 42)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION block_terminal_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(104729, 42); RETURN NEW; END $$; CREATE TRIGGER block_terminal_write BEFORE UPDATE OF is_partial ON messages FOR EACH ROW WHEN (OLD.is_partial AND NOT NEW.is_partial) EXECUTE FUNCTION block_terminal_write()")
        .execute(db).await.unwrap();
    blocker
}

async fn wait_until_update_is_blocked(db: &PgPool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let blocked: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=104729 AND objid=42 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))")
                .fetch_one(db).await.unwrap();
            if blocked { return; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("handle_done must reach the blocked terminal UPDATE");
}

async fn remove_block(db: &PgPool) {
    tokio::time::timeout(
        Duration::from_secs(10),
        sqlx::raw_sql(
            "DROP TRIGGER block_terminal_write ON messages; DROP FUNCTION block_terminal_write()",
        )
        .execute(db),
    )
    .await
    .expect("the completed/cancelled transaction must release its message lock")
    .unwrap();
}

#[sqlx::test]
async fn terminal_update_failure_can_retry_without_poisoning_the_stream(db: PgPool) {
    let turn = Turn::accepted(&db, true).await;
    install_failure(&db, false).await;
    assert!(turn.done(&db).await.is_err());
    turn.assert_partial(&db).await;
    turn.assert_no_receipt(&db).await;
    remove_failure(&db).await;
    turn.done(&db)
        .await
        .expect("a transient write failure must permit retry");
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn terminal_commit_failure_can_retry_without_consuming_a_sequence(db: PgPool) {
    let turn = Turn::accepted(&db, true).await;
    install_failure(&db, true).await;
    assert!(turn.done(&db).await.is_err());
    turn.assert_partial(&db).await;
    turn.assert_no_receipt(&db).await;
    remove_failure(&db).await;
    turn.done(&db)
        .await
        .expect("a failed COMMIT must release the in-memory claim");
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn cancellation_during_terminal_update_releases_the_claim_for_retry(db: PgPool) {
    let turn = Turn::accepted(&db, true).await;
    let blocker = block_terminal_update(&db).await;
    let done = turn.spawn_done(&db);
    wait_until_update_is_blocked(&db).await;
    done.abort();
    assert!(done.await.unwrap_err().is_cancelled());
    blocker.rollback().await.unwrap();
    remove_block(&db).await; // also waits for the cancelled transaction to release its row locks
    turn.assert_partial(&db).await;
    tokio::time::timeout(Duration::from_secs(10), turn.done(&db))
        .await
        .unwrap()
        .expect("cancelling the request must not poison its terminal claim");
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn cancellation_after_commit_does_not_retain_a_stream_claim(db: PgPool) {
    let mut turn = Turn::accepted(&db, true).await;
    let paused = Arc::new(PausedTerminalFanout {
        recorded: turn.recorded.clone(),
        entered: tokio::sync::Notify::new(),
    });
    turn.fanout = paused.clone();
    let done = turn.spawn_done(&db);
    tokio::time::timeout(Duration::from_secs(10), paused.entered.notified())
        .await
        .expect("terminal fanout must follow the successful DB commit");
    // Delivery is still pending: durable completion must already release memory.
    turn.assert_final(&db).await;
    done.abort();
    assert!(done.await.unwrap_err().is_cancelled());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), turn.done(&db))
            .await
            .expect("a committed result replays while its original fanout is cancelled")
            .unwrap(),
        TerminalOutcome::Replayed
    );
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn concurrent_done_frames_commit_and_broadcast_only_once(db: PgPool) {
    let turn = Turn::accepted(&db, true).await;
    let blocker = block_terminal_update(&db).await;
    let first = turn.spawn_done(&db);
    wait_until_update_is_blocked(&db).await;
    assert!(
        tokio::time::timeout(Duration::from_secs(10), turn.done(&db))
            .await
            .unwrap()
            .is_err(),
        "a second terminal frame cannot claim a turn already being finalized"
    );
    blocker.rollback().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), first)
        .await
        .expect("the winning terminal frame must complete once its DB barrier is released")
        .unwrap()
        .expect("the winning terminal frame should commit");
    remove_block(&db).await;
    turn.assert_final(&db).await;
    assert_eq!(turn.done(&db).await.unwrap(), TerminalOutcome::Replayed);
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn restart_with_an_empty_stream_registry_can_finalize_the_durable_placeholder(db: PgPool) {
    let turn = Turn::accepted(&db, false).await;
    assert!(!turn.registry.contains(turn.placeholder));
    turn.done(&db)
        .await
        .expect("durable ownership must allow done replay after gateway restart");
    turn.assert_final(&db).await;
    assert_eq!(turn.done(&db).await.unwrap(), TerminalOutcome::Replayed);
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn accepted_result_replays_after_gateway_restart_without_repeating_effects(db: PgPool) {
    let mut turn = Turn::accepted(&db, true).await;
    assert_eq!(turn.done(&db).await.unwrap(), TerminalOutcome::Committed);
    turn.assert_final(&db).await;
    let receipt: Value =
        sqlx::query_scalar("SELECT to_jsonb(bot_runs) FROM bot_runs WHERE placeholder_msg_id=$1")
            .bind(turn.placeholder.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        receipt["terminal_client_msg_id"],
        turn.terminal_client_msg_id.to_string()
    );
    assert_eq!(receipt["terminal_fingerprint"].as_str().unwrap().len(), 64);
    assert!(receipt["terminal_committed_at"].is_string());
    assert_eq!(receipt["status"], "completed");
    turn.registry = StreamRegistry::new();
    assert_eq!(turn.done(&db).await.unwrap(), TerminalOutcome::Replayed);
    turn.assert_final(&db).await;
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(bot_runs) FROM bot_runs WHERE placeholder_msg_id=$1")
            .bind(turn.placeholder.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(after, receipt);
}

#[sqlx::test]
async fn receipt_allows_a_fresh_signature_but_rejects_every_changed_unsigned_field(db: PgPool) {
    let turn = Turn::accepted(&db, true).await;
    let mut frame = turn.frame();
    frame["provider_session_key"] = json!("original-scope");
    frame["acp_capability"] = json!({"nonce":"original"});
    assert_eq!(
        turn.submit(&db, &frame).await.unwrap(),
        TerminalOutcome::Committed
    );
    frame["acp_capability"] = json!({"nonce":"fresh"});
    assert_eq!(
        turn.submit(&db, &frame).await.unwrap(),
        TerminalOutcome::Replayed
    );
    for (key, value) in [
        ("content", json!("changed")),
        ("client_msg_id", json!(Uuid::new_v4())),
        ("provider_session_key", json!("another-scope")),
        ("mention_ids", json!([])),
        ("type", json!("error")),
    ] {
        let mut changed = frame.clone();
        changed[key] = value;
        let error = turn.submit(&db, &changed).await.unwrap_err();
        assert_eq!(error.code, "TERMINAL_CONFLICT", "{key}");
        assert!(!error.retryable);
    }
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn reclaimed_result_is_negative_but_a_committed_receipt_survives_message_deletion(
    db: PgPool,
) {
    let missing = Turn::accepted(&db, true).await;
    sqlx::query("DELETE FROM messages WHERE msg_id=$1")
        .bind(missing.placeholder.to_string())
        .execute(&db)
        .await
        .unwrap();
    let error = missing.done(&db).await.unwrap_err();
    assert_eq!(error.code, "TERMINAL_GONE");
    assert!(!error.retryable);
    missing.assert_no_receipt(&db).await;
    assert_eq!(missing.next_seq(&db).await, 1);

    let completed = Turn::accepted(&db, true).await;
    assert_eq!(
        completed.done(&db).await.unwrap(),
        TerminalOutcome::Committed
    );
    sqlx::query("DELETE FROM messages WHERE msg_id=$1")
        .bind(completed.placeholder.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        completed.done(&db).await.unwrap(),
        TerminalOutcome::Replayed
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE msg_id=$1")
        .bind(completed.placeholder.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(rows, 0, "a receipt cannot recreate a deleted message");
    assert_eq!(completed.recorded.terminal_count(), 1);
    assert_eq!(completed.next_seq(&db).await, 2);
}

#[sqlx::test]
async fn an_inflight_result_retries_until_the_single_commit_can_be_acknowledged(db: PgPool) {
    let turn = Turn::accepted(&db, true).await;
    let blocker = block_terminal_update(&db).await;
    let first = turn.spawn_done(&db);
    wait_until_update_is_blocked(&db).await;
    let busy = turn.done(&db).await.unwrap_err();
    assert_eq!(busy.code, "TERMINAL_BUSY");
    assert!(busy.retryable);
    turn.assert_no_receipt(&db).await;
    blocker.rollback().await.unwrap();
    assert_eq!(first.await.unwrap().unwrap(), TerminalOutcome::Committed);
    remove_block(&db).await;
    assert_eq!(turn.done(&db).await.unwrap(), TerminalOutcome::Replayed);
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn legacy_or_unowned_terminal_frames_cannot_change_messages_receipts_or_registry(db: PgPool) {
    for case in ["accepted", "missing_run", "old_status"] {
        let turn = if case == "accepted" {
            Turn::accepted(&db, true).await
        } else {
            Turn::seed(&db, true).await
        };
        if case == "old_status" {
            sqlx::query("INSERT INTO bot_runs(bot_run_id,task_id,channel_id,trigger_msg_id,bot_id,placeholder_msg_id,binding_type,status) VALUES($1,$1,$2,$3,$4,$5,'acp','placeholder_created')")
                .bind(turn.task_id.to_string()).bind(turn.channel.to_string()).bind(turn.trigger.to_string())
                .bind(turn.bot.to_string()).bind(turn.placeholder.to_string()).execute(&db).await.unwrap();
        }
        let before: Option<Value> =
            sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE placeholder_msg_id=$1")
                .bind(turn.placeholder.to_string())
                .fetch_optional(&db)
                .await
                .unwrap();
        let shapes: &[&str] = if case == "accepted" {
            &["missing", "null"]
        } else {
            &["missing", "null", "ungranted"]
        };
        for shape in shapes {
            let mut frame = turn.frame();
            frame["type"] = json!("done");
            frame["client_msg_id"] = json!(turn.terminal_client_msg_id);
            match *shape {
                "missing" => {
                    frame.as_object_mut().unwrap().remove("execution");
                }
                "null" => frame["execution"] = Value::Null,
                "ungranted" => {
                    // Well-formed IDs cannot repair a missing or historical grant.
                    frame["execution"] = json!({"task_id":turn.task_id,"execution_id":Uuid::new_v4(),"channel_id":turn.channel});
                }
                _ => unreachable!(),
            }
            let error = turn.submit(&db, &frame).await.unwrap_err();
            let expected = if *shape != "ungranted" {
                "INVALID_FRAME"
            } else if case == "missing_run" {
                "TERMINAL_GONE"
            } else {
                "TERMINAL_FORBIDDEN"
            };
            assert_eq!(error.code, expected, "{case}/{shape}");
            assert!(!error.retryable);
            turn.assert_partial(&db).await;
            assert_eq!(turn.registry.active_channels(turn.bot), vec![turn.channel]);
            let after: Option<Value> = sqlx::query_scalar(
                "SELECT to_jsonb(r) FROM bot_runs r WHERE placeholder_msg_id=$1",
            )
            .bind(turn.placeholder.to_string())
            .fetch_optional(&db)
            .await
            .unwrap();
            assert_eq!(
                after, before,
                "{case}/{shape} must not create a grant or receipt"
            );
        }
    }
}
