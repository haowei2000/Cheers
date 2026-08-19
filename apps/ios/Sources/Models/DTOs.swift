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

    var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
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
    var rememberDevice: Bool = true
    var trustedDevice: String? = nil
    var deviceName: String? = nil

    enum CodingKeys: String, CodingKey {
        case login, password, client
        case rememberDevice = "remember_device"
        case trustedDevice = "trusted_device"
        case deviceName = "device_name"
    }
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
    let trustedDevice: String?

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
        case trustedDevice = "trusted_device"
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
    struct Providers: Decodable {
        let password: Bool?
        let apple: Bool?
        let google: Bool?
    }

    let passwordLogin: Bool
    let signInWithApple: Bool
    let signInWithGoogle: Bool
    let appleClientId: String?
    let selfServiceRegistration: Bool
    let passkey: Bool
    let passkeyRpId: String?

    enum CodingKeys: String, CodingKey {
        case providers
        case passwordLogin = "password_login"
        case signInWithApple = "sign_in_with_apple"
        case appleClientId = "apple_client_id"
        case selfServiceRegistration = "self_service_registration"
        case passkey
        case passkeyRpId = "passkey_rp_id"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let providers = try values.decodeIfPresent(Providers.self, forKey: .providers)
        passwordLogin = try values.decodeIfPresent(Bool.self, forKey: .passwordLogin)
            ?? providers?.password
            ?? true
        signInWithApple = try values.decodeIfPresent(Bool.self, forKey: .signInWithApple)
            ?? providers?.apple
            ?? false
        signInWithGoogle = providers?.google ?? false
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

/// Shared shape for GET `/users/me/external-identities/{apple|google}`.
struct ExternalIdentityStatusDto: Decodable {
    let provider: String
    let linked: Bool
    let displayName: String?
    let email: String?
    let hasPassword: Bool
    let canUnlink: Bool
    let recentAuthentication: Bool

    enum CodingKeys: String, CodingKey {
        case provider, linked, email
        case displayName = "display_name"
        case hasPassword = "has_password"
        case canUnlink = "can_unlink"
        case recentAuthentication = "recent_authentication"
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
    var trustedDevice: String? = nil
    var deviceName: String? = nil

    enum CodingKeys: String, CodingKey {
        case challengeId = "challenge_id"
        case identityToken = "identity_token"
        case authorizationCode = "authorization_code"
        case givenName = "given_name"
        case familyName = "family_name"
        case inviteToken = "invite_token"
        case client
        case trustedDevice = "trusted_device"
        case deviceName = "device_name"
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

struct MeProfileDto: Decodable {
    let userId: String
    let username: String
    let displayName: String?
    let role: String?
    let avatarURL: String?
    let bio: String?
    let statusText: String?
    let statusEmoji: String?

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case username
        case displayName = "display_name"
        case role
        case avatarURL = "avatar_url"
        case bio
        case statusText = "status_text"
        case statusEmoji = "status_emoji"
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

struct FriendDto: Decodable, Identifiable {
    let friendshipId: String
    let friendId: String
    let status: String
    let username: String
    let displayName: String?
    let avatarURL: String?
    var id: String { friendshipId }

    enum CodingKeys: String, CodingKey {
        case friendshipId = "friendship_id"
        case friendId = "friend_id"
        case status
        case username
        case displayName = "display_name"
        case avatarURL = "avatar_url"
    }
}

struct FriendRequestDto: Decodable, Identifiable {
    let friendshipId: String
    let userId: String
    let username: String
    let displayName: String?
    let avatarURL: String?
    let direction: String?
    var id: String { friendshipId }

    enum CodingKeys: String, CodingKey {
        case friendshipId = "friendship_id"
        case userId = "user_id"
        case username
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case direction
    }
}

struct UserSearchResultDto: Decodable, Identifiable {
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

struct FriendActionResultDto: Decodable {
    let friendId: String
    let status: String

    enum CodingKeys: String, CodingKey {
        case friendId = "friend_id"
        case status
    }
}

struct OAuthStartResponse: Decodable {
    let transactionId: String
    let authorizationURL: String
    let expiresIn: Int?

    enum CodingKeys: String, CodingKey {
        case transactionId = "transaction_id"
        case authorizationURL = "authorization_url"
        case expiresIn = "expires_in"
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

struct WorkspaceDto: Codable, Identifiable, Hashable {
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

struct WorkspaceMemberDto: Decodable, Identifiable, Hashable {
    let memberId: String
    let memberType: String
    let username: String
    let displayName: String?
    let role: String
    let status: String

    var id: String { "\(memberType):\(memberId)" }
    var userId: String { memberId }
    var name: String { displayName?.isEmpty == false ? displayName! : username }

    enum CodingKeys: String, CodingKey {
        case memberId = "member_id"
        case memberType = "member_type"
        case userId = "user_id"
        case botId = "bot_id"
        case username
        case displayName = "display_name"
        case role, status
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let botId = try values.decodeIfPresent(String.self, forKey: .botId)
        let genericId = try values.decodeIfPresent(String.self, forKey: .memberId)
        let legacyUserId = try values.decodeIfPresent(String.self, forKey: .userId)
        memberId = genericId
            ?? legacyUserId
            ?? botId
            ?? ""
        memberType = try values.decodeIfPresent(String.self, forKey: .memberType)
            ?? (botId == nil ? "user" : "bot")
        username = try values.decode(String.self, forKey: .username)
        displayName = try values.decodeIfPresent(String.self, forKey: .displayName)
        role = try values.decode(String.self, forKey: .role)
        status = try values.decode(String.self, forKey: .status)
    }
}

struct AuthSessionSummary: Decodable, Identifiable, Hashable {
    let sessionId: String
    let client: String
    let deviceName: String?
    let authenticatedAt: String
    let lastSeenAt: String
    let expiresAt: String
    let current: Bool

    var id: String { sessionId }

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case client
        case deviceName = "device_name"
        case authenticatedAt = "authenticated_at"
        case lastSeenAt = "last_seen_at"
        case expiresAt = "expires_at"
        case current
    }
}

// MARK: - Channels (server/src/api/channels.rs)

struct ChannelDto: Codable, Identifiable, Hashable {
    let channelId: String
    let workspaceId: String?
    let name: String
    let avatarUrl: String?
    /// serde: struct field `channel_type` is renamed to "type".
    let channelType: String
    /// `text` (default) or `voice`. Voice channels retain the normal message
    /// timeline and composer, with a LiveKit meeting strip above them.
    let kind: String?
    /// `chat` (default) or `discuss`. Older gateways omit this field.
    let conversationMode: String?
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
    var isDiscuss: Bool { conversationMode == "discuss" }
    var displayName: String {
        if isDM, let peerName, !peerName.isEmpty { return peerName }
        if isDM { return String(localized: "Unknown participant") }
        return name
    }

    enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case workspaceId = "workspace_id"
        case name
        case avatarUrl = "avatar_url"
        case channelType = "type"
        case kind
        case conversationMode = "conversation_mode"
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

// MARK: - Proactive task claiming

struct TaskClaimDto: Decodable, Identifiable, Hashable {
    let claimId: String
    let evaluationId: String
    let channelId: String
    let botId: String
    let botName: String
    let summary: String
    let proposedAction: String
    let confidence: Double
    let impact: String
    let status: String
    let createdAt: String
    let resolvedAt: String?
    let executionMsgId: String?
    let requesterId: String?
    let sourceMessageId: String?
    let confirmationMessageId: String?

    var id: String { claimId }

    enum CodingKeys: String, CodingKey {
        case claimId = "claim_id"
        case evaluationId = "evaluation_id"
        case channelId = "channel_id"
        case botId = "bot_id"
        case botName = "bot_name"
        case summary
        case proposedAction = "proposed_action"
        case confidence, impact, status
        case createdAt = "created_at"
        case resolvedAt = "resolved_at"
        case executionMsgId = "execution_msg_id"
        case requesterId = "requester_id"
        case sourceMessageId = "source_message_id"
        case confirmationMessageId = "confirmation_message_id"
    }
}

struct TaskClaimsResponse: Decodable { let claims: [TaskClaimDto] }

struct BotMonitoringDto: Codable, Hashable {
    var channelId: String
    var botId: String
    var mode: String
    var scope: String
    var debounceSeconds: Int
    var minIntervalSeconds: Int
    var maxEvaluationsPerHour: Int
    var batchSize: Int
    var confidenceThreshold: Double
    var policy: JSONValue?

    enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case botId = "bot_id"
        case mode, scope
        case debounceSeconds = "debounce_seconds"
        case minIntervalSeconds = "min_interval_seconds"
        case maxEvaluationsPerHour = "max_evaluations_per_hour"
        case batchSize = "batch_size"
        case confidenceThreshold = "confidence_threshold"
        case policy
    }
}

struct BotMonitoringUpdate: Encodable {
    let mode: String
    let scope: String
    let debounceSeconds: Int
    let minIntervalSeconds: Int
    let maxEvaluationsPerHour: Int
    let batchSize: Int
    let confidenceThreshold: Double
    let policy: JSONValue

    enum CodingKeys: String, CodingKey {
        case mode, scope
        case debounceSeconds = "debounce_seconds"
        case minIntervalSeconds = "min_interval_seconds"
        case maxEvaluationsPerHour = "max_evaluations_per_hour"
        case batchSize = "batch_size"
        case confidenceThreshold = "confidence_threshold"
        case policy
    }
}

struct ChannelMemberDto: Decodable, Identifiable, Hashable {
    let memberId: String
    let memberType: String
    /// active | pending | pending_workspace | pending_owner.
    let status: String?
    let role: String?
    let username: String?
    let displayName: String?
    let avatarUrl: String?
    let isOnline: Bool?
    let canReceiveAudio: Bool?
    let requestedCwd: String?
    let requestedAdditionalDirs: [String]?

    var id: String { memberId }
    var isPending: Bool { status != nil && status != "active" }
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
        case requestedCwd = "requested_cwd"
        case requestedAdditionalDirs = "requested_additional_dirs"
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
    let workspaceStatus: String?
    let requiresWorkspaceAcceptance: Bool?

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
        case workspaceStatus = "workspace_status"
        case requiresWorkspaceAcceptance = "requires_workspace_acceptance"
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

    var isImageAttachment: Bool {
        if contentType?.lowercased().hasPrefix("image/") == true { return true }
        guard let ext = originalFilename?.split(separator: ".").last?.lowercased() else {
            return false
        }
        return ["jpg", "jpeg", "png", "heic", "heif", "webp", "gif"].contains(String(ext))
    }

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
    var isDeleted: Bool?
    var replyToMsgId: String?
    /// Top-level discussion message for replies. Nil for root messages and
    /// frames produced by older gateways.
    var threadRootMsgId: String?
    var fileIds: [String]?
    var mentions: [MessageMention]?
    var files: [MessageFileRef]?
    /// RFC3339; absent on `message_done` WS frames.
    var createdAt: String?
    /// Present for approval/system cards; omitted when null server-side.
    var contentData: JSONValue?
    /// Secondary message record summaries. They are optional so older gateways
    /// remain decodable while the timeline can keep Context/Trace out of body flow.
    var contextBundle: ResourceContextBundle? = nil
    var traceCount: Int? = nil
    var traceHasFailure: Bool? = nil

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
        case isDeleted = "is_deleted"
        case replyToMsgId = "reply_to_msg_id"
        case threadRootMsgId = "thread_root_msg_id"
        case fileIds = "file_ids"
        case mentions
        case files
        case createdAt = "created_at"
        case contentData = "content_data"
        case contextBundle = "context_bundle"
        case traceCount = "trace_count"
        case traceHasFailure = "trace_has_failure"
    }
}

// MARK: - Discussions (server/src/api/discussions.rs)

struct DiscussionReplyPreviewDto: Codable, Hashable {
    let msgId: String
    let senderId: String
    let senderType: String
    let senderName: String
    let content: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case msgId = "msg_id"
        case senderId = "sender_id"
        case senderType = "sender_type"
        case senderName = "sender_name"
        case content
        case createdAt = "created_at"
    }
}

struct DiscussionParticipantDto: Codable, Identifiable, Hashable {
    let memberId: String
    let memberType: String
    let name: String
    let avatarUrl: String?
    var id: String { "\(memberType):\(memberId)" }

    enum CodingKeys: String, CodingKey {
        case memberId = "member_id"
        case memberType = "member_type"
        case name
        case avatarUrl = "avatar_url"
    }
}

struct DiscussionSummaryDto: Codable, Identifiable, Hashable {
    let root: MessageDto
    let replyCount: Int
    let lastActivityAt: String
    let lastReply: DiscussionReplyPreviewDto?
    let participants: [DiscussionParticipantDto]
    let participantCount: Int
    var id: String { root.msgId }

    enum CodingKeys: String, CodingKey {
        case root
        case replyCount = "reply_count"
        case lastActivityAt = "last_activity_at"
        case lastReply = "last_reply"
        case participants
        case participantCount = "participant_count"
    }
}

struct DiscussionListMetaDto: Codable, Hashable {
    let nextCursor: String?
    let hasMore: Bool
    enum CodingKeys: String, CodingKey {
        case nextCursor = "next_cursor"
        case hasMore = "has_more"
    }
}

struct ListDiscussionsResponseDto: Codable, Hashable {
    let discussions: [DiscussionSummaryDto]
    let meta: DiscussionListMetaDto
}

struct DiscussionDetailMetaDto: Codable, Hashable {
    let hasMoreBefore: Bool
    let limit: Int
    enum CodingKeys: String, CodingKey {
        case hasMoreBefore = "has_more_before"
        case limit
    }
}

struct DiscussionDetailResponseDto: Codable, Hashable {
    let root: MessageDto
    let replies: [MessageDto]
    let meta: DiscussionDetailMetaDto
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
    var contextBundle: ResourceContextBundle? = nil

    enum CodingKeys: String, CodingKey {
        case content
        case msgType = "msg_type"
        case replyToMsgId = "reply_to_msg_id"
        case fileIds = "file_ids"
        case mentionIds = "mention_ids"
        case mentionNames = "mention_names"
        case sessionId = "session_id"
        case contextBundle = "context_bundle"
    }
}

struct ResourceContextItem: Codable, Identifiable, Hashable {
    let id: String
    let verb: String
    let params: [String: JSONValue]
    let label: String
    let kind: String
}

struct ResourceContextWireItem: Codable, Hashable {
    let verb: String
    let params: [String: JSONValue]
    let label: String
    let kind: String
}

struct ResourceContextBundle: Codable, Hashable {
    let origin: String
    let items: [ResourceContextWireItem]
}

// MARK: - Notifications / invites (server/src/api/notifications.rs)

struct NotificationDto: Decodable, Identifiable {
    let id: String
    /// friend_request | workspace_invite | channel_invite | bot_channel_invite.
    let kind: String
    let title: String
    let actorId: String?
    let actorName: String?
    let createdAt: String?
    let friendshipId: String?
    let workspaceId: String?
    let channelId: String?
    let requesterUserId: String?
    let botId: String?
    let botName: String?
    let role: String?
    let requestedCwd: String?
    let requestedAdditionalDirs: [String]?

    var isChannelInvite: Bool { kind == "channel_invite" }

    enum CodingKeys: String, CodingKey {
        case id, kind, title, role
        case actorId = "actor_id"
        case actorName = "actor_name"
        case createdAt = "created_at"
        case friendshipId = "friendship_id"
        case workspaceId = "workspace_id"
        case channelId = "channel_id"
        case requesterUserId = "requester_user_id"
        case botId = "bot_id"
        case botName = "bot_name"
        case requestedCwd = "requested_cwd"
        case requestedAdditionalDirs = "requested_additional_dirs"
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

struct FleetHostListDto: Decodable {
    let hosts: [FleetHostDto]
}

struct FleetHostDto: Decodable, Identifiable {
    let hostId: String
    let botId: String
    let botName: String
    let deviceName: String
    let agentType: String
    let status: String
    let online: Bool
    let connectorVersion: String?
    let lastSeenAt: String?
    let revokedAt: String?
    let mcpConnectionState: String

    var id: String { hostId }

    enum CodingKeys: String, CodingKey {
        case hostId = "host_id"
        case botId = "bot_id"
        case botName = "bot_name"
        case deviceName = "device_name"
        case agentType = "agent_type"
        case status, online
        case connectorVersion = "connector_version"
        case lastSeenAt = "last_seen_at"
        case revokedAt = "revoked_at"
        case mcpConnectionState = "mcp_connection_state"
    }
}

struct FleetAuditListDto: Decodable {
    let events: [FleetAuditEventDto]
}

struct FleetAuditEventDto: Decodable, Identifiable {
    let id: String
    let source: String
    let eventType: String
    let botId: String?
    let hostId: String?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, source
        case eventType = "event_type"
        case botId = "bot_id"
        case hostId = "host_id"
        case createdAt = "created_at"
    }
}

// MARK: - Bot identity and host pairing (server/src/api/pairing.rs)
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

    enum CodingKeys: String, CodingKey {
        case username
        case displayName = "display_name"
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

/// A pending host and its single-use, TTL-bounded pairing code.
struct HostPairingDto: Decodable {
    let pairingCode: String
    let pairingId: String
    let hostId: String
    let botId: String
    let agentType: String?
    let status: String?
    let expiresAt: String?
    let ttlSecs: Int?
    let redeemPath: String?
    let controlUrl: String?
    let reachability: ReachabilityDto?
    let livePairings: Int?

    enum CodingKeys: String, CodingKey {
        case pairingCode = "pairing_code"
        case pairingId = "pairing_id"
        case hostId = "host_id"
        case botId = "bot_id"
        case agentType = "agent_type"
        case status
        case expiresAt = "expires_at"
        case ttlSecs = "ttl_secs"
        case redeemPath = "redeem_path"
        case controlUrl = "control_url"
        case reachability
        case livePairings = "live_pairings"
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
/// the code in a GET — the client substitutes `pairingCodePlaceholder` locally.
struct PairingGuidanceDto: Decodable {
    let installUrl: String
    let promptTemplate: String
    let pairingCodePlaceholder: String

    enum CodingKeys: String, CodingKey {
        case installUrl = "install_url"
        case promptTemplate = "prompt_template"
        case pairingCodePlaceholder = "pairing_code_placeholder"
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
    let pendingHostCount: Int?
    let statusText: String?
    let statusEmoji: String?

    var connected: Bool { bridgeConnected ?? isOnline ?? false }

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case isDisabled = "is_disabled"
        case isOnline = "is_online"
        case bridgeConnected = "bridge_connected"
        case pendingHostCount = "pending_host_count"
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
    let lastUsedAt: String?
    let sessionConfig: JSONValue?

    var id: String { sessionId }
    var tag: String { role ?? String(sessionId.prefix(6)) }

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case role
        case isPrimary = "is_primary"
        case status
        case lastUsedAt = "last_used_at"
        case sessionConfig = "session_config"
    }
}

struct SessionListResponse: Decodable { let sessions: [SessionInfo] }

struct CreateSessionResponse: Decodable {
    let sessionId: String
    let role: String?
    let cwd: String?
    let additionalDirs: [String]?

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case role, cwd
        case additionalDirs = "additional_dirs"
    }
}

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

struct BotPermissionsDto: Decodable {
    let posture: BotPostureDto
    let configOptions: BotConfigOptionsDto
    enum CodingKeys: String, CodingKey { case posture; case configOptions = "config_options" }
}

struct BotPostureDto: Decodable {
    let agentType: String
    let permissionMode: String?
    let allowedModes: [String]
    enum CodingKeys: String, CodingKey {
        case agentType = "agent_type"
        case permissionMode = "permission_mode"
        case allowedModes = "allowed_modes"
    }
}

struct BotConfigOptionsDto: Decodable {
    let advertised: [ConfigOption]
    let desired: [String: String]
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

    /// Prefer connector `command`, then server-normalized `summary`, then body.
    /// Gateway fills `tool.summary` / `command` / `locations` for all agents (#332).
    var subject: String? {
        guard let tool = detail?["tool"] else { return nil }
        let raw = tool["raw_input"]
        let candidates: [String?] = [
            tool["summary"]?.stringValue,
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
    /// Gateway-parsed JSON/YAML representation. Native clients never parse YAML.
    let data: JSONValue?
    /// Optimistic-lock token. Unused while the workbench is read-only; `fs.write`
    /// will send it back as `if_version`.
    let version: Int
    let isDir: Bool?

    enum CodingKeys: String, CodingKey {
        case path, content, data, version
        case isDir = "is_dir"
    }
}

struct FsWriteResponse: Decodable {
    let path: String
    let version: Int
}

struct WorkbenchExtensionSummary: Decodable, Identifiable {
    let id: String
    let version: String
    let title: String
    let description: String
    let sha256: String
    let origin: String
    let scenes: [WorkbenchExtensionSceneContribution]
    /// iOS intentionally ignores web renderer contributions and uses native lenses.
    let renderers: [WorkbenchExtensionRendererContribution]
}

struct WorkbenchExtensionSceneContribution: Decodable, Identifiable {
    let id: String
    let title: String
    let definition: String
}

struct WorkbenchExtensionRendererContribution: Decodable, Identifiable {
    let id: String
    let title: String
    let entry: String
}

struct WorkbenchResolvedScene: Decodable {
    let id: String
    let title: String
    let items: [WorkbenchExtensionSceneItem]
    let seed: [WorkbenchExtensionSeedFile]
    let pin: [String]
}

struct WorkbenchExtensionSceneItem: Decodable, Identifiable {
    let id: String
    let title: String
    let file: String
    let renderer: String
    let config: JSONValue?
}

struct WorkbenchExtensionSeedFile: Decodable {
    let path: String
    let content: String
}

struct WorkbenchTemplateRow: Identifiable {
    let tplId: String
    let title: String
    let manifest: WorkbenchTemplateManifest
    let origin: String?
    var id: String { tplId }

}

struct WorkbenchTemplateManifest: Codable, Identifiable {
    let id: String
    let title: String
    let views: [WorkbenchTemplateView]
    let seed: [String: JSONValue]?
    let pin: [String]?
}

struct WorkbenchTemplateView: Codable, Identifiable {
    let id: String
    let title: String
    let file: String
    let lens: String
    let renderer: String
    let config: JSONValue?
}

// MARK: - Remote workspace

struct RemoteWorkspaceBotsResponse: Decodable { let bots: [RemoteWorkspaceBot] }

struct RemoteWorkspaceBot: Decodable, Identifiable, Hashable {
    let botId: String
    let username: String
    let displayName: String?
    let online: Bool
    let canRead: Bool
    let canWrite: Bool
    var id: String { botId }
    var name: String { displayName?.isEmpty == false ? displayName! : username }

    enum CodingKeys: String, CodingKey {
        case botId = "bot_id"
        case username
        case displayName = "display_name"
        case online
        case canRead = "can_read"
        case canWrite = "can_write"
    }
}

struct RemoteWorkspaceTree: Decodable {
    let root: String
    let path: String
    let entries: [RemoteWorkspaceEntry]
}

struct RemoteWorkspaceEntry: Decodable, Identifiable, Hashable {
    let name: String
    let path: String
    let isDir: Bool
    let sizeBytes: Int
    var id: String { path }

    enum CodingKeys: String, CodingKey {
        case name, path
        case isDir = "is_dir"
        case sizeBytes = "size_bytes"
    }
}

struct RemoteWorkspaceFile: Decodable {
    let root: String
    let path: String
    let filename: String
    let contentType: String
    let sizeBytes: Int
    let isText: Bool
    let content: String?
    let contentBase64: String
    let etag: String

    enum CodingKeys: String, CodingKey {
        case root, path, filename, content, etag
        case contentType = "content_type"
        case sizeBytes = "size_bytes"
        case isText = "is_text"
        case contentBase64 = "content_b64"
    }
}

struct RemoteWorkspaceWriteResult: Decodable { let path: String?; let etag: String }

struct RemoteGitStatus: Decodable {
    let repo: Bool?
    let reason: String?
    let raw: String?
    let branch: String?
    let upstream: String?
    let ahead: Int?
    let behind: Int?
    let entries: [RemoteGitStatusEntry]?
}

struct RemoteGitStatusEntry: Decodable, Identifiable, Hashable {
    let xy: String
    let path: String
    var id: String { "\(xy):\(path)" }
}

struct RemoteGitDiff: Decodable { let diff: String; let staged: Bool }

struct RemoteGitLog: Decodable {
    let commits: [RemoteGitCommit]
    let skip: Int
    let limit: Int
}

struct RemoteGitCommit: Decodable, Identifiable, Hashable {
    let hash: String
    let author: String
    let date: String
    let subject: String
    var id: String { hash }
}

struct RemoteGitCommitFiles: Decodable {
    let commit: String
    let files: [RemoteGitCommitFile]
}

struct RemoteGitCommitFile: Decodable, Identifiable, Hashable {
    let status: String
    let path: String
    let oldPath: String?
    var id: String { "\(status):\(oldPath ?? ""): \(path)" }

    enum CodingKeys: String, CodingKey {
        case status, path
        case oldPath = "old_path"
    }
}

struct RemoteGitShow: Decodable {
    let commit: String
    let path: String?
    let diff: String
}

// MARK: - Durable agent-trace timeline (docs/arch/TRACE_PERSISTENCE.md)

/// One persisted step of a bot turn (`message_traces`), including interleaved
/// approval lifecycle rows (`kind == "approval"`).
struct TraceEventDto: Codable, Identifiable, Hashable {
    var v: Int = 1
    var id: String
    var eventId: String? = nil
    var msgId: String
    var channelId: String? = nil
    var traceSeq: Int? = nil
    var producerSeq: Int? = nil
    var kind: String
    var phase: String
    var status: String?
    var title: String?
    var message: String?
    var data: JSONValue?
    var requestId: String?
    var toolCallId: String? = nil
    var operationKind: String? = nil
    var operationId: String? = nil
    var isTerminal: Bool = false
    var approvalKind: String?
    var decision: String?
    var optionId: String?
    var actorId: String?
    var createdAt: String

    enum CodingKeys: String, CodingKey {
        case v, id, kind, phase, status, title, message, data, decision
        case eventId = "event_id"
        case msgId = "msg_id"
        case channelId = "channel_id"
        case traceSeq = "trace_seq"
        case producerSeq = "producer_seq"
        case requestId = "request_id"
        case toolCallId = "tool_call_id"
        case operationKind = "operation_kind"
        case operationId = "operation_id"
        case isTerminal = "is_terminal"
        case approvalKind = "approval_kind"
        case optionId = "option_id"
        case actorId = "actor_id"
        case createdAt = "created_at"
    }
}

struct MessageTraceResponse: Decodable {
    var events: [TraceEventDto]
}

extension TraceEventDto {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = try container.decodeIfPresent(Int.self, forKey: .v) ?? 1
        eventId = try container.decodeIfPresent(String.self, forKey: .eventId)
        msgId = try container.decode(String.self, forKey: .msgId)
        channelId = try container.decodeIfPresent(String.self, forKey: .channelId)
        traceSeq = try container.decodeIfPresent(Int.self, forKey: .traceSeq)
        producerSeq = try container.decodeIfPresent(Int.self, forKey: .producerSeq)
        phase = try container.decode(String.self, forKey: .phase)
        status = TraceEventContract.normalizeStatus(
            try container.decodeIfPresent(String.self, forKey: .status)
        )
        title = try container.decodeIfPresent(String.self, forKey: .title)
        message = try container.decodeIfPresent(String.self, forKey: .message)
        data = try container.decodeIfPresent(JSONValue.self, forKey: .data)
        requestId = try container.decodeIfPresent(String.self, forKey: .requestId)
            ?? data?["request_id"]?.stringValue
        toolCallId = try container.decodeIfPresent(String.self, forKey: .toolCallId)
            ?? data?.firstString("tool_call_id", "toolCallId")
        operationKind = try container.decodeIfPresent(String.self, forKey: .operationKind)
            ?? (requestId != nil ? "approval" : toolCallId != nil ? "tool" : nil)
        operationId = try container.decodeIfPresent(String.self, forKey: .operationId)
            ?? requestId
            ?? toolCallId
        id = try container.decodeIfPresent(String.self, forKey: .id)
            ?? eventId
            ?? operationId
            ?? "\(msgId):\(phase):\(title ?? message ?? "event")"
        eventId = eventId ?? id
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
            ?? (phase == "approval" ? "approval" : "trace")
        approvalKind = try container.decodeIfPresent(String.self, forKey: .approvalKind)
            ?? data?["approval_kind"]?.stringValue
        decision = try container.decodeIfPresent(String.self, forKey: .decision)
            ?? data?["decision"]?.stringValue
        optionId = try container.decodeIfPresent(String.self, forKey: .optionId)
            ?? data?["option_id"]?.stringValue
        actorId = try container.decodeIfPresent(String.self, forKey: .actorId)
            ?? data?["actor_id"]?.stringValue
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        isTerminal = try container.decodeIfPresent(Bool.self, forKey: .isTerminal)
            ?? TraceEventContract.terminalStatuses.contains(status ?? "")
    }
}

enum TraceEventContract {
    static let version = 1
    static let terminalStatuses: Set<String> = [
        "completed", "approved", "denied", "failed", "cancelled",
        "refused", "truncated", "max_turn_requests",
    ]

    static func normalizeStatus(_ status: String?) -> String? {
        guard let status else { return nil }
        switch status {
        case "running", "started": return "in_progress"
        case "complete", "done", "success", "succeeded": return "completed"
        case "error": return "failed"
        default: return status
        }
    }

    static func coalesce(_ sources: [TraceEventDto]...) -> [TraceEventDto] {
        let ordered = sources.flatMap { $0 }
            // Thought chunks are ephemeral stream state rather than lifecycle
            // steps. Older connectors emitted them without a durable traceSeq,
            // which placed "Thinking…" after prompt_finished on live screens.
            .filter { $0.phase != "agent_thought_chunk" }
            .enumerated().sorted { left, right in
            switch (left.element.traceSeq, right.element.traceSeq) {
            case let (lhs?, rhs?) where lhs != rhs: return lhs < rhs
            case (_?, nil): return true
            case (nil, _?): return false
            default: return left.offset < right.offset
            }
        }.map(\.element)

        var result: [TraceEventDto] = []
        var indexes: [String: Int] = [:]
        for event in ordered {
            let key: String
            if let operationId = event.operationId,
               !operationId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                key = "\(event.operationKind ?? "operation"):\(operationId)"
            } else {
                key = "event:\(event.id)"
            }
            guard let index = indexes[key] else {
                indexes[key] = result.count
                result.append(event)
                continue
            }
            result[index] = merge(older: result[index], newer: event)
        }
        return result
    }

    private static func merge(older: TraceEventDto, newer: TraceEventDto) -> TraceEventDto {
        var merged = newer
        merged.id = older.id
        merged.eventId = older.eventId ?? older.id
        merged.traceSeq = older.traceSeq ?? newer.traceSeq
        merged.channelId = newer.channelId ?? older.channelId
        merged.status = newer.status ?? older.status
        merged.title = newer.title ?? older.title
        merged.message = newer.message ?? older.message
        if let oldData = older.data, let newData = newer.data {
            merged.data = oldData.mergingTraceLifecycle(withNewer: newData)
        } else {
            merged.data = newer.data ?? older.data
        }
        merged.requestId = newer.requestId ?? older.requestId
        merged.toolCallId = newer.toolCallId ?? older.toolCallId
        merged.operationKind = newer.operationKind ?? older.operationKind
        merged.operationId = newer.operationId ?? older.operationId
        merged.isTerminal = older.isTerminal
            || newer.isTerminal
            || terminalStatuses.contains(newer.status ?? "")
        if older.isTerminal, !newer.isTerminal {
            merged.status = older.status
        }
        merged.approvalKind = newer.approvalKind ?? older.approvalKind
        merged.decision = newer.decision ?? older.decision
        merged.optionId = newer.optionId ?? older.optionId
        merged.actorId = newer.actorId ?? older.actorId
        if merged.createdAt.isEmpty { merged.createdAt = older.createdAt }
        return merged
    }
}

extension JSONValue {
    /// Lifecycle deltas may omit or null rich opening data. New non-null values
    /// win recursively; null keeps the older value.
    func mergingTraceLifecycle(withNewer newer: JSONValue) -> JSONValue {
        if case .null = newer { return self }
        guard case .object(let oldObject) = self,
              case .object(let newObject) = newer
        else { return newer }

        var result = oldObject
        for (key, value) in newObject {
            if let oldValue = result[key] {
                result[key] = oldValue.mergingTraceLifecycle(withNewer: value)
            } else if value != .null {
                result[key] = value
            }
        }
        return .object(result)
    }
}
