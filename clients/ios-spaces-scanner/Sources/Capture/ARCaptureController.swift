/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — ARKit scene-reconstruction capture controller. Purpose: drive the LiDAR mesh session, keep the live vertex/anchor counts + sampled camera poses, and export the captured mesh (.ply) + pose sidecar. Guards LiDAR availability.
 */

import Foundation
import Combine
import ARKit
import RealityKit
import simd

/// @description Owns the ARKit LiDAR capture session and exposes its live state to
/// SwiftUI. It configures `ARWorldTrackingConfiguration` with scene reconstruction
/// (`.meshWithClassification` when available, else `.mesh`), retains every
/// `ARMeshAnchor` so its geometry survives to export time, and samples per-keyframe
/// camera poses (camera-to-world transform + intrinsics) from the frame stream.
///
/// ARKit poses are already **metric and gravity-aligned** — the reason a native
/// LiDAR app exists — so no scale/gravity solve is needed; the pose sidecar ships
/// `metric:true, scaleSource:"arkit"`.
final class ARCaptureController: NSObject, ObservableObject, ARSessionDelegate {

    /// True on LiDAR devices that support scene reconstruction (iPhone/iPad Pro).
    @Published private(set) var lidarSupported: Bool = false
    /// True while a capture session is running.
    @Published private(set) var isScanning: Bool = false
    /// Live count of retained mesh anchors.
    @Published private(set) var anchorCount: Int = 0
    /// Live sum of vertices across all mesh anchors.
    @Published private(set) var vertexCount: Int = 0
    /// Number of camera poses sampled so far.
    @Published private(set) var poseCount: Int = 0
    /// A human-readable AR session error, if one occurred.
    @Published private(set) var sessionError: String?

    /// The RealityKit view whose session we drive (set by the SwiftUI container).
    weak var arView: ARView?

    /// Retained mesh anchors keyed by identifier; guarded by `lock`.
    private var meshAnchors: [UUID: ARMeshAnchor] = [:]
    /// Sampled poses; guarded by `lock`.
    private var keyframes: [KeyframePoseRecord] = []
    private let lock = NSLock()

    /// Pose sampling throttle — one keyframe at most this often (seconds).
    private let sampleInterval: TimeInterval = 0.4
    /// Cap on sampled keyframes so the sidecar stays small.
    private let maxKeyframes = 600
    private var lastSampleTimestamp: TimeInterval = 0
    private var captureStartedAt = Date()

    override init() {
        super.init()
        lidarSupported = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    // MARK: - Session lifecycle

    /// @description Attach a RealityKit view: become its session delegate and turn
    /// on the reconstructed-mesh debug overlay so the user sees the map fill in.
    /// @param view The `ARView` created by the SwiftUI container.
    func attach(_ view: ARView) {
        arView = view
        view.session.delegate = self
        view.debugOptions.insert(.showSceneUnderstanding)
        view.automaticallyConfigureSession = false
    }

    /// @description Start (or restart) a LiDAR scan, resetting tracking + anchors.
    func start() {
        guard let session = arView?.session, let config = makeConfiguration() else {
            sessionError = "This device does not support LiDAR scene reconstruction."
            return
        }
        resetState()
        captureStartedAt = Date()
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        isScanning = true
    }

    /// @description Stop the scan (pause the session). Retained anchors stay valid
    /// for export because the session is not reconfigured.
    func stop() {
        arView?.session.pause()
        isScanning = false
    }

    /// Build a scene-reconstruction configuration, preferring classified mesh.
    private func makeConfiguration() -> ARWorldTrackingConfiguration? {
        guard ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) else { return nil }
        let config = ARWorldTrackingConfiguration()
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
            config.sceneReconstruction = .meshWithClassification
        } else {
            config.sceneReconstruction = .mesh
        }
        config.environmentTexturing = .none
        config.worldAlignment = .gravity // +Y up, metric — matches the pose sidecar frame
        return config
    }

    private func resetState() {
        lock.lock()
        meshAnchors.removeAll()
        keyframes.removeAll()
        lock.unlock()
        lastSampleTimestamp = 0
        publish { self.anchorCount = 0; self.vertexCount = 0; self.poseCount = 0; self.sessionError = nil }
    }

    // MARK: - Export

    /// @description Snapshot the retained anchors + sampled poses and write both a
    /// merged ASCII `.ply` and a `poses.json` sidecar to a temp directory.
    /// Runs the buffer parsing/serialization synchronously; call it off the main
    /// thread (the caller shows a progress state).
    /// @returns The exported capture (ply + poses + tallies).
    /// @throws `PLYExportError` when nothing was captured or IO fails.
    func exportCapture() throws -> CapturedScan {
        lock.lock()
        let anchors = Array(meshAnchors.values)
        let frames = keyframes
        lock.unlock()

        let scanId = UUID().uuidString
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("scan-\(scanId)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let plyURL = dir.appendingPathComponent("scan.ply")
        let posesURL = dir.appendingPathComponent("poses.json")

        let stats = try PLYExporter.export(anchors: anchors, to: plyURL)
        let poses = PoseSidecarWriter.build(scanId: scanId, keyframes: frames)
        try PoseSidecarWriter.write(poses, to: posesURL)

        let name = "Room scan \(Self.nameStamp.string(from: captureStartedAt))"
        return CapturedScan(
            plyURL: plyURL,
            posesURL: posesURL,
            poses: poses,
            stats: stats,
            capturedAt: captureStartedAt,
            suggestedName: name
        )
    }

    // MARK: - ARSessionDelegate

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { ingest(anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { ingest(anchors) }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        lock.lock()
        for anchor in anchors { meshAnchors[anchor.identifier] = nil }
        lock.unlock()
        publishCounts()
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        samplePose(from: frame)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        publish { self.sessionError = error.localizedDescription; self.isScanning = false }
    }

    // MARK: - Ingest + sampling

    /// Retain the mesh anchors from a delegate batch and refresh the live counts.
    private func ingest(_ anchors: [ARAnchor]) {
        var changed = false
        lock.lock()
        for case let mesh as ARMeshAnchor in anchors {
            meshAnchors[mesh.identifier] = mesh
            changed = true
        }
        lock.unlock()
        if changed { publishCounts() }
    }

    /// Sample a keyframe pose (throttled) from the current frame's camera.
    private func samplePose(from frame: ARFrame) {
        guard isScanning else { return }
        let ts = frame.timestamp
        guard ts - lastSampleTimestamp >= sampleInterval else { return }
        lock.lock()
        guard keyframes.count < maxKeyframes else { lock.unlock(); return }
        let record = Self.keyframe(index: keyframes.count, camera: frame.camera)
        keyframes.append(record)
        let count = keyframes.count
        lock.unlock()
        lastSampleTimestamp = ts
        publish { self.poseCount = count }
    }

    /// Recompute + publish the anchor/vertex tallies from the retained anchors.
    private func publishCounts() {
        lock.lock()
        let anchors = meshAnchors.count
        let vertices = meshAnchors.values.reduce(0) { $0 + $1.geometry.vertices.count }
        lock.unlock()
        publish { self.anchorCount = anchors; self.vertexCount = vertices }
    }

    // MARK: - Pose math

    /// Convert an `ARCamera` to a `KeyframePoseRecord` (camera-to-world center +
    /// wxyz quaternion + pinhole intrinsics for the captured image resolution).
    private static func keyframe(index: Int, camera: ARCamera) -> KeyframePoseRecord {
        let t = camera.transform
        let center = [Double(t.columns.3.x), Double(t.columns.3.y), Double(t.columns.3.z)]
        let rot = simd_float3x3(
            SIMD3<Float>(t.columns.0.x, t.columns.0.y, t.columns.0.z),
            SIMD3<Float>(t.columns.1.x, t.columns.1.y, t.columns.1.z),
            SIMD3<Float>(t.columns.2.x, t.columns.2.y, t.columns.2.z)
        )
        let q = simd_quatf(rot)
        // wxyz to match scripts/spatial-recon-edge/poses.py `_mat_to_quat`.
        let quat = [Double(q.real), Double(q.imag.x), Double(q.imag.y), Double(q.imag.z)]

        let k = camera.intrinsics // column-major: fx=col0.x, fy=col1.y, cx=col2.x, cy=col2.y
        let res = camera.imageResolution
        return KeyframePoseRecord(
            index: index,
            imageRef: nil, // live LiDAR capture stores no per-frame image
            center: center,
            quat: quat,
            fx: Double(k.columns.0.x),
            fy: Double(k.columns.1.y),
            cx: Double(k.columns.2.x),
            cy: Double(k.columns.2.y),
            width: Int(res.width),
            height: Int(res.height)
        )
    }

    // MARK: - Helpers

    /// Run a published-state mutation on the main actor (SwiftUI requirement).
    private func publish(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }

    private static let nameStamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, HH:mm"
        return f
    }()
}
