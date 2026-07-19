import Foundation

// MARK: - Wire payloads (gateway/src/gateway/realtime/frame.rs)

struct StreamDelta: Decodable {
    let msgId: String
    let delta: String

    enum CodingKeys: String, CodingKey {
        case msgId = "msg_id"
        case delta
    }
}

struct DeletedPayload: Decodable {
    let msgId: String

    enum CodingKeys: String, CodingKey {
        case msgId = "msg_id"
    }
}

struct PresencePayload: Decodable {
    let channelId: String?
    let onlineUserIds: [String]?
    let onlineBotIds: [String]?
    let count: Int?

    enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case onlineUserIds = "online_user_ids"
        case onlineBotIds = "online_bot_ids"
        case count
    }
}

/// Events surfaced to the app layer, always on the main actor.
enum SocketEvent {
    case connected
    case authFailed(String)
    case subscribed(channelId: String)
    case message(channelId: String, MessageDto)
    case messageStream(channelId: String, msgId: String, delta: String)
    case messageDone(channelId: String, MessageDto)
    case messageDeleted(channelId: String, msgId: String)
    case presence(channelId: String, PresencePayload)
    /// A data-free "this board changed" tick; consumers re-pull through their own
    /// authz'd resource read. `board` ∈ plan/cost/commands/files/workspace…
    case boardSignal(channelId: String, board: String)
    case disconnected
}

enum ResourceError: Error, LocalizedError {
    case notConnected
    case timeout
    case server(code: String?, message: String?)

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Realtime connection is down"
        case .timeout: return "The server didn't answer in time"
        case .server(_, let message): return message ?? "Request failed"
        }
    }
}

// MARK: - Socket client
//
// Protocol (GET /ws, JSON text frames — see gateway/src/gateway/ws/browser.rs):
//   1. connect, send {"type":"auth","token":...} within 10 s
//   2. on {"type":"auth_ok"} send {"type":"subscribe","channel_id":...} per channel
//   3. on {"type":"subscribed"} the app RESTs ?since_seq= to heal any gap
// Close codes: 4401 auth, 4403 not member, 4408 backpressure (catch up + resubscribe).
// Reconnect: exponential backoff 1 s → 30 s. Unlike the web client's 10-retry
// budget (masked there by natural page reloads), attempts are NOT capped —
// a phone offline for a few minutes must pick realtime back up on its own.
// Foregrounding and pull-to-refresh additionally force an immediate attempt
// via AppModel.reconnectSocketIfNeeded().

@MainActor
final class ChatSocket: NSObject {
    private(set) var isAuthed = false

    var onEvent: ((SocketEvent) -> Void)?

    private var url: URL?
    private var token: String?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var subscriptions: Set<String> = []
    private var retryCount = 0
    private var intentionallyClosed = false

    private lazy var session = URLSession(configuration: .default)

    // MARK: Lifecycle

    func connect(url: URL, token: String) {
        self.url = url
        self.token = token
        intentionallyClosed = false
        retryCount = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        openSocket()
    }

    func disconnect() {
        intentionallyClosed = true
        reconnectTask?.cancel()
        reconnectTask = nil
        teardownSocket(code: .normalClosure)
        subscriptions.removeAll()
    }

    func subscribe(channelId: String) {
        subscriptions.insert(channelId)
        if isAuthed {
            sendJSON(["type": "subscribe", "channel_id": channelId])
        }
    }

    func unsubscribe(channelId: String) {
        subscriptions.remove(channelId)
        if isAuthed {
            sendJSON(["type": "unsubscribe", "channel_id": channelId])
        }
    }

    /// Replaces the desired subscription set (conversation list calls this on
    /// every reload). Replacing — instead of only ever adding — prunes channels
    /// the user left; replaying one of those after a reconnect makes the server
    /// close the whole connection with 4403.
    func resetSubscriptions(to channelIds: Set<String>) {
        let removed = subscriptions.subtracting(channelIds)
        let added = channelIds.subtracting(subscriptions)
        subscriptions = channelIds
        if isAuthed {
            for channelId in removed {
                sendJSON(["type": "unsubscribe", "channel_id": channelId])
            }
            for channelId in added {
                sendJSON(["type": "subscribe", "channel_id": channelId])
            }
        }
    }

    // MARK: Resource requests (request/response over the socket)
    //
    // Four of the five ViewBoard boards are served by WS "resource verbs", not
    // REST: send {"type":"resource_req","req_id":…,"resource":…,"params":…} and
    // correlate the {"type":"resource_res","req_id":…} reply. 15 s timeout,
    // matching the web client.

    private var pendingResources: [String: CheckedContinuation<JSONValue, Error>] = [:]

    func request(resource: String, params: [String: Any]) async throws -> JSONValue {
        guard isAuthed else { throw ResourceError.notConnected }
        let reqId = UUID().uuidString

        let value: JSONValue = try await withCheckedThrowingContinuation { continuation in
            pendingResources[reqId] = continuation
            sendJSON([
                "type": "resource_req",
                "req_id": reqId,
                "resource": resource,
                "params": params,
            ])
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self else { return }
                if let pending = self.pendingResources.removeValue(forKey: reqId) {
                    pending.resume(throwing: ResourceError.timeout)
                }
            }
        }
        return value
    }

    /// Any pending resource call dies with the connection — its req_id will
    /// never be answered on a new socket.
    private func failPendingResources(_ error: ResourceError) {
        let pending = pendingResources
        pendingResources.removeAll()
        for (_, continuation) in pending {
            continuation.resume(throwing: error)
        }
    }

    // MARK: Connection internals

    private func openSocket() {
        guard let url else { return }
        teardownSocket(code: nil)
        isAuthed = false

        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()

        // First frame must be auth (10 s server deadline).
        if let token {
            sendJSON(["type": "auth", "token": token])
        }

        receiveTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }
    }

    private func teardownSocket(code: URLSessionWebSocketTask.CloseCode?) {
        receiveTask?.cancel()
        receiveTask = nil
        pingTask?.cancel()
        pingTask = nil
        if let code {
            task?.cancel(with: code, reason: nil)
        } else {
            task?.cancel(with: .goingAway, reason: nil)
        }
        task = nil
        isAuthed = false
        failPendingResources(.notConnected)
    }

    private func scheduleReconnect() {
        guard !intentionallyClosed else { return }
        guard reconnectTask == nil else { return }
        retryCount += 1
        // 1s, 2s, 4s, ... capped at 30s; attempts are never capped (see header).
        let delay = min(30.0, pow(2.0, Double(min(retryCount, 6) - 1)))
        onEvent?(.disconnected)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.reconnectTask = nil
            self.openSocket()
        }
    }

    private func startPinging() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let self, !Task.isCancelled else { return }
                self.sendJSON(["type": "ping"])
            }
        }
    }

    // MARK: Send / receive

    private func sendJSON(_ object: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            if error != nil {
                Task { @MainActor in
                    self?.scheduleReconnect()
                }
            }
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        while !Task.isCancelled && self.task === task {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    handleFrame(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        handleFrame(text)
                    }
                @unknown default:
                    break
                }
            } catch {
                if self.task === task && !Task.isCancelled {
                    if task.closeCode.rawValue == 4403 {
                        // "not a channel member": one stale subscription would
                        // otherwise be replayed after every reconnect, closing
                        // the socket in a loop. Drop the set — attached models
                        // re-subscribe what they still need on .connected.
                        subscriptions.removeAll()
                    }
                    scheduleReconnect()
                }
                return
            }
        }
    }

    // MARK: Frame handling

    private struct FrameHead: Decodable {
        let type: String
        let channelId: String?
        let reason: String?
        let detail: String?

        enum CodingKeys: String, CodingKey {
            case type
            case channelId = "channel_id"
            case reason
            case detail
        }
    }

    private struct DataEnvelope<T: Decodable>: Decodable {
        let data: T
    }

    private struct ResourceResFrame: Decodable {
        let reqId: String
        let ok: Bool
        let data: JSONValue?
        let code: String?
        let error: String?

        enum CodingKeys: String, CodingKey {
            case reqId = "req_id"
            case ok, data, code, error
        }
    }

    private struct BoardSignalPayload: Decodable {
        let board: String?
    }

    private func handleFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let head = try? JSONDecoder().decode(FrameHead.self, from: data) else { return }

        switch head.type {
        // ---- Control frames (ServerControl) ----
        case "auth_ok":
            isAuthed = true
            retryCount = 0
            startPinging()
            onEvent?(.connected)
            for channelId in subscriptions {
                sendJSON(["type": "subscribe", "channel_id": channelId])
            }
        case "auth_err":
            isAuthed = false
            intentionallyClosed = true
            onEvent?(.authFailed(head.reason ?? "authentication failed"))
        case "subscribed":
            if let channelId = head.channelId {
                onEvent?(.subscribed(channelId: channelId))
            }
        case "unsubscribed", "pong":
            break
        case "error":
            break

        // ---- Event envelope frames (WireFrame) ----
        case "message":
            if let channelId = head.channelId,
               let payload = try? JSONDecoder().decode(DataEnvelope<MessageDto>.self, from: data) {
                onEvent?(.message(channelId: channelId, payload.data))
            }
        case "message_stream":
            if let channelId = head.channelId,
               let payload = try? JSONDecoder().decode(DataEnvelope<StreamDelta>.self, from: data) {
                onEvent?(.messageStream(channelId: channelId, msgId: payload.data.msgId, delta: payload.data.delta))
            }
        case "message_done":
            if let channelId = head.channelId,
               let payload = try? JSONDecoder().decode(DataEnvelope<MessageDto>.self, from: data) {
                onEvent?(.messageDone(channelId: channelId, payload.data))
            }
        case "message_deleted":
            if let channelId = head.channelId,
               let payload = try? JSONDecoder().decode(DataEnvelope<DeletedPayload>.self, from: data) {
                onEvent?(.messageDeleted(channelId: channelId, msgId: payload.data.msgId))
            }
        case "presence":
            if let channelId = head.channelId,
               let payload = try? JSONDecoder().decode(DataEnvelope<PresencePayload>.self, from: data) {
                onEvent?(.presence(channelId: channelId, payload.data))
            }
        case "resource_res":
            if let frame = try? JSONDecoder().decode(ResourceResFrame.self, from: data),
               let continuation = pendingResources.removeValue(forKey: frame.reqId) {
                if frame.ok {
                    continuation.resume(returning: frame.data ?? .null)
                } else {
                    continuation.resume(throwing: ResourceError.server(code: frame.code, message: frame.error))
                }
            }
        case "board_signal":
            if let channelId = head.channelId,
               let payload = try? JSONDecoder().decode(DataEnvelope<BoardSignalPayload>.self, from: data),
               let board = payload.data.board {
                onEvent?(.boardSignal(channelId: channelId, board: board))
            }

        default:
            // bot_trace / workspace_signal / file_transcribed — not needed yet.
            break
        }
    }
}
