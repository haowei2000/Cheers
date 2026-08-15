//! User-owned scheduled channel message API.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::scheduled_messages::{self, ScheduledMessageInput},
    errors::AppError,
};

fn user_id(claims: &Claims) -> Result<Uuid, AppError> {
    claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))
}

pub async fn list(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let tasks = scheduled_messages::list(&state.db, user_id(&claims)?).await?;
    Ok(Json(json!({ "tasks": tasks })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(input): Json<ScheduledMessageInput>,
) -> Result<impl IntoResponse, AppError> {
    let task = scheduled_messages::create(&state, user_id(&claims)?, input).await?;
    Ok((StatusCode::CREATED, Json(task)))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
    Json(input): Json<ScheduledMessageInput>,
) -> Result<Json<scheduled_messages::ScheduledMessageDto>, AppError> {
    Ok(Json(
        scheduled_messages::update(&state, user_id(&claims)?, &id, input).await?,
    ))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !scheduled_messages::delete(&state.db, user_id(&claims)?, &id).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "deleted": true })))
}

pub async fn list_runs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let runs = scheduled_messages::list_runs(&state.db, user_id(&claims)?, &id).await?;
    Ok(Json(json!({ "runs": runs })))
}

pub async fn run_now(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let message_id = scheduled_messages::run_now(&state, user_id(&claims)?, &id).await?;
    Ok(Json(json!({ "messageId": message_id })))
}
