//! The mapping template language.
//!
//! Deliberately boring, per issue #570: field interpolation, a `length` helper,
//! and a conditional. No loops, no expressions, no user-supplied code. The
//! moment a mapping needs real logic that is the signal it belongs in an
//! out-of-process connector, not a signal to grow this.
//!
//! # Why interpolated values are escaped
//!
//! A template's literal text is written by whoever authored the integration. Its
//! *values* come from a third-party webhook payload — a commit message, a branch
//! name, a pull-request title. Anyone who can open a PR against a public repo
//! can choose that text.
//!
//! Message bodies are markdown-rendered in the web client (`MessageItem.tsx`
//! switches to `MarkdownRenderer` as soon as the content contains a `#`, `*`,
//! `[`, backtick, or newline — and a template as ordinary as `PR #{{number}}`
//! already contains `#`). So an unescaped title of
//! `[Approved by admin](https://evil.example)` renders as a link inside a
//! message the reader trusts because it came from their GitHub integration.
//! That is the risk this module exists to close.
//!
//! Two things follow, and they are the whole reason [`escape_value`] looks the
//! way it does:
//!
//! - **Newlines are flattened.** That removes every block-level construct —
//!   headings, lists, quotes, fences — which is why the escape set below only
//!   needs to cover *inline* punctuation and can leave `-`, `+`, `.` and `!`
//!   alone.
//! - **Values are length-capped**, so one 40KB commit message cannot become a
//!   40KB channel message.
//!
//! Flat tokens (`<#file:id>`) are a separate matter and are not a capability
//! leak: attachments come from the `file_ids` column and mentions from
//! `message_mentions`, so a forged token in a body grants nothing — the web
//! client merely strips it from display, hiding some of the attacker's own text.
//! Any human typing in the composer can do the same thing, so it is a property
//! of the message model rather than something this module introduces. `<` and
//! `>` are escaped anyway, since they cost nothing here.

use serde_json::Value;

/// Longest interpolated value, in characters.
const MAX_VALUE_CHARS: usize = 300;
/// Longest rendered message, in characters. A safety net for a template that
/// interpolates many fields.
pub const MAX_RENDERED_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Helper {
    /// `{{commits.length}}` — array length, object key count, or string length.
    Length,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Literal(String),
    Field {
        path: Vec<String>,
        helper: Option<Helper>,
    },
    /// `{{#if a.b}}…{{else}}…{{/if}}`. Truthiness is JSON-shaped: `false`,
    /// `null`, `0`, `""`, `[]`, `{}` and a missing path are all falsy.
    If {
        path: Vec<String>,
        then_branch: Vec<Node>,
        else_branch: Vec<Node>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    /// `{{` with no closing `}}`.
    Unterminated,
    /// An empty or malformed `{{ }}`.
    BadExpression(String),
    /// `{{/if}}` or `{{else}}` with no open `{{#if}}`.
    DanglingClose(String),
    /// `{{#if}}` never closed.
    UnclosedIf,
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unterminated => write!(f, "unterminated {{{{"),
            Self::BadExpression(expr) => write!(f, "bad expression {{{{{expr}}}}}"),
            Self::DanglingClose(tag) => write!(f, "{{{{{tag}}}}} without a matching {{{{#if}}}}"),
            Self::UnclosedIf => write!(f, "{{{{#if}}}} was never closed"),
        }
    }
}

impl std::error::Error for TemplateError {}

/// What one render produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub text: String,
    /// Paths the payload did not contain. A missing field renders as empty
    /// rather than failing the whole mapping — a push message missing its
    /// commit count still beats no message — but the operator needs to see it,
    /// so it is reported rather than swallowed.
    pub missing: Vec<String>,
    /// Set when the result hit [`MAX_RENDERED_CHARS`].
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    nodes: Vec<Node>,
}

/// One `{{…}}` occurrence, already classified.
enum Token {
    Literal(String),
    Expr(String),
}

fn tokenize(source: &str) -> Result<Vec<Token>, TemplateError> {
    let mut tokens = Vec::new();
    let mut rest = source;
    while let Some(open) = rest.find("{{") {
        if open > 0 {
            tokens.push(Token::Literal(rest[..open].to_string()));
        }
        let after = &rest[open + 2..];
        let close = after.find("}}").ok_or(TemplateError::Unterminated)?;
        tokens.push(Token::Expr(after[..close].trim().to_string()));
        rest = &after[close + 2..];
    }
    if !rest.is_empty() {
        tokens.push(Token::Literal(rest.to_string()));
    }
    Ok(tokens)
}

/// A path segment is an identifier or an array index — nothing else.
///
/// This is what makes an unsupported construct *fail* instead of half-working.
/// Without it `{{commits.0.message | upper}}` parses cleanly as a lookup of a
/// key literally named `message | upper`, which no payload has, so the template
/// silently renders empty and the author has no idea the filter did nothing.
/// Rejecting the segment turns that into a startup-time error in the catalog's
/// own test.
fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn parse_path(expr: &str) -> Result<(Vec<String>, Option<Helper>), TemplateError> {
    let mut parts: Vec<String> = expr
        .split('.')
        .map(|part| part.trim().to_string())
        .collect();
    let helper = if parts.last().map(String::as_str) == Some("length") && parts.len() > 1 {
        parts.pop();
        Some(Helper::Length)
    } else {
        None
    };
    if parts.is_empty() || !parts.iter().all(|part| valid_segment(part)) {
        return Err(TemplateError::BadExpression(expr.to_string()));
    }
    Ok((parts, helper))
}

impl Template {
    pub fn parse(source: &str) -> Result<Self, TemplateError> {
        let tokens = tokenize(source)?;
        let mut cursor = tokens.into_iter().peekable();
        let (nodes, terminator) = parse_nodes(&mut cursor, false)?;
        if let Some(tag) = terminator {
            return Err(TemplateError::DanglingClose(tag));
        }
        Ok(Self { nodes })
    }

    pub fn render(&self, payload: &Value) -> Rendered {
        let mut out = String::new();
        let mut missing = Vec::new();
        render_nodes(&self.nodes, payload, &mut out, &mut missing);
        let truncated = out.chars().count() > MAX_RENDERED_CHARS;
        if truncated {
            out = out.chars().take(MAX_RENDERED_CHARS).collect::<String>() + "…";
        }
        Rendered {
            text: out,
            missing,
            truncated,
        }
    }

    /// Every field path the template reads, for validating a mapping against a
    /// sample payload without rendering it.
    pub fn paths(&self) -> Vec<String> {
        fn walk(nodes: &[Node], out: &mut Vec<String>) {
            for node in nodes {
                match node {
                    Node::Literal(_) => {}
                    Node::Field { path, .. } => out.push(path.join(".")),
                    Node::If {
                        path,
                        then_branch,
                        else_branch,
                    } => {
                        out.push(path.join("."));
                        walk(then_branch, out);
                        walk(else_branch, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.nodes, &mut out);
        out
    }
}

/// Parse until end of input, or — when `inside_if` — until `{{else}}` or
/// `{{/if}}`, returning which one stopped it.
fn parse_nodes(
    cursor: &mut std::iter::Peekable<std::vec::IntoIter<Token>>,
    inside_if: bool,
) -> Result<(Vec<Node>, Option<String>), TemplateError> {
    let mut nodes = Vec::new();
    while let Some(token) = cursor.next() {
        match token {
            Token::Literal(text) => nodes.push(Node::Literal(text)),
            Token::Expr(expr) => {
                if expr == "else" || expr == "/if" {
                    if !inside_if {
                        return Err(TemplateError::DanglingClose(expr));
                    }
                    return Ok((nodes, Some(expr)));
                }
                if let Some(condition) = expr.strip_prefix("#if ") {
                    let (path, _) = parse_path(condition.trim())?;
                    let (then_branch, stopped) = parse_nodes(cursor, true)?;
                    let else_branch = match stopped.as_deref() {
                        Some("else") => {
                            let (branch, stopped) = parse_nodes(cursor, true)?;
                            if stopped.as_deref() != Some("/if") {
                                return Err(TemplateError::UnclosedIf);
                            }
                            branch
                        }
                        Some("/if") => Vec::new(),
                        _ => return Err(TemplateError::UnclosedIf),
                    };
                    nodes.push(Node::If {
                        path,
                        then_branch,
                        else_branch,
                    });
                    continue;
                }
                if expr.starts_with('#') || expr.is_empty() {
                    return Err(TemplateError::BadExpression(expr));
                }
                let (path, helper) = parse_path(&expr)?;
                nodes.push(Node::Field { path, helper });
            }
        }
    }
    if inside_if {
        return Err(TemplateError::UnclosedIf);
    }
    Ok((nodes, None))
}

/// Walk a dotted path. `None` when any segment is absent.
///
/// An all-digits segment indexes an array, so `{{commits.0.message}}` — the
/// first thing anyone writes when they want the newest commit — works instead of
/// resolving to nothing. That is not a loop, and it is deliberately as far as
/// this goes: reaching for every element is the signal a mapping belongs in a
/// connector.
pub fn lookup<'a>(payload: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut current = payload;
    for key in path {
        current = match (current, key.parse::<usize>()) {
            (Value::Array(items), Ok(index)) => items.get(index)?,
            _ => current.get(key)?,
        };
    }
    Some(current)
}

/// JSON-shaped truthiness, shared with the mapper's `require` / `skip_when`
/// gates so a declaration's conditionals and its gates agree on what "empty"
/// means.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

fn render_nodes(nodes: &[Node], payload: &Value, out: &mut String, missing: &mut Vec<String>) {
    for node in nodes {
        match node {
            Node::Literal(text) => out.push_str(text),
            Node::Field { path, helper } => {
                let value = lookup(payload, path);
                if value.is_none() {
                    missing.push(path.join("."));
                }
                out.push_str(&escape_value(&stringify(value, helper.as_ref())));
            }
            Node::If {
                path,
                then_branch,
                else_branch,
            } => {
                let branch = if truthy(lookup(payload, path)) {
                    then_branch
                } else {
                    else_branch
                };
                render_nodes(branch, payload, out, missing);
            }
        }
    }
}

fn stringify(value: Option<&Value>, helper: Option<&Helper>) -> String {
    let Some(value) = value else {
        // A missing path under `length` is 0, not empty: "pushed  commits"
        // reads as a bug where "pushed 0 commits" reads as a fact.
        return match helper {
            Some(Helper::Length) => "0".to_string(),
            None => String::new(),
        };
    };
    match helper {
        Some(Helper::Length) => match value {
            Value::Array(items) => items.len().to_string(),
            Value::Object(map) => map.len().to_string(),
            Value::String(text) => text.chars().count().to_string(),
            _ => "0".to_string(),
        },
        None => match value {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        },
    }
}

/// Neutralise markdown structure in a payload-supplied value.
///
/// Newlines collapse to spaces first, which is what lets the escape set stay
/// inline-only — with no line starts left, `-`, `+`, `.` and `!` cannot begin a
/// list, heading, or quote, so they are left readable.
pub fn escape_value(value: &str) -> String {
    let flattened: String = value
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let capped: String = if flattened.chars().count() > MAX_VALUE_CHARS {
        flattened.chars().take(MAX_VALUE_CHARS).collect::<String>() + "…"
    } else {
        flattened
    };

    let mut out = String::with_capacity(capped.len());
    let mut last_was_space = false;
    for ch in capped.chars() {
        // Collapse the runs of spaces that flattening just created.
        if ch == ' ' {
            if !last_was_space {
                out.push(' ');
            }
            last_was_space = true;
            continue;
        }
        last_was_space = false;
        if matches!(
            ch,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '~' | '|'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn render(source: &str, payload: serde_json::Value) -> String {
        Template::parse(source)
            .expect("parses")
            .render(&payload)
            .text
    }

    #[test]
    fn interpolates_a_nested_field() {
        assert_eq!(
            render(
                "{{pusher.name}} pushed to {{ref}}",
                json!({
                    "pusher": {"name": "haowei"},
                    "ref": "refs/heads/develop",
                })
            ),
            "haowei pushed to refs/heads/develop"
        );
    }

    #[test]
    fn length_counts_arrays_objects_and_strings() {
        assert_eq!(render("{{c.length}}", json!({"c": [1, 2, 3]})), "3");
        assert_eq!(render("{{c.length}}", json!({"c": {"a": 1, "b": 2}})), "2");
        assert_eq!(render("{{c.length}}", json!({"c": "abcd"})), "4");
    }

    #[test]
    fn a_missing_length_is_zero_not_blank() {
        // "pushed  commits" reads as a bug; "pushed 0 commits" reads as a fact.
        assert_eq!(
            render("pushed {{commits.length}} commits", json!({})),
            "pushed 0 commits"
        );
    }

    #[test]
    fn a_missing_field_is_reported_not_swallowed() {
        let rendered = Template::parse("{{a.b}} and {{c}}")
            .unwrap()
            .render(&json!({"c": "here"}));
        assert_eq!(rendered.text, " and here");
        assert_eq!(rendered.missing, vec!["a.b".to_string()]);
    }

    #[test]
    fn conditionals_pick_a_branch_by_json_truthiness() {
        let source = "{{name}}{{#if prerelease}} (prerelease){{/if}}";
        assert_eq!(
            render(source, json!({"name": "v2", "prerelease": true})),
            "v2 (prerelease)"
        );
        assert_eq!(
            render(source, json!({"name": "v2", "prerelease": false})),
            "v2"
        );
        // Absent, empty string, empty array, and zero are all falsy.
        assert_eq!(render(source, json!({"name": "v2"})), "v2");
        assert_eq!(
            render(source, json!({"name": "v2", "prerelease": ""})),
            "v2"
        );
        assert_eq!(
            render(source, json!({"name": "v2", "prerelease": []})),
            "v2"
        );
        assert_eq!(render(source, json!({"name": "v2", "prerelease": 0})), "v2");
    }

    #[test]
    fn conditionals_take_an_else_branch() {
        let source = "{{#if merged}}merged{{else}}closed{{/if}}";
        assert_eq!(render(source, json!({"merged": true})), "merged");
        assert_eq!(render(source, json!({"merged": false})), "closed");
    }

    #[test]
    fn conditionals_nest() {
        let source = "{{#if a}}A{{#if b}}B{{else}}b{{/if}}{{else}}x{{/if}}";
        assert_eq!(render(source, json!({"a": true, "b": true})), "AB");
        assert_eq!(render(source, json!({"a": true, "b": false})), "Ab");
        assert_eq!(render(source, json!({"a": false, "b": true})), "x");
    }

    #[test]
    fn malformed_templates_are_rejected_at_parse_time() {
        assert_eq!(
            Template::parse("{{a").unwrap_err(),
            TemplateError::Unterminated
        );
        assert_eq!(
            Template::parse("{{}}").unwrap_err(),
            TemplateError::BadExpression(String::new())
        );
        assert_eq!(
            Template::parse("{{a..b}}").unwrap_err(),
            TemplateError::BadExpression("a..b".into())
        );
        assert_eq!(
            Template::parse("{{/if}}").unwrap_err(),
            TemplateError::DanglingClose("/if".into())
        );
        assert_eq!(
            Template::parse("{{else}}").unwrap_err(),
            TemplateError::DanglingClose("else".into())
        );
        assert_eq!(
            Template::parse("{{#if a}}x").unwrap_err(),
            TemplateError::UnclosedIf
        );
        // An unknown block helper is not silently treated as a field path.
        assert!(matches!(
            Template::parse("{{#each items}}{{/each}}").unwrap_err(),
            TemplateError::BadExpression(_)
        ));
    }

    #[test]
    fn there_is_no_loop_and_no_expression_syntax() {
        // Issue #570 fixes the language at field / length / conditional. These
        // are the shapes a contributor reaches for first when the language is
        // not enough, and each must fail loudly rather than half-work — a
        // half-working loop is how a template language starts growing.
        for source in [
            "{{#each commits}}{{message}}{{/each}}",
            "{{#unless draft}}x{{/unless}}",
            "{{commits.0.message | upper}}",
        ] {
            assert!(
                Template::parse(source).is_err(),
                "{source} parsed but must not"
            );
        }
    }

    #[test]
    fn a_payload_value_cannot_forge_a_markdown_link() {
        // The attack: anyone who can open a PR chooses its title. Unescaped,
        // this renders as a link inside a message the reader trusts because it
        // came from their GitHub integration.
        let rendered = render(
            "PR #{{number}}: {{title}}",
            json!({"number": 7, "title": "[Approved by admin](https://evil.example)"}),
        );
        // `](` still appears — the closing bracket is escaped, the paren needs
        // no escape — so the assertion has to be the real invariant: every
        // bracket carries a backslash, which is what stops commonmark reading
        // the run as a link.
        for (index, ch) in rendered.char_indices() {
            if ch == '[' || ch == ']' {
                assert_eq!(
                    rendered[..index].chars().next_back(),
                    Some('\\'),
                    "unescaped {ch} at {index} in {rendered}"
                );
            }
        }
        assert_eq!(
            rendered,
            "PR #7: \\[Approved by admin\\](https://evil.example)"
        );
    }

    #[test]
    fn a_numeric_segment_indexes_an_array() {
        // The natural way to reach the newest commit. Before path segments were
        // validated this silently rendered empty.
        assert_eq!(
            render(
                "{{commits.0.message}}",
                json!({"commits": [{"message": "first"}, {"message": "second"}]})
            ),
            "first"
        );
        assert_eq!(
            render(
                "{{commits.9.message}}",
                json!({"commits": [{"message": "x"}]})
            ),
            ""
        );
    }

    #[test]
    fn a_payload_value_cannot_forge_emphasis_or_code() {
        let rendered = render("{{t}}", json!({"t": "**URGENT** `sudo rm -rf /`"}));
        assert_eq!(rendered, "\\*\\*URGENT\\*\\* \\`sudo rm -rf /\\`");
    }

    #[test]
    fn a_payload_value_cannot_inject_a_flat_token() {
        let rendered = render("{{t}}", json!({"t": "see <#file:secret-id>"}));
        assert_eq!(rendered, "see \\<#file:secret-id\\>");
    }

    #[test]
    fn newlines_are_flattened_so_no_block_construct_can_form() {
        // A multi-line commit message must not be able to open a heading, list,
        // or fence on a line of its own. This is what lets the escape set stay
        // inline-only.
        let rendered = render(
            "{{msg}}",
            json!({"msg": "fix thing\n\n# Deploy approved\n- by admin\n```\ncode\n```"}),
        );
        assert!(!rendered.contains('\n'), "newline survived: {rendered:?}");
        assert_eq!(
            rendered,
            "fix thing # Deploy approved - by admin \\`\\`\\` code \\`\\`\\`"
        );
    }

    #[test]
    fn carriage_returns_and_other_controls_are_flattened_too() {
        // `\r` alone is a line break to some renderers, and a NUL or tab has no
        // business in a message body. `is_control` covers them all without
        // enumerating them.
        let rendered = render("{{t}}", json!({"t": "a\rb\u{0}c\td"}));
        assert_eq!(rendered, "a b c d");
    }

    #[test]
    fn one_value_cannot_blow_up_the_message_size() {
        let huge = "x".repeat(5000);
        let rendered = render("{{t}}", json!({"t": huge}));
        assert_eq!(rendered.chars().count(), MAX_VALUE_CHARS + 1); // + the ellipsis
        assert!(rendered.ends_with('…'));
    }

    #[test]
    fn a_whole_message_is_capped_even_when_each_value_fits() {
        let source = "{{a}}{{a}}{{a}}{{a}}{{a}}{{a}}{{a}}{{a}}";
        let value = "y".repeat(MAX_VALUE_CHARS);
        let rendered = Template::parse(source)
            .unwrap()
            .render(&json!({"a": value}));
        assert!(rendered.truncated);
        assert_eq!(rendered.text.chars().count(), MAX_RENDERED_CHARS + 1);
    }

    #[test]
    fn non_string_scalars_render_without_json_quoting() {
        assert_eq!(
            render("{{n}} {{b}}", json!({"n": 42, "b": true})),
            "42 true"
        );
    }

    #[test]
    fn paths_lists_every_field_the_template_reads() {
        let template = Template::parse("{{a}}{{#if b.c}}{{d.length}}{{else}}{{e}}{{/if}}").unwrap();
        assert_eq!(template.paths(), vec!["a", "b.c", "d", "e"]);
    }

    #[test]
    fn escaping_leaves_already_safe_text_alone() {
        assert_eq!(
            escape_value("ordinary commit message"),
            "ordinary commit message"
        );
        assert_eq!(
            escape_value("fix: handle 3 - 4 items!"),
            "fix: handle 3 - 4 items!"
        );
    }
}
