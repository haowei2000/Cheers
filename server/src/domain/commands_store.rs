//! ⑦ Command palette storage — the latest advertised command set per (channel, bot).
//! Source events parse through [`crate::domain::acp_session_updates`]; this module
//! owns the `bot_available_commands` table (migration 0034). Read side lives in
//! `resource/commands.rs`.
use crate::domain::acp_session_updates::AvailableCommands;
use sqlx::PgPool;

/// Best-effort upsert of a bot's latest advertised command set in a channel.
/// Never disrupts the live turn — any write failure is logged and swallowed.
///
/// The table is keyed by `(channel_id, bot_id)`, so each advertised set replaces
/// the previous one: the palette always reflects the bot's *current* commands.
pub async fn record(
    db: &PgPool,
    channel_id: Option<&str>,
    bot_id: &str,
    session_id: Option<&str>,
    commands: &AvailableCommands,
) {
    // No channel → no row key. The palette is a per-channel surface; a session
    // update without a channel can't be placed, so we drop it silently.
    let Some(channel_id) = channel_id else {
        return;
    };

    // Persist the command list as JSONB (cast a serialized string, mirroring the
    // activity-stream payload pattern). On a serialize miss, store an empty set
    // rather than a malformed blob.
    let commands_json =
        serde_json::to_string(&commands.commands).unwrap_or_else(|_| "[]".to_string());

    if let Err(err) = sqlx::query(
        "INSERT INTO bot_available_commands
            (channel_id, bot_id, session_id, commands, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (channel_id, bot_id)
         DO UPDATE SET session_id = EXCLUDED.session_id,
                       commands   = EXCLUDED.commands,
                       updated_at = now()",
    )
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(session_id.map(|s| s.to_string()))
    .bind(commands_json)
    .execute(db)
    .await
    {
        tracing::warn!(
            %channel_id,
            %bot_id,
            error = %err,
            "commands_store::record: upsert bot_available_commands failed"
        );
    }
}
