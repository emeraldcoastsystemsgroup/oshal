/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — Upload screen. Purpose: review the exported capture, name it, POST it to /api/spaces/scans/import with the bearer token, show upload progress, and surface the returned scanId or a readable error.
 */

import SwiftUI

/// @description The Upload screen: shows the exported capture's tallies, lets the
/// user name it, and imports it to the swarm. Reflects live upload progress and
/// the final `{ scanId, status }` (or a readable error). Disabled until a scan has
/// been captured and the device is paired.
struct UploadView: View {
    @EnvironmentObject private var model: ScannerModel
    @EnvironmentObject private var pairing: PairingStore

    private let client = ScanUploadClient()

    @State private var name: String = ""
    @State private var isUploading = false
    @State private var progress: Double = 0
    @State private var result: ScanImportResult?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                if let capture = model.lastCapture {
                    captureSection(capture)
                    nameSection
                    uploadSection(capture)
                    resultSection
                } else {
                    Section {
                        ContentUnavailableView(
                            "No scan yet",
                            systemImage: "cube.transparent",
                            description: Text("Capture a room on the Scan tab; it will appear here to upload.")
                        )
                    }
                }
            }
            .navigationTitle("Upload scan")
            .onChange(of: model.lastCapture?.id) { _, _ in
                name = model.lastCapture?.suggestedName ?? ""
                result = nil
                errorText = nil
                progress = 0
            }
            .onAppear {
                if name.isEmpty { name = model.lastCapture?.suggestedName ?? "" }
            }
        }
    }

    // MARK: - Sections

    private func captureSection(_ capture: CapturedScan) -> some View {
        Section("Captured mesh") {
            LabeledContent("Anchors", value: "\(capture.stats.anchorCount)")
            LabeledContent("Vertices", value: "\(capture.stats.vertexCount)")
            LabeledContent("Faces", value: "\(capture.stats.faceCount)")
            LabeledContent("Poses", value: "\(capture.poses.keyframes.count)")
            LabeledContent("File", value: capture.plyURL.lastPathComponent)
        }
    }

    private var nameSection: some View {
        Section("Name") {
            TextField("Scan name", text: $name)
        }
    }

    private func uploadSection(_ capture: CapturedScan) -> some View {
        Section {
            if isUploading {
                VStack(alignment: .leading, spacing: 8) {
                    ProgressView(value: progress)
                    Text("Uploading… \(Int(progress * 100))%").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Button {
                    upload(capture)
                } label: {
                    Label("Upload to OSHAL", systemImage: "arrow.up.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!pairing.isPaired)
            }
            if !pairing.isPaired {
                Text("Pair the device first (Pair tab).").font(.caption).foregroundStyle(.orange)
            }
        }
    }

    @ViewBuilder
    private var resultSection: some View {
        if let result {
            Section("Result") {
                LabeledContent("Scan ID", value: result.scanId)
                LabeledContent("Status", value: result.status)
                Text("Imported. Open ?app=spaces in the cockpit to watch it reconstruct.")
                    .font(.caption).foregroundStyle(.green)
            }
        }
        if let errorText {
            Section("Error") {
                Text(errorText).foregroundStyle(.red)
            }
        }
    }

    // MARK: - Actions

    /// Resolve the endpoint + token and run the multipart import.
    private func upload(_ capture: CapturedScan) {
        guard let endpoint = pairing.importEndpoint(), let token = pairing.bearerToken() else {
            errorText = UploadError.notPaired.localizedDescription
            return
        }
        isUploading = true
        progress = 0
        errorText = nil
        result = nil
        Task {
            do {
                let imported = try await client.importScan(
                    capture: capture,
                    name: name,
                    endpoint: endpoint,
                    token: token,
                    onProgress: { progress = $0 }
                )
                await MainActor.run {
                    isUploading = false
                    result = imported
                }
            } catch {
                await MainActor.run {
                    isUploading = false
                    errorText = error.localizedDescription
                }
            }
        }
    }
}
