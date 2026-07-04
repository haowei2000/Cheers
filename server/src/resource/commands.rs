//! `channel.commands.read` — ⑦ command palette read side. Returns each bot's
//! latest advertised command set in the channel (from `bot_available_commands`).
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{authorize_channel_read, Principal, ResourceResult};

/// `resource_req { resource: "channel.commands.read", params: { channel_id } }`
///
/// One row per bot (the table is keyed by `(channel_id, bot_id)`), so the result
/// has one `{ bot_id, commands }` entry per bot. Each command is projected down
/// to `{ name, description }` — the `input` hint stays server-side; the palette
/// only needs the name to insert and the description to show.
pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;
    authorize_channel_read(db, principal, channel_id).await?;

    // Per-channel rows (recorded from mid-turn `available_commands_update`
    // events) win; the bot-level connector snapshot — the INITIAL advertisement
    // reported at `session/new` — is the fallback for channel bots that never
    // re-advertised inside this channel. Without the fallback the palette stays
    // empty until an agent happens to update its commands mid-turn.
    let rows = sqlx::query(
        "SELECT cm.member_id AS bot_id,
                COALESCE(
                    bac.commands,
                    ba.binding_config #> '{connector_control,options,options,availableCommands}'
                ) AS commands
         FROM channel_memberships cm
         JOIN bot_accounts ba ON ba.bot_id = cm.member_id
         LEFT JOIN bot_available_commands bac
                ON bac.channel_id = cm.channel_id AND bac.bot_id = cm.member_id
         WHERE cm.channel_id = $1 AND cm.member_type = 'bot'
         ORDER BY cm.member_id ASC",
    )
    .bind(channel_id.to_string())
    .fetch_all(db)
    .await
    .map_err(super::db_err(
        "commands.read: select bot_available_commands",
    ))?;

    let bots: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let bot_id = row.try_get::<String, _>("bot_id").unwrap_or_default();
            // `commands` is a JSONB array of AvailableCommand; project each to the
            // read shape, skipping any entry missing a name.
            let commands: Vec<Value> = row
                .try_get::<Option<Value>, _>("commands")
                .ok()
                .flatten()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|c| {
                    let name = c.get("name").and_then(Value::as_str)?;
                    Some(json!({
                        "name": name,
                        "description": c.get("description").and_then(Value::as_str),
                    }))
                })
                .collect();
            json!({ "bot_id": bot_id, "commands": commands })
        })
        .collect();

    Ok(json!({ "channel_id": channel_id, "bots": bots }))
}
