import AVFoundation
import Foundation
import Speech
import SwiftUI

/// Growing multiline composer pinned to the bottom of the chat screen.
/// Uses native SwiftUI input, menu, list and button styles so interaction,
/// focus, disabled states and accessibility follow iOS automatically.
struct ComposerView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Draft and keyboard focus live inside this leaf view. A keystroke now
    /// invalidates only the composer subtree, never the chat timeline.
    @State private var text: String
    let clearTick: Int
    /// Bumped when an external prefill should update the live local draft.
    let prefillTick: Int
    let prefillText: String
    let prefillMention: MentionCandidate?
    let placeholder: String
    let isSending: Bool
    let onSend: (String) async -> Bool
    let channelId: String
    let api: APIClient?
    var onChooseSession: () -> Void = {}
    var onModelSettings: () -> Void = {}
    var onUploadFile: () -> Void = {}
    var onBrowseFiles: () -> Void = {}
    var onAddContext: () -> Void = {}
    /// "@" typeahead pool (group tokens + channel members) and the pick
    /// callback registering the selection for routing (ChatModel.pickedMentions).
    var mentionPool: [MentionCandidate] = []
    var onMentionPicked: (MentionCandidate) -> Void = { _ in }

    @FocusState private var isFocused: Bool
    @State private var dictation = ComposerDictationController()
    @State private var showMentionPicker = false
    @State private var mentionSearch = ""

    init(
        initialText: String,
        clearTick: Int,
        prefillTick: Int = 0,
        prefillText: String = "",
        prefillMention: MentionCandidate? = nil,
        placeholder: String,
        isSending: Bool,
        onSend: @escaping (String) async -> Bool,
        channelId: String,
        api: APIClient?,
        onChooseSession: @escaping () -> Void = {},
        onModelSettings: @escaping () -> Void = {},
        onUploadFile: @escaping () -> Void = {},
        onBrowseFiles: @escaping () -> Void = {},
        onAddContext: @escaping () -> Void = {},
        mentionPool: [MentionCandidate] = [],
        onMentionPicked: @escaping (MentionCandidate) -> Void = { _ in }
    ) {
        _text = State(initialValue: initialText)
        self.clearTick = clearTick
        self.prefillTick = prefillTick
        self.prefillText = prefillText
        self.prefillMention = prefillMention
        self.placeholder = placeholder
        self.isSending = isSending
        self.onSend = onSend
        self.channelId = channelId
        self.api = api
        self.onChooseSession = onChooseSession
        self.onModelSettings = onModelSettings
        self.onUploadFile = onUploadFile
        self.onBrowseFiles = onBrowseFiles
        self.onAddContext = onAddContext
        self.mentionPool = mentionPool
        self.onMentionPicked = onMentionPicked
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    // MARK: @-mention typeahead

    /// The active "@" token: the last "@" must start a word and the text after
    /// it must contain no whitespace. The caret is assumed to sit at the end of
    /// the draft — SwiftUI's TextField exposes no caret position, and appending
    /// is where mobile typing overwhelmingly happens.
    private var mentionToken: (range: Range<String.Index>, query: String)? {
        guard let atIndex = text.lastIndex(of: "@") else { return nil }
        if atIndex > text.startIndex, !text[text.index(before: atIndex)].isWhitespace {
            return nil
        }
        let query = text[text.index(after: atIndex)...]
        guard !query.contains(where: \.isWhitespace) else { return nil }
        return (atIndex..<text.endIndex, String(query))
    }

    private func pick(_ candidate: MentionCandidate) {
        guard let token = mentionToken else { return }
        text.replaceSubrange(token.range, with: "@\(candidate.label) ")
        onMentionPicked(candidate)
        showMentionPicker = false
        Task { @MainActor in
            await Task.yield()
            isFocused = true
        }
    }

    var body: some View {
        inputRow
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .onChange(of: clearTick) {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { text = "" }
        }
        .onChange(of: prefillTick) {
            guard prefillTick > 0 else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                if let prefillMention {
                    appendExternalMention(prefillMention)
                } else {
                    text = prefillText
                }
            }
            Task { @MainActor in
                await Task.yield()
                isFocused = true
            }
        }
        .onChange(of: text) { oldValue, newValue in
            guard newValue != oldValue,
                  newValue.last == "@",
                  mentionToken?.query.isEmpty == true,
                  !mentionPool.isEmpty else { return }
            presentMentionPicker()
        }
        .onChange(of: showMentionPicker) { _, isPresented in
            if !isPresented { mentionSearch = "" }
        }
    }

    private var mentionPickerSheet: some View {
        NavigationStack {
            Group {
                if filteredMentionPool.isEmpty {
                    ContentUnavailableView.search(text: mentionSearch)
                } else {
                    List {
                        if !filteredGroups.isEmpty {
                            Section("Groups") {
                                ForEach(filteredGroups) { candidate in
                                    mentionRow(candidate)
                                }
                            }
                        }
                        if !filteredBots.isEmpty {
                            Section("Bots") {
                                ForEach(filteredBots) { candidate in
                                    mentionRow(candidate)
                                }
                            }
                        }
                        if !filteredPeople.isEmpty {
                            Section("People") {
                                ForEach(filteredPeople) { candidate in
                                    mentionRow(candidate)
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Mention")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $mentionSearch, prompt: "Search people and groups")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showMentionPicker = false }
                }
            }
        }
    }

    private var filteredMentionPool: [MentionCandidate] {
        let query = mentionSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return mentionPool }
        return mentionPool.filter { candidate in
            candidate.label.localizedCaseInsensitiveContains(query)
                || (candidate.sublabel?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    private var filteredGroups: [MentionCandidate] {
        filteredMentionPool.filter { $0.kind == .group }
    }

    private var filteredBots: [MentionCandidate] {
        filteredMentionPool.filter { $0.kind == .bot }
    }

    private var filteredPeople: [MentionCandidate] {
        filteredMentionPool.filter { $0.kind == .user }
    }

    private func mentionRow(_ candidate: MentionCandidate) -> some View {
        Button {
            pick(candidate)
        } label: {
            HStack(spacing: Theme.space3) {
                mentionIcon(candidate)
                VStack(alignment: .leading, spacing: Theme.space1) {
                    Text("@\(candidate.label)")
                        .font(.body)
                        .foregroundStyle(candidate.kind == .bot && candidate.isOnline == false ? .secondary : .primary)
                    if let sublabel = candidate.sublabel, !sublabel.isEmpty {
                        Text(candidate.kind == .group ? sublabel : "@\(sublabel)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if candidate.kind == .bot {
                    Text(candidate.isOnline == false ? "OFFLINE" : "BOT")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(candidate.isOnline == false ? Theme.textFaint : .secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(candidate.kind == .bot && candidate.isOnline == false ? 0.55 : 1)
        .accessibilityLabel("Mention \(candidate.label)")
    }

    @ViewBuilder
    private func mentionIcon(_ candidate: MentionCandidate) -> some View {
        if candidate.kind == .group {
            Image(systemName: groupMentionIcon(candidate.id))
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 40, height: 40)
                .background(.quaternary, in: Circle())
                .accessibilityHidden(true)
        } else {
            AvatarView(
                seedId: candidate.id,
                name: candidate.label,
                size: 40,
                imageURL: resolveAvatarURL(candidate.avatarURL)
            )
        }
    }

    private func groupMentionIcon(_ id: String) -> String {
        switch id {
        case "all": return "person.3.fill"
        case "bots": return "cpu"
        case "humans": return "person.2.fill"
        case "here": return "location.fill"
        default: return "at"
        }
    }

    private func resolveAvatarURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        if let absolute = URL(string: raw), absolute.scheme != nil { return absolute }
        guard let base = api?.baseURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return URL(string: raw, relativeTo: components.url)?.absoluteURL
    }

    private var inputRow: some View {
        HStack(alignment: .center, spacing: 2) {
            Menu {
                Button { onUploadFile() } label: { Label("Upload file", systemImage: "paperclip") }
                Button { onBrowseFiles() } label: { Label("Channel files", systemImage: "folder") }
                Button { onAddContext() } label: { Label("Add context", systemImage: "link.badge.plus") }
                Divider()
                Button { onChooseSession() } label: { Label("Choose session", systemImage: "square.stack.3d.up") }
                Button { onModelSettings() } label: { Label("Model & bot settings", systemImage: "slider.horizontal.3") }
            } label: {
                Image(systemName: "plus")
                    .font(.title3.weight(.medium))
                    .frame(width: Theme.hitMin, height: Theme.hitMin)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add message options")

            TextField(placeholder, text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...8)
                .textFieldStyle(.plain)
                .padding(.vertical, 11)
                .frame(minHeight: Theme.hitMin, alignment: .center)
                .focused($isFocused)
                .accessibilityLabel(placeholder)

            Button {
                insertMention()
            } label: {
                Text("@")
                    .font(.title3.weight(.medium))
                    .frame(width: Theme.hitMin, height: Theme.hitMin)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Mention someone")
            .popover(
                isPresented: $showMentionPicker,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .bottom
            ) {
                mentionPickerSheet
                    .frame(idealWidth: 360, minHeight: 420)
                    .presentationCompactAdaptation(.popover)
            }
            .contextMenu {
                ForEach(mentionPool.filter { $0.kind == .group }) { candidate in
                    Button {
                        quickPick(candidate)
                    } label: {
                        Label("@\(candidate.label)", systemImage: groupMentionIcon(candidate.id))
                    }
                }
            }

            dictationButton

            Button {
                sendDraft()
            } label: {
                if isSending {
                    ProgressView()
                } else {
                    Image(systemName: "arrow.up")
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.circle)
            .controlSize(.large)
            .frame(width: Theme.hitMin, height: Theme.hitMin)
            .disabled(!canSend)
            .accessibilityLabel(primaryActionLabel)
        }
        .padding(6)
        .background(.regularMaterial, in: Capsule())
        .contentShape(Capsule())
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .alert("Voice dictation", isPresented: Binding(
            get: { dictation.errorMessage != nil },
            set: { if !$0 { dictation.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { dictation.errorMessage = nil }
        } message: {
            Text(dictation.errorMessage ?? "")
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { isFocused = false }
            }
        }
    }

    private var dictationButton: some View {
        Button {
            toggleDictation()
        } label: {
            if dictation.isWorking {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: dictation.isRecording ? "stop.circle.fill" : "mic")
                    .font(.title3)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(dictation.isRecording ? Color.red : Color.primary)
        .frame(width: Theme.hitMin, height: Theme.hitMin)
        .contentShape(Rectangle())
        .disabled(dictation.isWorking || api == nil)
        .accessibilityLabel(dictation.isRecording ? "Stop voice dictation" : "Start voice dictation")
    }

    private var primaryActionLabel: String {
        isSending ? "Sending message" : "Send message"
    }

    private func insertMention() {
        if !text.isEmpty, text.last?.isWhitespace != true {
            text += " "
        }
        text += "@"
        presentMentionPicker()
    }

    private func containsMention(_ candidate: MentionCandidate) -> Bool {
        let token = NSRegularExpression.escapedPattern(for: "@\(candidate.label)")
        let pattern = "(^|\\s)\(token)(?=$|\\s|[.,!?;:])"
        return text.range(of: pattern, options: .regularExpression) != nil
    }

    private func appendExternalMention(_ candidate: MentionCandidate) {
        if !containsMention(candidate) {
            if !text.isEmpty, text.last?.isWhitespace != true {
                text += " "
            }
            text += "@\(candidate.label) "
        }
        onMentionPicked(candidate)
    }

    private func presentMentionPicker() {
        guard !mentionPool.isEmpty else { return }
        isFocused = false
        showMentionPicker = true
    }

    private func quickPick(_ candidate: MentionCandidate) {
        if mentionToken == nil {
            if !text.isEmpty, text.last?.isWhitespace != true {
                text += " "
            }
            text += "@"
        }
        pick(candidate)
    }

    private func sendDraft() {
        guard canSend else { return }
        // Sending is an intentional completion point for a mobile draft. Clear
        // focus first so UIKit reliably dismisses the software keyboard.
        isFocused = false
        let draft = text
        Task {
            if await onSend(draft) {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { text = "" }
            }
        }
    }

    private func toggleDictation() {
        Task {
            await dictation.toggle(channelId: channelId, api: api) { transcript in
                let separator = text.isEmpty || text.last?.isWhitespace == true ? "" : " "
                // A final transcript can grow the multiline field by several
                // rows. Insert it without intermediate layout animations.
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    text += separator + transcript
                    isFocused = true
                }
            }
        }
    }
}

/// Captures one short composer utterance. A configured Gateway adapter is used
/// first so provider credentials never reach the phone; iOS Speech is only the
/// intentional no-adapter fallback. Neither path persists raw audio.
@MainActor
@Observable
private final class ComposerDictationController {
    private(set) var isRecording = false
    private(set) var isWorking = false
    var errorMessage: String?

    @ObservationIgnored private let audioEngine = AVAudioEngine()
    @ObservationIgnored private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognitionTask: SFSpeechRecognitionTask?
    @ObservationIgnored private var pcm = PCM16Accumulator()
    @ObservationIgnored private var usesServerAdapter = false
    @ObservationIgnored private var onTranscript: ((String) -> Void)?

    func toggle(channelId: String, api: APIClient?, onTranscript: @escaping (String) -> Void) async {
        if isRecording {
            await stop(channelId: channelId, api: api)
        } else {
            await start(channelId: channelId, api: api, onTranscript: onTranscript)
        }
    }

    private func start(channelId: String, api: APIClient?, onTranscript: @escaping (String) -> Void) async {
        guard let api else { return }
        errorMessage = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let capability = try await api.dictationCapability(channelId: channelId)
            usesServerAdapter = capability.adapterConfigured && capability.adapterKind == "stepfun"
            self.onTranscript = onTranscript
            pcm = PCM16Accumulator()

            if !usesServerAdapter {
                try await requestNativeSpeechPermission()
                let request = SFSpeechAudioBufferRecognitionRequest()
                request.shouldReportPartialResults = false
                if #available(iOS 13, *) { request.requiresOnDeviceRecognition = false }
                recognitionRequest = request
                let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
                    ?? SFSpeechRecognizer()
                guard let recognizer, recognizer.isAvailable else {
                    throw DictationError.speechUnavailable
                }
                recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                    guard let self else { return }
                    if let result, result.isFinal {
                        self.deliver(result.bestTranscription.formattedString)
                    } else if let error, self.isRecording {
                        self.errorMessage = error.localizedDescription
                    }
                }
            } else {
                try await requestMicrophonePermission()
            }

            try configureAudioAndStartTap()
            isRecording = true
        } catch {
            cleanup()
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func stop(channelId: String, api: APIClient?) async {
        guard isRecording else { return }
        isRecording = false
        let adapterAudio = usesServerAdapter ? pcm.data : Data()
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        recognitionRequest?.endAudio()
        if usesServerAdapter {
            isWorking = true
            defer { isWorking = false; cleanup() }
            guard !adapterAudio.isEmpty else {
                errorMessage = "No speech was captured. Please try again."
                return
            }
            do {
                guard let api else { return }
                deliver(try await api.dictate(channelId: channelId, pcm16: adapterAudio))
            } catch {
                errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        } else {
            // The recognizer delivers its final result asynchronously after endAudio.
            recognitionTask?.finish()
        }
    }

    private func configureAudioAndStartTap() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let input = audioEngine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            guard let self else { return }
            if self.usesServerAdapter {
                self.pcm.append(buffer)
            } else {
                self.recognitionRequest?.append(buffer)
            }
        }
        audioEngine.prepare()
        try audioEngine.start()
    }

    private func deliver(_ transcript: String) {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onTranscript?(trimmed)
        cleanup()
    }

    private func cleanup() {
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        isRecording = false
        usesServerAdapter = false
    }

    private func requestMicrophonePermission() async throws {
        let granted = await AVAudioApplication.requestRecordPermission()
        guard granted else { throw DictationError.microphoneDenied }
    }

    private func requestNativeSpeechPermission() async throws {
        try await requestMicrophonePermission()
        let status = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard status == .authorized else { throw DictationError.speechDenied }
    }

    private enum DictationError: LocalizedError {
        case microphoneDenied, speechDenied, speechUnavailable
        var errorDescription: String? {
            switch self {
            case .microphoneDenied: return "Allow microphone access in Settings to use voice dictation."
            case .speechDenied: return "Allow Speech Recognition in Settings to use the on-device dictation fallback."
            case .speechUnavailable: return "Speech Recognition is unavailable on this device right now."
            }
        }
    }
}

/// Thread-safe PCM conversion for StepFun: 16 kHz, mono, little-endian Int16.
/// The AudioEngine tap may run off the main actor, so this intentionally keeps
/// its mutable buffer behind a lock.
private final class PCM16Accumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    var data: Data { lock.withLock { storage } }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData else { return }
        let source = channels[0]
        let sourceCount = Int(buffer.frameLength)
        guard sourceCount > 0 else { return }
        let sourceRate = buffer.format.sampleRate
        let outputCount = max(1, Int((Double(sourceCount) * 16_000.0 / sourceRate).rounded()))
        var converted = Data(capacity: outputCount * MemoryLayout<Int16>.size)
        for outputIndex in 0..<outputCount {
            let sourceIndex = min(sourceCount - 1, Int(Double(outputIndex) * sourceRate / 16_000.0))
            let normalized = max(-1.0, min(1.0, source[sourceIndex]))
            var sample = Int16((normalized * Float(Int16.max)).rounded()).littleEndian
            withUnsafeBytes(of: &sample) { converted.append(contentsOf: $0) }
        }
        lock.withLock {
            guard storage.count + converted.count <= 8 * 1024 * 1024 else { return }
            storage.append(converted)
        }
    }
}
