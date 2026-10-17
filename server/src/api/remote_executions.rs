//! Durable user-owned execution receipts over the existing workspace RPC.
use crate::{
    api::middleware::Claims,
    app_state::AppState,
    errors::AppError,
    resource::{authorize_channel_read, Principal},
};
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StartExecution {
    pub bot_id: Uuid,
    pub host_id: Uuid,
    pub invocation_id: Uuid,
    pub action: String,
    #[serde(default)]
    pub path: String,
    pub root: Option<String>,
    pub command: Option<String>,
    pub opener: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub source_event: Option<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlExecution {
    pub action: String,
    pub input: Option<String>,
    pub offset: Option<u64>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}
async fn authorize(
    state: &AppState,
    claims: &Claims,
    channel: Uuid,
    bot: Uuid,
    host: Uuid,
    recent: bool,
) -> Result<(), AppError> {
    let user = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid user".into()))?;
    authorize_channel_read(&state.db, &Principal::user(user), channel)
        .await
        .map_err(|(_, message)| AppError::Forbidden(message))?;
    if recent {
        crate::api::bots::ensure_recent_bot_owner_or_admin(state, claims, &bot.to_string()).await?;
    } else {
        crate::api::bots::ensure_bot_owner_or_admin(state, claims, &bot.to_string()).await?;
    }
    let active=sqlx::query!("SELECT host_id FROM connector_hosts WHERE bot_id=$1 AND status='active' AND revoked_at IS NULL",bot.to_string()).fetch_optional(&state.db).await?.ok_or_else(||AppError::Conflict("This bot has no active host".into()))?;
    if active.host_id != host.to_string() {
        return Err(AppError::Conflict(
            "The active device changed. Select it again before executing.".into(),
        ));
    }
    Ok(())
}
async fn validate_source(
    state: &AppState,
    claims: &Claims,
    channel: Uuid,
    body: &StartExecution,
) -> Result<(), AppError> {
    let Some(event) = &body.source_event else {
        return Ok(());
    };
    cheers_interactive_core::validate_interaction(event)
        .map_err(|e| AppError::BadRequest(e.into()))?;
    if event["invocationId"] != body.invocation_id.to_string() {
        return Err(AppError::BadRequest("Invocation identity mismatch".into()));
    }
    let source = crate::api::resources::desk_resource(
        &state.db,
        &Principal::user(
            claims
                .sub
                .parse()
                .map_err(|_| AppError::Unauthorized("Invalid user".into()))?,
        ),
        event["sourceUri"].as_str().unwrap_or(""),
        Some(channel),
    )
    .await?;
    if source.deleted
        || source.channel_id != channel.to_string()
        || source.version != source.latest_version
        || event["sourceVersion"] != source.version
    {
        return Err(AppError::Conflict(
            "The action source changed. Reload before executing.".into(),
        ));
    }
    let parsed = if source.path.ends_with(".yaml") || source.path.ends_with(".yml") {
        serde_yaml::from_str::<Value>(&source.content).ok()
    } else {
        serde_json::from_str::<Value>(&source.content).ok()
    };
    let declarations = cheers_interactive_core::extract_action_declarations(
        &source.path,
        &source.content,
        parsed.as_ref(),
    )
    .map_err(|e| AppError::BadRequest(e.into()))?;
    let declared = declarations
        .iter()
        .find(|a| {
            a.action_id == event["actionId"].as_str().unwrap_or("")
                && a.surface_id.as_deref() == event["surfaceId"].as_str()
                && a.component_id.as_deref() == event["componentId"].as_str()
        })
        .ok_or_else(|| AppError::BadRequest("Source action not found".into()))?;
    if declared.name != "cheers.execute"
        || declared.bot_id.as_deref() != Some(body.bot_id.to_string().as_str())
        || event["botId"] != body.bot_id.to_string()
    {
        return Err(AppError::BadRequest(
            "The execution does not match its declared action".into(),
        ));
    }
    let input = event["input"]
        .as_object()
        .ok_or_else(|| AppError::BadRequest("Invalid execution input".into()))?;
    cheers_interactive_core::validate_action_input(&declared.payload, input)
        .map_err(|e| AppError::BadRequest(e.into()))?;
    for (key, value) in input {
        let expected = match key.as_str() {
            "action" => json!(body.action),
            "path" => json!(body.path),
            "root" => json!(body.root),
            "command" => json!(body.command),
            "opener" => json!(body.opener),
            _ => return Err(AppError::BadRequest("Unsupported execution input".into())),
        };
        if value != &expected {
            return Err(AppError::BadRequest(
                "Execution payload changed after approval".into(),
            ));
        }
    }
    for (key, present) in [
        ("command", body.command.is_some()),
        ("root", body.root.is_some()),
        ("opener", body.opener.is_some()),
        ("path", !body.path.is_empty()),
    ] {
        if present && !input.contains_key(key) {
            return Err(AppError::BadRequest("Undeclared execution field".into()));
        }
    }
    if input.get("action") != Some(&json!(body.action)) {
        return Err(AppError::BadRequest(
            "The operation must be declared".into(),
        ));
    }
    Ok(())
}
fn receipt(id: &str, status: &str, result: Option<Value>) -> Value {
    json!({"execution_id":id,"status":status,"result":result})
}
fn status(value: &Value) -> &str {
    match value["status"].as_str() {
        Some(s @ ("running" | "succeeded" | "failed" | "cancelled")) => s,
        _ => "unknown",
    }
}

pub async fn start(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel): Path<Uuid>,
    Json(body): Json<StartExecution>,
) -> Result<Json<Value>, AppError> {
    if !["terminal.start", "file.open"].contains(&body.action.as_str())
        || body
            .command
            .as_ref()
            .is_some_and(|c| c.len() > 16_000 || c.contains('\0'))
    {
        return Err(AppError::BadRequest("Invalid remote action".into()));
    }
    authorize(&state, &claims, channel, body.bot_id, body.host_id, true).await?;
    let request = serde_json::to_value(&body).map_err(|e| AppError::BadRequest(e.to_string()))?;
    let prior=sqlx::query!("SELECT execution_id,request,status,result FROM resource_executions WHERE user_id=$1 AND invocation_id=$2",claims.sub,body.invocation_id.to_string()).fetch_optional(&state.db).await?;
    if let Some(prior) = prior {
        if prior.request != request {
            return Err(AppError::Conflict(
                "Invocation id was reused with different input".into(),
            ));
        }
        return Ok(Json(receipt(
            &prior.execution_id,
            &prior.status,
            prior.result,
        )));
    }
    validate_source(&state, &claims, channel, &body).await?;
    let id = Uuid::new_v4().to_string();
    let inserted=sqlx::query!("INSERT INTO resource_executions(execution_id,user_id,channel_id,bot_id,host_id,invocation_id,request) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,invocation_id) DO NOTHING RETURNING execution_id",id,claims.sub,channel.to_string(),body.bot_id.to_string(),body.host_id.to_string(),body.invocation_id.to_string(),request).fetch_optional(&state.db).await?;
    let Some(inserted) = inserted else {
        return Err(AppError::Conflict(
            "The same request is being accepted. Retry with the same invocation id.".into(),
        ));
    };
    let id = inserted.execution_id;
    let worker_state = state.clone();
    let worker_id = id.clone();
    let user = claims.sub.clone();
    tokio::spawn(async move {
        let mut action = body.action.clone();
        loop {
            let pending = sqlx::query!(
                "SELECT status,cancel_requested FROM resource_executions WHERE execution_id=$1",
                worker_id
            )
            .fetch_optional(&worker_state.db)
            .await;
            let Ok(Some(pending)) = pending else {
                break;
            };
            if !["accepted", "running"].contains(&pending.status.as_str()) {
                break;
            }
            if pending.cancel_requested && action == "terminal.start" {
                let _=sqlx::query!("UPDATE resource_executions SET status='cancelled',updated_at=NOW() WHERE execution_id=$1 AND status='accepted'",worker_id).execute(&worker_state.db).await;
                break;
            }
            if pending.cancel_requested {
                action = "terminal.cancel".into();
            }
            // Re-check both the owner and the originally approved device; never reroute.
            let permission = authorize(
                &worker_state,
                &claims,
                channel,
                body.bot_id,
                body.host_id,
                false,
            )
            .await;
            let response = match permission {
                Err(error) => Err(error),
                Ok(()) => crate::api::workspace::workspace_call(
                    &worker_state,body.bot_id,"remote_execute",&body.path,body.root.as_deref(),
                    json!({"remote_execution":cheers_bridge_protocol::RemoteExecutionRequest {
                        execution_id:worker_id.clone(),host_id:body.host_id.to_string(),user_id:user.clone(),
                        action:action.clone(),command:if action=="terminal.start" {body.command.clone()}else{None},
                        opener:body.opener.clone(),input:None,offset:0,cols:body.cols,rows:body.rows,
                    }}),None,&[],
                ).await,
            };
            let (next, result) = match response {
                Ok(value) => (status(&value).to_owned(), value),
                Err(error) => {
                    let message = error.to_string();
                    // An explicit host refusal is definitive. A timeout is not.
                    let next = if action == "terminal.start" || action == "file.open" {
                        if message.contains("connector is offline")
                            || [
                                "disabled on this host",
                                "outside the registered root",
                                "Unsupported opener",
                                "Too many remote terminals",
                                "Invalid command",
                            ]
                            .iter()
                            .any(|reason| message.contains(reason))
                        {
                            "failed"
                        } else {
                            "unknown"
                        }
                    } else {
                        "unknown"
                    };
                    (
                        next.to_owned(),
                        json!({"error":message,"message":"This operation will not be replayed automatically."}),
                    )
                }
            };
            let _=sqlx::query!("UPDATE resource_executions SET status=$2,result=$3,updated_at=NOW() WHERE execution_id=$1 AND status IN ('accepted','running')",worker_id,next,result).execute(&worker_state.db).await;
            if next != "running" {
                break;
            }
            action = "terminal.status".into();
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
    Ok(Json(receipt(&id, "accepted", None)))
}
pub async fn control(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
    Json(body): Json<ControlExecution>,
) -> Result<Json<Value>, AppError> {
    if ![
        "terminal.status",
        "terminal.input",
        "terminal.resize",
        "terminal.cancel",
    ]
    .contains(&body.action.as_str())
        || body.input.as_ref().is_some_and(|v| v.len() > 8192)
    {
        return Err(AppError::BadRequest("Invalid terminal operation".into()));
    }
    let row=sqlx::query!("SELECT user_id,channel_id,bot_id,host_id,request,status,result,updated_at FROM resource_executions WHERE execution_id=$1",id.to_string()).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    if row.user_id != claims.sub {
        return Err(AppError::Forbidden(
            "This execution belongs to another user".into(),
        ));
    }
    let request: StartExecution =
        serde_json::from_value(row.request).map_err(|e| AppError::Internal(e.to_string()))?;
    if body.action == "terminal.status" {
        authorize_channel_read(
            &state.db,
            &Principal::user(
                claims
                    .sub
                    .parse()
                    .map_err(|_| AppError::Unauthorized("Invalid user".into()))?,
            ),
            row.channel_id.parse().map_err(|_| AppError::NotFound)?,
        )
        .await
        .map_err(|(_, m)| AppError::Forbidden(m))?;
        crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &request.bot_id.to_string())
            .await?;
    } else {
        authorize(
            &state,
            &claims,
            row.channel_id.parse().map_err(|_| AppError::NotFound)?,
            request.bot_id,
            request.host_id,
            body.action != "terminal.status",
        )
        .await?;
    }
    if body.action == "terminal.cancel" {
        sqlx::query!("UPDATE resource_executions SET cancel_requested=TRUE WHERE execution_id=$1 AND status IN ('accepted','running')",id.to_string()).execute(&state.db).await?;
    }
    if row.status == "accepted" || (row.status == "running" && body.action == "terminal.status") {
        // A crashed gateway cannot promise that an operation never started.
        if chrono::Utc::now()
            .signed_duration_since(row.updated_at)
            .num_seconds()
            > 60
        {
            sqlx::query!("UPDATE resource_executions SET status='unknown',updated_at=NOW() WHERE execution_id=$1 AND status IN ('accepted','running') AND updated_at < NOW()-INTERVAL '60 seconds'",id.to_string()).execute(&state.db).await?;
            return Ok(Json(receipt(
                &id.to_string(),
                "unknown",
                row.result
                    .map(|v| slice_output(v, body.offset.unwrap_or(0))),
            )));
        }
        return Ok(Json(receipt(
            &id.to_string(),
            &row.status,
            row.result
                .map(|v| slice_output(v, body.offset.unwrap_or(0))),
        )));
    }
    if request.action != "terminal.start" || !["running"].contains(&row.status.as_str()) {
        return Ok(Json(receipt(
            &id.to_string(),
            &row.status,
            row.result
                .map(|v| slice_output(v, body.offset.unwrap_or(0))),
        )));
    }
    let remote = cheers_bridge_protocol::RemoteExecutionRequest {
        execution_id: id.to_string(),
        host_id: request.host_id.to_string(),
        user_id: claims.sub,
        action: body.action,
        command: None,
        opener: None,
        input: body.input,
        offset: 0,
        cols: body.cols,
        rows: body.rows,
    };
    match crate::api::workspace::workspace_call(
        &state,
        request.bot_id,
        "remote_execute",
        &request.path,
        request.root.as_deref(),
        json!({"remote_execution":remote}),
        None,
        &[],
    )
    .await
    {
        Ok(value) => {
            let status = status(&value).to_owned();
            if status != "running" {
                sqlx::query!("UPDATE resource_executions SET status=$2,result=$3,updated_at=NOW() WHERE execution_id=$1 AND status IN ('accepted','running')",id.to_string(),status,value).execute(&state.db).await?;
            }
            Ok(Json(receipt(
                &id.to_string(),
                &status,
                Some(slice_output(value, body.offset.unwrap_or(0))),
            )))
        }
        Err(error) => {
            let value = json!({"error":error.to_string()});
            sqlx::query!("UPDATE resource_executions SET status='unknown',result=$2,updated_at=NOW() WHERE execution_id=$1",id.to_string(),value).execute(&state.db).await?;
            Ok(Json(receipt(
                &id.to_string(),
                "unknown",
                Some(slice_output(value, body.offset.unwrap_or(0))),
            )))
        }
    }
}

/// Store a complete bounded host snapshot; send each viewer only its unread bytes.
fn slice_output(mut value: Value, requested: u64) -> Value {
    use base64::Engine;
    if let Some(encoded) = value["output_b64"].as_str() {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) {
            let base = value["offset"].as_u64().unwrap_or(0);
            let offset = requested.max(base).min(base + bytes.len() as u64);
            value["output_b64"] = json!(base64::engine::general_purpose::STANDARD
                .encode(&bytes[(offset - base) as usize..]));
            value["offset"] = json!(offset);
            value["truncated"] = json!(requested < base);
        }
    }
    value
}
#[derive(Deserialize)]
pub struct HistoryQuery {
    pub channel_id: Uuid,
    pub bot_id: Uuid,
}
pub async fn history(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, AppError> {
    authorize_channel_read(
        &state.db,
        &Principal::user(
            claims
                .sub
                .parse()
                .map_err(|_| AppError::Unauthorized("Invalid user".into()))?,
        ),
        query.channel_id,
    )
    .await
    .map_err(|(_, m)| AppError::Forbidden(m))?;
    let rows=sqlx::query!("SELECT execution_id,status,request,created_at FROM resource_executions WHERE user_id=$1 AND channel_id=$2 AND bot_id=$3 ORDER BY created_at DESC LIMIT 30",claims.sub,query.channel_id.to_string(),query.bot_id.to_string()).fetch_all(&state.db).await?;
    Ok(Json(
        json!({"executions":rows.into_iter().map(|r|json!({"execution_id":r.execution_id,"status":r.status,"command":r.request["command"],"created_at":r.created_at})).collect::<Vec<_>>()}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_cursor_handles_reattach_and_truncation() {
        let v = json!({"offset":10,"next_offset":16,"output_b64":"YWJjZGVm"});
        assert_eq!(slice_output(v.clone(), 13)["output_b64"], "ZGVm");
        assert_eq!(slice_output(v.clone(), 99)["output_b64"], "");
        assert_eq!(slice_output(v, 0)["truncated"], true);
    }
}
