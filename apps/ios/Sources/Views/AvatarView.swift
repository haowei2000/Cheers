import SwiftUI

/// Circular avatar: optional remote image, else initials with the deterministic
/// color hash shared with the web client (`frontend/src/lib/format.ts`).
struct AvatarView: View {
    let seedId: String
    let name: String?
    var size: CGFloat = 44
    /// Neutral (grayscale) fill instead of the identity-hash color. Used on the
    /// chat page to keep it to a two-color palette (accent + neutral).
    var monochrome: Bool = false
    var imageURL: URL? = nil

    var body: some View {
        ZStack {
            Circle()
                .fill(monochrome ? Theme.bgSelected : Theme.avatarColor(for: seedId))
            if let imageURL {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        initialsLabel
                    }
                }
                .clipShape(Circle())
            } else {
                initialsLabel
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var initialsLabel: some View {
        Text(Theme.initials(name))
            .font(.system(size: size * 0.36, weight: .semibold))
            .foregroundStyle(monochrome ? Theme.textSecondary : .white)
    }
}

/// Group channels show their uploaded avatar, falling back to the familiar hash tile.
struct ChannelAvatarView: View {
    let channel: ChannelDto
    var size: CGFloat = 44

    var body: some View {
        if channel.isDM {
            AvatarView(seedId: channel.channelId, name: channel.displayName, size: size)
        } else if let avatarURL = channel.avatarUrl.flatMap(URL.init(string:)) {
            AvatarView(seedId: channel.channelId, name: channel.name, size: size, imageURL: avatarURL)
        } else {
            ZStack {
                Circle()
                    .fill(Theme.avatarColor(for: channel.channelId).opacity(0.85))
                Image(systemName: "number")
                    .font(.system(size: size * 0.4, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.95))
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
        }
    }
}
