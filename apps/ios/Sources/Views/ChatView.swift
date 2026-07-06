import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var app
    @State private var model: ChatModel
    private let listModel: ConversationListModel?

    init(channel: ChannelDto, listModel: ConversationListModel? = nil) {
        _model = State(initialValue: ChatModel(channel: channel))
        self.listModel = listModel
    }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            messageScroll
            if let error = model.errorMessage {
                errorBanner(error)
            }
            ComposerView(
                text: $model.composerText,
                placeholder: composerPlaceholder,
                isSending: model.isSending,
                onSend: { Task { await self.model.send() } }
            )
        }
        .background(Theme.bgApp)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                header
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
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
            }
            if let purpose = model.channel.purpose, !purpose.isEmpty {
                Text(purpose)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }
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
        let visible = model.messages.filter { message in
            // Hide resolved approval cards, like the web MessageList.
            if message.msgType == "permission",
               message.contentData?["resolved"]?.boolValue == true {
                return false
            }
            return true
        }

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
                showAvatar: !isOwn && isLastInGroup,
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
            SystemMessageView(message: message)
        case .bubble(let message, let isOwn, let showName, let showAvatar, let isLast):
            MessageBubbleView(
                message: message,
                isOwn: isOwn,
                showSenderName: showName,
                showAvatar: showAvatar,
                isLastInGroup: isLast
            )
        }
    }
}
