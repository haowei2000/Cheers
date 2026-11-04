import Foundation
import Observation
import UIKit

struct UserSession: Equatable {
    let userId: String
    let displayName: String?
    let role: String
    let username: String?
    let avatarURL: String?
}

/// Intermediate login step when the account has 2FA enabled.
struct FactorChallenge: Equatable {
    let transactionId: String
    let allowedFactors: [String]
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
    static let termsURL = URL(string: "https://www.tocheers.com/terms.html")!
    static let supportURL = URL(string: "https://www.tocheers.com/support.html")!
    static let accountDeletionURL = URL(string: "https://www.tocheers.com/account-deletion.html")!
    static let remoteOperationSafetyURL = URL(string: "https://www.tocheers.com/remote-operations.html")!

    private enum Keys {
        static let token = "access_token"
        static let refreshToken = "refresh_token"
        static let trustedDevice = "trusted_device"
        static let serverURL = "server_url"
        static let userId = "user_id"
        static let displayName = "display_name"
        static let role = "role"
        static let username = "username"
        static let avatarURL = "avatar_url"
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

    /// Refresh tokens rotate on every use. Every credential replacement (timer,
    /// foreground, socket auth failure, API 401 retry, password change) runs as this
    /// one task; late callers await it instead of presenting a refresh token that is
    /// being rotated, which the gateway treats as reuse and revokes.
    @ObservationIgnored
    private var credentialTask: Task<Void, Never>?

    @ObservationIgnored
    private var lastSessionRefreshAt: Date?

    /// A rejected socket token cannot be reused while refresh is unavailable.
    @ObservationIgnored
    private var needsSocketAuthenticationRefresh = false

    init() {
        let defaults = UserDefaults.standard
        if ProcessInfo.processInfo.arguments.contains("-ui-testing-reset-session") {
            KeychainStore.remove(Keys.token)
            KeychainStore.remove(Keys.refreshToken)
            KeychainStore.remove(Keys.trustedDevice)
            [Keys.serverURL, Keys.userId, Keys.displayName, Keys.role, Keys.username, Keys.avatarURL]
                .forEach(defaults.removeObject(forKey:))
        }
        serverURLString = defaults.string(forKey: Keys.serverURL) ?? Self.defaultServerURL
        token = KeychainStore.get(Keys.token)
        if let token, !token.isEmpty, let userId = defaults.string(forKey: Keys.userId) {
            session = UserSession(
                userId: userId,
                displayName: defaults.string(forKey: Keys.displayName),
                role: defaults.string(forKey: Keys.role) ?? "member",
                username: defaults.string(forKey: Keys.username),
                avatarURL: defaults.string(forKey: Keys.avatarURL)
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
                Task { await refreshSessionIfNeeded(force: true) }
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
        guard let baseURL, let token else { return nil }
        let userId = session?.userId
        return APIClient(
            baseURL: baseURL,
            token: token,
            reauthenticate: { [weak self] rejected in
                await self?.reauthenticate(rejectedToken: rejected, userId: userId)
            },
            confirmIdentity: { [weak self] in
                await self?.confirmIdentity() ?? false
            }
        )
    }

    // MARK: Step-up

    /// A security-sensitive request is waiting for the user to confirm their
    /// identity (gateway 428 `recent_authentication_required`). RootView presents
    /// StepUpSheet while this is set.
    struct StepUpRequest: Identifiable, Equatable {
        let id = UUID()
    }

    private(set) var pendingStepUp: StepUpRequest?

    @ObservationIgnored
    private var stepUpWaiters: [CheckedContinuation<Bool, Never>] = []

    /// APIClient's 428 hook. Concurrent sensitive requests share one prompt and
    /// all retry once it is confirmed.
    func confirmIdentity() async -> Bool {
        guard session != nil else { return false }
        return await withCheckedContinuation { continuation in
            stepUpWaiters.append(continuation)
            if pendingStepUp == nil {
                pendingStepUp = StepUpRequest()
            }
        }
    }

    func finishStepUp(confirmed: Bool) {
        let waiters = stepUpWaiters
        stepUpWaiters = []
        pendingStepUp = nil
        for waiter in waiters {
            waiter.resume(returning: confirmed)
        }
    }

    /// APIClient's 401 hook: an expired access token gets one shared refresh, and
    /// the request retries with the session's current token. Signing out happens
    /// only when the refresh credential itself is rejected (or missing).
    func reauthenticate(rejectedToken: String, userId: String?) async -> String? {
        if let inFlight = credentialTask {
            await inFlight.value
        }
        guard let session, session.userId == userId else { return nil }
        if let token, token != rejectedToken { return token }
        guard KeychainStore.get(Keys.refreshToken) != nil else {
            clearSession()
            return nil
        }
        await refreshSessionIfNeeded(force: true)
        guard self.session?.userId == userId, let token, token != rejectedToken else { return nil }
        return token
    }

    /// Runs `operation` as the only credential replacement in flight.
    private func withCredentialGate<T: Sendable>(
        _ operation: @escaping @MainActor () async -> T
    ) async -> T {
        while let inFlight = credentialTask {
            await inFlight.value
        }
        let task = Task { await operation() }
        credentialTask = Task { _ = await task.value }
        defer { credentialTask = nil }
        return await task.value
    }

    // MARK: Auth flows

    /// Returns a factor challenge when 2FA is required; `nil` means the session is live.
    @discardableResult
    func login(server: String, login loginName: String, password: String) async throws -> FactorChallenge? {
        guard let base = APIClient.normalizeBaseURL(server) else {
            throw APIError.invalidBaseURL
        }
        let client = APIClient(baseURL: base, token: nil)
        let response = try await client.login(
            login: loginName,
            password: password,
            trustedDevice: KeychainStore.get(Keys.trustedDevice),
            deviceName: UIDevice.current.name
        )
        return try finishLoginOrChallenge(base: base, response: response)
    }

    func completeTwoFactorLogin(
        server: String,
        transactionId: String,
        code: String,
        method: String = "code",
        rememberDevice: Bool = true
    ) async throws {
        guard let base = APIClient.normalizeBaseURL(server) else {
            throw APIError.invalidBaseURL
        }
        let client = APIClient(baseURL: base, token: nil)
        let response = try await client.verifyTwoFactorLogin(
            transactionId: transactionId,
            code: code,
            method: method,
            rememberDevice: rememberDevice
        )
        _ = try finishLoginOrChallenge(base: base, response: response)
    }

    func completeTwoFactorPasskeyLogin(
        server: String,
        transactionId: String,
        credential: [String: Any],
        rememberDevice: Bool = true
    ) async throws {
        guard let base = APIClient.normalizeBaseURL(server) else {
            throw APIError.invalidBaseURL
        }
        let client = APIClient(baseURL: base, token: nil)
        let response = try await client.passkeyFactorVerify(
            transactionId: transactionId,
            credential: credential,
            rememberDevice: rememberDevice
        )
        _ = try finishLoginOrChallenge(base: base, response: response)
    }

    func appleCapabilities(server: String) async throws -> (AuthCapabilities, AppleChallenge?) {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        let client = APIClient(baseURL: base, token: nil)
        let capabilities = try await client.authCapabilities(client: "ios")
        let challenge = capabilities.signInWithApple ? try await client.appleChallenge() : nil
        return (capabilities, challenge)
    }

    func forgotPassword(server: String, email: String) async throws {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        try await APIClient(baseURL: base, token: nil).forgotPassword(email: email)
    }

    func resetPassword(server: String, email: String, code: String, newPassword: String) async throws {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        try await APIClient(baseURL: base, token: nil).resetPassword(
            email: email,
            code: code,
            newPassword: newPassword
        )
    }

    /// Exchanges the `cheers://` handoff code from Google OAuth for a session.
    @discardableResult
    func completeGoogleOAuth(server: String, callbackURL: URL) async throws -> FactorChallenge? {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty
        else {
            if let err = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "error" })?.value {
                throw APIError.http(status: 401, detail: err)
            }
            throw APIError.http(status: 401, detail: "Google sign-in did not return a code.")
        }
        let response = try await APIClient(baseURL: base, token: nil)
            .exchangeOAuthHandoff(
                code: code,
                client: "ios",
                trustedDevice: KeychainStore.get(Keys.trustedDevice)
            )
        return try finishLoginOrChallenge(base: base, response: response)
    }

    func startGoogleOAuth(server: String, deviceName: String?) async throws -> URL {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        let started = try await APIClient(baseURL: base, token: nil).startOAuth(
            provider: "google",
            client: "ios",
            deviceName: deviceName
        )
        guard let url = URL(string: started.authorizationURL) else {
            throw APIError.http(status: 500, detail: "Invalid Google authorization URL.")
        }
        return url
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
        _ = try finishLoginOrChallenge(base: base, response: response)
    }

    @discardableResult
    func loginWithApple(server: String, payload: AppleAuthorizationPayload) async throws -> FactorChallenge? {
        guard let base = APIClient.normalizeBaseURL(server) else { throw APIError.invalidBaseURL }
        var payload = payload
        if payload.trustedDevice == nil {
            payload.trustedDevice = KeychainStore.get(Keys.trustedDevice)
        }
        if payload.deviceName == nil {
            payload.deviceName = UIDevice.current.name
        }
        let response = try await APIClient(baseURL: base, token: nil).appleLogin(payload)
        return try finishLoginOrChallenge(base: base, response: response)
    }

    private func finishLoginOrChallenge(base: URL, response: LoginResponse) throws -> FactorChallenge? {
        if response.needsFactor {
            guard let transactionId = response.transactionId, !transactionId.isEmpty else {
                throw APIError.http(status: 401, detail: "Authentication transaction is missing.")
            }
            return FactorChallenge(
                transactionId: transactionId,
                allowedFactors: response.allowedFactors ?? ["totp", "recovery_code"]
            )
        }
        try finishLogin(base: base, response: response)
        return nil
    }

    private func finishLogin(base: URL, response: LoginResponse) throws {
        guard let accessToken = response.accessToken,
              let userId = response.userId,
              let role = response.role else {
            throw APIError.http(status: 401, detail: "Login response is incomplete.")
        }
        serverURLString = base.absoluteString
        token = accessToken
        KeychainStore.set(accessToken, for: Keys.token)
        if let refreshToken = response.refreshToken {
            KeychainStore.set(refreshToken, for: Keys.refreshToken)
        }
        if let trusted = response.trustedDevice, !trusted.isEmpty {
            KeychainStore.set(trusted, for: Keys.trustedDevice)
        }

        let defaults = UserDefaults.standard
        defaults.set(base.absoluteString, forKey: Keys.serverURL)
        defaults.set(userId, forKey: Keys.userId)
        defaults.set(response.displayName, forKey: Keys.displayName)
        defaults.set(role, forKey: Keys.role)
        defaults.set(response.username, forKey: Keys.username)

        let persistedAvatarURL = session?.userId == userId ? session?.avatarURL : nil
        session = UserSession(
            userId: userId,
            displayName: response.displayName,
            role: role,
            username: response.username,
            avatarURL: persistedAvatarURL
        )
        needsSocketAuthenticationRefresh = false
        lastSessionRefreshAt = Date()
        if socket.isAuthed {
            socket.refreshAuthentication(token: accessToken)
        } else {
            connectSocket()
        }
    }

    /// Rotates the native refresh token before the ten-minute access token expires.
    /// Web and macOS use the same eight-minute cadence. Transient network failures keep
    /// the local session so a later timer/foreground wakeup can retry; only a rejected
    /// refresh credential signs the user out.
    func refreshSessionIfNeeded(force: Bool = false) async {
        if let inFlight = credentialTask {
            await inFlight.value
            return
        }
        guard let session, let base = baseURL else { return }
        guard let refreshToken = KeychainStore.get(Keys.refreshToken) else {
            if needsSocketAuthenticationRefresh {
                clearSession()
            }
            return
        }
        if !force, !needsSocketAuthenticationRefresh,
           let lastSessionRefreshAt,
           Date().timeIntervalSince(lastSessionRefreshAt) < 8 * 60 {
            return
        }

        let attemptedToken = token
        let isCurrentRefresh = {
            self.session?.userId == session.userId
                && self.baseURL == base
                && self.token == attemptedToken
                && KeychainStore.get(Keys.refreshToken) == refreshToken
        }
        await withCredentialGate {
            do {
                let response = try await APIClient(baseURL: base, token: nil).refresh(refreshToken: refreshToken)
                guard isCurrentRefresh() else { return }
                try self.finishLogin(base: base, response: response)
            } catch APIError.http(let status, _) where status == 401 {
                guard isCurrentRefresh() else { return }
                self.clearSession()
            } catch {
                guard isCurrentRefresh() else { return }
                // Offline/server failures are retryable. Keep using the current access
                // token only if the socket has not rejected it; otherwise the next
                // minute/foreground check retries refresh before connecting again.
                self.reconnectSocketIfNeeded()
            }
        }
    }

    /// One-minute checks make a failed eight-minute refresh retry before the access
    /// token's ten-minute expiry. SwiftUI cancels this task automatically on sign-out.
    func runSessionRefreshLoop() async {
        while !Task.isCancelled, session != nil {
            do {
                try await Task.sleep(for: .seconds(60))
            } catch {
                return
            }
            await refreshSessionIfNeeded()
        }
    }

    func logout() async {
        if let api {
            // Best-effort: stop pushes for this device, then revoke the session
            // server-side; local sign-out proceeds regardless.
            await PushRouter.deleteRegistration(using: api)
            try? await api.logout()
        }
        clearSession(forgetDevice: true)
    }

    /// Changes the password and adopts the reissued session (access + refresh
    /// token). The gateway revokes every older session and push registration.
    func changePassword(
        currentPassword: String,
        newPassword: String,
        twoFactorCode: String? = nil
    ) async throws {
        for attempt in 0..<2 {
            guard let base = baseURL, let token else { throw APIError.unauthorized }
            // The gateway kicks this user's sockets before it answers. Run inside the
            // credential gate so the socket's auth failure waits for the reissued
            // session instead of spending the refresh token the server is revoking.
            // The client has no 401 hook: reauthenticating would wait on this gate.
            let outcome: Result<Void, Error> = await withCredentialGate {
                do {
                    let response = try await APIClient(baseURL: base, token: token).changePassword(
                        currentPassword: currentPassword,
                        newPassword: newPassword,
                        twoFactorCode: twoFactorCode
                    )
                    self.socket.disconnect()
                    self.socketConnected = false
                    try self.finishLogin(base: base, response: response)
                    return .success(())
                } catch {
                    return .failure(error)
                }
            }
            switch outcome {
            case .success:
                if let refreshedAPI = self.api {
                    await PushRouter.reregisterCurrentDevice(using: refreshedAPI)
                }
                return
            case .failure(let error):
                if attempt == 0, case APIError.unauthorized = error,
                   await reauthenticate(rejectedToken: token, userId: session?.userId) != nil {
                    continue
                }
                if needsSocketAuthenticationRefresh {
                    await refreshSessionIfNeeded(force: true)
                }
                throw error
            }
        }
    }

    /// Local sign-out (used on 401 / invalidated token).
    func clearSession(forgetDevice: Bool = false) {
        finishStepUp(confirmed: false)
        NavigationCache.removeAll(userId: session?.userId, server: serverURLString)
        socket.disconnect()
        socketConnected = false
        chatModels.removeAll()
        Task { await messageStore.removeAll() }
        token = nil
        session = nil
        needsSocketAuthenticationRefresh = false
        lastSessionRefreshAt = nil
        KeychainStore.remove(Keys.token)
        KeychainStore.remove(Keys.refreshToken)
        if forgetDevice {
            KeychainStore.remove(Keys.trustedDevice)
        }
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Keys.userId)
        defaults.removeObject(forKey: Keys.displayName)
        defaults.removeObject(forKey: Keys.role)
        defaults.removeObject(forKey: Keys.username)
        defaults.removeObject(forKey: Keys.avatarURL)
    }

    /// Clears the session and remembered server URL so Login shows the server field.
    func switchServer() async {
        await logout()
        serverURLString = Self.defaultServerURL
        UserDefaults.standard.removeObject(forKey: Keys.serverURL)
    }

    /// Updates the in-memory + persisted profile fields used outside the edit sheet.
    func applyProfile(displayName: String?, avatarURL: String?) {
        guard let session else { return }
        let trimmed = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = (trimmed?.isEmpty == false) ? trimmed : nil
        self.session = UserSession(
            userId: session.userId,
            displayName: next,
            role: session.role,
            username: session.username,
            avatarURL: avatarURL
        )
        UserDefaults.standard.set(next, forKey: Keys.displayName)
        UserDefaults.standard.set(avatarURL, forKey: Keys.avatarURL)
    }

    func applyProfileAvatarURL(_ avatarURL: String?) {
        applyProfile(displayName: session?.displayName, avatarURL: avatarURL)
    }

    func resolveServerResourceURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        if let absolute = URL(string: raw), absolute.scheme != nil { return absolute }
        guard let baseURL,
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return URL(string: raw, relativeTo: components.url)?.absoluteURL
    }

    // MARK: Socket

    func connectSocket() {
        guard !needsSocketAuthenticationRefresh,
              let baseURL,
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

    /// iOS may suspend a websocket without delivering a timely close callback.
    /// Re-open it on foreground even when the last observed flag still says
    /// connected; desired channel subscriptions are retained and replayed.
    func resumeRealtimeAfterForeground() {
        guard session != nil else { return }
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
            needsSocketAuthenticationRefresh = true
            Task { [weak self] in
                await self?.refreshSessionIfNeeded(force: true)
            }
        default:
            break
        }
        for handler in eventListeners.values {
            handler(event)
        }
    }
}
