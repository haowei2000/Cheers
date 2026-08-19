//! The slice of GitHub's REST API this vertical needs: which repositories an
//! installation covers, and who can push to one.
//!
//! Read-only on purpose. Issue #571 puts write-back — commenting, opening PRs —
//! out of scope, because outbound belongs to the MCP bridge where an agent's
//! actions are already attributed and approved. Nothing here posts.

use serde::Deserialize;

use super::app::http;
use crate::config::Config;
use crate::domain::integrations::secret::Secret;

/// GitHub's maximum. Fewer, larger pages is the cheaper way to be polite to the
/// rate limiter.
const PER_PAGE: usize = 100;
/// Stop after this many pages. An installation with more repositories than this
/// is not something a picker can usefully show, and an unbounded loop against a
/// paginating API is how one bad response becomes an outage.
const MAX_PAGES: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repository {
    pub id: i64,
    /// `owner/name`, the same string a binding stores as its `external_id` and
    /// that inbound events carry as `repository.full_name`.
    pub full_name: String,
    pub name: String,
    pub private: bool,
    pub description: Option<String>,
    pub default_branch: String,
    pub clone_url: String,
    pub html_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collaborator {
    /// GitHub's numeric user id. Stable across a rename, which a login is not —
    /// so this, not the login, is what an identity link is keyed on.
    pub id: i64,
    pub login: String,
    /// Canonical permission name: `admin`, `maintain`, `push`, `triage`, or
    /// `pull`. See [`canonical_role`].
    pub role: String,
}

#[derive(Debug, Deserialize)]
struct RepositoryPage {
    repositories: Vec<RawRepository>,
}

#[derive(Debug, Deserialize)]
struct RawRepository {
    id: i64,
    name: String,
    full_name: String,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    clone_url: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawCollaborator {
    id: i64,
    login: String,
    #[serde(default)]
    permissions: Option<Permissions>,
    #[serde(default)]
    role_name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Permissions {
    #[serde(default)]
    admin: bool,
    #[serde(default)]
    maintain: bool,
    #[serde(default)]
    push: bool,
    #[serde(default)]
    triage: bool,
    #[serde(default)]
    pull: bool,
}

/// Reduce a collaborator's access to one name.
///
/// `permissions` is preferred over `role_name` because it is the stable shape:
/// it is always present, its vocabulary has not changed, and a *custom*
/// repository role — which `role_name` reports under whatever the org called
/// it — still reports the built-in permissions it grants. Highest wins, because
/// the flags are cumulative: an admin has every one of them set.
///
/// A collaborator with no permissions object and no role name is reported as
/// the empty string, which the projection treats as unmapped and therefore
/// grants nothing.
fn canonical_role(raw: &RawCollaborator) -> String {
    if let Some(permissions) = &raw.permissions {
        for (flag, name) in [
            (permissions.admin, "admin"),
            (permissions.maintain, "maintain"),
            (permissions.push, "push"),
            (permissions.triage, "triage"),
            (permissions.pull, "pull"),
        ] {
            if flag {
                return name.to_string();
            }
        }
    }
    raw.role_name.clone().unwrap_or_default()
}

/// Reject anything that is not exactly `owner/repo`.
///
/// This value reaches a URL path. A binding holding `a/../../orgs/secret` would
/// otherwise make the gateway fetch a resource the installation never covered,
/// using a valid installation token.
pub fn valid_full_name(full_name: &str) -> bool {
    let mut parts = full_name.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ok = |segment: &str| {
        !segment.is_empty()
            && segment.len() <= 100
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && segment != "."
            && segment != ".."
    };
    ok(owner) && ok(repo)
}

async fn get_json<T: serde::de::DeserializeOwned>(
    token: &Secret,
    url: &str,
) -> anyhow::Result<Option<T>> {
    let response = http()
        .get(url)
        .bearer_auth(token.expose())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        // Deliberately without the body: it echoes request context, and this
        // error is rendered to a user.
        anyhow::bail!("GitHub returned {status}");
    }
    Ok(Some(response.json().await?))
}

/// Every repository the installation can reach.
pub async fn list_repositories(config: &Config, token: &Secret) -> anyhow::Result<Vec<Repository>> {
    let mut all = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "{}/installation/repositories?per_page={PER_PAGE}&page={page}",
            config.github_api_base_url
        );
        let Some(body) = get_json::<RepositoryPage>(token, &url).await? else {
            break;
        };
        let count = body.repositories.len();
        all.extend(body.repositories.into_iter().map(|raw| Repository {
            id: raw.id,
            full_name: raw.full_name,
            name: raw.name,
            private: raw.private,
            description: raw.description,
            default_branch: raw.default_branch.unwrap_or_else(|| "main".into()),
            clone_url: raw.clone_url.unwrap_or_default(),
            html_url: raw.html_url.unwrap_or_default(),
        }));
        // A short page is the last page.
        if count < PER_PAGE {
            break;
        }
    }
    Ok(all)
}

/// Everyone with access to `full_name`, with their access reduced to one name.
///
/// `Ok(None)` means GitHub answered 404 — the repository is gone, or the
/// installation no longer covers it. That is a different situation from "no
/// collaborators" and the caller must not treat it as an empty roster, which
/// would read as "remove everyone".
pub async fn list_collaborators(
    config: &Config,
    token: &Secret,
    full_name: &str,
) -> anyhow::Result<Option<Vec<Collaborator>>> {
    if !valid_full_name(full_name) {
        anyhow::bail!("not a repository name");
    }
    let mut all = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "{}/repos/{full_name}/collaborators?per_page={PER_PAGE}&page={page}",
            config.github_api_base_url
        );
        let Some(body) = get_json::<Vec<RawCollaborator>>(token, &url).await? else {
            return Ok(None);
        };
        let count = body.len();
        all.extend(body.into_iter().map(|raw| Collaborator {
            role: canonical_role(&raw),
            id: raw.id,
            login: raw.login,
        }));
        if count < PER_PAGE {
            break;
        }
    }
    Ok(Some(all))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collaborator(json: serde_json::Value) -> RawCollaborator {
        serde_json::from_value(json).expect("parses")
    }

    #[test]
    fn permissions_reduce_to_the_highest_flag() {
        // GitHub sets every flag up to the granted level, so reading them in
        // any other order reports an admin as a reader.
        let admin = collaborator(serde_json::json!({
            "id": 1, "login": "octocat",
            "permissions": {"admin": true, "maintain": true, "push": true, "triage": true, "pull": true}
        }));
        assert_eq!(canonical_role(&admin), "admin");

        let writer = collaborator(serde_json::json!({
            "id": 2, "login": "hubot",
            "permissions": {"admin": false, "maintain": false, "push": true, "triage": true, "pull": true}
        }));
        assert_eq!(canonical_role(&writer), "push");

        let reader = collaborator(serde_json::json!({
            "id": 3, "login": "reader",
            "permissions": {"admin": false, "maintain": false, "push": false, "triage": false, "pull": true}
        }));
        assert_eq!(canonical_role(&reader), "pull");
    }

    #[test]
    fn a_custom_org_role_is_read_through_the_permissions_it_grants() {
        // `role_name` would be the org's own label, which no projection can
        // know. The built-in permissions underneath it are still meaningful.
        let custom = collaborator(serde_json::json!({
            "id": 4, "login": "dev",
            "role_name": "acme-deployer",
            "permissions": {"admin": false, "maintain": false, "push": true, "triage": true, "pull": true}
        }));
        assert_eq!(canonical_role(&custom), "push");
    }

    #[test]
    fn a_collaborator_with_no_permissions_is_unmapped_rather_than_a_member() {
        // Defaulting here would silently grant channel access on a response
        // shape we did not expect.
        let bare = collaborator(serde_json::json!({"id": 5, "login": "ghost"}));
        assert_eq!(canonical_role(&bare), "");
    }

    #[test]
    fn role_name_is_the_fallback_when_permissions_are_absent() {
        let named = collaborator(serde_json::json!({
            "id": 6, "login": "x", "role_name": "admin"
        }));
        assert_eq!(canonical_role(&named), "admin");
    }

    #[test]
    fn a_repository_name_must_be_exactly_owner_slash_repo() {
        assert!(valid_full_name("haowei2000/Cheers"));
        assert!(valid_full_name("a-b_c.d/e.f_g-h"));

        assert!(!valid_full_name("Cheers"));
        assert!(!valid_full_name("a/b/c"));
        assert!(!valid_full_name("/Cheers"));
        assert!(!valid_full_name("haowei2000/"));
        assert!(!valid_full_name(""));
    }

    #[test]
    fn a_repository_name_cannot_walk_out_of_its_url_path() {
        // The attack this exists for: a binding whose external_id escapes the
        // /repos/{full_name}/ prefix and spends a valid installation token on
        // something the installation never covered.
        assert!(!valid_full_name("a/../../orgs/secret"));
        assert!(!valid_full_name("../secret"));
        assert!(!valid_full_name(".."));
        assert!(!valid_full_name("a/.."));
        assert!(!valid_full_name("a/b?per_page=1"));
        assert!(!valid_full_name("a/b#x"));
        assert!(!valid_full_name("a/b c"));
        assert!(!valid_full_name("a%2F../b"));
    }

    #[test]
    fn a_repository_page_parses_the_fields_the_picker_shows() {
        let page: RepositoryPage = serde_json::from_value(serde_json::json!({
            "total_count": 1,
            "repositories": [{
                "id": 42, "name": "Cheers", "full_name": "haowei2000/Cheers",
                "private": true, "description": "chat", "default_branch": "develop",
                "clone_url": "https://github.com/haowei2000/Cheers.git",
                "html_url": "https://github.com/haowei2000/Cheers"
            }]
        }))
        .expect("parses");
        assert_eq!(page.repositories[0].full_name, "haowei2000/Cheers");
        assert_eq!(
            page.repositories[0].default_branch.as_deref(),
            Some("develop")
        );
    }

    #[test]
    fn a_repository_missing_optional_fields_still_parses() {
        // GitHub Enterprise and older payloads omit some of these; a picker
        // that fails to deserialize shows the user nothing at all.
        let page: RepositoryPage = serde_json::from_value(serde_json::json!({
            "repositories": [{"id": 1, "name": "x", "full_name": "o/x"}]
        }))
        .expect("parses");
        assert_eq!(page.repositories.len(), 1);
    }
}
