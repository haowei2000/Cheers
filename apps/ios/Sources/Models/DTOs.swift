import Foundation

// MARK: - Opaque JSON value (for `content_data` and WS payload passthrough)

enum JSONValue: Codable, Equatable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .number(let n): try container.encode(n)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var numberValue: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    /// First non-empty string among the given keys (for `command ?? cmd`-style fallbacks).
    func firstString(_ keys: String...) -> String? {
        for key in keys {
            if let s = self[key]?.stringValue, !s.isEmpty { return s }
        }
        return nil
    }
}

// MARK: - Auth (server/src/api/auth.rs)

struct LoginRequest: Encodable {
    let login: String
    let password: String
}

struct LoginResponse: Codable {
    let accessToken: String
    let tokenType: String
    let userId: String
    let displayName: String?
    let role: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case userId = "user_id"
        case displayName = "display_name"
        case role
    }
}

struct OkResponse: Decodable {
    let ok: Bool
}

// MARK: - Workspaces (server/src/api/workspaces.rs)

struct WorkspaceDto: Decodable, Identifiable, Hashable {
    let workspaceId: String
    let name: String
    let avatarUrl: String?
    let defaultBotId: String?
    let kind: String

    var id: String { workspaceId }

    enum CodingKeys: String, CodingKey {
        case workspaceId = "workspace_id"
        case name
        case avatarUrl = "avatar_url"
        case defaultBotId = "default_bot_id"
        case kind
    }
}

// MARK: - Channels (server/src/api/channels.rs)

struct ChannelDto: Decodable, Identifiable, Hashable {
    let channelId: String
    let workspaceId: String?
    let name: String
    /// serde: struct field `channel_type` is renamed to "type".
    let channelType: String
    let purpose: String?
    let autoAssist: Bool?
    let allowMemberInvites: Bool?
    let allowBotAdds: Bool?
    let unreadCount: Int?
    /// Only present on GET /channels/dm rows.
    let peerName: String?

    var id: String { channelId }
    var isDM: Bool { channelType == "dm" }
    var displayName: String {
        if isDM, let peerName, !peerName.isEmpty { return peerName }
        return name
    }

    enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case workspaceId = "workspace_id"
        case name
        case channelType = "type"
        case purpose
        case autoAssist = "auto_assist"
        case allowMemberInvites = "allow_member_invites"
        case allowBotAdds = "allow_bot_adds"
        case unreadCount = "unread_count"
        case peerName = "peer_name"
    }
}

struct ChannelMemberDto: Decodable, Identifiable, Hashable {
    let memberId: String
    let memberType: String
    let role: String?
    let username: String?
    let displayName: String?
    let avatarUrl: String?
    let isOnline: Bool?
    let canReceiveAudio: Bool?

    var id: String { memberId }
    var name: String {
        if let displayName, !displayName.isEmpty { return displayName }
        return username ?? memberId
    }

    enum CodingKeys: String, CodingKey {
        case memberId = "member_id"
        case memberType = "member_type"
        case role
        case username
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
        case isOnline = "is_online"
        case canReceiveAudio = "can_receive_audio"
    }
}

// MARK: - Messages (server/src/infra/db/models.rs → MessageDto)

struct MessageMention: Codable, Hashable {
    let memberId: String
    let memberType: String
    let username: String?
    let displayName: String?

    enum CodingKeys: String, CodingKey {
        case memberId = "member_id"
        case memberType = "member_type"
        case username
        case displayName = "display_name"
    }
}

struct MessageFileRef: Codable, Hashable, Identifiable {
    let fileId: String
    let originalFilename: String?
    let contentType: String?
    let sizeBytes: Int64?
    let status: String?
    let expiresAt: String?
    let previewUrl: String?
    let downloadUrl: String?
    let summary: String?

    var id: String { fileId }

    enum CodingKeys: String, CodingKey {
        case fileId = "file_id"
        case originalFilename = "original_filename"
        case contentType = "content_type"
        case sizeBytes = "size_bytes"
        case status
        case expiresAt = "expires_at"
        case previewUrl = "preview_url"
        case downloadUrl = "download_url"
        case summary
    }
}

struct MessageDto: Decodable, Identifiable, Hashable {
    var v: Int?
    var msgId: String
    var channelId: String
    var channelSeq: Int64?
    var depth: Int?
    var senderType: String
    var senderId: String?
    var senderName: String?
    var content: String
    var msgType: String?
    var isPartial: Bool?
    var replyToMsgId: String?
    var fileIds: [String]?
    var mentions: [MessageMention]?
    var files: [MessageFileRef]?
    /// RFC3339; absent on `message_done` WS frames.
    var createdAt: String?
    /// Present for approval/system cards; omitted when null server-side.
    var contentData: JSONValue?

    var id: String { msgId }
    var createdDate: Date? { TimeFormat.parse(createdAt) }
    var isBot: Bool { senderType == "bot" }

    enum CodingKeys: String, CodingKey {
        case v
        case msgId = "msg_id"
        case channelId = "channel_id"
        case channelSeq = "channel_seq"
        case depth
        case senderType = "sender_type"
        case senderId = "sender_id"
        case senderName = "sender_name"
        case content
        case msgType = "msg_type"
        case isPartial = "is_partial"
        case replyToMsgId = "reply_to_msg_id"
        case fileIds = "file_ids"
        case mentions
        case files
        case createdAt = "created_at"
        case contentData = "content_data"
    }
}

struct ListMessagesMeta: Decodable {
    let hasMoreBefore: Bool?
    let hasMoreAfter: Bool?
    let hasMore: Bool?
    let anchorFound: Bool?
    let limit: Int?

    enum CodingKeys: String, CodingKey {
        case hasMoreBefore = "has_more_before"
        case hasMoreAfter = "has_more_after"
        case hasMore = "has_more"
        case anchorFound = "anchor_found"
        case limit
    }
}

struct ListMessagesResponse: Decodable {
    let messages: [MessageDto]
    let count: Int?
    let meta: ListMessagesMeta?
}

struct SendMessageRequest: Encodable {
    let content: String
    var msgType: String? = nil
    var replyToMsgId: String? = nil
    var fileIds: [String]? = nil
    var mentionIds: [String]? = nil
    var sessionId: String? = nil

    enum CodingKeys: String, CodingKey {
        case content
        case msgType = "msg_type"
        case replyToMsgId = "reply_to_msg_id"
        case fileIds = "file_ids"
        case mentionIds = "mention_ids"
        case sessionId = "session_id"
    }
}

// MARK: - Notifications / invites (server/src/api/notifications.rs)

struct NotificationDto: Decodable, Identifiable {
    /// "workspace_invite" | "channel_invite".
    let kind: String
    let workspaceId: String
    let channelId: String?
    let title: String
    let invitedBy: String?
    let invitedAt: String?
    let role: String

    var id: String { "\(kind):\(channelId ?? workspaceId)" }
    var isChannelInvite: Bool { kind == "channel_invite" }

    enum CodingKeys: String, CodingKey {
        case kind, title, role
        case workspaceId = "workspace_id"
        case channelId = "channel_id"
        case invitedBy = "invited_by"
        case invitedAt = "invited_at"
    }
}

// MARK: - Bots / agents (server/src/api/bots.rs)

struct BotDto: Decodable, Identifiable {
    let botId: String
    let username: String?
    let displayName: String?
    let avatarUrl: String?
    let description: String?
    let isDisabled: Bool?
    let isOnline: Bool?
    let canManage: Bool?
    let statusText: String?
    let statusEmoji: String?
    /// Which ACP agent this bot was registered for. Onboarding must read it
    /// rather than re-defaulting, or it mints a config for the wrong adapter.
    let bridgeProvider: String?

    var id: String { botId }
    var name: String { displayName ?? username ?? "Agent" }
    var online: Bool { isOnline ?? false }
    var agentType: AgentType { AgentType(rawValue: bridgeProvider ?? "") ?? .generic }

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case username
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
        case description
        case isDisabled = "is_disabled"
        case isOnline = "is_online"
        case canManage = "can_manage"
        case statusText = "status_text"
        case statusEmoji = "status_emoji"
        case bridgeProvider = "bridge_provider"
    }
}

// MARK: - Bot onboarding (server/src/api/enrollment.rs)
//
// iOS can never host a connector — there is no way to run a long-lived ACP
// child process on the phone. So the phone's job is to CREATE the bot and hand
// a credential to whatever machine will actually run it. Everything below is
// about that hand-off; nothing here starts an agent locally.

enum AgentType: String, CaseIterable, Identifiable, Codable {
    case claude, codex, opencode, generic

    var id: String { rawValue }

    var label: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .opencode: return "OpenCode"
        case .generic: return "Other ACP agent"
        }
    }

    /// The adapter the gateway will name in the generated config — shown so the
    /// user can tell whether they have it installed on the target machine.
    var adapterHint: String {
        switch self {
        case .claude: return "claude-agent-acp"
        case .codex: return "codex-acp"
        case .opencode: return "opencode acp"
        case .generic: return "your own ACP binary"
        }
    }
}

struct CreateBotRequest: Encodable {
    let username: String
    let displayName: String?
    let bridgeProvider: String

    enum CodingKeys: String, CodingKey {
        case username
        case displayName = "display_name"
        case bridgeProvider = "bridge_provider"
    }
}

struct ReachabilityDto: Decodable {
    let publicBase: String?
    let configured: Bool?

    var isConfigured: Bool { configured ?? false }

    enum CodingKeys: String, CodingKey {
        case publicBase = "public_base"
        case configured
    }
}

/// One-time enrollment code. Single-use, TTL-bounded, and the *only* credential
/// safe to move between devices — it rotates the bot token on redemption, so a
/// leaked code costs one bot rather than an account.
struct EnrollmentCodeDto: Decodable {
    let code: String
    let botId: String
    let agentType: String?
    let expiresAt: String?
    let ttlSecs: Int?
    let controlUrl: String?
    let reachability: ReachabilityDto?
    let liveCodes: Int?

    enum CodingKeys: String, CodingKey {
        case code
        case botId = "bot_id"
        case agentType = "agent_type"
        case expiresAt = "expires_at"
        case ttlSecs = "ttl_secs"
        case controlUrl = "control_url"
        case reachability
        case liveCodes = "live_codes"
    }
}

/// Manual-mode config. The token is referenced by sidecar path, never inlined —
/// issue it separately so the config itself stays safe to share.
struct ConnectorConfigDto: Decodable {
    let botId: String
    let accountId: String
    let agentType: String?
    let tokenFile: String?
    let configToml: String
    let reachability: ReachabilityDto?

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case accountId = "account_id"
        case agentType = "agent_type"
        case tokenFile = "token_file"
        case configToml = "config_toml"
        case reachability
    }
}

struct IssuedTokenDto: Decodable {
    let botId: String
    let token: String
    let tokenPrefix: String?

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case token
        case tokenPrefix = "token_prefix"
    }
}

/// Prompt template for "let your agent connect itself". The server never sees
/// the code in a GET — the client substitutes `codePlaceholder` locally.
struct EnrollmentGuidanceDto: Decodable {
    let installUrl: String
    let promptTemplate: String
    let codePlaceholder: String

    enum CodingKeys: String, CodingKey {
        case installUrl = "install_url"
        case promptTemplate = "prompt_template"
        case codePlaceholder = "code_placeholder"
    }
}

struct ConnectorDiscoveryDto: Decodable {
    let publicBase: String?
    let configured: Bool?
    let hint: String?

    var isConfigured: Bool { configured ?? false }

    enum CodingKeys: String, CodingKey {
        case publicBase = "public_base"
        case configured
        case hint
    }
}

/// Live connectivity, used to answer "did the setup actually work?" — the phone
/// polls this because the user's half of the job happens on another machine.
struct BotStatusDto: Decodable {
    let botId: String
    let isDisabled: Bool?
    let isOnline: Bool?
    let bridgeConnected: Bool?
    let liveEnrollmentCodes: Int?

    var connected: Bool { bridgeConnected ?? isOnline ?? false }

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case isDisabled = "is_disabled"
        case isOnline = "is_online"
        case bridgeConnected = "bridge_connected"
        case liveEnrollmentCodes = "live_enrollment_codes"
    }
}


// MARK: - Sessions & bot settings (server/src/api/session_control.rs)

struct SessionInfo: Decodable, Identifiable {
    let sessionId: String
    let role: String?
    let isPrimary: Bool?
    let status: String?

    var id: String { sessionId }
    var tag: String { role ?? String(sessionId.prefix(6)) }

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case role
        case isPrimary = "is_primary"
        case status
    }
}

struct SessionListResponse: Decodable { let sessions: [SessionInfo] }

struct ConfigChoice: Decodable, Identifiable {
    let value: String
    let name: String?
    var id: String { value }
}

struct ConfigOption: Decodable, Identifiable {
    let optionId: String
    let name: String?
    let currentValue: String?
    let options: [ConfigChoice]?

    var id: String { optionId }
    var isModel: Bool { optionId.lowercased().contains("model") }

    enum CodingKeys: String, CodingKey {
        case optionId = "id"
        case name
        case currentValue = "current_value"
        case options
    }
}

struct SessionControls: Decodable {
    let canSetMode: Bool?
    let canSetConfigOption: Bool?
    let allowedModes: [String]?
    let currentMode: String?
    let configOptions: [ConfigOption]?

    enum CodingKeys: String, CodingKey {
        case canSetMode = "can_set_mode"
        case canSetConfigOption = "can_set_config_option"
        case allowedModes = "allowed_modes"
        case currentMode = "current_mode"
        case configOptions = "config_options"
    }
}

struct SetConfigOptionRequest: Encodable {
    let configId: String
    let value: String
    enum CodingKeys: String, CodingKey {
        case configId = "config_id"
        case value
    }
}

// MARK: - Permission audit (ViewBoard Audit board — server/src/api/approval.rs)

struct AuditEvent: Decodable, Identifiable {
    let eventType: String
    let botId: String?
    let requestId: String?
    let actorId: String?
    let targetUserId: String?
    let decision: String?
    let createdAt: String?

    var id: String { "\(requestId ?? "")\(eventType)\(createdAt ?? "")" }

    enum CodingKeys: String, CodingKey {
        case eventType = "event_type"
        case botId = "bot_id"
        case requestId = "request_id"
        case actorId = "actor_id"
        case targetUserId = "target_user_id"
        case decision
        case createdAt = "created_at"
    }
}

struct AuditResponse: Decodable {
    let events: [AuditEvent]
}

// MARK: - Create channel / DM (server/src/api/channels.rs)

struct ChannelCreateRequest: Encodable {
    let workspaceId: String
    let name: String
    let type: String          // "public" | "private"
    var purpose: String? = nil

    enum CodingKeys: String, CodingKey {
        case workspaceId = "workspace_id"
        case name, type, purpose
    }
}

struct DmCreateRequest: Encodable {
    var targetUserId: String? = nil
    var targetBotId: String? = nil

    enum CodingKeys: String, CodingKey {
        case targetUserId = "target_user_id"
        case targetBotId = "target_bot_id"
    }
}

// MARK: - Errors (server/src/errors.rs → { "detail": ... })

struct ApiErrorBody: Decodable {
    let detail: String
}
