/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — Scan screen. Purpose: run the ARKit LiDAR session with a live mesh overlay + vertex/anchor counter, guard unsupported (non-LiDAR) devices, and export the captured mesh + poses on stop.
 */

import SwiftUI

/// @description The Scan screen: a live AR view (RealityKit mesh overlay) with a
/// start/stop control and a live vertex/anchor/pose counter. On unsupported
/// (non-LiDAR) devices it shows a clear message instead of the camera. Stopping a
/// scan exports the merged `.ply` + `poses.json` and advances to the Upload tab.
struct ScanView: View {
    @EnvironmentObject private var model: ScannerModel
    @StateObject private var controller = ARCaptureController()

    @State private var isExporting = false
    @State private var exportError: String?

    var body: some View {
        NavigationStack {
            Group {
                if controller.lidarSupported {
                    scannerBody
                } else {
                    unsupported
                }
            }
            .navigationTitle("Scan room")
        }
    }

    // MARK: - Supported device

    private var scannerBody: some View {
        ZStack(alignment: .top) {
            ARViewContainer(controller: controller)
                .ignoresSafeArea()

            statsBar
                .padding()

            VStack {
                Spacer()
                controls.padding()
            }
        }
    }

    private var statsBar: some View {
        HStack(spacing: 16) {
            stat("Anchors", controller.anchorCount)
            stat("Vertices", controller.vertexCount)
            stat("Poses", controller.poseCount)
        }
        .padding(.vertical, 8).padding(.horizontal, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func stat(_ label: String, _ value: Int) -> some View {
        VStack {
            Text("\(value)").font(.headline.monospacedDigit())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if let exportError {
                Text(exportError).foregroundStyle(.red)
                    .padding(8).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
            }
            if isExporting {
                ProgressView("Exporting mesh…")
                    .padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            } else if controller.isScanning {
                Button(role: .destructive) { stopAndExport() } label: {
                    Label("Stop & export", systemImage: "stop.circle.fill")
                        .font(.title3).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            } else {
                Button { controller.start() } label: {
                    Label("Start scan", systemImage: "play.circle.fill")
                        .font(.title3).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            Text("Walk slowly around the room; keep surfaces in view until the mesh fills in.")
                .font(.caption).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(8).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    // MARK: - Unsupported device

    private var unsupported: some View {
        ContentUnavailableView {
            Label("LiDAR required", systemImage: "sensor.tag.radiowaves.forward")
        } description: {
            Text("This device has no LiDAR scanner, so ARKit scene reconstruction is unavailable. "
                 + "Use an iPhone Pro / iPad Pro (2020 or later) to capture a 3D room mesh.")
        }
    }

    // MARK: - Actions

    /// Stop the session, then export the mesh + poses off the main thread and hand
    /// the result to the shared model (which advances to the Upload tab).
    private func stopAndExport() {
        controller.stop()
        isExporting = true
        exportError = nil
        Task {
            do {
                let capture = try await Task.detached(priority: .userInitiated) {
                    try controller.exportCapture()
                }.value
                await MainActor.run {
                    isExporting = false
                    model.present(capture)
                }
            } catch {
                await MainActor.run {
                    isExporting = false
                    exportError = error.localizedDescription
                }
            }
        }
    }
}
