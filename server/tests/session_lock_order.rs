//! Session selection must not retain a binding lock while waiting on its session.
#![cfg(feature = "integration")]

use std::time::Duration;

use server::{
    domain::sessions::{self, SessionHandle},
    errors::AppError,
};
use sqlx::PgPool;
use tokio::{sync::oneshot, task::JoinHandle};
use uuid::Uuid;

async fn seed(db: &PgPool) -> (Uuid, Uuid, SessionHandle) {
    let workspace = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let bot = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Session locks')")
        .bind(workspace.to_string())
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channels(channel_id,workspace_id,name) VALUES($1,$2,'session locks')")
        .bind(channel.to_string())
        .bind(workspace.to_string())
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO bot_accounts(bot_id,username) VALUES($1,$2)")
        .bind(bot.to_string())
        .bind(format!("lock-bot-{bot}"))
        .execute(db)
        .await
        .unwrap();
    let primary = sessions::ensure_primary_session_workspace(
        db,
        bot,
        &bot.to_string(),
        &channel.to_string(),
        None,
        &[],
    )
    .await
    .unwrap();
    (bot, channel, primary)
}

fn resolve(
    db: PgPool,
    bot: Uuid,
    channel: Uuid,
    target: Option<Uuid>,
) -> (
    JoinHandle<Result<SessionHandle, AppError>>,
    oneshot::Receiver<i32>,
) {
    let (send, receive) = oneshot::channel();
    let handle = tokio::spawn(async move {
        let mut tx = db.begin().await?;
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *tx)
            .await?;
        send.send(pid).unwrap();
        let selected = if let Some(session_id) = target {
            let (selected_bot, provider_session_key) =
                sessions::resolve_channel_session_tx(&mut tx, &channel.to_string(), session_id)
                    .await?;
            assert_eq!(selected_bot, bot);
            SessionHandle {
                session_id,
                provider_session_key,
            }
        } else {
            sessions::resolve_primary_session_tx(&mut tx, bot, &channel.to_string())
                .await?
                .ok_or(AppError::NotFound)?
        };
        tx.commit().await?;
        Ok(selected)
    });
    (handle, receive)
}

async fn wait_for_lock(db: &PgPool, pid: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')",
            ).bind(pid).fetch_one(db).await.unwrap();
            if waiting { break; }
            tokio::task::yield_now().await;
        }
    }).await.expect("resolver must wait for the session lock");
}

#[sqlx::test]
async fn primary_and_targeted_resolution_wait_on_session_before_binding(db: PgPool) {
    let (bot, channel, primary) = seed(&db).await;
    for target in [None, Some(primary.session_id)] {
        let mut finalizer = db.begin().await.unwrap();
        sqlx::query("SELECT session_id FROM cheers_sessions WHERE session_id=$1 FOR UPDATE")
            .bind(primary.session_id.to_string())
            .execute(&mut *finalizer)
            .await
            .unwrap();
        let (pending, pid) = resolve(db.clone(), bot, channel, target);
        wait_for_lock(&db, pid.await.unwrap()).await;
        sqlx::query("SET LOCAL lock_timeout='1s'")
            .execute(&mut *finalizer)
            .await
            .unwrap();
        // This is the binding write done by session finalization. It must not
        // wait on the resolver that is itself waiting on our session lock.
        sqlx::query("UPDATE cheers_session_bindings SET detached_at=NOW() WHERE session_id=$1")
            .bind(primary.session_id.to_string())
            .execute(&mut *finalizer)
            .await
            .expect("a waiting resolver cannot hold the binding first");
        finalizer.commit().await.unwrap();
        let selected = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(selected.session_id, primary.session_id);
    }
}

#[sqlx::test]
async fn primary_promotion_during_a_session_wait_cannot_freeze_the_old_binding(db: PgPool) {
    let (bot, channel, primary) = seed(&db).await;
    let other = sessions::create_channel_session(
        &db,
        bot,
        &bot.to_string(),
        &channel.to_string(),
        "other",
        None,
        &[],
    )
    .await
    .unwrap();
    let mut promotion = db.begin().await.unwrap();
    sqlx::query("SELECT session_id FROM cheers_sessions WHERE session_id=$1 FOR UPDATE")
        .bind(primary.session_id.to_string())
        .execute(&mut *promotion)
        .await
        .unwrap();
    let (pending, pid) = resolve(db.clone(), bot, channel, None);
    wait_for_lock(&db, pid.await.unwrap()).await;
    sqlx::query("SET LOCAL lock_timeout='1s'")
        .execute(&mut *promotion)
        .await
        .unwrap();
    sqlx::query("UPDATE cheers_session_bindings SET role='other' WHERE session_id=$1")
        .bind(primary.session_id.to_string())
        .execute(&mut *promotion)
        .await
        .unwrap();
    sqlx::query("UPDATE cheers_session_bindings SET role='primary' WHERE session_id=$1")
        .bind(other.session_id.to_string())
        .execute(&mut *promotion)
        .await
        .unwrap();
    promotion.commit().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(result, Err(AppError::Conflict(_))),
        "stale selection: {result:?}"
    );
    let selected = sessions::resolve_primary_session(&db, bot, &channel.to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.0, other.session_id);
}
