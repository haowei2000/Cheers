import SwiftUI

/// Inline ACP agent re-auth card (`msg_type: auth_required`).
/// Owner taps "I've signed in" after completing login on the connector host.
struct AuthRequiredCardView: View {
    let message: MessageDto
    @Environment(AppModel.self) private var app
    @State private var busy: String?
    @State private var errorMessage: String?

    private var request: AuthRequiredRequest? {
        AuthRequiredRequest(contentData: message.contentData)
    }

    private var botName: String {
        message.senderName ?? "Agent"
    }

    private var isOwner: Bool {
        guard let owner = request?.botOwnerId, let me = app.session?.userId else { return false }
        return owner == me
    }

    var body: some View {
        if let request {
            if request.resolved {
                resolvedLine(request)
            } else {
                pendingCard(request)
            }
        } else {
            SystemMessageView(message: message)
        }
    }

    private func pendingCard(_ request: AuthRequiredRequest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "key.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.warning)
                Text("\(botName) needs sign-in")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
            }
            Text(request.title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textBody)
            Text(request.description)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
            if let methodId = request.methodId {
                Text(methodId)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textMuted)
            }
            if let link = request.link, let url = URL(string: link) {
                Link("Open login page", destination: url)
                    .font(.system(size: 12, weight: .medium))
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.danger)
            }
            if isOwner {
                HStack(spacing: 8) {
                    Button {
                        Task { await ack("retry") }
                    } label: {
                        HStack(spacing: 6) {
                            if busy == "retry" { ProgressView().controlSize(.mini) }
                            Text("I've signed in")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(.white)
                        .background(Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil)

                    Button {
                        Task { await ack("cancel") }
                    } label: {
                        Text("Cancel")
                            .font(.system(size: 13, weight: .medium))
                            .frame(minHeight: 44)
                            .padding(.horizontal, 14)
                            .foregroundStyle(Theme.textSecondary)
                            .background(Theme.bgRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil)
                }
            } else {
                Text("Waiting for the bot owner to finish agent authentication.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(12)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    private func resolvedLine(_ request: AuthRequiredRequest) -> some View {
        let label: String = {
            if request.chosenAction == "retry" { return "Auth acknowledged — retrying" }
            if request.chosenAction == "cancel" || request.resolvedKind == "timeout" {
                return "Auth cancelled"
            }
            return "Auth resolved"
        }()
        return HStack(spacing: 6) {
            Image(systemName: "key.fill")
                .font(.system(size: 11))
            Text(label)
                .font(.system(size: 12))
        }
        .foregroundStyle(Theme.textMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    private func ack(_ action: String) async {
        guard let request, let api = app.api else { return }
        busy = action
        errorMessage = nil
        defer { busy = nil }
        do {
            _ = try await api.ackAuthRequired(
                channelId: message.channelId,
                requestId: request.requestId,
                action: action
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
