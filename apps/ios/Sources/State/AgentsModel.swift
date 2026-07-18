import Foundation
import Observation

/// Fleet observability: the bots the caller owns or shares a channel with, with
/// live online status from GET /bots.
@MainActor
@Observable
final class AgentsModel {
    private(set) var bots: [BotDto] = []
    private(set) var isLoading = false
    var errorMessage: String?

    @ObservationIgnored private weak var app: AppModel?

    func attach(_ app: AppModel) {
        self.app = app
    }

    var onlineCount: Int { bots.filter { $0.online }.count }
    var offlineCount: Int { bots.filter { !$0.online }.count }

    func loadIfNeeded() async {
        guard bots.isEmpty else { return }
        await load()
    }

    func load() async {
        guard let api = app?.api else { return }
        if bots.isEmpty { isLoading = true }
        defer { isLoading = false }
        errorMessage = nil
        do {
            bots = try await api.listBots()
        } catch let error as APIError {
            if case .unauthorized = error { app?.clearSession(); return }
            errorMessage = error.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
