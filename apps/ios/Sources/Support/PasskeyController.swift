import AuthenticationServices
import Foundation
import UIKit

enum PasskeyError: LocalizedError {
    case cancelled
    case unavailable
    case invalidChallenge
    case unexpectedCredential
    case underlying(Error)

    var errorDescription: String? {
        switch self {
        case .cancelled: return "Passkey request was cancelled."
        case .unavailable: return "Passkeys are not available on this device."
        case .invalidChallenge: return "The server returned an invalid passkey challenge."
        case .unexpectedCredential: return "Unexpected passkey credential type."
        case .underlying(let error): return error.localizedDescription
        }
    }
}

/// Thin async wrapper around AuthenticationServices passkey register / assert sheets.
@MainActor
final class PasskeyController: NSObject {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?

    func register(
        rpId: String,
        challenge: Data,
        userId: Data,
        userName: String,
        displayName: String
    ) async throws -> ASAuthorizationPlatformPublicKeyCredentialRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: displayName.isEmpty ? userName : displayName,
            userID: userId
        )
        let auth = try await perform(request)
        guard let credential = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw PasskeyError.unexpectedCredential
        }
        return credential
    }

    func assert(
        rpId: String,
        challenge: Data,
        allowedCredentialIds: [Data]
    ) async throws -> ASAuthorizationPlatformPublicKeyCredentialAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        if !allowedCredentialIds.isEmpty {
            request.allowedCredentials = allowedCredentialIds.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        let auth = try await perform(request)
        guard let credential = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyError.unexpectedCredential
        }
        return credential
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }
}

extension PasskeyController: ASAuthorizationControllerDelegate {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        continuation?.resume(returning: authorization)
        continuation = nil
        self.controller = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            continuation?.resume(throwing: PasskeyError.cancelled)
        } else {
            continuation?.resume(throwing: PasskeyError.underlying(error))
        }
        continuation = nil
        self.controller = nil
    }
}

extension PasskeyController: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

enum PasskeyCodec {
    static func decodeBase64URL(_ value: String) throws -> Data {
        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let pad = 4 - base64.count % 4
        if pad < 4 { base64 += String(repeating: "=", count: pad) }
        guard let data = Data(base64Encoded: base64) else {
            throw PasskeyError.invalidChallenge
        }
        return data
    }

    static func encodeBase64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func registrationCredentialJSON(
        _ credential: ASAuthorizationPlatformPublicKeyCredentialRegistration
    ) -> [String: Any] {
        [
            "id": encodeBase64URL(credential.credentialID),
            "rawId": encodeBase64URL(credential.credentialID),
            "type": "public-key",
            "response": [
                "clientDataJSON": encodeBase64URL(credential.rawClientDataJSON),
                "attestationObject": encodeBase64URL(credential.rawAttestationObject ?? Data()),
                "transports": ["internal"],
            ] as [String: Any],
        ]
    }

    static func assertionCredentialJSON(
        _ credential: ASAuthorizationPlatformPublicKeyCredentialAssertion
    ) -> [String: Any] {
        var response: [String: Any] = [
            "clientDataJSON": encodeBase64URL(credential.rawClientDataJSON),
            "authenticatorData": encodeBase64URL(credential.rawAuthenticatorData),
            "signature": encodeBase64URL(credential.signature),
        ]
        if let handle = credential.userID {
            response["userHandle"] = encodeBase64URL(handle)
        }
        return [
            "id": encodeBase64URL(credential.credentialID),
            "rawId": encodeBase64URL(credential.credentialID),
            "type": "public-key",
            "response": response,
        ]
    }
}
