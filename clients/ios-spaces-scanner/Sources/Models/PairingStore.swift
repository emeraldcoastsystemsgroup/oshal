/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — observable pairing state over the Keychain store. Purpose: expose host URL + paired flag to SwiftUI while keeping the bearer token in Keychain (never published/logged).
 */

import Foundation
import Combine

/// @description Observable pairing state for the app: the OSHAL host URL and
/// whether a device-pairing token is present. The token itself is intentionally
/// NOT `@Published` (and never logged) — it stays in the Keychain and is read only
/// at upload time via `bearerToken()`. `hostURL` and `isPaired` drive the UI. All
/// mutation happens on the main thread (UI events).
final class PairingStore: ObservableObject {
    /// The configured OSHAL base URL (e.g. `https://oshal.example.com`), or "".
    @Published private(set) var hostURL: String = ""
    /// True when both a host URL and a token are stored.
    @Published private(set) var isPaired: Bool = false

    private let keychain = KeychainTokenStore()

    init() {
        hostURL = keychain.get(.host) ?? ""
        isPaired = !hostURL.isEmpty && (keychain.get(.token)?.isEmpty == false)
    }

    /// @description Persist a host + token pair, trimming whitespace and a trailing
    /// slash on the host so URL building is consistent.
    /// @param host The OSHAL base URL.
    /// @param token The device-pairing bearer token.
    /// @throws `PairingError.invalid` when host or token is empty/malformed.
    func save(host: String, token: String) throws {
        let normalizedHost = Self.normalizeHost(host)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: normalizedHost), url.scheme?.hasPrefix("http") == true,
              !trimmedToken.isEmpty else {
            throw PairingError.invalid
        }
        keychain.set(normalizedHost, for: .host)
        keychain.set(trimmedToken, for: .token)
        hostURL = normalizedHost
        isPaired = true
    }

    /// @description Forget the stored pairing (host + token).
    func clear() {
        keychain.delete(.host)
        keychain.delete(.token)
        hostURL = ""
        isPaired = false
    }

    /// @description The bearer token for an upload request. Read on demand from the
    /// Keychain; never cached in a published property.
    /// @returns The token, or nil when unpaired.
    func bearerToken() -> String? {
        let token = keychain.get(.token)
        return (token?.isEmpty == false) ? token : nil
    }

    /// @description The resolved import endpoint URL for the current host.
    /// @returns `<host>/api/spaces/scans/import`, or nil when unpaired.
    func importEndpoint() -> URL? {
        guard !hostURL.isEmpty else { return nil }
        return URL(string: hostURL)?.appendingPathComponent("api/spaces/scans/import")
    }

    /// Strip whitespace + a trailing slash so `appendingPathComponent` is clean.
    private static func normalizeHost(_ raw: String) -> String {
        var host = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while host.hasSuffix("/") { host.removeLast() }
        return host
    }
}

/// @description Errors surfaced by the pairing flow.
enum PairingError: LocalizedError {
    case invalid

    var errorDescription: String? {
        switch self {
        case .invalid:
            return "Enter a valid https host URL and a non-empty pairing token."
        }
    }
}
