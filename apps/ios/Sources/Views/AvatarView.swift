import SwiftUI

/// Circular initials avatar with the deterministic color hash shared with the
/// web client (frontend/src/lib/format.ts).
struct AvatarView: View {
    let seedId: String
    let name: String?
    var size: CGFloat = 44
    /// Neutral (grayscale) fill instead of the identity-hash color. Used on the
    /// chat page to keep it to a two-color palette (accent + neutral).
    var monochrome: Bool = false

    var body: some View {
        ZStack {
            Circle()
                .fill(monochrome ? Theme.bgSelected : Theme.avatarColor(for: seedId))
            Text(Theme.initials(name))
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundStyle(monochrome ? Theme.textSecondary : .white)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Hash-glyph tile for group channels (web sidebar uses a Hash glyph, not an
/// avatar, for channels).
struct ChannelAvatarView: View {
    let channel: ChannelDto
    var size: CGFloat = 44

    var body: some View {
        if channel.isDM {
            AvatarView(seedId: channel.channelId, name: channel.displayName, size: size)
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
