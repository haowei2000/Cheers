import SwiftUI

/// Growing multiline composer pinned to the bottom of the chat screen.
/// Visuals follow the web MessageComposer: raised capsule, strong border that
/// turns indigo on focus, 32pt indigo send button.
struct ComposerView: View {
    @Binding var text: String
    let placeholder: String
    let isSending: Bool
    let onSend: () -> Void

    @FocusState private var isFocused: Bool

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $text, axis: .vertical)
                .font(.system(size: 15))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1...8)
                .focused($isFocused)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)

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
                .frame(width: 32, height: 32)
                .background(canSend ? Theme.accent : Theme.bgSelected.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .disabled(!canSend)
            .padding(.trailing, 6)
            .padding(.bottom, 5)
        }
        .background(Theme.bgRaised.opacity(0.8))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isFocused ? Theme.accentHover.opacity(0.6) : Theme.borderStrong, lineWidth: 1)
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(Theme.bgApp)
    }
}
