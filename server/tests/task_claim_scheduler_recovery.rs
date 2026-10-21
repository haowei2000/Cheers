//! Scheduler failure recovery races the real canonical evaluation transaction.
#![cfg(feature = "integration")]

use chrono::{DateTime, Utc};
use server::{
    domain::task_claims::{complete_evaluation, CompleteEvaluationParams, EvaluationDecision},
    gateway::task_claim_scheduler::{fail_delivery, recover_expired_evaluations},
};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

struct Evaluation {
    evaluation: Uuid,
    channel: Uuid,
    bot: Uuid,
    dispatched_at: DateTime<Utc>,
}

impl Evaluation {
    async fn seed(db: &PgPool, stale: bool) -> Self {
        let (workspace, channel, user, bot, source, evaluation) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Evaluation recovery')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name,next_seq) VALUES($1,$2,'evaluation',1)")
            .bind(channel.to_string()).bind(workspace.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'fixture')")
            .bind(user.to_string())
            .bind(format!("recovery-user-{user}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username) VALUES($1,$2)")
            .bind(bot.to_string())
            .bind(format!("recovery-bot-{bot}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
            .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,channel_seq) VALUES($1,$2,$3,'user','Investigate the actual request','text',1)")
            .bind(source.to_string()).bind(channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_bot_monitoring(channel_id,bot_id,mode,last_evaluated_seq,confidence_threshold) VALUES($1,$2,'text',1,0.75)")
            .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        let dispatched_at = sqlx::query_scalar("INSERT INTO task_claim_evaluations(evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to,status,dispatched_at) VALUES($1,$2,$3,1,1,'dispatched',CASE WHEN $4 THEN NOW()-INTERVAL '11 minutes' ELSE NOW() END) RETURNING dispatched_at")
            .bind(evaluation.to_string()).bind(channel.to_string()).bind(bot.to_string()).bind(stale)
            .fetch_one(db).await.unwrap();
        Self {
            evaluation,
            channel,
            bot,
            dispatched_at,
        }
    }

    async fn snapshot(&self, db: &PgPool) -> (String, Option<String>, i64) {
        sqlx::query_as("SELECT e.status,e.error,m.last_evaluated_seq FROM task_claim_evaluations e JOIN channel_bot_monitoring m ON m.channel_id=e.channel_id AND m.bot_id=e.bot_id WHERE e.evaluation_id=$1")
            .bind(self.evaluation.to_string()).fetch_one(db).await.unwrap()
    }
}

#[sqlx::test]
async fn concurrent_canonical_completion_preserves_its_decision_and_monitoring_cursor(db: PgPool) {
    let evaluation = Evaluation::seed(&db, true).await;
    sqlx::raw_sql("CREATE FUNCTION pause_claim_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(104723,71); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER pause_claim_completion AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.msg_type='task_claim_confirmation') EXECUTE FUNCTION pause_claim_completion()")
        .execute(&db).await.unwrap();
    let mut blocker = db.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(104723,71)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let complete = {
        let db = db.clone();
        let (bot_id, evaluation_id, channel_id) =
            (evaluation.bot, evaluation.evaluation, evaluation.channel);
        tokio::spawn(async move {
            complete_evaluation(
                &db,
                CompleteEvaluationParams {
                    bot_id,
                    evaluation_id,
                    channel_id: Some(channel_id),
                    decision: EvaluationDecision::Claim { confidence: 0.9 },
                },
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=104723 AND objid=71 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))")
                .fetch_one(&db).await.unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("canonical completion must hold its evaluation before committing");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), recover_expired_evaluations(&db))
            .await
            .expect("the sweep skips an evaluation being decided")
            .unwrap(),
        0,
    );
    assert_eq!(
        evaluation.snapshot(&db).await,
        ("dispatched".into(), None, 1)
    );
    let failed_delivery = {
        let db = db.clone();
        let (id, channel, bot, dispatched_at) = (
            evaluation.evaluation,
            evaluation.channel,
            evaluation.bot,
            evaluation.dispatched_at,
        );
        tokio::spawn(async move { fail_delivery(&db, id, channel, bot, dispatched_at).await })
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT status,source_seq_from,source_seq_to,dispatched_at FROM task_claim_evaluations%')")
                .fetch_one(&db).await.unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("failed delivery must wait for the canonical decision");
    blocker.rollback().await.unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(10), complete)
        .await
        .expect("completion does not wait on scheduler monitoring locks")
        .unwrap()
        .unwrap();
    assert!(completed.newly_decided);
    assert_eq!(completed.data["status"], "pending");
    assert!(
        !tokio::time::timeout(Duration::from_secs(10), failed_delivery)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    );
    assert_eq!(
        evaluation.snapshot(&db).await,
        ("completed".into(), None, 1)
    );
    assert_eq!(recover_expired_evaluations(&db).await.unwrap(), 0);
    let claims: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM task_claim_requests WHERE evaluation_id=$1")
            .bind(evaluation.evaluation.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(claims, 1);
}

#[sqlx::test]
async fn genuine_expiry_and_delivery_failure_recover_only_the_current_reservation(db: PgPool) {
    let expired = Evaluation::seed(&db, true).await;
    assert_eq!(recover_expired_evaluations(&db).await.unwrap(), 1);
    assert_eq!(
        expired.snapshot(&db).await,
        ("failed".into(), Some("evaluation lease expired".into()), 0),
    );
    assert_eq!(recover_expired_evaluations(&db).await.unwrap(), 0);

    let delivery = Evaluation::seed(&db, false).await;
    // A reused evaluation ID has a new committed reservation timestamp. A late
    // callback from the preceding attempt cannot consume that fresh reservation.
    let newer: DateTime<Utc> = sqlx::query_scalar("UPDATE task_claim_evaluations SET dispatched_at=dispatched_at+INTERVAL '1 microsecond' WHERE evaluation_id=$1 RETURNING dispatched_at")
        .bind(delivery.evaluation.to_string()).fetch_one(&db).await.unwrap();
    assert!(!fail_delivery(
        &db,
        delivery.evaluation,
        delivery.channel,
        delivery.bot,
        delivery.dispatched_at,
    )
    .await
    .unwrap());
    assert_eq!(delivery.snapshot(&db).await, ("dispatched".into(), None, 1));
    assert!(fail_delivery(
        &db,
        delivery.evaluation,
        delivery.channel,
        delivery.bot,
        newer,
    )
    .await
    .unwrap());
    assert_eq!(
        delivery.snapshot(&db).await,
        ("failed".into(), Some("bot went offline".into()), 0),
    );
}
