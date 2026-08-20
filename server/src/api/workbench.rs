//! Read-only API for Gateway-release-managed official Workbench extensions.

use axum::{extract::Path, Extension, Json};
use serde_json::Value;

use crate::{api::middleware::Claims, domain, errors::AppError};

/// GET /api/v1/workbench/extensions
pub async fn list_extensions(Extension(_claims): Extension<Claims>) -> Json<Vec<Value>> {
    Json(domain::catalog::workbench::list())
}

/// GET /api/v1/workbench/extensions/:id/scenes/:scene_id
pub async fn get_scene(
    Extension(_claims): Extension<Claims>,
    Path((id, scene_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let scene = domain::catalog::workbench::get_scene(&id, &scene_id).ok_or(AppError::NotFound)?;
    Ok(Json(scene))
}
