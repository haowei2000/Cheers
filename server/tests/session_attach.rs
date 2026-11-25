//! Attach refuses an Agent session that a live Cheers session already holds.
#![cfg(feature = "integration")]

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use server::domain::sessions;

const NATIVE: &str = "01a1422e-d5e6-7e10-be3b-040fa49834a4";

async fn seed(db: &PgPool) -> (Uuid, Uuid) {
    let workspace = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let bot = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Attach')")
        .bind(workspace.to_string())
        .execute(db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO channels(channel_id,workspace_id,name,next_seq) VALUES($1,$2,'attach',1)",
    )
    .bind(channel.to_string())
    .bind(workspace.to_string())
    .execute(db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO bot_accounts(bot_id,username,external_processor,binding_config) VALUES($1,$2,FALSE,$3)")
        .bind(bot.to_string())
        .bind(format!("attach-{bot}"))
        .bind(json!({}))
        .execute(db)
        .await
        .unwrap();
    (bot, channel)
}

/// What a successful attach leaves behind: an "other" session whose ack
/// recorded the Agent's own session id.
async fn attach(db: &PgPool, bot: Uuid, channel: Uuid) -> Uuid {
    let handle = sessions::create_channel_session(
        db,
        bot,
        &bot.to_string(),
        &channel.to_string(),
        "other",
        Some("/work"),
        &[],
    )
    .await
    .unwrap();
    sessions::apply_runtime_session_ack(
        db,
        bot,
        &bot.to_string(),
        Some(handle.session_id),
        Some(&handle.provider_session_key),
        Some(NATIVE.to_string()),
        sessions::SESSION_STATUS_ACTIVE,
        None,
    )
    .await
    .unwrap();
    handle.session_id
}

#[sqlx::test]
async fn an_attached_agent_session_is_found_with_its_channel(db: PgPool) {
    let (bot, channel) = seed(&db).await;
    assert!(sessions::find_live_session_by_provider_id(&db, bot, NATIVE)
        .await
        .unwrap()
        .is_none());

    let session = attach(&db, bot, channel).await;

    assert_eq!(
        sessions::find_live_session_by_provider_id(&db, bot, NATIVE)
            .await
            .unwrap(),
        Some((session, Some(channel.to_string())))
    );
    // Another bot's Agent may reuse the id space; it is not a conflict.
    assert!(
        sessions::find_live_session_by_provider_id(&db, Uuid::new_v4(), NATIVE)
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test]
async fn a_closed_session_frees_the_agent_session_for_another_attach(db: PgPool) {
    let (bot, channel) = seed(&db).await;
    let session = attach(&db, bot, channel).await;

    sessions::close_channel_session(&db, &channel.to_string(), session)
        .await
        .unwrap();

    assert!(sessions::find_live_session_by_provider_id(&db, bot, NATIVE)
        .await
        .unwrap()
        .is_none());
}
