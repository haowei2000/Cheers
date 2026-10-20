//! Durable execution ownership against real PostgreSQL, independent of transport.
#![cfg(feature = "integration")]

use cheers_bridge_protocol::TaskAcceptanceStatus::{Granted, Owned, Rejected};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use server::gateway::task_acceptance::{self, Decision};

struct Task {
    bot: Uuid,
    channel: Uuid,
    task: Uuid,
    placeholder: Uuid,
    connection: Uuid,
}

impl Task {
    async fn seed(db: &PgPool) -> Self {
        let workspace = Uuid::new_v4();
        let task = Self {
            bot: Uuid::new_v4(),
            channel: Uuid::new_v4(),
            task: Uuid::new_v4(),
            placeholder: Uuid::new_v4(),
            connection: Uuid::new_v4(),
        };
        sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Task acceptance')")
            .bind(workspace.to_string())
            .execute(db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'acceptance')",
        )
        .bind(task.channel.to_string())
        .bind(workspace.to_string())
        .execute(db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,binding_type) VALUES($1,$2,'acp')")
            .bind(task.bot.to_string())
            .bind(format!("acceptance-{}", task.bot))
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
            .bind(task.channel.to_string()).bind(task.bot.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,is_partial) VALUES($1,$2,$3,'bot','','text',TRUE)")
            .bind(task.placeholder.to_string()).bind(task.channel.to_string()).bind(task.bot.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO bot_runs(bot_run_id,task_id,channel_id,trigger_msg_id,bot_id,placeholder_msg_id,binding_type,status) VALUES($1,$1,$2,$3,$4,$5,'acp','prepared')")
            .bind(task.task.to_string()).bind(task.channel.to_string()).bind(Uuid::new_v4().to_string())
            .bind(task.bot.to_string()).bind(task.placeholder.to_string()).execute(db).await.unwrap();
        task
    }

    async fn claim(&self, db: &PgPool, execution: Uuid) -> Decision {
        task_acceptance::claim(
            db,
            self.bot,
            self.connection,
            self.task,
            self.placeholder,
            self.channel,
            execution,
        )
        .await
        .unwrap()
    }

    async fn ledger(&self, db: &PgPool) -> Value {
        sqlx::query_scalar("SELECT to_jsonb(r) FROM bot_runs r WHERE placeholder_msg_id=$1")
            .bind(self.placeholder.to_string())
            .fetch_one(db)
            .await
            .unwrap()
    }
}

#[sqlx::test]
async fn concurrent_execution_ids_receive_exactly_one_durable_grant(db: PgPool) {
    let task = Task::seed(&db).await;
    let executions: Vec<Uuid> = (0..16).map(|_| Uuid::new_v4()).collect();
    let decisions = futures_util::future::join_all(
        executions
            .iter()
            .map(|execution| task.claim(&db, *execution)),
    )
    .await;
    assert_eq!(
        decisions
            .iter()
            .filter(|decision| decision.status == Granted)
            .count(),
        1
    );
    assert_eq!(
        decisions
            .iter()
            .filter(|decision| decision.status == Owned)
            .count(),
        15
    );
    let winner = executions[decisions
        .iter()
        .position(|decision| decision.status == Granted)
        .unwrap()];
    let ledger = task.ledger(&db).await;
    assert_eq!(ledger["execution_id"], winner.to_string());
    assert_eq!(
        ledger["execution_connection_id"],
        task.connection.to_string()
    );
    assert_eq!(ledger["status"], "accepted");
    assert!(!ledger["accepted_at"].is_null());
    assert_eq!(task.claim(&db, winner).await.status, Granted);
    assert_eq!(
        task.ledger(&db).await["accepted_at"],
        ledger["accepted_at"],
        "lost-ACK confirmation preserves the original grant"
    );
}

#[sqlx::test]
async fn a_new_control_connection_cannot_reuse_even_the_original_execution_id(db: PgPool) {
    let task = Task::seed(&db).await;
    let execution = Uuid::new_v4();
    assert_eq!(task.claim(&db, execution).await.status, Granted);
    for candidate in [execution, Uuid::new_v4()] {
        let decision = task_acceptance::claim(
            &db,
            task.bot,
            Uuid::new_v4(),
            task.task,
            task.placeholder,
            task.channel,
            candidate,
        )
        .await
        .unwrap();
        assert_eq!(decision.status, Owned);
    }
    assert_eq!(
        task.ledger(&db).await["execution_id"],
        execution.to_string()
    );
}

#[sqlx::test]
async fn every_identity_component_and_the_run_record_are_required(db: PgPool) {
    let task = Task::seed(&db).await;
    for (bot, id, message, channel) in [
        (Uuid::new_v4(), task.task, task.placeholder, task.channel),
        (task.bot, Uuid::new_v4(), task.placeholder, task.channel),
        (task.bot, task.task, Uuid::new_v4(), task.channel),
        (task.bot, task.task, task.placeholder, Uuid::new_v4()),
    ] {
        let decision = task_acceptance::claim(
            &db,
            bot,
            task.connection,
            id,
            message,
            channel,
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(decision.status, Rejected);
        assert!(task.ledger(&db).await["execution_id"].is_null());
    }
    sqlx::query("DELETE FROM bot_runs WHERE task_id=$1")
        .bind(task.task.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(task.claim(&db, Uuid::new_v4()).await.status, Rejected);
}

#[sqlx::test]
async fn terminal_deleted_and_missing_placeholders_never_authorize_execution(db: PgPool) {
    for state in ["completed", "deleted", "missing"] {
        let task = Task::seed(&db).await;
        let execution = Uuid::new_v4();
        assert_eq!(task.claim(&db, execution).await.status, Granted);
        match state {
            "completed" => {
                sqlx::query("UPDATE messages SET is_partial=FALSE,channel_seq=1,content='committed' WHERE msg_id=$1").bind(task.placeholder.to_string()).execute(&db).await.unwrap();
            }
            "deleted" => {
                sqlx::query("UPDATE messages SET is_deleted=TRUE WHERE msg_id=$1")
                    .bind(task.placeholder.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => {
                sqlx::query("DELETE FROM messages WHERE msg_id=$1")
                    .bind(task.placeholder.to_string())
                    .execute(&db)
                    .await
                    .unwrap();
            }
        }
        assert_eq!(
            task.claim(&db, execution).await.status,
            Rejected,
            "even the original owner cannot receive a late grant after {state}"
        );
        assert_eq!(task.claim(&db, Uuid::new_v4()).await.status, Rejected);
        assert_eq!(
            task.ledger(&db).await["execution_id"],
            execution.to_string(),
            "deleting a placeholder must retain its execution tombstone"
        );
    }
}

#[sqlx::test]
async fn revoked_role_disabled_bot_and_cancelled_chain_block_the_grant(db: PgPool) {
    let task = Task::seed(&db).await;
    let execution = Uuid::new_v4();
    sqlx::query(
        "UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(task.channel.to_string())
    .bind(task.bot.to_string())
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(task.claim(&db, execution).await.status, Rejected);
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
        .bind(task.channel.to_string())
        .bind(task.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(task.claim(&db, execution).await.status, Rejected);
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
        .bind(task.channel.to_string()).bind(task.bot.to_string()).execute(&db).await.unwrap();
    sqlx::query("UPDATE bot_accounts SET is_disabled=TRUE WHERE bot_id=$1")
        .bind(task.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(task.claim(&db, execution).await.status, Rejected);
    sqlx::query("UPDATE bot_accounts SET is_disabled=FALSE WHERE bot_id=$1")
        .bind(task.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    let chain =
        server::domain::task_chains::start_chain(&db, task.channel, task.task, Uuid::new_v4())
            .await
            .unwrap();
    sqlx::query("UPDATE messages SET chain_id=$2 WHERE msg_id=$1")
        .bind(task.placeholder.to_string())
        .bind(chain.to_string())
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE task_chains SET status='cancelled' WHERE chain_id=$1")
        .bind(chain.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(task.claim(&db, execution).await.status, Rejected);
    assert!(task.ledger(&db).await["execution_id"].is_null());
    sqlx::query("UPDATE task_chains SET status='active' WHERE chain_id=$1")
        .bind(chain.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(task.claim(&db, execution).await.status, Granted);
    sqlx::query("UPDATE bot_accounts SET is_disabled=TRUE WHERE bot_id=$1")
        .bind(task.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        task.claim(&db, execution).await.status,
        Rejected,
        "reconfirmation also rechecks current authority"
    );
}

#[sqlx::test]
async fn commit_failure_never_returns_a_grant_or_leaves_a_partial_claim(db: PgPool) {
    let task = Task::seed(&db).await;
    let execution = Uuid::new_v4();
    sqlx::query("CREATE FUNCTION reject_acceptance_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected acceptance commit failure'; END; $$")
        .execute(&db).await.unwrap();
    sqlx::query("CREATE CONSTRAINT TRIGGER reject_acceptance_commit AFTER UPDATE ON bot_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_acceptance_commit()")
        .execute(&db).await.unwrap();
    assert!(task_acceptance::claim(
        &db,
        task.bot,
        task.connection,
        task.task,
        task.placeholder,
        task.channel,
        execution
    )
    .await
    .is_err());
    let ledger = task.ledger(&db).await;
    assert!(ledger["execution_id"].is_null());
    assert!(ledger["execution_connection_id"].is_null());
    assert!(ledger["accepted_at"].is_null());
    assert_eq!(ledger["status"], "prepared");
    sqlx::query("DROP TRIGGER reject_acceptance_commit ON bot_runs")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(task.claim(&db, execution).await.status, Granted);
}

#[sqlx::test]
async fn explicit_bot_preflight_rejects_unnegotiated_connectors_before_commit(db: PgPool) {
    use server::{
        domain::messages::{self, CreateMessageParams},
        errors::AppError,
        gateway::{
            realtime::fanout::{Fanout, InProcessFanout},
            registry::{BotLocator, BotRegistry, InProcessBotLocator},
            stream::StreamRegistry,
        },
    };
    use std::sync::Arc;
    let task = Task::seed(&db).await;
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'test')")
        .bind(user.to_string())
        .bind(format!("preflight-{user}"))
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) SELECT workspace_id,$2,'member','active' FROM channels WHERE channel_id=$1")
        .bind(task.channel.to_string()).bind(user.to_string()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')")
        .bind(task.channel.to_string()).bind(user.to_string()).execute(&db).await.unwrap();
    let locator = InProcessBotLocator::new();
    let (tx, mut control) = tokio::sync::mpsc::channel(8);
    let (data_tx, _data) = tokio::sync::mpsc::channel(8);
    let connection = Uuid::new_v4();
    let _bound = locator.bind_control(task.bot, connection, tx);
    locator.bind_data(task.bot, Uuid::new_v4(), data_tx);
    let bot_locator: Arc<dyn BotLocator> = locator.clone();
    let fanout: Arc<dyn Fanout> = InProcessFanout::new();
    let registry = StreamRegistry::new();
    let params = |mentions| CreateMessageParams {
        user_id: user,
        channel_id: task.channel,
        content: "Please prepare the report".into(),
        msg_type: None,
        reply_to_msg_id: None,
        file_ids: vec![],
        mention_ids: mentions,
        mention_names: vec![],
        session_id: None,
        context_bundle: None,
        msg_id: None,
    };
    let before: i64 = sqlx::query_scalar("SELECT next_seq FROM channels WHERE channel_id=$1")
        .bind(task.channel.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    let rejected = messages::create_message(
        &db,
        &fanout,
        &registry,
        &bot_locator,
        params(vec![task.bot]),
    )
    .await;
    assert!(
        matches!(rejected, Err(AppError::Conflict(message)) if message.contains("reconnect or upgrade"))
    );
    let after: i64 = sqlx::query_scalar("SELECT next_seq FROM channels WHERE channel_id=$1")
        .bind(task.channel.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(after, before);
    let users: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id=$1 AND sender_type='user'",
    )
    .bind(task.channel.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(users, 0);
    assert!(control.try_recv().is_err());

    // An automatic default target remains best effort: normal human chat still
    // persists while its connector has not negotiated the execution contract.
    sqlx::query("UPDATE channels SET default_bot_id=$2 WHERE channel_id=$1")
        .bind(task.channel.to_string())
        .bind(task.bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    messages::create_message(&db, &fanout, &registry, &bot_locator, params(vec![]))
        .await
        .unwrap();
    assert!(control.try_recv().is_err());
    let sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cheers_sessions WHERE bot_id=$1 AND current_scope_id=$2",
    )
    .bind(task.bot.to_string())
    .bind(task.channel.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        sessions, 0,
        "an unready automatic target never starts or queues a session"
    );
    let intents: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM bot_runs WHERE channel_id=$1 AND dispatch_input IS NOT NULL",
    )
    .bind(task.channel.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(intents, 0);
    assert!(locator.set_task_acceptance(task.bot, connection, true));
    messages::create_message(
        &db,
        &fanout,
        &registry,
        &bot_locator,
        params(vec![task.bot]),
    )
    .await
    .unwrap();
    assert_eq!(control.try_recv().unwrap()["type"], "task");
}
