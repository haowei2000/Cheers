//! Real-Postgres recovery of turns whose control connection stayed unavailable.
#![cfg(feature = "integration")]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use server::gateway::{
    realtime::{fanout::Fanout, frame::WireFrame},
    reclaimer::{sweep_bot, sweep_once, ReclaimReport},
    registry::{BotLocator, BotRegistry, InProcessBotLocator},
    stream::{self, StreamEntry, StreamRegistry},
};

#[derive(Default)]
struct RecordingFanout(Mutex<Vec<WireFrame>>);

#[async_trait]
impl Fanout for RecordingFanout {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        self.0.lock().unwrap().push(frame);
    }
    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}

struct Scenario {
    channel: Uuid,
    bot: Uuid,
    generation: Uuid,
    registry: Arc<StreamRegistry>,
    locator: Arc<InProcessBotLocator>,
    bot_locator: Arc<dyn BotLocator>,
    recorded: Arc<RecordingFanout>,
    fanout: Arc<dyn Fanout>,
}

impl Scenario {
    async fn seed(db: &PgPool) -> Self {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Reclaimer recovery')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'recovery')")
            .bind(channel.to_string())
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        let bot = Uuid::new_v4();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username) VALUES($1,$2)")
            .bind(bot.to_string())
            .bind(format!("reclaimer-{bot}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
            .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        let recorded = Arc::new(RecordingFanout::default());
        let locator = InProcessBotLocator::new();
        let mut scenario = Self {
            channel,
            bot,
            generation: Uuid::nil(),
            registry: StreamRegistry::new(),
            bot_locator: locator.clone(),
            locator,
            fanout: recorded.clone(),
            recorded,
        };
        scenario.generation = scenario.connect();
        assert!(scenario
            .locator
            .unbind_if_connection(scenario.bot, scenario.generation));
        scenario
    }

    fn connect(&self) -> Uuid {
        let control = Uuid::new_v4();
        let (control_tx, _control_rx) = tokio::sync::mpsc::channel(1);
        let (data_tx, _data_rx) = tokio::sync::mpsc::channel(1);
        let _supersede = self.locator.bind_control(self.bot, control, control_tx);
        self.locator.bind_data(self.bot, Uuid::new_v4(), data_tx);
        control
    }

    async fn placeholder(&self, db: &PgPool, bot: Uuid, registered: bool) -> Uuid {
        let message = Uuid::new_v4();
        let task = Uuid::new_v4();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,is_partial,created_at,task_id) VALUES($1,$2,$3,'bot','','text',TRUE,NOW()-INTERVAL '1 hour',$4)")
            .bind(message.to_string()).bind(self.channel.to_string()).bind(bot.to_string())
            .bind(task.to_string())
            .execute(db).await.unwrap();
        if registered {
            self.registry.register(StreamEntry {
                msg_id: message,
                bot_id: bot,
                channel_id: self.channel,
                task_id: task,
                trigger_msg_id: Uuid::new_v4(),
                session_id: None,
                finalized: false,
                last_touched_ms: Default::default(),
                ownership_verified: Default::default(),
                delta_capability: None,
                terminal_pending: false,
                delta_rejection_noticed: false,
            });
        }
        message
    }

    async fn accepted_placeholder(&self, db: &PgPool) -> (Uuid, Uuid, Uuid) {
        let message = self.placeholder(db, self.bot, true).await;
        let task: String = sqlx::query_scalar("SELECT task_id FROM messages WHERE msg_id=$1")
            .bind(message.to_string())
            .fetch_one(db)
            .await
            .unwrap();
        let task = Uuid::parse_str(&task).unwrap();
        let trigger = self.registry.trigger_msg_id(message).unwrap();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,is_partial,channel_seq,created_at) VALUES($1,$2,$3,'bot','Recovery trigger','text',FALSE,1,NOW()-INTERVAL '2 hours')")
            .bind(trigger.to_string()).bind(self.channel.to_string()).bind(self.bot.to_string()).execute(db).await.unwrap();
        sqlx::query("UPDATE channels SET next_seq=1 WHERE channel_id=$1")
            .bind(self.channel.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("UPDATE messages SET in_reply_to_msg_id=$2 WHERE msg_id=$1")
            .bind(message.to_string())
            .bind(trigger.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO bot_runs(bot_run_id,task_id,channel_id,trigger_msg_id,bot_id,placeholder_msg_id,binding_type,status) VALUES($1,$1,$2,$3,$4,$5,'acp','prepared')")
            .bind(task.to_string()).bind(self.channel.to_string()).bind(trigger.to_string())
            .bind(self.bot.to_string()).bind(message.to_string()).execute(db).await.unwrap();
        let execution = Uuid::new_v4();
        let grant = server::gateway::task_acceptance::claim(
            db,
            self.bot,
            self.generation,
            task,
            message,
            self.channel,
            execution,
        )
        .await
        .unwrap();
        assert!(matches!(
            grant.status,
            cheers_bridge_protocol::TaskAcceptanceStatus::Granted
        ));
        (message, task, execution)
    }

    async fn sweep(&self, db: &PgPool, generation: Uuid) -> ReclaimReport {
        sweep_bot(
            db,
            &self.registry,
            &self.fanout,
            &self.bot_locator,
            self.bot,
            generation,
        )
        .await
    }

    fn unavailable(&self) -> Vec<Uuid> {
        self.recorded
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame.frame_type == "bot_unavailable")
            .map(|frame| {
                frame.data["placeholder_msg_id"]
                    .as_str()
                    .unwrap()
                    .parse()
                    .unwrap()
            })
            .collect()
    }
}

async fn exists(db: &PgPool, message: Uuid) -> bool {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE msg_id=$1)")
        .bind(message.to_string())
        .fetch_one(db)
        .await
        .unwrap()
}

#[sqlx::test]
async fn persistently_offline_registered_turn_is_reclaimed_without_touching_other_bots(db: PgPool) {
    let scenario = Scenario::seed(&db).await;
    let old = scenario.placeholder(&db, scenario.bot, true).await;
    let other = scenario.placeholder(&db, Uuid::new_v4(), true).await;
    let report = scenario.sweep(&db, scenario.generation).await;
    assert_eq!(report.reclaimed, 1);
    assert!(!report.retry);
    assert!(!exists(&db, old).await);
    assert!(!scenario.registry.contains(old));
    assert!(exists(&db, other).await);
    assert!(scenario.registry.contains(other));
    assert_eq!(scenario.unavailable(), vec![old]);
    assert_eq!(scenario.sweep(&db, scenario.generation).await.reclaimed, 0);
    assert_eq!(scenario.unavailable(), vec![old]);
}

#[sqlx::test]
async fn rapid_reconnect_then_disconnect_invalidates_the_old_grace_timer(db: PgPool) {
    let scenario = Scenario::seed(&db).await;
    let old = scenario.placeholder(&db, scenario.bot, true).await;
    let next_generation = scenario.connect();
    let new = scenario.placeholder(&db, scenario.bot, true).await;
    assert_eq!(scenario.sweep(&db, scenario.generation).await.reclaimed, 0);
    assert!(scenario
        .locator
        .unbind_if_connection(scenario.bot, next_generation));
    let stale = scenario.sweep(&db, scenario.generation).await;
    assert_eq!(stale.reclaimed, 0);
    assert!(!stale.retry);
    for message in [old, new] {
        assert!(exists(&db, message).await);
        assert!(scenario.registry.contains(message));
    }
    assert!(scenario.unavailable().is_empty());
    // Only the new connection's own post-grace attempt may reclaim its turns.
    assert_eq!(scenario.sweep(&db, next_generation).await.reclaimed, 2);
}

#[sqlx::test]
async fn online_slow_work_is_never_reclaimed_by_disconnect_or_periodic_sweeps(db: PgPool) {
    let scenario = Scenario::seed(&db).await;
    let generation = scenario.connect();
    let active = scenario.placeholder(&db, scenario.bot, true).await;
    let report = scenario.sweep(&db, generation).await;
    assert_eq!(report.reclaimed, 0);
    assert!(!report.retry);
    assert_eq!(
        sweep_once(&db, &scenario.registry, &scenario.fanout, 900).await,
        0
    );
    assert!(exists(&db, active).await);
    assert!(scenario.registry.contains(active));
    assert!(scenario.unavailable().is_empty());
}

#[sqlx::test]
async fn failed_delete_reopens_claim_for_a_fenced_retry(db: PgPool) {
    let scenario = Scenario::seed(&db).await;
    let message = scenario.placeholder(&db, scenario.bot, true).await;
    sqlx::query("CREATE FUNCTION reject_reclaim_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reclaimer delete failure'; END; $$")
        .execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_reclaim_delete BEFORE DELETE ON messages FOR EACH ROW EXECUTE FUNCTION reject_reclaim_delete()")
        .execute(&db).await.unwrap();
    let failed = scenario.sweep(&db, scenario.generation).await;
    assert_eq!(failed.reclaimed, 0);
    assert!(failed.retry);
    assert!(exists(&db, message).await);
    assert!(scenario.registry.contains(message));
    assert_eq!(
        scenario.registry.active_channels(scenario.bot),
        vec![scenario.channel]
    );
    assert!(scenario.unavailable().is_empty());
    sqlx::query("DROP TRIGGER reject_reclaim_delete ON messages")
        .execute(&db)
        .await
        .unwrap();
    let recovered = scenario.sweep(&db, scenario.generation).await;
    assert_eq!(recovered.reclaimed, 1);
    assert!(!recovered.retry);
    assert!(!scenario.registry.contains(message));
    assert!(!exists(&db, message).await);
    assert_eq!(scenario.unavailable(), vec![message]);
}

#[sqlx::test]
async fn in_flight_terminal_claim_is_retried_after_cancellation(db: PgPool) {
    let scenario = Scenario::seed(&db).await;
    let (message, task, execution) = scenario.accepted_placeholder(&db).await;
    let mut lock = db.begin().await.unwrap();
    sqlx::query("SELECT msg_id FROM messages WHERE msg_id=$1 FOR UPDATE")
        .bind(message.to_string())
        .execute(&mut *lock)
        .await
        .unwrap();
    let pending = {
        let db = db.clone();
        let registry = scenario.registry.clone();
        let fanout = scenario.fanout.clone();
        let locator = scenario.bot_locator.clone();
        let bot = scenario.bot;
        let channel = scenario.channel;
        tokio::spawn(async move {
            stream::handle_done(&registry, &fanout, &db, &locator, bot, &json!({"type":"done","client_msg_id":Uuid::new_v4(),"msg_id":message,"content":"pending terminal",
                    "execution":{"task_id":task,"execution_id":execution,"channel_id":channel}}))
            .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !scenario.registry.active_channels(scenario.bot).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("terminal frame must claim the turn before waiting on DB");
    let busy = scenario.sweep(&db, scenario.generation).await;
    assert_eq!(busy.reclaimed, 0);
    assert!(
        busy.retry,
        "an in-flight terminal claim must not retire recovery"
    );
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    lock.rollback().await.unwrap();
    assert!(exists(&db, message).await);
    assert_eq!(scenario.sweep(&db, scenario.generation).await.reclaimed, 1);
}

#[sqlx::test]
async fn periodic_sweep_reclaims_old_unregistered_rows_but_preserves_registered_work(db: PgPool) {
    let scenario = Scenario::seed(&db).await;
    let active = scenario.placeholder(&db, scenario.bot, true).await;
    let orphan = scenario.placeholder(&db, scenario.bot, false).await;
    assert_eq!(
        sweep_once(&db, &scenario.registry, &scenario.fanout, 900).await,
        1
    );
    assert!(exists(&db, active).await);
    assert!(scenario.registry.contains(active));
    assert!(!exists(&db, orphan).await);
    assert_eq!(scenario.unavailable(), vec![orphan]);
}

struct UnfencedLocator;
#[async_trait]
impl BotLocator for UnfencedLocator {
    async fn dispatch_task(&self, _bot: Uuid, _task: Value) -> bool {
        false
    }
    async fn send_data(&self, _bot: Uuid, _frame: Value) -> bool {
        false
    }
    async fn is_online(&self, _bot: Uuid) -> bool {
        false
    }
}

#[sqlx::test]
async fn transports_without_a_connection_generation_fail_closed(db: PgPool) {
    let scenario = Scenario::seed(&db).await;
    let message = scenario.placeholder(&db, scenario.bot, true).await;
    let unsupported: Arc<dyn BotLocator> = Arc::new(UnfencedLocator);
    let report = sweep_bot(
        &db,
        &scenario.registry,
        &scenario.fanout,
        &unsupported,
        scenario.bot,
        scenario.generation,
    )
    .await;
    assert_eq!(report.reclaimed, 0);
    assert!(!report.retry);
    assert!(exists(&db, message).await);
    assert!(scenario.registry.contains(message));
}
