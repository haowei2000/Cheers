import SwiftUI

/// Fleet — bot roster + create/manage. Approvals live in Activity
/// (`docs/arch/CLIENT_NAV_IA.md` §5); this screen deep-links when any are pending.
struct FleetView: View {
    private enum Section: String, CaseIterable, Identifiable {
        case overview = "Overview", bots = "Bots", hosts = "Hosts", audit = "Audit"
        var id: String { rawValue }
    }
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    var activity: ActivityModel
    @State private var model = AgentsModel()
    @State private var showOnboarding = false
    @State private var selectedBot: BotDto?
    @State private var searchText = ""
    @State private var searchPresented = false
    @State private var section: Section = .overview

    private var filteredBots: [BotDto] {
        guard !searchText.isEmpty else { return model.bots }
        return model.bots.filter { bot in
            bot.name.localizedCaseInsensitiveContains(searchText)
                || (bot.statusText?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    var body: some View {
        ScreenScaffold(title: "Fleet", titleDisplayMode: .inline) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if activity.pending.count > 0 {
                        Button { shell.push(.activity) } label: {
                            CheersOperationsItem(row: CheersItemRow(
                                title: "\(activity.pending.count) waiting on you",
                                subtitle: "Review in Activity",
                                leading: AnyView(Image(systemName: "shield.lefthalf.filled").foregroundStyle(Theme.warning)),
                                criticalStatus: AnyView(Text("\(activity.pending.count)").font(.caption2.bold()).foregroundStyle(Theme.warning)),
                                trailing: AnyView(Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.textFaint))
                            ))
                        }
                        .buttonStyle(.plain)
                    }

                    Picker("Fleet section", selection: $section) {
                        ForEach(Section.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.vertical, 4)

                    switch section {
                    case .overview:
                        sectionHeader("Status")
                        summaryStrip.padding(.vertical, 2)
                        sectionHeader("Recent bots")
                        botList(Array(filteredBots.prefix(5)))
                        if !model.auditEvents.isEmpty {
                            sectionHeader("Recent events")
                            ForEach(model.auditEvents.prefix(5)) { auditRow($0) }
                        }
                    case .bots:
                        sectionHeader("Bots")
                        botList(filteredBots)
                    case .hosts:
                        sectionHeader("Registered hosts")
                        if model.hosts.isEmpty {
                            ContentUnavailableView("No hosts", systemImage: "laptopcomputer", description: Text("Add one to choose where a bot runs."))
                        } else {
                            ForEach(model.hosts) { hostRow($0) }
                        }
                    case .audit:
                        sectionHeader("Audit timeline")
                        if model.auditEvents.isEmpty {
                            ContentUnavailableView("No audit events", systemImage: "clock.arrow.circlepath")
                        } else {
                            ForEach(model.auditEvents) { auditRow($0) }
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .refreshable { await model.load(); await activity.loadInvites() }
        }
        .searchable(
            text: $searchText,
            isPresented: $searchPresented,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search fleet"
        )
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Add", systemImage: "plus") {
                    showOnboarding = true
                }
                .labelStyle(.iconOnly)

                Button("Search", systemImage: "magnifyingglass") {
                    searchPresented = true
                }
                .labelStyle(.iconOnly)
            }
        }
        .task {
            model.attach(app)
            await model.loadIfNeeded()
        }
        .sheet(isPresented: $showOnboarding) {
            BotOnboardingView(existingBots: model.bots) {
                Task { await model.load() }
            }
        }
        .sheet(item: $selectedBot) { bot in
            BotDetailView(bot: bot) {
                Task { await model.load() }
            }
        }
    }

    @ViewBuilder
    private func botList(_ bots: [BotDto]) -> some View {
        if model.isLoading && model.bots.isEmpty {
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
        } else if model.bots.isEmpty {
            emptyState
        } else if bots.isEmpty {
            ContentUnavailableView.search(text: searchText)
        } else {
            ForEach(bots) { bot in
                Button { selectedBot = bot } label: { botRow(bot) }.buttonStyle(.plain)
                if bot.id != bots.last?.id { Divider().overlay(Theme.border).padding(.leading, 60) }
            }
        }
    }

    private func hostRow(_ host: FleetHostDto) -> some View {
        CheersOperationsItem(row: CheersItemRow(
            title: "\(host.botName) · \(host.deviceName)",
            subtitle: "\(host.agentType) · MCP \(host.mcpConnectionState.replacingOccurrences(of: "_", with: " "))",
            leading: AnyView(Image(systemName: "laptopcomputer").foregroundStyle(Theme.textSecondary)),
            status: AnyView(Text(host.revokedAt != nil ? "Revoked" : host.online ? "Online" : host.status.capitalized)
                .font(.caption).foregroundStyle(host.online ? Theme.online : Theme.textSecondary))
        ))
    }

    private func auditRow(_ event: FleetAuditEventDto) -> some View {
        CheersOperationsItem(row: CheersItemRow(
            title: event.eventType.replacingOccurrences(of: ".", with: " · ").replacingOccurrences(of: "_", with: " "),
            subtitle: event.createdAt,
            leading: AnyView(Image(systemName: "clock.arrow.circlepath").foregroundStyle(Theme.textSecondary)),
            status: AnyView(Text(event.source.capitalized).font(.caption).foregroundStyle(Theme.textSecondary))
        ))
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let message = model.errorMessage {
                Text(message).font(.subheadline).foregroundStyle(Theme.danger)
            } else {
                Text("No agents yet")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                Text("Create one here, then connect it from the machine that will run it — this phone can't host an agent itself.")
                    .font(.subheadline).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button { showOnboarding = true } label: {
                    Label("Add a bot", systemImage: "plus")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
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

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption.weight(.bold)).tracking(0.7)
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 4).padding(.top, 12).padding(.bottom, 2)
    }

    private var summaryStrip: some View {
        HStack(spacing: 7) {
            summaryChip(dot: Theme.online, "\(model.onlineCount) online")
            summaryChip(dot: Theme.textFaint, "\(model.offlineCount) offline")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func summaryChip(dot: Color, _ label: String) -> some View {
        HStack(spacing: 6) {
            Circle().fill(dot).frame(width: 8, height: 8)
            Text(label).font(.caption.weight(.medium)).foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 11).padding(.vertical, 7)
        .background(Theme.bgRaised)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private func botRow(_ bot: BotDto) -> some View {
        CheersEntityItem(row: CheersItemRow(
            title: bot.name,
            subtitle: statusLine(bot),
            leading: AnyView(ZStack(alignment: .bottomTrailing) {
                AvatarView(
                    seedId: bot.botId,
                    name: bot.name,
                    size: 44,
                    imageURL: bot.avatarUrl.flatMap(URL.init(string:))
                )
                Circle()
                    .fill(bot.isDisabled == true ? Theme.danger : (bot.online ? Theme.online : Theme.textFaint))
                    .frame(width: 12, height: 12)
                    .overlay(Circle().stroke(Theme.bgApp, lineWidth: 2.5))
                    .offset(x: 1, y: 1)
            }),
            criticalStatus: bot.isDisabled == true ? AnyView(Text("OFF").font(.caption2.bold()).foregroundStyle(Theme.danger)) : nil,
            status: AnyView(Text("BOT").font(.caption2.bold()).foregroundStyle(Theme.botBadgeText)),
            trailing: AnyView(Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.textFaint))
        ))
        .accessibilityHint("Opens bot management")
    }

    private func statusLine(_ bot: BotDto) -> String {
        if bot.isDisabled == true { return "Disabled" }
        if let text = bot.statusText, !text.isEmpty {
            if let emoji = bot.statusEmoji, !emoji.isEmpty { return "\(emoji) \(text)" }
            return text
        }
        return bot.online ? "Online" : "Offline"
    }
}
