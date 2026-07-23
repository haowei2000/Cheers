import Foundation
import Observation

struct UserSession: Equatable {
    let userId: String
    let displayName: String?
    let role: String
    let username: String?
}

/// Root app state: server config, auth session, and the shared realtime socket.
/// Token lives in the Keychain; non-secret session fields in UserDefaults.
@MainActor
@Observable
final class AppModel {
    static let defaultServerURL = "https://www.tocheers.com/api/v1"
    /// Public, production URLs. These must stay live and match the App Store
    /// Connect metadata before each submission.
    static let privacyPolicyURL = URL(string: "https://www.tocheers.com/privacy.html")!
    static let supportURL = URL(string: "https://www.tocheers.com/support.html")!
    static let remoteOperationSafetyURL = URL(string: "https://www.tocheers.com/remote-operations.html")!

    private enum Keys {
        static let token = "access_token"
        static let refreshToken = "refresh_token"
        static let serverURL = "server_url"
        static let userId = "user_id"
        static let displayName = "display_name"
        static let role = "role"
        static let username = "username"
    }

    var serverURLString: String
    var session: UserSession?
    var socketConnected = false

    let socket = ChatSocket()

    /// Per-channel chat models retained across switches — instant re-entry
    /// (see ChatModelStore). Cleared on sign-out.
    @ObservationIgnored
    let chatModels = ChatModelStore()

    /// Offline-first message cache (SwiftData) — instant history on relaunch.
    @ObservationIgnored
    let messageStore = MessageStore()

    @ObservationIgnored
    private var eventListeners: [UUID: (SocketEvent) -> Void] = [:]

    @ObservationIgnored
    private(set) var token: String?

    init() {
        let defaults = UserDefaults.standard
        serverURLString = defaults.string(forKey: Keys.serverURL) ?? Self.defaultServerURL
        token = KeychainStore.get(Keys.token)
        if let token, !token.isEmpty, let userId = defaults.string(forKey: Keys.userId) {
            session = UserSession(
                userId: userId,
                displayName: defaults.string(forKey: Keys.displayName),
                role: defaults.string(forKey: Keys.role) ?? "member",
                username: defaults.string(forKey: Keys.username)
            )
            _ = token // silence unused warning paths
        } else {
            token = nil
        }
        socket.onEvent = { [weak self] event in
            self?.dispatch(event)
        }
        if session != nil {
            if KeychainStore.get(Keys.refreshToken) != nil {
                Task { await restoreSession() }
            } else {
                connectSocket()
            }
        }
    }

    // MARK: API access

    var baseURL: URL? {
        APIClient.normalizeBaseURL(serverURLString)
    }

    /// Authenticated client for the current session.
    var api: APIClient? {
        guard let baseURL, token != nil else { return nil }
        return APIClient(baseURL: baseURL, token: token)
    }

    // MARK: Auth flows

    func login(server: String, login loginName: String, password: String) async throws {
        guard let base = APIClient.normalizeBaseURL(server) else {
            throw APIError.invalidBaseURL
        }
        let client = APIClient(baseURL: base, token: nil)
        let response = try await client.login(login: loginName, password: password)

        try finishLogin(base: base, response: response)
    }

    func appleCapabilities(server: String) async throws -> (AuthCapabilities, AppleChallenge?) {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        let client = APIClient(baseURL: base, token: nil)
        let capabilities = try await client.authCapabilities()
        let challenge = capabilities.signInWithApple ? try await client.appleChallenge() : nil
        return (capabilities, challenge)
    }

    func requestRegisterCode(server: String, email: String, inviteToken: String?) async throws {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        try await APIClient(baseURL: base, token: nil).requestRegisterCode(
            email: email,
            inviteToken: inviteToken
        )
    }

    func register(server: String, request: RegisterRequest) async throws {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        let response = try await APIClient(baseURL: base, token: nil).register(request)
        try finishLogin(base: base, response: response)
    }

    func loginWithApple(server: String, payload: AppleAuthorizationPayload) async throws {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        let response = try await APIClient(baseURL: base, token: nil).appleLogin(payload)
        try finishLogin(base: base, response: response)
    }

    private func finishLogin(base: URL, response: LoginResponse) throws {
        guard response.status != "factor_required",
              let accessToken = response.accessToken,
              let userId = response.userId,
              let role = response.role else {
            throw APIError.http(status: 401, detail: "Additional verification is required.")
        }
        serverURLString = base.absoluteString
        token = accessToken
        KeychainStore.set(accessToken, for: Keys.token)
        if let refreshToken = response.refreshToken {
            KeychainStore.set(refreshToken, for: Keys.refreshToken)
        }

        let defaults = UserDefaults.standard
        defaults.set(base.absoluteString, forKey: Keys.serverURL)
        defaults.set(userId, forKey: Keys.userId)
        defaults.set(response.displayName, forKey: Keys.displayName)
        defaults.set(role, forKey: Keys.role)
        defaults.set(response.username, forKey: Keys.username)

        session = UserSession(
            userId: userId,
            displayName: response.displayName,
            role: role,
            username: response.username
        )
        connectSocket()
    }

    private func restoreSession() async {
        guard let base = baseURL, let refreshToken = KeychainStore.get(Keys.refreshToken) else { return }
        do {
            let response = try await APIClient(baseURL: base, token: nil).refresh(refreshToken: refreshToken)
            try finishLogin(base: base, response: response)
        } catch {
            clearSession()
        }
    }

    func logout() async {
        if let api {
            // Best-effort: stop pushes for this device, then revoke the session
            // server-side; local sign-out proceeds regardless.
            await PushRouter.deleteRegistration(using: api)
            try? await api.logout()
        }
        clearSession()
    }

    /// Changes the password and replaces the locally held token. The gateway
    /// revokes every older session and push registration as part of this flow.
    func changePassword(currentPassword: String, newPassword: String) async throws {
        guard let api else { throw APIError.unauthorized }
        let response = try await api.changePassword(
            currentPassword: currentPassword,
            newPassword: newPassword
        )
        token = response.accessToken
        _ = KeychainStore.set(response.accessToken, for: Keys.token)
        socket.disconnect()
        socketConnected = false
        connectSocket()
        if let refreshedAPI = self.api {
            await PushRouter.reregisterCurrentDevice(using: refreshedAPI)
        }
    }

    /// Local sign-out (used on 401 / revoked token).
    func clearSession() {
        socket.disconnect()
        socketConnected = false
        chatModels.removeAll()
        Task { await messageStore.removeAll() }
        token = nil
        session = nil
        KeychainStore.remove(Keys.token)
        KeychainStore.remove(Keys.refreshToken)
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Keys.userId)
        defaults.removeObject(forKey: Keys.displayName)
        defaults.removeObject(forKey: Keys.role)
        defaults.removeObject(forKey: Keys.username)
    }

    // MARK: Socket

    func connectSocket() {
        guard let baseURL,
              let wsURL = APIClient.websocketURL(for: baseURL),
              let token else { return }
        socket.connect(url: wsURL, token: token)
    }

    /// Re-arms realtime when the socket is down: called on app foregrounding
    /// and pull-to-refresh so a long offline stretch (backoff waiting up to
    /// 30 s) recovers immediately instead of leaving stale data on screen.
    func reconnectSocketIfNeeded() {
        guard session != nil, !socketConnected else { return }
        connectSocket()
    }

    /// Fan-out: multiple models (conversation list + open chat) listen to the
    /// single shared socket.
    func addSocketListener(_ handler: @escaping (SocketEvent) -> Void) -> UUID {
        let id = UUID()
        eventListeners[id] = handler
        return id
    }

    func removeSocketListener(_ id: UUID) {
        eventListeners.removeValue(forKey: id)
    }

    private func dispatch(_ event: SocketEvent) {
        switch event {
        case .connected:
            socketConnected = true
        case .disconnected:
            socketConnected = false
        case .authFailed:
            socketConnected = false
            // Token rejected on the socket → treat as revoked session.
            clearSession()
        default:
            break
        }
        for handler in eventListeners.values {
            handler(event)
        }
    }
}
