import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var isSigningOut = false
    @State private var showSignOutConfirm = false

    var body: some View {
        List {
            profileSection
            serverSection
            accountSection
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgApp)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Sign out of Cheers?",
            isPresented: $showSignOutConfirm,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                signOut()
            }
        } message: {
            Text("This revokes your sessions on this server.")
        }
    }

    private var displayName: String {
        let session = app.session
        if let name = session?.displayName, !name.isEmpty { return name }
        return session?.username ?? "Unknown"
    }

    private var profileSection: some View {
        Section {
            HStack(spacing: 14) {
                AvatarView(seedId: app.session?.userId ?? "?", name: displayName, size: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(displayName)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    if let username = app.session?.username {
                        Text(username)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textMuted)
                    }
                    Text(app.session?.role ?? "member")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.botBadgeText)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.botBadgeBg)
                        .clipShape(Capsule())
                }
            }
            .padding(.vertical, 4)
            .listRowBackground(Theme.bgSurface)

            LabeledContent {
                Text(app.session?.userId ?? "—")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } label: {
                Text("User ID")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Profile")
        }
    }

    private var serverSection: some View {
        Section {
            LabeledContent {
                Text(app.serverURLString)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } label: {
                Text("Server")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            HStack {
                Text("Realtime")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textBody)
                Spacer()
                Circle()
                    .fill(app.socketConnected ? Theme.online : Theme.textFaint)
                    .frame(width: 8, height: 8)
                Text(app.socketConnected ? "Connected" : "Offline")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
            }
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Server")
        } footer: {
            Text("To switch servers, sign out and sign back in with a different server URL.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textFaint)
        }
    }

    private var accountSection: some View {
        Section {
            Button {
                showSignOutConfirm = true
            } label: {
                HStack {
                    if isSigningOut {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(isSigningOut ? "Signing out…" : "Sign out")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.danger)
                }
            }
            .disabled(isSigningOut)
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Account")
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 12, weight: .semibold))
            .tracking(0.8)
            .foregroundStyle(Theme.textMuted)
    }

    private func signOut() {
        guard !isSigningOut else { return }
        isSigningOut = true
        Task {
            await app.logout()
            isSigningOut = false
        }
    }
}
