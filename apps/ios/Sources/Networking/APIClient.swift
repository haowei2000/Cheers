import Foundation

// MARK: - Errors

enum APIError: LocalizedError {
    case invalidBaseURL
    case unauthorized
    case http(status: Int, detail: String?)
    case transport(Error)
    case decoding(Error)

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
        return URL(string: text)
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
            // 401 means "session revoked/expired" only on authenticated calls.
            // Unauthenticated ones (login) must surface the server's detail
            // ("invalid credentials", 429-style lockout text) instead of the
            // misleading "Session expired" copy.
            if http.statusCode == 401, token != nil {
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

    func postEmpty(_ path: String) async throws {
        let request = try makeRequest("POST", path, body: Data("{}".utf8))
        _ = try await send(request)
    }

    // MARK: Auth

    func login(login loginName: String, password: String) async throws -> LoginResponse {
        // Unauthenticated call — token intentionally ignored by the server here.
        try await postJSON("/auth/login", body: LoginRequest(login: loginName, password: password), as: LoginResponse.self)
    }

    func logout() async throws {
        try await postEmpty("/auth/logout")
    }

    // MARK: Workspaces / channels

    func listWorkspaces() async throws -> [WorkspaceDto] {
        try await getJSON("/workspaces", as: [WorkspaceDto].self)
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
}
