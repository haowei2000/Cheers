//! Projecting external permissions into Cheers channel roles.
//!
//! CLAUDE.md is explicit that authorization is channel-role only and that the
//! Grant/trust_level model is dead. So an integration never gets its own
//! authorization axis: it declares a *projection* from its own vocabulary into
//! the four existing roles, and sync writes ordinary `channel_memberships`
//! rows. Nothing in a permission check knows the row came from GitHub.
//!
//! This module is the easiest place in the whole integration design to
//! accidentally reintroduce a parallel permission model, so it deliberately
//! does only one thing: map a provider role string to a channel role, and
//! decide what a sync pass is allowed to change.

/// The four roles `channel_memberships` accepts. Declared here so a projection
/// cannot invent a fifth and fail at the database CHECK.
pub const CHANNEL_ROLES: [&str; 4] = ["owner", "admin", "member", "readonly"];

/// Higher binds tighter. Used to decide whether a projection would demote.
fn rank(role: &str) -> Option<u8> {
    match role {
        "readonly" => Some(0),
        "member" => Some(1),
        "admin" => Some(2),
        "owner" => Some(3),
        _ => None,
    }
}

/// One integration's declared mapping, e.g. `github.push -> member`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleProjection {
    entries: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    /// The projection names a role `channel_memberships` would reject.
    UnknownChannelRole(String),
    /// Two entries for the same provider role.
    DuplicateProviderRole(String),
    Empty,
}

impl RoleProjection {
    pub fn new(entries: Vec<(String, String)>) -> Result<Self, ProjectionError> {
        if entries.is_empty() {
            return Err(ProjectionError::Empty);
        }
        let mut seen = Vec::new();
        for (provider_role, channel_role) in &entries {
            if !CHANNEL_ROLES.contains(&channel_role.as_str()) {
                return Err(ProjectionError::UnknownChannelRole(channel_role.clone()));
            }
            if seen.contains(provider_role) {
                return Err(ProjectionError::DuplicateProviderRole(
                    provider_role.clone(),
                ));
            }
            seen.push(provider_role.clone());
        }
        Ok(Self { entries })
    }

    /// The channel role for a provider role, or `None` when the projection does
    /// not mention it.
    ///
    /// An unmapped provider role is deliberately not defaulted to `member`:
    /// silently granting write access to a role nobody declared is exactly the
    /// failure this whole design is trying to avoid.
    pub fn resolve(&self, provider_role: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(from, _)| from == provider_role)
            .map(|(_, to)| to.as_str())
    }
}

/// What a sync pass decided to do about one member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncAction {
    /// Not currently a member; add with this role.
    Add(String),
    /// Already a member at a different role; change it.
    Rewrite(String),
    /// No change needed.
    Keep,
    /// Member exists but was added by a human, and the projection would have
    /// demoted them. Left alone.
    PreserveManual,
    /// The provider role is not in the projection; nothing to do.
    Unmapped,
}

/// The existing membership a sync pass is reconciling against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingMembership {
    pub role: String,
    /// `Some(integration_id)` when a previous sync wrote this row.
    pub projected_from: Option<String>,
}

/// Decide what to do about one external collaborator.
///
/// The rule, and the reason for it:
///
/// - A row this integration projected is fully owned by it, so it follows the
///   provider in both directions.
/// - A row a human created is never demoted. An admin who deliberately made
///   someone a channel owner should not lose that because the repo only lists
///   them as a reader. Promotion is still allowed: it is additive and matches
///   what the provider says.
///
/// Removal is not modelled here at all. A sync pass only ever adds or adjusts;
/// deciding when to *remove* a member whose external access was revoked is a
/// product decision with a destructive failure mode, and it belongs behind an
/// explicit call rather than falling out of a reconcile loop.
pub fn decide(
    projection: &RoleProjection,
    integration_id: &str,
    provider_role: &str,
    existing: Option<&ExistingMembership>,
) -> SyncAction {
    let Some(target) = projection.resolve(provider_role) else {
        return SyncAction::Unmapped;
    };
    let Some(existing) = existing else {
        return SyncAction::Add(target.to_string());
    };
    if existing.role == target {
        return SyncAction::Keep;
    }
    let ours = existing.projected_from.as_deref() == Some(integration_id);
    if ours {
        return SyncAction::Rewrite(target.to_string());
    }
    // Human-added: promote, never demote.
    match (rank(target), rank(&existing.role)) {
        (Some(new), Some(current)) if new > current => SyncAction::Rewrite(target.to_string()),
        _ => SyncAction::PreserveManual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github() -> RoleProjection {
        RoleProjection::new(vec![
            ("admin".into(), "owner".into()),
            ("maintain".into(), "admin".into()),
            ("push".into(), "member".into()),
            ("pull".into(), "readonly".into()),
        ])
        .expect("valid projection")
    }

    fn existing(role: &str, projected: Option<&str>) -> ExistingMembership {
        ExistingMembership {
            role: role.into(),
            projected_from: projected.map(str::to_string),
        }
    }

    #[test]
    fn a_projection_cannot_name_a_role_the_database_would_reject() {
        let err = RoleProjection::new(vec![("admin".into(), "superuser".into())]).unwrap_err();
        assert_eq!(err, ProjectionError::UnknownChannelRole("superuser".into()));
    }

    #[test]
    fn a_projection_cannot_map_one_provider_role_twice() {
        let err = RoleProjection::new(vec![
            ("push".into(), "member".into()),
            ("push".into(), "admin".into()),
        ])
        .unwrap_err();
        assert_eq!(err, ProjectionError::DuplicateProviderRole("push".into()));
    }

    #[test]
    fn every_projected_role_is_accepted_by_channel_memberships() {
        // Guards the CHECK in 0001_baseline.sql from the other side.
        for (_, channel_role) in &github().entries {
            assert!(CHANNEL_ROLES.contains(&channel_role.as_str()));
        }
    }

    #[test]
    fn an_unmapped_provider_role_grants_nothing() {
        // GitHub added "triage" after this projection was written. It must not
        // silently become a member.
        assert_eq!(
            decide(&github(), "github", "triage", None),
            SyncAction::Unmapped
        );
    }

    #[test]
    fn a_new_collaborator_is_added_at_the_projected_role() {
        assert_eq!(
            decide(&github(), "github", "push", None),
            SyncAction::Add("member".into())
        );
    }

    #[test]
    fn an_unchanged_collaborator_is_left_alone() {
        assert_eq!(
            decide(
                &github(),
                "github",
                "push",
                Some(&existing("member", Some("github")))
            ),
            SyncAction::Keep
        );
    }

    #[test]
    fn a_row_this_integration_projected_follows_the_provider_down() {
        // Demoted on GitHub from maintain to pull: our own row follows.
        assert_eq!(
            decide(
                &github(),
                "github",
                "pull",
                Some(&existing("admin", Some("github")))
            ),
            SyncAction::Rewrite("readonly".into())
        );
    }

    #[test]
    fn a_human_added_member_is_never_demoted() {
        // An admin deliberately made this person a channel owner. GitHub only
        // lists them as a reader. The human's decision stands.
        assert_eq!(
            decide(&github(), "github", "pull", Some(&existing("owner", None))),
            SyncAction::PreserveManual
        );
    }

    #[test]
    fn a_human_added_member_can_still_be_promoted() {
        assert_eq!(
            decide(
                &github(),
                "github",
                "admin",
                Some(&existing("readonly", None))
            ),
            SyncAction::Rewrite("owner".into())
        );
    }

    #[test]
    fn another_integrations_row_is_treated_as_manual() {
        // Overleaf projected this row; GitHub must not quietly take it over.
        assert_eq!(
            decide(
                &github(),
                "github",
                "pull",
                Some(&existing("admin", Some("overleaf")))
            ),
            SyncAction::PreserveManual
        );
    }

    #[test]
    fn role_ranks_cover_exactly_the_declared_roles() {
        for role in CHANNEL_ROLES {
            assert!(rank(role).is_some(), "{role} has no rank");
        }
        assert!(rank("superuser").is_none());
    }
}
