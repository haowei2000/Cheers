use percent_encoding::percent_decode_str;
use serde_json::{json, Map, Value};
use url::Url;

pub mod interactive;
pub mod locator;
pub mod registry;
pub mod tools;

pub const RESOURCE_GUIDE_URI: &str = "cheers://help/resources";

pub const SCOPE_READ: &str = "cheers:read";
pub const SCOPE_MESSAGES_WRITE: &str = "cheers:messages:write";
pub const SCOPE_FILES_WRITE: &str = "cheers:files:write";
pub const SCOPE_WORKSPACE_WRITE: &str = "cheers:workspace:write";
pub const SCOPE_PROFILE_WRITE: &str = "cheers:profile:write";
pub const SCOPE_MEMBERSHIP_WRITE: &str = "cheers:membership:write";
pub const SCOPE_TASK_CLAIMS_WRITE: &str = "cheers:task-claims:write";

pub const ALL_OAUTH_SCOPES: &[&str] = &[
    SCOPE_READ,
    SCOPE_MESSAGES_WRITE,
    SCOPE_FILES_WRITE,
    SCOPE_WORKSPACE_WRITE,
    SCOPE_PROFILE_WRITE,
    SCOPE_MEMBERSHIP_WRITE,
    SCOPE_TASK_CLAIMS_WRITE,
];

/// Frozen MCP 2026-07-28 v1 scope for a public Cheers tool name.
///
/// Derived from [`registry::catalog`] — the scope lives beside the tool it
/// guards, so a new tool cannot be added without one.
///
/// `inbox_stage` is deliberately excluded: it refers to a terminal-local path
/// and cannot be routed safely until remote calls are host-bound.
pub fn required_scope_for_tool(name: &str) -> Option<&'static str> {
    registry::by_tool(name)
        .and_then(|spec| spec.tool)
        .map(|t| t.scope)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResourceCall {
    pub resource: &'static str,
    pub params: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceUriError {
    pub code: &'static str,
    pub message: String,
}

pub fn resource_definitions() -> Vec<Value> {
    let mut resources = vec![json!({
        "uri": RESOURCE_GUIDE_URI,
        "name": "Cheers resource guide",
        "title": "Cheers resource guide",
        "description": "Available channel resource URI templates and their permission boundary.",
        "mimeType": "text/markdown"
    })];
    for (uri, title, mime) in [
        (
            interactive::GUIDE_URI,
            "Interactive UI authoring guide",
            "text/markdown",
        ),
        (
            interactive::CATALOG_URI,
            "Cheers A2UI component catalog",
            "application/json",
        ),
        (
            interactive::EXAMPLE_URI,
            "Interactive resource example",
            "application/json",
        ),
    ] {
        resources.push(json!({"uri":uri,"name":title,"title":title,"mimeType":mime}));
    }
    resources
}

pub fn resource_template_definitions() -> Vec<Value> {
    [
        (
            "cheers://channel/{channel_id}/info",
            "Channel information",
            "Channel metadata and membership count.",
        ),
        (
            "cheers://channel/{channel_id}/members",
            "Channel members",
            "Users and agents in the channel.",
        ),
        (
            "cheers://channel/{channel_id}/messages{?limit,since_seq,before,after}",
            "Channel messages",
            "Finalized channel messages with cursor-based pagination.",
        ),
        (
            "cheers://channel/{channel_id}/context",
            "Channel context",
            "Condensed channel context bundle.",
        ),
        (
            "cheers://channel/{channel_id}/plan",
            "Channel plan",
            "Live plan and progress board.",
        ),
        (
            "cheers://channel/{channel_id}/sessions",
            "Agent sessions",
            "Agent sessions active in the channel.",
        ),
        (
            "cheers://channel/{channel_id}/usage",
            "Channel usage",
            "Token usage and cost totals.",
        ),
        (
            "cheers://channel/{channel_id}/artifacts{?limit,before,include_internal}",
            "Channel artifacts",
            "Documents, pages, canvases and delivered files with availability and stable IDs.",
        ),
        (
            "cheers://channel/{channel_id}/artifacts/{artifact_id}{?as_base64}",
            "Artifact content",
            "Read one available artifact, optionally returning binary content as base64.",
        ),
        (
            "cheers://channel/{channel_id}/artifacts/{artifact_id}/metadata",
            "Artifact metadata",
            "Inspect identity, version and availability, including deleted or expired artifacts.",
        ),
        (
            "cheers://channel/{channel_id}/desk/{+path}",
            "Legacy source file",
            "Path-based source/configuration access. Prefer artifact IDs for channel outputs.",
        ),
    ]
    .into_iter()
    .map(|(uri_template, name, description)| {
        json!({
            "uriTemplate": uri_template,
            "name": name,
            "title": name,
            "description": description
        })
    })
    .collect()
}

pub fn resource_help_text() -> &'static str {
    "# Cheers MCP resources\n\nUse `resources/templates/list` to discover channel URI templates. Artifacts list documents, pages, canvases and delivered files together. Use `/artifacts/{artifact_id}/metadata` to inspect availability and version, and `/artifacts/{artifact_id}` to read content. These channel-qualified MCP resource URIs address the same artifact IDs as `cheers:artifact/<id>` links in channel messages. Legacy `/files` and `/desk` URIs remain readable for existing clients. Every channel resource is authorized by the gateway against the connected bot's channel membership and role. A URI never grants access by itself.\n"
}

pub fn build_uri_resource_call(uri: &str) -> Result<ResourceCall, ResourceUriError> {
    if uri.len() > 4096 {
        return Err(uri_error("resource URI exceeds the 4096-byte limit"));
    }
    let parsed =
        Url::parse(uri).map_err(|err| uri_error(format!("invalid resource URI: {err}")))?;
    if parsed.scheme() != "cheers" || parsed.host_str() != Some("channel") {
        return Err(ResourceUriError {
            code: "UNSUPPORTED_URI",
            message: "resource URI must start with cheers://channel/".to_string(),
        });
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
    {
        return Err(uri_error(
            "resource URI must not contain userinfo, a port, or a fragment",
        ));
    }

    let segments = parsed
        .path_segments()
        .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() < 2 {
        return Err(uri_error(
            "resource URI requires a channel id and resource name",
        ));
    }

    let mut params = Map::new();
    params.insert(
        "channel_id".to_string(),
        Value::String(segments[0].to_string()),
    );
    let resource = match segments[1] {
        "info" if segments.len() == 2 => no_query(&parsed, "channel.info")?,
        "members" if segments.len() == 2 => no_query(&parsed, "channel.members")?,
        "messages" if segments.len() == 2 => {
            copy_message_query(&parsed, &mut params)?;
            "channel.messages"
        }
        "context" if segments.len() == 2 => no_query(&parsed, "channel.context")?,
        "plan" if segments.len() == 2 => no_query(&parsed, "channel.plan.read")?,
        "sessions" if segments.len() == 2 => no_query(&parsed, "channel.sessions.read")?,
        "usage" if segments.len() == 2 => no_query(&parsed, "channel.usage.read")?,
        "artifacts" if segments.len() == 2 => {
            for (name, value) in parsed.query_pairs() {
                reject_duplicate(&params, &name)?;
                let value = match name.as_ref() {
                    "limit" => {
                        let limit = value
                            .parse::<i64>()
                            .map_err(|_| uri_error("limit must be an integer"))?;
                        if !(1..=200).contains(&limit) {
                            return Err(uri_error("limit must be between 1 and 200"));
                        }
                        json!(limit)
                    }
                    "before" => Value::String(value.into_owned()),
                    "include_internal" => json!(value
                        .parse::<bool>()
                        .map_err(|_| uri_error("include_internal must be true or false"))?),
                    _ => return Err(uri_error(format!("unknown query parameter: {name}"))),
                };
                params.insert(name.into_owned(), value);
            }
            "channel.artifacts.list"
        }
        "artifacts"
            if segments.len() == 3 || (segments.len() == 4 && segments[3] == "metadata") =>
        {
            params.insert("artifact_id".into(), json!(segments[2]));
            if segments.len() == 4 {
                no_query(&parsed, "channel.artifacts.get")?
            } else {
                copy_file_query(&parsed, &mut params)?;
                "channel.artifacts.read"
            }
        }
        "files" if segments.len() == 2 => no_query(&parsed, "channel.files")?,
        "files" if segments.len() == 3 => {
            params.insert(
                "file_id".to_string(),
                Value::String(segments[2].to_string()),
            );
            copy_file_query(&parsed, &mut params)?;
            "channel.files.read"
        }
        "desk" if segments.len() >= 3 => {
            no_query(&parsed, "fs.read")?;
            let encoded_path = segments[2..].join("/");
            let path = percent_decode_str(&encoded_path)
                .decode_utf8()
                .map_err(|_| uri_error("desk path is not valid UTF-8"))?;
            params.insert("path".to_string(), Value::String(path.into_owned()));
            "fs.read"
        }
        _ => {
            return Err(ResourceUriError {
                code: "UNSUPPORTED_URI",
                message: format!("unsupported Cheers resource URI: {uri}"),
            })
        }
    };
    Ok(ResourceCall { resource, params })
}

pub fn resource_content(uri: &str, data: &Value) -> Value {
    let supplied = data.get("content_type").and_then(Value::as_str);
    if let Some(blob) = data.get("data_b64").and_then(Value::as_str) {
        return json!({
            "uri": uri,
            "mimeType": safe_mime(supplied.unwrap_or("application/octet-stream"), true),
            "blob": blob
        });
    }
    if let Some(text) = data.get("content").and_then(Value::as_str) {
        return json!({
            "uri": uri,
            "mimeType": safe_mime(supplied.unwrap_or("text/plain"), false),
            "text": text
        });
    }
    json!({
        "uri": uri,
        "mimeType": "application/json",
        "text": serde_json::to_string_pretty(data).unwrap_or_else(|_| data.to_string())
    })
}

fn no_query(uri: &Url, resource: &'static str) -> Result<&'static str, ResourceUriError> {
    if uri.query().is_some() {
        return Err(uri_error(
            "this resource URI does not accept query parameters",
        ));
    }
    Ok(resource)
}

fn copy_message_query(uri: &Url, params: &mut Map<String, Value>) -> Result<(), ResourceUriError> {
    for (name, value) in uri.query_pairs() {
        reject_duplicate(params, &name)?;
        match name.as_ref() {
            "limit" | "since_seq" => {
                let number = value
                    .parse::<i64>()
                    .map_err(|_| uri_error(format!("query parameter {name} must be an integer")))?;
                if number < 0 || (name == "limit" && !(1..=200).contains(&number)) {
                    return Err(uri_error(format!("query parameter {name} is out of range")));
                }
                params.insert(name.into_owned(), Value::Number(number.into()));
            }
            "before" | "after" => {
                params.insert(name.into_owned(), Value::String(value.into_owned()));
            }
            _ => return Err(uri_error(format!("unknown query parameter: {name}"))),
        }
    }
    if params.contains_key("before") && params.contains_key("after") {
        return Err(uri_error("before and after are mutually exclusive"));
    }
    Ok(())
}

fn copy_file_query(uri: &Url, params: &mut Map<String, Value>) -> Result<(), ResourceUriError> {
    for (name, value) in uri.query_pairs() {
        if name != "as_base64" {
            return Err(uri_error(format!("unknown query parameter: {name}")));
        }
        reject_duplicate(params, &name)?;
        let boolean = value
            .parse::<bool>()
            .map_err(|_| uri_error("query parameter as_base64 must be true or false"))?;
        params.insert(name.into_owned(), Value::Bool(boolean));
    }
    Ok(())
}

fn reject_duplicate(params: &Map<String, Value>, name: &str) -> Result<(), ResourceUriError> {
    if params.contains_key(name) {
        return Err(uri_error(format!("duplicate query parameter: {name}")));
    }
    Ok(())
}

fn uri_error(message: impl Into<String>) -> ResourceUriError {
    ResourceUriError {
        code: "INVALID_URI",
        message: message.into(),
    }
}

fn safe_mime(supplied: &str, binary: bool) -> &'static str {
    let normalized = supplied
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if binary {
        return match normalized.as_str() {
            "image/png" => "image/png",
            "image/jpeg" | "image/jpg" => "image/jpeg",
            "image/gif" => "image/gif",
            "image/webp" => "image/webp",
            "audio/mpeg" => "audio/mpeg",
            "audio/ogg" => "audio/ogg",
            "audio/wav" | "audio/x-wav" => "audio/wav",
            _ => "application/octet-stream",
        };
    }
    match normalized.as_str() {
        "text/plain" => "text/plain",
        "text/markdown" => "text/markdown",
        "text/csv" => "text/csv",
        "application/json" => "application/json",
        _ => "text/plain",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn artifact_resource_uris_use_canonical_contracts_and_strict_queries() {
        let list = super::build_uri_resource_call(
            "cheers://channel/c/artifacts?limit=50&before=cursor&include_internal=true",
        )
        .unwrap();
        assert_eq!(list.resource, "channel.artifacts.list");
        assert_eq!(list.params["channel_id"], "c");
        assert_eq!(list.params["limit"], 50);
        assert_eq!(list.params["before"], "cursor");
        assert_eq!(list.params["include_internal"], true);
        let read = super::build_uri_resource_call("cheers://channel/c/artifacts/a?as_base64=true")
            .unwrap();
        assert_eq!(read.resource, "channel.artifacts.read");
        assert_eq!(read.params["artifact_id"], "a");
        assert_eq!(read.params["as_base64"], true);
        assert_eq!(
            super::build_uri_resource_call("cheers://channel/c/artifacts/a/metadata")
                .unwrap()
                .resource,
            "channel.artifacts.get"
        );
        for suffix in [
            "?limit=0",
            "?limit=201",
            "?limit=x",
            "?limit=1&limit=2",
            "?channel_id=other",
            "?include_internal=1",
            "/a/metadata?as_base64=true",
            "/a?as_base64=true&as_base64=false",
            "/a/unknown",
        ] {
            assert!(
                super::build_uri_resource_call(&format!("cheers://channel/c/artifacts{suffix}"))
                    .is_err(),
                "{suffix}"
            );
        }
        // Already issued source URLs keep their original addressing semantics.
        assert_eq!(
            super::build_uri_resource_call("cheers://channel/c/files/f")
                .unwrap()
                .resource,
            "channel.files.read"
        );
        assert_eq!(
            super::build_uri_resource_call("cheers://channel/c/desk/a.md")
                .unwrap()
                .resource,
            "fs.read"
        );
        let templates = super::resource_template_definitions();
        assert!(!templates
            .iter()
            .any(|v| v["uriTemplate"].as_str().unwrap().contains("/files")));
    }

    /// The scope table as it was hand-written before the registry, plus every tool added
    /// since. Kept as a test fixture so the registry migration is provably behaviour-
    /// preserving; it is not reachable from production code.
    ///
    /// It has outgrown that original purpose and is now the better one: a second,
    /// deliberate statement of each tool's scope. A new tool cannot be added without
    /// writing its scope down twice, in two files, which is the point — the scope is the
    /// one thing about a tool that must never be decided by accident.
    fn frozen_scope_table(name: &str) -> Option<&'static str> {
        match name {
            "get_channel_info" | "list_members" | "read_messages" | "messages_index"
            | "messages_by_seq" | "search_messages" | "read_activity" | "get_context"
            | "read_plan" | "read_sessions" | "read_cost" | "inbox_list" | "inbox_open"
            | "desk_list" | "desk_read" | "read_workspace" | "list_task_claims"
            // Resolves a cheers: URI. SCOPE_READ grants nothing the tools above did not
            // already: every resource a locator can name is one of them. Asserted by
            // locator::tests::the_locator_tool_grants_no_more_than_the_tools_it_stands_in_for.
            | "read_ui_contract" | "read_locator" | "artifact_list" | "artifact_get" | "artifact_read" => Some(SCOPE_READ),

            "post_message" | "set_suggested_questions" | "set_resource_cards" => Some(SCOPE_MESSAGES_WRITE),
            "inbox_deliver" | "artifact_deliver" => Some(SCOPE_FILES_WRITE),
            "artifact_create" | "artifact_update" | "desk_write"
            | "desk_edit"
            | "desk_append"
            | "desk_rm"
            | "desk_mv"
            // Asks for the approval desk_rm / desk_mv need; same scope as them.
            | "request_approval"
            | "report_code_workspace" => Some(SCOPE_WORKSPACE_WRITE),
            "set_status" => Some(SCOPE_PROFILE_WRITE),
            "leave_channel" | "open_direct_message" => Some(SCOPE_MEMBERSHIP_WRITE),
            "respond_to_task_claim_evaluation" => Some(SCOPE_TASK_CLAIMS_WRITE),
            _ => None,
        }
    }

    #[test]
    fn registry_reproduces_the_frozen_scope_table_exactly() {
        for tool in registry::catalog().iter().filter_map(|s| s.tool) {
            assert_eq!(
                Some(tool.scope),
                frozen_scope_table(tool.name),
                "registry changed the frozen scope for {}",
                tool.name
            );
        }
        // inbox_stage is deliberately absent from both.
        assert_eq!(frozen_scope_table("inbox_stage"), None);
        assert_eq!(required_scope_for_tool("inbox_stage"), None);
    }

    use super::*;

    #[test]
    fn maps_messages_and_rejects_ambiguous_queries() {
        let call =
            build_uri_resource_call("cheers://channel/c/messages?limit=25&since_seq=8&after=m7")
                .unwrap();
        assert_eq!(call.resource, "channel.messages");
        assert_eq!(call.params["limit"], json!(25));
        assert!(build_uri_resource_call("cheers://channel/c/messages?before=m1&after=m2").is_err());
        assert!(build_uri_resource_call("cheers://channel/c/messages?limit=1&limit=2").is_err());
    }

    #[test]
    fn rejects_authority_confusion_and_active_mime() {
        assert!(build_uri_resource_call("cheers://user@channel/c/info").is_err());
        assert!(build_uri_resource_call("cheers://channel:9/c/info").is_err());
        let html = resource_content(
            "cheers://channel/c/files/f",
            &json!({"content_type":"text/html", "content":"<script/>"}),
        );
        assert_eq!(html["mimeType"], "text/plain");
    }

    #[test]
    fn frozen_tool_scope_contract_has_no_unscoped_remote_write() {
        assert_eq!(
            required_scope_for_tool("post_message"),
            Some(SCOPE_MESSAGES_WRITE)
        );
        assert_eq!(
            required_scope_for_tool("desk_rm"),
            Some(SCOPE_WORKSPACE_WRITE)
        );
        assert_eq!(required_scope_for_tool("read_messages"), Some(SCOPE_READ));
        assert_eq!(required_scope_for_tool("inbox_stage"), None);
        assert_eq!(required_scope_for_tool("unknown"), None);
    }

    #[test]
    fn frozen_oauth_scopes_are_unique() {
        let unique = ALL_OAUTH_SCOPES
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), ALL_OAUTH_SCOPES.len());
    }
}
