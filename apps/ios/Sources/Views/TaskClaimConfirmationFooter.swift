import SwiftUI

/// Small action footer attached to a normal bot reply, matching the web card.
struct TaskClaimConfirmationFooter: View {
    @Environment(AppModel.self) private var app
    let message: MessageDto
    let channelId: String
    @State private var busy = false
    @State private var resolved: Bool

    init(message: MessageDto, channelId: String) {
        self.message = message
        self.channelId = channelId
        _resolved = State(initialValue: message.contentData?["resolved"]?.boolValue == true)
    }

    var body: some View {
        if resolved {
            Label("Claim response recorded", systemImage: "checkmark.circle.fill")
                .font(.caption.weight(.medium))
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(.thinMaterial, in: Capsule())
        } else if actionable {
            TaskClaimActionButtons(busy: busy, onDecision: resolve)
        }
    }

    private var claimId: String? { message.contentData?["claim_id"]?.stringValue }
    private var actionable: Bool {
        guard let requester = message.contentData?["requester_id"]?.stringValue else { return false }
        return requester == app.session?.userId && claimId != nil
    }

    private func resolve(_ decision: String) {
        guard let api = app.api, let claimId, !busy else { return }
        NativeFeedback.selection()
        busy = true
        Task {
            defer { busy = false }
            do {
                try await api.resolveTaskClaim(channelId: channelId, claimId: claimId, decision: decision)
                resolved = true
            } catch {
                // Message-level feedback stays compact; a retry remains available.
            }
        }
    }
}

struct TaskClaimActionButtons: View {
    let busy: Bool
    let onDecision: (String) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button { onDecision("reject") } label: {
                Label("Decline", systemImage: "xmark")
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(Theme.textSecondary)

            Button { onDecision("accept") } label: {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Accept claim", systemImage: "checkmark")
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(Theme.accent)
        }
        .controlSize(.small)
        .font(.subheadline.weight(.semibold))
        .disabled(busy)
    }
}

/// Channel-level queue. Unlike the timeline footer this remains reachable when
/// the confirmation message is outside the loaded message window.
struct TaskClaimsPanelView: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: ChatModel

    var body: some View {
        if !model.pendingTaskClaims.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("TASK CLAIM REQUESTS · \(model.pendingTaskClaims.count)")
                    .font(.caption2.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(Theme.accent)
                ForEach(model.pendingTaskClaims) { claim in
                    claimRow(claim)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Theme.bgApp)
        }
    }

    private func claimRow(_ claim: TaskClaimDto) -> some View {
        CheersOperationsItem(row: CheersItemRow(
            title: claim.summary,
            subtitle: "\(claim.botName) wants to claim a task",
            metadata: "\(Int((claim.confidence * 100).rounded()))% · \(claim.impact)",
            preview: claim.proposedAction,
            explicitLevel: .max,
            leading: AnyView(Image(systemName: "sparkles").foregroundStyle(Theme.accent)),
            criticalStatus: AnyView(Text("APPROVAL").font(.caption2.bold()).foregroundStyle(Theme.warning)),
            actions: claim.requesterId == app.session?.userId ? AnyView(TaskClaimActionButtons(
                    busy: model.taskClaimBusyId == claim.claimId,
                    onDecision: { decision in Task { await model.resolveTaskClaim(claim, decision: decision) } }
                )) : model.canManageTaskClaims ? AnyView(Button(role: .destructive) {
                    Task { await model.cancelTaskClaim(claim) }
                } label: {
                    Label("Cancel claim", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.taskClaimBusyId != nil)) : AnyView(Text("Waiting").font(.caption2).foregroundStyle(Theme.textMuted))
        ))
    }
}

/// Admin/owner settings for proactive monitoring, plus a durable view of the
/// pending queue. Server authorization remains the source of truth.
struct TaskClaimManagementSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: ChatModel

    @State private var selectedBotId = ""
    @State private var monitoring: BotMonitoringDto?
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                if !model.pendingTaskClaims.isEmpty {
                    Section("Pending requests") {
                        ForEach(model.pendingTaskClaims) { claim in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(claim.summary).fontWeight(.semibold)
                                Text("\(claim.botName) · \(Int(claim.confidence * 100))% · \(claim.impact)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section {
                    Picker("Bot", selection: $selectedBotId) {
                        ForEach(model.botMembers) { bot in
                            Text(bot.name).tag(bot.memberId)
                        }
                    }
                    if let monitoring {
                        Picker("Listen to", selection: binding(\.mode)) {
                            Text("Off").tag("off")
                            Text("Text messages").tag("text")
                            Text("Text + voice transcript").tag("text_and_transcript")
                            Text("All activity").tag("all_activity")
                        }
                        TextField("Responsibility scope", text: binding(\.scope), axis: .vertical)
                            .lineLimit(2...5)
                        Stepper("Debounce: \(monitoring.debounceSeconds)s", value: binding(\.debounceSeconds), in: 1...3600)
                        Stepper("Minimum interval: \(monitoring.minIntervalSeconds)s", value: binding(\.minIntervalSeconds), in: 1...86400)
                        Stepper("Checks per hour: \(monitoring.maxEvaluationsPerHour)", value: binding(\.maxEvaluationsPerHour), in: 1...1000)
                    } else if isLoading {
                        ProgressView()
                    }
                } header: {
                    Text("Proactive task claiming")
                } footer: {
                    Text("The bot may inspect channel activity and propose work. A human confirmation is always required before execution.")
                }
                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Task claims")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                if model.canManageTaskClaims, monitoring != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                            .disabled(isSaving)
                    }
                }
            }
            .task {
                await model.refreshTaskClaims()
                if selectedBotId.isEmpty { selectedBotId = model.botMembers.first?.memberId ?? "" }
                await load()
            }
            .onChange(of: selectedBotId) { Task { await load() } }
        }
    }

    private func binding<T>(_ keyPath: WritableKeyPath<BotMonitoringDto, T>) -> Binding<T> {
        Binding(
            get: { monitoring![keyPath: keyPath] },
            set: { monitoring?[keyPath: keyPath] = $0 }
        )
    }

    private func load() async {
        guard !selectedBotId.isEmpty, let api = app.api else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            monitoring = try await api.botMonitoring(channelId: model.channel.channelId, botId: selectedBotId)
            errorText = nil
        } catch {
            monitoring = nil
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func save() async {
        guard model.canManageTaskClaims, let api = app.api, let monitoring else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            self.monitoring = try await api.updateBotMonitoring(
                channelId: model.channel.channelId,
                botId: selectedBotId,
                update: BotMonitoringUpdate(
                    mode: monitoring.mode, scope: monitoring.scope,
                    debounceSeconds: monitoring.debounceSeconds,
                    minIntervalSeconds: monitoring.minIntervalSeconds,
                    maxEvaluationsPerHour: monitoring.maxEvaluationsPerHour,
                    batchSize: monitoring.batchSize,
                    confidenceThreshold: monitoring.confidenceThreshold,
                    policy: monitoring.policy ?? .object([:])
                )
            )
            errorText = nil
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
