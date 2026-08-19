//! The set of known integrations, as data.
//!
//! This is the "hardcoded vertical" stage of the plan on purpose. Everything
//! here is already declarative — endpoints, signature scheme, where the event
//! id and type live — so lifting it into a signed manifest is a change of
//! source, not a redesign. Extracting a schema from two working verticals is
//! reliable; designing one against imagined integrations is not.

use super::mapper::EventMapping;
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
    /// Which events become channel messages, and how. An event type with no
    /// mapping is stored and marked processed without producing a message —
    /// GitHub sends dozens of types and a channel that echoed all of them would
    /// be unreadable.
    pub events: &'static [EventMapping],
}

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

pub fn descriptors() -> Vec<IntegrationDescriptor> {
    vec![IntegrationDescriptor {
        id: "github",
        display_name: "GitHub",
        signature: SignatureScheme::HmacSha256 {
            header: "X-Hub-Signature-256".into(),
            prefix: Some("sha256=".into()),
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
        events: GITHUB_EVENTS,
    }]
}

pub fn find(integration_id: &str) -> Option<IntegrationDescriptor> {
    descriptors()
        .into_iter()
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
                header: "X-Hub-Signature-256".into(),
                prefix: Some("sha256=".into()),
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
    #[test]
    fn every_declared_mapping_compiles() {
        for descriptor in descriptors() {
            super::super::mapper::compile_all(descriptor.events)
                .unwrap_or_else(|err| panic!("{}: {err}", descriptor.id));
        }
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
