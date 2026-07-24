import SwiftUI

/// Friends list, requests, add-by-UUID, and blocked users — mirrors web FriendsPage.
struct FriendsView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell

    private enum Tab: String, CaseIterable, Identifiable {
        case friends, requests, add, blocked
        var id: String { rawValue }
        var title: String {
            switch self {
            case .friends: return "Friends"
            case .requests: return "Requests"
            case .add: return "Add"
            case .blocked: return "Blocked"
            }
        }
    }

    @State private var tab: Tab = .friends
    @State private var friends: [FriendDto] = []
    @State private var incoming: [FriendRequestDto] = []
    @State private var outgoing: [FriendRequestDto] = []
    @State private var blocked: [BlockedUserDto] = []
    @State private var addQuery = ""
    @State private var searchHit: UserSearchResultDto?
    @State private var isLoading = true
    @State private var isBusy = false
    @State private var errorText: String?

    var body: some View {
        VStack(spacing: 0) {
            Picker("Tab", selection: $tab) {
                ForEach(Tab.allCases) { t in
                    Text(t == .requests && !incoming.isEmpty ? "Requests (\(incoming.count))" : t.title)
                        .tag(t)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            if let errorText {
                Text(errorText)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
            }

            Group {
                if isLoading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    switch tab {
                    case .friends: friendsList
                    case .requests: requestsList
                    case .add: addForm
                    case .blocked: blockedList
                    }
                }
            }
        }
        .background(Theme.bgApp)
        .navigationTitle("Friends")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .onChange(of: tab) { _, _ in
            errorText = nil
        }
    }

    private var friendsList: some View {
        List {
            if friends.isEmpty {
                Text("No friends yet. Use Add to find people by user ID.")
                    .foregroundStyle(Theme.textSecondary)
            } else {
                ForEach(friends) { friend in
                    HStack(spacing: 12) {
                        AvatarView(
                            seedId: friend.friendId,
                            name: friend.displayName ?? friend.username,
                            size: 36,
                            monochrome: true
                        )
                        VStack(alignment: .leading, spacing: 2) {
                            Text(friend.displayName ?? friend.username)
                                .font(.system(size: 15, weight: .medium))
                            Text("@\(friend.username)")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textMuted)
                        }
                        Spacer()
                        Button {
                            Task { await openDM(userId: friend.friendId) }
                        } label: {
                            Image(systemName: "bubble.left")
                        }
                        .buttonStyle(.borderless)
                        .disabled(isBusy)
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await remove(friendId: friend.friendId) }
                        } label: {
                            Label("Remove", systemImage: "person.badge.minus")
                        }
                        Button(role: .destructive) {
                            Task { await block(userId: friend.friendId) }
                        } label: {
                            Label("Block", systemImage: "hand.raised")
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    private var requestsList: some View {
        List {
            Section("Incoming") {
                if incoming.isEmpty {
                    Text("None").foregroundStyle(Theme.textMuted)
                } else {
                    ForEach(incoming) { req in
                        requestRow(req, incoming: true)
                    }
                }
            }
            Section("Outgoing") {
                if outgoing.isEmpty {
                    Text("None").foregroundStyle(Theme.textMuted)
                } else {
                    ForEach(outgoing) { req in
                        requestRow(req, incoming: false)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func requestRow(_ req: FriendRequestDto, incoming: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(req.displayName ?? req.username)
                Text("@\(req.username)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
            }
            Spacer()
            if incoming {
                Button("Accept") {
                    Task { await accept(userId: req.userId) }
                }
                .disabled(isBusy)
            }
            Button(incoming ? "Decline" : "Cancel", role: .destructive) {
                Task { await remove(friendId: req.userId) }
            }
            .disabled(isBusy)
        }
    }

    private var addForm: some View {
        Form {
            Section {
                TextField("User ID (UUID)", text: $addQuery)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(size: 14, design: .monospaced))
                Button {
                    Task { await search() }
                } label: {
                    if isBusy { ProgressView() } else { Text("Look up") }
                }
                .disabled(isBusy || addQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } footer: {
                Text("Search matches an exact user ID only (same as the web Friends Add tab).")
            }

            if let hit = searchHit {
                Section("Result") {
                    LabeledContent("Username", value: "@\(hit.username)")
                    if let name = hit.displayName {
                        LabeledContent("Name", value: name)
                    }
                    Button("Send friend request") {
                        Task { await sendRequest(userId: hit.userId) }
                    }
                    .disabled(isBusy)
                }
            }
        }
    }

    private var blockedList: some View {
        List {
            if blocked.isEmpty {
                Text("No blocked users.").foregroundStyle(Theme.textSecondary)
            } else {
                ForEach(blocked) { user in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(user.displayName ?? user.username)
                            Text("@\(user.username)")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textMuted)
                        }
                        Spacer()
                        Button("Unblock") {
                            Task { await unblock(userId: user.userId) }
                        }
                        .disabled(isBusy)
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    private func reload() async {
        guard let api = app.api else { return }
        isLoading = true
        errorText = nil
        defer { isLoading = false }
        do {
            async let f = api.listFriends()
            async let i = api.listFriendRequests(direction: "incoming")
            async let o = api.listFriendRequests(direction: "outgoing")
            async let b = api.blockedUsers()
            friends = try await f
            incoming = try await i
            outgoing = try await o
            blocked = try await b
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func search() async {
        guard let api = app.api, !isBusy else { return }
        isBusy = true
        errorText = nil
        searchHit = nil
        defer { isBusy = false }
        do {
            let q = addQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            let results = try await api.searchUsers(query: q)
            searchHit = results.first
            if results.isEmpty {
                errorText = "No user found for that ID."
            }
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func sendRequest(userId: String) async {
        guard let api = app.api, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await api.sendFriendRequest(friendId: userId)
            searchHit = nil
            addQuery = ""
            await reload()
            tab = .requests
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func accept(userId: String) async {
        guard let api = app.api, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await api.acceptFriendRequest(userId: userId)
            await reload()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func remove(friendId: String) async {
        guard let api = app.api, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await api.removeFriend(friendId: friendId)
            await reload()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func block(userId: String) async {
        guard let api = app.api, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await api.blockUser(userId)
            await reload()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func unblock(userId: String) async {
        guard let api = app.api, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await api.unblockUser(userId)
            await reload()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func openDM(userId: String) async {
        guard let api = app.api, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let channel = try await api.createDM(userId: userId)
            shell.openChat(channel)
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
