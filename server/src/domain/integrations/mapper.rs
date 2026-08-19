//! Event → message mapping, declared rather than coded.
//!
//! Issue #570's point: written as bespoke Rust per integration, this is the part
//! that balloons — every service has dozens of event types. So a mapping is
//! data: an event type, a message [`Template`], and optional mention templates.
//!
//! The output lands in the **existing** message model — text plus the flat
//! tokens the platform already understands. Per CLAUDE.md, operations never go
//! in a message body: a mapping that wants to trigger a bot resolves
//! `mention_names`, exactly as bot@bot triggering already does through
//! `post_message`.

use serde_json::Value;

use super::template::{self, Rendered, Template, TemplateError};

/// One event type's mapping.
#[derive(Debug, Clone)]
pub struct EventMapping {
    /// The provider's event type, matched against the ingress-extracted type.
    pub event_type: &'static str,
    /// Message body template.
    pub message: &'static str,
    /// Templates producing `mention_names`. Each renders to one name; an empty
    /// render is dropped, so `{{assignee.login}}` on an unassigned PR mentions
    /// nobody rather than mentioning the empty string.
    pub mentions: &'static [&'static str],
    /// Render only when this path is truthy.
    pub require: Option<&'static str>,
    /// Skip when this path is truthy. Both gates exist rather than one with a
    /// negation operator because GitHub needs both shapes and neither is
    /// expressible as the other: `push` arrives for branch *deletions* with
    /// `deleted: true` (skip_when), while `pull_request` carries the useful
    /// detail under a nested object that is sometimes absent (require).
    pub skip_when: Option<&'static str>,
}

/// A mapping compiled once, ready to render.
#[derive(Debug, Clone)]
pub struct CompiledMapping {
    pub event_type: String,
    message: Template,
    mentions: Vec<Template>,
    require: Option<Vec<String>>,
    skip_when: Option<Vec<String>>,
}

/// What a mapping produced for one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedMessage {
    pub content: String,
    pub mention_names: Vec<String>,
    /// Field paths the payload lacked, across the body and every mention.
    pub missing: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug)]
pub enum MappingError {
    /// A template in the declaration does not parse. A mapping author's bug,
    /// caught by the catalog's own test rather than at delivery time.
    Template {
        event_type: String,
        source: TemplateError,
    },
}

impl std::fmt::Display for MappingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Template { event_type, source } => {
                write!(f, "mapping for {event_type}: {source}")
            }
        }
    }
}

impl std::error::Error for MappingError {}

fn split_path(path: &str) -> Vec<String> {
    path.split('.').map(str::to_string).collect()
}

pub fn compile(mapping: &EventMapping) -> Result<CompiledMapping, MappingError> {
    let fail = |source: TemplateError| MappingError::Template {
        event_type: mapping.event_type.to_string(),
        source,
    };
    Ok(CompiledMapping {
        event_type: mapping.event_type.to_string(),
        message: Template::parse(mapping.message).map_err(fail)?,
        mentions: mapping
            .mentions
            .iter()
            .map(|source| Template::parse(source).map_err(fail))
            .collect::<Result<_, _>>()?,
        require: mapping.require.map(split_path),
        skip_when: mapping.skip_when.map(split_path),
    })
}

impl CompiledMapping {
    /// Render the event, or `None` when a gate says this event is not
    /// interesting.
    ///
    /// A body that renders to nothing also yields `None`: posting an empty
    /// message is worse than posting nothing, and empty is the shape a template
    /// takes when every field it reads is absent.
    pub fn render(&self, payload: &Value) -> Option<MappedMessage> {
        if let Some(path) = &self.require {
            if !template::truthy(template::lookup(payload, path)) {
                return None;
            }
        }
        if let Some(path) = &self.skip_when {
            if template::truthy(template::lookup(payload, path)) {
                return None;
            }
        }

        let Rendered {
            text,
            mut missing,
            truncated,
        } = self.message.render(payload);
        if text.trim().is_empty() {
            return None;
        }

        let mut mention_names = Vec::new();
        for mention in &self.mentions {
            let rendered = mention.render(payload);
            missing.extend(rendered.missing);
            // Escaping is for message bodies; a mention name is looked up, not
            // rendered, so the backslashes would just fail to match a username.
            let name = rendered.text.replace('\\', "").trim().to_string();
            if !name.is_empty() && !mention_names.contains(&name) {
                mention_names.push(name);
            }
        }

        missing.sort();
        missing.dedup();
        Some(MappedMessage {
            content: text,
            mention_names,
            missing,
            truncated,
        })
    }
}

/// Compile a whole declaration, keyed by event type.
pub fn compile_all(mappings: &[EventMapping]) -> Result<Vec<CompiledMapping>, MappingError> {
    mappings.iter().map(compile).collect()
}

/// The mapping for one event type, if the integration declares one.
pub fn find<'a>(compiled: &'a [CompiledMapping], event_type: &str) -> Option<&'a CompiledMapping> {
    compiled
        .iter()
        .find(|mapping| mapping.event_type == event_type)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn github(event_type: &str) -> CompiledMapping {
        let descriptor = super::super::catalog::find("github").expect("github");
        let compiled = compile_all(descriptor.events).expect("catalog compiles");
        find(&compiled, event_type)
            .unwrap_or_else(|| panic!("no {event_type} mapping"))
            .clone()
    }

    /// The literal shape GitHub sends, trimmed to the fields the mapping reads.
    fn push_payload() -> serde_json::Value {
        json!({
            "ref": "refs/heads/develop",
            "deleted": false,
            "pusher": {"name": "haowei2000"},
            "commits": [
                {"message": "fix the thing"},
                {"message": "and the other thing"}
            ],
            "repository": {"full_name": "haowei2000/Cheers"}
        })
    }

    /// Issue #570's first acceptance criterion, exercised end to end through
    /// the declaration in `catalog.rs` — no Rust in this path renders anything.
    #[test]
    fn a_github_push_becomes_a_message_by_declaration() {
        let mapped = github("push").render(&push_payload()).expect("renders");
        assert_eq!(
            mapped.content,
            "haowei2000 pushed 2 commit(s) to refs/heads/develop"
        );
        assert!(mapped.mention_names.is_empty());
        assert!(mapped.missing.is_empty(), "missing: {:?}", mapped.missing);
    }

    #[test]
    fn a_branch_deletion_does_not_become_a_push_message() {
        // GitHub reuses `push` for branch deletion. Without the skip_when gate
        // every deleted branch reads as "pushed 0 commit(s)".
        let mut payload = push_payload();
        payload["deleted"] = json!(true);
        payload["commits"] = json!([]);
        assert!(github("push").render(&payload).is_none());
    }

    #[test]
    fn a_pull_request_mentions_its_assignee() {
        let mapped = github("pull_request")
            .render(&json!({
                "number": 42,
                "action": "opened",
                "pull_request": {
                    "title": "Add the mapper",
                    "assignee": {"login": "haowei2000"}
                },
                "repository": {"full_name": "haowei2000/Cheers"}
            }))
            .expect("renders");
        assert_eq!(mapped.content, "PR #42 opened: Add the mapper");
        // Resolved later through the same `mention_names` path bots use, so an
        // integration cannot mention anyone a human could not.
        assert_eq!(mapped.mention_names, vec!["haowei2000".to_string()]);
    }

    #[test]
    fn an_unassigned_pull_request_mentions_nobody() {
        let mapped = github("pull_request")
            .render(&json!({
                "number": 42,
                "action": "closed",
                "pull_request": {"title": "Add the mapper"},
                "repository": {"full_name": "haowei2000/Cheers"}
            }))
            .expect("renders");
        // Not `vec![""]` — an empty render is dropped rather than becoming a
        // mention of the empty string.
        assert!(mapped.mention_names.is_empty());
    }

    #[test]
    fn a_mention_name_is_not_markdown_escaped() {
        // Escaping protects message bodies. A mention is looked up against
        // usernames, so a backslash would just fail to match.
        let mapped = github("pull_request")
            .render(&json!({
                "number": 1,
                "action": "opened",
                "pull_request": {
                    "title": "t",
                    "assignee": {"login": "some_user-name"}
                }
            }))
            .expect("renders");
        assert_eq!(mapped.mention_names, vec!["some_user-name".to_string()]);
    }

    #[test]
    fn require_skips_an_event_whose_object_is_absent() {
        // A `pull_request` delivery with no pull_request object is not
        // something to render half of.
        assert!(github("pull_request")
            .render(&json!({"number": 42, "action": "opened"}))
            .is_none());
    }

    #[test]
    fn a_conditional_in_a_declaration_reaches_the_message() {
        let release = github("release");
        let mapped = release
            .render(&json!({"release": {"name": "v2.0", "prerelease": true}}))
            .expect("renders");
        assert_eq!(mapped.content, "v2.0 released (prerelease)");
        let stable = release
            .render(&json!({"release": {"name": "v2.0", "prerelease": false}}))
            .expect("renders");
        assert_eq!(stable.content, "v2.0 released");
    }

    #[test]
    fn an_undeclared_event_type_has_no_mapping() {
        // GitHub sends dozens of types. A channel that echoed all of them would
        // be unreadable, so an unmapped type is simply absent here and the
        // worker marks it processed without posting.
        let descriptor = super::super::catalog::find("github").expect("github");
        let compiled = compile_all(descriptor.events).expect("compiles");
        assert!(find(&compiled, "watch").is_none());
        assert!(find(&compiled, "fork").is_none());
    }

    #[test]
    fn a_message_that_renders_to_nothing_is_not_posted() {
        let mapping = compile(&EventMapping {
            event_type: "blank",
            message: "{{absent}}",
            mentions: &[],
            require: None,
            skip_when: None,
        })
        .expect("compiles");
        assert!(mapping.render(&json!({})).is_none());
    }

    #[test]
    fn duplicate_mention_templates_collapse() {
        let mapping = compile(&EventMapping {
            event_type: "dup",
            message: "hi",
            mentions: &["{{a}}", "{{b}}"],
            require: None,
            skip_when: None,
        })
        .expect("compiles");
        let mapped = mapping.render(&json!({"a": "sam", "b": "sam"})).unwrap();
        assert_eq!(mapped.mention_names, vec!["sam".to_string()]);
    }

    #[test]
    fn a_broken_template_fails_to_compile_naming_its_event() {
        let err = compile(&EventMapping {
            event_type: "push",
            message: "{{unterminated",
            mentions: &[],
            require: None,
            skip_when: None,
        })
        .unwrap_err();
        assert!(err.to_string().starts_with("mapping for push:"), "{err}");
    }

    #[test]
    fn a_hostile_commit_message_cannot_forge_structure_in_a_real_mapping() {
        // The end-to-end version of the template escaping test: a branch name
        // anyone with push access chooses, carried through the declaration.
        let mut payload = push_payload();
        payload["ref"] = json!("refs/heads/[Approved](https://evil.example)");
        let mapped = github("push").render(&payload).expect("renders");
        assert!(
            mapped
                .content
                .ends_with("refs/heads/\\[Approved\\](https://evil.example)"),
            "{}",
            mapped.content
        );
    }
}
