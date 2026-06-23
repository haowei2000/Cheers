//! Server-level workbench plugin store API.
//! list (auth) · bundle (auth) · install/update (admin) · delete (admin).

use axum::{
    extract::{Path, State},
    response::Html,
    Extension, Json,
};
use serde_json::{json, Value};

use crate::{api::middleware::Claims, app_state::AppState, domain, errors::AppError};

fn require_admin(claims: &Claims) -> Result<(), AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "installing a workbench plugin requires admin".into(),
        ))
    }
}

/// GET /api/v1/workbench/plugins — installed plugins (metadata; bundle fetched separately).
pub async fn list_plugins(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    Ok(Json(domain::workbench_plugins::list(&state.db).await?))
}

/// GET /api/v1/workbench/plugins/:id/bundle — the sandboxed HTML/JS (for iframe srcdoc).
pub async fn get_bundle(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
    Path(plugin_id): Path<String>,
) -> Result<Html<String>, AppError> {
    let bundle = domain::workbench_plugins::get_bundle(&state.db, &plugin_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Html(bundle))
}

/// PUT /api/v1/workbench/plugins/:id — install/update (admin). Body: { title, manifest, bundle }.
pub async fn install_plugin(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(plugin_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    require_admin(&claims)?;
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(&plugin_id)
        .to_string();
    let manifest = body
        .get("manifest")
        .map(|m| m.to_string())
        .unwrap_or_else(|| "{}".to_string());
    let bundle = body
        .get("bundle")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if bundle.trim().is_empty() {
        return Err(AppError::BadRequest("plugin bundle is required".into()));
    }
    domain::workbench_plugins::install(&state.db, &plugin_id, &title, &manifest, &bundle, &claims.sub)
        .await?;
    Ok(Json(json!({ "plugin_id": plugin_id, "ok": true })))
}

/// DELETE /api/v1/workbench/plugins/:id — uninstall (admin).
pub async fn delete_plugin(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(plugin_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    require_admin(&claims)?;
    let n = domain::workbench_plugins::delete(&state.db, &plugin_id).await?;
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "deleted": n })))
}
