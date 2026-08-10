import SwiftUI

/// Friends list, requests, exact username-or-ID lookup, and blocked users.
struct FriendsView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell

    private enum Tab: String, CaseIterable, Identifiable {
        case friends, requests, blocked
        var id: String { rawValue }
        var title: String {
            switch self {
            case .friends: return String(localized: "Friends")
            case .requests: return String(localized: "Requests")
            case .blocked: return String(localized: "Blocked")
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
    @State private var showAddFriend = false
    @State private var friendToRemove: FriendDto?
    @State private var friendToBlock: FriendDto?
    @State private var isLoading = true
    @State private var isBusy = false
    @State private var errorText: String?

    var body: some View {
        ScreenScaffold(title: "Friends", titleDisplayMode: .inline) {
            VStack(spacing: 0) {
                Picker("Tab", selection: $tab) {
                    ForEach(Tab.allCases) { t in
                        Text(
                            t == .requests && !incoming.isEmpty
                                ? String(localized: "Requests (\(incoming.count))")
                                : t.title
                        )
                        .tag(t)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Theme.space4)
                .padding(.top, Theme.space2)
                .padding(.bottom, Theme.space1)

                Group {
                    if isLoading {
                        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        switch tab {
                        case .friends: friendsList
                        case .requests: requestsList
                        case .blocked: blockedList
                        }
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Add Friend", systemImage: "person.badge.plus") {
                    showAddFriend = true
                }
                .labelStyle(.iconOnly)
            }
        }
        .sheet(isPresented: $showAddFriend, onDismiss: resetAddForm) {
            addFriendSheet
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { errorText != nil },
                set: { if !$0 { errorText = nil } }
            )
        ) {
            Button("OK", role: .cancel) { errorText = nil }
        } message: {
            Text(errorText ?? "")
        }
        .confirmationDialog(
            "Remove friend?",
            isPresented: Binding(
                get: { friendToRemove != nil },
                set: { if !$0 { friendToRemove = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove Friend", role: .destructive) {
                guard let friend = friendToRemove else { return }
                friendToRemove = nil
                Task { await remove(friendId: friend.friendId) }
            }
            Button("Cancel", role: .cancel) { friendToRemove = nil }
        }
        .confirmationDialog(
            "Block this person?",
            isPresented: Binding(
                get: { friendToBlock != nil },
                set: { if !$0 { friendToBlock = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Block", role: .destructive) {
                guard let friend = friendToBlock else { return }
                friendToBlock = nil
                Task { await block(userId: friend.friendId) }
            }
            Button("Cancel", role: .cancel) { friendToBlock = nil }
        } message: {
            Text("They won’t be able to contact you or send a friend request.")
        }
        .task { await reload() }
        .onChange(of: tab) { _, _ in
            errorText = nil
        }
    }

    private var friendsList: some View {
        Group {
            if friends.isEmpty {
                ContentUnavailableView {
                    Label("No Friends Yet", systemImage: "person.2")
                } description: {
                    Text("Add someone by username or user ID to start a conversation.")
                } actions: {
                    Button("Add Friend", systemImage: "person.badge.plus") {
                        showAddFriend = true
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    ForEach(friends) { friend in
                        HStack(spacing: Theme.space3) {
                            AvatarView(
                                seedId: friend.friendId,
                                name: friend.displayName ?? friend.username,
                                size: Theme.avatarList,
                                imageURL: resolveAvatarURL(friend.avatarURL)
                            )
                            VStack(alignment: .leading, spacing: Theme.space1) {
                                Text(friend.displayName ?? friend.username)
                                    .font(.body)
                                Text("@\(friend.username)")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button {
                                Task { await openDM(userId: friend.friendId) }
                            } label: {
                                Image(systemName: "bubble.left")
                                    .font(.body.weight(.medium))
                                    .frame(width: Theme.hitMin, height: Theme.hitMin)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(String(localized: "Open direct message"))
                            .disabled(isBusy)
                        }
                        .listRowInsets(EdgeInsets(
                            top: Theme.rowVertical,
                            leading: Theme.space4,
                            bottom: Theme.rowVertical,
                            trailing: Theme.space2
                        ))
                        .swipeActions {
                            Button(role: .destructive) {
                                friendToRemove = friend
                            } label: {
                                Label("Remove", systemImage: "person.badge.minus")
                            }
                            Button(role: .destructive) {
                                friendToBlock = friend
                            } label: {
                                Label("Block", systemImage: "hand.raised")
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .refreshable { await reload() }
            }
        }
    }

    private var requestsList: some View {
        Group {
            if incoming.isEmpty && outgoing.isEmpty {
                ContentUnavailableView(
                    "No Friend Requests",
                    systemImage: "person.crop.circle.badge.checkmark",
                    description: Text("Incoming and sent requests will appear here.")
                )
            } else {
                List {
                    if !incoming.isEmpty {
                        Section("Incoming") {
                            ForEach(incoming) { req in
                                requestRow(req, incoming: true)
                            }
                        }
                    }
                    if !outgoing.isEmpty {
                        Section("Sent") {
                            ForEach(outgoing) { req in
                                requestRow(req, incoming: false)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { await reload() }
            }
        }
    }

    @ViewBuilder
    private func requestRow(_ req: FriendRequestDto, incoming: Bool) -> some View {
        HStack(spacing: Theme.space3) {
            AvatarView(
                seedId: req.userId,
                name: req.displayName ?? req.username,
                size: Theme.avatarList,
                imageURL: resolveAvatarURL(req.avatarURL)
            )
            VStack(alignment: .leading, spacing: Theme.space1) {
                Text(req.displayName ?? req.username)
                Text("@\(req.username)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if incoming {
                Button("Accept") {
                    Task { await accept(userId: req.userId) }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isBusy)
            }
        }
        .swipeActions {
            Button(incoming ? "Decline" : "Cancel", role: .destructive) {
                Task { await cancelRequest(friendshipId: req.friendshipId) }
            }
        }
    }

    private var addFriendSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username or user ID", text: $addQuery)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit {
                            guard !addQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                            Task { await search() }
                        }
                    Button {
                        Task { await search() }
                    } label: {
                        if isBusy {
                            ProgressView()
                        } else {
                            Label("Look Up", systemImage: "magnifyingglass")
                        }
                    }
                    .disabled(isBusy || addQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } footer: {
                    Text("Enter an exact username or user ID.")
                }

                if let hit = searchHit {
                    Section("Result") {
                        HStack(spacing: Theme.space3) {
                            AvatarView(
                                seedId: hit.userId,
                                name: hit.displayName ?? hit.username,
                                size: Theme.avatarList,
                                imageURL: resolveAvatarURL(hit.avatarURL)
                            )
                            VStack(alignment: .leading, spacing: Theme.space1) {
                                Text(hit.displayName ?? hit.username)
                                Text("@\(hit.username)")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Button("Send Friend Request", systemImage: "person.badge.plus") {
                            Task { await sendRequest(userId: hit.userId) }
                        }
                        .disabled(isBusy)
                    }
                }
            }
            .navigationTitle("Add Friend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showAddFriend = false }
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private func resetAddForm() {
        addQuery = ""
        searchHit = nil
        errorText = nil
    }

    private func resolveAvatarURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        if let absolute = URL(string: raw), absolute.scheme != nil { return absolute }
        guard let base = app.baseURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return URL(string: raw, relativeTo: components.url)?.absoluteURL
    }

    private var blockedList: some View {
        Group {
            if blocked.isEmpty {
                ContentUnavailableView(
                    "No Blocked Users",
                    systemImage: "hand.raised",
                    description: Text("People you block will appear here.")
                )
            } else {
                List {
                    ForEach(blocked) { user in
                        HStack(spacing: Theme.space3) {
                            AvatarView(
                                seedId: user.userId,
                                name: user.displayName ?? user.username,
                                size: Theme.avatarList,
                                imageURL: resolveAvatarURL(user.avatarURL)
                            )
                            VStack(alignment: .leading, spacing: Theme.space1) {
                                Text(user.displayName ?? user.username)
                                Text("@\(user.username)")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Unblock") {
                                Task { await unblock(userId: user.userId) }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(isBusy)
                        }
                    }
                }
                .listStyle(.plain)
                .refreshable { await reload() }
            }
        }
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
                errorText = String(localized: "No user found for that username or ID.")
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
            showAddFriend = false
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

    private func cancelRequest(friendshipId: String) async {
        guard let api = app.api, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await api.cancelFriendRequest(friendshipId: friendshipId)
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
