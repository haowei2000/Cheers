import SwiftUI

/// The user's scheduled channel messages: one Add entry, edit by opening a row,
/// confirmation before Delete. Same behavior as the web ScheduledMessagesManager.
struct ScheduledMessagesView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var tasks: [ScheduledMessageDto] = []
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var editing: EditorTarget?
    @State private var pendingDelete: ScheduledMessageDto?

    private enum EditorTarget: Identifiable {
        case new
        case existing(ScheduledMessageDto)

        var id: String {
            switch self {
            case .new: return "new"
            case .existing(let task): return task.id
            }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorText {
                    Text(errorText).foregroundStyle(Theme.danger)
                }
                if isLoading && tasks.isEmpty {
                    ProgressView().frame(maxWidth: .infinity)
                } else if tasks.isEmpty {
                    ContentUnavailableView(
                        "No scheduled tasks",
                        systemImage: "calendar.badge.clock",
                        description: Text("Send a message to a channel or an agent on a schedule.")
                    )
                }
                ForEach(tasks) { task in
                    Button { editing = .existing(task) } label: { row(task) }
                        .swipeActions(edge: .trailing) {
                            CheersConfirmationButton(title: String(localized: "Delete"), role: .destructive) { pendingDelete = task }
                        }
                        .swipeActions(edge: .leading) {
                            CheersConfirmationButton(title: String(localized: "Run now")) { Task { await act { try await $0.runScheduledMessageNow(id: task.id) } } }
                                .tint(Theme.accent)
                            CheersConfirmationButton(title: task.enabled ? String(localized: "Pause") : String(localized: "Resume")) {
                                Task {
                                    await act {
                                        _ = try await $0.updateScheduledMessage(
                                            id: task.id,
                                            task.input(enabled: !task.enabled)
                                        )
                                    }
                                }
                            }
                        }
                }
            }
            .navigationTitle("Scheduled tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CheersContentActionButton(action: .done) { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    CheersContentActionButton(action: .add) { editing = .new }
                }
            }
            .task { await load() }
            .refreshable { await load() }
            .sheet(item: $editing) { target in
                ScheduledMessageEditor(task: {
                    if case .existing(let task) = target { return task }
                    return nil
                }()) {
                    await load()
                }
            }
            .confirmationDialog(
                "Delete this scheduled task?",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { task in
                CheersConfirmationButton(title: String(localized: "Delete"), role: .destructive) {
                    Task { await act { try await $0.deleteScheduledMessage(id: task.id) } }
                }
            }
        }
    }

    private func row(_ task: ScheduledMessageDto) -> some View {
        VStack(alignment: .leading, spacing: Theme.space1) {
            Text(task.title)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            // A DM has no channel name.
            Text(task.channelName.isEmpty ? task.statusLabel : "#\(task.channelName) · \(task.statusLabel)")
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
            if let lastError = task.lastError {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .lineLimit(2)
            }
        }
    }

    private func load() async {
        guard let api = app.api else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            tasks = try await api.listScheduledMessages()
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

private struct ScheduledMessageEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let task: ScheduledMessageDto?
    let onSaved: () async -> Void

    @State private var title = ""
    @State private var channelId = ""
    @State private var botId = ""
    @State private var content = ""
    @State private var kind = "daily"
    @State private var runAt = Date().addingTimeInterval(3600)
    @State private var everyMinutes = 1440
    @State private var dailyTime = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var enabled = true

    @State private var channels: [ChannelDto] = []
    @State private var bots: [ChannelMemberDto] = []
    @State private var runs: [ScheduledMessageRunDto] = []
    @State private var isSaving = false
    @State private var errorText: String?

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !channelId.isEmpty
            && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorText {
                    Section { Text(errorText).foregroundStyle(Theme.danger) }
                }
                Section {
                    TextField("Title", text: $title)
                    Picker("Channel", selection: $channelId) {
                        Text("Select…").tag("")
                        ForEach(channels) { Text($0.displayName).tag($0.channelId) }
                    }
                    if !bots.isEmpty {
                        Picker("Agent", selection: $botId) {
                            Text("None").tag("")
                            ForEach(bots) { Text($0.displayName ?? $0.username ?? "Bot").tag($0.memberId) }
                        }
                    }
                    TextField("Message", text: $content, axis: .vertical)
                        .lineLimit(3...8)
                }
                Section("Schedule") {
                    Picker("Repeat", selection: $kind) {
                        Text("Once").tag("once")
                        Text("Interval").tag("interval")
                        Text("Daily").tag("daily")
                    }
                    switch kind {
                    case "once":
                        DatePicker("Time", selection: $runAt, in: Date()...)
                    case "interval":
                        Stepper("Every \(everyMinutes) min", value: $everyMinutes, in: 5...10_080, step: 5)
                    default:
                        DatePicker("Time", selection: $dailyTime, displayedComponents: .hourAndMinute)
                    }
                    Toggle("Enabled", isOn: $enabled)
                }
                if !runs.isEmpty {
                    Section("Recent runs") {
                        ForEach(runs.prefix(10)) { run in
                            LabeledContent(
                                TimeFormat.parse(run.scheduledFor)?
                                    .formatted(date: .abbreviated, time: .shortened) ?? run.scheduledFor,
                                value: run.error ?? run.status.capitalized
                            )
                        }
                    }
                }
            }
            .navigationTitle(task == nil ? "New task" : "Edit task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CheersContentActionButton(action: .cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    CheersContentActionButton(action: .save) { Task { await save() } }.disabled(!canSave)
                }
            }
            .task { await prepare() }
            .onChange(of: channelId) { old, new in
                if !old.isEmpty { botId = "" }
                Task { await loadBots(channelId: new) }
            }
        }
    }

    private func prepare() async {
        guard let api = app.api else { return }
        if let task, title.isEmpty {
            title = task.title
            channelId = task.channelId
            botId = task.mentionIds.first ?? ""
            content = task.content
            kind = task.schedule.kind
            enabled = task.enabled
            if let date = task.schedule.runAt.flatMap(TimeFormat.parse) { runAt = date }
            everyMinutes = task.schedule.everyMinutes ?? everyMinutes
            if let parts = task.schedule.localTime?.split(separator: ":"), parts.count == 2,
               let hour = Int(parts[0]), let minute = Int(parts[1]),
               let date = Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) {
                dailyTime = date
            }
            runs = (try? await api.listScheduledMessageRuns(id: task.id)) ?? []
        }
        do {
            async let dms = api.listDMs()
            async let named = api.listChannels(workspaceId: nil)
            channels = try await named + dms
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func loadBots(channelId: String) async {
        guard !channelId.isEmpty, let api = app.api else {
            bots = []
            return
        }
        let members = (try? await api.listMembers(channelId: channelId)) ?? []
        bots = members.filter { $0.memberType == "bot" }
    }

    private var schedule: ScheduledSchedule {
        switch kind {
        case "once":
            return ScheduledSchedule(kind: "once", runAt: TimeFormat.iso.string(from: runAt))
        case "interval":
            return ScheduledSchedule(
                kind: "interval",
                everyMinutes: everyMinutes,
                startAt: enabled
                    ? TimeFormat.iso.string(from: Date().addingTimeInterval(Double(everyMinutes) * 60))
                    : nil
            )
        default:
            let parts = Calendar.current.dateComponents([.hour, .minute], from: dailyTime)
            return ScheduledSchedule(
                kind: "daily",
                localTime: String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0),
                timezone: task?.schedule.timezone ?? TimeZone.current.identifier
            )
        }
    }

    private func save() async {
        guard let api = app.api, canSave else { return }
        isSaving = true
        errorText = nil
        defer { isSaving = false }
        let input = ScheduledMessageInput(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            channelId: channelId,
            content: content,
            mentionIds: botId.isEmpty ? [] : [botId],
            schedule: schedule,
            enabled: enabled,
            sourceExtensionId: task?.sourceExtensionId,
            sourceAutomationId: task?.sourceAutomationId
        )
        do {
            if let task {
                _ = try await api.updateScheduledMessage(id: task.id, input)
            } else {
                _ = try await api.createScheduledMessage(input)
            }
            await onSaved()
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
