import SwiftUI

/// ViewBoard — the channel's instrument plane, five boards behind segmented tabs.
/// Audit is REST; Plan/Cost/Sessions/Activity are WS resource reads
/// (`ChatSocket.request`). A `board_signal` frame is a data-free tick: the
/// matching board re-pulls through its own authz'd read, coalesced to one
/// refetch per 500 ms like the web client.
///
/// Everything a board shows is agent-authored and untrusted — render as inert
/// `Text` only, never markdown.
struct ViewBoardSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channelId: String
    /// Jump the chat to a message (and optional approval request) then dismiss.
    var onJumpToMessage: ((String, String?) -> Void)? = nil

    private enum Board: String, CaseIterable {
        case plan = "Plan", cost = "Cost", sessions = "Sessions", audit = "Audit", activity = "Activity"
    }
    @State private var board: Board = .plan
    /// member id → display name shared by all boards.
    @State private var memberNames: [String: String] = [:]
    @State private var refreshTick = 0
    @State private var listenerId: UUID?
    @State private var pendingSignal: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            Group {
                switch board {
                case .plan:     PlanBoardView(channelId: channelId, memberNames: memberNames, refreshTick: refreshTick)
                case .cost:     CostBoardView(channelId: channelId, memberNames: memberNames, refreshTick: refreshTick)
                case .sessions: SessionsBoardView(channelId: channelId, memberNames: memberNames)
                case .audit:    AuditBoardView(channelId: channelId, memberNames: memberNames, onJumpToMessage: onJumpToMessage)
                case .activity: ActivityBoardView(channelId: channelId, memberNames: memberNames)
                }
            }
            .navigationTitle(board.rawValue)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Picker("Board", selection: $board) {
                            ForEach(Board.allCases, id: \.self) { value in
                                Label(value.rawValue, systemImage: icon(for: value)).tag(value)
                            }
                        }
                    } label: {
                        Label("Choose board", systemImage: icon(for: board))
                    }
                }
            }
        }
        .task {
            if let api = app.api, memberNames.isEmpty {
                let members = (try? await api.listMembers(channelId: channelId)) ?? []
                memberNames = Dictionary(members.map { ($0.memberId, $0.name) },
                                         uniquingKeysWith: { first, _ in first })
            }
            listenerId = app.addSocketListener { event in
                if case .boardSignal(let cid, _) = event, cid == channelId {
                    scheduleRefresh()
                }
            }
        }
        .onDisappear {
            if let listenerId { app.removeSocketListener(listenerId) }
            pendingSignal?.cancel()
        }
    }

    private func icon(for board: Board) -> String {
        switch board {
        case .plan: "checklist"
        case .cost: "dollarsign.circle"
        case .sessions: "rectangle.stack.person.crop"
        case .audit: "checkmark.shield"
        case .activity: "waveform.path.ecg"
        }
    }

    /// Coalesce bursts of board_signal ticks into one refetch per 500 ms.
    private func scheduleRefresh() {
        guard pendingSignal == nil else { return }
        pendingSignal = Task {
            try? await Task.sleep(for: .milliseconds(500))
            pendingSignal = nil
            guard !Task.isCancelled else { return }
            refreshTick += 1
        }
    }
}

// MARK: - Shared board scaffolding

private struct BoardState<T> {
    var value: T?
    var errorText: String?
    var isLoading = true
}

@ViewBuilder
private func boardStatus(isLoading: Bool, errorText: String?, isEmpty: Bool, emptyIcon: String, emptyText: String) -> some View {
    if isLoading {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if let errorText {
        ContentUnavailableView("Couldn’t load board", systemImage: "exclamationmark.triangle", description: Text(errorText))
    } else if isEmpty {
        ContentUnavailableView(emptyText, systemImage: emptyIcon)
    }
}

private func shortSession(_ id: String?) -> String {
    guard let id, !id.isEmpty else { return "—" }
    return String(id.prefix(8))
}

private func fmtInt(_ value: Int64?) -> String {
    guard let value else { return "—" }
    return value.formatted(.number.grouping(.automatic))
}

private func fmtUSD(_ value: Double?) -> String {
    guard let value else { return "—" }
    return value.formatted(.currency(code: "USD").precision(.fractionLength(2...4)))
}

// MARK: - Plan

private struct PlanBoardView: View {
    @Environment(AppModel.self) private var app
    let channelId: String
    let memberNames: [String: String]
    var refreshTick: Int

    @State private var state = BoardState<[PlanCard]>()

    var body: some View {
        Group {
            if let plans = state.value, !plans.isEmpty {
                List(plans) { plan in
                    planCard(plan)
                }
                .listStyle(.insetGrouped)
            } else {
                boardStatus(isLoading: state.isLoading, errorText: state.errorText,
                            isEmpty: true, emptyIcon: "checklist", emptyText: "No plan yet")
            }
        }
        .task(id: refreshTick) { await load() }
    }

    private func planCard(_ plan: PlanCard) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            CheersWorkbenchItem(row: CheersItemRow(
                title: memberNames[plan.botId] ?? "bot",
                subtitle: shortSession(plan.sessionId),
                leading: AnyView(AvatarView(seedId: plan.botId, name: memberNames[plan.botId] ?? "bot", size: 24, monochrome: true)),
                status: AnyView(Text("PLAN").font(.caption2.bold()).foregroundStyle(Theme.accent)),
                trailing: AnyView(Text("\(plan.completed)/\(plan.total)").font(.caption.weight(.medium)).foregroundStyle(.secondary))
            ))
            if plan.total > 0 {
                ProgressView(value: Double(plan.completed), total: Double(plan.total))
            }
            entrySection("In progress", plan.entries.filter { $0.status == "in_progress" }, icon: "circle.dotted", color: .orange)
            entrySection("Pending", plan.entries.filter { $0.status != "in_progress" && $0.status != "completed" }, icon: "circle", color: .secondary)
            entrySection("Completed", plan.entries.filter { $0.status == "completed" }, icon: "checkmark.circle.fill", color: .green, struck: true)
        }
    }

    @ViewBuilder
    private func entrySection(_ title: String, _ entries: [PlanEntry], icon: String, color: Color, struck: Bool = false) -> some View {
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(title) · \(entries.count)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(entries) { entry in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: icon)
                            .font(.caption)
                            .foregroundStyle(color)
                            .padding(.top, 2)
                        Text(entry.content)
                            .font(.subheadline)
                            .foregroundStyle(struck ? Color.secondary : Color.primary)
                            .strikethrough(struck)
                    }
                }
            }
        }
    }

    private func load() async {
        do {
            let raw = try await app.socket.request(resource: "channel.plan.read", params: ["channel_id": channelId])
            state.value = try raw.decode(as: PlanBoardResponse.self).plans
            state.errorText = nil
        } catch {
            state.errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
        state.isLoading = false
    }
}

// MARK: - Cost

private struct CostBoardView: View {
    @Environment(AppModel.self) private var app
    let channelId: String
    let memberNames: [String: String]
    var refreshTick: Int

    @State private var state = BoardState<[UsageRow]>()

    var body: some View {
        Group {
            if let rows = state.value, !rows.isEmpty {
                List(rows) { row in
                    usageRow(row)
                }
                .listStyle(.insetGrouped)
            } else {
                boardStatus(isLoading: state.isLoading, errorText: state.errorText,
                            isEmpty: true, emptyIcon: "dollarsign.circle", emptyText: "No usage reported yet")
            }
        }
        .task(id: refreshTick) { await load() }
    }

    private func usageRow(_ row: UsageRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                AvatarView(seedId: row.botId, name: memberNames[row.botId] ?? "bot", size: 24, monochrome: true)
                Text(memberNames[row.botId] ?? "bot")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(shortSession(row.sessionId))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Text(fmtUSD(row.costUsd))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
            }
            HStack(spacing: 14) {
                metric("In", fmtInt(row.inputTokens))
                metric("Out", fmtInt(row.outputTokens))
                metric("Total", fmtInt(row.totalTokens))
                metric("Context", fmtInt(row.contextWindow))
            }
        }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.caption.monospaced()).foregroundStyle(.secondary)
        }
    }

    private func load() async {
        do {
            let raw = try await app.socket.request(resource: "channel.usage.read", params: ["channel_id": channelId])
            state.value = try raw.decode(as: UsageBoardResponse.self).bots
            state.errorText = nil
        } catch {
            state.errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
        state.isLoading = false
    }
}

// MARK: - Sessions

private struct SessionsBoardView: View {
    @Environment(AppModel.self) private var app
    let channelId: String
    let memberNames: [String: String]

    @State private var state = BoardState<[SessionBoardRow]>()

    var body: some View {
        Group {
            if let sessions = state.value, !sessions.isEmpty {
                List {
                    Section("\(sessions.count) sessions") {
                        ForEach(sessions) { sessionRow($0) }
                    }
                }
                .listStyle(.insetGrouped)
            } else {
                boardStatus(isLoading: state.isLoading, errorText: state.errorText,
                            isEmpty: true, emptyIcon: "terminal", emptyText: "No active sessions")
            }
        }
        .task { await load() }
    }

    private func sessionRow(_ session: SessionBoardRow) -> some View {
        CheersWorkbenchItem(row: CheersItemRow(
            title: session.botName ?? memberNames[session.botId] ?? "bot",
            subtitle: session.workspace?.cwd,
            metadata: shortSession(session.sessionId),
            explicitLevel: .max,
            leading: AnyView(Circle().fill(session.status == "active" ? Color.green : Color.secondary).frame(width: 8, height: 8)),
            criticalStatus: session.isPrimary ? AnyView(Text("PRIMARY").font(.caption2.bold()).foregroundStyle(Theme.accent)) : nil,
            status: AnyView(Text(session.status.uppercased()).font(.caption2.bold()).foregroundStyle(session.status == "active" ? Theme.online : Theme.textMuted))
        ))
    }

    private func load() async {
        do {
            let raw = try await app.socket.request(resource: "channel.sessions.read", params: ["channel_id": channelId])
            state.value = try raw.decode(as: SessionsBoardResponse.self).sessions
            state.errorText = nil
        } catch {
            state.errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
        state.isLoading = false
    }
}

// MARK: - Activity

private struct ActivityBoardView: View {
    @Environment(AppModel.self) private var app
    let channelId: String
    let memberNames: [String: String]

    @State private var state = BoardState<[ActivityBoardEvent]>()
    @State private var expandedSeq: Int64?

    var body: some View {
        Group {
            if let events = state.value, !events.isEmpty {
                List(events) { event in
                    activityRow(event)
                }
                .listStyle(.insetGrouped)
            } else {
                boardStatus(isLoading: state.isLoading, errorText: state.errorText,
                            isEmpty: true, emptyIcon: "waveform.path.ecg", emptyText: "No activity yet")
            }
        }
        .task { await load() }
    }

    private func activityRow(_ event: ActivityBoardEvent) -> some View {
        let expanded = expandedSeq == event.channelSeq
        return Button {
            withAnimation(.easeOut(duration: 0.2)) {
                expandedSeq = expanded ? nil : event.channelSeq
            }
        } label: {
            CheersWorkbenchItem(row: CheersItemRow(
                title: headline(event),
                subtitle: actorName(event),
                explicitLevel: expanded ? .max : .medium,
                leading: AnyView(Image(systemName: event.eventType == "message" ? "bubble.left" : "gearshape.2").foregroundStyle(.secondary)),
                trailing: event.createdAt.map { AnyView(Text(TimeFormat.listStamp(TimeFormat.parse($0))).font(.caption).foregroundStyle(.secondary)) }
            ))
        }
        .buttonStyle(.plain)
    }

    private func headline(_ event: ActivityBoardEvent) -> String {
        if event.eventType == "message" {
            let content = event.data?["content"]?.stringValue ?? ""
            return content.isEmpty ? "(empty message)" : content
        }
        let op = event.data?["op_type"]?.stringValue ?? "operation"
        return op.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func actorName(_ event: ActivityBoardEvent) -> String {
        let id = event.data?.firstString("sender_id", "actor_id") ?? ""
        return memberNames[id] ?? (event.eventType == "message" ? "member" : "system")
    }

    private func load() async {
        do {
            let raw = try await app.socket.request(
                resource: "channel.activity.read",
                params: ["channel_id": channelId, "limit": 200, "desc": true]
            )
            state.value = try raw.decode(as: ActivityBoardResponse.self).events
            state.errorText = nil
        } catch {
            state.errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
        state.isLoading = false
    }
}

// MARK: - Audit (REST — unchanged behavior, relocated from ChatView)

private struct AuditBoardView: View {
    @Environment(AppModel.self) private var app
    let channelId: String
    let memberNames: [String: String]
    var onJumpToMessage: ((String, String?) -> Void)? = nil

    @State private var events: [AuditEvent] = []
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var detailEvent: AuditEvent?

    var body: some View {
        Group {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
            } else if let errorText {
                ContentUnavailableView("Couldn’t load approvals", systemImage: "exclamationmark.triangle", description: Text(errorText))
            } else if events.isEmpty {
                ContentUnavailableView("No approvals recorded", systemImage: "checkmark.seal")
            } else {
                List(events) { event in
                    auditRow(event)
                }
                .listStyle(.insetGrouped)
            }
        }
        .task { await load() }
        .sheet(item: $detailEvent) { event in
            AuditDetailSheet(event: event, memberNames: memberNames)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// Row surfaces exactly three things — WHAT was approved, WHO asked, and the
    /// RESULT. Everything else (option id, request id, cwd, paths, actor) lives in
    /// the details sheet: a list of "Resolved / allow_always" rows carries no
    /// information, since every row says that.
    private func auditRow(_ event: AuditEvent) -> some View {
        Button {
            if let msgId = event.msgId, let onJumpToMessage {
                onJumpToMessage(msgId, event.requestId)
            } else {
                detailEvent = event
            }
        } label: {
            CheersWorkbenchItem(row: CheersItemRow(
                title: event.subject ?? event.outcomeLabel,
                subtitle: event.botId.map { memberNames[$0] ?? "bot" },
                leading: AnyView(Rectangle().fill(auditTone(event.outcome)).frame(width: 3, height: 28)),
                criticalStatus: AnyView(Text(event.outcomeLabel.uppercased()).font(.caption2.bold()).foregroundStyle(auditTone(event.outcome))),
                trailing: event.createdAt.map { timestamp in AnyView(HStack(spacing: 5) {
                    Text(TimeFormat.listStamp(TimeFormat.parse(timestamp))).font(.caption).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }) }
            ))
        }
        .buttonStyle(.plain)
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

private func auditTone(_ outcome: AuditOutcome) -> Color {
    switch outcome {
    case .approved: return Theme.online
    case .denied:   return Theme.danger
    case .pending:  return Theme.warning
    case .timedOut: return Theme.textMuted
    }
}

// MARK: - Audit detail

/// Everything the audit row deliberately leaves out. Agent-authored strings are
/// rendered as inert `Text` — never markdown — since they are untrusted input.
private struct AuditDetailSheet: View {
    let event: AuditEvent
    let memberNames: [String: String]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Result", value: event.outcomeLabel)
                        .foregroundStyle(auditTone(event.outcome))
                }
                if let subject = event.subject {
                    Section("Request") {
                        Text(subject)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                    }
                }
                Section("Details") {
                    row("Requested by", memberNames[event.botId ?? ""] ?? event.botId)
                    row("Decided by", memberNames[event.actorId ?? ""] ?? event.actorId)
                    row("Decision", event.decision)
                    row("Option", event.optionId)
                    row("Tool kind", event.toolKind)
                    row("Working dir", event.cwd)
                    row("Event", event.eventType)
                    row("Time", event.createdAt.map { TimeFormat.listStamp(TimeFormat.parse($0)) })
                    row("Request id", event.requestId)
                }
            }
            .navigationTitle("Approval detail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent {
                Text(value)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.trailing)
            } label: {
                Text(label)
            }
        }
    }
}
