/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — SwiftUI bridge for the RealityKit ARView. Purpose: host the AR session view and hand it to the capture controller (which turns on the reconstructed-mesh overlay).
 */

import SwiftUI
import RealityKit

/// @description Wraps a RealityKit `ARView` for SwiftUI and attaches it to the
/// `ARCaptureController`. The controller owns the session lifecycle (run/pause) and
/// enables the scene-understanding debug overlay, so this container only builds the
/// view and wires the delegate once.
struct ARViewContainer: UIViewRepresentable {
    let controller: ARCaptureController

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero)
        controller.attach(view)
        return view
    }

    func updateUIView(_ uiView: ARView, context: Context) {
        // Session state is driven imperatively via the controller's start()/stop();
        // nothing to reconcile here.
    }
}
