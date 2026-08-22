//! The set of known integrations, as data.
//!
//! This catalog is deliberately compiled into the trusted gateway release.
//! Descriptors are declarative so provider behavior stays reviewable and shared
//! engines remain reusable, but they are not remotely installable server plugins.

use std::sync::OnceLock;

use super::mapper::{self, CompiledMapping, EventMapping};
use super::projection::{ProjectionError, RoleProjection};
use super::webhook::SignatureScheme;

/// Where a provider puts a piece of event metadata.
///
/// Providers disagree: GitHub carries the delivery id and event name in
/// headers, LiveKit carries both in the body. Neither is more correct, so the
/// location is declared rather than assumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventField {
    Header(&'static str),
    /// A JSON Pointer (RFC 6901) into the parsed body.
    BodyPointer(&'static str),
}

#[derive(Debug, Clone)]
pub struct IntegrationDescriptor {
    pub id: &'static str,
    pub display_name: &'static str,
    pub signature: SignatureScheme,
    pub event_id: EventField,
    pub event_type: EventField,
    /// The `external_kind` a binding uses for this provider's main resource.
    pub resource_kind: &'static str,
    /// Dotted path to the resource's own identifier in every event payload.
    /// This is what turns an inbound event into a channel: the value is looked
    /// up against `channel_integration_bindings.external_id`.
    pub resource_path: &'static str,
    /// How the provider's own permission vocabulary maps onto the four channel
    /// roles. Data, not code: authorization stays channel-role only, and an
    /// integration never gets its own axis. A provider role absent from this
    /// table grants nothing at all — see [`super::projection`].
    pub role_projection: &'static [(&'static str, &'static str)],
    /// What to ask a channel's agent to do when the channel is first bound.
    ///
    /// A template like any other, and for the same reason: "clone it and index
    /// it" is one sentence of English that differs per provider, not logic. The
    /// prose is the message body; the machine-readable facts travel beside it
    /// in the message's context bundle, because CLAUDE.md keeps operations out
    /// of message bodies.
    pub init_prompt: Option<&'static str>,
    /// Which events become channel messages, and how. An event type with no
    /// mapping is stored and marked processed without producing a message —
    /// GitHub sends dozens of types and a channel that echoed all of them would
    /// be unreadable.
    pub events: &'static [EventMapping],
}

/// GitHub's repository permissions, projected onto channel roles.
///
/// `admin` and `maintain` both administer the repository, so both become
/// channel admins. `push` is the write bit — a contributor — and `triage`
/// grants issue management without code write, which is still participation,
/// so both become members. `pull` is read-only access and becomes `readonly`.
///
/// Nothing maps to `owner`: the channel's owner is whoever created it here, and
/// letting an external service hand out ownership would let a repository admin
/// take a Cheers channel away from the person who made it.
const GITHUB_ROLE_PROJECTION: &[(&str, &str)] = &[
    ("admin", "admin"),
    ("maintain", "admin"),
    ("push", "member"),
    ("triage", "member"),
    ("pull", "readonly"),
];

/// GitHub's mappings, as data. The whole point of issue #570 is that adding
/// `issues` or `release` here is an edit to this table, not new Rust.
const GITHUB_EVENTS: &[EventMapping] = &[
    EventMapping {
        event_type: "push",
        message: "{{pusher.name}} pushed {{commits.length}} commit(s) to {{ref}}",
        mentions: &[],
        require: None,
        // GitHub reuses `push` for branch deletion, with no commits. Without
        // this gate every deleted branch reads as "pushed 0 commit(s)".
        skip_when: Some("deleted"),
    },
    EventMapping {
        event_type: "pull_request",
        message: "PR #{{number}} {{action}}: {{pull_request.title}}",
        // The assignee's GitHub login is resolved through the same
        // `mention_names` path bots use, so an integration cannot mention
        // anyone a human could not.
        mentions: &["{{pull_request.assignee.login}}"],
        require: Some("pull_request"),
        skip_when: None,
    },
    EventMapping {
        event_type: "issues",
        message: "Issue #{{issue.number}} {{action}}: {{issue.title}}",
        mentions: &["{{issue.assignee.login}}"],
        require: Some("issue"),
        skip_when: None,
    },
    EventMapping {
        event_type: "release",
        message: "{{release.name}} released{{#if release.prerelease}} (prerelease){{/if}}",
        mentions: &[],
        require: Some("release"),
        skip_when: None,
    },
];

impl IntegrationDescriptor {
    /// This declaration's event mappings, compiled once. See [`compiled_table`].
    pub fn compiled_events(&self) -> Result<&'static [CompiledMapping], String> {
        match compiled_table().iter().find(|(id, _)| *id == self.id) {
            Some((_, Ok(compiled))) => Ok(compiled.as_slice()),
            Some((_, Err(error))) => Err(error.clone()),
            None => Err(format!("integration {} is not in the catalog", self.id)),
        }
    }

    /// The declared projection, validated.
    ///
    /// Returns an error rather than being built at startup so a broken
    /// declaration is a test failure in `catalog`, not a panic in `main`.
    pub fn projection(&self) -> Result<RoleProjection, ProjectionError> {
        RoleProjection::new(
            self.role_projection
                .iter()
                .map(|(from, to)| (from.to_string(), to.to_string()))
                .collect(),
        )
    }
}

/// Every trusted first-party integration. A `static` makes the release-coupled
/// trust boundary explicit and lets `find` return shared descriptor references.
static ALL: &[IntegrationDescriptor] = &[IntegrationDescriptor {
    id: "github",
    display_name: "GitHub",
    signature: SignatureScheme::HmacSha256 {
        header: "X-Hub-Signature-256",
        prefix: Some("sha256="),
    },
    // GitHub guarantees a unique delivery id per webhook attempt, and
    // repeats it on redelivery — which is exactly the dedupe semantics
    // wanted: a redelivery of an event already handled is a no-op.
    event_id: EventField::Header("X-GitHub-Delivery"),
    event_type: EventField::Header("X-GitHub-Event"),
    resource_kind: "repo",
    // Every repository-scoped GitHub event carries this, and it is the same
    // string a user types when binding a channel: `haowei2000/Cheers`.
    resource_path: "repository.full_name",
    role_projection: GITHUB_ROLE_PROJECTION,
    init_prompt: Some(
        "This channel now follows {{full_name}}. Please clone it into your \
         workspace, check out {{default_branch}}, and index the tree so you \
         can answer questions about the code. The clone URL is in this \
         message's context bundle. When the import finishes, call \
         report_code_workspace with the channel id, branch HEAD commit, and \
         ready status; report error status if setup fails.",
    ),
    events: GITHUB_EVENTS,
}];

pub fn descriptors() -> &'static [IntegrationDescriptor] {
    ALL
}

/// One row of the compile cache: an integration's id, and either its compiled
/// mappings or the reason its declaration does not compile.
type CompiledEntry = (&'static str, Result<Vec<CompiledMapping>, String>);

/// Every declaration's mappings, compiled once on first use.
///
/// Delivery used to call `mapper::compile_all` per event, re-parsing every
/// template of every declared event type and discarding all but one. The cost is
/// small at four mappings but grows with the table, and growing the table is the
/// entire point of declaring mappings as data.
///
/// Compiled lazily rather than at startup, and each entry keeps its error rather
/// than panicking, for the reason [`IntegrationDescriptor::projection`] already
/// documents: a broken declaration is a test failure in `catalog`, not a panic in
/// `main`. Delivery surfaces the error per event instead of taking down a worker.
fn compiled_table() -> &'static [CompiledEntry] {
    static COMPILED: OnceLock<Vec<CompiledEntry>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        ALL.iter()
            .map(|descriptor| {
                (
                    descriptor.id,
                    mapper::compile_all(descriptor.events).map_err(|error| error.to_string()),
                )
            })
            .collect()
    })
}

pub fn find(integration_id: &str) -> Option<&'static IntegrationDescriptor> {
    ALL.iter()
        .find(|descriptor| descriptor.id == integration_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_ids_are_unique() {
        let mut ids: Vec<_> = descriptors().iter().map(|d| d.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }

    #[test]
    fn github_uses_its_documented_signature_header() {
        let github = find("github").expect("github descriptor");
        assert_eq!(
            github.signature,
            SignatureScheme::HmacSha256 {
                header: "X-Hub-Signature-256",
                prefix: Some("sha256="),
            }
        );
    }

    #[test]
    fn unknown_integrations_resolve_to_none() {
        assert!(find("does-not-exist").is_none());
        assert!(find("").is_none());
    }

    /// A malformed template in this table would otherwise surface as a delivery
    /// failure on a live event, long after the typo was written.
    /// Same reason as the event mappings: a typo here would otherwise surface
    /// the first time somebody binds a channel.
    #[test]
    fn every_declared_init_prompt_compiles() {
        for descriptor in descriptors() {
            let Some(prompt) = descriptor.init_prompt else {
                continue;
            };
            super::super::template::Template::parse(prompt)
                .unwrap_or_else(|err| panic!("{}: {err}", descriptor.id));
        }
    }

    /// Why project init carries its facts in the message's context bundle
    /// rather than in the sentence: a body is markdown-escaped, so a repository
    /// whose name contains an underscore — a very ordinary name — arrives with
    /// a backslash in it. Prose can absorb that; a clone command cannot.
    #[test]
    fn an_init_body_is_escaped_so_the_facts_must_travel_beside_it() {
        let github = find("github").expect("github");
        let prompt = github.init_prompt.expect("github declares one");
        let rendered = super::super::template::Template::parse(prompt)
            .expect("compiles")
            .render(&serde_json::json!({
                "full_name": "haowei2000/my_repo",
                "default_branch": "main",
                "clone_url": "https://github.com/haowei2000/my_repo.git",
            }));
        assert!(
            rendered.text.contains("my\\_repo"),
            "expected an escaped body, got: {}",
            rendered.text
        );
        // And therefore the body must not be where a machine reads the URL.
        assert!(
            !rendered.text.contains("https://"),
            "the clone URL must not be interpolated into the body: {}",
            rendered.text
        );
    }

    #[test]
    fn every_declared_mapping_compiles() {
        // Through `compiled_events` rather than `mapper::compile_all` directly,
        // so this guards the path delivery actually takes.
        for descriptor in descriptors() {
            descriptor
                .compiled_events()
                .unwrap_or_else(|err| panic!("{}: {err}", descriptor.id));
        }
    }

    #[test]
    fn a_descriptor_is_one_shared_value_not_a_copy_per_lookup() {
        // `find` used to hand back a row of a table rebuilt with owned `String`s
        // on every call. Callers now share one compiled-in value, which is what
        // `&'static` is claiming in the type.
        let first = find("github").expect("github");
        let second = find("github").expect("github");
        assert!(std::ptr::eq(first, second));
    }

    #[test]
    fn event_mappings_are_compiled_once_and_shared() {
        // Delivery asks for these per inbound event. Recompiling would
        // re-tokenize every template of every declared type each time.
        let first = find("github")
            .expect("github")
            .compiled_events()
            .expect("compiles");
        let second = find("github")
            .expect("github")
            .compiled_events()
            .expect("compiles");
        assert_eq!(first.as_ptr(), second.as_ptr());
        assert_eq!(first.len(), GITHUB_EVENTS.len());
    }

    #[test]
    fn a_descriptor_outside_the_catalog_gets_no_mappings() {
        // The cache is keyed by id, so a descriptor built outside `ALL` has to
        // fail loudly rather than quietly resolving to another integration's
        // mappings.
        let mut stray = find("github").expect("github").clone();
        stray.id = "not-in-the-catalog";
        assert!(stray.compiled_events().is_err());
    }

    /// A projection naming a fifth role, or the same provider role twice, would
    /// otherwise surface as a failed sync against a live repository.
    #[test]
    fn every_declared_role_projection_is_valid() {
        for descriptor in descriptors() {
            descriptor
                .projection()
                .unwrap_or_else(|err| panic!("{}: {err:?}", descriptor.id));
        }
    }

    #[test]
    fn no_integration_can_hand_out_channel_ownership() {
        // An external service granting `owner` could take a channel away from
        // the person who created it.
        for descriptor in descriptors() {
            for (provider_role, channel_role) in descriptor.role_projection {
                assert_ne!(
                    *channel_role, "owner",
                    "{} projects {provider_role} onto owner",
                    descriptor.id
                );
            }
        }
    }

    #[test]
    fn github_projects_every_permission_level_it_can_receive() {
        // The five names `api::canonical_role` can produce. A gap here is a
        // collaborator who silently gets nothing.
        let github = find("github").expect("github");
        let projection = github.projection().expect("valid");
        for permission in ["admin", "maintain", "push", "triage", "pull"] {
            assert!(
                projection.resolve(permission).is_some(),
                "github does not project {permission}"
            );
        }
    }

    #[test]
    fn a_repository_reader_never_becomes_a_channel_writer() {
        let projection = find("github").expect("github").projection().expect("valid");
        assert_eq!(projection.resolve("pull"), Some("readonly"));
        // And an unrecognized permission grants nothing rather than defaulting.
        assert_eq!(projection.resolve("acme-custom-role"), None);
    }

    #[test]
    fn event_types_are_unique_within_an_integration() {
        for descriptor in descriptors() {
            let mut types: Vec<_> = descriptor.events.iter().map(|e| e.event_type).collect();
            let total = types.len();
            types.sort_unstable();
            types.dedup();
            assert_eq!(
                types.len(),
                total,
                "{} has a duplicate event type",
                descriptor.id
            );
        }
    }
}
