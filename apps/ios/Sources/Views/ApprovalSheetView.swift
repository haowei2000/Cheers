import SwiftUI

/// The expanded ACP approval — command block, optional diff, allow-option radios,
/// and a sticky Deny/Approve footer. Resolving records the decision server-side;
/// the resolved card re-broadcasts over WS. `delivered=false` surfaces an amber
/// warning (the agent's connector/session was offline).
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

    var body: some View {
        VStack(spacing: 14) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    if let command = request.command {
                        commandBlock(command)
                    }
                    if let diff = request.diff {
                        diffBlock(diff)
                    }
                    options
                    if let errorText {
                        Text(errorText)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.danger)
                    }
                    if undelivered {
                        Label("Recorded, but not delivered — the agent's connector or session may be offline.",
                              systemImage: "exclamationmark.triangle")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.warning)
                    }
                }
                .padding(16)
            }
            footer
        }
        .background(Theme.bgSurface)
        .onAppear {
            if selectedOptionId == nil {
                selectedOptionId = request.radioOptions.first?.optionId
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Image(systemName: "shield.lefthalf.filled")
                    .foregroundStyle(Theme.warning)
                Text("\(botName) requests permission")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
            }
            Text(request.title)
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private func commandBlock(_ command: String) -> some View {
        Text(command)
            .font(.system(size: 12.5, design: .monospaced))
            .foregroundStyle(Theme.textBody)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .padding(12)
            .background(Theme.bgApp)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func diffBlock(_ diff: String) -> some View {
        ScrollView {
            Text(diff)
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(Theme.textBody)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 180)
        .padding(12)
        .background(Theme.bgApp)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var options: some View {
        VStack(spacing: 8) {
            ForEach(request.radioOptions) { option in
                Button {
                    selectedOptionId = option.optionId
                } label: {
                    HStack(spacing: 11) {
                        Image(systemName: selectedOptionId == option.optionId ? "largecircle.fill.circle" : "circle")
                            .font(.system(size: 20))
                            .foregroundStyle(selectedOptionId == option.optionId ? Theme.accent : Theme.textFaint)
                        Text(option.label)
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.textBody)
                        Spacer()
                    }
                    .padding(.vertical, 11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button { Task { await resolve(with: denyOptionId) } } label: {
                Text("Deny")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Theme.bgRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(busy)

            Button { Task { await resolve(with: selectedOptionId) } } label: {
                ZStack {
                    if busy { ProgressView().tint(Theme.bgApp) }
                    Text("Approve").opacity(busy ? 0 : 1)
                }
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(Theme.bgApp)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Theme.textPrimary)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(busy || selectedOptionId == nil)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 28)
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
                // Keep the sheet open so the user sees the decision didn't reach the agent.
                undelivered = true
            }
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }
}
