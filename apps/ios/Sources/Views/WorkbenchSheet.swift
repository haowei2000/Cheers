import SwiftUI
import Charts
import QuickLook

// MARK: - Native multi-scene workbench

struct WorkbenchSceneState: Equatable {
    static let otherId = "__other__"
    var order: [String] = []
    var titles: [String: String] = [:]
    var items: [String: [String]] = [:]

    init() {}

    init(_ value: JSONValue?) {
        guard let object = value?.objectValue else { return }
        order = object["order"]?.arrayValue?.compactMap(\.stringValue) ?? []
        titles = object["titles"]?.objectValue?.compactMapValues(\.stringValue) ?? [:]
        items = object["items"]?.objectValue?.mapValues { $0.arrayValue?.compactMap(\.stringValue) ?? [] } ?? [:]
    }

    var jsonValue: JSONValue {
        .object([
            "version": .number(1),
            "order": .array(order.map(JSONValue.string)),
            "titles": .object(titles.mapValues(JSONValue.string)),
            "items": .object(items.mapValues { .array($0.map(JSONValue.string)) }),
        ])
    }
}

private struct WorkbenchSceneStyle {
    let icon: String
    let subtitle: String
    let tint: Color

    static func resolve(_ id: String) -> Self {
        switch id {
        case "cheers-code-project": return .init(icon: "chevron.left.forwardslash.chevron.right", subtitle: "Plan, fix, and ship", tint: .indigo)
        case "cheers-research-lab": return .init(icon: "atom", subtitle: "Experiments and submissions", tint: .purple)
        case "cheers-task-board": return .init(icon: "checklist", subtitle: "Turn intent into progress", tint: .blue)
        case "cheers-team-ops": return .init(icon: "server.rack", subtitle: "Keep systems and ownership clear", tint: .orange)
        case WorkbenchSceneState.otherId: return .init(icon: "sparkles.rectangle.stack", subtitle: "Renderable items outside a scene", tint: .teal)
        default: return .init(icon: "square.grid.2x2", subtitle: "Native workspace", tint: .accentColor)
        }
    }
}

/// The default Workbench surface is content-first. File paths remain the storage and
/// agent contract, but only files accepted by a compiled native renderer become items.
struct WorkbenchSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let channelId: String
    var onAddContext: (ResourceContextItem) -> Void = { _ in }

    @State private var entries: [FsEntry] = []
    @State private var root: [TreeNode] = []
    @State private var templates: [WorkbenchTemplateRow] = []
    @State private var config: [String: JSONValue] = [:]
    @State private var sceneState = WorkbenchSceneState()
    @State private var discoveredLenses: [String: String] = [:]
    @State private var cachedFiles: [String: FsFile] = [:]
    @State private var activeScene = ""
    @State private var selectedItems: [String: String] = [:]
    @State private var errorText: String?
    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var isApplyingTemplate = false
    @State private var showRaw = false
    @State private var showSceneManager = false
    @State private var listenerId: UUID?
    @State private var pendingSignal: Task<Void, Never>?

    private var bindings: [String: String] {
        config["bindings"]?.objectValue?.compactMapValues { value in
            value.stringValue?.replacingOccurrences(of: "builtin:", with: "")
        } ?? [:]
    }

    private var allFilePaths: Set<String> {
        Set(entries.lazy.filter { !$0.isDir }.map(\.path))
    }

    private var claimedPaths: Set<String> {
        Set(sceneState.order.flatMap { sceneState.items[$0] ?? [] })
    }

    private var otherPaths: [String] {
        workbenchOtherPaths(discovered: discoveredLenses, claimed: claimedPaths, existing: allFilePaths)
    }

    private var sceneIds: [String] {
        sceneState.order + (otherPaths.isEmpty ? [] : [WorkbenchSceneState.otherId])
    }

    private var activePaths: [String] {
        let paths = activeScene == WorkbenchSceneState.otherId ? otherPaths : (sceneState.items[activeScene] ?? [])
        return paths.filter { allFilePaths.contains($0) && discoveredLenses[$0] != nil }
    }

    private var selectedPath: String? {
        if let selected = selectedItems[activeScene], activePaths.contains(selected) { return selected }
        return activePaths.first
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Preparing workbench…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorText, entries.isEmpty {
                    ContentUnavailableView {
                        Label("Couldn’t open Workbench", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorText)
                    } actions: {
                        Button("Retry") { Task { await load() } }
                    }
                } else if sceneIds.isEmpty {
                    ContentUnavailableView {
                        Label("Choose a scene", systemImage: "square.grid.2x2")
                    } description: {
                        Text("Activate a scene to turn workspace data into native pages. Other files remain available in Raw.")
                    } actions: {
                        Button("Browse scenes") { showSceneManager = true }
                    }
                } else if horizontalSizeClass == .regular {
                    regularLayout
                } else {
                    compactLayout
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .principal) {
                    if sceneIds.isEmpty {
                        Text("Workbench").font(.headline)
                    } else {
                        sceneTitlePicker
                    }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { showRaw = true } label: {
                        Label("Raw", systemImage: "folder")
                    }
                    .accessibilityHint("Opens every workspace file in a file tree")
                    Button { showSceneManager = true } label: {
                        Label("Scenes", systemImage: "square.grid.2x2")
                    }
                    Button { Task { await load(showSpinner: false) } } label: {
                        if isRefreshing { ProgressView() } else { Label("Refresh", systemImage: "arrow.clockwise") }
                    }
                    .disabled(isRefreshing)
                }
            }
        }
        .sheet(isPresented: $showRaw) {
            WorkbenchRawBrowser(channelId: channelId, root: root) {
                Task { await load(showSpinner: false) }
            }
        }
        .sheet(isPresented: $showSceneManager) { sceneManager }
        .task {
            await load()
            listenerId = app.addSocketListener { event in
                if case .boardSignal(let id, let board) = event,
                   id == channelId, board == "files" {
                    scheduleSignalRefresh()
                }
            }
        }
        .onDisappear {
            if let listenerId { app.removeSocketListener(listenerId) }
            pendingSignal?.cancel()
        }
        .onChange(of: activeScene) { _, scene in
            guard !scene.isEmpty else { return }
            UserDefaults.standard.set(scene, forKey: "workbench.activeScene.\(channelId)")
            normalizeSelection()
        }
    }

    private var compactLayout: some View {
        VStack(spacing: 0) {
            itemStrip
            documentContent
        }
    }

    private var regularLayout: some View {
        VStack(spacing: 0) {
            itemStrip
            documentContent
        }
    }

    /// Active scene switcher in the navigation bar principal slot (replaces the
    /// static "Workbench" title). Explicit menu label keeps icon + title +
    /// chevron readable in the compact nav bar (plain `.pickerStyle(.menu)`
    /// often collapses to a bare title).
    private var sceneTitlePicker: some View {
        let style = WorkbenchSceneStyle.resolve(activeScene)
        return Menu {
            ForEach(sceneIds, id: \.self) { id in
                Button {
                    activeScene = id
                } label: {
                    Label(sceneTitle(id), systemImage: WorkbenchSceneStyle.resolve(id).icon)
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: style.icon)
                    .foregroundStyle(style.tint)
                    .imageScale(.medium)
                Text(sceneTitle(activeScene))
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Select workbench scene")
        .accessibilityValue(sceneTitle(activeScene))
    }

    private var sceneHeader: some View {
        let style = WorkbenchSceneStyle.resolve(activeScene)
        return HStack(spacing: 12) {
            Image(systemName: style.icon)
                .font(.title2.weight(.semibold))
                .foregroundStyle(style.tint)
                .frame(width: 44, height: 44)
                .background(style.tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 2) {
                Text(sceneTitle(activeScene)).font(.headline)
                Text(style.subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text("\(activePaths.count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityLabel("\(activePaths.count) items")
        }
        .padding(12)
    }

    private var itemStrip: some View {
        Group {
            if !activePaths.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(activePaths, id: \.self) { path in
                            let selected = path == selectedPath
                            Button { select(path) } label: {
                                Label(itemTitle(path), systemImage: lensIcon(discoveredLenses[path] ?? "raw"))
                                    .font(.subheadline.weight(selected ? .semibold : .regular))
                                    .lineLimit(1)
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 44)
                                    .background(selected ? Color.accentColor.opacity(0.14) : Theme.bgRaised, in: RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .contextMenu {
                                Button {
                                    onAddContext(workbenchContext(path))
                                } label: {
                                    Label("Add to context", systemImage: "link.badge.plus")
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                }
                .padding(.bottom, 8)
                .overlay(alignment: .bottom) { Divider() }
            }
        }
    }

    @ViewBuilder private var documentContent: some View {
        if let selectedPath, let entry = entries.first(where: { $0.path == selectedPath }) {
            let node = TreeNode(name: itemTitle(selectedPath), path: selectedPath, isDir: false, sizeBytes: entry.sizeBytes, children: [])
            FileContentView(
                channelId: channelId,
                node: node,
                preferredLens: discoveredLenses[selectedPath] ?? bindings[selectedPath],
                lensConfig: config["configs"]?.objectValue?[selectedPath]
            )
            .id("\(selectedPath):\(entry.version)")
        } else {
            ContentUnavailableView(
                "No native items",
                systemImage: "square.dashed",
                description: Text("This scene’s unsupported files are still available from Raw.")
            )
        }
    }

    private var sceneManager: some View {
        NavigationStack {
            List {
                if !sceneState.order.isEmpty {
                    Section("Enabled") {
                        ForEach(sceneState.order, id: \.self) { id in
                            CheersWorkbenchItem(row: CheersItemRow(
                                title: sceneTitle(id),
                                subtitle: WorkbenchSceneStyle.resolve(id).subtitle,
                                leading: AnyView(Image(systemName: WorkbenchSceneStyle.resolve(id).icon).foregroundStyle(WorkbenchSceneStyle.resolve(id).tint)),
                                status: AnyView(Text("ENABLED").font(.caption2.bold()).foregroundStyle(Theme.online))
                            ))
                        }
                        .onDelete { offsets in Task { await removeScenes(at: offsets) } }
                        .onMove { source, destination in Task { await moveScenes(from: source, to: destination) } }
                    }
                }
                Section("Available") {
                    ForEach(templates.filter { !sceneState.order.contains($0.manifest.id) }) { template in
                        Button { Task { await apply(template.manifest) } } label: {
                            CheersWorkbenchItem(row: CheersItemRow(
                                title: template.title,
                                subtitle: template.origin == "system" ? "Built in" : template.origin,
                                leading: AnyView(Image(systemName: "square.grid.2x2").foregroundStyle(Theme.accent)),
                                trailing: AnyView(Image(systemName: "plus.circle.fill").foregroundStyle(Theme.accent))
                            ))
                        }
                        .disabled(isApplyingTemplate)
                    }
                }
            }
            .navigationTitle("Scenes")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { showSceneManager = false } }
                ToolbarItem(placement: .primaryAction) { EditButton() }
            }
        }
    }

    private func sceneTitle(_ id: String) -> String {
        id == WorkbenchSceneState.otherId ? "Other" : (sceneState.titles[id] ?? templates.first { $0.manifest.id == id }?.title ?? id)
    }

    private func itemTitle(_ path: String) -> String {
        if activeScene != WorkbenchSceneState.otherId,
           let view = templates.first(where: { $0.manifest.id == activeScene })?.manifest.views.first(where: { $0.file == path }) {
            return view.title
        }
        let file = path.split(separator: "/").last.map(String.init) ?? path
        let stem = file.split(separator: ".").dropLast().joined(separator: ".")
        return (stem.isEmpty ? file : stem).replacingOccurrences(of: "-", with: " ").capitalized
    }

    private func lensIcon(_ lens: String) -> String {
        switch lens { case "markdown": return "doc.richtext"; case "table": return "tablecells"; case "kanban": return "rectangle.3.group"; case "chart": return "chart.xyaxis.line"; case "codemap": return "point.3.connected.trianglepath.dotted"; default: return "doc.text" }
    }

    private func workbenchContext(_ path: String) -> ResourceContextItem {
        ResourceContextItem(
            id: "fs:(channelId):(path)",
            verb: "fs.read",
            params: ["channel_id": .string(channelId), "path": .string(path)],
            label: "(itemTitle(path)) (Workbench)",
            kind: "file"
        )
    }

    private func select(_ path: String) {
        selectedItems[activeScene] = path
        UserDefaults.standard.set(path, forKey: "workbench.selected.\(channelId).\(activeScene)")
    }

    private func normalizeSelection() {
        if let stored = UserDefaults.standard.string(forKey: "workbench.selected.\(channelId).\(activeScene)"), activePaths.contains(stored) {
            selectedItems[activeScene] = stored
        } else if let first = activePaths.first {
            select(first)
        } else {
            selectedItems[activeScene] = nil
        }
    }

    private func load(showSpinner: Bool = true) async {
        if showSpinner { isLoading = true } else { isRefreshing = true }
        defer { isLoading = false; isRefreshing = false }
        do {
            async let listingValue = app.socket.request(resource: "fs.ls", params: ["channel_id": channelId, "path": ""])
            async let templateValues: [WorkbenchTemplateRow] = app.api?.listWorkbenchTemplates() ?? []
            let listing = try await listingValue.decode(as: FsListing.self)
            templates = try await templateValues
            entries = listing.entries
            root = TreeNode.build(from: entries)
            await loadConfiguration()
            migrateLegacySceneIfNeeded()
            reconcileBuiltInSceneItems()
            await discoverRenderers()
            restoreActiveScene()
            errorText = nil
        } catch {
            errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func loadConfiguration() async {
        do {
            let raw = try await app.socket.request(resource: "fs.read", params: ["channel_id": channelId, "path": ".workbench.json"])
            let file = try raw.decode(as: FsFile.self)
            config = (try? JSONDecoder().decode([String: JSONValue].self, from: Data(file.content.utf8))) ?? [:]
            sceneState = WorkbenchSceneState(config["scene_state"])
        } catch {
            config = [:]
            sceneState = WorkbenchSceneState()
        }
    }

    private func migrateLegacySceneIfNeeded() {
        guard sceneState.order.isEmpty,
              let environment = config["environment"]?.stringValue,
              let manifest = templates.first(where: { $0.manifest.id == environment })?.manifest else { return }
        sceneState.order = [manifest.id]
        sceneState.titles[manifest.id] = manifest.title
        sceneState.items[manifest.id] = manifest.views.map(\.file)
    }

    /// System scenes can gain new native items without replacing a channel's shared
    /// ordering or removing user-managed items. The reconciled state stays in memory
    /// until the next normal Workbench configuration write, matching legacy migration.
    private func reconcileBuiltInSceneItems() {
        for template in templates where template.origin == "system" && sceneState.order.contains(template.manifest.id) {
            var items = sceneState.items[template.manifest.id] ?? []
            for view in template.manifest.views where !items.contains(view.file) {
                items.append(view.file)
            }
            sceneState.items[template.manifest.id] = items
        }
    }

    private func discoverRenderers() async {
        var found: [String: String] = [:]
        let files = entries.filter { !$0.isDir && $0.path != ".workbench.json" }
        var needsInspection: [FsEntry] = []
        for entry in files {
            if let bound = bindings[entry.path], ["markdown", "table", "kanban", "chart", "codemap"].contains(bound) {
                found[entry.path] = bound
            } else if ["md", "markdown"].contains(entry.path.split(separator: ".").last.map(String.init)?.lowercased() ?? "") {
                found[entry.path] = "markdown"
            } else if ["json", "yaml", "yml"].contains(entry.path.split(separator: ".").last.map(String.init)?.lowercased() ?? "") {
                needsInspection.append(entry)
            }
        }
        discoveredLenses = found

        let priority = needsInspection.filter { claimedPaths.contains($0.path) }
        await inspectRenderers(priority)
        let background = needsInspection.filter { !claimedPaths.contains($0.path) }
        if !background.isEmpty {
            Task { await inspectRenderers(background) }
        }
    }

    private func inspectRenderers(_ candidates: [FsEntry]) async {
        for batchStart in stride(from: 0, to: candidates.count, by: 4) {
            let batch = Array(candidates[batchStart..<min(batchStart + 4, candidates.count)])
            await withTaskGroup(of: (String, FsFile?, String?).self) { group in
                for entry in batch {
                    if let cached = cachedFiles[entry.path], cached.version == entry.version {
                        if let lens = inferNativeLens(path: entry.path, data: cached.data) { discoveredLenses[entry.path] = lens }
                        continue
                    }
                    group.addTask {
                        do {
                            let value = try await app.socket.request(resource: "fs.read", params: ["channel_id": channelId, "path": entry.path])
                            let file = try value.decode(as: FsFile.self)
                            return (entry.path, file, inferNativeLens(path: entry.path, data: file.data))
                        } catch { return (entry.path, nil, nil) }
                    }
                }
                for await (path, file, lens) in group {
                    if let file { cachedFiles[path] = file }
                    if let lens { discoveredLenses[path] = lens }
                }
            }
        }
    }

    private func restoreActiveScene() {
        let stored = UserDefaults.standard.string(forKey: "workbench.activeScene.\(channelId)")
        if let stored, sceneIds.contains(stored) { activeScene = stored }
        else { activeScene = sceneIds.first ?? "" }
        normalizeSelection()
    }

    private func scheduleSignalRefresh() {
        guard pendingSignal == nil else { return }
        pendingSignal = Task {
            try? await Task.sleep(for: .milliseconds(500))
            pendingSignal = nil
            guard !Task.isCancelled else { return }
            await load(showSpinner: false)
        }
    }

    private func apply(_ manifest: WorkbenchTemplateManifest) async {
        isApplyingTemplate = true
        defer { isApplyingTemplate = false }
        do {
            for (path, value) in manifest.seed ?? [:] {
                let content: String
                if let text = value.stringValue { content = text }
                else { content = String(decoding: try JSONEncoder.workbench.encode(value), as: UTF8.self) }
                do {
                    _ = try await app.socket.request(resource: "fs.write", params: ["channel_id": channelId, "path": path, "content": content, "if_version": 0])
                } catch ResourceError.server(let code, _) where code == "VERSION_CONFLICT" {}
            }
            try await updateConfiguration { next in
                var nextBindings = next["bindings"]?.objectValue ?? [:]
                var nextConfigs = next["configs"]?.objectValue ?? [:]
                for view in manifest.views {
                    if nextBindings[view.file] == nil, view.renderer.hasPrefix("builtin:") {
                        nextBindings[view.file] = .string(view.renderer)
                    }
                    if nextConfigs[view.file] == nil, let value = view.config { nextConfigs[view.file] = value }
                }
                var state = WorkbenchSceneState(next["scene_state"])
                state.order.removeAll { $0 == manifest.id }
                state.order.append(manifest.id)
                state.titles[manifest.id] = manifest.title
                state.items[manifest.id] = manifest.views.map(\.file)
                let pins = Set((next["pinned"]?.arrayValue?.compactMap(\.stringValue) ?? []) + (manifest.pin ?? []))
                next["environment"] = .string(manifest.id)
                next["bindings"] = .object(nextBindings)
                next["configs"] = .object(nextConfigs)
                next["pinned"] = .array(pins.sorted().map(JSONValue.string))
                next["scene_state"] = state.jsonValue
            }
            showSceneManager = false
            await load(showSpinner: false)
            activeScene = manifest.id
        } catch {
            errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func removeScenes(at offsets: IndexSet) async {
        let ids = offsets.compactMap { sceneState.order.indices.contains($0) ? sceneState.order[$0] : nil }
        do {
            try await updateConfiguration { next in
                var state = WorkbenchSceneState(next["scene_state"])
                for id in ids { state.order.removeAll { $0 == id }; state.titles[id] = nil; state.items[id] = nil }
                next["scene_state"] = state.jsonValue
            }
            await load(showSpinner: false)
        } catch { errorText = error.localizedDescription }
    }

    private func moveScenes(from source: IndexSet, to destination: Int) async {
        var order = sceneState.order
        order.move(fromOffsets: source, toOffset: destination)
        do {
            try await updateConfiguration { next in
                var state = WorkbenchSceneState(next["scene_state"])
                state.order = order
                next["scene_state"] = state.jsonValue
            }
            sceneState.order = order
        } catch { errorText = error.localizedDescription }
    }

    private func updateConfiguration(_ mutate: (inout [String: JSONValue]) -> Void) async throws {
        for attempt in 0..<2 {
            var latest: [String: JSONValue] = [:]
            var version = 0
            if let raw = try? await app.socket.request(resource: "fs.read", params: ["channel_id": channelId, "path": ".workbench.json"]),
               let file = try? raw.decode(as: FsFile.self) {
                latest = (try? JSONDecoder().decode([String: JSONValue].self, from: Data(file.content.utf8))) ?? [:]
                version = file.version
            }
            mutate(&latest)
            latest["_doc"] = .string("Workbench config. scene_state indexes enabled native scenes and their file items; bindings choose renderers; pinned files are injected into agent prompts.")
            let text = String(decoding: try JSONEncoder.workbench.encode(latest), as: UTF8.self)
            do {
                _ = try await app.socket.request(resource: "fs.write", params: ["channel_id": channelId, "path": ".workbench.json", "content": text, "if_version": version])
                config = latest
                sceneState = WorkbenchSceneState(latest["scene_state"])
                return
            } catch ResourceError.server(let code, _) where code == "VERSION_CONFLICT" && attempt == 0 {
                continue
            }
        }
        throw ResourceError.server(code: "VERSION_CONFLICT", message: "Workbench configuration changed again; please retry.")
    }
}

func workbenchOtherPaths(discovered: [String: String], claimed: Set<String>, existing: Set<String>) -> [String] {
    discovered.keys
        .filter { !claimed.contains($0) && existing.contains($0) && $0 != ".workbench.json" }
        .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
}

func inferNativeLens(path: String, data: JSONValue?) -> String? {
    let ext = path.split(separator: ".").last.map(String.init)?.lowercased()
    if ext == "md" || ext == "markdown" { return "markdown" }
    guard let data else { return nil }
    if data["codemap"]?.numberValue == 1,
       data["nodes"]?.objectValue != nil || data["nodes"]?.arrayValue?.isEmpty == true { return "codemap" }
    if data["series"]?.arrayValue != nil { return "chart" }
    if let columns = data["columns"]?.arrayValue,
       columns.allSatisfy({ $0.objectValue != nil && $0["items"]?.arrayValue != nil }) { return "kanban" }
    if let rows = data.arrayValue, !rows.isEmpty, rows.allSatisfy({ $0.objectValue != nil }) { return "table" }
    return nil
}

/// Workbench — the channel's file workspace with native, inert renderers.
///
/// The web workbench is file-centric: browse the tree, open a file, and it renders
/// through a bound *renderer* (a built-in lens or a sandboxed HTML plugin), falling
/// back to "Raw" when nothing is bound. iOS never executes HTML plugin bundles;
/// Markdown, table, kanban, chart and codemap are rendered with native SwiftUI views.
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
private struct LegacyWorkbenchSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channelId: String

    private enum Route: Hashable {
        case folder(String)
        case file(String)
    }

    @State private var path: [Route] = []
    @State private var root: [TreeNode] = []
    @State private var errorText: String?
    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var templates: [WorkbenchTemplateRow] = []
    @State private var isApplyingTemplate = false
    @State private var lensBindings: [String: String] = [:]

    var body: some View {
        NavigationStack(path: $path) {
            browser(nodes: root, title: "Workbench", folderPath: "")
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .folder(let folderPath):
                        if let folder = find(folderPath, in: root) {
                            browser(nodes: folder.children, title: folder.name, folderPath: folderPath)
                        } else {
                            ContentUnavailableView(
                                "Folder unavailable",
                                systemImage: "folder.badge.questionmark",
                                description: Text("The folder may have been moved or deleted.")
                            )
                        }
                    case .file(let filePath):
                        if let file = find(filePath, in: root) {
                            FileContentView(
                                channelId: channelId,
                                node: file,
                                preferredLens: lensBindings[file.path]
                            )
                        } else {
                            ContentUnavailableView(
                                "File unavailable",
                                systemImage: "doc.badge.ellipsis",
                                description: Text("The file may have been moved or deleted.")
                            )
                        }
                    }
                }
        }
        .task {
            async let files: Void = load()
            async let templateList: Void = loadTemplates()
            _ = await (files, templateList)
        }
    }

    @ViewBuilder
    private func browser(nodes: [TreeNode], title: String, folderPath: String) -> some View {
        Group {
            if isLoading && root.isEmpty {
                ProgressView("Loading files…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorText, root.isEmpty {
                ContentUnavailableView {
                    Label("Couldn’t load files", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorText)
                } actions: {
                    Button("Retry") { Task { await load() } }
                }
            } else if nodes.isEmpty {
                ContentUnavailableView(
                    "No files",
                    systemImage: "folder",
                    description: Text("Files created in this channel will appear here.")
                )
            } else {
                List(nodes) { node in
                    NavigationLink(value: node.isDir ? Route.folder(node.path) : Route.file(node.path)) {
                        row(node)
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { await load(showSpinner: false) }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if folderPath.isEmpty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Menu {
                        if templates.isEmpty {
                            Text("No templates installed")
                        } else {
                            ForEach(templates) { template in
                                Button(template.title) { Task { await apply(template.manifest) } }
                            }
                        }
                    } label: {
                        if isApplyingTemplate { ProgressView() }
                        else { Label("Templates", systemImage: "square.grid.2x2") }
                    }
                    .disabled(isApplyingTemplate)

                    Button { Task { await load(showSpinner: false) } } label: {
                        if isRefreshing { ProgressView() }
                        else { Label("Refresh", systemImage: "arrow.clockwise") }
                    }
                    .disabled(isRefreshing || isLoading)
                }
            }
        }
    }

    private func row(_ node: TreeNode) -> some View {
        CheersFileTreeItem(row: CheersItemRow(
            title: node.name,
            subtitle: node.isDir ? "\(node.children.count) items" : nil,
            explicitLevel: .minimal,
            leading: AnyView(Image(systemName: node.isDir ? "folder.fill" : icon(for: node.name))
                .font(.subheadline)
                .foregroundStyle(node.isDir ? Color.accentColor : Color.secondary)
                .frame(width: 22)),
            trailing: AnyView(Group {
                if node.isDir {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                } else {
                    Text(size(node.sizeBytes)).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            })
        ))
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
            normalizeNavigationPath()
            errorText = nil
        } catch {
            errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    /// Keep the deepest still-valid destination after a refresh. If an agent moved
    /// or deleted the open item, SwiftUI pops back to its nearest valid parent.
    private func normalizeNavigationPath() {
        guard let invalidIndex = path.firstIndex(where: { route in
            switch route {
            case .folder(let routePath):
                guard let node = find(routePath, in: root) else { return true }
                return !node.isDir
            case .file(let routePath):
                guard let node = find(routePath, in: root) else { return true }
                return node.isDir
            }
        }) else { return }
        path.removeSubrange(invalidIndex...)
    }

    private func loadTemplates() async {
        guard let api = app.api else { return }
        templates = (try? await api.listWorkbenchTemplates()) ?? []
    }

    private func apply(_ manifest: WorkbenchTemplateManifest) async {
        isApplyingTemplate = true
        defer { isApplyingTemplate = false }
        do {
            for (path, value) in manifest.seed ?? [:] {
                let content: String
                if case .string(let text) = value { content = text }
                else { content = String(decoding: try JSONEncoder.workbench.encode(value), as: UTF8.self) }
                do {
                    _ = try await app.socket.request(resource: "fs.write", params: [
                        "channel_id": channelId, "path": path, "content": content, "if_version": 0,
                    ])
                } catch ResourceError.server(let code, _) where code == "VERSION_CONFLICT" {
                    // Reapplying a template fills gaps without replacing user or bot data.
                }
            }

            var config: [String: JSONValue] = [:]
            var version = 0
            if let raw = try? await app.socket.request(
                resource: "fs.read", params: ["channel_id": channelId, "path": ".workbench.json"]
            ), let file = try? raw.decode(as: FsFile.self),
               let data = file.content.data(using: .utf8),
               let decoded = try? JSONDecoder().decode([String: JSONValue].self, from: data) {
                config = decoded
                version = file.version
            }
            var bindings = config["bindings"]?.objectValue ?? [:]
            var configs = config["configs"]?.objectValue ?? [:]
            for view in manifest.views {
                if bindings[view.file] == nil, view.renderer.hasPrefix("builtin:") {
                    bindings[view.file] = .string(view.renderer)
                }
                if configs[view.file] == nil, let viewConfig = view.config { configs[view.file] = viewConfig }
                lensBindings[view.file] = view.lens
            }
            let existingPins = config["pinned"]?.arrayValue?.compactMap(\.stringValue) ?? []
            config["environment"] = .string(manifest.id)
            config["bindings"] = .object(bindings)
            config["configs"] = .object(configs)
            config["pinned"] = .array(Array(Set(existingPins + (manifest.pin ?? []))).sorted().map(JSONValue.string))
            let configText = String(decoding: try JSONEncoder.workbench.encode(config), as: UTF8.self)
            _ = try await app.socket.request(resource: "fs.write", params: [
                "channel_id": channelId, "path": ".workbench.json",
                "content": configText, "if_version": version,
            ])
            await load(showSpinner: false)
            if let first = manifest.views.first, let node = find(first.file, in: root) {
                var accumulated = ""
                path = first.file.split(separator: "/").dropLast().map { segment in
                    accumulated = accumulated.isEmpty ? String(segment) : "\(accumulated)/\(segment)"
                    return Route.folder(accumulated)
                }
                path.append(.file(node.path))
            }
            errorText = nil
        } catch {
            errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func find(_ path: String, in nodes: [TreeNode]) -> TreeNode? {
        for node in nodes {
            if node.path == path { return node }
            if let result = find(path, in: node.children) { return result }
        }
        return nil
    }
}

private extension JSONEncoder {
    static var workbench: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
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

// MARK: - Raw file tree and editor

private struct WorkbenchRawBrowser: View {
    @Environment(\.dismiss) private var dismiss
    let channelId: String
    let root: [TreeNode]
    let onChanged: () -> Void

    private enum Route: Hashable { case folder(String); case file(String) }
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            fileList(root, title: "Raw files")
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .folder(let value):
                        if let folder = find(value, in: root) { fileList(folder.children, title: folder.name) }
                        else { ContentUnavailableView("Folder unavailable", systemImage: "folder.badge.questionmark") }
                    case .file(let value):
                        RawFileEditor(channelId: channelId, path: value, onSaved: onChanged)
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                }
        }
    }

    private func fileList(_ nodes: [TreeNode], title: String) -> some View {
        List(nodes) { node in
            NavigationLink(value: node.isDir ? Route.folder(node.path) : Route.file(node.path)) {
                HStack(spacing: 10) {
                    Image(systemName: node.isDir ? "folder.fill" : "doc.text")
                        .foregroundStyle(node.isDir ? Color.accentColor : .secondary)
                        .frame(width: 24, height: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(node.name).lineLimit(1).truncationMode(.middle)
                        if !node.isDir { Text(node.path).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
                    }
                    Spacer()
                    if node.isDir { Text("\(node.children.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                }
                .contentShape(Rectangle())
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func find(_ value: String, in nodes: [TreeNode]) -> TreeNode? {
        for node in nodes {
            if node.path == value { return node }
            if let match = find(value, in: node.children) { return match }
        }
        return nil
    }
}

private struct RawFileEditor: View {
    @Environment(AppModel.self) private var app
    let channelId: String
    let path: String
    let onSaved: () -> Void

    @State private var content = ""
    @State private var original = ""
    @State private var version = 0
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var status: String?
    @State private var showConflict = false

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading…")
            } else {
                VStack(spacing: 0) {
                    if let status {
                        Text(status)
                            .font(.caption)
                            .foregroundStyle(showConflict ? Color.orange : .secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Theme.bgRaised)
                    }
                    TextEditor(text: $content)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(8)
                        .accessibilityLabel("Raw file contents")
                }
            }
        }
        .navigationTitle(path.split(separator: "/").last.map(String.init) ?? path)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await save() } } label: {
                    if isSaving { ProgressView() } else { Label("Save", systemImage: "checkmark") }
                }
                .disabled(isLoading || isSaving || content == original)
            }
        }
        .confirmationDialog("This file changed while you were editing", isPresented: $showConflict, titleVisibility: .visible) {
            Button("Reload latest version", role: .destructive) { Task { await load() } }
            Button("Keep my draft") { status = "Draft kept. Review it, then save again after reloading the latest version." }
        } message: {
            Text("Your draft was not overwritten. Reload to see the latest agent changes, then reapply your edit.")
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let raw = try await app.socket.request(resource: "fs.read", params: ["channel_id": channelId, "path": path])
            let file = try raw.decode(as: FsFile.self)
            content = file.content
            original = file.content
            version = file.version
            status = "Version \(version)"
            showConflict = false
        } catch { status = (error as? ResourceError)?.errorDescription ?? error.localizedDescription }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let raw = try await app.socket.request(resource: "fs.write", params: [
                "channel_id": channelId, "path": path, "content": content, "if_version": version,
            ])
            let response = try raw.decode(as: FsWriteResponse.self)
            version = response.version
            original = content
            status = "Saved · version \(version)"
            onSaved()
        } catch ResourceError.server(let code, _) where code == "VERSION_CONFLICT" {
            status = "Conflict — your draft is still here"
            showConflict = true
        } catch { status = (error as? ResourceError)?.errorDescription ?? error.localizedDescription }
    }
}

// MARK: - File contents and native renderers

private struct FileContentView: View {
    @Environment(AppModel.self) private var app
    let channelId: String
    let node: TreeNode
    let preferredLens: String?
    var lensConfig: JSONValue? = nil

    @State private var file: FsFile?
    @State private var errorText: String?
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var statusText: String?
    @State private var showConflict = false

    var body: some View {
        Group {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
            } else if let errorText {
                ContentUnavailableView("Couldn’t load file", systemImage: "exclamationmark.triangle", description: Text(errorText))
            } else if let file {
                if file.content.isEmpty {
                    ContentUnavailableView("Empty file", systemImage: "doc")
                } else {
                    VStack(spacing: 0) {
                        if let statusText {
                            Text(statusText)
                                .font(.caption)
                                .foregroundStyle(showConflict ? Color.orange : .secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(Theme.bgRaised)
                        }
                        renderer(file, lens: activeLens(file))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .navigationTitle(node.name)
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if isSaving { ProgressView().padding(12).background(.regularMaterial, in: Capsule()) } }
        .confirmationDialog("This item changed while you were editing", isPresented: $showConflict, titleVisibility: .visible) {
            Button("Reload latest version", role: .destructive) { Task { await load() } }
            Button("Cancel") {}
        } message: {
            Text("The agent or another user saved a newer version. Your edit was not applied.")
        }
        .task(id: node.path) { await load() }
    }

    @ViewBuilder
    private func renderer(_ file: FsFile, lens: String) -> some View {
        switch lens {
        case "markdown": MarkdownWorkbenchEditor(content: file.content) { next in await writeText(next) }
        case "table": TableWorkbenchEditor(data: file.data, config: lensConfig) { ops in await patch(ops) }
        case "kanban": KanbanWorkbenchEditor(data: file.data) { ops in await patch(ops) }
        case "chart": ChartWorkbenchEditor(data: file.data) { ops in await patch(ops) }
        case "codemap": CodemapWorkbenchEditor(data: file.data) { ops in await patch(ops) }
        default: RawRenderer(content: file.content)
        }
    }

    private func activeLens(_ file: FsFile) -> String {
        preferredLens ?? inferNativeLens(path: node.path, data: file.data) ?? "raw"
    }

    private func load() async {
        isLoading = true
        do {
            let raw = try await app.socket.request(
                resource: "fs.read", params: ["channel_id": channelId, "path": node.path])
            file = try raw.decode(as: FsFile.self)
            errorText = nil
        } catch {
            errorText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    private func patch(_ ops: [[String: Any]]) async -> Bool {
        guard let version = file?.version else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await app.socket.request(resource: "fs.patch", params: [
                "channel_id": channelId, "path": node.path, "if_version": version, "ops": ops,
            ])
            statusText = "Saved"
            await load()
            return true
        } catch ResourceError.server(let code, _) where code == "VERSION_CONFLICT" {
            statusText = "Conflict — reload and reapply your change"
            showConflict = true
        } catch { statusText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription }
        return false
    }

    private func writeText(_ next: String) async -> Bool {
        guard let version = file?.version else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await app.socket.request(resource: "fs.write", params: [
                "channel_id": channelId, "path": node.path, "content": next, "if_version": version,
            ])
            statusText = "Saved"
            await load()
            return true
        } catch ResourceError.server(let code, _) where code == "VERSION_CONFLICT" {
            statusText = "Conflict — reload and reapply your change"
            showConflict = true
        } catch { statusText = (error as? ResourceError)?.errorDescription ?? error.localizedDescription }
        return false
    }
}

private typealias WorkbenchPatchHandler = ([[String: Any]]) async -> Bool

private func patchValue(_ value: JSONValue) -> Any {
    switch value {
    case .null: return NSNull()
    case .bool(let value): return value
    case .number(let value): return value
    case .string(let value): return value
    case .array(let values): return values.map(patchValue)
    case .object(let values): return values.mapValues(patchValue)
    }
}

private func editedValue(_ text: String, matching original: JSONValue?) -> Any {
    switch original {
    case .bool: return ["true", "yes", "1"].contains(text.lowercased())
    case .number: return Double(text) ?? 0
    case .null: return text
    default: return text
    }
}

private struct MarkdownWorkbenchEditor: View {
    let content: String
    let onSave: (String) async -> Bool
    @State private var draft: String
    @State private var isEditing = false

    init(content: String, onSave: @escaping (String) async -> Bool) {
        self.content = content
        self.onSave = onSave
        _draft = State(initialValue: content)
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Markdown mode", selection: $isEditing) {
                Text("Preview").tag(false)
                Text("Edit").tag(true)
            }
            .pickerStyle(.segmented)
            .padding(12)
            if isEditing {
                TextEditor(text: $draft)
                    .font(.body.monospaced())
                    .autocorrectionDisabled()
                    .padding(.horizontal, 8)
                HStack {
                    Button("Discard") { draft = content; isEditing = false }
                    Spacer()
                    Button("Save") { Task { if await onSave(draft) { isEditing = false } } }
                        .buttonStyle(.borderedProminent)
                        .disabled(draft == content)
                }
                .padding(12)
            } else {
                MarkdownRenderer(content: content)
            }
        }
    }
}

private struct TableWorkbenchEditor: View {
    let data: JSONValue?
    let config: JSONValue?
    let onPatch: WorkbenchPatchHandler

    private var rows: [[String: JSONValue]] { data?.arrayValue?.compactMap(\.objectValue) ?? [] }
    private var configuredColumns: [[String: JSONValue]] { config?["columns"]?.arrayValue?.compactMap(\.objectValue) ?? [] }
    private var columns: [String] {
        let configured = configuredColumns.compactMap { $0["key"]?.stringValue }
        return configured + Array(Set(rows.flatMap(\.keys)).subtracting(configured)).sorted()
    }
    private var labels: [String: String] {
        Dictionary(uniqueKeysWithValues: configuredColumns.compactMap { column in
            guard let key = column["key"]?.stringValue else { return nil }
            return (key, column["label"]?.stringValue ?? key)
        })
    }
    private var options: [String: [String]] {
        Dictionary(uniqueKeysWithValues: configuredColumns.compactMap { column in
            guard let key = column["key"]?.stringValue,
                  let values = column["options"]?.arrayValue?.compactMap(\.stringValue), !values.isEmpty else { return nil }
            return (key, values)
        })
    }

    var body: some View {
        List {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                NavigationLink {
                    TableRowEditor(title: "Row \(index + 1)", row: row, columns: columns, labels: labels, options: options) { updates in
                        let ops = updates.map { key, value in ["op": "set", "path": [index, key], "value": value] as [String: Any] }
                        return await onPatch(ops)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(row.values.compactMap(\.stringValue).first ?? "Row \(index + 1)").font(.headline)
                        Text(columns.prefix(3).map { "\($0): \(display(row[$0]))" }.joined(separator: "  ·  "))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { Task { _ = await onPatch([["op": "remove", "path": [index]]]) } } label: { Label("Delete", systemImage: "trash") }
                    Button { Task { _ = await onPatch([["op": "insert", "path": [], "index": index + 1, "value": row.mapValues(patchValue)]]) } } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                }
            }
            .onMove { source, destination in
                guard let from = source.first else { return }
                let to = max(0, min(rows.count - 1, destination > from ? destination - 1 : destination))
                Task { _ = await onPatch([["op": "move", "path": [], "from": from, "to": to]]) }
            }
        }
        .overlay {
            if rows.isEmpty { ContentUnavailableView("No rows", systemImage: "tablecells", description: Text("Add the first row to start this table.")) }
        }
        .safeAreaInset(edge: .bottom) {
            Button { Task { _ = await onPatch([["op": "insert", "path": [], "index": rows.count, "value": Dictionary(uniqueKeysWithValues: columns.map { ($0, "") })]]) } } label: {
                Label("Add row", systemImage: "plus").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent).padding(12).background(.bar)
        }
    }
}

private struct TableRowEditor: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let row: [String: JSONValue]
    let columns: [String]
    let labels: [String: String]
    let options: [String: [String]]
    let onSave: ([String: Any]) async -> Bool
    @State private var values: [String: String]

    init(title: String, row: [String: JSONValue], columns: [String], labels: [String: String], options: [String: [String]], onSave: @escaping ([String: Any]) async -> Bool) {
        self.title = title; self.row = row; self.columns = columns; self.labels = labels; self.options = options; self.onSave = onSave
        _values = State(initialValue: Dictionary(uniqueKeysWithValues: columns.map { ($0, display(row[$0])) }))
    }

    var body: some View {
        Form {
            ForEach(columns, id: \.self) { column in
                if let choices = options[column] {
                    Picker(labels[column] ?? column, selection: Binding(get: { values[column] ?? choices.first ?? "" }, set: { values[column] = $0 })) {
                        ForEach(choices, id: \.self) { Text($0).tag($0) }
                    }
                } else {
                    TextField(labels[column] ?? column, text: Binding(get: { values[column] ?? "" }, set: { values[column] = $0 }), axis: .vertical)
                        .textInputAutocapitalization(.never)
                }
            }
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Save") {
                    Task {
                        let updates = Dictionary(uniqueKeysWithValues: columns.map { ($0, editedValue(values[$0] ?? "", matching: row[$0])) })
                        if await onSave(updates) { dismiss() }
                    }
                }
            }
        }
    }
}

private struct KanbanWorkbenchEditor: View {
    let data: JSONValue?
    let onPatch: WorkbenchPatchHandler
    private var columns: [[String: JSONValue]] { data?["columns"]?.arrayValue?.compactMap(\.objectValue) ?? [] }

    var body: some View {
        List {
            ForEach(Array(columns.enumerated()), id: \.offset) { columnIndex, column in
                Section {
                    let items = column["items"]?.arrayValue ?? []
                    NavigationLink {
                        WorkbenchNameEditor(title: "Column name", value: column["name"]?.stringValue ?? column["title"]?.stringValue ?? "Column") { name in
                            await onPatch([["op": "set", "path": ["columns", columnIndex, "name"], "value": name]])
                        }
                    } label: {
                        Label("Rename column", systemImage: "pencil").frame(minHeight: 44)
                    }
                    ForEach(Array(items.enumerated()), id: \.offset) { itemIndex, item in
                        NavigationLink {
                            KanbanCardEditor(value: item) { next in
                                await onPatch([["op": "set", "path": ["columns", columnIndex, "items", itemIndex], "value": next]])
                            }
                        } label: {
                            Text(item.firstString("title", "name", "text") ?? display(item)).frame(minHeight: 44, alignment: .leading)
                        }
                        .swipeActions {
                            Button(role: .destructive) { Task { _ = await onPatch([["op": "remove", "path": ["columns", columnIndex, "items", itemIndex]]]) } } label: { Label("Delete", systemImage: "trash") }
                        }
                        .contextMenu {
                            ForEach(Array(columns.enumerated()), id: \.offset) { targetIndex, target in
                                if targetIndex != columnIndex {
                                    Button("Move to \(target["name"]?.stringValue ?? "Column")") {
                                        Task {
                                            _ = await onPatch([
                                                ["op": "remove", "path": ["columns", columnIndex, "items", itemIndex]],
                                                ["op": "insert", "path": ["columns", targetIndex, "items"], "index": target["items"]?.arrayValue?.count ?? 0, "value": patchValue(item)],
                                            ])
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .onMove { source, destination in
                        guard let from = source.first else { return }
                        let to = max(0, min(items.count - 1, destination > from ? destination - 1 : destination))
                        Task { _ = await onPatch([["op": "move", "path": ["columns", columnIndex, "items"], "from": from, "to": to]]) }
                    }
                    Button { Task { _ = await onPatch([["op": "insert", "path": ["columns", columnIndex, "items"], "index": items.count, "value": "New card"]]) } } label: {
                        Label("Add card", systemImage: "plus").frame(minHeight: 44)
                    }
                } header: {
                    Text(column["name"]?.stringValue ?? column["title"]?.stringValue ?? "Column")
                }
            }
            .onDelete { offsets in
                guard let index = offsets.first else { return }
                Task { _ = await onPatch([["op": "remove", "path": ["columns", index]]]) }
            }
            .onMove { source, destination in
                guard let from = source.first else { return }
                let to = max(0, min(columns.count - 1, destination > from ? destination - 1 : destination))
                Task { _ = await onPatch([["op": "move", "path": ["columns"], "from": from, "to": to]]) }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button { Task { _ = await onPatch([["op": "insert", "path": ["columns"], "index": columns.count, "value": ["name": "New column", "items": []]]]) } } label: {
                Label("Add column", systemImage: "plus").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent).padding(12).background(.bar)
        }
    }
}

private struct KanbanCardEditor: View {
    @Environment(\.dismiss) private var dismiss
    let value: JSONValue
    let onSave: (Any) async -> Bool
    @State private var text: String

    init(value: JSONValue, onSave: @escaping (Any) async -> Bool) {
        self.value = value; self.onSave = onSave
        _text = State(initialValue: value.firstString("title", "name", "text") ?? display(value))
    }

    var body: some View {
        Form { TextField("Card", text: $text, axis: .vertical) }
            .navigationTitle("Card")
            .toolbar { ToolbarItem(placement: .primaryAction) { Button("Save") { Task { if await onSave(text) { dismiss() } } } } }
    }
}

private struct ChartWorkbenchEditor: View {
    let data: JSONValue?
    let onPatch: WorkbenchPatchHandler
    private var series: [[String: JSONValue]] { data?["series"]?.arrayValue?.compactMap(\.objectValue) ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            NativeChartRenderer(content: data.flatMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) } ?? "")
                .frame(minHeight: 220)
            List {
                ForEach(Array(series.enumerated()), id: \.offset) { seriesIndex, item in
                    Section(item["name"]?.stringValue ?? "Series \(seriesIndex + 1)") {
                        let points = item["points"]?.arrayValue ?? []
                        NavigationLink {
                            WorkbenchNameEditor(title: "Series name", value: item["name"]?.stringValue ?? "Series \(seriesIndex + 1)") { name in
                                await onPatch([["op": "set", "path": ["series", seriesIndex, "name"], "value": name]])
                            }
                        } label: {
                            Label("Rename series", systemImage: "pencil").frame(minHeight: 44)
                        }
                        ForEach(Array(points.enumerated()), id: \.offset) { pointIndex, point in
                            NavigationLink {
                                ChartPointEditor(point: point) { x, y in
                                    await onPatch([["op": "set", "path": ["series", seriesIndex, "points", pointIndex], "value": [x, y]]])
                                }
                            } label: { Text(display(point)).font(.body.monospacedDigit()).frame(minHeight: 44) }
                            .swipeActions { Button(role: .destructive) { Task { _ = await onPatch([["op": "remove", "path": ["series", seriesIndex, "points", pointIndex]]]) } } label: { Label("Delete", systemImage: "trash") } }
                        }
                        Button { Task { _ = await onPatch([["op": "insert", "path": ["series", seriesIndex, "points"], "index": points.count, "value": [Double(points.count), 0.0]]]) } } label: { Label("Add point", systemImage: "plus") }
                    }
                }
                .onDelete { offsets in
                    guard let index = offsets.first else { return }
                    Task { _ = await onPatch([["op": "remove", "path": ["series", index]]]) }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button { Task { _ = await onPatch([["op": "insert", "path": ["series"], "index": series.count, "value": ["name": "Series \(series.count + 1)", "points": []]]]) } } label: {
                Label("Add series", systemImage: "plus").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent).padding(12).background(.bar)
        }
    }
}

struct CodemapNode: Identifiable, Equatable {
    let id: String
    let kind: String
    let label: String
    let location: String?
    let summary: String
    let status: String
}

struct CodemapEdge: Equatable {
    let from: String
    let to: String
    let kind: String
    let label: String?
}

struct CodemapDocument: Equatable {
    let repository: String?
    let updated: String?
    let focus: Set<String>
    let nodes: [CodemapNode]
    let edges: [CodemapEdge]
}

func parseCodemap(_ data: JSONValue?) -> CodemapDocument? {
    guard data?["codemap"]?.numberValue == 1 else { return nil }
    let nodeObjects = data?["nodes"]?.objectValue ?? [:]
    let nodes = nodeObjects.map { id, value in
        CodemapNode(
            id: id,
            kind: value["kind"]?.stringValue ?? "module",
            label: value["label"]?.stringValue ?? id.split(separator: ".").last.map(String.init) ?? id,
            location: value["loc"]?.stringValue,
            summary: value["summary"]?.stringValue ?? "",
            status: value["status"]?.stringValue ?? "partial"
        )
    }.sorted { lhs, rhs in
        let lhsDepth = lhs.id.split(separator: ".").count
        let rhsDepth = rhs.id.split(separator: ".").count
        return lhsDepth == rhsDepth ? lhs.id.localizedCaseInsensitiveCompare(rhs.id) == .orderedAscending : lhsDepth < rhsDepth
    }
    let edges = data?["edges"]?.arrayValue?.compactMap { value -> CodemapEdge? in
        guard let from = value["from"]?.stringValue, let to = value["to"]?.stringValue else { return nil }
        return CodemapEdge(from: from, to: to, kind: value["kind"]?.stringValue ?? "calls", label: value["label"]?.stringValue)
    } ?? []
    return CodemapDocument(
        repository: data?["repo"]?.stringValue,
        updated: data?["updated"]?.stringValue,
        focus: Set(data?["focus"]?.arrayValue?.compactMap(\.stringValue) ?? []),
        nodes: nodes,
        edges: edges
    )
}

private struct CodemapLayout {
    let positions: [String: CGPoint]
    let size: CGSize

    init(nodes: [CodemapNode]) {
        let groups = Dictionary(grouping: nodes) { max(0, $0.id.split(separator: ".").count - 1) }
        var positions: [String: CGPoint] = [:]
        var longestColumn = 1
        for depth in groups.keys.sorted() {
            let column = (groups[depth] ?? []).sorted { $0.id < $1.id }
            longestColumn = max(longestColumn, column.count)
            for (index, node) in column.enumerated() {
                positions[node.id] = CGPoint(x: 86 + CGFloat(depth) * 176, y: 64 + CGFloat(index) * 104)
            }
        }
        self.positions = positions
        let depthCount = max(1, (groups.keys.max() ?? 0) + 1)
        size = CGSize(width: CGFloat(depthCount) * 176 + 40, height: CGFloat(longestColumn) * 104 + 48)
    }
}

private struct CodemapWorkbenchEditor: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let data: JSONValue?
    let onPatch: WorkbenchPatchHandler
    @State private var selectedNode: CodemapNode?
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero

    private var document: CodemapDocument? { parseCodemap(data) }

    var body: some View {
        if let document, !document.nodes.isEmpty {
            VStack(spacing: 0) {
                metadata(document)
                graph(document)
            }
            .sheet(item: $selectedNode) { node in
                NavigationStack {
                    CodemapNodeEditor(node: node) { summary, status in
                        await onPatch([
                            ["op": "set", "path": ["nodes", node.id, "summary"], "value": summary],
                            ["op": "set", "path": ["nodes", node.id, "status"], "value": status],
                        ])
                    }
                }
                .presentationDetents([.medium, .large])
            }
        } else {
            ContentUnavailableView {
                Label("Codemap is empty", systemImage: "point.3.connected.trianglepath.dotted")
            } description: {
                Text("Ask the agent to explore the repository and maintain codemap/map.yaml. New modules will appear here automatically.")
            }
        }
    }

    private func metadata(_ document: CodemapDocument) -> some View {
        HStack(spacing: 8) {
            if let repository = document.repository, !repository.isEmpty {
                Label(repository, systemImage: "shippingbox")
                    .lineLimit(1)
            } else {
                Label("Repository map", systemImage: "shippingbox")
            }
            Spacer()
            Text("\(document.nodes.count) nodes")
                .monospacedDigit()
            if !document.focus.isEmpty {
                Label("\(document.focus.count) focused", systemImage: "scope")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    private func graph(_ document: CodemapDocument) -> some View {
        let layout = CodemapLayout(nodes: document.nodes)
        return GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    Canvas { context, _ in
                        for edge in document.edges {
                            guard let from = layout.positions[edge.from], let to = layout.positions[edge.to] else { continue }
                            var path = Path()
                            path.move(to: CGPoint(x: from.x + 68, y: from.y + 29))
                            path.addCurve(
                                to: CGPoint(x: to.x - 68, y: to.y + 29),
                                control1: CGPoint(x: from.x + 112, y: from.y + 29),
                                control2: CGPoint(x: to.x - 112, y: to.y + 29)
                            )
                            context.stroke(path, with: .color(.secondary.opacity(0.45)), lineWidth: edge.kind == "data" ? 1 : 1.5)
                        }
                    }
                    .frame(width: layout.size.width, height: layout.size.height)

                    ForEach(document.nodes) { node in
                        if let position = layout.positions[node.id] {
                            CodemapNodeButton(node: node, isFocused: document.focus.contains(node.id)) {
                                selectedNode = node
                            }
                            .position(position)
                        }
                    }
                }
                .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
                .scaleEffect(scale, anchor: .topLeading)
                .offset(offset)

                VStack(spacing: 8) {
                    Button { changeZoom(by: 1.2) } label: { Image(systemName: "plus.magnifyingglass").frame(width: 44, height: 44) }
                        .accessibilityLabel("Zoom in")
                    Button { changeZoom(by: 1 / 1.2) } label: { Image(systemName: "minus.magnifyingglass").frame(width: 44, height: 44) }
                        .accessibilityLabel("Zoom out")
                    Button { resetView() } label: { Image(systemName: "arrow.counterclockwise").frame(width: 44, height: 44) }
                        .accessibilityLabel("Reset map position")
                }
                .buttonStyle(.bordered)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .padding(12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
            .contentShape(Rectangle())
            .gesture(panGesture)
            .simultaneousGesture(zoomGesture)
            .accessibilityLabel("Codemap graph with \(document.nodes.count) nodes and \(document.edges.count) edges")
        }
    }

    private var panGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                offset = CGSize(width: settledOffset.width + value.translation.width, height: settledOffset.height + value.translation.height)
            }
            .onEnded { _ in settledOffset = offset }
    }

    private var zoomGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in scale = min(2.4, max(0.55, settledScale * value)) }
            .onEnded { _ in settledScale = scale }
    }

    private func changeZoom(by factor: CGFloat) {
        let update = { scale = min(2.4, max(0.55, scale * factor)); settledScale = scale }
        if reduceMotion { update() } else { withAnimation(.snappy(duration: 0.2), update) }
    }

    private func resetView() {
        let update = { scale = 1; settledScale = 1; offset = .zero; settledOffset = .zero }
        if reduceMotion { update() } else { withAnimation(.snappy(duration: 0.25), update) }
    }
}

private struct CodemapNodeButton: View {
    let node: CodemapNode
    let isFocused: Bool
    let action: () -> Void

    private var statusIcon: String {
        switch node.status { case "explored": return "checkmark.circle.fill"; case "stale": return "exclamationmark.triangle.fill"; default: return "circle.lefthalf.filled" }
    }

    private var statusColor: Color {
        switch node.status { case "explored": return .green; case "stale": return .orange; default: return .blue }
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 5) {
                    Image(systemName: statusIcon).foregroundStyle(statusColor)
                    Text(node.label).font(.caption.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 0)
                }
                Text(node.kind.capitalized)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(10)
            .frame(width: 136, height: 58, alignment: .leading)
            .background(Theme.bgRaised, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isFocused ? Color.accentColor : statusColor.opacity(0.42), lineWidth: isFocused ? 3 : 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(node.label), \(node.kind), \(node.status)")
        .accessibilityHint("Opens module details")
    }
}

private struct CodemapNodeEditor: View {
    @Environment(\.dismiss) private var dismiss
    let node: CodemapNode
    let onSave: (String, String) async -> Bool
    @State private var summary: String
    @State private var status: String
    @State private var isSaving = false

    init(node: CodemapNode, onSave: @escaping (String, String) async -> Bool) {
        self.node = node
        self.onSave = onSave
        _summary = State(initialValue: node.summary)
        _status = State(initialValue: node.status)
    }

    var body: some View {
        Form {
            Section("Node") {
                LabeledContent("ID", value: node.id)
                LabeledContent("Kind", value: node.kind.capitalized)
                if let location = node.location, !location.isEmpty {
                    LabeledContent("Location") { Text(location).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
            Section("Knowledge") {
                Picker("Status", selection: $status) {
                    Text("Explored").tag("explored")
                    Text("Partial").tag("partial")
                    Text("Stale").tag("stale")
                }
                TextField("Summary", text: $summary, axis: .vertical)
                    .lineLimit(3...8)
            }
        }
        .navigationTitle(node.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .primaryAction) {
                Button("Save") {
                    isSaving = true
                    Task {
                        if await onSave(summary.trimmingCharacters(in: .whitespacesAndNewlines), status) { dismiss() }
                        isSaving = false
                    }
                }
                .disabled(isSaving || (summary == node.summary && status == node.status))
            }
        }
        .interactiveDismissDisabled(isSaving)
    }
}

private struct WorkbenchNameEditor: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let onSave: (String) async -> Bool
    @State private var value: String

    init(title: String, value: String, onSave: @escaping (String) async -> Bool) {
        self.title = title
        self.onSave = onSave
        _value = State(initialValue: value)
    }

    var body: some View {
        Form { TextField(title, text: $value).textInputAutocapitalization(.sentences) }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Save") { Task { if await onSave(value.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() } } }
                        .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
    }
}

private struct ChartPointEditor: View {
    @Environment(\.dismiss) private var dismiss
    let onSave: (Double, Double) async -> Bool
    @State private var x: String
    @State private var y: String

    init(point: JSONValue, onSave: @escaping (Double, Double) async -> Bool) {
        self.onSave = onSave
        let values = point.arrayValue ?? []
        _x = State(initialValue: values.first?.numberValue.map { String($0) } ?? "0")
        _y = State(initialValue: values.dropFirst().first?.numberValue.map { String($0) } ?? "0")
    }

    var body: some View {
        Form {
            TextField("X", text: $x).keyboardType(.numbersAndPunctuation)
            TextField("Y", text: $y).keyboardType(.numbersAndPunctuation)
        }
        .navigationTitle("Data point")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Save") { Task { if await onSave(Double(x) ?? 0, Double(y) ?? 0) { dismiss() } } } } }
    }
}

private struct RawRenderer: View {
    let content: String
    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            Text(content)
                .font(.subheadline.monospaced())
                .foregroundStyle(Theme.textBody)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: true)
                .padding(16)
        }
    }
}

/// Presentation-only Markdown. It recognizes structure but deliberately does not
/// create tappable links from untrusted bot-authored content.
private struct MarkdownRenderer: View {
    let content: String
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(Array(content.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                    markdownLine(String(line))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
    }

    @ViewBuilder private func markdownLine(_ line: String) -> some View {
        if line.hasPrefix("### ") { Text(String(line.dropFirst(4))).font(.headline) }
        else if line.hasPrefix("## ") { Text(String(line.dropFirst(3))).font(.title3.bold()) }
        else if line.hasPrefix("# ") { Text(String(line.dropFirst(2))).font(.title2.bold()) }
        else if line.hasPrefix("- [ ] ") { Label(String(line.dropFirst(6)), systemImage: "square") }
        else if line.hasPrefix("- [x] ") || line.hasPrefix("- [X] ") {
            Label(String(line.dropFirst(6)), systemImage: "checkmark.square.fill")
                .foregroundStyle(Theme.textSecondary)
        } else if line.hasPrefix("- ") {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "circle.fill").font(.caption2)
                Text(String(line.dropFirst(2)))
            }
        } else if line.hasPrefix("> ") {
            Text(String(line.dropFirst(2))).italic().foregroundStyle(Theme.textSecondary).padding(.leading, 10)
        } else {
            Text(line.isEmpty ? " " : line).font(.body).textSelection(.enabled)
        }
    }
}

private struct TableRenderer: View {
    let content: String
    private var rows: [[String: JSONValue]] {
        guard let data = content.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
        return value.arrayValue?.compactMap(\.objectValue) ?? []
    }
    private var columns: [String] { Array(Set(rows.flatMap(\.keys))).sorted() }
    var body: some View {
        if rows.isEmpty { ComingSoon(icon: "tablecells", text: "No table rows to display.") }
        else {
            ScrollView([.horizontal, .vertical]) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 9) {
                    GridRow { ForEach(columns, id: \.self) { Text($0).font(.caption.bold()) } }
                    Divider().gridCellUnsizedAxes(.horizontal)
                    ForEach(Array(rows.prefix(200).enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(columns, id: \.self) { Text(display(row[$0])).font(.caption).textSelection(.enabled) }
                        }
                        Divider().gridCellUnsizedAxes(.horizontal)
                    }
                }
                .padding(16)
            }
        }
    }
}

private struct KanbanRenderer: View {
    let content: String
    private var columns: [JSONValue] {
        guard let data = content.data(using: .utf8),
              let root = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
        return root["columns"]?.arrayValue ?? []
    }
    var body: some View {
        if columns.isEmpty { ComingSoon(icon: "rectangle.3.group", text: "No kanban columns to display.") }
        else {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(column.firstString("name", "title") ?? "Column").font(.headline)
                            ForEach(Array((column["items"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, item in
                                Text(item.firstString("title", "name", "text") ?? display(item))
                                    .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(10).background(Theme.bgRaised, in: RoundedRectangle(cornerRadius: 10))
                            }
                        }
                        .padding(12).frame(width: 220, alignment: .topLeading)
                        .background(Theme.bgApp, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                .padding(16)
            }
        }
    }
}

private struct NativeChartRenderer: View {
    let content: String
    private struct Point: Identifiable {
        let id = UUID()
        let series: String
        let x: Double
        let y: Double
    }
    private var points: [Point] {
        guard let data = content.data(using: .utf8),
              let root = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
        return (root["series"]?.arrayValue ?? []).flatMap { series in
            let name = series["name"]?.stringValue ?? "Series"
            return (series["points"]?.arrayValue ?? []).enumerated().compactMap { index, pair -> Point? in
                guard let values = pair.arrayValue, values.count >= 2, let y = values[1].numberValue else { return nil }
                return Point(series: name, x: values[0].numberValue ?? Double(index), y: y)
            }
        }
    }
    var body: some View {
        if points.isEmpty { ComingSoon(icon: "chart.xyaxis.line", text: "No chart series to display.") }
        else {
            Chart(points) { point in
                LineMark(x: .value("X", point.x), y: .value("Y", point.y))
                    .foregroundStyle(by: .value("Series", point.series))
                PointMark(x: .value("X", point.x), y: .value("Y", point.y))
                    .foregroundStyle(by: .value("Series", point.series))
            }
            .chartLegend(position: .bottom)
            .padding(16)
        }
    }
}

private func display(_ value: JSONValue?) -> String {
    guard let value else { return "" }
    switch value {
    case .null: return "—"
    case .bool(let value): return value ? "true" : "false"
    case .number(let value): return value.rounded() == value ? String(Int(value)) : String(value)
    case .string(let value): return value
    case .array, .object:
        guard let data = try? JSONEncoder().encode(value) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - Remote workspace

struct RemoteWorkspaceSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channelId: String
    let onAddContext: (ResourceContextItem) -> Void

    private enum Tab: String, CaseIterable { case files = "Files"; case changes = "Changes" }
    private enum GitMode: String, CaseIterable { case working = "Working"; case history = "History" }
    private enum FileSort: String, CaseIterable { case name = "Name"; case size = "Size"; case kind = "Kind" }
    private enum Route: Hashable {
        case folder(String)
        case file(String)
        case diff(path: String, staged: Bool)
        case commit(String)
        case commitDiff(commit: String, path: String?)
    }
    @State private var tab: Tab = .files
    @State private var gitMode: GitMode = .working
    @State private var fileSort: FileSort = .name
    @State private var fileQuery = ""
    @State private var navigationPath: [Route] = []
    @State private var bots: [RemoteWorkspaceBot] = []
    @State private var botId = ""
    @State private var root: String?
    @State private var currentPath = ""
    @State private var entries: [RemoteWorkspaceEntry] = []
    @State private var file: RemoteWorkspaceFile?
    @State private var git: RemoteGitStatus?
    @State private var gitHistory: [RemoteGitCommit] = []
    @State private var commitFiles: [RemoteGitCommitFile] = []
    @State private var diffText: String?
    @State private var previewURL: URL?
    @State private var previewFiles: [URL] = []
    @State private var draft = ""
    @State private var isEditing = false
    @State private var isInitialLoading = true
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorText: String?
    @State private var showConflict = false

    private var selectedBot: RemoteWorkspaceBot? { bots.first { $0.botId == botId } }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            VStack(spacing: 0) {
                Picker("Workspace view", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).padding(12)
                Group {
                    // Only replace the entire surface during the initial agent lookup.
                    // Page-level loads (History, diffs, files) must keep their owning
                    // view mounted or SwiftUI cancels the `.task` that started them.
                    if isInitialLoading { ProgressView() }
                    else if let errorText, entries.isEmpty { workspaceUnavailable(errorText) }
                    else if tab == .changes { changesView }
                    else { treeView(path: "") }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .navigationTitle("Remote workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if bots.count > 1 {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Picker("Agent", selection: $botId) {
                                ForEach(bots) { bot in
                                    Text(bot.name + (bot.online ? "" : " · offline")).tag(bot.botId)
                                }
                            }
                        } label: {
                            Label(selectedBot?.name ?? "Agent", systemImage: "desktopcomputer")
                        }
                    }
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .folder(let folderPath):
                    treeView(path: folderPath)
                        .navigationTitle(folderPath.split(separator: "/").last.map(String.init) ?? "Folder")
                        .navigationBarTitleDisplayMode(.inline)
                        .task(id: folderPath) { await loadTree(path: folderPath) }
                case .file(let filePath):
                    remoteFileDestination(path: filePath)
                        .task(id: filePath) { await loadFile(path: filePath) }
                case .diff(let path, let staged):
                    diffView(title: path.isEmpty ? nil : path, staged: staged)
                        .task(id: "\(path):\(staged)") { await loadDiff(path: path, staged: staged) }
                case .commit(let commit):
                    commitView(commit: commit)
                        .task(id: commit) { await loadCommitFiles(commit: commit) }
                case .commitDiff(let commit, let path):
                    diffView(title: path ?? String(commit.prefix(8)), staged: false)
                        .task(id: "\(commit):\(path ?? "")") { await loadCommitDiff(commit: commit, path: path) }
                }
            }
        }
        .task { await loadBots() }
        .onChange(of: tab) {
            navigationPath.removeAll()
            if tab == .changes { Task { await loadGit() } }
            else { Task { await loadTree(path: "") } }
        }
        .onChange(of: botId) { resetAndLoad() }
        .confirmationDialog("This file changed on the agent's machine", isPresented: $showConflict) {
            Button("Reload remote version") { Task { await reloadOpenFile() } }
            Button("Overwrite remote version", role: .destructive) { Task { await save(force: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Review the remote version before overwriting whenever possible.")
        }
        .quickLookPreview($previewURL)
        .onDisappear { removePreviewFiles() }
    }

    private func treeView(path: String) -> some View {
        List {
            if let root {
                Section {
                    Label(root, systemImage: "externaldrive").font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            Section(path.isEmpty ? "Root" : path) {
                ForEach(visibleEntries) { entry in
                    NavigationLink(value: entry.isDir ? Route.folder(entry.path) : Route.file(entry.path)) {
                        HStack(spacing: 10) {
                            Image(systemName: fileIcon(entry))
                                .foregroundStyle(entry.isDir ? Color.accentColor : Color.secondary)
                                .frame(width: 24)
                            Text(entry.name).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            if !entry.isDir {
                                Text(ByteCountFormatter.string(fromByteCount: Int64(entry.sizeBytes), countStyle: .file))
                                    .font(.caption2).foregroundStyle(Theme.textFaint)
                            }
                        }
                    }
                    .contextMenu {
                        if !entry.isDir {
                            Button { Task { await previewFile(path: entry.path) } } label: {
                                Label("Quick Look", systemImage: "eye")
                            }
                            Button { Task { await addFileToContext(path: entry.path) } } label: {
                                Label("Add to context", systemImage: "link.badge.plus")
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $fileQuery, prompt: "Search this folder")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Sort by", selection: $fileSort) {
                        ForEach(FileSort.allCases, id: \.self) { value in
                            Text(value.rawValue).tag(value)
                        }
                    }
                } label: {
                    Label("Sort", systemImage: "arrow.up.arrow.down")
                }
            }
        }
        .refreshable { await loadTree(path: path) }
        .onAppear {
            if currentPath != path { Task { await loadTree(path: path) } }
        }
    }

    private var visibleEntries: [RemoteWorkspaceEntry] {
        let filtered = fileQuery.isEmpty ? entries : entries.filter {
            $0.name.localizedCaseInsensitiveContains(fileQuery)
        }
        return filtered.sorted { lhs, rhs in
            if lhs.isDir != rhs.isDir { return lhs.isDir }
            switch fileSort {
            case .name:
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            case .size:
                if lhs.sizeBytes != rhs.sizeBytes { return lhs.sizeBytes < rhs.sizeBytes }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            case .kind:
                let left = lhs.name.split(separator: ".").last.map(String.init) ?? ""
                let right = rhs.name.split(separator: ".").last.map(String.init) ?? ""
                if left != right { return left.localizedCaseInsensitiveCompare(right) == .orderedAscending }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
        }
    }

    private func fileIcon(_ entry: RemoteWorkspaceEntry) -> String {
        if entry.isDir { return "folder.fill" }
        switch entry.name.split(separator: ".").last.map(String.init)?.lowercased() {
        case "png", "jpg", "jpeg", "gif", "heic": return "photo"
        case "mov", "mp4", "m4v": return "film"
        case "mp3", "m4a", "wav": return "waveform"
        case "pdf": return "doc.richtext"
        case "swift", "rs", "js", "ts", "py", "json", "yaml", "yml": return "chevron.left.forwardslash.chevron.right"
        case "md", "txt": return "doc.text"
        default: return "doc"
        }
    }

    @ViewBuilder
    private func remoteFileDestination(path: String) -> some View {
        if isLoading {
            ProgressView("Loading file…")
        } else if let file {
            fileView(file)
                .navigationTitle(file.filename)
                .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("File unavailable", systemImage: "doc.badge.ellipsis")
        }
    }

    @ViewBuilder
    private func fileView(_ opened: RemoteWorkspaceFile) -> some View {
        VStack(spacing: 8) {
            if isEditing {
                TextEditor(text: $draft)
                    .font(.subheadline.monospaced())
                    .padding()
            } else if opened.isText, let content = opened.content {
                RawRenderer(content: content)
            } else {
                ContentUnavailableView(
                    "Binary file", systemImage: "doc",
                    description: Text("Add it to context so an authorized agent can read it on demand.")
                )
            }
            if let errorText { Text(errorText).font(.caption).foregroundStyle(.red).padding(.horizontal) }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { prepareQuickLook(opened) } label: {
                    Label("Quick Look", systemImage: "eye")
                }
                Button { onAddContext(workspaceContext(opened)) } label: {
                    Label("Add to context", systemImage: "link.badge.plus")
                }
                if opened.isText, selectedBot?.canWrite == true {
                    if isEditing {
                        Button("Cancel") { isEditing = false }
                        Button(isSaving ? "Saving…" : "Save") { Task { await save(force: false) } }
                            .disabled(isSaving)
                    } else {
                        Button("Edit") {
                            draft = opened.content ?? ""
                            isEditing = true
                        }
                    }
                }
            }
        }
    }

    private var changesView: some View {
        VStack(spacing: 0) {
            Picker("Git view", selection: $gitMode) {
                ForEach(GitMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.bottom, 8)

            if git?.repo == false {
                ContentUnavailableView("Not a Git repository", systemImage: "arrow.triangle.branch", description: Text(git?.reason ?? "Git is unavailable for this root."))
            } else if let errorText, git == nil || (gitMode == .history && gitHistory.isEmpty) {
                ContentUnavailableView(
                    "Couldn’t load Git data",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorText)
                )
            } else if gitMode == .history {
                historyView
            } else {
                workingChangesView
            }
        }
        .task(id: "\(botId):\(root ?? ""): \(gitMode.rawValue)") {
            if gitMode == .history { await loadGitHistory() }
            else { await loadGit() }
        }
    }

    @ViewBuilder
    private var workingChangesView: some View {
        List {
            Section {
                LabeledContent("Branch", value: git?.branch ?? "(detached)")
                if let upstream = git?.upstream { LabeledContent("Upstream", value: upstream) }
                if (git?.ahead ?? 0) > 0 || (git?.behind ?? 0) > 0 {
                    LabeledContent("Sync", value: "↑\(git?.ahead ?? 0) ↓\(git?.behind ?? 0)")
                }
            }
            if !stagedEntries.isEmpty {
                Section("Staged · \(stagedEntries.count)") {
                    ForEach(stagedEntries) { changeRow($0, staged: true) }
                    NavigationLink("Review all staged changes", value: Route.diff(path: "", staged: true))
                }
            }
            if !unstagedEntries.isEmpty {
                Section("Unstaged · \(unstagedEntries.count)") {
                    ForEach(unstagedEntries) { changeRow($0, staged: false) }
                    NavigationLink("Review all unstaged changes", value: Route.diff(path: "", staged: false))
                }
            }
            if stagedEntries.isEmpty && unstagedEntries.isEmpty {
                Section {
                    ContentUnavailableView("Working tree clean", systemImage: "checkmark.circle")
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await loadGit() }
    }

    private var historyView: some View {
        List(gitHistory) { commit in
            NavigationLink(value: Route.commit(commit.hash)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(commit.subject).font(.body.weight(.medium)).lineLimit(2)
                    HStack {
                        Text(commit.author)
                        Text(String(commit.hash.prefix(8))).font(.caption.monospaced())
                        Spacer()
                        Text(commitDate(commit.date))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 3)
            }
        }
        .listStyle(.plain)
        .refreshable { await loadGitHistory() }
        .overlay {
            if isLoading {
                ProgressView("Loading history…")
            } else if gitHistory.isEmpty {
                ContentUnavailableView("No commits", systemImage: "clock.arrow.circlepath")
            }
        }
    }

    @ViewBuilder
    private func changeRow(_ entry: RemoteGitStatusEntry, staged: Bool) -> some View {
        if entry.xy == "??" {
            NavigationLink(value: Route.file(entry.path)) {
                gitFileLabel(entry, status: "U")
            }
        } else {
            NavigationLink(value: Route.diff(path: entry.path, staged: staged)) {
                gitFileLabel(entry, status: staged ? String(entry.xy.prefix(1)) : String(entry.xy.suffix(1)))
            }
        }
    }

    private func gitFileLabel(_ entry: RemoteGitStatusEntry, status: String) -> some View {
        HStack(spacing: 10) {
            Text(status.trimmingCharacters(in: .whitespaces).isEmpty ? "M" : status)
                .font(.caption.monospaced().weight(.semibold))
                .foregroundStyle(gitStatusColor(status))
                .frame(width: 20)
            Text(entry.path).lineLimit(1).truncationMode(.middle)
        }
    }

    private var stagedEntries: [RemoteGitStatusEntry] {
        (git?.entries ?? []).filter {
            guard $0.xy != "??", let first = $0.xy.first else { return false }
            return first != " " && first != "."
        }
    }

    private var unstagedEntries: [RemoteGitStatusEntry] {
        (git?.entries ?? []).filter {
            if $0.xy == "??" { return true }
            guard $0.xy.count > 1 else { return false }
            let second = $0.xy[$0.xy.index(after: $0.xy.startIndex)]
            return second != " " && second != "."
        }
    }

    private func gitStatusColor(_ status: String) -> Color {
        switch status.trimmingCharacters(in: .whitespaces).first {
        case "A", "?": .green
        case "D": .red
        case "R": .blue
        default: .orange
        }
    }

    @ViewBuilder
    private func diffView(title: String?, staged: Bool) -> some View {
        Group {
            if isLoading {
                ProgressView("Loading diff…")
            } else if let diffText, !diffText.isEmpty {
                GitPatchView(diff: diffText)
            } else if let errorText {
                ContentUnavailableView("Couldn’t load diff", systemImage: "exclamationmark.triangle", description: Text(errorText))
            } else {
                ContentUnavailableView("No changes", systemImage: "checkmark.circle")
            }
        }
        .navigationTitle(title ?? (staged ? "Staged review" : "Changes review"))
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func commitView(commit: String) -> some View {
        if isLoading {
            ProgressView("Loading commit…")
        } else if commitFiles.isEmpty {
            ContentUnavailableView("No changed files", systemImage: "doc")
        } else {
            List {
                Section {
                    NavigationLink("Review full commit", value: Route.commitDiff(commit: commit, path: nil))
                }
                Section("Changed files · \(commitFiles.count)") {
                    ForEach(commitFiles) { item in
                        NavigationLink(value: Route.commitDiff(commit: commit, path: item.path)) {
                            HStack(spacing: 10) {
                                Text(String(item.status.prefix(1)))
                                    .font(.caption.monospaced().weight(.semibold))
                                    .foregroundStyle(gitStatusColor(item.status))
                                    .frame(width: 20)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.path).lineLimit(1).truncationMode(.middle)
                                    if let oldPath = item.oldPath {
                                        Text("from \(oldPath)").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
    }

    private func commitDate(_ raw: String) -> String {
        guard let date = TimeFormat.parse(raw) else { return raw }
        return TimeFormat.listStamp(date)
    }

    private func workspaceUnavailable(_ message: String) -> some View {
        ContentUnavailableView("Workspace unavailable", systemImage: "externaldrive.badge.exclamationmark", description: Text(message))
    }

    private func loadBots() async {
        defer { isInitialLoading = false }
        guard let api = app.api else { isLoading = false; return }
        do {
            bots = try await api.listRemoteWorkspaceBots(channelId: channelId)
            if let first = bots.first(where: { $0.online && $0.canRead }) ?? bots.first(where: \.canRead) {
                botId = first.botId
                await loadTree(path: "")
            } else {
                errorText = "No readable agent workspace is available in this channel."
                isLoading = false
            }
        } catch { fail(error) }
    }

    private func resetAndLoad() {
        root = nil; currentPath = ""; entries = []; file = nil; git = nil
        gitHistory = []; commitFiles = []; diffText = nil; navigationPath = []
        Task { await loadTree(path: "") }
    }

    private func loadTree(path: String) async {
        guard let api = app.api, !botId.isEmpty else { return }
        isLoading = true
        do {
            let tree = try await api.remoteWorkspaceTree(
                channelId: channelId, botId: botId, path: path, root: root
            )
            if currentPath != tree.path { fileQuery = "" }
            root = tree.root; currentPath = tree.path; entries = tree.entries; file = nil; errorText = nil
        } catch { fail(error) }
        isLoading = false
    }

    private func loadFile(path: String) async {
        guard let api = app.api else { return }
        isLoading = true
        do {
            file = try await api.remoteWorkspaceFile(
                channelId: channelId, botId: botId, path: path, root: root
            )
            draft = file?.content ?? ""; isEditing = false; errorText = nil
            if let file { prepareQuickLook(file) }
        } catch { fail(error) }
        isLoading = false
    }

    private func reloadOpenFile() async {
        guard let path = file?.path else { return }
        await loadFile(path: path)
    }

    private func save(force: Bool) async {
        guard let api = app.api, let opened = file, selectedBot?.canWrite == true else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await api.writeRemoteWorkspaceFile(
                channelId: channelId, botId: botId, path: opened.path, root: root,
                content: draft, ifMatch: force ? nil : opened.etag
            )
            await reloadOpenFile(); isEditing = false; await loadGit()
        } catch APIError.http(let status, _) where status == 409 {
            showConflict = true
        } catch { fail(error) }
    }

    private func loadGit() async {
        guard let api = app.api, !botId.isEmpty else { return }
        do {
            git = try await api.remoteGitStatus(
                channelId: channelId, botId: botId, path: currentPath, root: root
            )
            errorText = nil
        } catch { fail(error) }
    }

    private func loadDiff(path: String, staged: Bool) async {
        guard let api = app.api else { return }
        isLoading = true
        diffText = nil
        defer { isLoading = false }
        do {
            let result = try await api.remoteGitDiff(
                channelId: channelId, botId: botId, path: path, staged: staged, root: root
            )
            diffText = result.diff
            errorText = nil
        } catch { fail(error) }
    }

    private func loadGitHistory() async {
        guard let api = app.api, !botId.isEmpty else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            gitHistory = try await api.remoteGitLog(
                channelId: channelId, botId: botId, root: root
            ).commits
            errorText = nil
        } catch { fail(error) }
    }

    private func loadCommitFiles(commit: String) async {
        guard let api = app.api else { return }
        isLoading = true
        commitFiles = []
        defer { isLoading = false }
        do {
            commitFiles = try await api.remoteGitCommitFiles(
                channelId: channelId, botId: botId, commit: commit, root: root
            ).files
            errorText = nil
        } catch { fail(error) }
    }

    private func loadCommitDiff(commit: String, path: String?) async {
        guard let api = app.api else { return }
        isLoading = true
        diffText = nil
        defer { isLoading = false }
        do {
            diffText = try await api.remoteGitShow(
                channelId: channelId, botId: botId, commit: commit, path: path, root: root
            ).diff
            errorText = nil
        } catch { fail(error) }
    }

    private func previewFile(path: String) async {
        guard let api = app.api else { return }
        do {
            let opened = try await api.remoteWorkspaceFile(
                channelId: channelId, botId: botId, path: path, root: root
            )
            prepareQuickLook(opened)
        } catch { fail(error) }
    }

    private func addFileToContext(path: String) async {
        guard let api = app.api else { return }
        do {
            let opened = try await api.remoteWorkspaceFile(
                channelId: channelId, botId: botId, path: path, root: root
            )
            onAddContext(workspaceContext(opened))
        } catch { fail(error) }
    }

    private func prepareQuickLook(_ opened: RemoteWorkspaceFile) {
        guard let data = Data(base64Encoded: opened.contentBase64) else {
            errorText = "This file could not be prepared for preview."
            return
        }
        removePreviewFile()
        let safeName = URL(fileURLWithPath: opened.filename).lastPathComponent
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cheers-preview-\(UUID().uuidString)-\(safeName)")
        do {
            try data.write(to: url, options: .atomic)
            previewFiles.append(url)
            previewURL = url
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func removePreviewFile() {
        guard let previewURL else { return }
        try? FileManager.default.removeItem(at: previewURL)
        previewFiles.removeAll { $0 == previewURL }
        self.previewURL = nil
    }

    private func removePreviewFiles() {
        previewFiles.forEach { try? FileManager.default.removeItem(at: $0) }
        previewFiles.removeAll()
        previewURL = nil
    }

    private func workspaceContext(_ file: RemoteWorkspaceFile) -> ResourceContextItem {
        var params: [String: JSONValue] = ["bot_id": .string(botId), "path": .string(file.path)]
        if let root { params["root"] = .string(root) }
        let owner = selectedBot?.name ?? botId
        return ResourceContextItem(
            id: "ws:\(botId):\(root ?? ""):\(file.path)", verb: "workspace.read",
            params: params, label: "\(file.filename) (@\(owner) workspace)", kind: "file"
        )
    }

    private func fail(_ error: Error) {
        errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        isLoading = false
    }
}

private struct GitPatchView: View {
    private struct Line: Identifiable {
        enum Kind { case addition, deletion, hunk, header, context }
        let id: Int
        let text: String
        let kind: Kind
    }

    let diff: String

    private var lines: [Line] {
        diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated().map { index, raw in
            let text = String(raw)
            let kind: Line.Kind
            if text.hasPrefix("+++") || text.hasPrefix("---") || text.hasPrefix("diff ") || text.hasPrefix("index ") {
                kind = .header
            } else if text.hasPrefix("@@") {
                kind = .hunk
            } else if text.hasPrefix("+") {
                kind = .addition
            } else if text.hasPrefix("-") {
                kind = .deletion
            } else {
                kind = .context
            }
            return Line(id: index, text: text, kind: kind)
        }
    }

    private var additions: Int { lines.filter { $0.kind == .addition }.count }
    private var deletions: Int { lines.filter { $0.kind == .deletion }.count }

    var body: some View {
        List {
            Section {
                HStack {
                    Label("+\(additions)", systemImage: "plus")
                        .foregroundStyle(.green)
                    Label("−\(deletions)", systemImage: "minus")
                        .foregroundStyle(.red)
                    Spacer()
                    Text("\(lines.count) lines").foregroundStyle(.secondary)
                }
                .font(.caption.monospacedDigit())
            }
            Section("Patch") {
                ForEach(lines) { line in
                    CheersDiffLineItem(text: line.text, tone: tone(line.kind))
                }
            }
        }
        .listStyle(.plain)
    }

    private func tone(_ kind: Line.Kind) -> CheersDiffTone {
        switch kind {
        case .addition: .addition
        case .deletion: .deletion
        case .hunk: .hunk
        case .header: .header
        case .context: .context
        }
    }

    private func foreground(_ kind: Line.Kind) -> Color {
        switch kind {
        case .addition: .green
        case .deletion: .red
        case .hunk: .blue
        case .header: .secondary
        case .context: .primary
        }
    }

    private func background(_ kind: Line.Kind) -> Color {
        switch kind {
        case .addition: Color.green.opacity(0.08)
        case .deletion: Color.red.opacity(0.08)
        case .hunk: Color.blue.opacity(0.08)
        default: Color.clear
        }
    }
}
