/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — native iOS LiDAR scanner app entry (SwiftUI @main). Owns the shared PairingStore and hosts the Pair/Scan/Upload flow. Purpose: capture an ARKit mesh of a room and import it to the OSHAL Spaces swarm.
 */

import SwiftUI

/// @description SwiftUI application entry point for the OSHAL Spaces LiDAR
/// scanner. Holds the app-wide `PairingStore` (host URL + device-pairing token,
/// backed by Keychain) so every screen can read the pairing state, and mounts
/// `RootView` (the Pair / Scan / Upload tab flow).
@main
struct SpacesScannerApp: App {
    /// App-wide pairing (host + bearer token). Created once, shared via the environment.
    @StateObject private var pairing = PairingStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(pairing)
        }
    }
}
