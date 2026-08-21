//! Cheers Locator — the one textual name for a platform resource.
//!
//! A locator is the AI-writable serialization of the `{resource, params}` addressing
//! every read already uses:
//!
//! ```text
//!   cheers:desk/<path>[#L<n>[-L<n>]]      this channel's Desk file (context_files)
//!   cheers:ws/<bot>/<path>[#L<n>[-L<n>]]  a bot's real workspace file
//!   cheers:msg/<message_id>               a message in this channel
//!   cheers:inbox/<file_id>                a chat attachment
//!   cheers:plan | sessions | cost | activity   this channel's live projections
//! ```
//!
//! It lives in this crate, not the Gateway, for the reason [`crate::registry`] exists:
//! the resource vocabulary is declared once and every consumer derives from it. A
//! locator that resolved to a resource the catalog does not know would be a fifth
//! hand-maintained list, so [`tests::every_resolvable_locator_names_a_catalog_resource`]
//! makes that impossible.
//!
//! **Channel scope is deliberately not in the URI.** Locators are channel-implicit —
//! always the current channel — which is how the shipped, agent-writable format already
//! works and how the Gateway pins scope everywhere else. [`Locator::resolve`] takes the
//! channel and puts it in the params.
//!
//! ## Relationship to the MCP resource templates
//!
//! This crate already exposes a *second* resource-URI form: the MCP resource templates
//! `cheers://channel/{channel_id}/plan` and friends, resolved by
//! [`crate::build_uri_resource_call`]. They overlap — both name plan, sessions, usage,
//! files and desk — and having two URI vocabularies for one platform is the very thing a
//! single resource name was meant to end. Worth converging; not converged here, because
//! those templates are wire contract for already-connected Agents.
//!
//! Until then the split is by origin rather than preference, and a locator earns its keep
//! on two things the template form cannot do:
//!
//! - **Line anchors.** `cheers:desk/notes.md#L3-L9` names a passage. A template names a
//!   whole file.
//! - **The text form.** An Agent reads `cheers:desk/notes.md#L3` in a channel message. It
//!   cannot hand that to `resources/read`, which wants the `cheers://channel/{id}/…` form
//!   — converting between them means knowing the mapping, which is the knowledge the URI
//!   exists to remove. `read_locator` takes what the message actually said.
//!
//! ## `cheers:` is crowded, and that is guarded
//!
//! The scheme already means six other things: OAuth scopes (`cheers:read`), the resource
//! guide (`cheers://help/resources`), the MCP resource templates
//! (`cheers://channel/…`), the desktop callback (`cheers://auth/callback`), a task-claim
//! namespace string, and a LiveKit participant identity. None of them is a
//! locator, and none of them parses as one — the shapes genuinely differ. That was luck
//! until [`tests::the_other_meanings_of_the_scheme_are_not_locators`] froze it.

use serde_json::{json, Value};

/// Matches the client parser's cap: a path plus an anchor. Anything longer is garbage
/// or an attack surface, not a file reference.
pub const MAX_LOCATOR_LENGTH: usize = 2048;
pub const SCHEME: &str = "cheers:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Locator {
    Desk {
        path: String,
        line: Option<u32>,
        line_end: Option<u32>,
    },
    Ws {
        bot: String,
        path: String,
        line: Option<u32>,
        line_end: Option<u32>,
    },
    Msg {
        message_id: String,
    },
    Inbox {
        file_id: String,
    },
    /// Channel-scoped projections. No tail, no anchor — the channel IS the address.
    Plan,
    Sessions,
    Cost,
    Activity,
}

/// One path segment of hygiene: locators address files RELATIVELY. Absolute paths and
/// dot-segments never appear in honest locators, so rejecting them here means no consumer
/// ever sees a traversal attempt.
fn clean_rel_path(p: &str) -> Option<String> {
    if p.is_empty() || p.starts_with('/') || p.contains('\\') {
        return None;
    }
    if p.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return None;
    }
    Some(p.to_owned())
}

/// `L<n>` or `L<n>-L<n>`. Tolerant on intent: a reversed range still names the same lines.
fn parse_anchor(frag: &str) -> Option<(u32, Option<u32>)> {
    let rest = frag.strip_prefix('L')?;
    let (a, b) = match rest.split_once("-L") {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };
    let a: u32 = a.parse().ok().filter(|n| *n >= 1)?;
    match b {
        None => Some((a, None)),
        Some(b) => {
            let b: u32 = b.parse().ok().filter(|n| *n >= 1)?;
            Some(if b < a { (b, Some(a)) } else { (a, Some(b)) })
        }
    }
}

/// Parse a `cheers:` locator. `None` when the string is not a well-formed locator —
/// callers surface that as a user-visible error, never as silence.
///
/// Strict on shape, tolerant on intent, mirroring the client parser exactly.
pub fn parse(uri: &str) -> Option<Locator> {
    if uri.len() > MAX_LOCATOR_LENGTH {
        return None;
    }
    let rest = uri.strip_prefix(SCHEME)?;
    // Single-token by design: whitespace and control characters cannot appear in a valid
    // locator, so their presence means this is something else entirely.
    if rest
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\u{7f}')
    {
        return None;
    }

    let (body, frag) = match rest.split_once('#') {
        Some((b, f)) => (b, Some(f)),
        None => (rest, None),
    };

    let anchor = match frag {
        // A fragment that is not a line anchor makes the whole locator malformed.
        Some(f) => Some(parse_anchor(f)?),
        None => None,
    };

    // A leading slash means an authority form (`cheers://…`), which is a deep link, not
    // a locator. No slash at all is a channel-scoped kind.
    let (kind, tail) = match body.find('/') {
        Some(0) => return None,
        Some(i) => (&body[..i], &body[i + 1..]),
        None => (body, ""),
    };

    let (line, line_end) = match anchor {
        Some((a, b)) => (Some(a), b),
        None => (None, None),
    };

    match kind {
        "desk" => Some(Locator::Desk {
            path: clean_rel_path(tail)?,
            line,
            line_end,
        }),
        "ws" => {
            let i = tail.find('/').filter(|i| *i > 0)?;
            let bot = &tail[..i];
            if bot == "@" {
                return None;
            }
            Some(Locator::Ws {
                bot: bot.to_owned(),
                path: clean_rel_path(&tail[i + 1..])?,
                line,
                line_end,
            })
        }
        "msg" if !tail.is_empty() && !tail.contains('/') && anchor.is_none() => {
            Some(Locator::Msg {
                message_id: tail.to_owned(),
            })
        }
        "inbox" if !tail.is_empty() && !tail.contains('/') && anchor.is_none() => {
            Some(Locator::Inbox {
                file_id: tail.to_owned(),
            })
        }
        "plan" | "sessions" | "cost" | "activity" if tail.is_empty() && anchor.is_none() => {
            Some(match kind {
                "plan" => Locator::Plan,
                "sessions" => Locator::Sessions,
                "cost" => Locator::Cost,
                _ => Locator::Activity,
            })
        }
        _ => None,
    }
}

fn anchor_suffix(line: Option<u32>, line_end: Option<u32>) -> String {
    match (line, line_end) {
        (Some(a), Some(b)) => format!("#L{a}-L{b}"),
        (Some(a), None) => format!("#L{a}"),
        _ => String::new(),
    }
}

/// Render a locator back to its URI. The half the client never had: without it a
/// resource can be read from text but never named in it, so "copy a link to this" was
/// impossible.
pub fn format(locator: &Locator) -> String {
    match locator {
        Locator::Desk {
            path,
            line,
            line_end,
        } => format!("{SCHEME}desk/{path}{}", anchor_suffix(*line, *line_end)),
        Locator::Ws {
            bot,
            path,
            line,
            line_end,
        } => format!("{SCHEME}ws/{bot}/{path}{}", anchor_suffix(*line, *line_end)),
        Locator::Msg { message_id } => format!("{SCHEME}msg/{message_id}"),
        Locator::Inbox { file_id } => format!("{SCHEME}inbox/{file_id}"),
        Locator::Plan => format!("{SCHEME}plan"),
        Locator::Sessions => format!("{SCHEME}sessions"),
        Locator::Cost => format!("{SCHEME}cost"),
        Locator::Activity => format!("{SCHEME}activity"),
    }
}

/// Why a locator names something real but cannot be turned into a read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unresolvable {
    /// `cheers:msg/<id>` addresses a message by id, and no read resource takes one —
    /// `channel.messages.by-seq` takes a seq window. Resolving would mean either a DB
    /// lookup inside what is otherwise a pure translation, or changing a shipped,
    /// agent-writable format. Navigation still works: the client jumps by id without
    /// needing a read verb at all.
    MessageIdHasNoReadResource,
    /// `cheers:ws/<bot>/<path>` names a file on a bot's machine, and three things a
    /// locator cannot carry are needed to read one:
    ///
    /// - the **browse root** the path is relative to. The same relative path under two
    ///   roots is two different files, so a reference without it can resolve the wrong
    ///   one.
    /// - a bot **id**. A locator's `<bot>` may be `@handle`, which only resolves against
    ///   the channel's member list — a lookup, not a translation.
    /// - the **channel**, which `workspace.read` needs and a bare bot/path pair lacks.
    ///
    /// Navigation is unaffected: the client resolves the handle against members it
    /// already has and probes for the file before jumping. This says only that the
    /// Gateway cannot turn one into a read on its own.
    WorkspacePathNeedsMoreThanALocator,
}

/// Translate a locator into the `{resource, params}` a caller could have sent directly.
///
/// This is the whole safety argument for accepting URIs at the Gateway: the output is
/// exactly a call that was already expressible and already authorized. Resolution adds
/// no reach — every handler still runs its own authorization on these params — so a URI
/// can never open a path a verb call could not. Keep it a PURE function of
/// (locator, channel) for that reason: the moment it queries anything, that argument
/// needs re-making.
pub fn resolve(locator: &Locator, channel_id: &str) -> Result<(&'static str, Value), Unresolvable> {
    let lines = |line: &Option<u32>, line_end: &Option<u32>| -> Value {
        match (line, line_end) {
            (Some(a), Some(b)) => json!({ "start_line": a, "end_line": b }),
            (Some(a), None) => json!({ "start_line": a, "end_line": a }),
            _ => json!({}),
        }
    };
    let merge = |base: Value, extra: Value| -> Value {
        let mut map = base.as_object().cloned().unwrap_or_default();
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                map.insert(k.clone(), v.clone());
            }
        }
        Value::Object(map)
    };

    Ok(match locator {
        Locator::Desk {
            path,
            line,
            line_end,
        } => (
            "fs.read",
            merge(
                json!({ "channel_id": channel_id, "path": path }),
                lines(line, line_end),
            ),
        ),
        Locator::Inbox { file_id } => (
            "channel.files.read",
            json!({ "channel_id": channel_id, "file_id": file_id }),
        ),
        Locator::Plan => ("channel.plan.read", json!({ "channel_id": channel_id })),
        Locator::Sessions => ("channel.sessions.read", json!({ "channel_id": channel_id })),
        Locator::Cost => ("channel.usage.read", json!({ "channel_id": channel_id })),
        Locator::Activity => ("channel.activity.read", json!({ "channel_id": channel_id })),
        Locator::Msg { .. } => return Err(Unresolvable::MessageIdHasNoReadResource),
        Locator::Ws { .. } => return Err(Unresolvable::WorkspacePathNeedsMoreThanALocator),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CH: &str = "c-1";

    fn round_trip(uri: &str) {
        let parsed = parse(uri).unwrap_or_else(|| panic!("{uri} should parse"));
        assert_eq!(format(&parsed), uri, "{uri} should survive a round trip");
    }

    #[test]
    fn every_kind_survives_a_round_trip() {
        // format() is the half the client never had; a kind that parses but renders
        // differently would make "copy link" produce something nobody can read back.
        for uri in [
            "cheers:desk/notes.md",
            "cheers:desk/dev/plan.yaml#L3",
            "cheers:desk/dev/plan.yaml#L3-L9",
            "cheers:ws/@claude/src/main.rs",
            "cheers:ws/bot-7/src/main.rs#L12",
            "cheers:msg/abc-123",
            "cheers:inbox/file-9",
            "cheers:plan",
            "cheers:sessions",
            "cheers:cost",
            "cheers:activity",
        ] {
            round_trip(uri);
        }
    }

    #[test]
    fn a_reversed_range_is_swapped_not_rejected() {
        // Strict on shape, tolerant on intent: L9-L3 names the same lines as L3-L9.
        assert_eq!(
            parse("cheers:desk/a.md#L9-L3"),
            parse("cheers:desk/a.md#L3-L9")
        );
    }

    #[test]
    fn traversal_never_survives_parsing() {
        for uri in [
            "cheers:desk/../etc/passwd",
            "cheers:desk//etc/passwd",
            "cheers:desk/a/./b",
            "cheers:desk/a\\b",
            "cheers:ws/@bot/../x",
        ] {
            assert!(parse(uri).is_none(), "{uri} must not parse");
        }
    }

    #[test]
    fn malformed_shapes_are_rejected() {
        for uri in [
            "desk/a.md",            // no scheme
            "cheers:",              // no kind
            "cheers:desk",          // kind that needs a tail, without one
            "cheers:desk/",         // empty tail
            "cheers:nope/a",        // unknown kind
            "cheers:msg/a/b",       // a message id has no path
            "cheers:msg/a#L1",      // nor an anchor
            "cheers:plan/x",        // a channel projection takes no tail
            "cheers:plan#L1",       // nor an anchor
            "cheers:desk/a.md#top", // a fragment that is not a line anchor
            "cheers:desk/a.md#L0",  // lines are 1-indexed
            "cheers:ws/@/x",        // an empty handle
            "cheers:ws/bot",        // a workspace path is required
            "cheers:desk/a b.md",   // whitespace: locators are single tokens
        ] {
            assert!(parse(uri).is_none(), "{uri} must not parse");
        }
    }

    #[test]
    fn an_overlong_locator_is_rejected_before_anything_else() {
        let uri = format!("cheers:desk/{}", "a".repeat(MAX_LOCATOR_LENGTH));
        assert!(parse(&uri).is_none());
    }

    #[test]
    fn the_other_meanings_of_the_scheme_are_not_locators() {
        // `cheers:` is crowded — OAuth scopes, the resource guide, the desktop callback,
        // a task-claim namespace string, a LiveKit identity. None is a locator, and the
        // shapes make that true rather than the convention hoping for it. If a future
        // kind made one of these parse, the collision would be silent and this is the
        // only place it would be caught.
        for uri in [
            crate::SCOPE_READ,
            crate::SCOPE_MESSAGES_WRITE,
            crate::SCOPE_TASK_CLAIMS_WRITE,
            crate::RESOURCE_GUIDE_URI,
            "cheers://channel/c-1/plan",
            "cheers://channel/c-1/desk/notes.md",
            "cheers://auth/callback",
            "cheers:task-claim:11111111-2222-3333-4444-555555555555",
            "cheers:sess-1:user-2:nonce-3",
        ] {
            assert!(parse(uri).is_none(), "{uri} must not parse as a locator");
        }
    }

    #[test]
    fn resolution_yields_a_call_that_was_already_expressible() {
        let (resource, params) =
            resolve(&parse("cheers:desk/dev/plan.yaml#L3-L9").unwrap(), CH).expect("desk resolves");
        assert_eq!(resource, "fs.read");
        assert_eq!(params["channel_id"], CH);
        assert_eq!(params["path"], "dev/plan.yaml");
        assert_eq!(params["start_line"], 3);
        assert_eq!(params["end_line"], 9);
    }

    #[test]
    fn a_single_line_anchor_resolves_to_a_one_line_window() {
        let (_, params) = resolve(&parse("cheers:desk/a.md#L7").unwrap(), CH).unwrap();
        assert_eq!(params["start_line"], 7);
        assert_eq!(params["end_line"], 7);
    }

    #[test]
    fn channel_projections_resolve_to_their_verbs() {
        for (uri, expected) in [
            ("cheers:plan", "channel.plan.read"),
            ("cheers:sessions", "channel.sessions.read"),
            ("cheers:cost", "channel.usage.read"),
            ("cheers:activity", "channel.activity.read"),
            ("cheers:inbox/f-1", "channel.files.read"),
        ] {
            let (resource, params) = resolve(&parse(uri).unwrap(), CH).unwrap();
            assert_eq!(resource, expected, "{uri}");
            assert_eq!(params["channel_id"], CH, "{uri}");
        }
    }

    #[test]
    fn a_message_locator_names_something_real_that_cannot_be_read() {
        // Deliberate, not an oversight: no read resource takes a message id. Returning
        // an error keeps `resolve` a pure translation instead of smuggling a DB lookup
        // into it, and keeps the shipped `cheers:msg/<id>` format working for the thing
        // it already does — navigation.
        assert_eq!(
            resolve(&parse("cheers:msg/abc").unwrap(), CH),
            Err(Unresolvable::MessageIdHasNoReadResource)
        );
    }

    /// The shared grammar declaration. Both parsers assert against this file, so a rule
    /// changed on one side fails the other side's build — the pattern `fixtures/workbench`
    /// already uses for the extension grammar, and for the same reason: two hand-written
    /// parsers of one format drift, and nothing fails until someone's locator silently
    /// stops working.
    const CORPUS: &str = include_str!("../../../fixtures/locator/corpus.json");

    #[test]
    fn agrees_with_the_shared_corpus() {
        let corpus: Value = serde_json::from_str(CORPUS).expect("corpus is valid JSON");
        let cases = corpus["cases"].as_array().expect("corpus has cases");
        assert!(!cases.is_empty());

        for case in cases {
            let uri = case["uri"].as_str().expect("case has a uri");
            let why = case["why"].as_str().unwrap_or("");
            let parsed = parse(uri);

            if !case["parses"].as_bool().expect("case declares parses") {
                assert!(parsed.is_none(), "{uri} must not parse — {why}");
                continue;
            }
            let parsed = parsed.unwrap_or_else(|| panic!("{uri} must parse — {why}"));

            // Rendering must produce a locator that reads back identically. NOT equality
            // with the input: parsing is deliberately tolerant, so `#L9-L3` canonicalizes
            // to `#L3-L9`. What must hold is that the canonical form is stable, or a
            // rendered link could parse to a different resource than the one it names.
            let rendered = format(&parsed);
            assert_eq!(
                parse(&rendered),
                Some(parsed.clone()),
                "{uri} -> {rendered}"
            );

            if let Some(kind) = case.get("unresolvable").and_then(|v| v.as_str()) {
                assert_eq!(
                    resolve(&parsed, CH).unwrap_err(),
                    match kind {
                        "MessageIdHasNoReadResource" => Unresolvable::MessageIdHasNoReadResource,
                        "WorkspacePathNeedsMoreThanALocator" => {
                            Unresolvable::WorkspacePathNeedsMoreThanALocator
                        }
                        other => panic!("{uri}: unknown unresolvable `{other}`"),
                    },
                    "{uri} — {why}"
                );
                continue;
            }

            let (resource, params) =
                resolve(&parsed, CH).unwrap_or_else(|_| panic!("{uri} should resolve — {why}"));
            assert_eq!(resource, case["resource"], "{uri} — {why}");
            assert_eq!(params, case["params"], "{uri} — {why}");
        }
    }

    #[test]
    fn the_locator_tool_grants_no_more_than_the_tools_it_stands_in_for() {
        // Why `read_locator` can sit at SCOPE_READ. Every resource a locator resolves to
        // is already exposed by a read-only tool at that same scope, so the tool is a
        // different SPELLING of calls a client already holds — not new reach.
        //
        // That is a fact about the catalog, not a judgment, which is why it belongs in a
        // test: a future kind that resolves to something with a stronger scope — or to a
        // resource with no tool at all, the subtler failure — would silently hand a read
        // token more than it should have. It fails here instead.
        let tool = crate::registry::by_tool("read_locator")
            .and_then(|spec| spec.tool)
            .expect("read_locator is declared");
        assert_eq!(tool.scope, crate::SCOPE_READ);
        assert!(tool.read_only, "a locator only ever reads");

        for locator in [
            Locator::Desk {
                path: "a.md".into(),
                line: None,
                line_end: None,
            },
            Locator::Inbox {
                file_id: "f".into(),
            },
            Locator::Plan,
            Locator::Sessions,
            Locator::Cost,
            Locator::Activity,
        ] {
            let (resource, _) = resolve(&locator, CH).expect("resolves");
            let spec = crate::registry::by_resource(resource)
                .unwrap_or_else(|| panic!("{resource} is not in the catalog"));
            let stood_in_for = spec.tool.unwrap_or_else(|| {
                panic!(
                    "{resource} has no tool, so read_locator would be the only way to \
                        reach it — that is new reach, not a new spelling"
                )
            });
            assert_eq!(
                stood_in_for.scope, tool.scope,
                "{resource} needs {} but read_locator only asks for {}",
                stood_in_for.scope, tool.scope
            );
            assert!(stood_in_for.read_only, "{resource} is not read-only");
        }
    }

    #[test]
    fn every_resolvable_locator_names_a_catalog_resource() {
        // The reason this module lives in this crate. A locator that resolved to a
        // resource the catalog does not declare would be a fifth hand-maintained copy of
        // the vocabulary, and nothing would fail until an Agent called it.
        //
        // Checked against the CATALOG, not `routed_resources()`: `workspace.read` is a
        // declared resource the Gateway deliberately does not route, because the owner
        // Bot's Connector answers it.
        for locator in [
            Locator::Desk {
                path: "a.md".into(),
                line: None,
                line_end: None,
            },
            Locator::Inbox {
                file_id: "f".into(),
            },
            Locator::Plan,
            Locator::Sessions,
            Locator::Cost,
            Locator::Activity,
        ] {
            let (resource, _) = resolve(&locator, CH).expect("resolves");
            assert!(
                crate::registry::by_resource(resource).is_some(),
                "{resource} is not declared in the registry catalog"
            );
        }
    }
}
