import SwiftUI

/// Growing multiline composer pinned to the bottom of the chat screen.
/// Visuals follow the web MessageComposer: raised capsule, strong border that
/// turns indigo on focus, 32pt indigo send button.
/// Composer "..." menu actions, mirroring the web MessageComposer controls
/// (attach file, add context, choose session, model & bot settings).
private enum ComposerAction: String, Identifiable {
    case attach = "Attach file"
    case context = "Add context"
    case session = "Choose session"
    case model = "Model & bot settings"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .attach: return "paperclip"
        case .context: return "text.badge.plus"
        case .session: return "square.stack.3d.up"
        case .model: return "slider.horizontal.3"
        }
    }
    var blurb: String {
        switch self {
        case .attach: return "Upload a file or pick an existing channel file to send."
        case .context: return "Add Cheers resources (plan, decisions, files) as context for your next message."
        case .session: return "Route this message to a specific bot session, or Auto by @mention."
        case .model: return "Session mode and per-bot model settings for this channel."
        }
    }
}

struct ComposerView: View {
    @Binding var text: String
    let placeholder: String
    let isSending: Bool
    let onSend: () -> Void
    var onChooseSession: () -> Void = {}
    var onModelSettings: () -> Void = {}

    @FocusState private var isFocused: Bool
    @State private var action: ComposerAction?

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Menu {
                Button { action = .attach } label: { Label("Attach file", systemImage: "paperclip") }
                Button { action = .context } label: { Label("Add context", systemImage: "text.badge.plus") }
                Button { onChooseSession() } label: { Label("Choose session", systemImage: "square.stack.3d.up") }
                Button { onModelSettings() } label: { Label("Model & bot settings", systemImage: "slider.horizontal.3") }
            } label: {
                // 44pt hit target (HIG hard minimum), 32pt glyph footprint.
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .padding(.leading, 2)

            TextField(placeholder, text: $text, axis: .vertical)
                .font(.system(size: 16))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1...8)
                .focused($isFocused)
                .padding(.vertical, 11)

            Button(action: onSend) {
                Group {
                    if isSending {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(canSend ? Color.white : Theme.textFaint)
                    }
                }
                .frame(width: 34, height: 34)
                .background(canSend ? Theme.accent : Theme.bgSelected.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                .frame(width: 44, height: 44)   // 44pt hit target around the 34pt visual
                .contentShape(Rectangle())
            }
            .disabled(!canSend)
            .padding(.trailing, 2)
        }
        .background(Theme.bgRaised.opacity(0.8))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        // Borderless at rest (content-first); the accent ring appears only on focus.
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isFocused ? Theme.accentHover.opacity(0.6) : Color.clear, lineWidth: 1.5)
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(Theme.bgApp)
        .sheet(item: $action) { action in
            ComposerActionSheet(action: action)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }
}

/// Placeholder detail for a composer action — the full pickers (file upload,
/// context bundle, session/model) are a follow-up; this names the action and
/// its purpose so the entry points match the web composer.
private struct ComposerActionSheet: View {
    let action: ComposerAction

    var body: some View {
        VStack(spacing: 14) {
            Capsule().fill(Theme.bgSelected).frame(width: 38, height: 5).padding(.top, 8)
            Image(systemName: action.icon)
                .font(.system(size: 34))
                .foregroundStyle(Theme.accent)
                .padding(.top, 8)
            Text(action.rawValue)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(action.blurb)
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgSurface)
    }
}
