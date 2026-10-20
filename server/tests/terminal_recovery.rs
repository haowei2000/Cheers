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
    stream::{self, StreamEntry, StreamRegistry},
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
        sqlx::query("INSERT INTO messages (msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,in_reply_to_msg_id,content_data) VALUES ($1,$2,'bot',$3,'','text',TRUE,$4,$5)")
            .bind(placeholder.to_string()).bind(channel.to_string()).bind(bot.to_string())
            .bind(trigger.to_string())
            .bind(json!({"pending_cards":[{"v":1,"kind":"resource_ref","uri":"cheers:desk/report.md"}]}))
            .execute(db).await.unwrap();
        let registry = StreamRegistry::new();
        if registered {
            registry.register(StreamEntry {
                msg_id: placeholder,
                bot_id: bot,
                channel_id: channel,
                task_id: Uuid::new_v4(),
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
            registry,
            fanout: recorded.clone(),
            recorded,
            locator: InProcessBotLocator::new(),
        }
    }

    fn frame(&self) -> Value {
        json!({"msg_id":self.placeholder,"content":"terminal result"})
    }

    async fn done(&self, db: &PgPool) -> Result<(), &'static str> {
        stream::handle_done(
            &self.registry,
            &self.fanout,
            db,
            &self.locator,
            self.bot,
            "",
            &self.frame(),
        )
        .await
    }

    fn spawn_done(&self, db: &PgPool) -> tokio::task::JoinHandle<Result<(), &'static str>> {
        let (db, registry, fanout, locator, bot, frame) = (
            db.clone(),
            self.registry.clone(),
            self.fanout.clone(),
            self.locator.clone(),
            self.bot,
            self.frame(),
        );
        tokio::spawn(async move {
            stream::handle_done(&registry, &fanout, &db, &locator, bot, "", &frame).await
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
    let turn = Turn::seed(&db, true).await;
    install_failure(&db, false).await;
    assert!(turn.done(&db).await.is_err());
    turn.assert_partial(&db).await;
    remove_failure(&db).await;
    turn.done(&db)
        .await
        .expect("a transient write failure must permit retry");
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn terminal_commit_failure_can_retry_without_consuming_a_sequence(db: PgPool) {
    let turn = Turn::seed(&db, true).await;
    install_failure(&db, true).await;
    assert!(turn.done(&db).await.is_err());
    turn.assert_partial(&db).await;
    remove_failure(&db).await;
    turn.done(&db)
        .await
        .expect("a failed COMMIT must release the in-memory claim");
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn cancellation_during_terminal_update_releases_the_claim_for_retry(db: PgPool) {
    let turn = Turn::seed(&db, true).await;
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
    let mut turn = Turn::seed(&db, true).await;
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
    assert!(
        tokio::time::timeout(Duration::from_secs(10), turn.done(&db))
            .await
            .expect("a committed turn must reject replay before terminal delivery")
            .is_err()
    );
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn concurrent_done_frames_commit_and_broadcast_only_once(db: PgPool) {
    let turn = Turn::seed(&db, true).await;
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
    assert!(turn.done(&db).await.is_err());
    turn.assert_final(&db).await;
}

#[sqlx::test]
async fn restart_with_an_empty_stream_registry_can_finalize_the_durable_placeholder(db: PgPool) {
    let turn = Turn::seed(&db, false).await;
    assert!(!turn.registry.contains(turn.placeholder));
    turn.done(&db)
        .await
        .expect("durable ownership must allow done replay after gateway restart");
    turn.assert_final(&db).await;
    assert!(turn.done(&db).await.is_err());
    turn.assert_final(&db).await;
}
