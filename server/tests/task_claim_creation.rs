//! The MCP resource adapter and legacy WS decision adapter share one claim commit.
//! These are direct adapter/PG tests. MCP publication calls the real shared helper
//! after a successful resource result, matching the effects layer's boundary;
//! this fixture does not claim to exercise HTTP MCP or a websocket transport.
#![cfg(feature = "integration")]

use async_trait::async_trait;
use serde_json::{json, Value};
use server::{
    gateway::{
        realtime::{fanout::Fanout, frame::WireFrame},
        resource_effects, task_claim_scheduler,
    },
    resource::{self, Principal},
};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Default)]
struct Events(Mutex<Vec<(String, Value)>>);
#[async_trait]
impl Fanout for Events {
    async fn broadcast_channel(&self, _channel: Uuid, frame: WireFrame) {
        self.0.lock().unwrap().push((frame.frame_type, frame.data));
    }
    async fn broadcast_user(&self, _user: Uuid, _frame: WireFrame) {}
}
impl Events {
    fn snapshot(&self) -> Vec<(String, Value)> {
        self.0.lock().unwrap().clone()
    }
    fn counts(&self) -> (usize, usize, usize) {
        let events = self.0.lock().unwrap();
        let count = |kind: &str| events.iter().filter(|(name, _)| name == kind).count();
        (
            count("message"),
            count("task_claim_created"),
            count("board_signal"),
        )
    }
}
#[derive(Clone, Copy, Debug)]
enum Adapter {
    Mcp,
    LegacyWs,
}
impl Adapter {
    fn other(self) -> Self {
        match self {
            Self::Mcp => Self::LegacyWs,
            Self::LegacyWs => Self::Mcp,
        }
    }
}
#[derive(Clone)]
struct Fixture {
    user: Uuid,
    bot: Uuid,
    other_bot: Uuid,
    channel: Uuid,
    source: Uuid,
    evaluation: Uuid,
}
impl Fixture {
    const SOURCE: &'static str = "  A source-owned task: investigate the original incident.  ";
    async fn seed(db: &PgPool) -> Self {
        let (user, bot, other_bot, workspace, channel, source, evaluation) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'fixture')")
            .bind(user.to_string())
            .bind(format!("creation-user-{user}"))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Claim creation')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'member','active')")
            .bind(workspace.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channels(channel_id,workspace_id,name,next_seq) VALUES($1,$2,'creation',1)")
            .bind(channel.to_string()).bind(workspace.to_string()).execute(db).await.unwrap();
        for id in [bot, other_bot] {
            sqlx::query("INSERT INTO bot_accounts(bot_id,username,display_name,external_processor) VALUES($1,$2,'Claim worker',FALSE)")
                .bind(id.to_string()).bind(format!("creation-bot-{id}")).execute(db).await.unwrap();
            sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
                .bind(channel.to_string()).bind(id.to_string()).execute(db).await.unwrap();
        }
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')")
            .bind(channel.to_string()).bind(user.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,channel_seq) VALUES($1,$2,'user',$3,$4,'text',FALSE,1)")
            .bind(source.to_string()).bind(channel.to_string()).bind(user.to_string()).bind(Self::SOURCE).execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_bot_monitoring(channel_id,bot_id,mode,confidence_threshold,next_eligible_at) VALUES($1,$2,'text',0.75,NOW()+INTERVAL '1 day')")
            .bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO task_claim_evaluations(evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to,status,dispatched_at) VALUES($1,$2,$3,1,1,'dispatched',NOW())")
            .bind(evaluation.to_string()).bind(channel.to_string()).bind(bot.to_string()).execute(db).await.unwrap();
        Self {
            user,
            bot,
            other_bot,
            channel,
            source,
            evaluation,
        }
    }
    async fn submit_as(
        &self,
        db: &PgPool,
        events: &Events,
        adapter: Adapter,
        bot: Uuid,
        decision: &str,
        confidence: Option<f64>,
    ) -> Result<Value, String> {
        // Legacy model-supplied descriptions never own the durable task. Supply
        // tempting overrides to both adapters to catch accidental divergence.
        let body = json!({"decision":decision,"confidence":confidence,"summary":"FORGED MODEL SUMMARY",
            "proposed_action":"FORGED MODEL ACTION","impact":"high","requester_id":self.other_bot,
            "source_message_id":Uuid::new_v4()});
        match adapter {
            Adapter::Mcp => {
                let mut params = body;
                params["channel_id"] = json!(self.channel);
                params["evaluation_id"] = json!(self.evaluation);
                let data =
                    resource::task_claims::handle_evaluate(db, &Principal::bot(bot), &params)
                        .await
                        .map_err(|(code, message)| format!("{code}: {message}"))?;
                // The resource function is deliberately publication-free; use
                // the production postcommit helper, as dispatch_with_effects does.
                resource_effects::publish_claim_evaluation(events, &data).await;
                Ok(data)
            }
            Adapter::LegacyWs => task_claim_scheduler::complete(
                db,
                events,
                bot,
                self.evaluation,
                Some(&body.to_string()),
                None,
            )
            .await
            .map_err(|error| error.to_string()),
        }
    }
    async fn submit(
        &self,
        db: &PgPool,
        events: &Events,
        adapter: Adapter,
        decision: &str,
        confidence: Option<f64>,
    ) -> Result<Value, String> {
        self.submit_as(db, events, adapter, self.bot, decision, confidence)
            .await
    }
    async fn evaluation(&self, db: &PgPool) -> Value {
        sqlx::query_scalar(
            "SELECT to_jsonb(e) FROM task_claim_evaluations e WHERE evaluation_id=$1",
        )
        .bind(self.evaluation.to_string())
        .fetch_one(db)
        .await
        .unwrap()
    }
    async fn claim(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM task_claim_requests r WHERE evaluation_id=$1")
            .bind(self.evaluation.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }
    async fn counts(&self, db: &PgPool) -> (i64, i64, i64, i64) {
        sqlx::query_as("SELECT (SELECT COUNT(*) FROM task_claim_requests WHERE evaluation_id=$1),(SELECT COUNT(*) FROM messages WHERE channel_id=$2 AND msg_type='task_claim_confirmation'),(SELECT COUNT(*) FROM message_mentions mm JOIN messages m USING(msg_id) WHERE m.channel_id=$2),(SELECT next_seq FROM channels WHERE channel_id=$2)")
            .bind(self.evaluation.to_string()).bind(self.channel.to_string()).fetch_one(db).await.unwrap()
    }
    async fn assert_created(&self, db: &PgPool, data: &Value) {
        assert_eq!(data["status"], "pending");
        let claim = self.claim(db).await;
        assert_eq!(claim["claim_id"], data["claim_id"]);
        assert_eq!(claim["requester_id"], self.user.to_string());
        assert_eq!(claim["source_message_id"], self.source.to_string());
        assert_eq!(claim["summary"], Self::SOURCE.trim());
        assert_eq!(
            claim["proposed_action"],
            "Start the requested work and report the result in this channel."
        );
        assert_eq!(claim["impact"], "medium");
        assert_eq!(claim["status"], "pending");
        assert_eq!(
            claim["confirmation_message_id"],
            data["confirmation_message"]["msg_id"]
        );
        let message: Value =
            sqlx::query_scalar("SELECT to_jsonb(m) FROM messages m WHERE msg_id=$1")
                .bind(claim["confirmation_message_id"].as_str().unwrap())
                .fetch_one(db)
                .await
                .unwrap();
        assert_eq!(message["content"], data["confirmation_message"]["content"]);
        assert_eq!(message["sender_id"], self.bot.to_string());
        assert_eq!(message["in_reply_to_msg_id"], self.source.to_string());
        assert_eq!(message["channel_seq"], 2);
        assert_eq!(
            message["content_data"]["requester_id"],
            self.user.to_string()
        );
        assert_eq!(message["content_data"]["resolved"], false);
        let mention: (String, String) =
            sqlx::query_as("SELECT member_id,member_type FROM message_mentions WHERE msg_id=$1")
                .bind(claim["confirmation_message_id"].as_str().unwrap())
                .fetch_one(db)
                .await
                .unwrap();
        assert_eq!(mention, (self.user.to_string(), "user".into()));
        assert_eq!(self.counts(db).await, (1, 1, 1, 2));
        assert_eq!(self.evaluation(db).await["status"], "completed");
    }
}

#[sqlx::test]
async fn both_adapters_derive_the_same_claim_and_complete_confirmation_from_the_source(db: PgPool) {
    let mut semantics = Vec::new();
    for adapter in [Adapter::Mcp, Adapter::LegacyWs] {
        let fixture = Fixture::seed(&db).await;
        let events = Events::default();
        let data = fixture
            .submit(&db, &events, adapter, "claim", Some(0.9))
            .await
            .unwrap();
        fixture.assert_created(&db, &data).await;
        let claim = fixture.claim(&db).await;
        semantics.push(json!({"summary":claim["summary"],"action":claim["proposed_action"],"confidence":claim["confidence"],"impact":claim["impact"],"status":claim["status"]}));
        assert_eq!(events.counts(), (1, 1, 1));
    }
    assert_eq!(semantics[0], semantics[1]);
}

#[sqlx::test]
async fn racing_mcp_and_legacy_ws_decisions_publish_only_the_single_committed_winner(db: PgPool) {
    let fixture = Fixture::seed(&db).await;
    let events = Arc::new(Events::default());
    let start = Arc::new(tokio::sync::Barrier::new(3));
    let handles = [Adapter::Mcp, Adapter::LegacyWs].map(|adapter| {
        let (fixture, db, events, start) =
            (fixture.clone(), db.clone(), events.clone(), start.clone());
        tokio::spawn(async move {
            start.wait().await;
            fixture
                .submit(&db, &events, adapter, "claim", Some(0.9))
                .await
        })
    });
    start.wait().await;
    let [a, b] = handles;
    let results = [a.await.unwrap(), b.await.unwrap()];
    let winners: Vec<&Value> = results
        .iter()
        .filter_map(|result| result.as_ref().ok())
        .filter(|data| data["status"] == "pending")
        .collect();
    assert_eq!(
        winners.len(),
        1,
        "one adapter wins the evaluation capability: {results:?}"
    );
    fixture.assert_created(&db, winners[0]).await;
    assert!(results.iter().any(|result| match result {
        Ok(data) => data["duplicate"] == true,
        Err(error) => error.contains("CONFLICT"),
    }));
    assert_eq!(
        events.counts(),
        (1, 1, 1),
        "a losing adapter cannot publish a second confirmation or claim event"
    );
}

async fn creation_fault(db: &PgPool, boundary: &str, first: Adapter) {
    let fixture = Fixture::seed(db).await;
    let events = Events::default();
    let before = fixture.evaluation(db).await;
    sqlx::raw_sql("CREATE FUNCTION reject_claim_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected claim creation failure'; END $$")
        .execute(db).await.unwrap();
    let ddl=match boundary {
        "confirmation"=>"CREATE TRIGGER reject_claim_creation BEFORE INSERT ON messages FOR EACH ROW WHEN (NEW.msg_type='task_claim_confirmation') EXECUTE FUNCTION reject_claim_creation()",
        "mention"=>"CREATE TRIGGER reject_claim_creation BEFORE INSERT ON message_mentions FOR EACH ROW EXECUTE FUNCTION reject_claim_creation()",
        "commit"=>"CREATE CONSTRAINT TRIGGER reject_claim_creation AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.msg_type='task_claim_confirmation') EXECUTE FUNCTION reject_claim_creation()",
        _=>unreachable!(),
    };
    sqlx::raw_sql(ddl).execute(db).await.unwrap();
    assert!(fixture
        .submit(db, &events, first, "claim", Some(0.9))
        .await
        .is_err());
    assert_eq!(
        fixture.evaluation(db).await,
        before,
        "DB failure must not consume the reservation or mark it failed"
    );
    assert_eq!(
        fixture.counts(db).await,
        (0, 0, 0, 1),
        "claim, confirmation, mention and allocated sequence must all roll back"
    );
    assert!(events.snapshot().is_empty());
    let table = if boundary == "mention" {
        "message_mentions"
    } else {
        "messages"
    };
    sqlx::raw_sql(&format!(
        "DROP TRIGGER reject_claim_creation ON {table}; DROP FUNCTION reject_claim_creation()"
    ))
    .execute(db)
    .await
    .unwrap();
    let retry = fixture
        .submit(db, &events, first.other(), "claim", Some(0.9))
        .await
        .unwrap();
    fixture.assert_created(db, &retry).await;
    assert_eq!(events.counts(), (1, 1, 1));
}
#[sqlx::test]
async fn confirmation_insert_failure_is_retryable_through_the_other_adapter(db: PgPool) {
    creation_fault(&db, "confirmation", Adapter::Mcp).await;
}
#[sqlx::test]
async fn mention_insert_failure_is_retryable_through_the_other_adapter(db: PgPool) {
    creation_fault(&db, "mention", Adapter::LegacyWs).await;
}
#[sqlx::test]
async fn deferred_commit_failure_cannot_leave_a_claim_without_its_confirmation(db: PgPool) {
    creation_fault(&db, "commit", Adapter::LegacyWs).await;
}

#[sqlx::test]
async fn both_adapters_reject_foreign_evaluations_and_nonvisible_or_nonhuman_sources(db: PgPool) {
    for adapter in [Adapter::Mcp, Adapter::LegacyWs] {
        for corruption in [
            "other_bot",
            "deleted",
            "secret",
            "partial",
            "bot_source",
            "missing_user",
            "empty",
            "bot_disabled",
            "bot_readonly",
            "bot_removed",
        ] {
            let fixture = Fixture::seed(&db).await;
            let events = Events::default();
            let before = fixture.evaluation(&db).await;
            let statement = match corruption {
                "deleted" => Some("UPDATE messages SET is_deleted=TRUE WHERE msg_id=$1"),
                "secret" => Some("UPDATE messages SET is_secret=TRUE WHERE msg_id=$1"),
                "partial" => Some("UPDATE messages SET is_partial=TRUE WHERE msg_id=$1"),
                "bot_source" | "missing_user" => None,
                "empty" => Some("UPDATE messages SET content='   ' WHERE msg_id=$1"),
                "other_bot" | "bot_disabled" | "bot_readonly" | "bot_removed" => None,
                _ => unreachable!(),
            };
            if let Some(statement) = statement {
                sqlx::query(statement)
                    .bind(fixture.source.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            if matches!(corruption, "bot_source" | "missing_user") {
                let sender = if corruption == "bot_source" {
                    fixture.bot
                } else {
                    Uuid::new_v4()
                };
                sqlx::query("UPDATE messages SET sender_type=$2,sender_id=$3 WHERE msg_id=$1")
                    .bind(fixture.source.to_string())
                    .bind(if corruption == "bot_source" {
                        "bot"
                    } else {
                        "user"
                    })
                    .bind(sender.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            match corruption {
                "bot_disabled" => {
                    sqlx::query("UPDATE bot_accounts SET is_disabled=TRUE WHERE bot_id=$1")
                        .bind(fixture.bot.to_string())
                        .execute(&db)
                        .await
                        .unwrap();
                }
                "bot_readonly" => {
                    sqlx::query("UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2 AND member_type='bot'")
                        .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
                }
                "bot_removed" => {
                    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='bot'")
                        .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
                }
                _ => {}
            }
            let actor = if corruption == "other_bot" {
                fixture.other_bot
            } else {
                fixture.bot
            };
            assert!(
                fixture
                    .submit_as(&db, &events, adapter, actor, "claim", Some(0.9))
                    .await
                    .is_err(),
                "{adapter:?}/{corruption}"
            );
            assert_eq!(
                fixture.evaluation(&db).await,
                before,
                "{adapter:?}/{corruption} must not consume or poison the owner's reservation"
            );
            assert_eq!(fixture.counts(&db).await, (0, 0, 0, 1));
            assert!(events.snapshot().is_empty());
            sqlx::query("UPDATE messages SET sender_type='user',sender_id=$3,is_deleted=FALSE,is_secret=FALSE,is_partial=FALSE,content=$2 WHERE msg_id=$1")
                .bind(fixture.source.to_string()).bind(Fixture::SOURCE).bind(fixture.user.to_string()).execute(&db).await.unwrap();
            if corruption == "bot_disabled" {
                sqlx::query("UPDATE bot_accounts SET is_disabled=FALSE WHERE bot_id=$1")
                    .bind(fixture.bot.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            if matches!(corruption, "bot_readonly" | "bot_removed") {
                sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member') ON CONFLICT(channel_id,member_id) DO UPDATE SET role='member'")
                    .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            let retry = fixture
                .submit(&db, &events, adapter.other(), "claim", Some(0.9))
                .await
                .unwrap();
            fixture.assert_created(&db, &retry).await;
        }
    }
    let fixture = Fixture::seed(&db).await;
    let bad_channel=resource::task_claims::handle_evaluate(&db,&Principal::bot(fixture.bot),
        &json!({"channel_id":Uuid::new_v4(),"evaluation_id":fixture.evaluation,"decision":"claim","confidence":0.9})).await;
    assert!(bad_channel.is_err());
    assert_eq!(fixture.evaluation(&db).await["status"], "dispatched");
    let human=resource::task_claims::handle_evaluate(&db,&Principal::user(fixture.user),
        &json!({"channel_id":fixture.channel,"evaluation_id":fixture.evaluation,"decision":"claim","confidence":0.9})).await;
    assert!(human.is_err());
    assert_eq!(fixture.counts(&db).await, (0, 0, 0, 1));
}

#[sqlx::test]
async fn ignore_threshold_clamping_and_legacy_protocol_failures_have_explicit_single_decisions(
    db: PgPool,
) {
    for adapter in [Adapter::Mcp, Adapter::LegacyWs] {
        for (decision, confidence, expected) in [
            ("ignore", Some(1.0), "ignored"),
            ("claim", Some(0.5), "ignored"),
            ("claim", None, "ignored"),
            ("claim", Some(-2.0), "ignored"),
            ("claim", Some(2.0), "pending"),
        ] {
            let fixture = Fixture::seed(&db).await;
            let events = Events::default();
            if decision == "ignore" {
                sqlx::query("UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2 AND member_type='bot'")
                .bind(fixture.channel.to_string()).bind(fixture.bot.to_string()).execute(&db).await.unwrap();
            }
            let data = fixture
                .submit(&db, &events, adapter, decision, confidence)
                .await
                .unwrap();
            assert_eq!(
                data["status"], expected,
                "{adapter:?}/{decision}/{confidence:?}"
            );
            if expected == "pending" {
                fixture.assert_created(&db, &data).await;
                assert_eq!(fixture.claim(&db).await["confidence"], 1.0);
                assert_eq!(events.counts(), (1, 1, 1));
            } else {
                assert_eq!(fixture.evaluation(&db).await["status"], "ignored");
                assert_eq!(fixture.counts(&db).await, (0, 0, 0, 1));
                assert_eq!(events.counts(), (0, 0, 1));
            }
        }
    }
    for (content, error) in [
        (None, Some("the ACP evaluation failed")),
        (Some("{broken"), None),
        (None, None),
    ] {
        let fixture = Fixture::seed(&db).await;
        let events = Events::default();
        let failed = task_claim_scheduler::complete(
            &db,
            &events,
            fixture.bot,
            fixture.evaluation,
            content,
            error,
        )
        .await
        .unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(fixture.evaluation(&db).await["status"], "failed");
        assert_eq!(fixture.counts(&db).await, (0, 0, 0, 1));
        assert_eq!(events.counts(), (0, 0, 1));
    }
}

#[sqlx::test]
async fn late_legacy_empty_and_error_results_cannot_downgrade_or_republish_an_mcp_claim(
    db: PgPool,
) {
    let fixture = Fixture::seed(&db).await;
    let events = Events::default();
    let created = fixture
        .submit(&db, &events, Adapter::Mcp, "claim", Some(0.9))
        .await
        .unwrap();
    fixture.assert_created(&db, &created).await;
    let before = fixture.evaluation(&db).await;
    let claim_before = fixture.claim(&db).await;
    let published = events.snapshot();
    for (content, error) in [
        (None, None),
        (None, Some("late closed ACP stream")),
        (Some("{broken"), None),
    ] {
        let duplicate = task_claim_scheduler::complete(
            &db,
            &events,
            fixture.bot,
            fixture.evaluation,
            content,
            error,
        )
        .await
        .unwrap();
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(fixture.evaluation(&db).await, before);
        assert_eq!(fixture.claim(&db).await, claim_before);
        assert_eq!(fixture.counts(&db).await, (1, 1, 1, 2));
        assert_eq!(events.snapshot(), published);
    }
    let duplicate = fixture
        .submit(&db, &events, Adapter::Mcp, "claim", Some(0.9))
        .await
        .unwrap_err();
    assert!(duplicate.contains("CONFLICT"));
    assert_eq!(events.snapshot(), published);
}
