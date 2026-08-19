//! The authenticated half of integrations: pick an external resource, bind a
//! channel to it, and keep that channel's members in step with it.
//!
//! Separate from `api::integrations`, which is the webhook receiver and sits
//! *outside* the JWT middleware because providers authenticate by signature.
//! Everything here is a logged-in user acting on their own channel, so it runs
//! inside the middleware and checks channel role like any other channel edit.
//!
//! Binding is deliberately a separate step from creating the channel. Channel
//! creation already carries a long tail of policy — workspace membership,
//! founding invitations, initial bots — and duplicating it here to make "create
//! from repo" one endpoint would fork that policy in two. The client creates a
//! channel the ordinary way and then binds it, so there stays exactly one
//! channel-creation path.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::{channels::ensure_channel_admin, middleware::Claims},
    app_state::AppState,
    domain::integrations::{
        bindings::{self, Binding, ExternalCollaborator, SyncReport},
        catalog,
        github::{api as gh, app as gh_app},
        template,
    },
    domain::messages::{create_message, CreateMessageParams},
    errors::AppError,
};

/// An installation row, already checked against the caller.
struct Installation {
    installation_id: String,
    workspace_id: String,
    /// The provider's own installation identifier.
    external_account: String,
    installed_by: String,
}

/// Load an installation the caller is entitled to use.
///
/// Entitlement is active membership of the installation's workspace — the same
/// boundary everything else in the platform uses. A disabled installation is
/// reported as absent so a paused integration behaves uniformly here and at the
/// webhook door.
async fn installation_for_user(
    state: &AppState,
    integration_id: &str,
    installation_id: &str,
    user_id: &str,
) -> Result<Installation, AppError> {
    let row = sqlx::query(
        "SELECT i.installation_id, i.workspace_id, i.external_account, i.installed_by
           FROM integration_installations i
           JOIN workspace_memberships m
             ON m.workspace_id = i.workspace_id
            AND m.user_id = $3
            AND m.status = 'active'
          WHERE i.installation_id = $1
            AND i.integration_id = $2
            AND i.disabled_at IS NULL",
    )
    .bind(installation_id)
    .bind(integration_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Installation {
        installation_id: row.try_get("installation_id")?,
        workspace_id: row.try_get("workspace_id")?,
        external_account: row.try_get("external_account")?,
        installed_by: row.try_get("installed_by")?,
    })
}

async fn token(
    state: &AppState,
    installation: &Installation,
) -> Result<crate::domain::integrations::secret::Secret, AppError> {
    gh_app::installation_token(
        &state.db,
        &state.config,
        &installation.workspace_id,
        &installation.external_account,
        &installation.installed_by,
    )
    .await
    .map_err(|error| {
        tracing::warn!(%error, installation = %installation.installation_id, "no usable GitHub installation token");
        AppError::BadRequest("GitHub is not reachable for this installation".into())
    })
}

#[derive(Debug, Serialize)]
pub struct InstallationDto {
    pub installation_id: String,
    pub integration_id: String,
    pub workspace_id: String,
    pub display_name: String,
    pub external_account: String,
}

/// `GET /integrations/:integration_id/installations`
pub async fn list_installations(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(integration_id): Path<String>,
) -> Result<Json<Vec<InstallationDto>>, AppError> {
    let descriptor = catalog::find(&integration_id).ok_or(AppError::NotFound)?;
    let rows = sqlx::query(
        "SELECT i.installation_id, i.workspace_id, i.external_account
           FROM integration_installations i
           JOIN workspace_memberships m
             ON m.workspace_id = i.workspace_id
            AND m.user_id = $2
            AND m.status = 'active'
          WHERE i.integration_id = $1 AND i.disabled_at IS NULL
          ORDER BY i.created_at",
    )
    .bind(&integration_id)
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;

    let installations = rows
        .into_iter()
        .map(|row| {
            Ok(InstallationDto {
                installation_id: row.try_get("installation_id")?,
                integration_id: integration_id.clone(),
                workspace_id: row.try_get("workspace_id")?,
                display_name: descriptor.display_name.to_string(),
                external_account: row.try_get("external_account")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::Db)?;
    Ok(Json(installations))
}

#[derive(Debug, Serialize)]
pub struct ResourceDto {
    /// What a binding stores, and what inbound events are matched against.
    pub external_id: String,
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    pub private: bool,
    pub url: String,
    /// Everything the picker does not model, kept so the client can show it and
    /// so project init can read `clone_url` without a second round trip.
    pub detail: serde_json::Value,
}

/// `GET /integrations/:integration_id/installations/:installation_id/resources`
///
/// The picker. For GitHub, the repositories the installation was granted.
pub async fn list_resources(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((integration_id, installation_id)): Path<(String, String)>,
) -> Result<Json<Vec<ResourceDto>>, AppError> {
    let descriptor = catalog::find(&integration_id).ok_or(AppError::NotFound)?;
    if integration_id != gh_app::INTEGRATION_ID {
        // Only GitHub has a resource API so far. A descriptor without one is a
        // 404 rather than an empty list: "no repositories" and "this provider
        // cannot be browsed" are different answers.
        return Err(AppError::NotFound);
    }
    let installation =
        installation_for_user(&state, &integration_id, &installation_id, &claims.sub).await?;
    let token = token(&state, &installation).await?;

    let repositories = gh::list_repositories(&state.config, &token)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "listing GitHub repositories failed");
            AppError::BadRequest("could not list repositories".into())
        })?;

    Ok(Json(
        repositories
            .into_iter()
            .map(|repo| ResourceDto {
                external_id: repo.full_name.clone(),
                kind: descriptor.resource_kind.to_string(),
                name: repo.name,
                description: repo.description,
                private: repo.private,
                url: repo.html_url,
                detail: json!({
                    "clone_url": repo.clone_url,
                    "default_branch": repo.default_branch,
                    "repository_id": repo.id,
                }),
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
pub struct BindRequest {
    pub integration_id: String,
    pub installation_id: String,
    /// `owner/repo` for GitHub.
    pub external_id: String,
}

#[derive(Debug, Serialize)]
pub struct BindingDto {
    pub channel_id: String,
    pub integration_id: String,
    pub installation_id: String,
    pub external_kind: String,
    pub external_id: String,
}

impl From<Binding> for BindingDto {
    fn from(binding: Binding) -> Self {
        Self {
            channel_id: binding.channel_id,
            integration_id: binding.integration_id,
            installation_id: binding.installation_id,
            external_kind: binding.external_kind,
            external_id: binding.external_id,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SyncReportDto {
    pub added: usize,
    pub rewritten: usize,
    pub unchanged: usize,
    pub preserved_manual: usize,
    pub unmapped: usize,
    /// Collaborators with no linked Cheers account. The number the UI turns
    /// into "3 collaborators have not connected GitHub".
    pub unlinked: usize,
    /// Collaborators who are not members of this workspace. Never auto-joined.
    pub not_in_workspace: usize,
}

impl From<SyncReport> for SyncReportDto {
    fn from(report: SyncReport) -> Self {
        Self {
            added: report.added,
            rewritten: report.rewritten,
            unchanged: report.unchanged,
            preserved_manual: report.preserved_manual,
            unmapped: report.unmapped,
            unlinked: report.unlinked,
            not_in_workspace: report.not_in_workspace,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BindResponse {
    pub binding: BindingDto,
    pub sync: SyncReportDto,
}

/// `PUT /channels/:channel_id/integration` — bind, then project members once.
pub async fn bind_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<BindRequest>,
) -> Result<Json<BindResponse>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let descriptor = catalog::find(&body.integration_id).ok_or(AppError::NotFound)?;
    let installation = installation_for_user(
        &state,
        &body.integration_id,
        &body.installation_id,
        &claims.sub,
    )
    .await?;

    // The channel and the installation must live in the same workspace, or a
    // binding would carry a repository across a tenancy boundary.
    let channel_workspace: String =
        sqlx::query_scalar("SELECT workspace_id FROM channels WHERE channel_id = $1")
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    if channel_workspace != installation.workspace_id {
        return Err(AppError::Forbidden(
            "channel and installation are in different workspaces".into(),
        ));
    }

    if body.integration_id == gh_app::INTEGRATION_ID && !gh::valid_full_name(&body.external_id) {
        return Err(AppError::BadRequest(
            "external_id must be owner/repo".into(),
        ));
    }

    // Read the roster *before* writing anything. Binding first and syncing
    // second leaves a channel bound to a repository the caller was told the
    // bind had failed for — and that binding is a live inbound route.
    let collaborators = fetch_collaborators(&state, &installation, &body.external_id).await?;

    let binding = Binding {
        channel_id: channel_id.clone(),
        integration_id: body.integration_id.clone(),
        installation_id: installation.installation_id.clone(),
        external_kind: descriptor.resource_kind.to_string(),
        external_id: body.external_id.clone(),
        created_by: claims.sub.clone(),
    };
    bindings::bind(&state.db, &binding, &json!({}), &claims.sub)
        .await
        .map_err(|error| {
            tracing::warn!(%error, %channel_id, "binding a channel failed");
            // The unique constraint is the interesting case: another channel
            // already owns this resource's inbound route.
            AppError::BadRequest("this resource is already bound to another channel".into())
        })?;

    let sync = project(
        &state,
        &channel_id,
        &installation,
        &claims.sub,
        collaborators,
    )
    .await?;
    Ok(Json(BindResponse {
        binding: binding.into(),
        sync: sync.into(),
    }))
}

/// `POST /channels/:channel_id/integration/sync`
pub async fn sync_channel_members(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<SyncReportDto>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let binding = bindings::for_channel(&state.db, &channel_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
        .ok_or(AppError::NotFound)?;
    let installation = installation_for_user(
        &state,
        &binding.integration_id,
        &binding.installation_id,
        &claims.sub,
    )
    .await?;
    let collaborators = fetch_collaborators(&state, &installation, &binding.external_id).await?;
    let report = project(
        &state,
        &channel_id,
        &installation,
        &claims.sub,
        collaborators,
    )
    .await?;
    Ok(Json(report.into()))
}

/// The current collaborator roster, in the projection's vocabulary.
async fn fetch_collaborators(
    state: &AppState,
    installation: &Installation,
    external_id: &str,
) -> Result<Vec<ExternalCollaborator>, AppError> {
    let token = token(state, installation).await?;
    let collaborators = gh::list_collaborators(&state.config, &token, external_id)
        .await
        .map_err(|error| {
            tracing::warn!(%error, %external_id, "listing collaborators failed");
            AppError::BadRequest("could not read collaborators".into())
        })?
        // 404 is not an empty roster. Reporting it as one would look like
        // "nobody has access" and is the shape that turns a transient
        // permission change into a silent no-op.
        .ok_or_else(|| {
            AppError::BadRequest("this installation can no longer read that repository".into())
        })?;

    Ok(collaborators
        .into_iter()
        .map(|collaborator| ExternalCollaborator {
            // The numeric id, not the login: a rename must not orphan a link.
            subject: collaborator.id.to_string(),
            role: collaborator.role,
        })
        .collect())
}

/// Project a roster onto the channel's memberships.
async fn project(
    state: &AppState,
    channel_id: &str,
    installation: &Installation,
    actor_id: &str,
    collaborators: Vec<ExternalCollaborator>,
) -> Result<SyncReport, AppError> {
    let descriptor = catalog::find(gh_app::INTEGRATION_ID).ok_or(AppError::NotFound)?;
    let projection = descriptor
        .projection()
        .map_err(|error| AppError::Internal(format!("invalid role projection: {error:?}")))?;

    bindings::sync_members(
        &state.db,
        channel_id,
        &installation.installation_id,
        gh_app::INTEGRATION_ID,
        &projection,
        &collaborators,
        actor_id,
    )
    .await
    .map_err(|error| {
        tracing::warn!(%error, %channel_id, "member sync failed");
        AppError::Internal("member sync failed".into())
    })
}

#[derive(Debug, Serialize)]
pub struct InitResponse {
    /// The bots asked to do the work. Empty means nothing was posted.
    pub prompted: Vec<String>,
    pub message_id: Option<String>,
}

/// `POST /channels/:channel_id/integration/init` — ask this channel's agents to
/// set the project up.
///
/// The gateway never runs `git`. Project init is a prompt: the agent already
/// runs on the user's machine inside its own `allowed_roots`, so cloning is its
/// job, under its own policy, with its own credentials. What the gateway
/// contributes is the instruction and the facts to carry it out.
///
/// Those facts travel in the message's `context_bundle`, not in the sentence.
/// A repository named `my_repo` would arrive in the body as `my\_repo` —
/// message bodies are markdown-escaped so an externally-chosen name cannot
/// forge structure — and an agent pasting that into a clone command would fetch
/// nothing. The bundle is the typed channel that reaches the agent's task frame
/// verbatim.
pub async fn init_project(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<InitResponse>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let binding = bindings::for_channel(&state.db, &channel_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
        .ok_or(AppError::NotFound)?;
    let descriptor = catalog::find(&binding.integration_id).ok_or(AppError::NotFound)?;
    let prompt = descriptor
        .init_prompt
        .ok_or_else(|| AppError::BadRequest("this integration has no project init".into()))?;
    let installation = installation_for_user(
        &state,
        &binding.integration_id,
        &binding.installation_id,
        &claims.sub,
    )
    .await?;

    let token = token(&state, &installation).await?;
    let repository = gh::get_repository(&state.config, &token, &binding.external_id)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "reading the repository for init failed");
            AppError::BadRequest("could not read that repository".into())
        })?
        .ok_or_else(|| {
            AppError::BadRequest("this installation can no longer read that repository".into())
        })?;

    let facts = json!({
        "full_name": repository.full_name,
        "default_branch": repository.default_branch,
        "clone_url": repository.clone_url,
    });
    let rendered = template::Template::parse(prompt)
        .map_err(|error| AppError::Internal(format!("invalid init prompt: {error}")))?
        .render(&facts);

    // Every bot in the channel. Mentioning by id rather than by name is the
    // same path `bot_status_scheduler` uses to prompt out of band.
    let bot_ids: Vec<String> = sqlx::query_scalar(
        "SELECT member_id FROM channel_memberships
          WHERE channel_id = $1 AND member_type = 'bot'
          ORDER BY member_id",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await?;
    if bot_ids.is_empty() {
        // Not an error: binding a channel before inviting an agent is a normal
        // order to do things in, and the caller can init again afterwards.
        return Ok(Json(InitResponse {
            prompted: vec![],
            message_id: None,
        }));
    }

    let mention_ids = bot_ids
        .iter()
        .map(|id| Uuid::parse_str(id).map_err(|_| AppError::Internal("malformed bot id".into())))
        .collect::<Result<Vec<_>, _>>()?;
    let channel_uuid = Uuid::parse_str(&channel_id)
        .map_err(|_| AppError::BadRequest("channel_id must be a uuid".into()))?;
    let author =
        Uuid::parse_str(&claims.sub).map_err(|_| AppError::Internal("malformed user id".into()))?;

    let message = create_message(
        &state.db,
        &state.fanout,
        &state.stream_registry,
        &state.bot_locator,
        CreateMessageParams {
            user_id: author,
            channel_id: channel_uuid,
            content: rendered.text,
            msg_type: None,
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids,
            mention_names: vec![],
            session_id: None,
            context_bundle: Some(json!({
                "integration": {
                    "id": binding.integration_id,
                    "kind": binding.external_kind,
                    "external_id": binding.external_id,
                    "action": "project_init",
                    "resource": facts,
                }
            })),
            msg_id: None,
        },
    )
    .await?;

    Ok(Json(InitResponse {
        prompted: bot_ids,
        message_id: Some(message.msg_id),
    }))
}

/// `GET /channels/:channel_id/integration`
pub async fn get_binding(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Option<BindingDto>>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let binding = bindings::for_channel(&state.db, &channel_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(Json(binding.map(BindingDto::from)))
}

/// `DELETE /channels/:channel_id/integration`
pub async fn unbind_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let removed = bindings::unbind(&state.db, &channel_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(Json(json!({ "unbound": removed })))
}
