import Foundation

// MARK: - Errors

enum APIError: LocalizedError {
    case invalidBaseURL
    case unauthorized
    case http(status: Int, detail: String?)
    case transport(Error)
    case decoding(Error)
    case aiConsentRequired([AIDataDisclosure])

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Invalid server URL."
        case .unauthorized:
            return "Session expired. Please sign in again."
        case .http(let status, let detail):
            if let detail, !detail.isEmpty { return detail }
            return "HTTP \(status)"
        case .transport(let err):
            return err.localizedDescription
        case .decoding:
            return "Unexpected server response."
        case .aiConsentRequired:
            return "Review the external AI data notice before sending this message."
        }
    }
}

// MARK: - Client

/// Thin async/await REST client for the Cheers Rust gateway.
/// `baseURL` includes the `/api/v1` prefix (e.g. http://localhost:30080/api/v1).
struct APIClient: Sendable {
    let baseURL: URL
    let token: String?

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    init(baseURL: URL, token: String?) {
        self.baseURL = baseURL
        self.token = token
    }

    /// Normalizes user input like "localhost:30080" or a trailing-slash URL
    /// into a base URL ending in /api/v1 (no trailing slash).
    ///
    /// Credentials and bearer tokens must never traverse a clear-text network.
    /// Local HTTP remains available for simulator/local-development use only;
    /// every non-loopback server must use HTTPS.
    static func normalizeBaseURL(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.lowercased().hasPrefix("http://") && !text.lowercased().hasPrefix("https://") {
            text = "http://" + text
        }
        while text.hasSuffix("/") { text.removeLast() }
        if !text.hasSuffix("/api/v1") {
            text += "/api/v1"
        }
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              scheme == "https" || scheme == "http"
        else { return nil }

        if scheme == "http" {
            let isLoopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
            guard isLoopback else { return nil }
        }
        return url
    }

    /// Derives the websocket URL (ws(s)://host[:port]/ws) from the REST base.
    static func websocketURL(for baseURL: URL) -> URL? {
        var components = URLComponents()
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components.host = baseURL.host
        components.port = baseURL.port
        components.path = "/ws"
        return components.url
    }

    // MARK: Request plumbing

    private func makeRequest(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil
    ) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidBaseURL
        }
        components.path += path
        if !query.isEmpty {
            components.queryItems = query
        }
        guard let url = components.url else { throw APIError.invalidBaseURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(status: 0, detail: "no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 428,
               let required = try? JSONDecoder().decode(AIConsentRequiredResponse.self, from: data),
               required.code == "ai_consent_required" {
                throw APIError.aiConsentRequired(required.disclosures)
            }
            // 401 means "session revoked/expired" only when the body is empty.
            // Authenticated management calls (change-password, 2FA enable/disable)
            // also use 401 for wrong credentials / codes — surface that detail.
            if http.statusCode == 401, token != nil {
                let detail = (try? JSONDecoder().decode(ApiErrorBody.self, from: data))?.detail
                if let detail, !detail.isEmpty {
                    throw APIError.http(status: 401, detail: detail)
                }
                throw APIError.unauthorized
            }
            // AppError bodies are { "detail": "..." }; auth middleware 401s are empty.
            let detail = (try? JSONDecoder().decode(ApiErrorBody.self, from: data))?.detail
                ?? String(data: data, encoding: .utf8)
            throw APIError.http(status: http.statusCode, detail: detail)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    @discardableResult
    func getJSON<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type) async throws -> T {
        let request = try makeRequest("GET", path, query: query)
        return try decode(type, from: try await send(request))
    }

    @discardableResult
    func postJSON<B: Encodable, T: Decodable>(_ path: String, body: B, as type: T.Type) async throws -> T {
        let data = try JSONEncoder().encode(body)
        let request = try makeRequest("POST", path, body: data)
        return try decode(type, from: try await send(request))
    }

    @discardableResult
    func patchJSON<B: Encodable, T: Decodable>(_ path: String, body: B, as type: T.Type) async throws -> T {
        let data = try JSONEncoder().encode(body)
        let request = try makeRequest("PATCH", path, body: data)
        return try decode(type, from: try await send(request))
    }

    func postEmpty(_ path: String) async throws {
        let request = try makeRequest("POST", path, body: Data("{}".utf8))
        _ = try await send(request)
    }

    func postEmptyJSON<B: Encodable>(_ path: String, body: B) async throws {
        let data = try JSONEncoder().encode(body)
        let request = try makeRequest("POST", path, body: data)
        _ = try await send(request)
    }

    func deleteEmpty(_ path: String) async throws {
        let request = try makeRequest("DELETE", path)
        _ = try await send(request)
    }

    // MARK: Auth

    func login(login loginName: String, password: String) async throws -> LoginResponse {
        // Unauthenticated call — token intentionally ignored by the server here.
        try await postJSON("/auth/login", body: LoginRequest(login: loginName, password: password), as: LoginResponse.self)
    }

    func authCapabilities() async throws -> AuthCapabilities {
        try await getJSON("/auth/capabilities", as: AuthCapabilities.self)
    }

    func requestRegisterCode(email: String, inviteToken: String?) async throws {
        try await postEmptyJSON(
            "/auth/register/request-code",
            body: RegisterCodeRequest(email: email, inviteToken: inviteToken)
        )
    }

    func register(_ request: RegisterRequest) async throws -> LoginResponse {
        try await postJSON("/auth/register", body: request, as: LoginResponse.self)
    }

    func refresh(refreshToken: String) async throws -> LoginResponse {
        try await postJSON("/auth/refresh", body: RefreshRequest(refreshToken: refreshToken), as: LoginResponse.self)
    }

    func appleChallenge() async throws -> AppleChallenge {
        try await postJSON("/auth/apple/challenge", body: EmptyRequest(), as: AppleChallenge.self)
    }

    func appleLogin(_ payload: AppleAuthorizationPayload) async throws -> LoginResponse {
        try await postJSON("/auth/apple", body: payload, as: LoginResponse.self)
    }

    func linkApple(_ payload: AppleAuthorizationPayload) async throws {
        _ = try await postJSON("/users/me/external-identities/apple", body: payload, as: JSONValue.self)
    }

    func appleIdentityStatus() async throws -> AppleIdentityStatus {
        try await getJSON("/users/me/external-identities/apple", as: AppleIdentityStatus.self)
    }

    func unlinkApple() async throws {
        try await deleteEmpty("/users/me/external-identities/apple")
    }

    func deleteAccount(currentPassword: String?, apple: AppleAuthorizationPayload?) async throws {
        try await postEmptyJSON(
            "/users/me/delete",
            body: DeleteAccountRequest(confirmation: "DELETE", currentPassword: currentPassword, apple: apple)
        )
    }

    func setPassword(_ password: String, apple: AppleAuthorizationPayload) async throws {
        try await postEmptyJSON("/users/me/password", body: SetPasswordRequest(newPassword: password, apple: apple))
    }

    func report(targetType: String, targetId: String, channelId: String?, reason: String, details: String?) async throws {
        try await postEmptyJSON(
            "/reports",
            body: CreateReportRequest(targetType: targetType, targetId: targetId, channelId: channelId, reason: reason, details: details)
        )
    }

    func blockUser(_ userId: String) async throws {
        _ = try await postJSON("/friends/block", body: ["user_id": userId], as: JSONValue.self)
    }

    func unblockUser(_ userId: String) async throws {
        _ = try await postJSON("/friends/unblock", body: ["user_id": userId], as: JSONValue.self)
    }

    func blockedUsers() async throws -> [BlockedUserDto] {
        try await getJSON("/friends/blocks", as: [BlockedUserDto].self)
    }

    func aiDisclosures(channelId: String) async throws -> [AIDataDisclosure] {
        try await getJSON("/channels/\(channelId)/ai-disclosures", as: [AIDataDisclosure].self)
    }

    func storedAIConsents() async throws -> [StoredAIConsent] {
        try await getJSON("/users/me/ai-consents", as: [StoredAIConsent].self)
    }

    func grantAIConsent(channelId: String, disclosure: AIDataDisclosure) async throws {
        _ = try await postJSON(
            "/channels/\(channelId)/bots/\(disclosure.botId)/ai-consent",
            body: ["policy_version": disclosure.policyVersion],
            as: JSONValue.self
        )
    }

    func revokeAIConsent(channelId: String, botId: String) async throws {
        try await deleteEmpty("/channels/\(channelId)/bots/\(botId)/ai-consent")
    }

    func logout() async throws {
        try await postEmpty("/auth/logout")
    }

    func changePassword(
        currentPassword: String,
        newPassword: String,
        twoFactorCode: String? = nil
    ) async throws -> ChangePasswordResponse {
        try await postJSON(
            "/auth/change-password",
            body: ChangePasswordRequest(
                currentPassword: currentPassword,
                newPassword: newPassword,
                twoFactorCode: twoFactorCode
            ),
            as: ChangePasswordResponse.self
        )
    }

    func verifyTwoFactorLogin(
        transactionId: String,
        code: String,
        rememberDevice: Bool = true
    ) async throws -> LoginResponse {
        try await postJSON(
            "/auth/2fa/login",
            body: TwoFactorLoginRequest(
                transactionId: transactionId,
                code: code,
                rememberDevice: rememberDevice
            ),
            as: LoginResponse.self
        )
    }

    func sendTwoFactorEmail(transactionId: String) async throws -> TwoFactorEmailSendResponse {
        try await postJSON(
            "/auth/2fa/email/send",
            body: TwoFactorEmailSendRequest(transactionId: transactionId),
            as: TwoFactorEmailSendResponse.self
        )
    }

    func twoFactorStatus() async throws -> TwoFactorStatusResponse {
        try await getJSON("/auth/2fa/status", as: TwoFactorStatusResponse.self)
    }

    func setupTwoFactor() async throws -> TwoFactorSetupResponse {
        try await postJSON("/auth/2fa/setup", body: EmptyRequest(), as: TwoFactorSetupResponse.self)
    }

    func enableTwoFactor(code: String) async throws -> TwoFactorEnableResponse {
        try await postJSON("/auth/2fa/enable", body: TwoFactorCodeRequest(code: code), as: TwoFactorEnableResponse.self)
    }

    func disableTwoFactor(code: String) async throws {
        _ = try await postJSON("/auth/2fa/disable", body: TwoFactorCodeRequest(code: code), as: OkFlagResponse.self)
    }

    // MARK: Passkeys

    func passkeyRegisterOptions(name: String? = nil) async throws -> PasskeyRegisterOptionsResponse {
        struct Body: Encodable {
            let name: String?
        }
        return try await postJSON(
            "/auth/passkey/register/options",
            body: Body(name: name),
            as: PasskeyRegisterOptionsResponse.self
        )
    }

    func passkeyRegisterFinish(transactionId: String, credential: [String: Any]) async throws -> PasskeyCredentialDto {
        let body: [String: Any] = [
            "transaction_id": transactionId,
            "credential": credential,
        ]
        return try await postRawJSON("/auth/passkey/register/finish", object: body, as: PasskeyCredentialDto.self)
    }

    func listPasskeys() async throws -> [PasskeyCredentialDto] {
        try await getJSON("/auth/passkey/credentials", as: [PasskeyCredentialDto].self)
    }

    func deletePasskey(credentialPk: String) async throws {
        try await deleteEmpty("/auth/passkey/credentials/\(credentialPk)")
    }

    func passkeyFactorOptions(transactionId: String) async throws -> PasskeyAssertOptionsResponse {
        struct Body: Encodable {
            let transactionId: String
            enum CodingKeys: String, CodingKey { case transactionId = "transaction_id" }
        }
        return try await postJSON(
            "/auth/2fa/passkey/options",
            body: Body(transactionId: transactionId),
            as: PasskeyAssertOptionsResponse.self
        )
    }

    func passkeyFactorVerify(
        transactionId: String,
        credential: [String: Any],
        rememberDevice: Bool = true
    ) async throws -> LoginResponse {
        let body: [String: Any] = [
            "transaction_id": transactionId,
            "credential": credential,
            "remember_device": rememberDevice,
        ]
        return try await postRawJSON("/auth/2fa/passkey/verify", object: body, as: LoginResponse.self)
    }

    private func postRawJSON<T: Decodable>(_ path: String, object: [String: Any], as type: T.Type) async throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object)
        let request = try makeRequest("POST", path, body: data)
        return try decode(type, from: try await send(request))
    }

    // MARK: Workspaces / channels

    func listWorkspaces() async throws -> [WorkspaceDto] {
        try await getJSON("/workspaces", as: [WorkspaceDto].self)
    }

    func createWorkspace(name: String) async throws -> WorkspaceDto {
        try await postJSON("/workspaces", body: CreateWorkspaceRequest(name: name), as: WorkspaceDto.self)
    }

    func personalWorkspace() async throws -> WorkspaceDto {
        try await getJSON("/workspaces/personal", as: WorkspaceDto.self)
    }

    func listChannels(workspaceId: String?) async throws -> [ChannelDto] {
        var query: [URLQueryItem] = []
        if let workspaceId {
            query.append(URLQueryItem(name: "workspace_id", value: workspaceId))
        }
        return try await getJSON("/channels", query: query, as: [ChannelDto].self)
    }

    func listDMs() async throws -> [ChannelDto] {
        try await getJSON("/channels/dm", as: [ChannelDto].self)
    }

    func listMembers(channelId: String) async throws -> [ChannelMemberDto] {
        try await getJSON("/channels/\(channelId)/members", as: [ChannelMemberDto].self)
    }

    // MARK: Membership management (channel admin only)

    /// Typeahead for both "invite a person" and "add a bot" — one endpoint, the
    /// `member_type` on each result tells them apart. Requires q.count >= 2.
    func searchInvitable(channelId: String, query: String) async throws -> [InvitableItem] {
        try await getJSON(
            "/channels/\(channelId)/invitable",
            query: [URLQueryItem(name: "q", value: query)],
            as: InvitableResponse.self
        ).results
    }

    /// Adding a BOT binds it immediately; adding a USER only creates a pending
    /// invite they must accept. The response's `status` says which happened.
    @discardableResult
    func addMember(channelId: String, memberId: String, memberType: String, role: String? = nil) async throws -> AddMemberResponse {
        try await postJSON(
            "/channels/\(channelId)/members",
            body: AddMemberRequest(memberId: memberId, memberType: memberType, role: role),
            as: AddMemberResponse.self
        )
    }

    func removeMember(channelId: String, memberId: String) async throws {
        try await deleteEmpty("/channels/\(channelId)/members/\(memberId)")
    }

    func setMemberRole(channelId: String, memberId: String, role: String) async throws {
        _ = try await patchJSON(
            "/channels/\(channelId)/members/\(memberId)",
            body: MemberRoleRequest(role: role),
            as: JSONValue.self
        )
    }

    // MARK: Channel settings

    func updateChannel(channelId: String, _ update: ChannelUpdateRequest) async throws -> ChannelDto {
        try await patchJSON("/channels/\(channelId)", body: update, as: ChannelDto.self)
    }

    func deleteChannel(channelId: String) async throws {
        try await deleteEmpty("/channels/\(channelId)")
    }

    func leaveChannel(channelId: String) async throws {
        try await postEmpty("/channels/\(channelId)/leave")
    }

    // MARK: Invite links (WORKSPACE-scoped, workspace-admin gated)

    /// Returns every link in the workspace — there is no server-side channel
    /// filter, so callers narrow by `channelId` themselves.
    func listInviteLinks(workspaceId: String) async throws -> [InviteLinkDto] {
        try await getJSON("/workspaces/\(workspaceId)/invite-links", as: [InviteLinkDto].self)
    }

    func createInviteLink(workspaceId: String, channelId: String?, expiresInHours: Int?, maxUses: Int?) async throws -> InviteLinkDto {
        try await postJSON(
            "/workspaces/\(workspaceId)/invite-links",
            body: CreateInviteLinkRequest(expiresInHours: expiresInHours, maxUses: maxUses, channelId: channelId),
            as: InviteLinkDto.self
        )
    }

    func revokeInviteLink(workspaceId: String, linkId: String) async throws {
        try await deleteEmpty("/workspaces/\(workspaceId)/invite-links/\(linkId)")
    }

    func markRead(channelId: String) async throws {
        try await postEmpty("/channels/\(channelId)/read")
    }

    // MARK: Messages

    func listMessages(
        channelId: String,
        before: String? = nil,
        sinceSeq: Int64? = nil,
        limit: Int = 50
    ) async throws -> ListMessagesResponse {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before {
            query.append(URLQueryItem(name: "before", value: before))
        }
        if let sinceSeq {
            query.append(URLQueryItem(name: "since_seq", value: String(sinceSeq)))
        }
        return try await getJSON("/channels/\(channelId)/messages", query: query, as: ListMessagesResponse.self)
    }

    func sendMessage(channelId: String, _ body: SendMessageRequest) async throws -> MessageDto {
        try await postJSON("/channels/\(channelId)/messages", body: body, as: MessageDto.self)
    }

    // MARK: Voice

    func joinVoice(channelId: String) async throws -> VoiceJoinResponse {
        try await postJSON("/channels/\(channelId)/voice/join", body: [String: String](), as: VoiceJoinResponse.self)
    }

    func voiceState(channelId: String) async throws -> VoiceStateResponse {
        try await getJSON("/channels/\(channelId)/voice/state", as: VoiceStateResponse.self)
    }

    func dictationCapability(channelId: String) async throws -> DictationCapabilityResponse {
        try await getJSON("/channels/\(channelId)/voice/dictation-capability", as: DictationCapabilityResponse.self)
    }

    /// Short-lived 16 kHz mono PCM captured for Composer dictation. The Gateway
    /// owns the provider credential and returns text only; audio is never saved
    /// as a message, attachment, or channel transcript.
    func dictate(channelId: String, pcm16: Data) async throws -> String {
        var request = try makeRequest("POST", "/channels/\(channelId)/voice/dictation", body: pcm16)
        request.setValue("audio/pcm;rate=16000;channels=1", forHTTPHeaderField: "Content-Type")
        let response: DictationTranscriptResponse = try decode(DictationTranscriptResponse.self, from: try await send(request))
        return response.transcript
    }

    func voiceTranscript(channelId: String, afterSeq: Int64 = 0) async throws -> [VoiceTranscriptSegment] {
        try await getJSON("/channels/\(channelId)/voice/transcript", query: [
            URLQueryItem(name: "after_seq", value: String(afterSeq)),
            URLQueryItem(name: "limit", value: "100"),
        ], as: [VoiceTranscriptSegment].self)
    }

    func grantVoiceConsent(channelId: String) async throws -> VoiceConsentResponse {
        try await postJSON("/channels/\(channelId)/voice/consent", body: [String: String](), as: VoiceConsentResponse.self)
    }

    func setVoiceTranscription(channelId: String, enabled: Bool) async throws -> VoiceTranscriptionControlResponse {
        try await postJSON(
            "/channels/\(channelId)/voice/transcription/\(enabled ? "start" : "stop")",
            body: [String: String](),
            as: VoiceTranscriptionControlResponse.self
        )
    }

    func resolveTaskClaim(channelId: String, claimId: String, decision: String) async throws {
        _ = try await postJSON(
            "/channels/\(channelId)/task-claims/\(claimId)/resolve",
            body: ["decision": decision],
            as: JSONValue.self
        )
    }

    // MARK: Files

    /// Raw file bytes (Bearer-authed). `download` serves the original; otherwise
    /// the inline preview (a PDF rendition for office docs).
    func fileData(fileId: String, download: Bool = true) async throws -> Data {
        let request = try makeRequest("GET", "/files/\(fileId)/\(download ? "download" : "preview")")
        return try await send(request)
    }

    // MARK: Approvals (ACP permission resolution)

    /// Resolve a pending permission request by option id (allow/reject).
    /// `delivered=false` means the decision was recorded but the agent's
    /// connector/session was offline to receive it.
    func resolvePermission(
        channelId: String,
        requestId: String,
        optionId: String
    ) async throws -> ResolveResponse {
        let encoded = requestId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? requestId
        return try await postJSON(
            "/channels/\(channelId)/permissions/\(encoded)/resolve",
            body: ResolvePermissionRequest(optionId: optionId),
            as: ResolveResponse.self
        )
    }

    /// Acknowledge an ACP agent re-auth card (`retry` / `cancel`).
    func ackAuthRequired(
        channelId: String,
        requestId: String,
        action: String
    ) async throws -> AuthAckResponse {
        let encoded = requestId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? requestId
        return try await postJSON(
            "/channels/\(channelId)/auth-required/\(encoded)/ack",
            body: AuthAckRequest(action: action),
            as: AuthAckResponse.self
        )
    }
}

struct ResolvePermissionRequest: Encodable {
    let optionId: String
    enum CodingKeys: String, CodingKey { case optionId = "option_id" }
}

struct AuthAckRequest: Encodable {
    let action: String
}

extension APIClient {
    // MARK: Notifications / invites

    func listNotifications() async throws -> [NotificationDto] {
        try await getJSON("/notifications", as: [NotificationDto].self)
    }

    func acceptWorkspaceInvite(workspaceId: String) async throws {
        try await postEmpty("/workspaces/\(workspaceId)/accept")
    }

    func declineWorkspaceInvite(workspaceId: String) async throws {
        try await postEmpty("/workspaces/\(workspaceId)/decline")
    }

    func acceptChannelInvite(channelId: String) async throws {
        try await postEmpty("/channels/\(channelId)/accept")
    }

    func declineChannelInvite(channelId: String) async throws {
        try await postEmpty("/channels/\(channelId)/decline")
    }

    // MARK: Agents

    func listBots() async throws -> [BotDto] {
        try await getJSON("/bots", as: [BotDto].self)
    }

    func disableBot(botId: String) async throws {
        try await postEmpty("/bots/\(botId)/disable")
    }

    func enableBot(botId: String) async throws {
        try await postEmpty("/bots/\(botId)/enable")
    }

    func deleteBot(botId: String) async throws {
        try await deleteEmpty("/bots/\(botId)")
    }

    func updateBotProfile(botId: String, displayName: String?, description: String?) async throws {
        _ = try await patchJSON(
            "/bots/\(botId)/profile",
            body: UpdateBotProfileRequest(displayName: displayName, description: description),
            as: JSONValue.self
        )
    }

    // MARK: Bot onboarding
    //
    // The phone can create a bot and mint credentials, but never runs the
    // connector — see the AgentType/EnrollmentCodeDto note in DTOs.swift. Every
    // call here exists to produce something the user carries to a real host.

    func createBot(username: String, displayName: String?, agentType: AgentType) async throws -> BotDto {
        try await postJSON(
            "/bots",
            body: CreateBotRequest(
                username: username,
                displayName: displayName,
                bridgeProvider: agentType.rawValue
            ),
            as: BotDto.self
        )
    }

    /// Mint a one-time enrollment code (owner/admin). Plaintext is returned
    /// once and never stored server-side — only its hash is.
    func mintEnrollmentCode(botId: String, agentType: AgentType) async throws -> EnrollmentCodeDto {
        try await postJSON(
            "/bots/\(botId)/enrollment",
            body: ["agent_type": agentType.rawValue],
            as: EnrollmentCodeDto.self
        )
    }

    /// Revoke ALL live codes for a bot. Idempotent — and blunt: there is no
    /// single-code revoke, so this will also kill an install in flight.
    func revokeEnrollmentCodes(botId: String) async throws {
        try await deleteEmpty("/bots/\(botId)/enrollment")
    }

    func connectorConfig(botId: String, agentType: AgentType) async throws -> ConnectorConfigDto {
        try await getJSON(
            "/bots/\(botId)/connector-config",
            query: [URLQueryItem(name: "agent_type", value: agentType.rawValue)],
            as: ConnectorConfigDto.self
        )
    }

    /// Issue/rotate the long-lived bot token. Destructive: it replaces any
    /// previous token and kicks a connector already running with the old one.
    func issueBotToken(botId: String) async throws -> IssuedTokenDto {
        try await postJSON("/bots/\(botId)/token", body: [String: String](), as: IssuedTokenDto.self)
    }

    func enrollmentGuidance() async throws -> EnrollmentGuidanceDto {
        try await getJSON("/enrollment/guidance", as: EnrollmentGuidanceDto.self)
    }

    func connectorDiscovery() async throws -> ConnectorDiscoveryDto {
        try await getJSON("/ops/connector-discovery", as: ConnectorDiscoveryDto.self)
    }

    func botStatus(botId: String) async throws -> BotStatusDto {
        try await getJSON("/bots/\(botId)/status", as: BotStatusDto.self)
    }

    // MARK: Create channel / DM

    func createChannel(
        workspaceId: String,
        name: String,
        isPrivate: Bool,
        kind: String = "text",
        purpose: String?
    ) async throws -> ChannelDto {
        try await postJSON(
            "/channels",
            body: ChannelCreateRequest(
                workspaceId: workspaceId,
                name: name,
                type: isPrivate ? "private" : "public",
                kind: kind,
                purpose: purpose
            ),
            as: ChannelDto.self
        )
    }

    func createDM(botId: String) async throws -> ChannelDto {
        try await postJSON("/channels/dm", body: DmCreateRequest(targetBotId: botId), as: ChannelDto.self)
    }

    func createDM(userId: String) async throws -> ChannelDto {
        try await postJSON("/channels/dm", body: DmCreateRequest(targetUserId: userId), as: ChannelDto.self)
    }

    // MARK: Push devices (OS notifications)

    func registerDevice(token: String, name: String?) async throws {
        struct Body: Encodable {
            let pushToken: String
            let platform: String
            let deviceName: String?
            enum CodingKeys: String, CodingKey {
                case pushToken = "push_token"
                case platform
                case deviceName = "device_name"
            }
        }
        _ = try await postJSON(
            "/users/me/devices",
            body: Body(pushToken: token, platform: "ios", deviceName: name),
            as: OkResponse.self
        )
    }

    func deleteDevice(token: String) async throws {
        try await deleteEmpty("/users/me/devices/\(token)")
    }

    // MARK: ViewBoard (Audit)

    func permissionAudit(channelId: String, limit: Int = 50) async throws -> [AuditEvent] {
        let query = [URLQueryItem(name: "limit", value: String(limit))]
        return try await getJSON("/channels/\(channelId)/permissions/audit", query: query, as: AuditResponse.self).events
    }

    // MARK: Sessions & bot settings

    func listSessions(channelId: String, botId: String) async throws -> [SessionInfo] {
        try await getJSON("/channels/\(channelId)/bots/\(botId)/sessions", as: SessionListResponse.self).sessions
    }

    func sessionControls(channelId: String, botId: String) async throws -> SessionControls {
        try await getJSON("/channels/\(channelId)/bots/\(botId)/session-controls", as: SessionControls.self)
    }

    func setSessionMode(channelId: String, botId: String, sessionId: String, mode: String) async throws {
        _ = try await postJSON("/channels/\(channelId)/bots/\(botId)/sessions/\(sessionId)/mode", body: ["mode": mode], as: OkResponse.self)
    }

    func setSessionConfig(channelId: String, botId: String, sessionId: String, configId: String, value: String) async throws {
        _ = try await postJSON(
            "/channels/\(channelId)/bots/\(botId)/sessions/\(sessionId)/config-option",
            body: SetConfigOptionRequest(configId: configId, value: value),
            as: OkResponse.self
        )
    }
}
