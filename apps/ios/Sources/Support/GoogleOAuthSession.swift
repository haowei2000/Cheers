import AuthenticationServices
import Foundation
import UIKit

enum GoogleOAuthError: LocalizedError {
    case cancelled
    case underlying(Error)

    var errorDescription: String? {
        switch self {
        case .cancelled: return "Google sign-in was cancelled."
        case .underlying(let error): return error.localizedDescription
        }
    }
}

/// ASWebAuthenticationSession wrapper for Google OAuth → `cheers://auth/callback`.
@MainActor
final class GoogleOAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(authorizationURL: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callbackURLScheme: "cheers"
            ) { callbackURL, error in
                self.session = nil
                if let error {
                    let ns = error as NSError
                    if ns.domain == ASWebAuthenticationSessionErrorDomain,
                       ns.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(throwing: GoogleOAuthError.cancelled)
                    } else {
                        continuation.resume(throwing: GoogleOAuthError.underlying(error))
                    }
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: GoogleOAuthError.cancelled)
                    return
                }
                continuation.resume(returning: callbackURL)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                continuation.resume(
                    throwing: GoogleOAuthError.underlying(
                        NSError(
                            domain: "Cheers.GoogleOAuth",
                            code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "Could not start Google sign-in."]
                        )
                    )
                )
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
