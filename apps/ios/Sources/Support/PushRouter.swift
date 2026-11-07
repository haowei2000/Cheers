import SwiftUI
import UIKit
import UserNotifications

/// Where a notification tap (or failed background action) should land.
enum PushDestination: Equatable {
    case channel(String)
    case approval(channelId: String, requestId: String)
    case activity
}

/// OS push bridge (docs/arch/MOBILE_APP_DESIGN.md §5.4), following the HIG:
/// - authorization is requested IN CONTEXT — after login, when the main shell
///   appears — never cold at first launch;
/// - categories + the notification-center delegate are registered at process
///   launch so lock-screen Approve/Deny and cold-start taps work;
/// - the ACP_APPROVAL category keeps direct Approve / Deny actions for urgent
///   requests. Approval requires device authentication; tapping the banner
///   opens the channel (and the approval sheet for permission pushes);
/// - a foregrounded app suppresses banners (its live WS already shows the
///   event — design §5.3 "client-side suppression").
@MainActor
final class PushRouter: NSObject {
    static let shared = PushRouter()

    static let approvalCategoryId = "ACP_APPROVAL"
    private static let tokenKey = "push_token"

    /// Attached at launch by PushAppDelegate (which owns the AppModel), so a
    /// lock-screen action that cold-launches the app in the background still
    /// sends through the token-renewing client.
    weak var app: AppModel?
    /// Set by the shell once navigation is ready. Flushes any pending destination.
    var onNavigate: ((PushDestination) -> Void)? {
        didSet { flushPendingNavigation() }
    }

    private var configuredAuth = false
    private var bootstrapped = false
    private var pendingDestination: PushDestination?

    /// Call from `application(_:didFinishLaunchingWithOptions:)` before return —
    /// categories and the delegate must be live before the system delivers a
    /// cold-start notification response.
    func bootstrap() {
        guard !bootstrapped else { return }
        bootstrapped = true

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        registerCategories(on: center)
    }

    /// Idempotent; call once the user is signed in (contextual permission ask).
    func configure(app: AppModel) {
        bootstrap()
        self.app = app
        flushCachedTokenIfNeeded()
        guard !configuredAuth else { return }
        configuredAuth = true

        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    private func registerCategories(on center: UNUserNotificationCenter) {
        // Titles are fixed at category registration (iOS cannot vary them per
        // push). ACP's default allow option is allow_once — label matches that;
        // the payload's approve_option_id carries the real option id.
        let approve = UNNotificationAction(
            identifier: "APPROVE",
            title: "Approve once",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: "DENY",
            title: "Deny",
            options: [.destructive, .authenticationRequired]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.approvalCategoryId,
                actions: [approve, deny],
                intentIdentifiers: [],
                options: []
            ),
        ])
    }

    /// APNs granted us a device token — persist locally, then upload when API is ready.
    func uploadDeviceToken(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: Self.tokenKey)
        flushCachedTokenIfNeeded()
    }

    /// Upload a previously cached token once `app.api` is available. Safe to call
    /// repeatedly — register is idempotent server-side.
    private func flushCachedTokenIfNeeded() {
        guard let api = app?.api,
              let token = UserDefaults.standard.string(forKey: Self.tokenKey)
        else { return }
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

    /// Password changes revoke every registered device server-side. Restore the
    /// current, user-controlled device only after its fresh session is stored.
    static func reregisterCurrentDevice(using api: APIClient) async {
        guard let token = UserDefaults.standard.string(forKey: tokenKey) else { return }
        try? await api.registerDevice(token: token, name: UIDevice.current.name)
    }

    // MARK: Navigation

    func navigate(_ destination: PushDestination) {
        if let onNavigate {
            onNavigate(destination)
        } else {
            pendingDestination = destination
        }
    }

    private func flushPendingNavigation() {
        guard let onNavigate, let pending = pendingDestination else { return }
        pendingDestination = nil
        onNavigate(pending)
    }

    // MARK: Payload parsing

    /// APNs delivers custom keys as property-list types; `null` becomes NSNull
    /// and UUID-looking values are usually String — normalize carefully.
    nonisolated static func cheersPayload(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        if let cheers = userInfo["cheers"] as? [String: Any] {
            return cheers
        }
        // Tolerate a flattened custom dictionary (older / misrouted payloads).
        return userInfo.reduce(into: [String: Any]()) { out, pair in
            guard let key = pair.key as? String, key != "aps" else { return }
            out[key] = pair.value
        }
    }

    nonisolated static func stringValue(_ raw: Any?) -> String? {
        switch raw {
        case let s as String:
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case let n as NSNumber:
            return n.stringValue
        default:
            return nil
        }
    }

    nonisolated static func destination(from cheers: [String: Any]) -> PushDestination? {
        let type = stringValue(cheers["type"])
        if type == "activity" { return .activity }
        guard let channelId = stringValue(cheers["channel_id"]) else { return nil }
        if type == "permission_request", let requestId = stringValue(cheers["request_id"]) {
            return .approval(channelId: channelId, requestId: requestId)
        }
        return .channel(channelId)
    }
}

extension PushRouter: UNUserNotificationCenterDelegate {
    /// Foreground suppression: the open app's realtime socket already shows
    /// the event, so banners would be duplicate noise.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Apple's documented API (WWDC20 Push Notifications primer):
        // completion-handler form, not the Swift `async` overload.
        let info = response.notification.request.content.userInfo
        let cheers = PushRouter.cheersPayload(from: info)
        let action = response.actionIdentifier
        // Finish the system callback before MainActor UI. Holding the async
        // `didReceive` across `await MainActor.run` races UIKit snapshot
        // restoration and aborts (`_performBlockAfterCATransactionCommitSynchronizes`).
        completionHandler()
        Task { @MainActor in
            PushRouter.shared.handleResponse(action: action, cheers: cheers)
        }
    }

    fileprivate func handleResponse(action: String, cheers: [String: Any]) {
        switch action {
        case "APPROVE", "DENY":
            handleApprovalAction(action: action, cheers: cheers)
        default:
            // Default tap / dismiss-open — deep-link into the app.
            if let destination = Self.destination(from: cheers) {
                navigate(destination)
            }
        }
    }

    private func handleApprovalAction(action: String, cheers: [String: Any]) {
        guard let channelId = Self.stringValue(cheers["channel_id"]),
              let requestId = Self.stringValue(cheers["request_id"])
        else {
            if let destination = Self.destination(from: cheers) {
                navigate(destination)
            }
            return
        }
        let optionKey = action == "APPROVE" ? "approve_option_id" : "reject_option_id"
        guard let optionId = Self.stringValue(cheers[optionKey]) else {
            navigate(.approval(channelId: channelId, requestId: requestId))
            return
        }

        guard let api = app?.api else {
            navigate(.approval(channelId: channelId, requestId: requestId))
            return
        }

        // Approve/Deny run without opening the app, and the system callback has
        // already completed (see didReceive) — hold a background assertion so
        // iOS doesn't suspend the process before the decision reaches the server.
        let backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "ResolvePermission")
        Task {
            defer {
                if backgroundTask != .invalid {
                    UIApplication.shared.endBackgroundTask(backgroundTask)
                }
            }
            do {
                _ = try await api.resolvePermission(
                    channelId: channelId,
                    requestId: requestId,
                    optionId: optionId
                )
            } catch {
                navigate(.approval(channelId: channelId, requestId: requestId))
            }
        }
    }
}

/// UIKit delegate adaptor: receives the APNs registration callbacks and
/// bootstraps notification categories before the first frame.
///
/// Marked `@MainActor` so launch can call `PushRouter.shared` safely. Do **not**
/// use `MainActor.assumeIsolated` here — on the notification cold-start path
/// that traps even though the call is on the main thread, which is exactly the
/// "tap notification → crash" failure mode.
@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    /// The app's single AppModel. Owned here, not by the SwiftUI scene, because
    /// a notification action can launch the app in the background with no scene;
    /// one owner also keeps refresh-token rotation in one place.
    let appModel = AppModel()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PushRouter.shared.bootstrap()
        PushRouter.shared.app = appModel
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushRouter.shared.uploadDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on simulators / unsigned builds — local notification
        // delivery (simctl push) still works for testing.
    }
}
