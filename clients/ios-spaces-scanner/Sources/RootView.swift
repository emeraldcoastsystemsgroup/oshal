/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — root tab flow (Pair -> Scan -> Upload). Purpose: the top-level SwiftUI container that owns the ScannerModel and wires the three screens.
 */

import SwiftUI

/// @description The top-level three-tab flow: Pair (host + token), Scan (ARKit
/// LiDAR capture), Upload (export + import to the swarm). Owns the shared
/// `ScannerModel` so the captured scan produced on the Scan tab is visible to the
/// Upload tab, and so the Scan tab can programmatically advance to Upload.
struct RootView: View {
    @EnvironmentObject private var pairing: PairingStore
    @StateObject private var model = ScannerModel()

    var body: some View {
        TabView(selection: $model.selectedTab) {
            PairView()
                .tabItem { Label("Pair", systemImage: "link") }
                .tag(ScannerModel.Tab.pair)

            ScanView()
                .tabItem { Label("Scan", systemImage: "cube.transparent") }
                .tag(ScannerModel.Tab.scan)

            UploadView()
                .tabItem { Label("Upload", systemImage: "arrow.up.circle") }
                .tag(ScannerModel.Tab.upload)
        }
        .environmentObject(model)
    }
}
