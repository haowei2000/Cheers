//! Unified global Workbench extension API. Global packages are declarative only.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap},
    Extension, Json,
};
use serde_json::{json, Value};

use crate::{api::middleware::Claims, app_state::AppState, domain, errors::AppError};

fn require_admin(claims: &Claims) -> Result<(), AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "installing a global Workbench extension requires admin".into(),
        ))
    }
}

/// GET /api/v1/workbench/extensions
pub async fn list_extensions(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    Ok(Json(domain::workbench_extensions::list(&state.db).await?))
}

/// GET /api/v1/workbench/extensions/:id/scenes/:scene_id
pub async fn get_scene(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
    Path((id, scene_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let scene = domain::workbench_extensions::get_scene(&state.db, &id, &scene_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(scene))
}

/// PUT /api/v1/workbench/extensions/:id
pub async fn put_extension(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    require_admin(&claims)?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    if content_type != Some(domain::workbench_extensions::MEDIA_TYPE) {
        return Err(AppError::BadRequest(format!(
            "Content-Type must be {}",
            domain::workbench_extensions::MEDIA_TYPE
        )));
    }
    if body.len() > domain::workbench_extensions::MAX_COMPRESSED_BYTES {
        return Err(AppError::PayloadTooLarge(
            "extension exceeds the 4 MiB compressed limit".into(),
        ));
    }
    if domain::workbench_extensions::is_official_id(&state.db, &id).await? {
        return Err(AppError::BadRequest(
            "official extension is managed by gateway releases; use another id".into(),
        ));
    }
    let package = domain::workbench_extensions::validate_package(&body, false)
        .map_err(AppError::BadRequest)?;
    if package.manifest.id != id {
        return Err(AppError::BadRequest("URL id must match manifest id".into()));
    }
    domain::workbench_extensions::install(&state.db, &package, &claims.sub, "admin").await?;
    Ok(Json(json!({
        "id": id,
        "version": package.manifest.version,
        "sha256": package.sha256,
        "ok": true
    })))
}

/// DELETE /api/v1/workbench/extensions/:id
pub async fn delete_extension(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    require_admin(&claims)?;
    let deleted = domain::workbench_extensions::delete(&state.db, &id).await?;
    if deleted == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({"deleted": deleted})))
}
