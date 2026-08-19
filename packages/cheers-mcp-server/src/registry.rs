//! The single declaration of the resource vocabulary.
//!
//! Before this module the same vocabulary was hand-maintained in four places
//! across two crates: the Gateway's `resource::dispatch` match, this crate's
//! `tools::definitions`, `tools::build_resource_call`, and
//! `required_scope_for_tool`. They drifted — a resource could exist with no
//! tool, a tool could name a resource the Gateway never routed, and nothing
//! failed until an Agent called it.
//!
//! Everything is now derived from [`catalog`]. Adding a resource means adding
//! one [`ResourceSpec`]; the tool schema, the scope, the argument mapping, and
//! the Gateway's routing check all follow from it, and tests in both crates
//! fail if any consumer falls out of sync.

use crate::{
    SCOPE_FILES_WRITE, SCOPE_MEMBERSHIP_WRITE, SCOPE_MESSAGES_WRITE, SCOPE_PROFILE_WRITE,
    SCOPE_READ, SCOPE_TASK_CLAIMS_WRITE, SCOPE_WORKSPACE_WRITE,
};

/// JSON Schema type of one tool argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamKind {
    String,
    Integer,
    Boolean,
    Number,
    /// `array` of `string` — the only array shape any tool takes.
    StringArray,
}

impl ParamKind {
    pub fn json_type(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Integer => "integer",
            Self::Boolean => "boolean",
            Self::Number => "number",
            Self::StringArray => "array",
        }
    }
}

/// One tool argument and where it lands in the resource params.
#[derive(Debug, Clone, Copy)]
pub struct Param {
    /// Name in the MCP tool input schema.
    pub tool: &'static str,
    /// Name in the `resource_req` params. Differs from `tool` where the two
    /// protocols disagree (`post_message.text` is `channel.messages.create`'s
    /// `content`).
    pub resource: &'static str,
    pub kind: ParamKind,
    pub required: bool,
}

impl Param {
    const fn req(tool: &'static str, kind: ParamKind) -> Self {
        Self {
            tool,
            resource: tool,
            kind,
            required: true,
        }
    }

    const fn opt(tool: &'static str, kind: ParamKind) -> Self {
        Self {
            tool,
            resource: tool,
            kind,
            required: false,
        }
    }

    const fn renamed(tool: &'static str, resource: &'static str, kind: ParamKind) -> Self {
        Self {
            tool,
            resource,
            kind,
            required: true,
        }
    }
}

/// Argument reshaping a flat rename cannot express.
///
/// Deliberately an enum of named cases rather than a template language: a
/// mapping that needs more than this belongs in an out-of-process connector,
/// not in a bigger expression evaluator here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shaping {
    None,
    /// `post_message`: a non-empty `context` array becomes
    /// `context_bundle: { items: [...] }`.
    ContextBundle,
}

/// How the Gateway reaches the handler for a resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Routing {
    /// Handled inside `resource::dispatch` against the database.
    Database,
    /// Intercepted before `dispatch` and brokered elsewhere (currently only
    /// `workspace.read`, which is answered by the owner Bot's live Connector).
    Brokered,
}

/// The MCP tool that exposes a resource. Not every resource has one — some are
/// reachable only over the browser WS path.
#[derive(Debug, Clone, Copy)]
pub struct ToolBinding {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub scope: &'static str,
    pub read_only: bool,
    /// MCP `destructiveHint`. Independent of [`ResourceSpec::destructive`],
    /// which is the Gateway's owner/admin gate: `fs.mv` is gated but not
    /// hinted, and `channel.leave` is hinted but not gated. Both values are
    /// frozen wire behaviour and must not be "harmonised".
    pub destructive_hint: bool,
    pub params: &'static [Param],
    /// Params inserted with a fixed value regardless of the caller's arguments.
    pub constants: &'static [(&'static str, &'static str)],
    pub shaping: Shaping,
}

#[derive(Debug, Clone, Copy)]
pub struct ResourceSpec {
    pub resource: &'static str,
    pub routing: Routing,
    /// Destructive operations are gated for the user path: `dispatch_user`
    /// requires owner/admin. This flag is what drives that gate.
    pub destructive: bool,
    pub tool: Option<ToolBinding>,
}

impl ResourceSpec {
    pub fn tool_name(&self) -> Option<&'static str> {
        self.tool.map(|t| t.name)
    }
}

const fn db(resource: &'static str, tool: Option<ToolBinding>) -> ResourceSpec {
    ResourceSpec {
        resource,
        routing: Routing::Database,
        destructive: false,
        tool,
    }
}

const fn destructive(resource: &'static str, tool: Option<ToolBinding>) -> ResourceSpec {
    ResourceSpec {
        resource,
        routing: Routing::Database,
        destructive: true,
        tool,
    }
}

const fn read_tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    params: &'static [Param],
) -> Option<ToolBinding> {
    Some(ToolBinding {
        name,
        title,
        description,
        scope: SCOPE_READ,
        read_only: true,
        destructive_hint: false,
        params,
        constants: &[],
        shaping: Shaping::None,
    })
}

const fn write_tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    scope: &'static str,
    params: &'static [Param],
) -> Option<ToolBinding> {
    Some(ToolBinding {
        name,
        title,
        description,
        scope,
        read_only: false,
        destructive_hint: false,
        params,
        constants: &[],
        shaping: Shaping::None,
    })
}

const CHANNEL_ONLY: &[Param] = &[Param::req("channel_id", ParamKind::String)];

/// The vocabulary.
///
/// Order is **frozen**: [`crate::tools::definitions`] projects this list in
/// sequence, and MCP clients display tools in the order the server sends them.
/// The tail holds resources with no tool, whose position is not observable.
pub fn catalog() -> &'static [ResourceSpec] {
    const CATALOG: &[ResourceSpec] = &[
        db(
            "channel.info",
            read_tool(
                "get_channel_info",
                "Get channel info",
                "Metadata for a channel.",
                CHANNEL_ONLY,
            ),
        ),
        db(
            "channel.members",
            read_tool(
                "list_members",
                "List channel members",
                "Users and Agents in a channel.",
                CHANNEL_ONLY,
            ),
        ),
        db(
            "channel.messages",
            read_tool(
                "read_messages",
                "Read recent messages",
                "Read channel messages by cursor.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::opt("limit", ParamKind::Integer),
                    Param::opt("before", ParamKind::String),
                    Param::opt("after", ParamKind::String),
                    Param::opt("since_seq", ParamKind::Integer),
                ],
            ),
        ),
        db(
            "channel.messages.index",
            read_tool(
                "messages_index",
                "Get message sequence index",
                "Get channel message sequence bounds.",
                CHANNEL_ONLY,
            ),
        ),
        db(
            "channel.messages.by-seq",
            read_tool(
                "messages_by_seq",
                "Read messages by channel sequence",
                "Read messages in a channel sequence range.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("min_seq", ParamKind::Integer),
                    Param::opt("max_seq", ParamKind::Integer),
                    Param::opt("limit", ParamKind::Integer),
                ],
            ),
        ),
        db(
            "channel.messages.search",
            read_tool(
                "search_messages",
                "Search channel messages",
                "Search finalized message content.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("query", ParamKind::String),
                    Param::opt("limit", ParamKind::Integer),
                    Param::opt("before", ParamKind::String),
                ],
            ),
        ),
        db(
            "channel.activity.read",
            read_tool(
                "read_activity",
                "Read channel activity",
                "Read the ordered channel activity stream.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::opt("since_seq", ParamKind::Integer),
                    Param::opt("limit", ParamKind::Integer),
                ],
            ),
        ),
        db(
            "channel.context",
            read_tool(
                "get_context",
                "Get channel context",
                "Read the condensed channel context.",
                CHANNEL_ONLY,
            ),
        ),
        db(
            "channel.plan.read",
            read_tool(
                "read_plan",
                "Read channel plan",
                "Read the live channel plan.",
                CHANNEL_ONLY,
            ),
        ),
        db(
            "channel.sessions.read",
            read_tool(
                "read_sessions",
                "List channel Agent sessions",
                "Read Agent sessions in a channel.",
                CHANNEL_ONLY,
            ),
        ),
        db(
            "channel.usage.read",
            read_tool(
                "read_cost",
                "Read channel usage",
                "Read token usage and cost totals.",
                CHANNEL_ONLY,
            ),
        ),
        ResourceSpec {
            resource: "channel.leave",
            routing: Routing::Database,
            // `leave_channel` carries destructiveHint: true in the MCP catalog,
            // but it is not an fs mutation and is not owner/admin gated.
            destructive: false,
            tool: Some(ToolBinding {
                name: "leave_channel",
                title: "Leave a channel",
                description: "Remove this Bot from a non-DM channel.",
                scope: SCOPE_MEMBERSHIP_WRITE,
                read_only: false,
                destructive_hint: true,
                params: CHANNEL_ONLY,
                constants: &[],
                shaping: Shaping::None,
            }),
        },
        db(
            "dm.open",
            write_tool(
                "open_direct_message",
                "Open a direct message",
                "Open an eligible one-to-one DM.",
                SCOPE_MEMBERSHIP_WRITE,
                &[Param::req("target_user_id", ParamKind::String)],
            ),
        ),
        db(
            "channel.files",
            read_tool(
                "inbox_list",
                "List channel attachments",
                "List files uploaded to channel chat.",
                CHANNEL_ONLY,
            ),
        ),
        db(
            "channel.files.read",
            read_tool(
                "inbox_open",
                "Open a channel attachment",
                "Read one channel attachment.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("file_id", ParamKind::String),
                    Param::opt("as_base64", ParamKind::Boolean),
                ],
            ),
        ),
        // Brokered through the owner Bot's live Connector, not the database.
        ResourceSpec {
            resource: "workspace.read",
            routing: Routing::Brokered,
            destructive: false,
            tool: read_tool(
                "read_workspace",
                "Read another Bot's workspace file",
                "Resolve a shared workspace reference through the owner Bot's live Connector.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("bot_id", ParamKind::String),
                    Param::req("path", ParamKind::String),
                    Param::opt("session_id", ParamKind::String),
                    Param::opt("root", ParamKind::String),
                ],
            ),
        },
        db(
            "channel.messages.create",
            Some(ToolBinding {
                name: "post_message",
                title: "Post a message",
                description: "Send or reply to a channel message.",
                scope: SCOPE_MESSAGES_WRITE,
                read_only: false,
                destructive_hint: false,
                params: &[
                    Param::req("channel_id", ParamKind::String),
                    Param::renamed("text", "content", ParamKind::String),
                    Param::opt("mention_ids", ParamKind::StringArray),
                    Param::opt("mention_names", ParamKind::StringArray),
                    Param::opt("reply_to_msg_id", ParamKind::String),
                    Param::opt("context", ParamKind::StringArray),
                ],
                constants: &[("msg_type", "text")],
                shaping: Shaping::ContextBundle,
            }),
        ),
        db(
            "bot.status.write",
            write_tool(
                "set_status",
                "Update Bot status",
                "Update this Bot's own status/profile card.",
                SCOPE_PROFILE_WRITE,
                &[
                    Param::opt("status_text", ParamKind::String),
                    Param::opt("status_emoji", ParamKind::String),
                    Param::opt("info", ParamKind::String),
                ],
            ),
        ),
        db(
            "channel.files.create",
            write_tool(
                "inbox_deliver",
                "Deliver a channel attachment",
                "Upload a base64-encoded attachment.",
                SCOPE_FILES_WRITE,
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("filename", ParamKind::String),
                    Param::req("data_b64", ParamKind::String),
                    Param::opt("content_type", ParamKind::String),
                ],
            ),
        ),
        db(
            "fs.ls",
            read_tool(
                "desk_list",
                "List Desk files",
                "List Cheers Desk files under a path.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::opt("path", ParamKind::String),
                ],
            ),
        ),
        db(
            "fs.read",
            read_tool(
                "desk_read",
                "Read a Desk file",
                "Read a Cheers Desk file.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("path", ParamKind::String),
                ],
            ),
        ),
        db(
            "fs.write",
            write_tool(
                "desk_write",
                "Write a Desk file",
                "Create or overwrite a Cheers Desk file.",
                SCOPE_WORKSPACE_WRITE,
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("path", ParamKind::String),
                    Param::req("content", ParamKind::String),
                    Param::opt("if_version", ParamKind::Integer),
                    Param::opt("is_dir", ParamKind::Boolean),
                ],
            ),
        ),
        db(
            "fs.edit",
            write_tool(
                "desk_edit",
                "Edit a Desk file",
                "Replace one exact string in a Desk file.",
                SCOPE_WORKSPACE_WRITE,
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("path", ParamKind::String),
                    Param::req("old_string", ParamKind::String),
                    Param::req("new_string", ParamKind::String),
                    Param::opt("if_version", ParamKind::Integer),
                ],
            ),
        ),
        db(
            "fs.append",
            write_tool(
                "desk_append",
                "Append to a Desk file",
                "Append text to a Desk file.",
                SCOPE_WORKSPACE_WRITE,
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("path", ParamKind::String),
                    Param::req("content", ParamKind::String),
                ],
            ),
        ),
        destructive(
            "fs.rm",
            Some(ToolBinding {
                name: "desk_rm",
                title: "Remove a Desk path",
                description: "Remove a Desk file or subtree.",
                scope: SCOPE_WORKSPACE_WRITE,
                read_only: false,
                destructive_hint: true,
                params: &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("path", ParamKind::String),
                    Param::opt("recursive", ParamKind::Boolean),
                ],
                constants: &[],
                shaping: Shaping::None,
            }),
        ),
        destructive(
            "fs.mv",
            write_tool(
                "desk_mv",
                "Move a Desk path",
                "Move or rename a Desk file or subtree.",
                SCOPE_WORKSPACE_WRITE,
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("from", ParamKind::String),
                    Param::req("to", ParamKind::String),
                ],
            ),
        ),
        db(
            "channel.task_claims.evaluate",
            write_tool(
                "respond_to_task_claim_evaluation",
                "Respond to a task evaluation",
                "Record this Bot's assigned task-claim decision.",
                SCOPE_TASK_CLAIMS_WRITE,
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::req("evaluation_id", ParamKind::String),
                    Param::req("decision", ParamKind::String),
                    Param::opt("confidence", ParamKind::Number),
                ],
            ),
        ),
        db(
            "channel.task_claims.list",
            read_tool(
                "list_task_claims",
                "List task claims",
                "List proactive task claims in a channel.",
                &[
                    Param::req("channel_id", ParamKind::String),
                    Param::opt("status", ParamKind::String),
                    Param::opt("limit", ParamKind::Integer),
                ],
            ),
        ),
        // Browser-WS only: no MCP tool is exposed for these.
        db("channel.voice.transcript", None),
        db("channel.voice.transcript.by-seq", None),
        db("channel.commands.read", None),
        // Browser-WS only.
        db("fs.patch", None),
    ];
    CATALOG
}

pub fn by_tool(name: &str) -> Option<&'static ResourceSpec> {
    catalog()
        .iter()
        .find(|spec| spec.tool_name() == Some(name).filter(|n| !n.is_empty()))
}

pub fn by_resource(name: &str) -> Option<&'static ResourceSpec> {
    catalog().iter().find(|spec| spec.resource == name)
}

/// Resources `resource::dispatch` must route. `workspace.read` is excluded —
/// it is intercepted upstream and never reaches the database dispatcher.
pub fn database_resources() -> impl Iterator<Item = &'static str> {
    catalog()
        .iter()
        .filter(|spec| spec.routing == Routing::Database)
        .map(|spec| spec.resource)
}

/// Resources gated behind owner/admin on the browser path.
pub fn destructive_resources() -> impl Iterator<Item = &'static str> {
    catalog()
        .iter()
        .filter(|spec| spec.destructive)
        .map(|spec| spec.resource)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn resource_names_are_unique() {
        let names: BTreeSet<_> = catalog().iter().map(|s| s.resource).collect();
        assert_eq!(names.len(), catalog().len(), "duplicate resource name");
    }

    #[test]
    fn tool_names_are_unique() {
        let tools: Vec<_> = catalog().iter().filter_map(|s| s.tool_name()).collect();
        let unique: BTreeSet<_> = tools.iter().copied().collect();
        assert_eq!(unique.len(), tools.len(), "duplicate tool name");
    }

    #[test]
    fn every_param_rename_is_deliberate() {
        // A rename is a protocol disagreement and should be rare. Freeze the
        // set so a new one is a conscious edit rather than a typo.
        let renames: Vec<_> = catalog()
            .iter()
            .filter_map(|s| s.tool)
            .flat_map(|t| t.params.iter())
            .filter(|p| p.tool != p.resource)
            .map(|p| (p.tool, p.resource))
            .collect();
        assert_eq!(renames, vec![("text", "content")]);
    }

    #[test]
    fn only_fs_mutations_are_destructive() {
        let names: Vec<_> = destructive_resources().collect();
        assert_eq!(names, vec!["fs.rm", "fs.mv"]);
    }

    #[test]
    fn brokered_resources_are_not_database_routed() {
        let db: BTreeSet<_> = database_resources().collect();
        assert!(!db.contains("workspace.read"));
        assert!(db.contains("channel.info"));
    }
}
