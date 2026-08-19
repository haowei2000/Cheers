//! Binding a channel to an external resource, and syncing collaborators into it.
//!
//! Two directions run over the same row:
//!
//! - **Inbound**: a webhook arrives carrying `haowei2000/Cheers`. [`for_external`]
//!   turns that into a channel id. Without it the only way to route an event
//!   would be to pattern-match channel names.
//! - **Outbound**: a channel wants to know what it is connected to, so the
//!   Workbench can open the right repo. [`for_channel`].
//!
//! Member sync lives here too, but the *policy* — which external role becomes
//! which channel role, and when a projection may overwrite a human's decision —
//! is in [`super::projection`] and is deliberately pure.

use sqlx::{PgPool, Row};

use super::projection::{self, ExistingMembership, RoleProjection, SyncAction};

/// A channel's link to one external resource.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub channel_id: String,
    pub integration_id: String,
    pub installation_id: String,
    /// `repo` for GitHub, `project` for Overleaf.
    pub external_kind: String,
    /// The provider's own identifier, e.g. `haowei2000/Cheers`.
    pub external_id: String,
    /// Who bound the channel. Inbound events post as this user, following the
    /// convention `domain::scheduled_messages` already uses for out-of-band
    /// posting — which keeps an integration inside the permission model rather
    /// than beside it.
    pub created_by: String,
}

/// Link `channel_id` to an external resource.
///
/// Re-binding the same channel replaces the link rather than failing, so
/// pointing a channel at a renamed repo is one call. Binding a *second* channel
/// to a resource that is already bound is rejected by
/// `uq_channel_integration_binding` — the error surfaces rather than silently
/// creating an ambiguous inbound route.
pub async fn bind(
    db: &PgPool,
    binding: &Binding,
    config: &serde_json::Value,
    created_by: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO channel_integration_bindings (
             channel_id, integration_id, installation_id, external_kind, external_id,
             config, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (channel_id) DO UPDATE SET
             integration_id  = EXCLUDED.integration_id,
             installation_id = EXCLUDED.installation_id,
             external_kind   = EXCLUDED.external_kind,
             external_id     = EXCLUDED.external_id,
             config          = EXCLUDED.config",
    )
    .bind(&binding.channel_id)
    .bind(&binding.integration_id)
    .bind(&binding.installation_id)
    .bind(&binding.external_kind)
    .bind(&binding.external_id)
    .bind(config)
    .bind(created_by)
    .execute(db)
    .await?;
    Ok(())
}

fn read_binding(row: &sqlx::postgres::PgRow) -> anyhow::Result<Binding> {
    Ok(Binding {
        channel_id: row.try_get("channel_id")?,
        integration_id: row.try_get("integration_id")?,
        installation_id: row.try_get("installation_id")?,
        external_kind: row.try_get("external_kind")?,
        external_id: row.try_get("external_id")?,
        created_by: row.try_get("created_by")?,
    })
}

const COLUMNS: &str =
    "channel_id, integration_id, installation_id, external_kind, external_id, created_by";

pub async fn for_channel(db: &PgPool, channel_id: &str) -> anyhow::Result<Option<Binding>> {
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM channel_integration_bindings WHERE channel_id = $1"
    ))
    .bind(channel_id)
    .fetch_optional(db)
    .await?;
    row.as_ref().map(read_binding).transpose()
}

/// The inbound route: which channel, if any, an external resource feeds.
pub async fn for_external(
    db: &PgPool,
    integration_id: &str,
    installation_id: &str,
    external_kind: &str,
    external_id: &str,
) -> anyhow::Result<Option<Binding>> {
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM channel_integration_bindings
          WHERE integration_id = $1 AND installation_id = $2
            AND external_kind = $3 AND external_id = $4"
    ))
    .bind(integration_id)
    .bind(installation_id)
    .bind(external_kind)
    .bind(external_id)
    .fetch_optional(db)
    .await?;
    row.as_ref().map(read_binding).transpose()
}

/// Drop the link.
///
/// Memberships this integration projected are left in place: the people are
/// still in the channel and still have history there. Unbinding says "stop
/// syncing", not "eject everyone". `projected_from` is cleared so a later
/// re-bind treats those rows as human-owned and cannot demote them.
pub async fn unbind(db: &PgPool, channel_id: &str) -> anyhow::Result<bool> {
    let mut tx = db.begin().await?;
    let removed = sqlx::query("DELETE FROM channel_integration_bindings WHERE channel_id = $1")
        .bind(channel_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    sqlx::query(
        "UPDATE channel_memberships SET projected_from = NULL
          WHERE channel_id = $1 AND projected_from IS NOT NULL",
    )
    .bind(channel_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(removed > 0)
}

/// One collaborator as the provider reports them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalCollaborator {
    /// The provider's stable subject id, matched against
    /// `auth_external_identities.subject`.
    pub subject: String,
    /// The provider's own role name, e.g. GitHub's `push`.
    pub role: String,
}

/// What one sync pass did, for the audit line and the API response.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub added: usize,
    pub rewritten: usize,
    pub unchanged: usize,
    /// Members left alone because a human had set a higher role.
    pub preserved_manual: usize,
    /// Collaborators whose provider role the projection does not mention.
    pub unmapped: usize,
    /// Collaborators with no Cheers account linked to that provider.
    pub unlinked: usize,
    /// Collaborators who are linked but not active members of the workspace.
    pub not_in_workspace: usize,
}

/// Project external collaborators onto `channel_id`'s memberships.
///
/// Only ever adds or adjusts. A collaborator whose external access was revoked
/// keeps their membership — see [`super::projection::decide`] for why removal is
/// not modelled as part of reconcile.
///
/// A collaborator who is not already an **active workspace member** is skipped
/// and counted, never auto-joined. Two reasons, and the second is the one that
/// bites:
///
/// 1. The workspace is the tenancy boundary. Being a repo collaborator is not
///    consent to join someone's workspace, and an integration must not be able
///    to widen a grant that big on its own.
/// 2. `trg_channel_membership_workspace_invariant` (0068/0069) enforces this in
///    the database and is `DEFERRABLE INITIALLY DEFERRED`. Inserting such a row
///    inside this transaction would not fail at the INSERT — it would fail at
///    `COMMIT`, rolling back the entire sync pass and reporting an error that
///    names no particular member. Checking up front is what keeps one
///    unaffiliated collaborator from voiding everyone else's sync.
pub async fn sync_members(
    db: &PgPool,
    channel_id: &str,
    integration_id: &str,
    provider: &str,
    role_projection: &RoleProjection,
    collaborators: &[ExternalCollaborator],
    actor_id: &str,
) -> anyhow::Result<SyncReport> {
    let mut report = SyncReport::default();
    let mut tx = db.begin().await?;

    let workspace_id: String =
        sqlx::query_scalar("SELECT workspace_id FROM channels WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_one(&mut *tx)
            .await?;

    for collaborator in collaborators {
        let user_id: Option<String> = sqlx::query_scalar(
            "SELECT user_id FROM auth_external_identities
              WHERE provider = $1 AND subject = $2",
        )
        .bind(provider)
        .bind(&collaborator.subject)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(user_id) = user_id else {
            report.unlinked += 1;
            continue;
        };

        let in_workspace: bool = sqlx::query_scalar(
            "SELECT EXISTS (
                 SELECT 1 FROM workspace_memberships
                  WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'
             )",
        )
        .bind(&workspace_id)
        .bind(&user_id)
        .fetch_one(&mut *tx)
        .await?;
        if !in_workspace {
            report.not_in_workspace += 1;
            continue;
        }

        let existing = sqlx::query(
            "SELECT role, projected_from FROM channel_memberships
              WHERE channel_id = $1 AND member_id = $2",
        )
        .bind(channel_id)
        .bind(&user_id)
        .fetch_optional(&mut *tx)
        .await?
        .map(|row| -> anyhow::Result<ExistingMembership> {
            Ok(ExistingMembership {
                role: row.try_get("role")?,
                projected_from: row.try_get("projected_from")?,
            })
        })
        .transpose()?;

        match projection::decide(
            role_projection,
            integration_id,
            &collaborator.role,
            existing.as_ref(),
        ) {
            SyncAction::Add(role) => {
                sqlx::query(
                    "INSERT INTO channel_memberships
                         (channel_id, member_id, member_type, role, added_by, projected_from)
                     VALUES ($1, $2, 'user', $3, $4, $5)",
                )
                .bind(channel_id)
                .bind(&user_id)
                .bind(&role)
                .bind(actor_id)
                .bind(integration_id)
                .execute(&mut *tx)
                .await?;
                report.added += 1;
            }
            SyncAction::Rewrite(role) => {
                sqlx::query(
                    "UPDATE channel_memberships SET role = $3, projected_from = $4
                      WHERE channel_id = $1 AND member_id = $2",
                )
                .bind(channel_id)
                .bind(&user_id)
                .bind(&role)
                .bind(integration_id)
                .execute(&mut *tx)
                .await?;
                report.rewritten += 1;
            }
            SyncAction::Keep => report.unchanged += 1,
            SyncAction::PreserveManual => report.preserved_manual += 1,
            SyncAction::Unmapped => report.unmapped += 1,
        }
    }

    sqlx::query("UPDATE channel_integration_bindings SET synced_at = NOW() WHERE channel_id = $1")
        .bind(channel_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Every source file that reads or writes `projected_from`.
    ///
    /// The whole point of issue #569's Part B is that a projected membership is
    /// *indistinguishable from a manual one at the authorization layer*. The
    /// refactor that deleted the Grant/trust_level model left CLAUDE.md saying
    /// "authorization is channel-role only", and the easiest way to undo that
    /// is for one permission check to start reading this column — a projected
    /// member is "less trusted", a human-added one is "real". That is the dead
    /// model coming back under a new name.
    ///
    /// So the column is confined to `domain/integrations/` — the projection
    /// policy and the module that writes it. If it ever appears in `api/`,
    /// `resource/`, or anywhere else, this fails and the reviewer has to
    /// justify it.
    fn sources_mentioning(needle: &str) -> Vec<String> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    out.push(path);
                }
            }
        }

        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        walk(&root, &mut files);
        files.sort();

        files
            .into_iter()
            .filter(|path| {
                std::fs::read_to_string(path).is_ok_and(|source| source.contains(needle))
            })
            .map(|path| {
                path.strip_prefix(&root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn no_permission_check_consults_the_projection_marker() {
        let escaped: Vec<_> = sources_mentioning("projected_from")
            .into_iter()
            .filter(|path| !path.starts_with("domain/integrations/"))
            .collect();
        assert_eq!(
            escaped,
            Vec::<String>::new(),
            "`projected_from` escaped domain/integrations/. A permission check that \
             reads it reintroduces the per-source trust model CLAUDE.md calls dead — \
             a projected membership must be indistinguishable from a manual one at \
             the authorization layer."
        );
    }

    #[test]
    fn the_source_sweep_can_actually_find_things() {
        // Negative control: without this, a typo'd needle would make the guard
        // above pass by matching nothing at all.
        let hits = sources_mentioning("channel_memberships");
        assert!(
            hits.len() > 5,
            "sweep found only {hits:?} — it is not reading the tree"
        );
        assert!(hits.contains(&"domain/integrations/bindings.rs".to_string()));
    }
}
