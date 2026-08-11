import SwiftUI
import UIKit

/// One persistent activity control owned by a bot message.
///
/// Tap 1 opens the complete step list. Tap 2 opens a step's detail. The main
/// conversation never expands a long timeline inline, so message reading stays
/// primary and the target does not move when a run completes.
struct BotTracePanelView: View {
    let channelId: String
    let msgId: String
    var liveEvents: [TraceEventDto] = []
    var isRunning = false
    /// When set, auto-open the steps sheet (ViewBoard Approval deep-link).
    var focusRequestId: String? = nil
    var contextBundle: ResourceContextBundle? = nil
    var reportedTraceCount: Int? = nil
    var reportedFailure = false

    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var showingSheet = false
    @State private var durableEvents: [TraceEventDto]?
    @State private var loading = false
    @State private var errorText: String?

    private var displayedEvents: [TraceEventDto] {
        TraceEventContract.coalesce(durableEvents ?? [], liveEvents)
    }

    var body: some View {
        // After the authoritative read proves a completed turn had no trace,
        // remove the speculative lazy-load control.
        if durableEvents?.isEmpty == true,
           !isRunning,
           (reportedTraceCount ?? 0) == 0,
           contextBundle?.items.isEmpty != false
        {
            EmptyView()
        } else {
            Button {
                showingSheet = true
            } label: {
                HStack(spacing: 4) {
                    statusIcon
                        .frame(width: 14)
                    Text(folioLabel)
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .tracking(0.8)
                }
                .foregroundStyle(recordTone)
                .frame(width: Theme.hitMin, height: Theme.hitMin)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(recordAccessibilityLabel)
            .accessibilityHint("Shows this message's references and agent record")
            .sheet(isPresented: $showingSheet) {
                TraceActivitySheet(
                    events: displayedEvents,
                    isRunning: isRunning,
                    loading: loading,
                    errorText: errorText,
                    contextBundle: contextBundle,
                    retry: { Task { await loadDurableTrace() } }
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .task { await loadDurableTrace() }
            }
            .onChange(of: liveEvents) { _, latest in
                // A terminal socket delta can be less descriptive than the
                // opening row returned by REST. Merge both sources through the
                // same lifecycle fold instead of replacing the durable rows.
                if isRunning {
                    durableEvents = TraceEventContract.coalesce(durableEvents ?? [], latest)
                }
            }
            .onChange(of: focusRequestId) { _, requestId in
                if requestId != nil { showingSheet = true }
            }
            .onAppear {
                if focusRequestId != nil { showingSheet = true }
            }
        }
    }

    private var recordCount: Int {
        max(reportedTraceCount ?? 0, displayedEvents.count) + (contextBundle?.items.count ?? 0)
    }

    private var hasFailure: Bool {
        reportedFailure || displayedEvents.contains(where: { $0.status == "failed" || $0.phase.contains("failed") })
    }

    private var folioLabel: String {
        if isRunning { return String(localized: "LIVE") }
        if hasFailure { return String(localized: "ERR") }
        return String(format: "%02d", recordCount)
    }

    private var recordTone: Color {
        if hasFailure { return Theme.danger }
        return Theme.textMuted
    }

    private var recordAccessibilityLabel: String {
        if isRunning { return String(localized: "Message record, running") }
        if hasFailure { return String(localized: "Message record, contains a failed step") }
        return String(localized: "Message record, \(recordCount) entries")
    }

    @ViewBuilder
    private var statusIcon: some View {
        if loading && displayedEvents.isEmpty {
            ProgressView().controlSize(.mini)
        } else if isRunning {
            if reduceMotion {
                Image(systemName: "circle.dotted")
            } else {
                ProgressView().controlSize(.mini)
            }
        } else if hasFailure {
            Image(systemName: "xmark.circle")
                .foregroundStyle(Theme.danger)
        } else if let presentation = singlePresentation {
            Image(systemName: presentation.eventType.symbol)
                .foregroundStyle(Theme.textMuted)
        } else {
            Image(systemName: "checkmark.circle")
        }
    }

    private var singlePresentation: ToolPresentation? {
        guard displayedEvents.count == 1 else { return nil }
        return displayedEvents[0].toolPresentation
    }

    private func loadDurableTrace() async {
        guard let api = app.api, !loading else { return }
        loading = true
        errorText = nil
        defer { loading = false }
        do {
            let fetched = try await api.fetchMessageTrace(channelId: channelId, msgId: msgId)
            durableEvents = isRunning
                ? TraceEventContract.coalesce(fetched, liveEvents)
                : fetched
        } catch {
            errorText = String(localized: "Failed to load activity.")
            if durableEvents == nil, !liveEvents.isEmpty { durableEvents = liveEvents }
        }
    }
}

private struct TraceActivitySheet: View {
    let events: [TraceEventDto]
    let isRunning: Bool
    let loading: Bool
    let errorText: String?
    let contextBundle: ResourceContextBundle?
    let retry: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let directGitStatus {
                    GitTraceDetailView(
                        entry: directGitStatus.entry,
                        presentation: directGitStatus.presentation,
                        result: directGitStatus.result
                    )
                } else {
                    content
                }
            }
                .navigationTitle(directGitStatus == nil ? "Message record" : "Git status")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                    if isRunning {
                        ToolbarItem(placement: .bottomBar) {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("Running")
                            }
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
                .navigationDestination(for: TraceEventDto.self) { entry in
                    if let presentation = entry.toolPresentation,
                       let result = GitStatusResult.parse(presentation)
                    {
                        GitTraceDetailView(entry: entry, presentation: presentation, result: result)
                    } else {
                        TraceDetailView(entry: entry)
                    }
                }
        }
    }

    private var directGitStatus: (entry: TraceEventDto, presentation: ToolPresentation, result: GitStatusResult)? {
        guard contextBundle?.items.isEmpty != false,
              events.count == 1,
              let presentation = events[0].toolPresentation,
              let result = GitStatusResult.parse(presentation)
        else { return nil }
        return (events[0], presentation, result)
    }

    @ViewBuilder
    private var content: some View {
        Group {
                if events.isEmpty, loading {
                    ProgressView("Loading activity…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if events.isEmpty, let errorText {
                    ContentUnavailableView {
                        Label("Couldn’t load activity", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorText)
                    } actions: {
                        Button("Retry", action: retry)
                            .buttonStyle(.borderedProminent)
                    }
                } else if events.isEmpty, contextBundle?.items.isEmpty != false {
                    ContentUnavailableView(
                        "No activity recorded",
                        systemImage: "checkmark.circle",
                        description: Text("This response did not record any agent steps.")
                    )
                } else {
                    List {
                        if let items = contextBundle?.items, !items.isEmpty {
                            Section("References") {
                                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                                    Label(item.label, systemImage: "doc.text")
                                        .font(.subheadline)
                                }
                            }
                        }
                        if !events.isEmpty {
                            Section("Agent record") {
                                ForEach(events) { entry in
                                    Group {
                                        if entry.hasDetail {
                                            NavigationLink(value: entry) {
                                                TraceStepRow(entry: entry)
                                            }
                                        } else {
                                            TraceStepRow(entry: entry)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
    }
}

private struct TraceStepRow: View {
    let entry: TraceEventDto

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: entry.displaySymbol)
                .font(.body)
                .foregroundStyle(entry.statusTone)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(entry.compactLabel)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                if let target = entry.targetLabel {
                    if target != entry.compactLabel && !entry.compactLabel.contains(target) {
                        Text(target)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }

            Spacer(minLength: 8)

            HStack(spacing: Theme.space2) {
                if let duration = entry.durationLabel {
                    Text(duration)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.textMuted)
                }
                statusGlyph
            }
        }
        .padding(.vertical, 4)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var statusGlyph: some View {
        switch entry.status {
        case "in_progress", "pending":
            ProgressView().controlSize(.mini)
        case "failed":
            Image(systemName: "xmark.circle").foregroundStyle(Theme.danger)
        default:
            Image(systemName: "checkmark.circle").foregroundStyle(Theme.textMuted)
        }
    }
}

struct GitTraceDetailView: View {
    let entry: TraceEventDto
    let presentation: ToolPresentation
    let result: GitStatusResult

    @State private var copiedCommand = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                statusHeader
                    .padding(.bottom, Theme.space5)

                Text(result.branch ?? String(localized: "Working tree"))
                    .font(.body)
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)

                Text(countSummary)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.top, Theme.space2)

                if result.clean {
                    Label("Working tree clean", systemImage: "checkmark.circle")
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                        .frame(minHeight: Theme.hitMin)
                        .padding(.top, Theme.space5)
                } else {
                    LazyVStack(spacing: Theme.space2) {
                        ForEach(result.files) { file in
                            gitFileRow(file)
                        }
                    }
                    .padding(.top, Theme.space5)
                }

                if result.truncated {
                    Text("More files omitted.")
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                        .padding(.top, Theme.space3)
                }

                if presentation.command != nil || presentation.cwd != nil {
                    commandContext
                        .padding(.top, Theme.space5)
                }

                if presentation.command != nil {
                    copyCommandButton
                        .padding(.top, Theme.space4)
                }
            }
            .padding(.horizontal, Theme.space5)
            .padding(.vertical, Theme.space4)
        }
        .accessibilityIdentifier("git-trace-detail")
        .background(Theme.bgApp)
        .sensoryFeedback(.success, trigger: copiedCommand)
    }

    private var statusHeader: some View {
        HStack(spacing: Theme.space3) {
            Image(systemName: presentation.eventType.symbol)
                .font(.title3)
                .foregroundStyle(Theme.textMuted)

            Text(entry.status == "failed" ? "Failed" : "Done")
                .font(.body.weight(.medium))
                .foregroundStyle(entry.status == "failed" ? Theme.danger : Theme.online)

            Spacer(minLength: Theme.space3)

            Text("\(result.files.count) files changed")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(minHeight: Theme.hitMin)
        .accessibilityElement(children: .combine)
    }

    private var countSummary: String {
        var items: [String] = []
        if result.counts.staged > 0 { items.append("\(result.counts.staged) staged") }
        if result.counts.unstaged > 0 { items.append("\(result.counts.unstaged) unstaged") }
        if result.counts.untracked > 0 { items.append("\(result.counts.untracked) untracked") }
        if result.counts.conflicted > 0 { items.append("\(result.counts.conflicted) conflicted") }
        return items.isEmpty ? String(localized: "No changes") : items.joined(separator: " · ")
    }

    private func gitFileRow(_ file: GitStatusFile) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.space4) {
            Text(fileMarker(file))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(fileColor(file))
                .frame(width: 20, alignment: .leading)

            Text(file.path)
                .font(.caption)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: Theme.hitMin, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var commandContext: some View {
        HStack(alignment: .top, spacing: Theme.space4) {
            Image(systemName: "terminal")
                .font(.subheadline)
                .foregroundStyle(Theme.textMuted)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: Theme.space1) {
                if let command = presentation.command {
                    Text(command)
                        .font(.subheadline)
                        .foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                }
                if let cwd = presentation.cwd {
                    Text("cwd: \(cwd)")
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                        .textSelection(.enabled)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: Theme.hitMin, alignment: .leading)
    }

    private var copyCommandButton: some View {
        Button {
            guard let command = presentation.command else { return }
            UIPasteboard.general.string = command
            copiedCommand = true
        } label: {
            Label(
                copiedCommand ? "Copied" : "Copy command",
                systemImage: copiedCommand ? "checkmark" : "doc.on.doc"
            )
            .font(.subheadline)
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity, minHeight: Theme.hitMin, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    private func fileMarker(_ file: GitStatusFile) -> String {
        if file.state == .untracked { return "A" }
        if file.state == .conflicted { return "!" }
        let index = file.index.trimmingCharacters(in: .whitespaces)
        let worktree = file.worktree.trimmingCharacters(in: .whitespaces)
        return index.first.map(String.init) ?? worktree.first.map(String.init) ?? "M"
    }

    private func fileColor(_ file: GitStatusFile) -> Color {
        if file.state == .conflicted || file.index == "D" || file.worktree == "D" {
            return Theme.danger
        }
        if file.state == .untracked || file.index == "A" || file.worktree == "A" {
            return Theme.online
        }
        return Theme.textSecondary
    }
}

#if DEBUG
struct GitTraceFixtureView: View {
    private let event = TraceEventDto(
        id: "git-status-fixture",
        msgId: "message-fixture",
        kind: "trace",
        phase: "tool_call_update",
        status: "completed",
        createdAt: "2026-08-04T00:00:00Z"
    )

    private let presentation = ToolPresentation(
        eventType: .gitStatus,
        family: "git",
        operation: "status",
        target: "--short --branch",
        path: nil,
        command: "git status --short --branch",
        query: nil,
        cwd: "/repo/Cheers",
        args: "--short --branch",
        risk: "read",
        compound: false,
        result: nil
    )

    private let result = GitStatusResult(
        branch: "feature/tool-presentation",
        clean: false,
        counts: GitStatusCounts(staged: 1, unstaged: 2, untracked: 1, conflicted: 0),
        files: [
            GitStatusFile(path: "server/src/domain/tool_presentation.rs", index: " ", worktree: "M", state: .unstaged),
            GitStatusFile(path: "frontend/src/features/chat/BotTracePanel.tsx", index: " ", worktree: "M", state: .unstaged),
            GitStatusFile(path: "docs/design/TOOL_PRESENTATION.md", index: "A", worktree: " ", state: .staged),
            GitStatusFile(path: "apps/ios/Sources/Views/BotTracePanelView.swift", index: "?", worktree: "?", state: .untracked),
        ],
        truncated: false
    )

    var body: some View {
        NavigationStack {
            GitTraceDetailView(entry: event, presentation: presentation, result: result)
                .navigationTitle("Git status")
                .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
    }
}
#endif

private struct TraceDetailView: View {
    let entry: TraceEventDto

    var body: some View {
        Form {
            Section("Overview") {
                LabeledContent("Type", value: entry.displayLabel)
                LabeledContent("Status") {
                    Label(
                        entry.statusLabel,
                        systemImage: entry.status == "failed" ? "xmark.circle" : statusSymbol
                    )
                    .foregroundStyle(entry.status == "failed" ? Color.red : Color.secondary)
                }
                if let duration = entry.durationLabel {
                    LabeledContent("Duration", value: duration)
                }
                if let target = entry.targetLabel {
                    LabeledContent("Target", value: target)
                }
            }

            if let path = entry.path {
                Section("File") {
                    Text(path)
                        .font(.system(.subheadline, design: .monospaced))
                        .textSelection(.enabled)
                }
            }

            if let diff = entry.diff {
                Section("Changes · +\(diffAdditions) −\(diffDeletions)") {
                    ForEach(Array(diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, raw in
                        let line = String(raw)
                        Text(line.isEmpty ? " " : line)
                            .font(.caption.monospaced())
                            .foregroundStyle(diffForeground(line))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .listRowBackground(diffBackground(line))
                            .listRowSeparator(.hidden)
                    }
                }
            }

            // Generic/"Other" ACP agents put their concrete tool payload one
            // level deeper under `tool`; honor that shared gateway shape too.
            if let input = entry.inputPayload {
                jsonSection("Input", value: input)
            }
            if let output = entry.outputPayload {
                jsonSection("Output", value: output)
            } else if let message = entry.message?.nilIfEmpty {
                Section("Result") {
                    Text(message).font(.subheadline).textSelection(.enabled)
                }
            }
            if let decision = entry.decision?.nilIfEmpty {
                Section("Decision") {
                    Text(decision).font(.subheadline).textSelection(.enabled)
                }
            }
        }
        .navigationTitle(entry.displayLabel)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var statusSymbol: String {
        switch entry.status {
        case "pending", "in_progress": "circle.dotted"
        default: "checkmark.circle"
        }
    }

    private var diffLines: [String] {
        entry.diff?.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) ?? []
    }

    private var diffAdditions: Int {
        diffLines.filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count
    }

    private var diffDeletions: Int {
        diffLines.filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count
    }

    private func diffForeground(_ line: String) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff ") { return .secondary }
        if line.hasPrefix("@@") { return .blue }
        if line.hasPrefix("+") { return .green }
        if line.hasPrefix("-") { return .red }
        return .primary
    }

    private func diffBackground(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Color.green.opacity(0.08) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Color.red.opacity(0.08) }
        if line.hasPrefix("@@") { return Color.blue.opacity(0.08) }
        return .clear
    }

    @ViewBuilder
    private func jsonSection(_ title: LocalizedStringKey, value: JSONValue) -> some View {
        Section {
            Text(value.prettyPrinted(maximumCharacters: 12_000))
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } header: {
            Text(title)
        }
    }
}

private enum TraceCategory {
    case read, edit, write, command, plan, approval, tool, done, failure

    var label: String {
        switch self {
        case .read: return String(localized: "Read")
        case .edit: return String(localized: "Edit")
        case .write: return String(localized: "Write")
        case .command: return String(localized: "Run")
        case .plan: return String(localized: "Plan")
        case .approval: return String(localized: "Approval")
        case .tool: return String(localized: "Tool")
        case .done: return String(localized: "Done")
        case .failure: return String(localized: "Failed")
        }
    }

    var symbol: String {
        switch self {
        case .read: return "doc.text.magnifyingglass"
        case .edit: return "pencil"
        case .write: return "square.and.pencil"
        case .command: return "terminal"
        case .plan: return "list.bullet"
        case .approval: return "checkmark.shield"
        case .tool: return "wrench"
        case .done: return "checkmark"
        case .failure: return "xmark.circle"
        }
    }
}

private extension TraceEventDto {
    var inputPayload: JSONValue? {
        firstNonNullPayload(
            data?["input"],
            data?["raw_input"],
            data?["tool"]?["input"],
            data?["tool"]?["raw_input"]
        )
    }

    var outputPayload: JSONValue? {
        firstNonNullPayload(
            data?["output"],
            data?["raw_output"],
            data?["tool"]?["output"],
            data?["tool"]?["raw_output"]
        )
    }

    private func firstNonNullPayload(_ candidates: JSONValue?...) -> JSONValue? {
        candidates.compactMap { $0 }.first { !$0.isNull }
    }

    var category: TraceCategory {
        if kind == "approval" || phase == "approval" { return .approval }
        if status == "failed" || phase.contains("failed") { return .failure }
        if phase == "plan" { return .plan }
        if phase == "prompt_finished" { return .done }
        return .tool
    }

    var displayLabel: String {
        toolPresentation?.eventType.label ?? category.label
    }

    var displaySymbol: String {
        toolPresentation?.eventType.symbol ?? category.symbol
    }

    var compactLabel: String {
        if let targetLabel { return "\(displayLabel) · \(targetLabel)" }
        return toolPresentation == nil ? (title?.nilIfEmpty ?? displayLabel) : displayLabel
    }

    var targetLabel: String? {
        if let presentation = toolPresentation {
            if let path = presentation.path {
                return path.split(separator: "/").last.map(String.init) ?? path
            }
            return presentation.target ?? presentation.query ?? presentation.command
        }
        if let pathComponent = path?.split(separator: "/").last.map(String.init) {
            return pathComponent
        }
        if let directTarget = data?.firstString("command", "cmd", "query", "target", "tool_name") {
            return directTarget
        }
        if let nestedTarget = data?["tool"]?.firstString("summary", "command", "title", "kind") {
            return nestedTarget
        }
        return title?.nilIfEmpty ?? message?.nilIfEmpty
    }

    var path: String? {
        toolPresentation?.path
            ?? data?.firstString("path", "file_path", "filename")
            ?? data?["input"]?.firstString("path", "file_path", "filename")
            ?? data?["tool"]?.firstString("path", "file_path", "filename")
            ?? data?["tool"]?["raw_input"]?.firstString("path", "file_path", "filename")
    }

    var diff: String? {
        data?.firstString("diff", "unified_diff", "patch")
            ?? data?["output"]?.firstString("diff", "unified_diff", "patch")
    }

    var durationLabel: String? {
        let milliseconds = data?["duration_ms"]?.numberValue
            ?? data?["elapsed_ms"]?.numberValue
        guard let milliseconds else { return nil }
        if milliseconds < 1_000 { return "\(Int(milliseconds))ms" }
        return String(format: "%.1fs", milliseconds / 1_000)
    }

    var hasDetail: Bool {
        if toolPresentation != nil { return true }
        if diff != nil || path != nil || decision?.nilIfEmpty != nil || message?.nilIfEmpty != nil { return true }
        guard let object = data?.objectValue else { return false }
        return !object.isEmpty
    }

    var detailTitle: String {
        if let targetLabel { return "\(displayLabel) · \(targetLabel)" }
        return displayLabel
    }

    var statusLabel: String {
        switch status {
        case "pending": return String(localized: "Pending")
        case "in_progress": return String(localized: "In progress")
        case "failed": return String(localized: "Failed")
        default: return String(localized: "Completed")
        }
    }

    var statusTone: Color {
        switch status {
        case "failed": return Theme.danger
        case "pending", "in_progress": return Theme.textSecondary
        default: return Theme.textMuted
        }
    }
}

private extension JSONValue {
    var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    func prettyPrinted(maximumCharacters: Int? = nil) -> String {
        if let maximumCharacters {
            return boundedPrettyPrinted(maximumCharacters: maximumCharacters)
        }
        guard let encoded = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: encoded),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: pretty, encoding: .utf8)
        else { return String(describing: self) }
        return string
    }

    private func boundedPrettyPrinted(maximumCharacters: Int) -> String {
        var output = ""
        var remaining = maximumCharacters
        appendPreview(to: &output, remaining: &remaining)
        return remaining > 0 ? output : output + "\n… (truncated)"
    }

    private func appendPreview(to output: inout String, remaining: inout Int) {
        guard remaining > 0 else { return }
        func append(_ fragment: String) {
            guard remaining > 0 else { return }
            let prefix = fragment.prefix(remaining)
            output += prefix
            remaining -= prefix.count
        }

        switch self {
        case .null:
            append("null")
        case .bool(let value):
            append(value ? "true" : "false")
        case .number(let value):
            append(String(value))
        case .string(let value):
            let preview = String(value.prefix(remaining))
            let quoted = (try? JSONEncoder().encode(preview))
                .flatMap { String(data: $0, encoding: .utf8) } ?? preview
            append(quoted)
        case .array(let values):
            append("[")
            for (index, value) in values.enumerated() where remaining > 0 {
                if index > 0 { append(", ") }
                value.appendPreview(to: &output, remaining: &remaining)
            }
            append("]")
        case .object(let values):
            append("{")
            for (index, key) in values.keys.sorted().enumerated() where remaining > 0 {
                if index > 0 { append(", ") }
                let quotedKey = (try? JSONEncoder().encode(key))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? key
                append(quotedKey)
                append(": ")
                values[key]?.appendPreview(to: &output, remaining: &remaining)
            }
            append("}")
        }
    }
}

private extension String {
    var nilIfEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
