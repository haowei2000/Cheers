import SwiftUI

/// Workbench — the channel's file workspace, read-only.
///
/// The web workbench is file-centric: browse the tree, open a file, and it renders
/// through a bound *renderer* (a built-in lens or a sandboxed HTML plugin), falling
/// back to "Raw" when nothing is bound. iOS has no sandbox to run plugin bundles in,
/// so this is the Raw half only: the tree plus exact file bytes. Native lenses
/// (checklist / table / kanban) are the follow-up; editing comes after that
/// (`fs.write` + the `if_version` optimistic lock).
///
/// **`fs.ls` returns a FLAT, recursive list of full paths** — `draft/paper.md`, not a
/// `draft` directory containing `paper.md` — and in practice emits no `is_dir` rows at
/// all. So, exactly like the web `buildTree` (workbench/panels/FilePanel.tsx), the
/// folder hierarchy is *derived client-side*: a folder is any path prefix that has
/// children (or an explicit `is_dir` row, which materializes a possibly-empty folder).
/// One `fs.ls` at the root feeds the whole browser; drilling down costs no round trip.
///
/// Everything here is agent-authored and untrusted — like ViewBoards, it renders as
/// inert `Text`, never as markup and never as tappable links.
struct WorkbenchSheet: View {
    @Environment(AppModel.self) private var app
    let channelId: String

    /// Folder stack: [] is the workspace root, one segment appended per drill-down.
    @State private var stack: [String] = []
    @State private var openFile: TreeNode?
    @State private var root: [TreeNode] = []
    @State private var errorText: String?
    @State private var isLoading = true
    @State private var isRefreshing = false

    private var currentPath: String { stack.joined(separator: "/") }

    /// Children of the folder the user is currently in, walked down from the root.
    private var visible: [TreeNode] {
        var nodes = root
        for segment in stack {
            guard let next = nodes.first(where: { $0.isDir && $0.name == segment }) else { return [] }
            nodes = next.children
        }
        return nodes
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let openFile {
                FileContentView(channelId: channelId, node: openFile)
            } else if isLoading {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
            } else if let errorText {
                ComingSoon(icon: "exclamationmark.triangle", text: errorText)
            } else if visible.isEmpty {
                ComingSoon(icon: "folder", text: "No files here yet.")
            } else {
                List(visible) { node in
                    Button {
                        if node.isDir { stack.append(node.name) } else { openFile = node }
                    } label: {
                        row(node)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Theme.bgSurface)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
        .task { await load() }
    }

    private func row(_ node: TreeNode) -> some View {
        HStack(spacing: 10) {
            Image(systemName: node.isDir ? "folder.fill" : icon(for: node.name))
                .font(.system(size: 15))
                .foregroundStyle(node.isDir ? Theme.accent : Theme.textMuted)
                .frame(width: 22)
            Text(node.name)
                .font(.system(size: 15))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if node.isDir {
                Text("\(node.children.count)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textFaint)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textFaint)
            } else {
                Text(size(node.sizeBytes))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textFaint)
            }
        }
        .contentShape(Rectangle())
    }

    private func icon(for name: String) -> String {
        switch name.split(separator: ".").last.map(String.init)?.lowercased() {
        case "md", "markdown", "txt": return "doc.text"
        case "json", "yaml", "yml", "toml", "xml": return "curlybraces"
        default: return "doc"
        }
    }

    private func size(_ bytes: Int) -> String {
        bytes < 1024 ? "\(bytes) B" : String(format: "%.1f KB", Double(bytes) / 1024)
    }

    /// `showSpinner: false` on a manual refresh — replacing the list with a full-frame
    /// ProgressView would make the tree flicker away under the user's finger; the header
    /// button shows the progress instead.
    private func load(showSpinner: Bool = true) async {
        if showSpinner { isLoading = true } else { isRefreshing = true }
        defer { isRefreshing = false }
        do {
            // One recursive listing for the whole workspace — see the type doc.
            let raw = try await app.socket.request(
                resource: "fs.ls", params: ["channel_id": channelId, "path": ""])
            root = TreeNode.build(from: try raw.decode(as: FsListing.self).entries)
            errorText = nil
        } catch {
            errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    private var header: some View {
        HStack(spacing: 8) {
            if openFile != nil || !stack.isEmpty {
                Button {
                    if openFile != nil { openFile = nil } else { stack.removeLast() }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                }
            } else {
                Image(systemName: "sidebar.right").foregroundStyle(Theme.accent)
            }

            VStack(alignment: .leading, spacing: 1) {
                Text(openFile?.name ?? "Workbench")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                // Show where we are; the root shows the purpose instead of an empty path.
                Text(breadcrumb)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer()
            // The tree is a snapshot — nothing pushes a bot's new file into an open
            // sheet. This is a BUTTON, not pull-to-refresh: inside a presentationDetents
            // sheet a downward pan is claimed by the sheet's own resize/dismiss gesture,
            // so `.refreshable` never fires (verified on device).
            if openFile == nil {
                Button {
                    Task { await load(showSpinner: false) }
                } label: {
                    if isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.accent)
                    }
                }
                .disabled(isRefreshing || isLoading)
                .accessibilityLabel("Refresh file list")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    private var breadcrumb: String {
        if let openFile { return openFile.path }
        return stack.isEmpty ? "The channel's file workspace" : currentPath
    }
}

// MARK: - Derived folder tree

/// A node in the tree derived from the flat `fs.ls` paths. Mirrors the web
/// `buildTree` (workbench/panels/FilePanel.tsx) so both clients show the same shape.
struct TreeNode: Identifiable {
    let name: String
    let path: String
    let isDir: Bool
    let sizeBytes: Int
    let children: [TreeNode]

    var id: String { path }

    /// Reference type used only while assembling — nested `struct` mutation would mean
    /// copying whole subtrees on every insert.
    private final class Builder {
        let name: String
        let path: String
        var isDir: Bool
        var sizeBytes = 0
        /// Insertion-ordered children, keyed for O(1) lookup while walking segments.
        var order: [String] = []
        var kids: [String: Builder] = [:]

        init(name: String, path: String, isDir: Bool) {
            self.name = name
            self.path = path
            self.isDir = isDir
        }

        func child(_ segment: String, isDir: Bool) -> Builder {
            if let existing = kids[segment] {
                // A prefix seen earlier as a leaf is really a folder once it gains children.
                if isDir { existing.isDir = true }
                return existing
            }
            let full = path.isEmpty ? segment : "\(path)/\(segment)"
            let node = Builder(name: segment, path: full, isDir: isDir)
            kids[segment] = node
            order.append(segment)
            return node
        }

        func frozen() -> [TreeNode] {
            order
                .compactMap { kids[$0] }
                .map {
                    TreeNode(
                        name: $0.name, path: $0.path, isDir: $0.isDir,
                        sizeBytes: $0.sizeBytes, children: $0.frozen()
                    )
                }
                // Folders first, then files, each alphabetical — same ordering as the web.
                .sorted {
                    $0.isDir != $1.isDir
                        ? $0.isDir
                        : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                }
        }
    }

    static func build(from entries: [FsEntry]) -> [TreeNode] {
        let root = Builder(name: "", path: "", isDir: true)
        for entry in entries {
            let parts = entry.path.split(separator: "/").map(String.init)
            guard !parts.isEmpty else { continue }
            var cursor = root
            // Every segment but the last is necessarily a folder.
            for segment in parts.dropLast() {
                cursor = cursor.child(segment, isDir: true)
            }
            let leaf = cursor.child(parts[parts.count - 1], isDir: entry.isDir)
            if !entry.isDir { leaf.sizeBytes = entry.sizeBytes }
        }
        return root.frozen()
    }
}

// MARK: - File contents (Raw)

private struct FileContentView: View {
    @Environment(AppModel.self) private var app
    let channelId: String
    let node: TreeNode

    @State private var content: String?
    @State private var errorText: String?
    @State private var isLoading = true

    var body: some View {
        Group {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
            } else if let errorText {
                ComingSoon(icon: "exclamationmark.triangle", text: errorText)
            } else if let content {
                if content.isEmpty {
                    ComingSoon(icon: "doc", text: "This file is empty.")
                } else {
                    ScrollView([.vertical, .horizontal]) {
                        // Inert by construction: plain Text renders no markup and makes
                        // no link tappable, so bot-authored content cannot act on a tap.
                        // Monospaced + exact bytes = the web workbench's "Raw" view.
                        //
                        // fixedSize lets the Text take its NATURAL width so long lines
                        // extend past the viewport and the horizontal scroll has room to
                        // move. A `maxWidth: .infinity` here would pin the content to the
                        // viewport instead, silently clipping long lines with no way to
                        // reach them — code and JSON must never be truncated invisibly.
                        Text(content)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(Theme.textBody)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: true)
                            .padding(16)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task(id: node.path) { await load() }
    }

    private func load() async {
        isLoading = true
        do {
            let raw = try await app.socket.request(
                resource: "fs.read", params: ["channel_id": channelId, "path": node.path])
            content = try raw.decode(as: FsFile.self).content
            errorText = nil
        } catch {
            errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }
}
