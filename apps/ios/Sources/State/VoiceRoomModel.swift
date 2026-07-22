import Foundation
import LiveKit
import Observation

/// Owns one channel's media lifecycle. The gateway only mints a room-scoped
/// token; microphone media goes directly between this device and LiveKit.
@MainActor
@Observable
final class VoiceRoomModel {
    let channelId: String
    private(set) var isJoining = false
    private(set) var isConnected = false
    private(set) var micEnabled = false
    private(set) var canPublish = false
    private(set) var canManageTranscription = false
    private(set) var participantNames: [String] = []
    private(set) var transcripts: [VoiceTranscriptSegment] = []
    private(set) var transcriptionStatus = "off"
    var errorMessage: String?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var room: Room?
    @ObservationIgnored private var listenerId: UUID?
    @ObservationIgnored private var transcriptPoll: Task<Void, Never>?

    init(channelId: String) { self.channelId = channelId }

    func attach(_ app: AppModel) {
        self.app = app
        if listenerId == nil {
            listenerId = app.addSocketListener { [weak self] event in
                guard let self else { return }
                if case let .voiceTranscript(channelId, segment) = event, channelId == self.channelId {
                    self.upsertTranscript(segment)
                }
            }
        }
    }

    func refresh() async {
        guard let api = app?.api else { return }
        do {
            async let state = api.voiceState(channelId: channelId)
            async let rows = api.voiceTranscript(channelId: channelId)
            let resolvedState = try await state
            transcriptionStatus = resolvedState.session?.transcriptionStatus ?? "off"
            canManageTranscription = resolvedState.canManage
            transcripts = try await rows
        } catch {
            // Voice can be deliberately unavailable; joining shows the useful error.
        }
    }

    func join() async {
        guard !isJoining, !isConnected, let api = app?.api else { return }
        isJoining = true
        errorMessage = nil
        defer { isJoining = false }
        do {
            let grant = try await api.joinVoice(channelId: channelId)
            let newRoom = Room()
            room = newRoom
            try await newRoom.connect(url: grant.url, token: grant.token, connectOptions: ConnectOptions(enableMicrophone: grant.canPublish))
            isConnected = true
            canPublish = grant.canPublish
            micEnabled = grant.canPublish
            refreshParticipants()
            startPollingTranscript()
        } catch {
            errorMessage = error.localizedDescription
            await leave()
        }
    }

    func leave() async {
        transcriptPoll?.cancel()
        transcriptPoll = nil
        if let room {
            await room.disconnect()
        }
        room = nil
        isConnected = false
        micEnabled = false
        canPublish = false
        canManageTranscription = false
        participantNames = []
    }

    func toggleMicrophone() async {
        guard let room, canPublish else { return }
        do {
            let enabled = !micEnabled
            try await room.localParticipant.setMicrophone(enabled: enabled)
            micEnabled = enabled
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func acceptConsent() async {
        guard let api = app?.api else { return }
        do {
            let result = try await api.grantVoiceConsent(channelId: channelId)
            canPublish = result.canPublish
            // The gateway returns a fresh token with microphone grant. Reconnect
            // rather than attempting to mutate the existing token in-place.
            await leave()
            await join()
        } catch { errorMessage = error.localizedDescription }
    }

    func setTranscription(_ enabled: Bool) async {
        guard let api = app?.api else { return }
        do { transcriptionStatus = try await api.setVoiceTranscription(channelId: channelId, enabled: enabled).transcriptionStatus }
        catch { errorMessage = error.localizedDescription }
    }

    func detach() {
        if let listenerId, let app { app.removeSocketListener(listenerId) }
        listenerId = nil
        Task { await leave() }
    }

    private func refreshParticipants() {
        guard let room else { return }
        let localName = room.localParticipant.name
            ?? room.localParticipant.identity.map { String(describing: $0) }
            ?? "You"
        let remoteNames = room.remoteParticipants.values.map { participant in
            participant.name ?? participant.identity.map { String(describing: $0) } ?? "Participant"
        }
        participantNames = [localName] + remoteNames
    }

    private func startPollingTranscript() {
        transcriptPoll?.cancel()
        transcriptPoll = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                await self.fetchNewTranscript()
            }
        }
    }

    private func fetchNewTranscript() async {
        guard let api = app?.api else { return }
        let last = transcripts.map(\.channelSeq).max() ?? 0
        if let fresh = try? await api.voiceTranscript(channelId: channelId, afterSeq: last) {
            fresh.forEach(upsertTranscript)
        }
    }

    private func upsertTranscript(_ segment: VoiceTranscriptSegment) {
        guard !transcripts.contains(where: { $0.segmentId == segment.segmentId }) else { return }
        transcripts.append(segment)
        transcripts.sort { $0.channelSeq < $1.channelSeq }
    }
}
