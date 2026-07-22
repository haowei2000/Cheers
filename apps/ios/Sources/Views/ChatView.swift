import SwiftUI
import UIKit
import os

private let timelinePerformanceSignposter = OSSignposter(
    subsystem: "app.cheers.ios",
    category: "TimelinePerformance"
)

/// Channel header surfaces, mirroring the web channel header. Every ⋯-menu item
/// opens a bottom SHEET (modal "peek" surfaces) — pushed pages are reserved for
/// drawer destinations, so the menu's presentation stays consistent.
enum ChannelPanel: String, Identifiable {
    case members = "Members"
    case files = "Channel files"
    case workspaceFiles = "Workspace files"
    case viewboard = "ViewBoard"
    case workbench = "Workbench"
    case settings = "Channel settings"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .members: return "person.2"
        case .files: return "paperclip"
        case .workspaceFiles: return "folder"
        case .viewboard: return "rectangle.3.group"
        case .workbench: return "sidebar.right"
        case .settings: return "gearshape"
        }
    }
    var blurb: String {
        switch self {
        case .members: return "People and bots in this channel."
        case .files: return "Files shared in this channel."
        case .workspaceFiles: return "Browse the connected remote workspace's files."
        case .viewboard: return "Live plan, cost, sessions and audit for this channel's agents (the instrument plane)."
        case .workbench: return "The channel's file workspace."
        case .settings: return "Name, purpose, invites, membership and the danger zone."
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
        isOwn: Bool,
        showName: Bool,
        showAvatar: Bool,
        isLast: Bool,
        formattedTime: String,
        repliedTo: MessageDto?
    )

    var id: String {
        switch self {
        case .loadOlder: return "load-older"
        case .day(_, let key): return "day-\(key)"
        case .system(let message): return "sys-\(message.msgId)"
        case .bubble(let message, _, _, _, _, _, _): return message.msgId
        }
    }
}

struct ChatView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model: ChatModel
    @State private var panel: ChannelPanel?
    @State private var forwardMessage: MessageDto?
    @State private var previewFile: MessageFileRef?
    @State private var showSessionSheet = false
    @State private var showModelSheet = false
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
                VoiceMeetingStrip(
                    voice: voice,
                    canManageTranscription: voice.canManageTranscription
                )
            }
            messageScroll
            if let reply = model.replyTo {
                replyBar(reply)
            }
            if let error = model.errorMessage {
                errorBanner(error)
            }
            ComposerView(
                initialText: model.composerText,
                clearTick: model.composerClearTick,
                placeholder: composerPlaceholder,
                isSending: model.isSending,
                onSend: { draft in await model.send(draft: draft) },
                channelId: model.channel.channelId,
                api: app.api,
                onChooseSession: { showSessionSheet = true },
                onModelSettings: { showModelSheet = true },
                mentionPool: model.mentionPool,
                onMentionPicked: { candidate in
                    if !model.pickedMentions.contains(candidate) {
                        model.pickedMentions.append(candidate)
                    }
                }
            )
        }
        .background(Theme.bgApp)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                CircleIconButton(systemName: "line.3.horizontal", badge: shell.pendingApprovals) {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { shell.openDrawer() }
                }
            }
            ToolbarItem(placement: .principal) {
                header
            }
            ToolbarItem(placement: .topBarTrailing) {
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
        .sheet(item: $panel) { panel in
            Group {
                switch panel {
                case .members:   MembersSheet(channel: model.channel)
                case .viewboard: ViewBoardSheet(channelId: model.channel.channelId)
                case .workbench: WorkbenchSheet(channelId: model.channel.channelId)
                case .settings:  ChannelSettingsSheet(channel: model.channel)
                default:         ChannelPanelSheet(panel: panel)
                }
            }
            .presentationDetents([.medium, .large])
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

    private func replyBar(_ reply: MessageDto) -> some View {
        HStack(spacing: 9) {
            Image(systemName: "arrowshape.turn.up.left")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.link)
            VStack(alignment: .leading, spacing: 1) {
                Text("Replying to \(reply.senderName ?? (reply.isBot ? "Bot" : "message"))")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(reply.content.replacingOccurrences(of: "\n", with: " "))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            Spacer()
            Button {
                model.replyTo = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 14)
        .background(Theme.bgSurface)
    }

    private var composerPlaceholder: String {
        model.channel.isDM
            ? "Message \(model.channel.displayName)"
            : "Message #\(model.channel.name)"
    }

    private var header: some View {
        VStack(spacing: 1) {
            HStack(spacing: 5) {
                if !model.channel.isDM {
                    Image(systemName: "number")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                }
                Text(model.channel.displayName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
            }
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 12))
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
            Button { panel = .files } label: {
                Label("Channel files", systemImage: "paperclip")
            }
            Button { panel = .workspaceFiles } label: {
                Label("Workspace files", systemImage: "folder")
            }
            Button { panel = .viewboard } label: {
                Label("ViewBoard", systemImage: "rectangle.3.group")
            }
            Button { panel = .workbench } label: {
                Label("Workbench", systemImage: "sidebar.right")
            }
            if !model.channel.isDM {
                Button { panel = .settings } label: {
                    Label("Channel settings", systemImage: "gearshape")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.textBody)
                .frame(width: 36, height: 36)
                .background(Theme.bgRaised)
                .clipShape(Circle())
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
            atBottom: $atBottom,
            onLoadOlder: { Task { await model.loadOlder() } },
            onReply: { model.replyTo = $0 },
            onForward: { forwardMessage = $0 },
            onFile: { previewFile = $0 },
            onReport: { reportTarget = $0 },
            onBlock: { blockTarget = $0 }
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
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 44, height: 44)          // HIG minimum tap target
                .background(Theme.bgRaised, in: Circle())
                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .accessibilityLabel(model.hasTrimmedNewer ? "Return to latest messages" : "Jump to latest messages")
        .padding(.trailing, 14)
        .padding(.bottom, 10)
        .transition(.opacity)
    }

    private func errorBanner(_ text: String) -> some View {
        HStack {
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(Theme.danger)
                .lineLimit(2)
            Spacer()
            Button {
                model.errorMessage = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Theme.danger.opacity(0.1))
    }

    // MARK: Item building

    private static let systemTypes: Set<String> = ["routing", "announcement", "notification", "permission"]

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
        // Approval cards stay in the stream in both states: pending renders an
        // actionable card, resolved shrinks to a quiet trace line (ApprovalCardView).
        var result: [ChatTimelineItem] = []
        result.reserveCapacity(visible.count + 8)
        var previousDay: Date?
        let messagesById = Dictionary(uniqueKeysWithValues: visible.map { ($0.msgId, $0) })

        for (index, message) in visible.enumerated() {
            let day = message.createdDate
            if let day, !TimeFormat.sameDay(day, previousDay) {
                result.append(.day(label: TimeFormat.dayLabel(day), key: message.msgId))
            }
            if day != nil { previousDay = day }

            let isSystem = message.senderType == "system"
                || Self.systemTypes.contains(message.msgType ?? "")
            if isSystem {
                result.append(.system(message))
                continue
            }

            let isOwn = message.senderType == "user" && message.senderId == currentUserId

            func groupable(_ other: MessageDto?) -> Bool {
                guard let other else { return false }
                let otherIsSystem = other.senderType == "system"
                    || Self.systemTypes.contains(other.msgType ?? "")
                return !otherIsSystem
                    && other.senderId == message.senderId
                    && other.senderType == message.senderType
                    && TimeFormat.sameDay(other.createdDate, message.createdDate)
            }

            let prev = index > 0 ? visible[index - 1] : nil
            let next = index + 1 < visible.count ? visible[index + 1] : nil
            let isFirstInGroup = !groupable(prev)
            let isLastInGroup = !groupable(next)

            result.append(.bubble(
                message,
                isOwn: isOwn,
                showName: !isOwn && !model.channel.isDM && isFirstInGroup,
                showAvatar: !isOwn && isFirstInGroup,   // web parity: avatar on the FIRST of a run, top-aligned
                isLast: isLastInGroup,
                formattedTime: TimeFormat.time(message.createdDate),
                repliedTo: message.replyToMsgId.flatMap { messagesById[$0] }
            ))
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
    @Binding var atBottom: Bool
    let onLoadOlder: () -> Void
    let onReply: (MessageDto) -> Void
    let onForward: (MessageDto) -> Void
    let onFile: (MessageFileRef) -> Void
    let onReport: (MessageDto) -> Void
    let onBlock: (MessageDto) -> Void

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
        private var hasAppliedInitialSnapshot = false

        init(parent: ChatCollectionTimeline) {
            self.parent = parent
            lastFollowTick = parent.followBottomTick
            lastForceTick = parent.forceBottomTick
        }

        private lazy var registration = UICollectionView.CellRegistration<UICollectionViewCell, String> {
            [weak self] cell, _, itemId in
            guard let self, let item = self.itemsById[itemId] else { return }
            cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
            cell.contentConfiguration = UIHostingConfiguration {
                ChatTimelineRow(
                    item: item,
                    channelId: self.parent.channelId,
                    onLoadOlder: self.parent.onLoadOlder,
                    onReply: self.parent.onReply,
                    onForward: self.parent.onForward,
                    onFile: self.parent.onFile,
                    onReport: self.parent.onReport,
                    onBlock: self.parent.onBlock
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
            lastForceTick = parent.forceBottomTick
            lastFollowTick = parent.followBottomTick
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
            guard contentChanged || forceBottom || followBottom || !hasAppliedInitialSnapshot else { return }
            let interval = timelinePerformanceSignposter.beginInterval("ApplyTimelineSnapshot")

            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(newIdentifiers, toSection: 0)
            let existingIds = Set(oldIdentifiers)
            let reconfigurable = changedIds.filter { existingIds.contains($0) && newItemsById[$0] != nil }
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
    let onLoadOlder: () -> Void
    let onReply: (MessageDto) -> Void
    let onForward: (MessageDto) -> Void
    let onFile: (MessageFileRef) -> Void
    let onReport: (MessageDto) -> Void
    let onBlock: (MessageDto) -> Void

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
            } else {
                SystemMessageView(message: message)
            }
        case .bubble(let message, let isOwn, let showName, let showAvatar, let isLast, let time, let repliedTo):
            VStack(alignment: isOwn ? .trailing : .leading, spacing: 0) {
                MessageBubbleView(
                    message: message,
                    isOwn: isOwn,
                    showSenderName: showName,
                    showAvatar: showAvatar,
                    isLastInGroup: isLast,
                    formattedTime: time,
                    repliedTo: repliedTo,
                    onReply: { onReply(message) },
                    onForward: { onForward(message) },
                    onTapFile: onFile,
                    onReport: { onReport(message) },
                    onBlock: { onBlock(message) }
                )
                if message.msgType == "task_claim_confirmation" {
                    TaskClaimConfirmationFooter(message: message, channelId: channelId)
                        .padding(.leading, 58)
                        .padding(.top, 2)
                }
            }
        }
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
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .padding(16)
            Text(message.content.replacingOccurrences(of: "\n", with: " "))
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
            if let errorText {
                Text(errorText)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 16)
            }
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(convo?.rows ?? []) { row in
                        Button { forward(to: row.channel) } label: {
                            HStack(spacing: 11) {
                                ChannelAvatarView(channel: row.channel, size: 34)
                                Text(row.channel.displayName)
                                    .font(.system(size: 15))
                                    .foregroundStyle(Theme.textBody)
                                    .lineLimit(1)
                                Spacer()
                                if busyId == row.channel.channelId {
                                    ProgressView().controlSize(.small)
                                }
                            }
                            .padding(.horizontal, 16)
                            .frame(minHeight: 48)
                            .contentShape(Rectangle())
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
                    Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    if let bytes = file.sizeBytes {
                        Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
                            .font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                    }
                }
                Spacer()
                if let shareURL {
                    ShareLink(item: shareURL) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 17))
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
                Image(systemName: "doc.fill").font(.system(size: 44)).foregroundStyle(Theme.textFaint)
                Text("Preview not available for this type").font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                if let shareURL {
                    ShareLink(item: shareURL) {
                        Label("Save / Share", systemImage: "square.and.arrow.up")
                            .font(.system(size: 15, weight: .semibold))
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

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row(title: "Auto", subtitle: "Route by @mention to each bot's primary", selected: selectedSessionId == nil) {
                        selectedSessionId = nil; dismiss()
                    }
                }
                ForEach(bots, id: \.memberId) { bot in
                    Section(bot.name) {
                        let sessions = sessionsByBot[bot.memberId] ?? []
                        if sessions.isEmpty {
                            Text("No sessions").font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                        }
                        ForEach(sessions) { s in
                            row(title: s.tag + (s.isPrimary == true ? " · primary" : ""), subtitle: s.status, selected: selectedSessionId == s.sessionId) {
                                selectedSessionId = s.sessionId; dismiss()
                            }
                        }
                    }
                }
            }
            .navigationTitle("Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } } }
            .overlay { if isLoading && sessionsByBot.isEmpty { ProgressView() } }
        }
        .task { await load() }
    }

    private func row(title: String, subtitle: String?, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15)).foregroundStyle(Theme.textBody)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle).font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                    }
                }
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
            }
            .frame(minHeight: 44)
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
                    Text(errorText).font(.system(size: 13)).foregroundStyle(Theme.danger)
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
                .font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
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
