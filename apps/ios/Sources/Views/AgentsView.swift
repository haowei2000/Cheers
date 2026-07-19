import SwiftUI

/// Fleet — the workspace's mission control, matching the web's Fleet page:
/// a "Waiting on you" section (pending approvals) over a "Bots" roster with
/// live status.
struct FleetView: View {
    @Environment(AppModel.self) private var app
    var activity: ActivityModel
    @State private var model = AgentsModel()
    @State private var sheetItem: ApprovalItem?
    @State private var showOnboarding = false

    var body: some View {
        ScreenScaffold(title: "Fleet") {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if !activity.pending.isEmpty {
                        sectionHeader("Waiting on you", icon: "shield.lefthalf.filled", tint: Theme.warning)
                        ForEach(activity.pending) { item in
                            approvalCard(item)
                        }
                    }

                    HStack {
                        sectionHeader("Bots")
                        Spacer()
                        Button { showOnboarding = true } label: {
                            Label("Add", systemImage: "plus")
                                .font(.system(size: 12.5, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.accent)
                        .padding(.top, 12)
                    }
                    summaryStrip.padding(.vertical, 2)
                    if model.isLoading && model.bots.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
                    } else if model.bots.isEmpty {
                        emptyState
                    } else {
                        ForEach(model.bots) { bot in
                            botRow(bot)
                            if bot.id != model.bots.last?.id {
                                Divider().overlay(Theme.border).padding(.leading, 60)
                            }
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .refreshable { await model.load(); await activity.loadInvites() }
        }
        .task {
            model.attach(app)
            await model.loadIfNeeded()
        }
        .sheet(item: $sheetItem) { item in
            ApprovalSheetView(channelId: item.channelId, botName: item.botName, request: item.request)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showOnboarding) {
            BotOnboardingView(existingBots: model.bots) {
                Task { await model.load() }
            }
        }
    }

    /// An empty fleet is the most common first-run state, so it doubles as the
    /// entry point rather than just reporting that nothing is here.
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let message = model.errorMessage {
                Text(message).font(.system(size: 13)).foregroundStyle(Theme.danger)
            } else {
                Text("No agents yet")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                Text("Create one here, then connect it from the machine that will run it — this phone can't host an agent itself.")
                    .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button { showOnboarding = true } label: {
                    Label("Add a bot", systemImage: "plus")
                        .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 9)
                        .background(Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 16)
    }

    private func sectionHeader(_ title: String, icon: String? = nil, tint: Color = Theme.textSecondary) -> some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon).font(.system(size: 12)).foregroundStyle(tint)
            }
            Text(title.uppercased())
                .font(.system(size: 11.5, weight: .bold)).tracking(0.7)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 4).padding(.top, 12).padding(.bottom, 2)
    }

    // MARK: Waiting on you

    private func approvalCard(_ item: ApprovalItem) -> some View {
        HStack(spacing: 0) {
            Rectangle().fill(Theme.warning).frame(width: 3)
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 9) {
                    AvatarView(seedId: item.message.senderId ?? item.id, name: item.botName, size: 30)
                    Text(item.request.title)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Spacer()
                }
                if let command = item.request.command {
                    Text(command)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background(Theme.bgApp)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                Text("\(item.botName) · #\(channelName(item))")
                    .font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                Button { sheetItem = item } label: {
                    Text("Review")
                        .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            .padding(12)
        }
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func channelName(_ item: ApprovalItem) -> String {
        item.channelId.prefix(6).description
    }

    // MARK: Bots

    private var summaryStrip: some View {
        HStack(spacing: 7) {
            summaryChip(dot: Theme.online, "\(model.onlineCount) online")
            summaryChip(dot: Theme.textFaint, "\(model.offlineCount) idle")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func summaryChip(dot: Color, _ label: String) -> some View {
        HStack(spacing: 6) {
            Circle().fill(dot).frame(width: 8, height: 8)
            Text(label).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 11).padding(.vertical, 7)
        .background(Theme.bgRaised)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private func botRow(_ bot: BotDto) -> some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(seedId: bot.botId, name: bot.name, size: 44)
                Circle()
                    .fill(bot.online ? Theme.online : Theme.textFaint)
                    .frame(width: 12, height: 12)
                    .overlay(Circle().stroke(Theme.bgApp, lineWidth: 2.5))
                    .offset(x: 1, y: 1)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(bot.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary).lineLimit(1)
                    Text("BOT")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Theme.botBadgeText)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Theme.botBadgeBg)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                Text(statusLine(bot))
                    .font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer()
        }
        .padding(.vertical, 10)
    }

    private func statusLine(_ bot: BotDto) -> String {
        if let text = bot.statusText, !text.isEmpty {
            if let emoji = bot.statusEmoji, !emoji.isEmpty { return "\(emoji) \(text)" }
            return text
        }
        return bot.online ? "Online" : "Offline"
    }
}
