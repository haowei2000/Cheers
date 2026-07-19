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
    let channel: ChannelDto

    @State private var members: [ChannelMemberDto] = []
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var showInvite = false
    @State private var roleTarget: ChannelMemberDto?
    @State private var removeTarget: ChannelMemberDto?

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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Theme.border)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
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

    private var header: some View {
        HStack {
            Text("Members")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            if !members.isEmpty {
                Text("\(members.filter { !$0.isPending }.count)")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            if canManage && !channel.isDM {
                Button {
                    showInvite = true
                } label: {
                    Label("Invite", systemImage: "person.badge.plus")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.link)
                }
                .frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
        } else if let errorText {
            Text(errorText)
                .font(.system(size: 12))
                .foregroundStyle(Theme.danger)
                .padding(16)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(members) { member in
                        memberRow(member)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func memberRow(_ member: ChannelMemberDto) -> some View {
        HStack(spacing: 11) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(seedId: member.memberId, name: member.name, size: 34, monochrome: true)
                if member.isOnline == true {
                    Circle()
                        .fill(Theme.online)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(Theme.bgSurface, lineWidth: 2))
                }
            }
            .opacity(member.isPending ? 0.5 : 1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(member.name)
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if member.isBot {
                        Text("BOT")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Theme.botBadgeText)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Theme.botBadgeBg, in: RoundedRectangle(cornerRadius: 3))
                    }
                }
                HStack(spacing: 6) {
                    if member.isPending {
                        Text("Invited · awaiting reply")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.warning)
                    } else if let role = member.role, role != "member" {
                        Text(role.capitalized)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            Spacer(minLength: 8)
            if canManage {
                rowMenu(member)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
    }

    /// Role change is unavailable for pending invites (no endpoint) and for
    /// yourself (server: "use leave or transfer ownership"). Owners are not
    /// removable from here — the web guards this client-side too.
    @ViewBuilder
    private func rowMenu(_ member: ChannelMemberDto) -> some View {
        let isMe = member.memberType == "user" && member.memberId == app.session?.userId
        let canChangeRole = !member.isPending && !isMe
        let canRemove = !isMe && member.role != "owner"
        if canChangeRole || canRemove {
            Menu {
                if canChangeRole {
                    Button { roleTarget = member } label: { Label("Change role", systemImage: "person.badge.key") }
                }
                if canRemove {
                    Button(role: .destructive) { removeTarget = member } label: {
                        Label(member.isPending ? "Cancel invite" : "Remove", systemImage: "person.badge.minus")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .semibold))
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
        VStack(spacing: 0) {
            HStack {
                Text("Add to #\(channel.name)")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                Button("Done") { dismiss() }
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.link)
                    .frame(minHeight: 44)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)

            Picker("", selection: $mode) {
                ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            Divider().overlay(Theme.border)

            if let errorText {
                Text(errorText)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
            }
            if let notice {
                Text(notice)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.online)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
            }

            switch mode {
            case .direct: directInvite
            case .link:   linkInvite
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
    }

    // MARK: Direct

    private var directInvite: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textMuted)
                TextField("Search people and bots", text: $query)
                    .font(.system(size: 15))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: query) { _, new in scheduleSearch(new) }
                if isSearching { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Theme.bgRaised)
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .padding(16)

            if query.count < 2 {
                Text("Only workspace members can be invited to a channel. Use an invite link to bring in someone new.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 16)
            } else if results.isEmpty && !isSearching {
                Text("No matches")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.horizontal, 16)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(results) { item in
                            candidateRow(item)
                        }
                    }
                }
            }
        }
    }

    private func candidateRow(_ item: InvitableItem) -> some View {
        let already = item.alreadyMember == true
        return Button {
            Task { await add(item) }
        } label: {
            HStack(spacing: 11) {
                AvatarView(seedId: item.memberId, name: item.name, size: 32, monochrome: true)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(item.name)
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.textPrimary)
                        if item.isBot {
                            Text("BOT")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(Theme.botBadgeText)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(Theme.botBadgeBg, in: RoundedRectangle(cornerRadius: 3))
                        }
                    }
                    if already {
                        Text("Already in this channel")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                Spacer()
                if !already {
                    Image(systemName: "plus.circle")
                        .font(.system(size: 18))
                        .foregroundStyle(Theme.link)
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
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
            // A bot is bound immediately; a user only gets a pending invite.
            notice = response.status == "pending" ? "Invited \(item.name)" : "Added \(item.name)"
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
        VStack(alignment: .leading, spacing: 12) {
            if channel.channelType != "public" {
                infoText("Invite links only work for public channels — a bearer link must never be a back door into a private one.")
            } else if !linksAllowed {
                infoText("Only a workspace owner or admin can create invite links.")
            } else {
                Button {
                    Task { await createLink() }
                } label: {
                    HStack(spacing: 7) {
                        if isCreating {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "link.badge.plus")
                        }
                        Text("Create invite link")
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .disabled(isCreating)
                .padding(.horizontal, 16)

                if links.isEmpty && linksLoaded {
                    infoText("No active links for this channel yet.")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(links) { link in
                                linkRow(link)
                            }
                        }
                    }
                }
            }
        }
        .padding(.top, 14)
        .task { await loadLinks() }
    }

    private func linkRow(_ link: InviteLinkDto) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(inviteURL(link))
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            HStack(spacing: 10) {
                Text(usageLabel(link))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                Spacer()
                ShareLink(item: inviteURL(link)) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.link)
                        .frame(width: 44, height: 36)
                }
                Button {
                    UIPasteboard.general.string = inviteURL(link)
                    notice = "Link copied"
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.link)
                        .frame(width: 44, height: 36)
                }
                Button {
                    Task { await revoke(link) }
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.danger)
                        .frame(width: 44, height: 36)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.border).padding(.leading, 16) }
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
            .font(.system(size: 12))
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 16)
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
