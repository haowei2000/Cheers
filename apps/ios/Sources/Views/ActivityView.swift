import SwiftUI

/// Notifications inbox — the caller's pending channel/workspace invites, matching
/// the web's "Notifications" bell. Approvals live in Fleet ("Waiting on you").
struct NotificationsView: View {
    var activity: ActivityModel

    var body: some View {
        ScreenScaffold(title: "Notifications") {
            Group {
                if activity.invites.isEmpty {
                    ComingSoon(icon: "bell", text: "Channel invites and alerts appear here")
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(activity.invites) { invite in
                                inviteCard(invite)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                    .refreshable { await activity.loadInvites() }
                }
            }
        }
    }

    private func inviteCard(_ invite: NotificationDto) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 9) {
                Image(systemName: invite.isChannelInvite ? "number" : "square.grid.2x2")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 30, height: 30)
                    .background(Theme.bgRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                Text(invite.title)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
            }
            if let by = invite.invitedBy {
                Text("\(by) invited you to join")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
            }
            HStack(spacing: 8) {
                Button { Task { await activity.acceptInvite(invite) } } label: {
                    Text("Accept")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
                Button { Task { await activity.declineInvite(invite) } } label: {
                    Text("Decline")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(Theme.bgRaised)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
