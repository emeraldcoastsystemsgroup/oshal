/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — shared app model: the selected tab + the last exported capture handed from the Scan screen to the Upload screen. Purpose: decouple capture from upload so each screen stays a focused view.
 */

import Foundation
import Combine

/// @description The captured-and-exported artifact produced when the user stops a
/// scan: the on-disk `.ply` (real merged ARKit mesh geometry) plus the pose
/// sidecar (poses.json-style, matching the swarm's `ScanPoses` shape). Passed from
/// the Scan screen to the Upload screen via `ScannerModel`.
struct CapturedScan: Identifiable {
    let id = UUID()
    /// On-disk ASCII `.ply` — merged world-space geometry of every ARMeshAnchor.
    let plyURL: URL
    /// On-disk poses.json sidecar (also embedded in the upload metadata).
    let posesURL: URL
    /// The parsed pose set, so the uploader can embed it in the metadata part.
    let poses: ScanPosesRecord
    /// Export tallies surfaced in the UI.
    let stats: PLYStats
    /// When the scan was captured (also the metadata `capturedAt`, ISO8601).
    let capturedAt: Date
    /// A default, editable scan name (used for the metadata `name` field).
    var suggestedName: String
}

/// @description App-wide observable state shared across the tab flow. Holds the
/// current tab and the most recently exported capture. All mutations happen on the
/// main thread (UI events + `MainActor.run` blocks after export), so its published
/// properties are always updated on the main run loop.
final class ScannerModel: ObservableObject {
    /// The tabs, hashable so they can be `TabView` tags.
    enum Tab: Hashable { case pair, scan, upload }

    /// Currently selected tab.
    @Published var selectedTab: Tab = .pair

    /// The last capture the user exported (nil until a scan is stopped + exported).
    @Published var lastCapture: CapturedScan?

    /// @description Record a freshly exported capture and jump to the Upload tab.
    /// @param capture The exported scan (ply + poses + stats).
    func present(_ capture: CapturedScan) {
        lastCapture = capture
        selectedTab = .upload
    }
}
