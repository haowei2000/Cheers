import SwiftUI
import UIKit
import UserNotifications

/// OS push bridge (docs/arch/MOBILE_APP_DESIGN.md §5.4), following the HIG:
/// - authorization is requested IN CONTEXT — after login, when the main shell
///   appears — never cold at first launch;
/// - the ACP_APPROVAL category makes approval banners actionable (Approve
///   requires device authentication, Deny is destructive-styled); actions
///   resolve via the REST API without opening the UI;
/// - a foregrounded app suppresses banners (its live WS already shows the
///   event — design §5.3 "client-side suppression");
/// - tapping a banner deep-links to the channel.
@MainActor
final class PushRouter: NSObject {
    static let shared = PushRouter()

    weak var app: AppModel?
    /// Set by the shell: routes a channel id from a notification tap.
    var openChannel: ((String) -> Void)?

    private var configured = false
    private static let tokenKey = "push_token"

    /// Idempotent; call once the user is signed in (contextual permission ask).
    func configure(app: AppModel) {
        self.app = app
        guard !configured else { return }
        configured = true

        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let approve = UNNotificationAction(
            identifier: "APPROVE",
            title: "Approve",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: "DENY",
            title: "Deny",
            options: [.destructive]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: "ACP_APPROVAL",
                actions: [approve, deny],
                intentIdentifiers: [],
                options: []
            ),
        ])

        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// APNs granted us a device token — upload it (design §5.2).
    func uploadDeviceToken(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: Self.tokenKey)
        guard let api = app?.api else { return }
        Task {
            try? await api.registerDevice(token: token, name: UIDevice.current.name)
        }
    }

    /// Best-effort deregistration on sign-out so a revoked session stops
    /// receiving pushes.
    static func deleteRegistration(using api: APIClient) async {
        guard let token = UserDefaults.standard.string(forKey: tokenKey) else { return }
        try? await api.deleteDevice(token: token)
        UserDefaults.standard.removeObject(forKey: tokenKey)
    }
}

extension PushRouter: UNUserNotificationCenterDelegate {
    /// Foreground suppression: the open app's realtime socket already shows
    /// the event, so banners would be duplicate noise.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        []
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let cheers = info["cheers"] as? [String: Any]
        let channelId = cheers?["channel_id"] as? String
        let action = response.actionIdentifier

        await MainActor.run {
            switch action {
            case "APPROVE", "DENY":
                guard let api = PushRouter.shared.app?.api,
                      let channelId,
                      let requestId = cheers?["request_id"] as? String,
                      let optionId = cheers?[action == "APPROVE" ? "approve_option_id" : "reject_option_id"] as? String
                else { return }
                Task {
                    _ = try? await api.resolvePermission(
                        channelId: channelId,
                        requestId: requestId,
                        optionId: optionId
                    )
                }
            default:
                // Plain tap → open the conversation.
                if let channelId {
                    PushRouter.shared.openChannel?(channelId)
                }
            }
        }
    }
}

/// UIKit delegate adaptor: receives the APNs registration callbacks.
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushRouter.shared.uploadDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on simulators / unsigned builds — local notification
        // delivery (simctl push) still works for testing.
    }
}
