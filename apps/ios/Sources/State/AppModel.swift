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

    private enum Keys {
        static let token = "access_token"
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
            connectSocket()
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

        serverURLString = base.absoluteString
        token = response.accessToken
        KeychainStore.set(response.accessToken, for: Keys.token)

        let defaults = UserDefaults.standard
        defaults.set(base.absoluteString, forKey: Keys.serverURL)
        defaults.set(response.userId, forKey: Keys.userId)
        defaults.set(response.displayName, forKey: Keys.displayName)
        defaults.set(response.role, forKey: Keys.role)
        defaults.set(loginName, forKey: Keys.username)

        session = UserSession(
            userId: response.userId,
            displayName: response.displayName,
            role: response.role,
            username: loginName
        )
        connectSocket()
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

    /// Local sign-out (used on 401 / revoked token).
    func clearSession() {
        socket.disconnect()
        socketConnected = false
        chatModels.removeAll()
        token = nil
        session = nil
        KeychainStore.remove(Keys.token)
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
