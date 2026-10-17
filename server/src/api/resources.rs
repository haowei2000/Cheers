//! One identity resolver and user-owned view state for every resource host.
use crate::{
    api::middleware::Claims,
    app_state::AppState,
    errors::AppError,
    resource::{authorize_channel_read, Principal},
};
use axum::{
    extract::{Query, State},
    Extension, Json,
};
use cheers_interactive_core::global_uri;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

fn resource_error((code, message): (String, String)) -> AppError {
    if code == "PERMISSION_DENIED" {
        AppError::Forbidden(message)
    } else {
        AppError::BadRequest(message)
    }
}

#[derive(Deserialize)]
pub struct ResolveBody {
    pub uri: String,
    pub channel_id: Option<Uuid>,
}
#[derive(Debug, Serialize)]
pub struct DeskResource {
    pub uri: String,
    pub resource_id: String,
    pub service_id: String,
    pub channel_id: String,
    pub path: String,
    pub content: String,
    pub version: i64,
    pub latest_version: i64,
    pub is_dir: bool,
    pub deleted: bool,
}

pub async fn service_id(db: &PgPool) -> Result<String, AppError> {
    Ok(
        sqlx::query!("SELECT service_id FROM resource_service_identity WHERE singleton=TRUE")
            .fetch_one(db)
            .await?
            .service_id,
    )
}

pub async fn desk_resource(
    db: &PgPool,
    principal: &Principal,
    uri: &str,
    channel: Option<Uuid>,
) -> Result<DeskResource, AppError> {
    let service = service_id(db).await?;
    let (id, version) = if let Some(global) = global_uri::parse(uri) {
        if global.service_id != service {
            return Err(AppError::BadRequest(
                "This resource belongs to another server. Switch servers to open it.".into(),
            ));
        }
        if global.kind != "desk" {
            return Err(AppError::BadRequest("A Desk resource is required.".into()));
        }
        (global.resource_id, global.version)
    } else {
        let Some(cheers_mcp_server::locator::Locator::Desk { path, .. }) =
            cheers_mcp_server::locator::parse(uri)
        else {
            return Err(AppError::BadRequest("Invalid resource URI".into()));
        };
        let channel = channel.ok_or_else(|| {
            AppError::BadRequest("Relative links require their original channel.".into())
        })?;
        authorize_channel_read(db, principal, channel)
            .await
            .map_err(resource_error)?;
        let row = sqlx::query!(
            "SELECT file_id FROM context_files WHERE channel_id=$1 AND path=$2",
            channel.to_string(),
            path
        )
        .fetch_optional(db)
        .await?
        .ok_or(AppError::NotFound)?;
        (row.file_id, None)
    };
    let latest=sqlx::query!("SELECT channel_id,MAX(version) AS version FROM resource_revisions WHERE resource_id=$1 GROUP BY channel_id",id)
        .fetch_optional(db).await?.ok_or(AppError::NotFound)?;
    let channel: Uuid = latest
        .channel_id
        .parse()
        .map_err(|_| AppError::Internal("Invalid resource channel".into()))?;
    authorize_channel_read(db, principal, channel)
        .await
        .map_err(resource_error)?;
    let latest_version = latest.version.ok_or(AppError::NotFound)?;
    let revision = sqlx::query!(
        "SELECT path,content,is_dir FROM resource_revisions WHERE resource_id=$1 AND version=$2",
        id,
        version.unwrap_or(latest_version)
    )
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    let current = sqlx::query!("SELECT file_id FROM context_files WHERE file_id=$1", id)
        .fetch_optional(db)
        .await?;
    let deleted = current.is_none();
    if deleted && version.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(DeskResource {
        uri: global_uri::format(&service, "desk", &id, version),
        resource_id: id,
        service_id: service,
        channel_id: channel.to_string(),
        path: revision.path,
        content: revision.content,
        is_dir: revision.is_dir,
        version: version.unwrap_or(latest_version),
        latest_version,
        deleted,
    })
}

pub async fn resolve(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<ResolveBody>,
) -> Result<Json<Value>, AppError> {
    let principal = Principal::user(
        claims
            .sub
            .parse()
            .map_err(|_| AppError::Unauthorized("Invalid user".into()))?,
    );
    Ok(Json(
        resolve_descriptor(&state.db, &principal, &body.uri, body.channel_id, None).await?,
    ))
}

#[derive(Deserialize)]
pub struct DraftQuery {
    pub uri: String,
    pub channel_id: Option<Uuid>,
    pub view_id: String,
    pub schema_version: i64,
}
#[derive(Deserialize)]
pub struct DraftWrite {
    #[serde(flatten)]
    pub key: DraftQuery,
    pub source_version: i64,
    pub if_revision: i64,
    pub data: Value,
}
fn validate_draft_key(key: &DraftQuery) -> Result<(), AppError> {
    if !(1..=1_000_000).contains(&key.schema_version)
        || key.view_id.is_empty()
        || key.view_id.len() > 256
        || !key
            .view_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(AppError::BadRequest(
            "Invalid draft view or schema version".into(),
        ));
    }
    Ok(())
}
fn validate_draft_data(data: &Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match data {
        Value::Object(v) => v.iter().all(|(k, v)| {
            !["__proto__", "prototype", "constructor"].contains(&k.as_str())
                && validate_draft_data(v, depth + 1)
        }),
        Value::Array(v) => v.iter().all(|v| validate_draft_data(v, depth + 1)),
        _ => true,
    }
}
pub async fn read_draft(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(key): Query<DraftQuery>,
) -> Result<Json<Value>, AppError> {
    validate_draft_key(&key)?;
    let principal = Principal::user(
        claims
            .sub
            .parse()
            .map_err(|_| AppError::Unauthorized("Invalid user".into()))?,
    );
    let source = desk_resource(&state.db, &principal, &key.uri, key.channel_id).await?;
    let row=sqlx::query!("SELECT revision,source_version,data FROM resource_view_drafts WHERE user_id=$1 AND resource_id=$2 AND view_id=$3 AND schema_version=$4",claims.sub,source.resource_id,key.view_id,key.schema_version).fetch_optional(&state.db).await?;
    Ok(Json(row.map_or(json!({"revision":0,"data":null,"source_version":source.version}),|r|
        json!({"revision":r.revision,"data":r.data,"source_version":r.source_version,"stale":r.source_version!=source.version}))))
}
pub async fn write_draft(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<DraftWrite>,
) -> Result<Json<Value>, AppError> {
    validate_draft_key(&body.key)?;
    if body.if_revision < 0 || !validate_draft_data(&body.data, 0) || !body.data.is_object() {
        return Err(AppError::BadRequest("Invalid draft data".into()));
    }
    if body.data.to_string().len() > 60_000 {
        return Err(AppError::PayloadTooLarge("Draft exceeds 60 KB".into()));
    }
    let principal = Principal::user(
        claims
            .sub
            .parse()
            .map_err(|_| AppError::Unauthorized("Invalid user".into()))?,
    );
    let source = desk_resource(&state.db, &principal, &body.key.uri, body.key.channel_id).await?;
    if source.deleted
        || source.version != body.source_version
        || source.version != source.latest_version
    {
        return Err(AppError::Conflict(
            "The resource changed. Review your draft before saving.".into(),
        ));
    }
    let mut transaction = state.db.begin().await?;
    let current = sqlx::query!(
        "SELECT version FROM context_files WHERE file_id=$1 FOR SHARE",
        source.resource_id
    )
    .fetch_optional(&mut *transaction)
    .await?;
    if current.is_none_or(|r| r.version != body.source_version) {
        return Err(AppError::Conflict(
            "The resource changed while saving this draft.".into(),
        ));
    }
    let revision=if body.if_revision==0 {
        sqlx::query!("INSERT INTO resource_view_drafts(user_id,resource_id,view_id,schema_version,source_version,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING revision",claims.sub,source.resource_id,body.key.view_id,body.key.schema_version,body.source_version,body.data).fetch_optional(&mut *transaction).await?.map(|r|r.revision)
    } else {
        sqlx::query!("UPDATE resource_view_drafts SET data=$6,source_version=$5,revision=revision+1,updated_at=NOW() WHERE user_id=$1 AND resource_id=$2 AND view_id=$3 AND schema_version=$4 AND revision=$7 RETURNING revision",claims.sub,source.resource_id,body.key.view_id,body.key.schema_version,body.source_version,body.data,body.if_revision).fetch_optional(&mut *transaction).await?.map(|r|r.revision)
    }.ok_or_else(||AppError::Conflict("This draft was updated on another device. Reload or keep your local copy.".into()))?;
    transaction.commit().await?;
    Ok(Json(
        json!({"revision":revision,"source_version":source.version}),
    ))
}

/// Shared descriptor resolver: REST and the agent resource dispatcher use this function.
/// A bound channel is an additional restriction, never authority to read the target.
pub async fn resolve_descriptor(
    db: &PgPool,
    principal: &Principal,
    uri: &str,
    channel: Option<Uuid>,
    bound: Option<Uuid>,
) -> Result<Value, AppError> {
    let service = service_id(db).await?;
    let parsed = global_uri::parse(uri);
    if parsed.as_ref().is_some_and(|g| g.service_id != service) {
        return Err(AppError::BadRequest(
            "This resource belongs to another server. Switch servers to open it.".into(),
        ));
    }
    if parsed.as_ref().is_some_and(|g| g.kind == "desk")
        || matches!(
            cheers_mcp_server::locator::parse(uri),
            Some(cheers_mcp_server::locator::Locator::Desk { .. })
        )
    {
        let desk = desk_resource(db, principal, uri, channel).await?;
        if bound.is_some_and(|c| c.to_string() != desk.channel_id) {
            return Err(AppError::Forbidden(
                "Resource is outside the bound channel".into(),
            ));
        }
        let mut value =
            serde_json::to_value(desk).map_err(|e| AppError::Internal(e.to_string()))?;
        value["kind"] = json!("desk");
        return Ok(value);
    }
    let global = parsed.ok_or_else(|| {
        AppError::BadRequest("Use a global URI or a channel-relative Desk URI".into())
    })?;
    let id = global.resource_id;
    let target_channel=match global.kind.as_str() {
        "inbox"=>sqlx::query!("SELECT channel_id FROM file_records WHERE file_id=$1 AND status IN ('uploaded','converted') AND (expires_at IS NULL OR expires_at>NOW())",id).fetch_optional(db).await?.and_then(|r|r.channel_id).ok_or(AppError::NotFound)?,
        "msg"=>sqlx::query!("SELECT channel_id FROM messages WHERE msg_id=$1 AND is_deleted=FALSE",id).fetch_optional(db).await?.ok_or(AppError::NotFound)?.channel_id,
        _=>id.clone(),
    };
    let target: Uuid = target_channel.parse().map_err(|_| AppError::NotFound)?;
    if bound.is_some_and(|c| c != target) {
        return Err(AppError::Forbidden(
            "Resource is outside the bound channel".into(),
        ));
    }
    authorize_channel_read(db, principal, target)
        .await
        .map_err(resource_error)?;
    Ok(
        json!({"kind":global.kind,"uri":uri,"resource_id":id,"service_id":service,"channel_id":target_channel}),
    )
}
