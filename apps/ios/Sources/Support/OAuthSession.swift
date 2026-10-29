import AuthenticationServices
import Foundation
import UIKit

enum OAuthError: LocalizedError {
    case cancelled
    case underlying(Error)

    var errorDescription: String? {
        switch self {
        case .cancelled: return "Sign-in was cancelled."
        case .underlying(let error): return error.localizedDescription
        }
    }
}

/// ASWebAuthenticationSession wrapper for provider OAuth → `cheers://auth/callback`.
@MainActor
final class OAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
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
                        continuation.resume(throwing: OAuthError.cancelled)
                    } else {
                        continuation.resume(throwing: OAuthError.underlying(error))
                    }
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: OAuthError.cancelled)
                    return
                }
                continuation.resume(returning: callbackURL)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(
                    throwing: OAuthError.underlying(
                        NSError(
                            domain: "Cheers.OAuth",
                            code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "Could not start sign-in."]
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
