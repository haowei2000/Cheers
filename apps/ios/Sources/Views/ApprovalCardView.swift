import SwiftUI

/// Inline ACP approval, rendered in the message stream. Pending → a compact card
/// (shield + bot + one-line command + Review) that opens the Approval sheet.
/// Resolved → a single quiet trace-style line. Falls back to plain system text
/// when the payload isn't an actionable request.
struct ApprovalCardView: View {
    let message: MessageDto
    @State private var showSheet = false

    private var request: PermissionRequest? {
        PermissionRequest(contentData: message.contentData)
    }

    private var botName: String {
        message.senderName ?? "Agent"
    }

    var body: some View {
        if let request {
            if request.resolved {
                resolvedLine(request)
            } else {
                pendingCard(request)
            }
        } else {
            // Not an actionable card (missing request id) — plain system text.
            SystemMessageView(message: message)
        }
    }

    // MARK: Pending

    private func pendingCard(_ request: PermissionRequest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "shield.lefthalf.filled")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.warning)
                Text("\(botName) requests permission")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
            }
            if let command = request.command {
                Text(command)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.textBody)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Theme.bgApp)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            HStack {
                Text(request.title)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Theme.textSecondary)
                Spacer()
                Button { showSheet = true } label: {
                    Text("Review")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)   // HIG minimum tap target
                        .background(Theme.bgRaised)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .sheet(isPresented: $showSheet) {
            ApprovalSheetView(channelId: message.channelId, botName: botName, request: request)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // MARK: Resolved

    private func resolvedLine(_ request: PermissionRequest) -> some View {
        let (icon, tint, verb): (String, Color, String) = {
            if request.wasExpired { return ("clock", Theme.textMuted, "Expired") }
            if request.wasAllowed { return ("checkmark", Theme.online, "Allowed") }
            return ("xmark", Theme.textMuted, "Denied")
        }()
        return HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tint)
            Text("\(verb): \(request.command ?? request.title)")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .padding(.horizontal, 24)
    }
}
