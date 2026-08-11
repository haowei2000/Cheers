import SwiftUI
import UIKit
import os
import UniformTypeIdentifiers

private let timelinePerformanceSignposter = OSSignposter(
    subsystem: "app.cheers.ios",
    category: "TimelinePerformance"
)

enum AttachmentUploadPolicy {
    /// Matches the gateway's explicit top-level request body limit.
    static let maximumByteCount: Int64 = 16 * 1024 * 1024

    static func validate(byteCount: Int64) throws {
        guard byteCount > 0 else { throw AttachmentUploadError.empty }
        guard byteCount <= maximumByteCount else {
            throw AttachmentUploadError.tooLarge(maximumByteCount: maximumByteCount)
        }
    }
}

enum AttachmentUploadError: LocalizedError, Equatable {
    case empty
    case unreadable
    case tooLarge(maximumByteCount: Int64)

    var errorDescription: String? {
        switch self {
        case .empty:
            return String(localized: "The selected file is empty.")
        case .unreadable:
            return String(localized: "Cheers cannot read the selected file. Check its access permissions and try again.")
        case .tooLarge(let maximumByteCount):
            let limit = ByteCountFormatter.string(fromByteCount: maximumByteCount, countStyle: .file)
            return String(localized: "The selected file is too large. Choose a file no larger than \(limit).")
        }
    }
}

/// Channel header surfaces, mirroring the web channel header. Every ⋯-menu item
/// opens a bottom SHEET (modal "peek" surfaces) — pushed pages are reserved for
/// drawer destinations, so the menu's presentation stays consistent.
enum ChannelPanel: String, Identifiable {
    case members = "Members"
    case viewboard = "ViewBoard"
    case workbench = "Workbench"
    case remoteWorkspace = "Remote workspace"
    case taskClaims = "Task claims"
    case settings = "Channel settings"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .members: return "person.2"
        case .viewboard: return "rectangle.3.group"
        case .workbench: return "sidebar.right"
        case .remoteWorkspace: return "externaldrive.connected.to.line.below"
        case .taskClaims: return "checkmark.seal"
        case .settings: return "gearshape"
        }
    }
    var blurb: String {
        switch self {
        case .members: return "People and bots in this channel."
        case .viewboard: return "Live plan, cost, sessions and audit for this channel's agents (the instrument plane)."
        case .workbench: return "The channel's file workspace."
        case .remoteWorkspace: return "Browse an agent's live workspace and Git state."
        case .taskClaims: return "Pending proactive work proposals and monitoring settings."
        case .settings: return "Name, purpose, invites, membership and the danger zone."
        }
    }
}

private struct ChannelMessageSearchSheet: View {
    @Environment(\.dismiss) private var dismiss

    let channel: ChannelDto
    let members: [ChannelMemberDto]
    let api: APIClient?
    let onSelect: (MessageDto) -> Void

    @State private var query = ""
    @State private var results: [MessageDto] = []
    @State private var isSearching = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Group {
                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView(
                        "Search messages",
                        systemImage: "magnifyingglass",
                        description: Text("Search the full history of #\(channel.displayName).")
                    )
                } else if isSearching && results.isEmpty {
                    ProgressView("Searching…")
                } else if let errorText, results.isEmpty {
                    ContentUnavailableView(
                        "Search unavailable",
                        systemImage: "exclamationmark.magnifyingglass",
                        description: Text(errorText)
                    )
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    List(results) { message in
                        Button {
                            onSelect(message)
                            dismiss()
                        } label: {
                            searchResultRow(message)
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Search in #\(channel.displayName)")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task(id: query) {
            await search()
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private func searchResultRow(_ message: MessageDto) -> some View {
        let member = members.first { $0.memberId == message.senderId }
        return HStack(alignment: .top, spacing: 12) {
            AvatarView(
                seedId: message.senderId ?? message.msgId,
                name: message.senderName,
                size: 36,
                monochrome: true,
                imageURL: member?.avatarUrl.flatMap(URL.init(string:))
            )
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(message.senderName ?? member?.name ?? "Unknown")
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let date = message.createdDate {
                        Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(message.content)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 4)
    }

    private func search() async {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            results = []
            errorText = nil
            isSearching = false
            return
        }

        do {
            try await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            isSearching = true
            errorText = nil
            guard let api else {
                results = []
                errorText = "Connect to Cheers before searching."
                isSearching = false
                return
            }
            let response = try await api.searchMessages(channelId: channel.channelId, query: value)
            guard !Task.isCancelled else { return }
            results = Array(response.messages.reversed())
            isSearching = false
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            results = []
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            isSearching = false
        }
    }
}

/// Immutable presentation records consumed by the UIKit timeline. Identity is
/// stable by message id; equality includes the rendered content so the
/// diffable data source reconfigures only rows that actually changed.
private enum ChatTimelineItem: Identifiable, Hashable {
    case loadOlder(isLoading: Bool)
    case day(label: String, key: String)
    case system(MessageDto)
    case bubble(
        MessageDto,
        traceEvents: [TraceEventDto],
        isOwn: Bool,
        showAvatar: Bool,
        /// Among siblings at this depth (roots or reply children): last one
        /// gets the wide trailing gap / L-rail stop.
        isLastSibling: Bool,
        /// True when this message has nested reply children in the timeline.
        hasReplyChildren: Bool,
        formattedTime: String,
        repliedTo: MessageDto?,
        /// Nesting depth under a reply parent (0 = top-level root).
        depth: Int,
        /// Parent is in the loaded window — skip the quote strip.
        hideReplyQuote: Bool
    )

    var id: String {
        switch self {
        case .loadOlder: return "load-older"
        case .day(_, let key): return "day-\(key)"
        case .system(let message): return "sys-\(message.msgId)"
        case .bubble(let message, _, _, _, _, _, _, _, _, _): return message.msgId
        }
    }
}

struct ChatView: View {
    @Environment(AppModel.self) private var app
    @State private var model: ChatModel
    @State private var panel: ChannelPanel?
    @State private var forwardMessage: MessageDto?
    @State private var previewFile: MessageFileRef?
    @State private var showSessionSheet = false
    @State private var showModelSheet = false
    @State private var showFileImporter = false
    @State private var showChannelFiles = false
    @State private var showResourceContext = false
    @State private var showMessageSearch = false
    @State private var isUploading = false
    @State private var uploadTask: Task<Void, Never>?
    @State private var uploadingFilename: String?
    @State private var voice: VoiceRoomModel
    @State private var reportTarget: MessageDto?
    @State private var blockTarget: MessageDto?
    /// Grouping the timeline involves date parsing and neighbour comparisons.
    /// Cache that presentation model and rebuild it only when messages (or the
    /// identity used for "own" bubbles) actually change.
    @State private var messageItems: [ChatTimelineItem] = []
    /// Whether the message list is parked at the bottom (drives auto-follow).
    @State private var atBottom = true
    @State private var manualBottomTick = 0
    @State private var jumpTargetId: String?
    @State private var jumpTargetTick = 0
    /// Deep-link into Agent steps for a specific approval request (from ViewBoard Audit).
    @State private var focusTraceMsgId: String?
    @State private var focusTraceRequestId: String?
    private let listModel: ConversationListModel?

    /// `model` comes from AppModel.chatModels so history survives channel
    /// switches — creating a fresh ChatModel here would cold-reload every entry.
    init(model: ChatModel, listModel: ConversationListModel? = nil) {
        _model = State(initialValue: model)
        _voice = State(initialValue: VoiceRoomModel(channelId: model.channel.channelId))
        self.listModel = listModel
    }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            if model.channel.isVoice {
                VoiceMeetingStrip(voice: voice)
            }
            if model.channel.isDiscuss {
                DiscussionChannelView(model: model, currentUserId: app.session?.userId) {
                    composerDock
                }
            } else {
                messageScroll
            }
            TaskClaimsPanelView(model: model)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !model.channel.isDiscuss {
                composerDock
            }
        }
        .background(Theme.bgApp)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                header
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showMessageSearch = true
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .accessibilityLabel("Search messages")
                moreMenu
            }
        }
        .task {
            model.attach(app)
            if model.channel.isVoice {
                voice.attach(app)
                await voice.refresh()
            }
            listModel?.openChannelId = model.channel.channelId
            listModel?.markRead(channelId: model.channel.channelId)
            await model.loadInitial()
        }
        .onChange(of: model.messages) { rebuildMessageItems() }
        .onChange(of: model.traceRevision) { rebuildMessageItems() }
        .onChange(of: app.session?.userId) { rebuildMessageItems() }
        .onAppear { rebuildMessageItems() }
        .onDisappear {
            if listModel?.openChannelId == model.channel.channelId {
                listModel?.openChannelId = nil
            }
            listModel?.markRead(channelId: model.channel.channelId)
            model.detach()
            voice.detach()
        }
        .sheet(item: $panel) { selected in
            channelPanelSheet(selected)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $forwardMessage) { message in
            ForwardSheet(message: message, convo: listModel)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $previewFile) { file in
            FilePreviewSheet(file: file)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showSessionSheet) {
            SessionSheet(channelId: model.channel.channelId, bots: model.botMembers, selectedSessionId: $model.selectedSessionId)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showModelSheet) {
            ModelSettingsSheet(channelId: model.channel.channelId, bots: model.botMembers)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showChannelFiles) {
            ChannelFilesSheet(
                channelId: model.channel.channelId,
                onAttach: { model.addPendingFile($0) },
                onContext: { model.addContext(Self.fileContext($0)) }
            )
        }
        .sheet(isPresented: $showResourceContext) {
            ResourceContextSheet(
                channelId: model.channel.channelId,
                reply: model.replyTo,
                onAdd: { model.addContext($0) }
            )
        }
        .sheet(isPresented: $showMessageSearch) {
            ChannelMessageSearchSheet(
                channel: model.channel,
                members: model.channelMembers,
                api: app.api,
                onSelect: jumpToSearchResult
            )
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                uploadTask?.cancel()
                uploadTask = Task { await upload(url) }
            case .failure(let error):
                let nsError = error as NSError
                if nsError.code != NSUserCancelledError {
                    model.errorMessage = error.localizedDescription
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { !model.pendingAIConsent.isEmpty },
            set: { if !$0 { model.pendingAIConsent = [] } }
        )) {
            AIConsentSheet(
                disclosures: model.pendingAIConsent,
                onCancel: { model.pendingAIConsent = [] },
                onAgree: { Task { await model.grantPendingAIConsentAndRetry() } }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog("Why are you reporting this message?", isPresented: Binding(
            get: { reportTarget != nil }, set: { if !$0 { reportTarget = nil } }
        ), titleVisibility: .visible) {
            ForEach(["harassment", "spam", "illegal", "privacy", "other"], id: \.self) { reason in
                Button(reason.capitalized) { submitReport(reason: reason) }
            }
            Button("Cancel", role: .cancel) { reportTarget = nil }
        }
        .confirmationDialog("Block this user?", isPresented: Binding(
            get: { blockTarget != nil }, set: { if !$0 { blockTarget = nil } }
        ), titleVisibility: .visible) {
            Button("Block", role: .destructive) { blockUser() }
            Button("Cancel", role: .cancel) { blockTarget = nil }
        } message: {
            Text("Blocking removes any friendship and prevents direct messages in either direction.")
        }
    }

    private var composerDock: some View {
        VStack(spacing: 0) {
            if let error = model.errorMessage {
                errorBanner(error)
            }
            pendingAttachmentBar
            ComposerView(
                initialText: model.composerText,
                clearTick: model.composerClearTick,
                prefillTick: model.composerPrefillTick,
                prefillText: model.composerText,
                prefillMention: model.composerPrefillMention,
                placeholder: composerPlaceholder,
                isSending: model.isSending,
                onSend: { draft in await model.send(draft: draft) },
                channelId: model.channel.channelId,
                api: app.api,
                onChooseSession: { showSessionSheet = true },
                onModelSettings: { showModelSheet = true },
                onUploadFile: { showFileImporter = true },
                onBrowseFiles: { showChannelFiles = true },
                onAddContext: { showResourceContext = true },
                mentionPool: model.mentionPool,
                onMentionPicked: { candidate in
                    if !model.pickedMentions.contains(candidate) {
                        model.pickedMentions.append(candidate)
                    }
                }
            )
        }
    }

    @ViewBuilder
    private var pendingAttachmentBar: some View {
        if isUploading || !model.pendingFiles.isEmpty || !model.pendingContext.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    if isUploading {
                        ProgressView().controlSize(.small)
                        Text(uploadingFilename ?? String(localized: "Uploading file"))
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                        Button {
                            uploadTask?.cancel()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .accessibilityLabel("Cancel upload")
                    }
                    ForEach(model.pendingFiles) { file in
                        removableChip(file.originalFilename ?? "File", icon: "paperclip") {
                            model.pendingFiles.removeAll { $0.fileId == file.fileId }
                        }
                    }
                    ForEach(model.pendingContext) { item in
                        removableChip(item.label, icon: "link") {
                            model.pendingContext.removeAll { $0.id == item.id }
                        }
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
            }
            .background(Theme.bgApp)
        }
    }

    private func removableChip(_ text: String, icon: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
            Text(text).lineLimit(1)
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .accessibilityLabel("Remove \(text)")
        }
        .font(.caption)
        .foregroundStyle(Theme.textSecondary)
        .padding(.horizontal, 9).padding(.vertical, 6)
        .background(Theme.bgRaised, in: Capsule())
    }

    private func upload(_ url: URL) async {
        guard let api = app.api, !isUploading else { return }
        isUploading = true
        uploadingFilename = url.lastPathComponent
        defer {
            isUploading = false
            uploadingFilename = nil
            uploadTask = nil
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isReadableKey, .contentTypeKey])
            if values.isReadable == false { throw AttachmentUploadError.unreadable }
            if let fileSize = values.fileSize {
                try AttachmentUploadPolicy.validate(byteCount: Int64(fileSize))
            }
            try Task.checkCancellation()
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            try AttachmentUploadPolicy.validate(byteCount: Int64(data.count))
            try Task.checkCancellation()
            let type = values.contentType?.preferredMIMEType ?? "application/octet-stream"
            let file = try await api.uploadFile(
                channelId: model.channel.channelId,
                filename: url.lastPathComponent,
                contentType: type,
                data: data
            )
            try Task.checkCancellation()
            model.addPendingFile(file)
        } catch is CancellationError {
            // User cancellation is an expected state, not a red error banner.
        } catch {
            model.errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private static func fileContext(_ file: MessageFileRef) -> ResourceContextItem {
        ResourceContextItem(
            id: "file:\(file.fileId)", verb: "channel.files.read",
            params: ["file_id": .string(file.fileId)],
            label: file.originalFilename ?? "File", kind: "file"
        )
    }

    private var composerPlaceholder: String {
        model.channel.isDM
            ? String(localized: "Message \(model.channel.displayName)")
            : String(localized: "Message #\(model.channel.name)")
    }

    private var header: some View {
        VStack(spacing: 1) {
            HStack(spacing: 5) {
                if !model.channel.isDM {
                    Image(systemName: "number")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.textSecondary)
                }
                Text(model.channel.displayName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
            }
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
        }
    }

    private var subtitle: String? {
        if let purpose = model.channel.purpose, !purpose.isEmpty { return purpose }
        return nil
    }

    private var moreMenu: some View {
        Menu {
            Button { panel = .members } label: {
                Label("Members", systemImage: "person.2")
            }
            Button { panel = .viewboard } label: {
                Label("ViewBoard", systemImage: "rectangle.3.group")
            }
            Button { panel = .workbench } label: {
                Label("Workbench", systemImage: "sidebar.right")
            }
            Button { panel = .remoteWorkspace } label: {
                Label("Remote workspace", systemImage: "externaldrive.connected.to.line.below")
            }
            Button { panel = .taskClaims } label: {
                Label("Task claims", systemImage: "checkmark.seal")
            }
            if !model.channel.isDM {
                Button { panel = .settings } label: {
                    Label("Channel settings", systemImage: "gearshape")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("Channel options")
    }

    @ViewBuilder
    private func channelPanelSheet(_ selected: ChannelPanel) -> some View {
        switch selected {
        case .members:
            MembersSheet(channel: model.channel)
        case .viewboard:
            ViewBoardSheet(
                channelId: model.channel.channelId,
                onJumpToMessage: { msgId, requestId in
                    panel = nil
                    jumpToMessage(msgId: msgId, requestId: requestId)
                }
            )
        case .workbench:
            WorkbenchSheet(
                channelId: model.channel.channelId,
                onAddContext: { model.addContext($0) }
            )
        case .remoteWorkspace:
            RemoteWorkspaceSheet(
                channelId: model.channel.channelId,
                onAddContext: { model.addContext($0) }
            )
        case .taskClaims:
            TaskClaimManagementSheet(model: model)
        case .settings:
            ChannelSettingsSheet(channel: model.channel)
        }
    }

    // MARK: Message list

    private var messageScroll: some View {
        ChatCollectionTimeline(
            items: (model.hasMoreBefore ? [.loadOlder(isLoading: model.isLoadingOlder)] : []) + messageItems,
            app: app,
            channelId: model.channel.channelId,
            hasMoreBefore: model.hasMoreBefore,
            isLoadingOlder: model.isLoadingOlder,
            followBottomTick: model.followBottomTick,
            forceBottomTick: model.forceBottomTick + manualBottomTick,
            scrollTargetId: jumpTargetId,
            scrollTargetTick: jumpTargetTick,
            highlightedMessageId: jumpTargetId,
            focusTraceMsgId: focusTraceMsgId,
            focusTraceRequestId: focusTraceRequestId,
            atBottom: $atBottom,
            onLoadOlder: { Task { await model.loadOlder() } },
            onReply: { message in
                model.beginReply(to: message)
                jumpTargetId = message.msgId
                jumpTargetTick += 1
            },
            onMention: { model.mentionSender(of: $0) },
            onForward: { forwardMessage = $0 },
            onFile: { previewFile = $0 },
            onReport: { reportTarget = $0 },
            onBlock: { blockTarget = $0 },
            onStop: { message in Task { await model.stopTurn(msgId: message.msgId) } }
        )
        .overlay(alignment: .bottomTrailing) {
            if !atBottom || model.hasTrimmedNewer {
                jumpToLatestButton
            }
        }
        .overlay {
            if model.isLoading && model.messages.isEmpty {
                ProgressView()
            }
        }
    }

    private func jumpToSearchResult(_ message: MessageDto) {
        if model.channel.isDiscuss {
            let rootId = message.threadRootMsgId ?? message.msgId
            Task { await model.selectDiscussion(rootId) }
            return
        }
        jumpToMessage(msgId: message.msgId, requestId: nil, known: message)
    }

    /// Scroll/flash a message in the timeline. Remaps folded permission cards to
    /// their source bot turn (web MessageList parity).
    private func jumpToMessage(msgId: String, requestId: String?, known: MessageDto? = nil) {
        Task {
            var targetId = msgId
            let existing = known ?? model.messages.first(where: { $0.msgId == msgId })
            if let existing, let source = MessageTree.permissionSourceId(existing) {
                targetId = source
            }
            if let existing, existing.msgId == targetId || MessageTree.permissionSourceId(existing) != nil {
                // already in window (or we only need the source which may also be loaded)
            } else if let existing {
                await model.loadAround(existing)
            } else if let stub = model.messages.first(where: { $0.msgId == targetId }) {
                await model.loadAround(stub)
            }
            // Prefer source if the permission arrived later with source_msg_id.
            if let loaded = model.messages.first(where: { $0.msgId == msgId }),
               let source = MessageTree.permissionSourceId(loaded)
            {
                targetId = source
            }
            jumpTargetId = targetId
            jumpTargetTick += 1
            // Stash request id for BotTracePanel deep-link via a short-lived state.
            if let requestId {
                focusTraceRequestId = requestId
                focusTraceMsgId = targetId
            }
            try? await Task.sleep(for: .seconds(1.6))
            guard jumpTargetId == targetId else { return }
            jumpTargetId = nil
            jumpTargetTick += 1
        }
    }

    /// Escape hatch once auto-follow is suppressed: one tap back to live.
    private var jumpToLatestButton: some View {
        Button {
            if model.hasTrimmedNewer {
                Task { await model.loadLatest() }
            } else {
                manualBottomTick += 1
            }
        } label: {
            Image(systemName: "arrow.down")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 44, height: 44)          // HIG minimum tap target
                .background(.regularMaterial, in: Circle())
                .overlay { Circle().stroke(.primary.opacity(0.08), lineWidth: 0.5) }
                .shadow(color: .black.opacity(0.1), radius: 8, y: 3)
        }
        .accessibilityLabel(model.hasTrimmedNewer ? "Return to latest messages" : "Jump to latest messages")
        .padding(.trailing, 14)
        .padding(.bottom, 10)
        .transition(.opacity)
    }

    private func errorBanner(_ text: String) -> some View {
        HStack {
            Text(text)
                .font(.caption)
                .foregroundStyle(Theme.danger)
                .lineLimit(2)
            Spacer()
            Button {
                model.errorMessage = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: Theme.hitMin, height: Theme.hitMin)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Theme.danger.opacity(0.1))
    }

    // MARK: Item building

    private static let systemTypes: Set<String> = ["routing", "announcement", "notification", "permission", "auth_required"]

    private func rebuildMessageItems() {
        let interval = timelinePerformanceSignposter.beginInterval("BuildPresentationItems")
        defer { timelinePerformanceSignposter.endInterval("BuildPresentationItems", interval) }
        messageItems = buildMessageItems(
            messages: model.messages,
            currentUserId: app.session?.userId
        )
    }

    private func buildMessageItems(
        messages visible: [MessageDto],
        currentUserId: String?
    ) -> [ChatTimelineItem] {
        // Only actionable approvals belong in the main conversation. Completed,
        // denied and expired results remain available in the agent trace/audit.
        var result: [ChatTimelineItem] = []
        result.reserveCapacity(visible.count + 8)
        var previousDay: Date?

        let displayMessages = visible.filter { message in
            guard message.msgType == "permission" else { return true }
            let resolved = PermissionRequest(contentData: message.contentData)?.resolved == true
                || message.contentData?["resolved"]?.boolValue == true
            return !resolved
        }

        // Pending approvals keyed by the bot turn they belong to — rendered
        // immediately under that turn (web folds them into Agent steps).
        var approvalsBySource: [String: [MessageDto]] = [:]
        for message in displayMessages where message.msgType == "permission" {
            if let source = MessageTree.permissionSourceId(message) {
                approvalsBySource[source, default: []].append(message)
            }
        }

        let tree = MessageTree.groupByReply(displayMessages)
        // Top-level walk: roots keep channel order; children nest under parents.
        let roots = tree.roots

        func appendDayIfNeeded(for message: MessageDto, depth: Int) {
            guard depth == 0 else { return }
            let day = message.createdDate
            if let day, !TimeFormat.sameDay(day, previousDay) {
                result.append(.day(label: TimeFormat.dayLabel(day), key: message.msgId))
            }
            if day != nil { previousDay = day }
        }

        func emit(_ message: MessageDto, depth: Int, prevSibling: MessageDto?, nextSibling: MessageDto?) {
            appendDayIfNeeded(for: message, depth: depth)

            let isSystem = message.senderType == "system"
                || Self.systemTypes.contains(message.msgType ?? "")
            if isSystem {
                result.append(.system(message))
                return
            }

            let isOwn = message.senderType == "user" && message.senderId == currentUserId
            let kids = tree.childrenByParent[message.msgId] ?? []

            func groupable(_ other: MessageDto?) -> Bool {
                guard depth == 0, let other else { return false }
                let otherIsSystem = other.senderType == "system"
                    || Self.systemTypes.contains(other.msgType ?? "")
                return !otherIsSystem
                    && other.senderId == message.senderId
                    && other.senderType == message.senderType
                    && TimeFormat.sameDay(other.createdDate, message.createdDate)
            }

            let isFirstInGroup = depth > 0 || !groupable(prevSibling)
            let isLastSibling = nextSibling == nil
            let parentInView = message.replyToMsgId.flatMap { tree.byId[$0] } != nil

            result.append(.bubble(
                message,
                traceEvents: model.traceEvents(for: message.msgId),
                isOwn: isOwn,
                showAvatar: depth > 0 ? true : (!isOwn && isFirstInGroup),
                isLastSibling: isLastSibling,
                hasReplyChildren: !kids.isEmpty,
                formattedTime: TimeFormat.time(message.createdDate),
                repliedTo: parentInView ? nil : message.replyToMsgId.flatMap { tree.byId[$0] },
                depth: depth,
                hideReplyQuote: parentInView
            ))

            // Anchored pending approvals sit under the bot turn they belong to.
            for approval in approvalsBySource[message.msgId] ?? [] {
                result.append(.system(approval))
            }

            for (i, child) in kids.enumerated() {
                let prev = i > 0 ? kids[i - 1] : nil
                let next = i + 1 < kids.count ? kids[i + 1] : nil
                emit(child, depth: depth + 1, prevSibling: prev, nextSibling: next)
            }
        }

        for (index, root) in roots.enumerated() {
            // Folded permissions are excluded from the tree — skip any that
            // somehow landed as roots (orphans without source stay as system).
            if MessageTree.isFoldedPermission(root) {
                appendDayIfNeeded(for: root, depth: 0)
                result.append(.system(root))
                continue
            }
            let prev = index > 0 ? roots[index - 1] : nil
            let next = index + 1 < roots.count ? roots[index + 1] : nil
            emit(root, depth: 0, prevSibling: prev, nextSibling: next)
        }
        return result
    }

    private func submitReport(reason: String) {
        guard let target = reportTarget, let api = app.api else { return }
        reportTarget = nil
        Task {
            do {
                try await api.report(targetType: "message", targetId: target.msgId, channelId: model.channel.channelId, reason: reason, details: nil)
                model.errorMessage = "Report submitted. Thank you for helping keep Cheers safe."
            } catch { model.errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription }
        }
    }

    private func blockUser() {
        guard let target = blockTarget, let userId = target.senderId, let api = app.api else { return }
        blockTarget = nil
        Task {
            do {
                try await api.blockUser(userId)
                model.errorMessage = "User blocked."
            } catch { model.errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription }
        }
    }
}

// MARK: - Incremental UIKit timeline

/// UICollectionView owns scrolling, cell reuse, self-sizing, keyboard viewport
/// changes, and incremental updates. SwiftUI remains responsible for the
/// content inside each reused cell, but a composer edit can no longer
/// invalidate or rebuild the entire transcript hierarchy.
private struct ChatCollectionTimeline: UIViewRepresentable {
    let items: [ChatTimelineItem]
    let app: AppModel
    let channelId: String
    let hasMoreBefore: Bool
    let isLoadingOlder: Bool
    let followBottomTick: Int
    let forceBottomTick: Int
    let scrollTargetId: String?
    let scrollTargetTick: Int
    let highlightedMessageId: String?
    var focusTraceMsgId: String? = nil
    var focusTraceRequestId: String? = nil
    @Binding var atBottom: Bool
    let onLoadOlder: () -> Void
    let onReply: (MessageDto) -> Void
    let onMention: (MessageDto) -> Void
    let onForward: (MessageDto) -> Void
    let onFile: (MessageFileRef) -> Void
    let onReport: (MessageDto) -> Void
    let onBlock: (MessageDto) -> Void
    let onStop: (MessageDto) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UICollectionView {
        var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
        configuration.showsSeparators = false
        configuration.backgroundColor = .clear
        let layout = UICollectionViewCompositionalLayout.list(using: configuration)
        let collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.backgroundColor = .clear
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .interactive
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.delegate = context.coordinator
        context.coordinator.configure(collectionView)
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        context.coordinator.update(parent: self, collectionView: collectionView)
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate {
        private var parent: ChatCollectionTimeline
        private weak var collectionView: UICollectionView?
        private var dataSource: UICollectionViewDiffableDataSource<Int, String>?
        private var itemsById: [String: ChatTimelineItem] = [:]
        private var itemHashes: [String: Int] = [:]
        private var lastFollowTick: Int
        private var lastForceTick: Int
        private var lastScrollTargetTick: Int
        private var lastHighlightedMessageId: String?
        private var hasAppliedInitialSnapshot = false

        init(parent: ChatCollectionTimeline) {
            self.parent = parent
            lastFollowTick = parent.followBottomTick
            lastForceTick = parent.forceBottomTick
            lastScrollTargetTick = parent.scrollTargetTick
            lastHighlightedMessageId = parent.highlightedMessageId
        }

        private lazy var registration = UICollectionView.CellRegistration<UICollectionViewCell, String> {
            [weak self] cell, _, itemId in
            guard let self, let item = self.itemsById[itemId] else { return }
            var background = UIBackgroundConfiguration.clear()
            if self.parent.highlightedMessageId == itemId {
                background.backgroundColor = UIColor.tintColor.withAlphaComponent(0.12)
                background.cornerRadius = 14
            }
            cell.backgroundConfiguration = background
            cell.contentConfiguration = UIHostingConfiguration {
                ChatTimelineRow(
                    item: item,
                    channelId: self.parent.channelId,
                    focusTraceRequestId: self.parent.focusTraceMsgId == itemId
                        ? self.parent.focusTraceRequestId
                        : nil,
                    onLoadOlder: self.parent.onLoadOlder,
                    onReply: self.parent.onReply,
                    onMention: self.parent.onMention,
                    onForward: self.parent.onForward,
                    onFile: self.parent.onFile,
                    onReport: self.parent.onReport,
                    onBlock: self.parent.onBlock,
                    onStop: self.parent.onStop
                )
                .environment(self.parent.app)
            }
            .margins(.all, 0)
        }

        func configure(_ collectionView: UICollectionView) {
            self.collectionView = collectionView
            // UIKit requires registrations to exist before entering the cell
            // provider. Force the lazy value here so every dequeue reuses the
            // same registration instead of creating one during cell lookup.
            let registration = self.registration
            dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: collectionView) {
                collectionView, indexPath, itemId in
                return collectionView.dequeueConfiguredReusableCell(
                    using: registration,
                    for: indexPath,
                    item: itemId
                )
            }
        }

        func update(parent: ChatCollectionTimeline, collectionView: UICollectionView) {
            let wasAtBottom = isAtBottom(collectionView)
            let oldIdentifiers = dataSource?.snapshot().itemIdentifiers ?? []
            let oldFirstMessageId = oldIdentifiers.first { $0 != "load-older" }
            let oldContentHeight = collectionView.contentSize.height
            let oldOffsetY = collectionView.contentOffset.y
            let forceBottom = parent.forceBottomTick != lastForceTick
            let followBottom = parent.followBottomTick != lastFollowTick && wasAtBottom
            let scrollTargetChanged = parent.scrollTargetTick != lastScrollTargetTick
            let previousHighlightId = lastHighlightedMessageId
            lastForceTick = parent.forceBottomTick
            lastFollowTick = parent.followBottomTick
            lastScrollTargetTick = parent.scrollTargetTick
            lastHighlightedMessageId = parent.highlightedMessageId
            self.parent = parent

            var newItemsById: [String: ChatTimelineItem] = [:]
            var newHashes: [String: Int] = [:]
            newItemsById.reserveCapacity(parent.items.count)
            newHashes.reserveCapacity(parent.items.count)
            for item in parent.items {
                newItemsById[item.id] = item
                newHashes[item.id] = item.hashValue
            }
            let newIdentifiers = parent.items.map(\.id)
            let contentChanged = oldIdentifiers != newIdentifiers || itemHashes != newHashes
            let changedIds = parent.items.compactMap { item -> String? in
                guard itemHashes[item.id] != nil, itemHashes[item.id] != newHashes[item.id] else { return nil }
                return item.id
            }
            itemsById = newItemsById
            itemHashes = newHashes

            // Binding updates such as crossing the bottom threshold re-enter
            // updateUIView. They must not re-apply an identical snapshot.
            guard contentChanged || forceBottom || followBottom || scrollTargetChanged || !hasAppliedInitialSnapshot else { return }
            let interval = timelinePerformanceSignposter.beginInterval("ApplyTimelineSnapshot")

            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(newIdentifiers, toSection: 0)
            let existingIds = Set(oldIdentifiers)
            var reconfigurable = changedIds.filter { existingIds.contains($0) && newItemsById[$0] != nil }
            if scrollTargetChanged {
                for id in [previousHighlightId, parent.highlightedMessageId].compactMap({ $0 })
                    where existingIds.contains(id) && newItemsById[id] != nil && !reconfigurable.contains(id) {
                    reconfigurable.append(id)
                }
            }
            if !reconfigurable.isEmpty {
                snapshot.reconfigureItems(reconfigurable)
            }

            dataSource?.apply(snapshot, animatingDifferences: false) { [weak self, weak collectionView] in
                timelinePerformanceSignposter.endInterval("ApplyTimelineSnapshot", interval)
                guard let self, let collectionView else { return }
                collectionView.layoutIfNeeded()
                let newFirstMessageId = snapshot.itemIdentifiers.first { $0 != "load-older" }
                let prependedHistory = oldFirstMessageId != nil
                    && newFirstMessageId != oldFirstMessageId
                    && !forceBottom
                    && !followBottom
                if prependedHistory {
                    let delta = collectionView.contentSize.height - oldContentHeight
                    collectionView.setContentOffset(
                        CGPoint(x: 0, y: max(-collectionView.adjustedContentInset.top, oldOffsetY + delta)),
                        animated: false
                    )
                } else if forceBottom || followBottom || !self.hasAppliedInitialSnapshot {
                    self.scrollToBottom(collectionView, animated: false)
                }
                if scrollTargetChanged,
                   let targetId = parent.scrollTargetId,
                   let indexPath = self.dataSource?.indexPath(for: targetId) {
                    collectionView.scrollToItem(at: indexPath, at: .centeredVertically, animated: true)
                }
                self.hasAppliedInitialSnapshot = true
                self.publishBottomState(collectionView)
            }
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard let collectionView = scrollView as? UICollectionView else { return }
            publishBottomState(collectionView)
        }

        private func scrollToBottom(_ collectionView: UICollectionView, animated: Bool) {
            guard let last = dataSource?.snapshot().itemIdentifiers.last,
                  let indexPath = dataSource?.indexPath(for: last) else { return }
            collectionView.scrollToItem(at: indexPath, at: .bottom, animated: animated)
        }

        private func isAtBottom(_ collectionView: UICollectionView) -> Bool {
            let visibleBottom = collectionView.contentOffset.y
                + collectionView.bounds.height
                - collectionView.adjustedContentInset.bottom
            return collectionView.contentSize.height - visibleBottom <= 80
        }

        private func publishBottomState(_ collectionView: UICollectionView) {
            let value = isAtBottom(collectionView)
            guard parent.atBottom != value else { return }
            parent.atBottom = value
        }
    }
}

private struct ChatTimelineRow: View {
    let item: ChatTimelineItem
    let channelId: String
    var focusTraceRequestId: String? = nil
    let onLoadOlder: () -> Void
    let onReply: (MessageDto) -> Void
    let onMention: (MessageDto) -> Void
    let onForward: (MessageDto) -> Void
    let onFile: (MessageFileRef) -> Void
    let onReport: (MessageDto) -> Void
    let onBlock: (MessageDto) -> Void
    let onStop: (MessageDto) -> Void

    @ViewBuilder
    var body: some View {
        switch item {
        case .loadOlder(let isLoading):
            HStack {
                if isLoading {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Load earlier messages", action: onLoadOlder)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.link)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.vertical, 4)
        case .day(let label, _):
            DaySeparatorView(label: label)
        case .system(let message):
            if message.msgType == "permission" {
                ApprovalCardView(message: message)
            } else if message.msgType == "auth_required" {
                AuthRequiredCardView(message: message)
            } else {
                SystemMessageView(message: message)
            }
        case .bubble(
            let message,
            let traceEvents,
            let isOwn,
            let showAvatar,
            let isLastSibling,
            let hasReplyChildren,
            let time,
            let repliedTo,
            let depth,
            let hideReplyQuote
        ):
            // Spacing scale: tight inside the unit, medium before replies,
            // wide after a finished root/thread.
            let trailingGap: CGFloat = {
                if depth == 0 {
                    return hasReplyChildren ? Theme.messageReplyGap : Theme.messageGroupGap
                }
                return isLastSibling ? Theme.messageGroupGap : Theme.messageReplyGap
            }()
            VStack(alignment: isOwn ? .trailing : .leading, spacing: Theme.messageInnerGap) {
                MessageBubbleView(
                    message: message,
                    isOwn: isOwn,
                    showAvatar: showAvatar,
                    formattedTime: time,
                    repliedTo: hideReplyQuote ? nil : repliedTo,
                    nested: depth > 0,
                    onReply: { onReply(message) },
                    onMention: isOwn ? nil : { onMention(message) },
                    onForward: { onForward(message) },
                    onTapFile: onFile,
                    onReport: { onReport(message) },
                    onBlock: { onBlock(message) },
                    onStop: message.isPartial == true ? { onStop(message) } : nil
                )
                if message.isBot {
                    BotTracePanelView(
                        channelId: channelId,
                        msgId: message.msgId,
                        liveEvents: traceEvents,
                        isRunning: message.isPartial == true,
                        focusRequestId: focusTraceRequestId
                    )
                    .padding(.leading, Theme.space5 + CGFloat(depth) * 16)
                    .padding(.trailing, Theme.space5)
                }
                if message.msgType == "task_claim_confirmation" {
                    TaskClaimConfirmationFooter(message: message, channelId: channelId)
                        .padding(.leading, 58 + CGFloat(depth) * 16)
                }
            }
            .padding(.leading, depth > 0 ? 16 + CGFloat(depth - 1) * 16 : 0)
            .overlay(alignment: .leading) {
                if depth > 0 {
                    ThreadCornerRail(isLastSibling: isLastSibling)
                        .frame(width: 14)
                        .padding(.leading, CGFloat(depth - 1) * 16 + 6)
                }
            }
            .padding(.bottom, trailingGap)
        }
    }
}

/// L-shaped reply connector (web MessageList parity): vertical rail + stub
/// into the nested row. Last sibling stops the rail at the elbow.
private struct ThreadCornerRail: View {
    let isLastSibling: Bool

    var body: some View {
        Canvas { context, size in
            let x: CGFloat = 0.5
            let elbowY = min(16, size.height * 0.35)
            var path = Path()
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(to: CGPoint(x: x, y: isLastSibling ? elbowY : size.height))
            path.move(to: CGPoint(x: x, y: elbowY))
            path.addLine(to: CGPoint(x: size.width, y: elbowY))
            context.stroke(
                path,
                with: .color(Theme.border),
                style: StrokeStyle(lineWidth: 1, lineCap: .square)
            )
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct AIConsentSheet: View {
    let disclosures: [AIDataDisclosure]
    let onCancel: () -> Void
    let onAgree: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Your message is about to be sent to the external AI services below. This permission applies to this channel and can be revoked in Settings.")
                        .foregroundStyle(Theme.textBody)
                }
                ForEach(disclosures) { item in
                    Section(item.botName) {
                        LabeledContent("Provider", value: item.providerName ?? "External service")
                        if let use = item.dataUse { Text(use).foregroundStyle(Theme.textSecondary) }
                        if let raw = item.privacyURL, let url = URL(string: raw) {
                            Link("Provider privacy policy", destination: url)
                        }
                    }
                }
            }
            .navigationTitle("External AI Data Sharing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Not now", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) { Button("Agree & Send", action: onAgree) }
            }
        }
    }
}

// MARK: - Members sheet

/// The channel roster (web MembersPopover): people and bots with online dots
/// and roles, fetched from GET /channels/:id/members.

// MARK: - Forward sheet

/// Forward a message's text to another conversation (web ForwardDialog, mobile
/// form): pick a conversation, the content is re-sent there.
private struct ForwardSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let message: MessageDto
    let convo: ConversationListModel?

    @State private var busyId: String?
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Forward to")
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .padding(16)
            Text(message.content.replacingOccurrences(of: "\n", with: " "))
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
            if let errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 16)
            }
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(convo?.rows ?? []) { row in
                        Button { forward(to: row.channel) } label: {
                            CheersNavigationItem(row: CheersItemRow(
                                title: row.channel.displayName,
                                subtitle: row.channel.kind?.capitalized,
                                leading: AnyView(ChannelAvatarView(channel: row.channel, size: 34)),
                                trailing: busyId == row.channel.channelId ? AnyView(ProgressView().controlSize(.small)) : nil
                            ))
                        }
                        .buttonStyle(.plain)
                        .disabled(busyId != nil)
                    }
                }
            }
        }
        .background(Theme.bgSurface)
    }

    private func forward(to channel: ChannelDto) {
        guard let api = app.api, busyId == nil else { return }
        busyId = channel.channelId
        errorText = nil
        Task {
            do {
                _ = try await api.sendMessage(channelId: channel.channelId, SendMessageRequest(content: message.content))
                dismiss()
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
                busyId = nil
            }
        }
    }
}

// MARK: - ViewBoard (Audit board)

/// The channel's instrument plane. Plan/cost/activity are live-WS-only (view on
/// web); the Audit board is REST-fetchable, so iOS shows the permission audit
/// trail — who approved/denied which agent action, when.

// MARK: - File preview sheet

private struct ChannelFilesSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channelId: String
    let onAttach: (MessageFileRef) -> Void
    let onContext: (MessageFileRef) -> Void

    @State private var files: [MessageFileRef] = []
    @State private var isLoading = true
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else if let errorText {
                    ContentUnavailableView("Could not load files", systemImage: "exclamationmark.triangle", description: Text(errorText))
                } else if files.isEmpty {
                    ContentUnavailableView("No channel files", systemImage: "folder", description: Text("Upload a file from the composer to start the library."))
                } else {
                    List(files) { file in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                Image(systemName: "doc")
                                    .foregroundStyle(Theme.accent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(file.originalFilename ?? "File").lineLimit(1)
                                    if let size = file.sizeBytes {
                                        Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                                            .font(.caption).foregroundStyle(Theme.textSecondary)
                                    }
                                }
                            }
                            HStack {
                                Button("Attach", systemImage: "paperclip") {
                                    onAttach(file); dismiss()
                                }
                                .buttonStyle(.borderedProminent)
                                Button("Add to context", systemImage: "link") {
                                    onContext(file); dismiss()
                                }
                                .buttonStyle(.bordered)
                            }
                            .font(.caption)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("Channel files")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .task { await load() }
    }

    private func load() async {
        guard let api = app.api else { isLoading = false; return }
        do {
            files = try await api.listChannelFiles(channelId: channelId)
            errorText = nil
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }
}

private struct ResourceContextSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channelId: String
    let reply: MessageDto?
    let onAdd: (ResourceContextItem) -> Void

    @State private var files: [MessageFileRef] = []

    private var quickItems: [ResourceContextItem] {
        var items = [
            ResourceContextItem(id: "plan", verb: "channel.plan.read", params: [:], label: "Plan", kind: "plan"),
            ResourceContextItem(id: "activity", verb: "channel.activity.read", params: [:], label: "Recent decisions", kind: "activity"),
            ResourceContextItem(id: "sessions", verb: "channel.sessions.read", params: [:], label: "Sessions", kind: "sessions"),
            ResourceContextItem(id: "cost", verb: "channel.usage.read", params: [:], label: "Cost", kind: "cost"),
        ]
        if let reply, let seq = reply.channelSeq {
            items.append(ResourceContextItem(
                id: "msg:\(seq)", verb: "channel.messages.by-seq",
                params: ["min_seq": .number(Double(seq)), "max_seq": .number(Double(seq))],
                label: reply.senderName.map { "Reply to \($0)" } ?? "Message #\(seq)", kind: "message"
            ))
        }
        return items
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Channel context") {
                    ForEach(quickItems) { item in
                        Button { onAdd(item); dismiss() } label: {
                            Label(item.label, systemImage: icon(item.kind))
                        }
                    }
                }
                if !files.isEmpty {
                    Section("Channel files") {
                        ForEach(files) { file in
                            Button {
                                onAdd(ResourceContextItem(
                                    id: "file:\(file.fileId)", verb: "channel.files.read",
                                    params: ["file_id": .string(file.fileId)],
                                    label: file.originalFilename ?? "File", kind: "file"
                                ))
                                dismiss()
                            } label: {
                                Label(file.originalFilename ?? "File", systemImage: "doc")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Add context")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .task {
            guard let api = app.api else { return }
            files = (try? await api.listChannelFiles(channelId: channelId)) ?? []
        }
    }

    private func icon(_ kind: String) -> String {
        switch kind {
        case "plan": return "list.bullet.clipboard"
        case "activity": return "clock.arrow.circlepath"
        case "sessions": return "rectangle.stack"
        case "cost": return "creditcard"
        case "message": return "bubble.left"
        default: return "link"
        }
    }
}

/// Attachment viewer: images render inline; everything else shows file info with
/// a Share/Save action. Bytes are Bearer-fetched (the URLs can't carry a header).
private struct FilePreviewSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let file: MessageFileRef

    @State private var image: UIImage?
    @State private var shareURL: URL?
    @State private var isLoading = true
    @State private var errorText: String?

    private var isImage: Bool { (file.contentType ?? "").hasPrefix("image/") }
    private var title: String { file.originalFilename ?? "Attachment" }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    if let bytes = file.sizeBytes {
                        Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
                            .font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                }
                Spacer()
                if let shareURL {
                    ShareLink(item: shareURL) {
                        Image(systemName: "square.and.arrow.up").font(.body)
                    }
                }
            }
            .padding(16)
            content
        }
        .background(Theme.bgSurface)
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorText {
            ComingSoon(icon: "exclamationmark.triangle", text: errorText)
        } else if let image {
            ScrollView([.horizontal, .vertical]) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgApp)
        } else {
            VStack(spacing: 14) {
                Image(systemName: "doc.fill").font(.largeTitle).foregroundStyle(Theme.textFaint)
                Text("Preview not available for this type").font(.subheadline).foregroundStyle(Theme.textSecondary)
                if let shareURL {
                    ShareLink(item: shareURL) {
                        Label("Save / Share", systemImage: "square.and.arrow.up")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 18).frame(minHeight: 44)
                            .background(Theme.accent)
                            .clipShape(Capsule())
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func load() async {
        guard let api = app.api else { isLoading = false; return }
        do {
            let data = try await api.fileData(fileId: file.fileId, download: true)
            if isImage { image = UIImage(data: data) }
            // Write to a temp file so ShareLink/Save works for any type.
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(title)
            try? data.write(to: url)
            shareURL = url
            isLoading = false
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            isLoading = false
        }
    }
}

// MARK: - Session picker

/// Composer "Choose session" — Auto (route by @mention) or pin one bot's session.
/// Mirrors the web SessionChip; the target rides SendMessageRequest.session_id.
private struct SessionSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channelId: String
    let bots: [ChannelMemberDto]
    @Binding var selectedSessionId: String?

    @State private var sessionsByBot: [String: [SessionInfo]] = [:]
    @State private var isLoading = true
    @State private var busyId: String?
    @State private var closeTarget: (botId: String, session: SessionInfo)?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    CheersItemButton(row: CheersItemRow(
                        title: "Auto",
                        subtitle: "Route by @mention to each bot's primary",
                        selected: selectedSessionId == nil,
                        leading: AnyView(Image(systemName: "wand.and.stars").foregroundStyle(Theme.accent)),
                        criticalStatus: selectedSessionId == nil ? AnyView(Image(systemName: "checkmark").foregroundStyle(Theme.accent)) : nil
                    )) {
                        selectedSessionId = nil; dismiss()
                    }
                }
                ForEach(bots, id: \.memberId) { bot in
                    Section(bot.name) {
                        let sessions = sessionsByBot[bot.memberId] ?? []
                        if sessions.isEmpty {
                            Text("No sessions").font(.subheadline).foregroundStyle(Theme.textSecondary)
                        }
                        ForEach(sessions) { s in
                            CheersNavigationItem(row: CheersItemRow(
                                title: s.tag,
                                subtitle: sessionSubtitle(s),
                                leading: AnyView(Image(systemName: "terminal").foregroundStyle(Theme.accent)),
                                criticalStatus: s.isPrimary == true ? AnyView(Text("PRIMARY").font(.caption2.bold()).foregroundStyle(Theme.accent)) : nil,
                                status: selectedSessionId == s.sessionId ? AnyView(Image(systemName: "checkmark").foregroundStyle(Theme.accent)) : nil,
                                actions: AnyView(HStack(spacing: Theme.space1) {
                                    Button {
                                    selectedSessionId = s.sessionId; dismiss()
                                    } label: { Text("Select") }
                                    .buttonStyle(.borderless)
                                    if busyId == s.sessionId { ProgressView().controlSize(.small) }
                                    Menu {
                                    if s.isPrimary != true {
                                        Button("Make primary", systemImage: "star") {
                                            Task { await makePrimary(botId: bot.memberId, session: s) }
                                        }
                                    }
                                    Button("Close session", systemImage: "xmark.circle", role: .destructive) {
                                        closeTarget = (bot.memberId, s)
                                    }
                                    } label: { Image(systemName: "ellipsis.circle").foregroundStyle(Theme.textSecondary) }
                                })
                            ))
                        }
                    }
                }
                if let errorText { Section { Text(errorText).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ForEach(bots, id: \.memberId) { bot in
                            Button(bot.name) { Task { await create(botId: bot.memberId) } }
                        }
                    } label: { Image(systemName: "plus") }
                    .disabled(bots.isEmpty || busyId != nil)
                    .accessibilityLabel("Create session")
                }
            }
            .overlay { if isLoading && sessionsByBot.isEmpty { ProgressView() } }
        }
        .task { await load() }
        .confirmationDialog("Close this session?", isPresented: Binding(
            get: { closeTarget != nil }, set: { if !$0 { closeTarget = nil } }
        )) {
            Button("Close session", role: .destructive) { Task { await closeSelected() } }
            Button("Cancel", role: .cancel) { closeTarget = nil }
        } message: {
            Text("The session will disappear from this channel and can no longer receive messages.")
        }
    }

    private func load() async {
        guard let api = app.api else { isLoading = false; return }
        await withTaskGroup(of: (String, [SessionInfo]).self) { group in
            for bot in bots {
                let id = bot.memberId
                group.addTask { (id, (try? await api.listSessions(channelId: channelId, botId: id)) ?? []) }
            }
            for await (botId, sessions) in group { sessionsByBot[botId] = sessions }
        }
        isLoading = false
    }

    private func sessionSubtitle(_ session: SessionInfo) -> String {
        let status = session.status ?? "active"
        guard let raw = session.lastUsedAt, let date = TimeFormat.parse(raw) else { return status }
        return "\(status) · \(date.formatted(.relative(presentation: .named)))"
    }

    private func create(botId: String) async {
        guard let api = app.api else { return }
        busyId = botId; errorText = nil
        defer { busyId = nil }
        do {
            let created = try await api.createSession(channelId: channelId, botId: botId)
            await load()
            selectedSessionId = created.sessionId
        } catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }

    private func makePrimary(botId: String, session: SessionInfo) async {
        guard let api = app.api else { return }
        busyId = session.sessionId; errorText = nil
        defer { busyId = nil }
        do {
            try await api.setPrimarySession(channelId: channelId, botId: botId, sessionId: session.sessionId)
            await load()
        } catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }

    private func closeSelected() async {
        guard let target = closeTarget, let api = app.api else { return }
        closeTarget = nil; busyId = target.session.sessionId; errorText = nil
        defer { busyId = nil }
        do {
            try await api.closeSession(channelId: channelId, botId: target.botId, sessionId: target.session.sessionId)
            if selectedSessionId == target.session.sessionId { selectedSessionId = nil }
            await load()
        } catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }
}

// MARK: - Model & bot settings

/// Composer "Model & bot settings" — per-bot session mode + config options
/// (including the model). Applies to the bot's primary session.
private struct ModelSettingsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channelId: String
    let bots: [ChannelMemberDto]

    @State private var controls: [String: SessionControls] = [:]
    @State private var primarySession: [String: String] = [:]
    @State private var modeSel: [String: String] = [:]
    @State private var configSel: [String: [String: String]] = [:]
    @State private var isLoading = true
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                if bots.isEmpty {
                    Text("No agents in this channel").foregroundStyle(Theme.textSecondary)
                }
                ForEach(bots, id: \.memberId) { bot in
                    if let ctrl = controls[bot.memberId] {
                        Section(bot.name) { botControls(botId: bot.memberId, ctrl: ctrl) }
                    }
                }
                if let errorText {
                    Text(errorText).font(.subheadline).foregroundStyle(Theme.danger)
                }
            }
            .navigationTitle("Model & settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .overlay { if isLoading { ProgressView() } }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func botControls(botId: String, ctrl: SessionControls) -> some View {
        let hasSession = primarySession[botId] != nil
        if let modes = ctrl.allowedModes, !modes.isEmpty {
            Picker("Mode", selection: Binding(
                get: { modeSel[botId] ?? ctrl.currentMode ?? modes.first ?? "" },
                set: { modeSel[botId] = $0; applyMode(botId: botId, mode: $0) }
            )) {
                ForEach(modes, id: \.self) { Text($0.capitalized).tag($0) }
            }
            .disabled(ctrl.canSetMode != true || !hasSession)
        }
        ForEach(ctrl.configOptions ?? []) { opt in
            if let choices = opt.options, !choices.isEmpty {
                Picker(opt.name ?? opt.optionId, selection: Binding(
                    get: { configSel[botId]?[opt.optionId] ?? opt.currentValue ?? "" },
                    set: { configSel[botId, default: [:]][opt.optionId] = $0; applyConfig(botId: botId, configId: opt.optionId, value: $0) }
                )) {
                    ForEach(choices) { choice in Text(choice.name ?? choice.value).tag(choice.value) }
                }
                .disabled(ctrl.canSetConfigOption != true || !hasSession)
            }
        }
        if !hasSession {
            Text("No active session — start one to change settings.")
                .font(.caption).foregroundStyle(Theme.textSecondary)
        }
    }

    private func applyMode(botId: String, mode: String) {
        guard let api = app.api, let sid = primarySession[botId] else { return }
        Task {
            do { try await api.setSessionMode(channelId: channelId, botId: botId, sessionId: sid, mode: mode) }
            catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
        }
    }

    private func applyConfig(botId: String, configId: String, value: String) {
        guard let api = app.api, let sid = primarySession[botId] else { return }
        Task {
            do { try await api.setSessionConfig(channelId: channelId, botId: botId, sessionId: sid, configId: configId, value: value) }
            catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
        }
    }

    private func load() async {
        guard let api = app.api else { isLoading = false; return }
        await withTaskGroup(of: (String, SessionControls?, String?).self) { group in
            for bot in bots {
                let id = bot.memberId
                group.addTask {
                    let ctrl = try? await api.sessionControls(channelId: channelId, botId: id)
                    let sessions = (try? await api.listSessions(channelId: channelId, botId: id)) ?? []
                    let primary = sessions.first { $0.isPrimary == true }?.sessionId ?? sessions.first?.sessionId
                    return (id, ctrl, primary)
                }
            }
            for await (botId, ctrl, primary) in group {
                if let ctrl { controls[botId] = ctrl }
                if let primary { primarySession[botId] = primary }
            }
        }
        isLoading = false
    }
}
