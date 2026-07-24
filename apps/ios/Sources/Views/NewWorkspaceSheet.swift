import SwiftUI

/// Create a team workspace (POST /workspaces). Mirrors the web NewWorkspaceDialog.
struct NewWorkspaceSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var isSaving = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Workspace name", text: $name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                } footer: {
                    Text("You become the owner. Invite people after the workspace is created.")
                }

                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("New workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Creating…" : "Create") {
                        Task { await create() }
                    }
                    .disabled(!canCreate || isSaving)
                }
            }
        }
    }

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func create() async {
        guard canCreate, !isSaving else { return }
        isSaving = true
        errorText = nil
        defer { isSaving = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            let workspace = try await api.createWorkspace(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            await shell.loadWorkspaces()
            shell.selectWorkspace(workspace.workspaceId)
            dismiss()
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }
}
