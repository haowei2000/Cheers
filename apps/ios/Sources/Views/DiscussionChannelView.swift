import SwiftUI

/// Topic-first presentation for Discuss channels. Compact widths navigate from
/// the topic list into a thread; Regular width keeps both visible side by side.
struct DiscussionChannelView<Footer: View>: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var model: ChatModel
    let currentUserId: String?
    @ViewBuilder let footer: () -> Footer

    @State private var search = ""
    @State private var topicWidth: CGFloat = 320
    @State private var dragOrigin: CGFloat?

    private var isWide: Bool { horizontalSizeClass == .regular }
    private var showsDetail: Bool {
        model.selectedDiscussionId != nil || model.isCreatingDiscussion
    }
    private var splitKey: String {
        "cheers:discussion-split:\(model.channel.channelId)"
    }

    var body: some View {
        GeometryReader { proxy in
            if isWide && proxy.size.width >= 720 {
                HStack(spacing: 0) {
                    topicList
                        .frame(width: clampedTopicWidth(in: proxy.size.width))
                    topicSplitter(totalWidth: proxy.size.width)
                    detail
                }
                .task(id: model.discussions.first?.id) {
                    if model.selectedDiscussionId == nil,
                       !model.isCreatingDiscussion,
                       let first = model.discussions.first
                    {
                        let candidate = model.discussions.first {
                            $0.id == model.rememberedDiscussionId
                        } ?? first
                        await model.selectDiscussion(candidate.id)
                    }
                }
            } else if showsDetail {
                detail
            } else {
                topicList
            }
        }
        .task(id: search) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await model.loadDiscussions(query: search)
        }
        .onAppear(perform: loadTopicWidth)
        .onChange(of: model.channel.channelId) { _, _ in
            loadTopicWidth()
        }
    }

    private func loadTopicWidth() {
        let stored = UserDefaults.standard.double(forKey: splitKey)
        if stored >= 260 { topicWidth = stored }
        else { topicWidth = 320 }
    }

    private func clampedTopicWidth(in total: CGFloat) -> CGFloat {
        let minLeft: CGFloat = 280
        let minRight: CGFloat = 360
        let maxLeft = max(minLeft, total - minRight)
        return min(max(topicWidth, minLeft), maxLeft)
    }

    private func topicSplitter(totalWidth: CGFloat) -> some View {
        ZStack {
            Divider()
            Color.clear
                .frame(width: 12)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 1)
                        .onChanged { value in
                            if dragOrigin == nil { dragOrigin = topicWidth }
                            topicWidth = min(
                                max((dragOrigin ?? topicWidth) + value.translation.width, 280),
                                max(280, totalWidth - 360)
                            )
                        }
                        .onEnded { _ in
                            UserDefaults.standard.set(
                                Double(clampedTopicWidth(in: totalWidth)),
                                forKey: splitKey
                            )
                            dragOrigin = nil
                        }
                )
                .accessibilityLabel("Resize discussion panes")
                .accessibilityHint("Drag to change the topic list width")
                .accessibilityAddTraits(.adjustable)
        }
        .frame(width: 12)
    }

    private var topicList: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(Theme.textMuted)
                    TextField("Search discussions", text: $search)
                        .textInputAutocapitalization(.never)
                        .submitLabel(.search)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(Theme.bgRaised, in: RoundedRectangle(cornerRadius: 11))

                Button {
                    model.startDiscussion()
                } label: {
                    Image(systemName: "square.and.pencil")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 11))
                .accessibilityLabel("New discussion")
            }
            .padding(12)

            Divider()

            if model.isLoadingDiscussions && model.discussions.isEmpty {
                Spacer()
                ProgressView("Loading discussions…")
                Spacer()
            } else if model.discussions.isEmpty {
                ContentUnavailableView {
                    Label("No discussions yet", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text(search.isEmpty ? "Start a topic for this channel." : "No topic or reply matches your search.")
                } actions: {
                    if search.isEmpty {
                        Button("Start a discussion") { model.startDiscussion() }
                            .buttonStyle(.borderedProminent)
                    }
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 9) {
                        ForEach(model.discussions) { topic in
                            topicCard(topic)
                        }
                        if model.discussionNextCursor != nil {
                            Button {
                                Task { await model.loadMoreDiscussions(query: search) }
                            } label: {
                                Label("Load more", systemImage: "arrow.down.circle")
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .padding(10)
                }
            }
        }
        .background(Theme.bgApp)
    }

    private func topicCard(_ topic: DiscussionSummaryDto) -> some View {
        let copy = titleAndPreview(topic.root)
        let selected = topic.id == model.selectedDiscussionId && !model.isCreatingDiscussion
        return Button {
            Task { await model.selectDiscussion(topic.id) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                AvatarView(
                    seedId: topic.root.senderId ?? topic.root.msgId,
                    name: topic.root.senderName,
                    size: 34,
                    monochrome: true
                )
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(copy.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(relativeTime(topic.lastActivityAt))
                            .font(.caption2)
                            .foregroundStyle(Theme.textMuted)
                    }
                    if !copy.preview.isEmpty {
                        Text(copy.preview)
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(2)
                    }
                    if let last = topic.lastReply {
                        Text("\(last.senderName) · \(last.content.isEmpty ? String(localized: "Attachment") : last.content)")
                            .font(.caption2)
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                    }
                    HStack(spacing: 12) {
                        Label("\(topic.replyCount)", systemImage: "bubble.left")
                        Label("\(topic.participantCount)", systemImage: "person.2")
                        Spacer()
                        Image(systemName: "chevron.right")
                    }
                    .font(.caption2)
                    .foregroundStyle(Theme.textMuted)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.bgSelected : Theme.bgRaised)
            .overlay {
                RoundedRectangle(cornerRadius: 13)
                    .stroke(selected ? Color.accentColor.opacity(0.55) : Theme.textFaint.opacity(0.3))
            }
            .clipShape(RoundedRectangle(cornerRadius: 13))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(copy.title), \(topic.replyCount) replies")
    }

    private var detail: some View {
        VStack(spacing: 0) {
            if !isWide {
                Button {
                    model.closeDiscussion()
                } label: {
                    Label("Discussions", systemImage: "chevron.left")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                Divider()
            }

            if model.isCreatingDiscussion {
                ContentUnavailableView {
                    Label("Start a new discussion", systemImage: "square.and.pencil")
                } description: {
                    Text("Write the topic below. The first non-empty line becomes its title.")
                }
                .frame(maxHeight: .infinity)
            } else if model.isLoadingDiscussion && model.selectedDiscussionRoot == nil {
                Spacer()
                ProgressView("Opening discussion…")
                Spacer()
            } else if let root = model.selectedDiscussionRoot {
                rootSummary(root)
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.discussionHasMoreBefore {
                            Button {
                                Task { await model.loadOlderDiscussionReplies() }
                            } label: {
                                if model.isLoadingOlderDiscussionReplies {
                                    ProgressView().frame(maxWidth: .infinity, minHeight: 44)
                                } else {
                                    Label("Load older replies", systemImage: "arrow.up.circle")
                                        .frame(maxWidth: .infinity, minHeight: 44)
                                }
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.textSecondary)
                        }
                        if threadRows.isEmpty {
                            Text("No replies yet. Continue the discussion below.")
                                .font(.subheadline)
                                .foregroundStyle(Theme.textMuted)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 54)
                        } else {
                            ForEach(threadRows) { row in
                                discussionReplyRow(row)
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }
            } else {
                ContentUnavailableView("Select a discussion", systemImage: "bubble.left.and.bubble.right")
                    .frame(maxHeight: .infinity)
            }

            footer()
        }
        .background(Theme.bgApp)
    }

    private func rootSummary(_ root: MessageDto) -> some View {
        let copy = titleAndPreview(root)
        return HStack(alignment: .top, spacing: 11) {
            AvatarView(
                seedId: root.senderId ?? root.msgId,
                name: root.senderName,
                size: 36,
                monochrome: true
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(copy.title)
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                Text("\(root.senderName ?? String(localized: "Unknown")) · \(formattedTime(root))")
                    .font(.caption)
                    .foregroundStyle(Theme.textMuted)
                if !copy.preview.isEmpty {
                    Text(copy.preview)
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(.bar)
    }

    private func titleAndPreview(_ message: MessageDto) -> (title: String, preview: String) {
        if message.isDeleted == true {
            return ("Deleted discussion", "The original post was deleted.")
        }
        let lines = message.content
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let title = lines.first ?? (message.files?.isEmpty == false ? "Shared attachment" : "Untitled discussion")
        let preview = lines.dropFirst().joined(separator: " ")
        return (String(title.prefix(120)), String((preview.isEmpty ? message.content : preview).prefix(240)))
    }

    private struct ThreadRow: Identifiable {
        let message: MessageDto
        let depth: Int
        let isLastSibling: Bool
        let parentInView: Bool
        var id: String { message.msgId }
    }

    /// REST replies plus live WS rows (streaming bots) for the open topic.
    private var threadMessages: [MessageDto] {
        guard let root = model.selectedDiscussionRoot else { return model.discussionReplies }
        return MessageTree.mergeDiscussion(
            root: root,
            replies: model.discussionReplies,
            live: model.messages
        )
    }

    private var threadRows: [ThreadRow] {
        guard let root = model.selectedDiscussionRoot else { return [] }
        let grouped = MessageTree.groupByReply(threadMessages)
        return flattenThread(parentId: root.msgId, grouped: grouped, depth: 1)
    }

    private func flattenThread(
        parentId: String,
        grouped: MessageTree.Grouped,
        depth: Int
    ) -> [ThreadRow] {
        let kids = grouped.childrenByParent[parentId] ?? []
        var rows: [ThreadRow] = []
        for (index, child) in kids.enumerated() {
            rows.append(ThreadRow(
                message: child,
                depth: depth,
                isLastSibling: index == kids.count - 1,
                parentInView: child.replyToMsgId.flatMap { grouped.byId[$0] } != nil
            ))
            rows.append(contentsOf: flattenThread(
                parentId: child.msgId,
                grouped: grouped,
                depth: depth + 1
            ))
        }
        return rows
    }

    private func discussionReplyRow(_ row: ThreadRow) -> some View {
        let message = row.message
        let isOwn = message.senderType == "user" && message.senderId == currentUserId
        return MessageBubbleView(
            message: message,
            isOwn: isOwn,
            showAvatar: true,
            formattedTime: formattedTime(message),
            repliedTo: row.parentInView ? nil : message.replyToMsgId.flatMap { parent in
                threadMessages.first { $0.msgId == parent }
            },
            nested: row.depth > 0,
            onReply: { model.beginReply(to: message) },
            onMention: currentUserId == message.senderId
                ? nil
                : { model.mentionSender(of: message) }
        )
        .padding(.leading, 16 + CGFloat(max(row.depth - 1, 0)) * 16)
        .overlay(alignment: .leading) {
            DiscussionThreadRail(isLastSibling: row.isLastSibling)
                .frame(width: 14)
                .padding(.leading, CGFloat(max(row.depth - 1, 0)) * 16 + 6)
        }
        .accessibilityIdentifier("discussion-reply-\(message.msgId)")
    }

    private func formattedTime(_ message: MessageDto) -> String {
        guard let date = message.createdDate else { return "" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func relativeTime(_ raw: String) -> String {
        guard let date = TimeFormat.parse(raw) else { return "" }
        return date.formatted(.relative(presentation: .numeric))
    }
}

/// L-shaped reply connector (chat timeline parity) for nested discussion rows.
private struct DiscussionThreadRail: View {
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
