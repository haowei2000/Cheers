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
    /// "@" typeahead pool (group tokens + channel members) and the pick
    /// callback registering the selection for routing (ChatModel.pickedMentions).
    var mentionPool: [MentionCandidate] = []
    var onMentionPicked: (MentionCandidate) -> Void = { _ in }

    @FocusState private var isFocused: Bool
    @State private var action: ComposerAction?

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    // MARK: @-mention typeahead

    /// The active "@" token: the last "@" must start a word and the text after
    /// it must contain no whitespace. The caret is assumed to sit at the end of
    /// the draft — SwiftUI's TextField exposes no caret position, and appending
    /// is where mobile typing overwhelmingly happens.
    private var mentionToken: (range: Range<String.Index>, query: String)? {
        guard let atIndex = text.lastIndex(of: "@") else { return nil }
        if atIndex > text.startIndex, !text[text.index(before: atIndex)].isWhitespace {
            return nil
        }
        let query = text[text.index(after: atIndex)...]
        guard !query.contains(where: \.isWhitespace) else { return nil }
        return (atIndex..<text.endIndex, String(query))
    }

    /// Matches for the active token, ranked bots → group tokens → people (web
    /// parity). Capped at 5 rows so the list never buries the input.
    private var mentionMatches: [MentionCandidate] {
        guard let token = mentionToken, !mentionPool.isEmpty else { return [] }
        let q = token.query.lowercased()
        let hits = mentionPool.filter {
            q.isEmpty || $0.label.lowercased().contains(q)
                || ($0.sublabel?.lowercased().contains(q) ?? false)
        }
        // Stable rank sort: decorate with the original index as tie-break.
        return hits.enumerated()
            .sorted { ($0.element.kind.rawValue, $0.offset) < ($1.element.kind.rawValue, $1.offset) }
            .prefix(5)
            .map(\.element)
    }

    private func pick(_ candidate: MentionCandidate) {
        guard let token = mentionToken else { return }
        text.replaceSubrange(token.range, with: "@\(candidate.label) ")
        onMentionPicked(candidate)
    }

    var body: some View {
        VStack(spacing: 0) {
            if !mentionMatches.isEmpty {
                mentionPicker
            }
            inputRow
        }
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

    private var mentionPicker: some View {
        VStack(spacing: 0) {
            ForEach(mentionMatches) { candidate in
                Button { pick(candidate) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: candidate.kind == .bot ? "sparkles"
                            : candidate.kind == .group ? "person.3" : "person")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(candidate.kind == .bot ? Theme.accent : Theme.textSecondary)
                            .frame(width: 22)
                        Text(candidate.label)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        if let sub = candidate.sublabel, !sub.isEmpty {
                            Text(candidate.kind == .group ? sub : "@\(sub)")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if candidate.kind == .bot {
                            Text("BOT")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(Theme.accent)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 2)
                                .background(Theme.accent.opacity(0.15))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 44)   // HIG tap target
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(Theme.bgRaised)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 2)
        .padding(.bottom, 6)
    }

    private var inputRow: some View {
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
