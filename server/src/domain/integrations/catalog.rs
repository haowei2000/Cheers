//! The set of known integrations, as data.
//!
//! This is the "hardcoded vertical" stage of the plan on purpose. Everything
//! here is already declarative — endpoints, signature scheme, where the event
//! id and type live — so lifting it into a signed manifest is a change of
//! source, not a redesign. Extracting a schema from two working verticals is
//! reliable; designing one against imagined integrations is not.

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
}

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
}
