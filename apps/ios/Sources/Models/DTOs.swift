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

    subscript(index: Int) -> JSONValue? {
        if case .array(let a) = self, a.indices.contains(index) { return a[index] }
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

    /// Bridge an untyped resource-response payload into a typed DTO by
    /// round-tripping through JSON. Board reads arrive as `JSONValue`.
    func decode<T: Decodable>(as type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(type, from: data)
    }
}

// MARK: - Auth (server/src/api/auth.rs)

struct LoginRequest: Encodable {
    let login: String
    let password: String
    let client: String = "ios"
}

struct RefreshRequest: Encodable {
    let refreshToken: String
    enum CodingKeys: String, CodingKey { case refreshToken = "refresh_token" }
}

struct LoginResponse: Codable {
    let status: String?
    let transactionId: String?
    let allowedFactors: [String]?
    let requires2fa: Bool?
    let accessToken: String?
    let refreshToken: String?
    let expiresIn: Int?
    let tokenType: String?
    let userId: String?
    let username: String?
    let displayName: String?
    let role: String?

    var needsFactor: Bool {
        status == "factor_required" || requires2fa == true
    }

    enum CodingKeys: String, CodingKey {
        case status
        case transactionId = "transaction_id"
        case allowedFactors = "allowed_factors"
        case requires2fa = "requires_2fa"
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
        case tokenType = "token_type"
        case userId = "user_id"
        case username
        case displayName = "display_name"
        case role
    }
}

struct TwoFactorLoginRequest: Encodable {
    let transactionId: String
    let code: String
    let rememberDevice: Bool

    enum CodingKeys: String, CodingKey {
        case transactionId = "transaction_id"
        case code
        case rememberDevice = "remember_device"
    }
}

struct TwoFactorEmailSendResponse: Decodable {
    let ok: Bool
    let emailHint: String?

    enum CodingKeys: String, CodingKey {
        case ok
        case emailHint = "email_hint"
    }
}

struct TwoFactorEmailSendRequest: Encodable {
    let transactionId: String

    enum CodingKeys: String, CodingKey {
        case transactionId = "transaction_id"
    }
}

struct TwoFactorStatusResponse: Decodable {
    let enabled: Bool
}

struct TwoFactorSetupResponse: Decodable {
    let secret: String
    let provisioningUri: String

    enum CodingKeys: String, CodingKey {
        case secret
        case provisioningUri = "provisioning_uri"
    }
}

struct TwoFactorCodeRequest: Encodable {
    let code: String
}

struct TwoFactorEnableResponse: Decodable {
    let backupCodes: [String]

    enum CodingKeys: String, CodingKey {
        case backupCodes = "backup_codes"
    }
}

struct OkFlagResponse: Decodable {
    let ok: Bool?
}

struct AuthCapabilities: Decodable {
    let passwordLogin: Bool
    let signInWithApple: Bool
    let appleClientId: String?
    let selfServiceRegistration: Bool
    let passkey: Bool
    let passkeyRpId: String?

    enum CodingKeys: String, CodingKey {
        case passwordLogin = "password_login"
        case signInWithApple = "sign_in_with_apple"
        case appleClientId = "apple_client_id"
        case selfServiceRegistration = "self_service_registration"
        case passkey
        case passkeyRpId = "passkey_rp_id"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        passwordLogin = try values.decode(Bool.self, forKey: .passwordLogin)
        signInWithApple = try values.decode(Bool.self, forKey: .signInWithApple)
        appleClientId = try values.decodeIfPresent(String.self, forKey: .appleClientId)
        selfServiceRegistration = try values.decodeIfPresent(Bool.self, forKey: .selfServiceRegistration) ?? false
        passkey = try values.decodeIfPresent(Bool.self, forKey: .passkey) ?? false
        passkeyRpId = try values.decodeIfPresent(String.self, forKey: .passkeyRpId)
    }
}

// MARK: - Passkeys / WebAuthn

struct PasskeyCredentialDto: Decodable, Identifiable, Hashable {
    let credentialPk: String
    let credentialId: String
    let name: String
    let createdAt: String
    let lastUsedAt: String?
    let backupEligible: Bool?
    let backupState: Bool?

    var id: String { credentialPk }

    enum CodingKeys: String, CodingKey {
        case credentialPk = "credential_pk"
        case credentialId = "credential_id"
        case name
        case createdAt = "created_at"
        case lastUsedAt = "last_used_at"
        case backupEligible = "backup_eligible"
        case backupState = "backup_state"
    }
}

/// Registration options returned by POST /auth/passkey/register/options.
struct PasskeyRegisterOptionsResponse: Decodable {
    let transactionId: String
    let rpId: String
    let publicKey: PasskeyPublicKeyCreationOptions

    enum CodingKeys: String, CodingKey {
        case transactionId = "transaction_id"
        case rpId = "rp_id"
        case publicKey
    }
}

struct PasskeyPublicKeyCreationOptions: Decodable {
    let challenge: String
    let rp: PasskeyRp
    let user: PasskeyUser
}

struct PasskeyRp: Decodable {
    let id: String?
    let name: String?
}

struct PasskeyUser: Decodable {
    let id: String
    let name: String
    let displayName: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case displayName
    }
}

struct PasskeyAssertOptionsResponse: Decodable {
    let rpId: String?
    let publicKey: PasskeyPublicKeyRequestOptions

    enum CodingKeys: String, CodingKey {
        case rpId = "rp_id"
        case publicKey
    }
}

struct PasskeyPublicKeyRequestOptions: Decodable {
    let challenge: String
    let rpId: String?
    let allowCredentials: [PasskeyAllowCredential]?

    enum CodingKeys: String, CodingKey {
        case challenge
        case rpId
        case allowCredentials
    }
}

struct PasskeyAllowCredential: Decodable {
    let id: String
    let type: String?
}

struct RegisterCodeRequest: Encodable {
    let email: String
    let inviteToken: String?

    enum CodingKeys: String, CodingKey {
        case email
        case inviteToken = "invite_token"
    }
}

struct RegisterRequest: Encodable {
    let username: String
    let password: String
    let email: String
    let code: String
    let displayName: String?
    let inviteToken: String?
    let client: String = "ios"

    enum CodingKeys: String, CodingKey {
        case username, password, email, code
        case displayName = "display_name"
        case inviteToken = "invite_token"
        case client
    }
}

struct AppleIdentityStatus: Decodable {
    let appleLinked: Bool
    let hasPassword: Bool
    enum CodingKeys: String, CodingKey {
        case appleLinked = "linked"
        case hasPassword = "has_password"
    }
}

struct AppleChallenge: Decodable {
    let challengeId: String
    let nonce: String
    let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case challengeId = "challenge_id"
        case nonce
        case expiresAt = "expires_at"
    }
}

struct AppleAuthorizationPayload: Encodable {
    let challengeId: String
    let identityToken: String
    let authorizationCode: String
    let givenName: String?
    let familyName: String?
    let inviteToken: String?
    let client: String = "ios"

    enum CodingKeys: String, CodingKey {
        case challengeId = "challenge_id"
        case identityToken = "identity_token"
        case authorizationCode = "authorization_code"
        case givenName = "given_name"
        case familyName = "family_name"
        case inviteToken = "invite_token"
        case client
    }
}

struct AIDataDisclosure: Codable, Identifiable {
    let botId: String
    let botName: String
    let providerName: String?
    let privacyURL: String?
    let dataUse: String?
    let policyVersion: String
    let consented: Bool?
    var id: String { botId + ":" + policyVersion }

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case botName = "bot_name"
        case providerName = "provider_name"
        case privacyURL = "privacy_url"
        case dataUse = "data_use"
        case policyVersion = "policy_version"
        case consented
    }
}

struct AIConsentRequiredResponse: Decodable {
    let code: String
    let disclosures: [AIDataDisclosure]
}

struct StoredAIConsent: Decodable, Identifiable {
    let channelId: String
    let channelName: String
    let botId: String
    let botName: String
    let providerName: String?
    let privacyURL: String?
    let dataUse: String?
    let policyVersion: String
    var id: String { channelId + ":" + botId }

    enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case channelName = "channel_name"
        case botId = "bot_id"
        case botName = "bot_name"
        case providerName = "provider_name"
        case privacyURL = "privacy_url"
        case dataUse = "data_use"
        case policyVersion = "policy_version"
    }
}

struct BlockedUserDto: Decodable, Identifiable {
    let userId: String
    let username: String
    let displayName: String?
    let avatarURL: String?
    var id: String { userId }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case username
        case displayName = "display_name"
        case avatarURL = "avatar_url"
    }
}

struct OkResponse: Decodable {
    let ok: Bool?
}

struct EmptyRequest: Encodable {}

struct DeleteAccountRequest: Encodable {
    let confirmation: String
    let currentPassword: String?
    let apple: AppleAuthorizationPayload?

    enum CodingKeys: String, CodingKey {
        case confirmation
        case currentPassword = "current_password"
        case apple
    }
}

struct SetPasswordRequest: Encodable {
    let newPassword: String
    let apple: AppleAuthorizationPayload

    enum CodingKeys: String, CodingKey {
        case newPassword = "new_password"
        case apple
    }
}

struct CreateReportRequest: Encodable {
    let targetType: String
    let targetId: String
    let channelId: String?
    let reason: String
    let details: String?

    enum CodingKeys: String, CodingKey {
        case targetType = "target_type"
        case targetId = "target_id"
        case channelId = "channel_id"
        case reason, details
    }
}

struct ChangePasswordRequest: Encodable {
    let currentPassword: String
    let newPassword: String
    let twoFactorCode: String?

    enum CodingKeys: String, CodingKey {
        case currentPassword = "current_password"
        case newPassword = "new_password"
        case twoFactorCode = "two_factor_code"
    }
}

struct CreateWorkspaceRequest: Encodable {
    let name: String
}

struct UpdateBotProfileRequest: Encodable {
    var displayName: String?
    var description: String?

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case description
    }
}

struct ChangePasswordResponse: Decodable {
    let accessToken: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
    }
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
    /// `text` (default) or `voice`. Voice channels retain the normal message
    /// timeline and composer, with a LiveKit meeting strip above them.
    let kind: String?
    let purpose: String?
    let autoAssist: Bool?
    let allowMemberInvites: Bool?
    let allowBotAdds: Bool?
    let unreadCount: Int?
    /// Only present on GET /channels/dm rows.
    let peerName: String?

    var id: String { channelId }
    var isDM: Bool { channelType == "dm" }
    var isVoice: Bool { kind == "voice" }
    var displayName: String {
        if isDM, let peerName, !peerName.isEmpty { return peerName }
        return name
    }

    enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case workspaceId = "workspace_id"
        case name
        case channelType = "type"
        case kind
        case purpose
        case autoAssist = "auto_assist"
        case allowMemberInvites = "allow_member_invites"
        case allowBotAdds = "allow_bot_adds"
        case unreadCount = "unread_count"
        case peerName = "peer_name"
    }
}

// MARK: - Voice (server/src/api/voice.rs)

struct VoiceJoinResponse: Decodable {
    let url: String
    let token: String
    let roomName: String
    let voiceSessionId: String
    let participantIdentity: String
    let canPublish: Bool

    enum CodingKeys: String, CodingKey {
        case url, token
        case roomName = "room_name"
        case voiceSessionId = "voice_session_id"
        case participantIdentity = "participant_identity"
        case canPublish = "can_publish"
    }
}

struct VoiceSessionDto: Decodable {
    let voiceSessionId: String
    let status: String
    let transcriptionStatus: String
    enum CodingKeys: String, CodingKey {
        case voiceSessionId = "voice_session_id"
        case status
        case transcriptionStatus = "transcription_status"
    }
}

struct VoiceStateResponse: Decodable {
    let enabled: Bool
    let channelKind: String
    let canManage: Bool
    let session: VoiceSessionDto?
    enum CodingKeys: String, CodingKey {
        case enabled
        case channelKind = "channel_kind"
        case canManage = "can_manage"
        case session
    }
}

struct DictationCapabilityResponse: Decodable {
    let adapterConfigured: Bool
    let adapterKind: String?

    enum CodingKeys: String, CodingKey {
        case adapterConfigured = "adapter_configured"
        case adapterKind = "adapter_kind"
    }
}

struct DictationTranscriptResponse: Decodable {
    let transcript: String
}

struct VoiceConsentResponse: Decodable {
    let consented: Bool
    let publishToken: String?
    let canPublish: Bool
    enum CodingKeys: String, CodingKey {
        case consented
        case publishToken = "publish_token"
        case canPublish = "can_publish"
    }
}

struct VoiceTranscriptionControlResponse: Decodable {
    let voiceSessionId: String
    let transcriptionStatus: String
    enum CodingKeys: String, CodingKey {
        case voiceSessionId = "voice_session_id"
        case transcriptionStatus = "transcription_status"
    }
}

struct VoiceTranscriptSegment: Decodable, Identifiable, Hashable {
    let segmentId: String
    let channelId: String
    let channelSeq: Int64
    let userId: String
    let text: String
    let finalizedAt: String
    var id: String { segmentId }
    enum CodingKeys: String, CodingKey {
        case segmentId = "segment_id"
        case channelId = "channel_id"
        case channelSeq = "channel_seq"
        case userId = "user_id"
        case text
        case finalizedAt = "finalized_at"
    }
}

struct ChannelMemberDto: Decodable, Identifiable, Hashable {
    let memberId: String
    let memberType: String
    /// "active" | "pending" — a *directly invited* user sits here as `pending`
    /// until they accept; they are not a member yet.
    let status: String?
    let role: String?
    let username: String?
    let displayName: String?
    let avatarUrl: String?
    let isOnline: Bool?
    let canReceiveAudio: Bool?

    var id: String { memberId }
    var isPending: Bool { status == "pending" }
    var isBot: Bool { memberType == "bot" }
    var name: String {
        if let displayName, !displayName.isEmpty { return displayName }
        return username ?? memberId
    }

    enum CodingKeys: String, CodingKey {
        case memberId = "member_id"
        case memberType = "member_type"
        case status
        case role
        case username
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
        case isOnline = "is_online"
        case canReceiveAudio = "can_receive_audio"
    }
}

// MARK: - Membership management (server/src/api/channels.rs)

/// A candidate for `POST /channels/:id/members`. Already-in-channel candidates
/// come back flagged rather than filtered, so the UI can grey them out.
struct InvitableItem: Decodable, Identifiable, Hashable {
    let memberId: String
    let memberType: String
    let username: String?
    let displayName: String?
    let avatarUrl: String?
    let isOnline: Bool?
    let alreadyMember: Bool?

    var id: String { memberId }
    var isBot: Bool { memberType == "bot" }
    var name: String {
        if let displayName, !displayName.isEmpty { return displayName }
        return username ?? memberId
    }

    enum CodingKeys: String, CodingKey {
        case memberId = "member_id"
        case memberType = "member_type"
        case username
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
        case isOnline = "is_online"
        case alreadyMember = "already_member"
    }
}

struct InvitableResponse: Decodable {
    let results: [InvitableItem]
}

struct AddMemberRequest: Encodable {
    let memberId: String
    let memberType: String
    let role: String?

    enum CodingKeys: String, CodingKey {
        case memberId = "member_id"
        case memberType = "member_type"
        case role
    }
}

struct AddMemberResponse: Decodable {
    let status: String?
    let role: String?
}

struct MemberRoleRequest: Encodable {
    let role: String
}

/// PATCH /channels/:id — every field optional, COALESCE-applied server-side.
/// NOTE: sending a null `purpose` is a server-side no-op, so a purpose cannot
/// be cleared through this endpoint. Don't pretend otherwise in the UI.
struct ChannelUpdateRequest: Encodable {
    var name: String?
    var purpose: String?
    var channelType: String?

    enum CodingKeys: String, CodingKey {
        case name
        case purpose
        case channelType = "type"
    }
}

// MARK: - Invite links (server/src/api/invite_links.rs)
//
// Scoping trap: invite links are a WORKSPACE resource gated on workspace admin,
// even though the channel settings screen surfaces them. Listing returns every
// link in the workspace — filter by channelId client-side.

struct InviteLinkDto: Decodable, Identifiable, Hashable {
    let linkId: String
    let token: String
    let workspaceId: String
    let channelId: String?
    let channelName: String?
    let createdBy: String?
    let createdAt: String?
    let expiresAt: String?
    let maxUses: Int?
    let useCount: Int?
    let status: String?

    var id: String { linkId }

    enum CodingKeys: String, CodingKey {
        case linkId = "link_id"
        case token
        case workspaceId = "workspace_id"
        case channelId = "channel_id"
        case channelName = "channel_name"
        case createdBy = "created_by"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
        case maxUses = "max_uses"
        case useCount = "use_count"
        case status
    }
}

struct CreateInviteLinkRequest: Encodable {
    let expiresInHours: Int?
    let maxUses: Int?
    let channelId: String?

    enum CodingKeys: String, CodingKey {
        case expiresInHours = "expires_in_hours"
        case maxUses = "max_uses"
        case channelId = "channel_id"
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

struct MessageDto: Codable, Identifiable, Hashable {
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
    /// Group @-mention tokens (`all`/`bots`/`humans`/`here`), expanded to real
    /// members server-side — mirrors the web composer's mention_names split.
    var mentionNames: [String]? = nil
    var sessionId: String? = nil

    enum CodingKeys: String, CodingKey {
        case content
        case msgType = "msg_type"
        case replyToMsgId = "reply_to_msg_id"
        case fileIds = "file_ids"
        case mentionIds = "mention_ids"
        case mentionNames = "mention_names"
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
    case claude, codex, opencode, cursor, generic

    var id: String { rawValue }

    var label: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .opencode: return "OpenCode"
        case .cursor: return "Cursor"
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
        case .cursor: return "agent acp"
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
    let statusText: String?
    let statusEmoji: String?

    var connected: Bool { bridgeConnected ?? isOnline ?? false }

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case isDisabled = "is_disabled"
        case isOnline = "is_online"
        case bridgeConnected = "bridge_connected"
        case liveEnrollmentCodes = "live_enrollment_codes"
        case statusText = "status_text"
        case statusEmoji = "status_emoji"
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
    let msgId: String?
    let actorId: String?
    let targetUserId: String?
    let decision: String?
    let optionId: String?
    /// `{ title, tool: { command, raw_input, locations, cwd, kind } }` — the only
    /// place the *concrete* thing that was approved is recorded.
    let detail: JSONValue?
    let createdAt: String?

    var id: String { "\(requestId ?? "")\(eventType)\(createdAt ?? "")" }

    enum CodingKeys: String, CodingKey {
        case eventType = "event_type"
        case botId = "bot_id"
        case requestId = "request_id"
        case msgId = "msg_id"
        case actorId = "actor_id"
        case targetUserId = "target_user_id"
        case decision
        case optionId = "option_id"
        case detail
        case createdAt = "created_at"
    }

    /// What was actually approved, dug out of `detail.tool`. `detail.title` is a
    /// hardcoded "ACP permission request" server-side and must never be used.
    var subject: String? {
        guard let tool = detail?["tool"] else { return nil }
        let raw = tool["raw_input"]
        let candidates: [String?] = [
            tool["command"]?.stringValue,
            raw?["command"]?.stringValue,
            raw?["file_path"]?.stringValue,
            raw?["path"]?.stringValue,
            tool["title"]?.stringValue,
            tool["locations"]?[0]?["path"]?.stringValue,
        ]
        return candidates.compactMap { $0 }.first { !$0.isEmpty }
    }

    var cwd: String? { detail?["tool"]?["cwd"]?.stringValue }
    var toolKind: String? { detail?["tool"]?["kind"]?.stringValue }

    /// approved / denied / pending / timed-out, from decision + event type.
    var outcome: AuditOutcome {
        let d = decision ?? ""
        if d.hasPrefix("allow") { return .approved }
        if d.hasPrefix("reject") || d.hasPrefix("deny") { return .denied }
        if eventType == "timeout" { return .timedOut }
        return .pending
    }

    /// Human label for the decision, falling back to the event type.
    var outcomeLabel: String {
        switch decision {
        case "allow_once":   return "Approved once"
        case "allow_always": return "Always approved"
        case "reject_once":  return "Denied once"
        case "reject_always":return "Always denied"
        default: break
        }
        switch eventType {
        case "requested":        return "Approval requested"
        case "access_requested": return "Access requested"
        case "access_granted":   return "Access granted"
        case "access_revoked":   return "Access revoked"
        case "timeout":          return "Timed out"
        default: return eventType.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

enum AuditOutcome {
    case approved, denied, pending, timedOut
}

struct AuditResponse: Decodable {
    let events: [AuditEvent]
}

// MARK: - Create channel / DM (server/src/api/channels.rs)

struct ChannelCreateRequest: Encodable {
    let workspaceId: String
    let name: String
    let type: String          // "public" | "private"
    let kind: String          // "text" | "voice"
    var purpose: String? = nil

    enum CodingKeys: String, CodingKey {
        case workspaceId = "workspace_id"
        case name, type, kind, purpose
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

// MARK: - ViewBoard resource payloads (server/src/resource/*.rs)
//
// All numerics are genuinely nullable — the UI must render "—" for null,
// because "no data" is not "measured zero".

struct PlanBoardResponse: Decodable {
    let plans: [PlanCard]
}

struct PlanCard: Decodable, Identifiable {
    let botId: String
    let sessionId: String
    let entries: [PlanEntry]
    let total: Int
    let completed: Int
    let updatedAt: String?

    var id: String { "\(botId)/\(sessionId)" }

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case sessionId = "session_id"
        case entries, total, completed
        case updatedAt = "updated_at"
    }
}

struct PlanEntry: Decodable, Identifiable, Hashable {
    let content: String
    let priority: String?
    let status: String?

    var id: String { content }
}

struct UsageBoardResponse: Decodable {
    let bots: [UsageRow]
}

struct UsageRow: Decodable, Identifiable {
    let botId: String
    let sessionId: String?
    let inputTokens: Int64?
    let outputTokens: Int64?
    let totalTokens: Int64?
    let contextWindow: Int64?
    let costUsd: Double?

    var id: String { "\(botId)/\(sessionId ?? "-")" }

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case sessionId = "session_id"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case totalTokens = "total_tokens"
        case contextWindow = "context_window"
        case costUsd = "cost_usd"
    }
}

struct SessionsBoardResponse: Decodable {
    let sessions: [SessionBoardRow]
}

struct SessionBoardRow: Decodable, Identifiable {
    let sessionId: String
    let botId: String
    let botName: String?
    let role: String
    let isPrimary: Bool
    let status: String
    let createdAt: String     // "" when absent, NOT null
    let lastUsedAt: String
    let workspace: SessionWorkspace?

    var id: String { sessionId }

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case botId = "bot_id"
        case botName = "bot_name"
        case role
        case isPrimary = "is_primary"
        case status
        case createdAt = "created_at"
        case lastUsedAt = "last_used_at"
        case workspace
    }
}

struct SessionWorkspace: Decodable {
    let cwd: String?
    let additionalDirs: [String]?

    enum CodingKeys: String, CodingKey {
        case cwd
        case additionalDirs = "additional_dirs"
    }
}

struct ActivityBoardResponse: Decodable {
    let events: [ActivityBoardEvent]
}

struct ActivityBoardEvent: Decodable, Identifiable {
    let eventType: String     // "message" | "operation"
    let channelSeq: Int64
    let createdAt: String?
    let data: JSONValue?

    var id: Int64 { channelSeq }

    enum CodingKeys: String, CodingKey {
        case eventType = "event_type"
        case channelSeq = "channel_seq"
        case createdAt = "created_at"
        case data
    }
}

// MARK: - Workbench (the `fs.*` resource verbs over the channel workspace)
//
// The workbench is file-centric: a channel owns a tree of `context_files` that
// humans and bots both read and write. `fs.ls` / `fs.read` are WS resource verbs
// (ChatSocket.request), authz'd per channel-role on the server — the same pair the
// web workbench drawer is built on (frontend/.../workbench/fsClient.ts).

struct FsListing: Decodable {
    let path: String
    let entries: [FsEntry]
}

/// One row of an `fs.ls` reply.
///
/// `path` is the FULL path from the workspace root (`draft/paper.md`), and `fs.ls`
/// returns the tree **flattened** — every file at every depth, with no directory rows
/// in practice. Deliberately no `name`/basename helper: reading only the last segment
/// throws the folder away, which silently flattens the hierarchy and makes same-named
/// files in different folders indistinguishable. Build the tree instead — see
/// `TreeNode.build` in WorkbenchSheet.swift.
struct FsEntry: Decodable, Hashable {
    let path: String
    let version: Int
    let isDir: Bool
    let sizeBytes: Int

    enum CodingKeys: String, CodingKey {
        case path, version
        case isDir = "is_dir"
        case sizeBytes = "size_bytes"
    }
}

struct FsFile: Decodable {
    let path: String
    let content: String
    /// Optimistic-lock token. Unused while the workbench is read-only; `fs.write`
    /// will send it back as `if_version`.
    let version: Int

    enum CodingKeys: String, CodingKey {
        case path, content, version
    }
}
