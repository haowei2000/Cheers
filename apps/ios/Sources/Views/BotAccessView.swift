import SwiftUI

/// Owner view of who may act for a bot: delegated approvers, event-access rules
/// and the bot's ACP event log. Native counterpart of the web permissions page;
/// posture and config options stay on BotDetailView.
struct BotAccessView: View {
    @Environment(AppModel.self) private var app

    let botId: String

    @State private var approvers: [ApproverDto] = []
    @State private var access: EventAccessDto?
    @State private var events: [AcpEventDto] = []
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var showAddRule = false
    @State private var pendingRevoke: ApproverDto?
    @State private var pendingRuleDelete: EventRuleDto?

    var body: some View {
        Form {
            if let errorText {
                Section { Text(errorText).foregroundStyle(Theme.danger) }
            }

            Section {
                if approvers.isEmpty {
                    Text(isLoading ? "Loading…" : "Only you can approve this bot's tool calls.")
                        .foregroundStyle(Theme.textSecondary)
                }
                ForEach(approvers) { approver in
                    VStack(alignment: .leading, spacing: Theme.space1) {
                        Text(approver.displayName ?? approver.username ?? approver.userId)
                        Text(approverScope(approver))
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .swipeActions {
                        if approver.channelId != nil {
                            Button("Revoke", role: .destructive) { pendingRevoke = approver }
                        }
                    }
                }
            } header: {
                Text("Approvers")
                    .helpExplanation("People you allowed to approve this bot's tool calls in a channel. Grant them from an approval request.")
            }

            if let access {
                Section {
                    if access.rules.isEmpty {
                        Text("No custom rules. Channel roles decide.")
                            .foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(access.rules) { rule in
                        VStack(alignment: .leading, spacing: Theme.space1) {
                            Text("\(rule.capability.capitalized) · \(rule.eventClass)")
                            Text(ruleScope(rule))
                                .font(.caption)
                                .foregroundStyle(rule.decision == "deny" ? Theme.danger : Theme.textSecondary)
                        }
                        .swipeActions {
                            Button("Delete", role: .destructive) { pendingRuleDelete = rule }
                        }
                    }
                    Button("Add rule", systemImage: "plus") { showAddRule = true }
                } header: {
                    Text("Event access")
                        .helpExplanation("Rules override what each channel role can start, see or answer for this bot.")
                }
            }

            Section("Recent events") {
                if events.isEmpty {
                    Text(isLoading ? "Loading…" : "No events yet")
                        .foregroundStyle(Theme.textSecondary)
                }
                ForEach(Array(events.prefix(50).enumerated()), id: \.offset) { _, event in
                    LabeledContent(
                        event.name,
                        value: TimeFormat.parse(event.createdAt)?
                            .formatted(date: .abbreviated, time: .shortened) ?? event.createdAt
                    )
                    .font(.caption.monospaced())
                }
            }
        }
        .navigationTitle("Approvers and event access")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showAddRule) {
            if let access {
                EventRuleEditor(botId: botId, access: access) { await load() }
            }
        }
        .confirmationDialog(
            "Revoke this approver?",
            isPresented: Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } }),
            titleVisibility: .visible,
            presenting: pendingRevoke
        ) { approver in
            Button("Revoke", role: .destructive) {
                Task { await act { try await $0.revokeApprover(botId: botId, approver: approver) } }
            }
        }
        .confirmationDialog(
            "Delete this rule?",
            isPresented: Binding(get: { pendingRuleDelete != nil }, set: { if !$0 { pendingRuleDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingRuleDelete
        ) { rule in
            Button("Delete", role: .destructive) {
                Task { await act { try await $0.deleteEventRule(botId: botId, rule: rule) } }
            }
        }
    }

    private func approverScope(_ approver: ApproverDto) -> String {
        let operation = approver.operationKind == "*" || approver.operationKind == nil
            ? String(localized: "All operations")
            : approver.operationKind ?? ""
        guard let channel = approver.channelName ?? approver.channelId else { return operation }
        return "#\(channel) · \(operation)"
    }

    private func ruleScope(_ rule: EventRuleDto) -> String {
        let scope = rule.channelId.isEmpty ? String(localized: "Bot-wide") : rule.channelId
        let expired = rule.expired == true ? " · " + String(localized: "Expired") : ""
        return "\(rule.decision.capitalized) · \(rule.subjectKind): \(rule.subjectId) · \(scope)\(expired)"
    }

    private func load() async {
        guard let api = app.api else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let approversTask = api.listApprovers(botId: botId)
            async let accessTask = api.eventAccess(botId: botId)
            async let eventsTask = api.acpEvents(botId: botId)
            approvers = try await approversTask
            access = try await accessTask
            events = try await eventsTask
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func act(_ work: (APIClient) async throws -> Void) async {
        guard let api = app.api else { return }
        do {
            try await work(api)
            await load()
        } catch {
            errorText = error.localizedDescription
        }
    }
}

/// Bot-wide rule for a channel role. Per-user and per-group overrides stay on the
/// web page, where the subject pickers have room.
private struct EventRuleEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let botId: String
    let access: EventAccessDto
    let onSaved: () async -> Void

    @State private var capability = "see"
    @State private var eventClass = ""
    @State private var role = "member"
    @State private var decision = "allow"
    @State private var isSaving = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorText {
                    Section { Text(errorText).foregroundStyle(Theme.danger) }
                }
                Section {
                    Picker("Capability", selection: $capability) {
                        Text("Do").tag("initiate")
                        Text("View").tag("see")
                        Text("Answer").tag("respond")
                    }
                    Picker("Event", selection: $eventClass) {
                        Text("Select…").tag("")
                        ForEach(access.events(for: capability), id: \.self) { Text($0).tag($0) }
                    }
                    Picker("Role", selection: $role) {
                        Text("Any role").tag("*")
                        Text("Owner").tag("owner")
                        Text("Admin").tag("admin")
                        Text("Member").tag("member")
                    }
                    Picker("Decision", selection: $decision) {
                        Text("Allow").tag("allow")
                        Text("Deny").tag("deny")
                    }
                }
            }
            .navigationTitle("Add rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(eventClass.isEmpty || isSaving)
                }
            }
            .onChange(of: capability) { eventClass = "" }
        }
    }

    private func save() async {
        guard let api = app.api else { return }
        isSaving = true
        errorText = nil
        defer { isSaving = false }
        do {
            try await api.upsertEventRule(botId: botId, rule: EventRuleInput(
                subjectKind: "role", subjectId: role,
                eventClass: eventClass, capability: capability, decision: decision
            ))
            await onSaved()
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
