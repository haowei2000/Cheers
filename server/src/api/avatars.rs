//! Avatar image upload + serving.
//!
//! Upload is JWT-gated (you set your own avatar; a bot's is owner/admin-only) and
//! writes the serving URL straight into the existing `avatar_url` column. Serving
//! is a PUBLIC route because an `<img src>` can't attach a Bearer token and an
//! avatar isn't sensitive. The content type is carried in the key's extension
//! (`avatars/{kind}/{id}/{uuid}.png`) so serving needs no extra column, and the
//! per-upload uuid cache-busts the URL on re-upload.
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header::CONTENT_TYPE, HeaderMap},
    response::Response,
    Extension, Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    api::{bots::ensure_bot_owner_or_admin, middleware::Claims},
    app_state::AppState,
    errors::AppError,
    infra::{http::file_response, s3},
};

/// Avatars are small; cap well under the global 16 MiB body limit.
const MAX_AVATAR_BYTES: usize = 5 * 1024 * 1024;
/// One day; the URL is uuid-versioned, so re-uploads bust the cache anyway.
const AVATAR_CACHE_SECONDS: i64 = 86_400;

/// image/* content type → stored extension (raster only). SVG is intentionally
/// unsupported — `file_response` forces it to download, so it'd never render.
fn ext_for_image(content_type: &str) -> Option<&'static str> {
    match content_type.split(';').next().unwrap_or("").trim() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn content_type_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn content_type_header(headers: &HeaderMap) -> &str {
    headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

/// Store image bytes and return the public serving URL. `kind` is "user"|"bot".
async fn store_avatar(
    state: &AppState,
    kind: &str,
    owner_id: &str,
    content_type: &str,
    bytes: Bytes,
) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty avatar upload".into()));
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err(AppError::PayloadTooLarge(
            "avatar must be 5 MiB or smaller".into(),
        ));
    }
    let ext = ext_for_image(content_type).ok_or_else(|| {
        AppError::BadRequest("avatar must be a PNG, JPEG, WebP, or GIF image".into())
    })?;
    let file = format!("{}.{}", Uuid::new_v4(), ext);
    let key = format!("avatars/{kind}/{owner_id}/{file}");
    s3::put_object(
        &state.s3,
        &state.config.s3_bucket,
        &key,
        content_type,
        bytes.to_vec(),
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    // Matches the public serve routes below.
    Ok(format!("/api/v1/{kind}s/{owner_id}/avatar/{file}"))
}

/// `POST /api/v1/users/me/avatar` — self-service; body is the raw image bytes.
pub async fn upload_user_avatar(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    let ct = content_type_header(&headers).to_string();
    let url = store_avatar(&state, "user", &claims.sub, &ct, body).await?;
    sqlx::query("UPDATE users SET avatar_url = $1 WHERE user_id = $2 AND is_deleted = FALSE")
        .bind(&url)
        .bind(&claims.sub)
        .execute(&state.db)
        .await?;
    // New avatar → refresh the member's card live in every channel they're in.
    crate::api::users::broadcast_member_update(&state, &claims.sub).await;
    Ok(Json(json!({ "avatar_url": url })))
}

/// `POST /api/v1/bots/:bot_id/avatar` — owner/admin only.
pub async fn upload_bot_avatar(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let ct = content_type_header(&headers).to_string();
    let url = store_avatar(&state, "bot", &bot_id, &ct, body).await?;
    sqlx::query("UPDATE bot_accounts SET avatar_url = $1 WHERE bot_id = $2")
        .bind(&url)
        .bind(&bot_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "avatar_url": url })))
}

/// `GET /api/v1/users/:user_id/avatar/:file` — PUBLIC (no JWT); image bytes.
pub async fn get_user_avatar(
    State(state): State<AppState>,
    Path((user_id, file)): Path<(String, String)>,
) -> Result<Response, AppError> {
    serve_avatar(&state, "user", &user_id, &file).await
}

/// `GET /api/v1/bots/:bot_id/avatar/:file` — PUBLIC (no JWT); image bytes.
pub async fn get_bot_avatar(
    State(state): State<AppState>,
    Path((bot_id, file)): Path<(String, String)>,
) -> Result<Response, AppError> {
    serve_avatar(&state, "bot", &bot_id, &file).await
}

async fn serve_avatar(
    state: &AppState,
    kind: &str,
    owner_id: &str,
    file: &str,
) -> Result<Response, AppError> {
    // Validate the path so a crafted key can't escape the avatars/ prefix:
    // owner must be a uuid, file must be `{hex-uuid}.{known-ext}`.
    Uuid::parse_str(owner_id).map_err(|_| AppError::NotFound)?;
    let (stem, ext) = file.rsplit_once('.').ok_or(AppError::NotFound)?;
    let content_type = content_type_for_ext(ext).ok_or(AppError::NotFound)?;
    if stem.is_empty() || !stem.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(AppError::NotFound);
    }
    let key = format!("avatars/{kind}/{owner_id}/{file}");
    let bytes = s3::get_object(&state.s3, &state.config.s3_bucket, &key)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok(file_response(
        bytes,
        file,
        Some(content_type),
        true,
        Some(AVATAR_CACHE_SECONDS),
    ))
}
