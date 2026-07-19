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
    let channelId: String

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
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.3.group").foregroundStyle(Theme.accent)
                Text("ViewBoard")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 10)

            Picker("", selection: $board) {
                ForEach(Board.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.bottom, 10)

            Divider().overlay(Theme.border)

            Group {
                switch board {
                case .plan:     PlanBoardView(channelId: channelId, memberNames: memberNames, refreshTick: refreshTick)
                case .cost:     CostBoardView(channelId: channelId, memberNames: memberNames, refreshTick: refreshTick)
                case .sessions: SessionsBoardView(channelId: channelId, memberNames: memberNames)
                case .audit:    AuditBoardView(channelId: channelId, memberNames: memberNames)
                case .activity: ActivityBoardView(channelId: channelId, memberNames: memberNames)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
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
        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
    } else if let errorText {
        ComingSoon(icon: "exclamationmark.triangle", text: errorText)
    } else if isEmpty {
        ComingSoon(icon: emptyIcon, text: emptyText)
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
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(plans) { planCard($0) }
                    }
                    .padding(16)
                }
            } else {
                boardStatus(isLoading: state.isLoading, errorText: state.errorText,
                            isEmpty: true, emptyIcon: "checklist", emptyText: "No plan yet")
            }
        }
        .task(id: refreshTick) { await load() }
    }

    private func planCard(_ plan: PlanCard) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                AvatarView(seedId: plan.botId, name: memberNames[plan.botId] ?? "bot", size: 24, monochrome: true)
                Text(memberNames[plan.botId] ?? "bot")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(shortSession(plan.sessionId))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textMuted)
                Spacer()
                Text("\(plan.completed)/\(plan.total)")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
            }
            if plan.total > 0 {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.bgRaised)
                        Capsule().fill(Theme.online)
                            .frame(width: geo.size.width * CGFloat(plan.completed) / CGFloat(max(plan.total, 1)))
                    }
                }
                .frame(height: 4)
            }
            entrySection("In progress", plan.entries.filter { $0.status == "in_progress" }, icon: "circle.dotted", color: Theme.warning)
            entrySection("Pending", plan.entries.filter { $0.status != "in_progress" && $0.status != "completed" }, icon: "circle", color: Theme.textMuted)
            entrySection("Completed", plan.entries.filter { $0.status == "completed" }, icon: "checkmark.circle.fill", color: Theme.online, struck: true)
        }
        .padding(12)
        .background(Theme.bgRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private func entrySection(_ title: String, _ entries: [PlanEntry], icon: String, color: Color, struck: Bool = false) -> some View {
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(title) · \(entries.count)")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
                ForEach(entries) { entry in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: icon)
                            .font(.system(size: 11))
                            .foregroundStyle(color)
                            .padding(.top, 2)
                        Text(entry.content)
                            .font(.system(size: 13))
                            .foregroundStyle(struck ? Theme.textMuted : Theme.textPrimary)
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
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(rows) { usageRow($0) }
                    }
                    .padding(.vertical, 6)
                }
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
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(shortSession(row.sessionId))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textMuted)
                Spacer()
                Text(fmtUSD(row.costUsd))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
            }
            HStack(spacing: 14) {
                metric("In", fmtInt(row.inputTokens))
                metric("Out", fmtInt(row.outputTokens))
                metric("Total", fmtInt(row.totalTokens))
                metric("Context", fmtInt(row.contextWindow))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.border).padding(.leading, 16) }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 10)).foregroundStyle(Theme.textMuted)
            Text(value).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.textSecondary)
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
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        Text("\(sessions.count) sessions")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                        ForEach(sessions) { sessionRow($0) }
                    }
                }
            } else {
                boardStatus(isLoading: state.isLoading, errorText: state.errorText,
                            isEmpty: true, emptyIcon: "terminal", emptyText: "No active sessions")
            }
        }
        .task { await load() }
    }

    private func sessionRow(_ session: SessionBoardRow) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(session.status == "active" ? Theme.online : Theme.textFaint)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(session.botName ?? memberNames[session.botId] ?? "bot")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                    if session.isPrimary {
                        Text("PRIMARY")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Theme.accent)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 3))
                    }
                    Text(shortSession(session.sessionId))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.textMuted)
                }
                if let cwd = session.workspace?.cwd, !cwd.isEmpty {
                    Text(cwd)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.border).padding(.leading, 34) }
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
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(events) { activityRow($0) }
                    }
                    .padding(.vertical, 4)
                }
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
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: event.eventType == "message" ? "bubble.left" : "gearshape.2")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 22)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(headline(event))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(expanded ? nil : 2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        Text(actorName(event))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.textSecondary)
                        if let ts = event.createdAt {
                            Text(TimeFormat.listStamp(TimeFormat.parse(ts)))
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textMuted)
                        }
                    }
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.border).padding(.leading, 48) }
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

    @State private var events: [AuditEvent] = []
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var detailEvent: AuditEvent?

    var body: some View {
        Group {
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
            detailEvent = event
        } label: {
            HStack(spacing: 11) {
                Rectangle()
                    .fill(auditTone(event.outcome))
                    .frame(width: 3)
                    .clipShape(Capsule())
                VStack(alignment: .leading, spacing: 3) {
                    // WHAT: the concrete command or path, never the generic title.
                    Text(event.subject ?? event.outcomeLabel)
                        .font(.system(size: 14, weight: .medium, design: event.subject == nil ? .default : .monospaced))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        // WHO asked.
                        if let bot = event.botId {
                            Text(memberNames[bot] ?? "bot")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Theme.textSecondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Theme.bgRaised, in: Capsule())
                        }
                        // RESULT.
                        Text(event.outcomeLabel)
                            .font(.system(size: 12))
                            .foregroundStyle(auditTone(event.outcome))
                    }
                }
                Spacer(minLength: 8)
                if let ts = event.createdAt {
                    Text(TimeFormat.listStamp(TimeFormat.parse(ts)))
                        .font(.system(size: 11)).foregroundStyle(Theme.textSecondary)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textFaint)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
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
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("Approval detail")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                Text(event.outcomeLabel)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(auditTone(event.outcome))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(auditTone(event.outcome).opacity(0.12), in: Capsule())
            }
            .padding(16)
            Divider().overlay(Theme.border)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let subject = event.subject {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Request")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Theme.textMuted)
                            Text(subject)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(Theme.textPrimary)
                                .textSelection(.enabled)
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.bgRaised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .padding(16)
                    }
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
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    Text(label)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 108, alignment: .leading)
                    Text(value)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                Divider().overlay(Theme.border).padding(.leading, 16)
            }
        }
    }
}
