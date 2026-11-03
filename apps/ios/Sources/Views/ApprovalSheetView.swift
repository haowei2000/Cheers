import SwiftUI

/// Shared native presentation shell for actionable content opened from a channel.
/// Approval, authentication and future tool details use the same navigation,
/// dismissal, scrolling and action placement instead of drawing separate cards.
struct ChannelActionSheet<Content: View, Actions: View>: View {
    @Environment(\.dismiss) private var dismiss

    let title: LocalizedStringKey
    let systemImage: String
    let showsActionBar: Bool
    @ViewBuilder let content: Content
    @ViewBuilder let actions: Actions

    init(
        _ title: LocalizedStringKey,
        systemImage: String,
        showsActionBar: Bool = true,
        @ViewBuilder content: () -> Content,
        @ViewBuilder actions: () -> Actions
    ) {
        self.title = title
        self.systemImage = systemImage
        self.showsActionBar = showsActionBar
        self.content = content()
        self.actions = actions()
    }

    var body: some View {
        NavigationStack {
            content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Image(systemName: systemImage)
                        .foregroundStyle(Theme.textSecondary)
                        .accessibilityHidden(true)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark", role: .cancel) {
                        dismiss()
                    }
                    .labelStyle(.iconOnly)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if showsActionBar {
                    actions
                        .padding(.horizontal)
                        .padding(.vertical, 12)
                        .background(.bar)
                }
            }
        }
    }
}

/// Native expanded ACP approval. The shared sheet owns the presentation while
/// this view supplies only approval-specific sections and actions.
struct ApprovalSheetView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let channelId: String
    let botName: String
    let request: PermissionRequest

    @State private var selectedOptionId: String?
    @State private var busy = false
    @State private var errorText: String?
    @State private var undelivered = false
    @State private var showApprovalConfirm = false

    var body: some View {
        ChannelActionSheet("Approval", systemImage: "checkmark.shield") {
            Form {
                Section {
                    LabeledContent("Agent", value: botName)
                    LabeledContent("Request", value: request.title)
                }

                if let command = request.command {
                    Section("Command") {
                        Text(command)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }

                if let diff = request.diff {
                    Section("Changes") {
                        ScrollView(.horizontal) {
                            Text(diff)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                        }
                        .frame(maxHeight: 220)
                    }
                }

                if !request.locations.isEmpty {
                    Section("Files affected") {
                        ForEach(request.locations, id: \.self) { path in
                            Label(path, systemImage: "doc")
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                }

                Section("Permission") {
                    Picker("Permission", selection: $selectedOptionId) {
                        ForEach(request.radioOptions) { option in
                            Text(option.label).tag(Optional(option.optionId))
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.inline)
                }

                Section {
                    Label(
                        "Review carefully. Approval may allow the agent to read, change or delete files, run commands, or contact external services.",
                        systemImage: "exclamationmark.shield"
                    )
                    .font(.footnote)
                    .foregroundStyle(Theme.warning)

                    if let errorText {
                        Label(errorText, systemImage: "exclamationmark.circle")
                            .font(.footnote)
                            .foregroundStyle(Theme.danger)
                    }

                    if undelivered {
                        Label(
                            "Recorded, but not delivered. The agent may be offline.",
                            systemImage: "wifi.exclamationmark"
                        )
                        .font(.footnote)
                        .foregroundStyle(Theme.warning)
                    }
                }
            }
        } actions: {
            HStack(spacing: 12) {
                Button("Deny", role: .destructive) {
                    Task { await resolve(with: denyOptionId) }
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .disabled(busy)

                Button {
                    showApprovalConfirm = true
                } label: {
                    if busy {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Approve")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy || selectedOptionId == nil)
            }
        }
        .onAppear {
            if selectedOptionId == nil {
                selectedOptionId = request.radioOptions.first?.optionId
            }
        }
        .confirmationDialog(
            "Approve this request?",
            isPresented: $showApprovalConfirm,
            titleVisibility: .visible
        ) {
            Button("Approve request") {
                Task { await resolve(with: selectedOptionId) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Confirm that you reviewed the command, files, and changes above.")
        }
    }

    private var denyOptionId: String? {
        request.rejectOption?.optionId ?? request.options.first { $0.isReject }?.optionId
    }

    private func resolve(with optionId: String?) async {
        guard let optionId, let api = app.api, !busy else { return }
        busy = true
        errorText = nil
        defer { busy = false }
        do {
            let response = try await api.resolvePermission(
                channelId: channelId,
                requestId: request.requestId,
                optionId: optionId
            )
            if response.delivered {
                dismiss()
            } else {
                undelivered = true
            }
        } catch {
            errorText = error.localizedDescription
        }
    }
}
