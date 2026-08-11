import SwiftUI

/// Channel roster **plus** membership management: direct invite, add bot, change
/// role, remove. Mirrors the web's split (read-only popover + settings dialog)
/// collapsed into one mobile sheet, because a phone has no room for two.
///
/// `canManage` has no server-provided shortcut — the web derives it client-side
/// and so must we: find your own row in the member list and read its role, or
/// fall back to the global admin role on the session.
struct MembersSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channel: ChannelDto

    @State private var members: [ChannelMemberDto] = []
    @State private var query = ""
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var showInvite = false
    @State private var roleTarget: ChannelMemberDto?
    @State private var removeTarget: ChannelMemberDto?
    @State private var reportTarget: ChannelMemberDto?
    @State private var blockTarget: ChannelMemberDto?

    private var channelId: String { channel.channelId }

    private var myRole: String? {
        guard let me = app.session?.userId else { return nil }
        return members.first { $0.memberType == "user" && $0.memberId == me }?.role
    }

    private var isGlobalAdmin: Bool {
        let role = app.session?.role ?? ""
        return role == "system_admin" || role == "admin"
    }

    private var canManage: Bool {
        isGlobalAdmin || myRole == "owner" || myRole == "admin"
    }

    private var filteredMembers: [ChannelMemberDto] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return members }
        return members.filter {
            $0.name.localizedCaseInsensitiveContains(needle)
                || ($0.role?.localizedCaseInsensitiveContains(needle) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(members.isEmpty ? "Members" : "Members (\(members.filter { !$0.isPending }.count))")
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, prompt: "Search members")
                .toolbar {
                    if canManage && !channel.isDM {
                        ToolbarItem(placement: .primaryAction) {
                            Button {
                                showInvite = true
                            } label: {
                                Label("Invite", systemImage: "person.badge.plus")
                            }
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .task { await load() }
        .sheet(isPresented: $showInvite) {
            InviteSheet(channel: channel, onChanged: { Task { await load() } })
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Change role",
            isPresented: Binding(get: { roleTarget != nil }, set: { if !$0 { roleTarget = nil } }),
            titleVisibility: .visible
        ) {
            if let target = roleTarget {
                // Bots may only hold member/readonly — the server rejects the rest.
                ForEach(target.isBot ? ["member", "readonly"] : ["owner", "admin", "member", "readonly"], id: \.self) { role in
                    Button(role.capitalized) { Task { await setRole(target, role) } }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Report this user?", isPresented: Binding(get: { reportTarget != nil }, set: { if !$0 { reportTarget = nil } }), titleVisibility: .visible) {
            ForEach(["harassment", "spam", "illegal", "privacy", "other"], id: \.self) { reason in
                Button(reason.capitalized) { Task { await report(reason) } }
            }
            Button("Cancel", role: .cancel) { reportTarget = nil }
        }
        .confirmationDialog("Block this user?", isPresented: Binding(get: { blockTarget != nil }, set: { if !$0 { blockTarget = nil } }), titleVisibility: .visible) {
            Button("Block", role: .destructive) { Task { await block() } }
            Button("Cancel", role: .cancel) { blockTarget = nil }
        }
        .confirmationDialog(
            removeTarget.map { "Remove \($0.name) from #\(channel.name)?" } ?? "",
            isPresented: Binding(get: { removeTarget != nil }, set: { if !$0 { removeTarget = nil } }),
            titleVisibility: .visible
        ) {
            if let target = removeTarget {
                Button("Remove", role: .destructive) { Task { await remove(target) } }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView("Loading members…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorText {
            ContentUnavailableView {
                Label("Couldn’t load members", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorText)
            } actions: {
                Button("Retry") { Task { await load() } }
                    .buttonStyle(.borderedProminent)
            }
        } else if filteredMembers.isEmpty {
            ContentUnavailableView(
                query.isEmpty ? "No members" : "No matching members",
                systemImage: query.isEmpty ? "person.2" : "magnifyingglass",
                description: Text(query.isEmpty ? "Invite someone to start this channel." : "Try a different name or role.")
            )
        } else {
            List(filteredMembers) { member in
                memberRow(member)
            }
            .listStyle(.insetGrouped)
            .refreshable {
                await load()
            }
        }
    }

    private func memberRow(_ member: ChannelMemberDto) -> some View {
        let subtitle: String? = member.isPending
            ? (member.status == "pending_owner"
                ? "Awaiting bot owner approval"
                : member.status == "pending_workspace"
                    ? "Awaiting workspace acceptance"
                    : "Invited · awaiting reply")
            : member.role.flatMap { $0 == "member" ? nil : $0.capitalized }
        return CheersEntityItem(row: CheersItemRow(
            title: member.name,
            subtitle: subtitle,
            leading: AnyView(ZStack(alignment: .bottomTrailing) {
                AvatarView(seedId: member.memberId, name: member.name, size: 34, monochrome: true)
                if member.isOnline == true {
                    Circle()
                        .fill(Theme.online)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(Theme.bgSurface, lineWidth: 2))
                }
            }.opacity(member.isPending ? 0.5 : 1)),
            criticalStatus: member.isPending ? AnyView(Text("PENDING").font(.caption2.bold()).foregroundStyle(Theme.warning)) : nil,
            status: member.isBot ? AnyView(Text("BOT").font(.caption2.bold()).foregroundStyle(Theme.botBadgeText)) : nil,
            actions: AnyView(rowMenu(member))
        ))
    }

    /// Role change is unavailable for pending invites (no endpoint) and for
    /// yourself (server: "use leave or transfer ownership"). Owners are not
    /// removable from here — the web guards this client-side too.
    @ViewBuilder
    private func rowMenu(_ member: ChannelMemberDto) -> some View {
        let isMe = member.memberType == "user" && member.memberId == app.session?.userId
        let canChangeRole = canManage && !member.isPending && !isMe
        let canRemove = canManage && !isMe && member.role != "owner"
        let canSafetyAction = !member.isBot && !member.isPending && !isMe
        if canChangeRole || canRemove || canSafetyAction {
            Menu {
                if canChangeRole {
                    Button { roleTarget = member } label: { Label("Change role", systemImage: "person.badge.key") }
                }
                if canRemove {
                    Button(role: .destructive) { removeTarget = member } label: {
                        Label(member.isPending ? "Cancel invite" : "Remove", systemImage: "person.badge.minus")
                    }
                }
                if canSafetyAction {
                    Divider()
                    Button { reportTarget = member } label: { Label("Report user", systemImage: "exclamationmark.bubble") }
                    Button(role: .destructive) { blockTarget = member } label: { Label("Block user", systemImage: "hand.raised") }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
        }
    }

    // MARK: Actions

    private func load() async {
        guard let api = app.api else { isLoading = false; return }
        do {
            members = try await api.listMembers(channelId: channelId)
            errorText = nil
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    private func setRole(_ member: ChannelMemberDto, _ role: String) async {
        guard let api = app.api else { return }
        roleTarget = nil
        do {
            try await api.setMemberRole(channelId: channelId, memberId: member.memberId, role: role)
            await load()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func remove(_ member: ChannelMemberDto) async {
        guard let api = app.api else { return }
        removeTarget = nil
        do {
            try await api.removeMember(channelId: channelId, memberId: member.memberId)
            await load()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func report(_ reason: String) async {
        guard let target = reportTarget, let api = app.api else { return }
        reportTarget = nil
        do {
            try await api.report(targetType: "user", targetId: target.memberId, channelId: channelId, reason: reason, details: nil)
            errorText = nil
        } catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }

    private func block() async {
        guard let target = blockTarget, let api = app.api else { return }
        blockTarget = nil
        do { try await api.blockUser(target.memberId) }
        catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }
}

// MARK: - Invite

/// The two invite mechanisms, side by side, because they are genuinely different:
/// **Direct** invites an existing workspace member (they must accept); **Link**
/// mints a shareable workspace invite-link scoped to this channel.
struct InviteSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let channel: ChannelDto
    var onChanged: () -> Void = {}

    private enum Mode: String, CaseIterable { case direct = "Invite people", link = "Invite link" }
    @State private var mode: Mode = .direct

    // Direct invite
    @State private var query = ""
    @State private var results: [InvitableItem] = []
    @State private var isSearching = false
    @State private var notice: String?
    @State private var errorText: String?
    @State private var searchTask: Task<Void, Never>?

    // Invite links
    @State private var links: [InviteLinkDto] = []
    @State private var linksLoaded = false
    @State private var linksAllowed = true
    @State private var isCreating = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Invite method", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding()

                switch mode {
                case .direct: directInvite
                case .link: linkInvite
                }
            }
            .navigationTitle("Add to #\(channel.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: Direct

    private var directInvite: some View {
        List {
            if let errorText {
                Section { Label(errorText, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            }
            if let notice {
                Section { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.green) }
            }
            if query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 {
                Section {
                    ContentUnavailableView(
                        "Find workspace members",
                        systemImage: "person.badge.plus",
                        description: Text("Search by name. Use an invite link to bring in someone new.")
                    )
                }
            } else if isSearching {
                Section { ProgressView("Searching…") }
            } else if results.isEmpty && !isSearching {
                Section { ContentUnavailableView.search(text: query) }
            } else {
                Section("Results") {
                    ForEach(results) { item in candidateRow(item) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $query, prompt: "Search people and bots")
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onChange(of: query) { _, new in scheduleSearch(new) }
    }

    private func candidateRow(_ item: InvitableItem) -> some View {
        let already = item.alreadyMember == true
        return Button {
            Task { await add(item) }
        } label: {
            CheersEntityItem(row: CheersItemRow(
                title: item.name,
                subtitle: already ? "Already in this channel" : item.requiresWorkspaceAcceptance == true ? "Workspace acceptance required first" : nil,
                leading: AnyView(AvatarView(seedId: item.memberId, name: item.name, size: 32, monochrome: true)),
                criticalStatus: already ? AnyView(Text("MEMBER").font(.caption2.bold()).foregroundStyle(Theme.textMuted)) : nil,
                status: item.isBot ? AnyView(Text("BOT").font(.caption2.bold()).foregroundStyle(Theme.botBadgeText)) : nil,
                trailing: already ? nil : AnyView(Image(systemName: "plus.circle").foregroundStyle(Theme.accent))
            ))
            .opacity(already ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(already)
    }

    private func scheduleSearch(_ text: String) {
        searchTask?.cancel()
        guard text.count >= 2, let api = app.api else { results = []; return }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))   // debounce, as the web does
            guard !Task.isCancelled else { return }
            isSearching = true
            defer { isSearching = false }
            do {
                let found = try await api.searchInvitable(channelId: channel.channelId, query: text)
                guard !Task.isCancelled else { return }
                results = found
                errorText = nil
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func add(_ item: InvitableItem) async {
        guard let api = app.api else { return }
        do {
            let response = try await api.addMember(
                channelId: channel.channelId,
                memberId: item.memberId,
                memberType: item.memberType
            )
            switch response.status {
            case "pending": notice = "Invited \(item.name)"
            case "pending_workspace": notice = "Invited \(item.name) to the workspace first"
            case "pending_owner": notice = "Sent \(item.name)'s owner an approval request"
            default: notice = "Added \(item.name)"
            }
            errorText = nil
            onChanged()
            scheduleSearch(query)
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: Invite link

    @ViewBuilder
    private var linkInvite: some View {
        List {
            if let errorText {
                Section { Label(errorText, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            }
            if let notice {
                Section { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.green) }
            }
            if channel.channelType != "public" {
                Section { infoText("Invite links only work for public channels — a bearer link must never be a back door into a private one.") }
            } else if !linksAllowed {
                Section { infoText("Only a workspace owner or admin can create invite links.") }
            } else {
                Section {
                    Button { Task { await createLink() } } label: {
                        if isCreating { ProgressView() }
                        else { Label("Create invite link", systemImage: "link.badge.plus") }
                    }
                    .disabled(isCreating)
                }

                if links.isEmpty && linksLoaded {
                    Section { ContentUnavailableView("No active links", systemImage: "link") }
                } else {
                    Section("Active links") {
                        ForEach(links) { link in linkRow(link) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .task { await loadLinks() }
    }

    private func linkRow(_ link: InviteLinkDto) -> some View {
        CheersOperationsItem(row: CheersItemRow(
            title: inviteURL(link),
            subtitle: usageLabel(link),
            leading: AnyView(Image(systemName: "link").foregroundStyle(Theme.accent)),
            actions: AnyView(HStack(spacing: 10) {
                ShareLink(item: inviteURL(link)) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 44, height: 36)
                }
                Button {
                    UIPasteboard.general.string = inviteURL(link)
                    notice = "Link copied"
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 44, height: 36)
                }
                Button {
                    Task { await revoke(link) }
                } label: {
                    Image(systemName: "trash")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.red)
                        .frame(width: 44, height: 36)
                }
            })
        ))
    }

    /// The link must point at the *web deployment*, not any app scheme — the
    /// recipient opens it in a browser.
    private func inviteURL(_ link: InviteLinkDto) -> String {
        let origin = app.baseURL?.absoluteString
            .replacingOccurrences(of: "/api/v1", with: "") ?? ""
        let trimmed = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
        return "\(trimmed)/invite/\(link.token)"
    }

    private func usageLabel(_ link: InviteLinkDto) -> String {
        var parts: [String] = []
        if let max = link.maxUses {
            parts.append("\(link.useCount ?? 0)/\(max) uses")
        } else {
            parts.append("\(link.useCount ?? 0) uses · unlimited")
        }
        if let status = link.status, status != "active" { parts.append(status) }
        return parts.joined(separator: " · ")
    }

    private func infoText(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
    }

    private func loadLinks() async {
        guard !linksLoaded, let api = app.api, let workspaceId = channel.workspaceId else { return }
        do {
            let all = try await api.listInviteLinks(workspaceId: workspaceId)
            links = all.filter { $0.channelId == channel.channelId }
            linksAllowed = true
        } catch {
            // A 403 here means "not a workspace admin" — hide the section rather
            // than showing an error the user can do nothing about.
            linksAllowed = false
        }
        linksLoaded = true
    }

    private func createLink() async {
        guard let api = app.api, let workspaceId = channel.workspaceId else { return }
        isCreating = true
        defer { isCreating = false }
        do {
            let link = try await api.createInviteLink(
                workspaceId: workspaceId,
                channelId: channel.channelId,
                expiresInHours: 168,      // 7 days
                maxUses: nil
            )
            links.insert(link, at: 0)
            errorText = nil
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func revoke(_ link: InviteLinkDto) async {
        guard let api = app.api, let workspaceId = channel.workspaceId else { return }
        do {
            try await api.revokeInviteLink(workspaceId: workspaceId, linkId: link.linkId)
            links.removeAll { $0.linkId == link.linkId }
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
