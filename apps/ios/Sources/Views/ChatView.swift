import SwiftUI
import UIKit

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

struct ChatView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @State private var model: ChatModel
    @State private var panel: ChannelPanel?
    @State private var forwardMessage: MessageDto?
    @State private var previewFile: MessageFileRef?
    @State private var showSessionSheet = false
    @State private var showModelSheet = false
    private let listModel: ConversationListModel?

    init(channel: ChannelDto, listModel: ConversationListModel? = nil) {
        _model = State(initialValue: ChatModel(channel: channel))
        self.listModel = listModel
    }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            messageScroll
            if let reply = model.replyTo {
                replyBar(reply)
            }
            if let error = model.errorMessage {
                errorBanner(error)
            }
            ComposerView(
                text: $model.composerText,
                placeholder: composerPlaceholder,
                isSending: model.isSending,
                onSend: { Task { await self.model.send() } },
                onChooseSession: { showSessionSheet = true },
                onModelSettings: { showModelSheet = true }
            )
        }
        .background(Theme.bgApp)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                CircleIconButton(systemName: "line.3.horizontal", badge: shell.pendingApprovals) {
                    withAnimation(.easeOut(duration: 0.25)) { shell.openDrawer() }
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
            listModel?.openChannelId = model.channel.channelId
            listModel?.markRead(channelId: model.channel.channelId)
            await model.loadInitial()
        }
        .onDisappear {
            if listModel?.openChannelId == model.channel.channelId {
                listModel?.openChannelId = nil
            }
            listModel?.markRead(channelId: model.channel.channelId)
            model.detach()
        }
        .sheet(item: $panel) { panel in
            Group {
                switch panel {
                case .members:   MembersSheet(channelId: model.channel.channelId)
                case .viewboard: ViewBoardSheet(channelId: model.channel.channelId)
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
            Divider()
            Button { panel = .viewboard } label: {
                Label("ViewBoard", systemImage: "rectangle.3.group")
            }
            Button { panel = .workbench } label: {
                Label("Workbench", systemImage: "sidebar.right")
            }
            if !model.channel.isDM {
                Divider()
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
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if model.hasMoreBefore {
                        loadOlderSentinel
                    }
                    ForEach(items) { item in
                        itemView(item)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.scrollToBottomTick) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .overlay {
                if model.isLoading && model.messages.isEmpty {
                    ProgressView()
                }
            }
        }
    }

    private var loadOlderSentinel: some View {
        HStack {
            if model.isLoadingOlder {
                ProgressView()
                    .controlSize(.small)
            } else {
                Button("Load earlier messages") {
                    Task { await model.loadOlder() }
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.link)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .onAppear {
            Task { await model.loadOlder() }
        }
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

    private enum ChatItem: Identifiable {
        case day(label: String, key: String)
        case system(MessageDto)
        case bubble(MessageDto, isOwn: Bool, showName: Bool, showAvatar: Bool, isLast: Bool)

        var id: String {
            switch self {
            case .day(_, let key): return "day-\(key)"
            case .system(let msg): return "sys-\(msg.msgId)"
            case .bubble(let msg, _, _, _, _): return msg.msgId
            }
        }
    }

    private static let systemTypes: Set<String> = ["routing", "announcement", "notification", "permission"]

    private var items: [ChatItem] {
        let currentUserId = app.session?.userId
        // Approval cards stay in the stream in both states: pending renders an
        // actionable card, resolved shrinks to a quiet trace line (ApprovalCardView).
        let visible = model.messages

        var result: [ChatItem] = []
        result.reserveCapacity(visible.count + 8)
        var previousDay: Date?

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
                isLast: isLastInGroup
            ))
        }
        return result
    }

    @ViewBuilder
    private func itemView(_ item: ChatItem) -> some View {
        switch item {
        case .day(let label, _):
            DaySeparatorView(label: label)
        case .system(let message):
            if message.msgType == "permission" {
                ApprovalCardView(message: message)
            } else {
                SystemMessageView(message: message)
            }
        case .bubble(let message, let isOwn, let showName, let showAvatar, let isLast):
            MessageBubbleView(
                message: message,
                isOwn: isOwn,
                showSenderName: showName,
                showAvatar: showAvatar,
                isLastInGroup: isLast,
                repliedTo: message.replyToMsgId.flatMap { id in
                    model.messages.first { $0.msgId == id }
                },
                onReply: { model.replyTo = message },
                onForward: { forwardMessage = message },
                onTapFile: { file in previewFile = file }
            )
        }
    }
}

// MARK: - Members sheet

/// The channel roster (web MembersPopover): people and bots with online dots
/// and roles, fetched from GET /channels/:id/members.
private struct MembersSheet: View {
    @Environment(AppModel.self) private var app
    let channelId: String

    @State private var members: [ChannelMemberDto] = []
    @State private var isLoading = true
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Members")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                if !members.isEmpty {
                    Text("\(members.count)")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .padding(16)
            Divider().overlay(Theme.border)
            if isLoading {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
            } else if let errorText {
                Text(errorText)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.danger)
                    .padding(16)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(members, id: \.memberId) { member in
                            memberRow(member)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
        .task { await load() }
    }

    private func memberRow(_ member: ChannelMemberDto) -> some View {
        HStack(spacing: 11) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(seedId: member.memberId, name: member.name, size: 34, monochrome: true)
                if member.isOnline == true {
                    Circle()
                        .fill(Theme.online)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(Theme.bgSurface, lineWidth: 2))
                }
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(member.name)
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.textBody)
                        .lineLimit(1)
                    if member.memberType == "bot" {
                        Text("BOT")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Theme.bgSelected)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }
                if let role = member.role, !role.isEmpty {
                    Text(role)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
    }

    private func load() async {
        guard let api = app.api else { isLoading = false; return }
        do {
            members = try await api.listMembers(channelId: channelId)
            isLoading = false
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            isLoading = false
        }
    }
}

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
            Divider().overlay(Theme.border)
            ScrollView {
                LazyVStack(spacing: 0) {
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
private struct ViewBoardSheet: View {
    @Environment(AppModel.self) private var app
    let channelId: String

    @State private var events: [AuditEvent] = []
    @State private var isLoading = true
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.3.group").foregroundStyle(Theme.accent)
                Text("ViewBoard · Audit")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
            }
            .padding(16)
            Text("Approval history for this channel's agents. Plan, cost and activity boards are live — view them on the web.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
            Divider().overlay(Theme.border)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
        } else if let errorText {
            ComingSoon(icon: "exclamationmark.triangle", text: errorText)
        } else if events.isEmpty {
            ComingSoon(icon: "checkmark.seal", text: "No approvals recorded yet")
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(events) { event in
                        auditRow(event)
                        Divider().overlay(Theme.border).padding(.leading, 44)
                    }
                }
            }
        }
    }

    private func auditRow(_ event: AuditEvent) -> some View {
        let allowed = (event.decision ?? "").hasPrefix("allow")
        let denied = (event.decision ?? "").hasPrefix("reject") || (event.decision ?? "").hasPrefix("deny")
        return HStack(spacing: 11) {
            Image(systemName: denied ? "xmark.circle" : (allowed ? "checkmark.circle" : "clock"))
                .font(.system(size: 16))
                .foregroundStyle(denied ? Theme.danger : (allowed ? Theme.online : Theme.textMuted))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(prettyEvent(event.eventType))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                if let decision = event.decision {
                    Text(decision).font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                }
            }
            Spacer()
            if let ts = event.createdAt {
                Text(TimeFormat.listStamp(TimeFormat.parse(ts)))
                    .font(.system(size: 11)).foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
    }

    private func prettyEvent(_ raw: String) -> String {
        raw.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func load() async {
        guard let api = app.api else { isLoading = false; return }
        do {
            events = try await api.permissionAudit(channelId: channelId, limit: 100)
            isLoading = false
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            isLoading = false
        }
    }
}

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
            Divider().overlay(Theme.border)
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
