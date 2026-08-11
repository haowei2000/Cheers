import SwiftUI
import UIKit

enum PresentationLevel: String, CaseIterable, Sendable {
    case max
    case medium
    case minimal
}

enum CheersItemKind: String, Sendable {
    case entity
    case navigation
    case operations
    case workbench
}

private struct PresentationLevelKey: EnvironmentKey {
    static let defaultValue: PresentationLevel = .medium
}

extension EnvironmentValues {
    var presentationLevel: PresentationLevel {
        get { self[PresentationLevelKey.self] }
        set { self[PresentationLevelKey.self] = newValue }
    }
}

extension View {
    /// Explicit item/container levels override the inherited responsive default.
    func presentationLevel(_ level: PresentationLevel) -> some View {
        environment(\.presentationLevel, level)
    }
}

/// Native SwiftUI implementation of the shared item anatomy.
struct CheersItemRow: View {
    @Environment(\.presentationLevel) private var inheritedLevel

    let title: String
    var subtitle: String? = nil
    var metadata: String? = nil
    var preview: String? = nil
    var explicitLevel: PresentationLevel? = nil
    var selected = false
    var leading: AnyView? = nil
    var criticalStatus: AnyView? = nil
    var status: AnyView? = nil
    var trailing: AnyView? = nil
    /// Interactive controls for a composite row. A row with actions must not be
    /// wrapped in `CheersItemButton`, which keeps nested SwiftUI Buttons out.
    var actions: AnyView? = nil

    private var level: PresentationLevel { explicitLevel ?? inheritedLevel }

    var body: some View {
        HStack(alignment: level == .max ? .top : .center, spacing: Theme.space2) {
            leading

            VStack(alignment: .leading, spacing: Theme.space1) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.space1) {
                    Text(title)
                        .font(Theme.utilityFont(for: title, emphasized: true))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    criticalStatus
                    if level != .minimal { status }
                    Spacer(minLength: Theme.space1)
                }

                if level != .minimal, let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(level == .max ? 2 : 1)
                }
                if level == .max, let metadata {
                    Text(metadata)
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
                if level == .max, let preview {
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(Theme.textBody)
                        .lineLimit(2)
                }
            }

            trailing
            actions
        }
        .padding(.horizontal, Theme.space2)
        .padding(.vertical, level == .max ? Theme.space2 : Theme.space1)
        .frame(maxWidth: .infinity, minHeight: Theme.hitMin, alignment: .leading)
        .background(selected ? Theme.bgSelected : Color.clear, in: RoundedRectangle(cornerRadius: 2))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.border)
                .frame(height: 0.5)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Single-action item. Composite items use `CheersItemRow.actions` instead.
struct CheersItemButton: View {
    let row: CheersItemRow
    let action: () -> Void

    var body: some View {
        Button { action() } label: { row }
            .buttonStyle(.plain)
    }
}

private struct CheersSemanticItem: View {
    let kind: CheersItemKind
    let row: CheersItemRow

    var body: some View {
        row.accessibilityIdentifier("cheers-item-\(kind.rawValue)")
    }
}

struct CheersEntityItem: View {
    let row: CheersItemRow
    var body: some View { CheersSemanticItem(kind: .entity, row: row) }
}

struct CheersNavigationItem: View {
    let row: CheersItemRow
    var body: some View { CheersSemanticItem(kind: .navigation, row: row) }
}

struct CheersOperationsItem: View {
    let row: CheersItemRow
    var body: some View { CheersSemanticItem(kind: .operations, row: row) }
}

struct CheersWorkbenchItem: View {
    let row: CheersItemRow
    var body: some View { CheersSemanticItem(kind: .workbench, row: row) }
}

/// Specialized tree row: hierarchy and NavigationLink disclosure remain native.
struct CheersFileTreeItem: View {
    let row: CheersItemRow
    var body: some View { row.accessibilityIdentifier("cheers-item-file-tree") }
}

enum CheersDiffTone: Sendable {
    case addition
    case deletion
    case hunk
    case header
    case context
}

/// Specialized diff row: preserves monospaced selection and semantic color.
struct CheersDiffLineItem: View {
    let text: String
    let tone: CheersDiffTone

    private var foreground: Color {
        switch tone {
        case .addition: .green
        case .deletion: .red
        case .hunk: .blue
        case .header: Theme.textSecondary
        case .context: Theme.textBody
        }
    }

    private var background: Color {
        switch tone {
        case .addition: Color.green.opacity(0.08)
        case .deletion: Color.red.opacity(0.08)
        case .hunk: Color.blue.opacity(0.08)
        case .header, .context: Color.clear
        }
    }

    var body: some View {
        Text(text.isEmpty ? " " : text)
            .font(.caption.monospaced())
            .foregroundStyle(foreground)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowBackground(background)
            .listRowSeparator(.hidden)
            .accessibilityIdentifier("cheers-item-diff-line")
    }
}

#Preview("Item presentation levels") {
    VStack(spacing: Theme.space1) {
        ForEach(PresentationLevel.allCases, id: \.self) { level in
            CheersItemRow(
                title: "Release channel",
                subtitle: "3 unread messages",
                metadata: "Workspace · Engineering",
                preview: "Shared item anatomy across every client.",
                explicitLevel: level,
                leading: AnyView(Image(systemName: "number").frame(width: 28, height: 28)),
                criticalStatus: AnyView(Text("3").font(.caption2.bold()).padding(4).background(Theme.accent, in: RoundedRectangle(cornerRadius: 2)))
            )
        }
        CheersOperationsItem(row: CheersItemRow(
            title: "Deploy production change",
            subtitle: "Approval required",
            criticalStatus: AnyView(Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.warning)),
            actions: AnyView(Button {} label: { Text("Review") })
        ))
    }
    .padding()
}

enum NativeFeedback {
    static func lightImpact() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
}

/// A pushed secondary screen using the system navigation bar and back gesture.
struct ScreenScaffold<Content: View>: View {
    let title: String
    var titleDisplayMode: NavigationBarItem.TitleDisplayMode = .large
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgApp)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(titleDisplayMode)
    }
}
