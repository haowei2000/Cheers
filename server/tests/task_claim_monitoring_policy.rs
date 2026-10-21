//! Real-Postgres authorization of proactive activity before evaluation delivery.
//! A recording transport observes offers; it does not bypass scheduler admission.
#![cfg(feature = "integration")]

use async_trait::async_trait;
use serde_json::Value;
use server::{
    domain::task_claims::{complete_evaluation, CompleteEvaluationParams, EvaluationDecision},
    gateway::{
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        task_claim_scheduler::{self, run_once},
    },
};
use sqlx::PgPool;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::Notify;
use uuid::Uuid;

#[derive(Clone)]
struct Pause {
    entered: Arc<Notify>,
    release: Arc<Notify>,
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

struct RecordingLocator {
    bot: Uuid,
    accepts_delivery: AtomicBool,
    offers: Mutex<Vec<Value>>,
    online_pause: Mutex<Option<Pause>>,
    delivery_pause: Mutex<Option<Pause>>,
}
#[async_trait]
impl BotLocator for RecordingLocator {
    async fn dispatch_task(&self, bot: Uuid, frame: Value) -> bool {
        assert_eq!(bot, self.bot);
        self.offers.lock().unwrap().push(frame);
        let pause = self.delivery_pause.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.entered.notify_one();
            pause.release.notified().await;
        }
        self.accepts_delivery.load(Ordering::SeqCst)
    }
    async fn send_data(&self, _bot: Uuid, _frame: Value) -> bool {
        false
    }
    async fn is_online(&self, bot: Uuid) -> bool {
        if bot != self.bot {
            return false;
        }
        let pause = self.online_pause.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.entered.notify_one();
            pause.release.notified().await;
        }
        true
    }
    async fn supports_task_acceptance(&self, bot: Uuid) -> bool {
        bot == self.bot
    }
}
impl RecordingLocator {
    fn offers(&self) -> Vec<Value> {
        self.offers.lock().unwrap().clone()
    }
    fn pause_online(&self) -> Pause {
        let pause = Pause {
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        *self.online_pause.lock().unwrap() = Some(pause.clone());
        pause
    }
    fn pause_delivery(&self) -> Pause {
        let pause = Pause {
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        *self.delivery_pause.lock().unwrap() = Some(pause.clone());
        pause
    }
}

struct Fixture {
    channel: Uuid,
    bot: Uuid,
    user: Uuid,
    other_user: Uuid,
    voice_session: Uuid,
    locator: Arc<RecordingLocator>,
}
impl Fixture {
    async fn seed(db: &PgPool) -> Self {
        let (workspace, channel, bot, user, other_user, voice_session) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Monitoring policy')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name,kind) VALUES($1,$2,'monitoring','text')")
            .bind(channel.to_string()).bind(workspace.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_features(channel_id,feature,config) VALUES($1,'voice','{\"transcription_mode\":\"optional\",\"consent_mode\":\"explicit\"}'::jsonb)")
            .bind(channel.to_string()).execute(db).await.unwrap();
        for id in [user, other_user] {
            sqlx::query(
                "INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'fixture')",
            )
            .bind(id.to_string())
            .bind(format!("monitor-user-{id}"))
            .execute(db)
            .await
            .unwrap();
            sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
                .bind(workspace.to_string()).bind(id.to_string()).execute(db).await.unwrap();
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')")
                .bind(channel.to_string()).bind(id.to_string()).execute(db).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO bot_accounts(bot_id,username,external_processor) VALUES($1,$2,FALSE)",
        )
        .bind(bot.to_string())
        .bind(format!("monitor-bot-{bot}"))
        .execute(db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
            .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_bot_monitoring(channel_id,bot_id,mode,scope,debounce_seconds,min_interval_seconds,max_evaluations_per_hour,batch_size,confidence_threshold) VALUES($1,$2,'text','Initial responsibility',1,1,100,8,0.75)")
            .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO voice_sessions(voice_session_id,channel_id,provider,provider_room_id,status,transcription_status) VALUES($1,$2,'fixture',$3,'active','active')")
            .bind(voice_session.to_string()).bind(channel.to_string()).bind(format!("room-{voice_session}")).execute(db).await.unwrap();
        Self {
            channel,
            bot,
            user,
            other_user,
            voice_session,
            locator: Arc::new(RecordingLocator {
                bot,
                accepts_delivery: AtomicBool::new(true),
                offers: Mutex::new(Vec::new()),
                online_pause: Mutex::new(None),
                delivery_pause: Mutex::new(None),
            }),
        }
    }

    async fn text(&self, db: &PgPool, author: Uuid, seq: i64, text: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,channel_seq,created_at) VALUES($1,$2,$3,'user',$4,'text',$5,NOW()-INTERVAL '10 minutes')")
            .bind(id.to_string()).bind(self.channel.to_string()).bind(author.to_string())
            .bind(text).bind(seq).execute(db).await.unwrap();
        sqlx::query("UPDATE channels SET next_seq=GREATEST(next_seq,$2) WHERE channel_id=$1")
            .bind(self.channel.to_string())
            .bind(seq)
            .execute(db)
            .await
            .unwrap();
        id
    }

    async fn voice(&self, db: &PgPool, speaker: Uuid, seq: i64, text: &str) -> Uuid {
        let participant = Uuid::new_v4();
        let segment = Uuid::new_v4();
        sqlx::query("INSERT INTO voice_participant_sessions(participant_session_id,voice_session_id,user_id,provider_identity,connection_nonce,joined_at,consent_version) VALUES($1,$2,$3,$4,$5,NOW()-INTERVAL '15 minutes','v1')")
            .bind(participant.to_string()).bind(self.voice_session.to_string()).bind(speaker.to_string())
            .bind(format!("participant-{participant}")).bind(Uuid::new_v4().to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO voice_transcript_segments(segment_id,voice_session_id,channel_id,participant_session_id,user_id,provider_segment_id,provider_event_id,track_id,channel_seq,text,started_at_ms,ended_at_ms,finalized_at) VALUES($1,$2,$3,$4,$5,$1,$1,'fixture-track',$6,$7,0,1000,NOW()-INTERVAL '10 minutes')")
            .bind(segment.to_string()).bind(self.voice_session.to_string()).bind(self.channel.to_string())
            .bind(participant.to_string()).bind(speaker.to_string()).bind(seq).bind(text).execute(db).await.unwrap();
        sqlx::query("UPDATE channels SET next_seq=GREATEST(next_seq,$2) WHERE channel_id=$1")
            .bind(self.channel.to_string())
            .bind(seq)
            .execute(db)
            .await
            .unwrap();
        segment
    }

    async fn monitoring(&self, db: &PgPool) -> Value {
        sqlx::query_scalar(
            "SELECT to_jsonb(m) FROM channel_bot_monitoring m WHERE channel_id=$1 AND bot_id=$2",
        )
        .bind(self.channel.to_string())
        .bind(self.bot.to_string())
        .fetch_one(db)
        .await
        .unwrap()
    }

    async fn evaluations(&self, db: &PgPool) -> Vec<Value> {
        sqlx::query_scalar("SELECT to_jsonb(e) FROM task_claim_evaluations e WHERE channel_id=$1 AND bot_id=$2 ORDER BY source_seq_from")
            .bind(self.channel.to_string()).bind(self.bot.to_string()).fetch_all(db).await.unwrap()
    }

    async fn due(&self, db: &PgPool) {
        sqlx::query("UPDATE channel_bot_monitoring SET next_eligible_at=NOW()-INTERVAL '1 second' WHERE channel_id=$1 AND bot_id=$2")
            .bind(self.channel.to_string()).bind(self.bot.to_string()).execute(db).await.unwrap();
    }

    async fn assert_unreserved(&self, db: &PgPool) {
        assert_eq!(self.monitoring(db).await["last_evaluated_seq"], 0);
        assert!(self.evaluations(db).await.is_empty());
        assert!(self.locator.offers().is_empty());
    }

    async fn run(&self, db: &PgPool) -> anyhow::Result<()> {
        let locator: Arc<dyn BotLocator> = self.locator.clone();
        run_once(db, &locator).await
    }

    fn spawn(&self, db: &PgPool) -> tokio::task::JoinHandle<anyhow::Result<()>> {
        let db = db.clone();
        let locator: Arc<dyn BotLocator> = self.locator.clone();
        tokio::spawn(async move { run_once(&db, &locator).await })
    }

    async fn deny_prompt(&self, db: &PgPool, author: Uuid) {
        sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision) VALUES($1,$2,'user',$3,'prompt','initiate','deny')")
            .bind(self.bot.to_string()).bind(self.channel.to_string()).bind(author.to_string()).execute(db).await.unwrap();
    }

    async fn consent(&self, db: &PgPool, user: Uuid, version: &str) {
        sqlx::query("INSERT INTO ai_data_consents(user_id,channel_id,bot_id,policy_version) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,channel_id,bot_id,policy_version) DO UPDATE SET revoked_at=NULL")
            .bind(user.to_string()).bind(self.channel.to_string()).bind(self.bot.to_string()).bind(version).execute(db).await.unwrap();
    }

    fn evaluation_id(&self) -> Uuid {
        self.locator.offers()[0]["evaluation_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }

    async fn complete(
        &self,
        db: &PgPool,
        decision: EvaluationDecision,
    ) -> Result<server::domain::task_claims::CompleteEvaluationOutcome, server::errors::AppError>
    {
        complete_evaluation(
            db,
            CompleteEvaluationParams {
                bot_id: self.bot,
                evaluation_id: self.evaluation_id(),
                channel_id: Some(self.channel),
                decision,
            },
        )
        .await
    }

    async fn claim_effects(&self, db: &PgPool) -> (i64, i64, i64, i64) {
        sqlx::query_as("SELECT (SELECT next_seq FROM channels WHERE channel_id=$1),(SELECT COUNT(*) FROM task_claim_requests WHERE channel_id=$1),(SELECT COUNT(*) FROM messages WHERE channel_id=$1 AND msg_type='task_claim_confirmation'),(SELECT COUNT(*) FROM message_mentions mm JOIN messages m USING(msg_id) WHERE m.channel_id=$1)")
            .bind(self.channel.to_string()).fetch_one(db).await.unwrap()
    }
}

fn activity_sequences(frame: &Value) -> Vec<i64> {
    frame["activity"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["seq"].as_i64().unwrap())
        .collect()
}

async fn wait_for_lock(db: &PgPool, blocker: i32) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(blocker).fetch_one(db).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("scheduler must wait on the locked authority row");
}

#[sqlx::test]
async fn removed_readonly_and_disabled_bots_cannot_consume_activity_even_if_transport_is_online(
    db: PgPool,
) {
    for denied in ["removed", "readonly", "disabled"] {
        let fixture = Fixture::seed(&db).await;
        fixture
            .text(
                &db,
                fixture.user,
                1,
                "Original activity must survive a bot denial",
            )
            .await;
        match denied {
            "removed" => {
                sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
                    .bind(fixture.channel.to_string())
                    .bind(fixture.bot.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "readonly" => {
                sqlx::query("UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2").bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            "disabled" => {
                sqlx::query("UPDATE bot_accounts SET is_disabled=TRUE WHERE bot_id=$1")
                    .bind(fixture.bot.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        fixture.run(&db).await.unwrap();
        fixture.assert_unreserved(&db).await;
        match denied {
            "removed" => {
                sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')").bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            "readonly" => {
                sqlx::query("UPDATE channel_memberships SET role='member' WHERE channel_id=$1 AND member_id=$2").bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            "disabled" => {
                sqlx::query("UPDATE bot_accounts SET is_disabled=FALSE WHERE bot_id=$1")
                    .bind(fixture.bot.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        fixture.due(&db).await;
        fixture.run(&db).await.unwrap();
        assert_eq!(
            activity_sequences(&fixture.locator.offers()[0]),
            vec![1],
            "{denied}"
        );
        assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 1);
    }
}

#[sqlx::test]
async fn switching_monitoring_off_after_due_selection_prevents_the_old_snapshot_from_dispatching(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    fixture
        .text(
            &db,
            fixture.user,
            1,
            "Do not send after monitoring is disabled",
        )
        .await;
    let pause = fixture.locator.pause_online();
    let running = fixture.spawn(&db);
    tokio::time::timeout(Duration::from_secs(10), pause.entered.notified())
        .await
        .unwrap();
    sqlx::query("UPDATE channel_bot_monitoring SET mode='off' WHERE channel_id=$1 AND bot_id=$2")
        .bind(fixture.channel.to_string())
        .bind(fixture.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    pause.release.notify_one();
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    fixture.assert_unreserved(&db).await;
    assert_eq!(fixture.monitoring(&db).await["mode"], "off");
}

#[sqlx::test]
async fn changed_scope_threshold_and_batch_size_are_read_from_current_monitoring_before_reservation(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    fixture
        .text(&db, fixture.user, 1, "First current activity")
        .await;
    fixture
        .text(
            &db,
            fixture.other_user,
            2,
            "Second activity waits for another batch",
        )
        .await;
    let pause = fixture.locator.pause_online();
    let running = fixture.spawn(&db);
    tokio::time::timeout(Duration::from_secs(10), pause.entered.notified())
        .await
        .unwrap();
    sqlx::query("UPDATE channel_bot_monitoring SET scope='Changed responsibility',confidence_threshold=0.9,batch_size=1,min_interval_seconds=17 WHERE channel_id=$1 AND bot_id=$2")
        .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
    pause.release.notify_one();
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let frame = fixture.locator.offers().remove(0);
    assert_eq!(frame["scope"], "Changed responsibility");
    assert_eq!(frame["confidence_threshold"], 0.9);
    assert_eq!(activity_sequences(&frame), vec![1]);
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 1);
}

#[sqlx::test]
async fn prompt_denials_filter_authors_and_a_denied_tail_waits_for_its_active_evaluation(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    fixture.text(&db, fixture.user, 1, "Denied prefix").await;
    fixture
        .text(&db, fixture.other_user, 2, "Allowed author")
        .await;
    fixture.text(&db, fixture.user, 3, "Denied tail").await;
    fixture.deny_prompt(&db, fixture.user).await;
    fixture.run(&db).await.unwrap();
    let frame = fixture.locator.offers().remove(0);
    assert_eq!(activity_sequences(&frame), vec![2]);
    assert_eq!(frame["source_seq_from"], 1);
    assert_eq!(frame["source_seq_to"], 2);
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 2);
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 2);
    assert_eq!(fixture.locator.offers().len(), 1);
    assert_eq!(fixture.evaluations(&db).await.len(), 1);
    fixture
        .complete(&db, EvaluationDecision::Ignore)
        .await
        .unwrap();
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 3);
    assert_eq!(fixture.locator.offers().len(), 1);
    assert_eq!(fixture.evaluations(&db).await.len(), 1);
}

#[sqlx::test]
async fn removed_readonly_suspended_or_deleted_authors_are_filtered_without_blocking_later_activity(
    db: PgPool,
) {
    for denied in ["removed", "readonly", "suspended", "deleted"] {
        let fixture = Fixture::seed(&db).await;
        fixture
            .text(&db, fixture.user, 1, "No longer authorized author")
            .await;
        fixture
            .text(&db, fixture.other_user, 2, "Still authorized author")
            .await;
        match denied {
            "removed" => {
                sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
                    .bind(fixture.channel.to_string())
                    .bind(fixture.user.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "readonly" => {
                sqlx::query("UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2").bind(fixture.channel.to_string()).bind(fixture.user.to_string()).execute(&db).await.unwrap();
            }
            "suspended" => {
                sqlx::query("UPDATE users SET is_suspended=TRUE WHERE user_id=$1")
                    .bind(fixture.user.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "deleted" => {
                sqlx::query("UPDATE users SET is_deleted=TRUE WHERE user_id=$1")
                    .bind(fixture.user.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        fixture.run(&db).await.unwrap();
        assert_eq!(
            activity_sequences(&fixture.locator.offers()[0]),
            vec![2],
            "{denied}"
        );
        assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 2);
    }
}

#[sqlx::test]
async fn external_ai_consent_is_current_and_specific_to_each_text_author_or_voice_speaker(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    sqlx::query("UPDATE bot_accounts SET external_processor=TRUE,processor_policy_version='v2' WHERE bot_id=$1")
        .bind(fixture.bot.to_string()).execute(&db).await.unwrap();
    sqlx::query("UPDATE channel_bot_monitoring SET mode='text_and_transcript' WHERE channel_id=$1 AND bot_id=$2")
        .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
    fixture.text(&db, fixture.user, 1, "Consented author").await;
    fixture
        .voice(
            &db,
            fixture.other_user,
            2,
            "STT consent does not grant AI processing consent",
        )
        .await;
    fixture.consent(&db, fixture.user, "v2").await;
    fixture.run(&db).await.unwrap();
    assert_eq!(activity_sequences(&fixture.locator.offers()[0]), vec![1]);
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 1);
    fixture
        .complete(&db, EvaluationDecision::Ignore)
        .await
        .unwrap();
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 2);
    fixture.consent(&db, fixture.other_user, "v1").await;
    fixture
        .voice(&db, fixture.other_user, 3, "Stale AI policy version")
        .await;
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(fixture.locator.offers().len(), 1);
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 3);
    fixture.consent(&db, fixture.other_user, "v2").await;
    fixture
        .voice(&db, fixture.other_user, 4, "Current speaker consent")
        .await;
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(activity_sequences(&fixture.locator.offers()[1]), vec![4]);
    assert_eq!(
        fixture.locator.offers()[1]["activity"][0]["kind"],
        "voice_transcript"
    );
    let voice_evaluation = fixture.locator.offers()[1]["evaluation_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        complete_evaluation(
            &db,
            CompleteEvaluationParams {
                bot_id: fixture.bot,
                evaluation_id: voice_evaluation,
                channel_id: Some(fixture.channel),
                decision: EvaluationDecision::Claim { confidence: 1.0 },
            }
        )
        .await
        .is_err(),
        "an authorized transcript evaluation is not a user-message source for a claim"
    );
    assert_eq!(fixture.claim_effects(&db).await, (4, 0, 0, 0));
    sqlx::query("UPDATE ai_data_consents SET revoked_at=NOW() WHERE user_id=$1 AND channel_id=$2 AND bot_id=$3 AND policy_version='v2'")
        .bind(fixture.other_user.to_string()).bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
    fixture
        .voice(&db, fixture.other_user, 5, "Revoked speaker consent")
        .await;
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(fixture.locator.offers().len(), 2);
    assert_eq!(fixture.evaluations(&db).await.len(), 2);
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 5);
    let duplicate = complete_evaluation(
        &db,
        CompleteEvaluationParams {
            bot_id: fixture.bot,
            evaluation_id: voice_evaluation,
            channel_id: Some(fixture.channel),
            decision: EvaluationDecision::Ignore,
        },
    )
    .await
    .unwrap();
    assert!(!duplicate.newly_decided);
    assert_eq!(duplicate.data["duplicate"], true);
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 5);
}

#[sqlx::test]
async fn legal_text_and_voice_batches_preserve_clock_order_and_exclude_deleted_transcripts(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    sqlx::query("UPDATE channel_bot_monitoring SET mode='text_and_transcript',batch_size=2 WHERE channel_id=$1 AND bot_id=$2")
        .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
    fixture.text(&db, fixture.user, 1, "Text first").await;
    fixture
        .voice(&db, fixture.other_user, 2, "Voice second")
        .await;
    let deleted = fixture
        .voice(&db, fixture.user, 3, "Deleted transcript secret")
        .await;
    sqlx::query("UPDATE voice_transcript_segments SET deleted_at=NOW() WHERE segment_id=$1")
        .bind(deleted.to_string())
        .execute(&db)
        .await
        .unwrap();
    fixture
        .text(&db, fixture.user, 4, "Text after deleted transcript")
        .await;
    fixture.run(&db).await.unwrap();
    assert_eq!(activity_sequences(&fixture.locator.offers()[0]), vec![1, 2]);
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(activity_sequences(&fixture.locator.offers()[1]), vec![4]);
    assert!(!fixture
        .locator
        .offers()
        .iter()
        .any(|frame| frame.to_string().contains("Deleted transcript secret")));
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 4);
}

#[sqlx::test]
async fn text_only_monitoring_does_not_offer_voice_activity(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    fixture
        .voice(&db, fixture.other_user, 1, "Not in text-only scope")
        .await;
    fixture.text(&db, fixture.user, 2, "Text is in scope").await;
    fixture.run(&db).await.unwrap();
    assert_eq!(activity_sequences(&fixture.locator.offers()[0]), vec![2]);
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 2);
}

#[sqlx::test]
async fn authorization_database_failure_rolls_back_the_reservation_and_retries_original_activity(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    fixture
        .text(
            &db,
            fixture.user,
            1,
            "Keep this batch on an authorization DB outage",
        )
        .await;
    sqlx::query("UPDATE bot_accounts SET external_processor=TRUE,processor_policy_version='v2' WHERE bot_id=$1")
        .bind(fixture.bot.to_string()).execute(&db).await.unwrap();
    fixture.consent(&db, fixture.user, "v2").await;
    sqlx::query("ALTER TABLE ai_data_consents RENAME TO unavailable_ai_data_consents")
        .execute(&db)
        .await
        .unwrap();
    let _failed = fixture.run(&db).await;
    fixture.assert_unreserved(&db).await;
    sqlx::query("ALTER TABLE unavailable_ai_data_consents RENAME TO ai_data_consents")
        .execute(&db)
        .await
        .unwrap();
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    assert_eq!(activity_sequences(&fixture.locator.offers()[0]), vec![1]);
    assert_eq!(fixture.evaluations(&db).await.len(), 1);
}

#[sqlx::test]
async fn bot_membership_revoked_while_reservation_waits_on_its_row_prevents_dispatch(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    fixture
        .text(
            &db,
            fixture.user,
            1,
            "Do not dispatch after a locked membership is removed",
        )
        .await;
    let mut blocker = db.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query(
        "SELECT member_id FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 FOR UPDATE",
    )
    .bind(fixture.channel.to_string())
    .bind(fixture.bot.to_string())
    .execute(&mut *blocker)
    .await
    .unwrap();
    let running = fixture.spawn(&db);
    wait_for_lock(&db, pid).await;
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
        .bind(fixture.channel.to_string())
        .bind(fixture.bot.to_string())
        .execute(&mut *blocker)
        .await
        .unwrap();
    blocker.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    fixture.assert_unreserved(&db).await;
}

#[sqlx::test]
async fn author_revoked_during_a_source_row_wait_is_filtered_before_activity_leaves_postgres(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    let source = fixture
        .text(&db, fixture.user, 1, "Author about to lose authority")
        .await;
    fixture
        .text(&db, fixture.other_user, 2, "Still allowed after the wait")
        .await;
    let mut blocker = db.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("SELECT msg_id FROM messages WHERE msg_id=$1 FOR UPDATE")
        .bind(source.to_string())
        .execute(&mut *blocker)
        .await
        .unwrap();
    let running = fixture.spawn(&db);
    wait_for_lock(&db, pid).await;
    sqlx::query("UPDATE users SET is_suspended=TRUE WHERE user_id=$1")
        .bind(fixture.user.to_string())
        .execute(&mut *blocker)
        .await
        .unwrap();
    let released: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    blocker.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(activity_sequences(&fixture.locator.offers()[0]), vec![2]);
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 2);
    let fresh_timing: (bool, bool) = sqlx::query_as("SELECT e.dispatched_at >= $3,m.next_eligible_at > $3 FROM task_claim_evaluations e JOIN channel_bot_monitoring m ON m.channel_id=e.channel_id AND m.bot_id=e.bot_id WHERE e.channel_id=$1 AND e.bot_id=$2")
        .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).bind(released)
        .fetch_one(&db).await.unwrap();
    assert_eq!(
        fresh_timing,
        (true, true),
        "lock wait must not consume the new reservation's lease or interval"
    );
}

#[sqlx::test]
async fn a_denied_tail_cannot_steal_the_rewind_cursor_from_failed_delivery_or_expiry(db: PgPool) {
    for recovery in ["delivery", "expiry"] {
        let fixture = Fixture::seed(&db).await;
        fixture.text(&db, fixture.user, 1, "Denied prefix").await;
        fixture
            .text(&db, fixture.other_user, 2, "Authorized activity to retry")
            .await;
        fixture
            .text(&db, fixture.user, 3, "Denied tail must wait")
            .await;
        fixture.deny_prompt(&db, fixture.user).await;
        let pending_delivery = if recovery == "delivery" {
            fixture
                .locator
                .accepts_delivery
                .store(false, Ordering::SeqCst);
            let pause = fixture.locator.pause_delivery();
            let running = fixture.spawn(&db);
            tokio::time::timeout(Duration::from_secs(10), pause.entered.notified())
                .await
                .unwrap();
            Some((pause, running))
        } else {
            fixture.run(&db).await.unwrap();
            None
        };
        let original = fixture.locator.offers()[0].clone();
        assert_eq!(activity_sequences(&original), vec![2]);
        assert_eq!(original["source_seq_from"], 1);
        assert_eq!(original["source_seq_to"], 2);
        assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 2);

        // The first real reservation is still dispatched (or its socket call
        // is still pending). A later tick sees only the denied trailing row.
        fixture.due(&db).await;
        fixture.run(&db).await.unwrap();
        assert_eq!(
            fixture.monitoring(&db).await["last_evaluated_seq"],
            2,
            "{recovery}"
        );
        assert_eq!(fixture.evaluations(&db).await.len(), 1);
        assert_eq!(fixture.evaluations(&db).await[0]["status"], "dispatched");
        assert_eq!(fixture.locator.offers().len(), 1);
        let deferred: bool = sqlx::query_scalar("SELECT next_eligible_at > clock_timestamp() FROM channel_bot_monitoring WHERE channel_id=$1 AND bot_id=$2")
            .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).fetch_one(&db).await.unwrap();
        assert!(
            deferred,
            "a denied tail is deferred without another evaluation"
        );

        if let Some((pause, running)) = pending_delivery {
            // Returning false drives the scheduler's actual fail_delivery path
            // after the overlapping all-denied tick has finished.
            pause.release.notify_one();
            tokio::time::timeout(Duration::from_secs(10), running)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        } else {
            sqlx::query("UPDATE task_claim_evaluations SET dispatched_at=clock_timestamp()-INTERVAL '11 minutes' WHERE evaluation_id=$1")
                .bind(fixture.evaluation_id().to_string()).execute(&db).await.unwrap();
            assert_eq!(
                task_claim_scheduler::recover_expired_evaluations(&db)
                    .await
                    .unwrap(),
                1
            );
        }
        assert_eq!(
            fixture.monitoring(&db).await["last_evaluated_seq"],
            0,
            "{recovery}"
        );
        assert_eq!(fixture.evaluations(&db).await[0]["status"], "failed");
        fixture
            .locator
            .accepts_delivery
            .store(true, Ordering::SeqCst);
        fixture.due(&db).await;
        fixture.run(&db).await.unwrap();
        let offers = fixture.locator.offers();
        assert_eq!(offers.len(), 2);
        assert_eq!(
            offers[1], original,
            "the original authorized range must be retryable: {recovery}"
        );
        assert_eq!(fixture.evaluations(&db).await.len(), 1);
        assert_eq!(fixture.evaluations(&db).await[0]["status"], "dispatched");
        assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 2);
    }
}

#[sqlx::test]
async fn failed_delivery_rewinds_then_reuses_the_same_authorized_evaluation_range(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    fixture
        .text(
            &db,
            fixture.user,
            1,
            "Exact batch survives failed socket delivery",
        )
        .await;
    fixture
        .locator
        .accepts_delivery
        .store(false, Ordering::SeqCst);
    fixture.run(&db).await.unwrap();
    let failed = fixture.evaluations(&db).await.remove(0);
    assert_eq!(failed["status"], "failed");
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 0);
    fixture
        .locator
        .accepts_delivery
        .store(true, Ordering::SeqCst);
    fixture.due(&db).await;
    fixture.run(&db).await.unwrap();
    let offered = fixture.evaluations(&db).await;
    assert_eq!(offered.len(), 1);
    assert_eq!(offered[0]["evaluation_id"], failed["evaluation_id"]);
    assert_eq!(offered[0]["status"], "dispatched");
    let frames = fixture.locator.offers();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0], frames[1]);
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 1);
}

#[sqlx::test]
async fn fresh_claim_rechecks_monitoring_prompt_consent_and_bot_membership_after_evaluation_delivery(
    db: PgPool,
) {
    for revoked in ["monitoring", "prompt", "consent", "bot_membership"] {
        let fixture = Fixture::seed(&db).await;
        fixture
            .text(
                &db,
                fixture.user,
                1,
                "A real authorized source before evaluation delivery",
            )
            .await;
        if revoked == "consent" {
            sqlx::query("UPDATE bot_accounts SET external_processor=TRUE,processor_policy_version='v2' WHERE bot_id=$1")
                .bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            fixture.consent(&db, fixture.user, "v2").await;
        }
        fixture.run(&db).await.unwrap();
        let effects = fixture.claim_effects(&db).await;
        match revoked {
            "monitoring" => {
                sqlx::query("UPDATE channel_bot_monitoring SET mode='off' WHERE channel_id=$1 AND bot_id=$2").bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            "prompt" => fixture.deny_prompt(&db, fixture.user).await,
            "consent" => {
                sqlx::query("UPDATE ai_data_consents SET revoked_at=NOW() WHERE user_id=$1 AND channel_id=$2 AND bot_id=$3").bind(fixture.user.to_string()).bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            "bot_membership" => {
                sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
                    .bind(fixture.channel.to_string())
                    .bind(fixture.bot.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            fixture
                .complete(&db, EvaluationDecision::Claim { confidence: 1.0 })
                .await
                .is_err(),
            "{revoked}"
        );
        let rejected = fixture.evaluations(&db).await;
        assert_eq!(rejected[0]["status"], "failed", "{revoked}");
        assert!(rejected[0]["completed_at"].is_string());
        assert!(rejected[0]["error"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert_eq!(
            fixture.claim_effects(&db).await,
            effects,
            "rejection has no claim/message/mention/clock effects: {revoked}"
        );
        match revoked {
            "monitoring" => {
                sqlx::query("UPDATE channel_bot_monitoring SET mode='text' WHERE channel_id=$1 AND bot_id=$2").bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            "prompt" => {
                sqlx::query("DELETE FROM bot_event_access WHERE bot_id=$1")
                    .bind(fixture.bot.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            "consent" => fixture.consent(&db, fixture.user, "v2").await,
            "bot_membership" => {
                sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')").bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            _ => unreachable!(),
        }
        let completed = fixture
            .complete(&db, EvaluationDecision::Claim { confidence: 1.0 })
            .await
            .unwrap();
        assert!(!completed.newly_decided);
        assert_eq!(completed.data["duplicate"], true);
        assert_eq!(fixture.evaluations(&db).await, rejected);
        assert_eq!(fixture.claim_effects(&db).await, effects);
    }
}

#[sqlx::test]
async fn revoked_monitoring_still_allows_its_owner_to_finish_private_ignore_or_failure_diagnostics(
    db: PgPool,
) {
    for failed in [false, true] {
        let fixture = Fixture::seed(&db).await;
        fixture
            .text(&db, fixture.user, 1, "Scoped diagnostic reservation")
            .await;
        fixture.run(&db).await.unwrap();
        sqlx::query(
            "UPDATE channel_bot_monitoring SET mode='off' WHERE channel_id=$1 AND bot_id=$2",
        )
        .bind(fixture.channel.to_string())
        .bind(fixture.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
            .bind(fixture.channel.to_string())
            .bind(fixture.bot.to_string())
            .execute(&db)
            .await
            .unwrap();
        let decision = if failed {
            EvaluationDecision::Failed {
                reason: "private ACP diagnostic".into(),
            }
        } else {
            EvaluationDecision::Ignore
        };
        let outcome = fixture.complete(&db, decision).await.unwrap();
        assert!(outcome.newly_decided);
        assert_eq!(
            outcome.data["status"],
            if failed { "failed" } else { "ignored" }
        );
        assert_eq!(
            fixture.evaluations(&db).await[0]["status"],
            if failed { "failed" } else { "ignored" }
        );
        assert_eq!(fixture.claim_effects(&db).await, (1, 0, 0, 0));
    }
}

#[sqlx::test]
async fn decided_evaluations_remain_duplicate_after_revocation_and_late_ws_diagnostics_do_not_publish(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    fixture
        .text(&db, fixture.user, 1, "One genuine canonical claim decision")
        .await;
    fixture.run(&db).await.unwrap();
    let outcome = fixture
        .complete(&db, EvaluationDecision::Claim { confidence: 1.0 })
        .await
        .unwrap();
    assert!(outcome.newly_decided);
    let effects = fixture.claim_effects(&db).await;
    let evaluation = fixture.evaluations(&db).await;
    sqlx::query("UPDATE channel_bot_monitoring SET mode='off' WHERE channel_id=$1 AND bot_id=$2")
        .bind(fixture.channel.to_string())
        .bind(fixture.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    fixture.deny_prompt(&db, fixture.user).await;
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
        .bind(fixture.channel.to_string())
        .bind(fixture.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    let duplicate = fixture
        .complete(
            &db,
            EvaluationDecision::Claim {
                confidence: f64::NAN,
            },
        )
        .await
        .unwrap();
    assert!(!duplicate.newly_decided);
    assert_eq!(duplicate.data["duplicate"], true);
    let events = Events::default();
    let late = task_claim_scheduler::complete(
        &db,
        &events,
        fixture.bot,
        fixture.evaluation_id(),
        None,
        Some("late MCP-completion diagnostic"),
    )
    .await
    .unwrap();
    assert_eq!(late["duplicate"], true);
    assert!(events.0.lock().unwrap().is_empty());
    assert_eq!(fixture.claim_effects(&db).await, effects);
    assert_eq!(fixture.evaluations(&db).await, evaluation);
}

#[sqlx::test]
async fn an_allow_rule_that_expires_during_a_source_lock_wait_cannot_authorize_the_old_transaction(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    let source = fixture
        .text(&db, fixture.user, 1, "Time-limited prompt permission")
        .await;
    sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision) VALUES($1,$2,'role','*','prompt','initiate','deny')")
        .bind(fixture.bot.to_string()).bind(fixture.channel.to_string()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision,expires_at) VALUES($1,$2,'user',$3,'prompt','initiate','allow',clock_timestamp()+INTERVAL '1 hour')")
        .bind(fixture.bot.to_string()).bind(fixture.channel.to_string()).bind(fixture.user.to_string()).execute(&db).await.unwrap();
    let mut blocker = db.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("SELECT msg_id FROM messages WHERE msg_id=$1 FOR UPDATE")
        .bind(source.to_string())
        .execute(&mut *blocker)
        .await
        .unwrap();
    let running = fixture.spawn(&db);
    wait_for_lock(&db, pid).await;
    // The scheduler's transaction already exists. Keep the rule, but let its
    // real deadline pass before the scheduler can read authorization policy.
    let expires: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("UPDATE bot_event_access SET expires_at=clock_timestamp()+INTERVAL '100 milliseconds' WHERE bot_id=$1 AND channel_id=$2 AND subject_kind='user' AND subject_id=$3 RETURNING expires_at")
        .bind(fixture.bot.to_string()).bind(fixture.channel.to_string()).bind(fixture.user.to_string()).fetch_one(&mut *blocker).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let expired: bool = sqlx::query_scalar("SELECT clock_timestamp()>$1")
                .bind(expires)
                .fetch_one(&db)
                .await
                .unwrap();
            if expired {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the allow rule's database wall-clock deadline must pass");
    blocker.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(fixture.locator.offers().is_empty());
    assert!(fixture.evaluations(&db).await.is_empty());
    assert_eq!(fixture.monitoring(&db).await["last_evaluated_seq"], 1);
}

#[sqlx::test]
async fn deleting_a_locked_parent_bot_cannot_deadlock_scheduler_or_fresh_completion_on_cascaded_rows(
    db: PgPool,
) {
    for completing in [false, true] {
        let fixture = Fixture::seed(&db).await;
        fixture
            .text(&db, fixture.user, 1, "A real source before parent deletion")
            .await;
        let evaluation = if completing {
            fixture.run(&db).await.unwrap();
            Some(fixture.evaluation_id())
        } else {
            None
        };
        let offers = fixture.locator.offers();
        let effects = fixture.claim_effects(&db).await;
        let mut blocker = db.begin().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *blocker)
            .await
            .unwrap();
        sqlx::query("SELECT bot_id FROM bot_accounts WHERE bot_id=$1 FOR UPDATE")
            .bind(fixture.bot.to_string())
            .execute(&mut *blocker)
            .await
            .unwrap();
        let running = {
            let db = db.clone();
            let bot = fixture.bot;
            let channel = fixture.channel;
            let locator: Arc<dyn BotLocator> = fixture.locator.clone();
            tokio::spawn(async move {
                if let Some(evaluation_id) = evaluation {
                    match complete_evaluation(
                        &db,
                        CompleteEvaluationParams {
                            bot_id: bot,
                            evaluation_id,
                            channel_id: Some(channel),
                            decision: EvaluationDecision::Claim { confidence: 1.0 },
                        },
                    )
                    .await
                    {
                        Err(server::errors::AppError::NotFound) => Ok(()),
                        Err(error) => Err(format!(
                            "unexpected completion failure after bot deletion: {error}"
                        )),
                        Ok(_) => Err("a deleted bot must not create a claim".to_string()),
                    }
                } else {
                    run_once(&db, &locator)
                        .await
                        .map_err(|error| error.to_string())
                }
            })
        };
        wait_for_lock(&db, pid).await;
        // This transaction already owns the parent. Its cascade must not wait
        // for monitoring/evaluation locks held by the command waiting on us.
        // A DB lock timeout also prevents deadlock detection from aborting the
        // scheduler, concealing an incorrect child-before-parent lock order.
        sqlx::query("SET LOCAL lock_timeout='500ms'")
            .execute(&mut *blocker)
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            sqlx::query("DELETE FROM bot_accounts WHERE bot_id=$1")
                .bind(fixture.bot.to_string())
                .execute(&mut *blocker),
        )
        .await
        .expect("parent deletion and its cascades must finish without a lock cycle")
        .expect("waiting scheduler/completion cannot retain a cascaded child lock");
        blocker.commit().await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .expect("the command must finish after the parent deletion commits")
            .unwrap()
            .unwrap();
        assert_eq!(fixture.locator.offers(), offers);
        assert_eq!(fixture.claim_effects(&db).await, effects);
        let children: (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM channel_bot_monitoring WHERE channel_id=$1 AND bot_id=$2),(SELECT COUNT(*) FROM task_claim_evaluations WHERE channel_id=$1 AND bot_id=$2)",
        ).bind(fixture.channel.to_string()).bind(fixture.bot.to_string())
            .fetch_one(&db).await.unwrap();
        assert_eq!(children, (0, 0));
    }
}
