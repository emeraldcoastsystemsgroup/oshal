/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 pose persistence (increment A), device side — build + write the poses.json sidecar. Purpose: hand the swarm per-keyframe camera-to-world poses + intrinsics in the exact ScanPoses shape (matches scripts/spatial-recon-edge/poses.py: quat is (w,x,y,z), center is the camera-to-world translation).
 */

import Foundation

// The wire types below mirror src/features/spatial-mapping/model/pose-types.ts
// and the box-side scripts/spatial-recon-edge/poses.py output BYTE-FOR-BYTE, so
// the swarm parses this sidecar with no adapter. Do not rename the fields.

/// @description The coordinate frame the poses (and any reconstructed geometry)
/// share. For an ARKit LiDAR capture the frame is already metric + gravity-aligned,
/// which is why `metric`/`gravityAligned` are true and `scaleSource` is `arkit`
/// (contrast the COLMAP/nerfstudio path, which ships `metric:false, scaleSource:none`).
struct WorldFrameRecord: Codable {
    /// ARKit's camera convention is +X right, +Y up, +Z toward the viewer — the
    /// OpenGL/Blender convention nerfstudio also uses, so `opengl` here.
    let convention: String
    /// ARKit world tracking is in meters -> true (COLMAP is scale-free -> false).
    let metric: Bool
    /// Where metric scale came from. `arkit` = the device's own metric poses.
    let scaleSource: String
    /// Multiply raw units by this to get meters. ARKit is already meters -> 1.0.
    let scale: Double
    /// ARKit gravity-aligns the world so +Y is up -> true.
    let gravityAligned: Bool
    /// The up axis in the world frame.
    let upAxis: String

    /// The frame every ARKit LiDAR capture is expressed in.
    static let arkit = WorldFrameRecord(
        convention: "opengl",
        metric: true,
        scaleSource: "arkit",
        scale: 1.0,
        gravityAligned: true,
        upAxis: "y"
    )
}

/// @description One keyframe's camera pose (camera-to-world) + pinhole intrinsics,
/// expressed in the scan's `WorldFrameRecord`. Encoded with an explicit
/// `imageRef` (null when there is no stored frame image, as in a live LiDAR
/// capture) to match the box-side sidecar exactly.
struct KeyframePoseRecord: Codable {
    let index: Int
    /// Stored frame filename for relocalization, or null for live LiDAR capture.
    let imageRef: String?
    /// Camera-to-world center C = translation column of the camera transform.
    let center: [Double]
    /// Camera orientation as (w, x, y, z) — matches poses.py `_mat_to_quat`.
    let quat: [Double]
    let fx: Double
    let fy: Double
    let cx: Double
    let cy: Double
    let width: Int
    let height: Int

    enum CodingKeys: String, CodingKey {
        case index, imageRef, center, quat, fx, fy, cx, cy, width, height
    }

    /// Custom encode so a nil `imageRef` is written as an explicit JSON `null`
    /// (the default synthesized encoder would omit the key); the box emits null.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(index, forKey: .index)
        try c.encode(imageRef, forKey: .imageRef)
        try c.encode(center, forKey: .center)
        try c.encode(quat, forKey: .quat)
        try c.encode(fx, forKey: .fx)
        try c.encode(fy, forKey: .fy)
        try c.encode(cx, forKey: .cx)
        try c.encode(cy, forKey: .cy)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
    }
}

/// @description The full pose set for one scan: its frame + every sampled keyframe.
struct ScanPosesRecord: Codable {
    let scanId: String
    let frame: WorldFrameRecord
    let keyframes: [KeyframePoseRecord]
}

/// @description Builds and writes the poses.json sidecar. Pure serialization —
/// the keyframes are sampled by `ARCaptureController` from live `ARFrame`s.
enum PoseSidecarWriter {
    /// @description Assemble the `ScanPosesRecord` for a capture.
    /// @param scanId A client-side scan id (the server assigns its own on import).
    /// @param keyframes The sampled per-keyframe poses.
    /// @returns The pose record ready to write and/or embed in upload metadata.
    static func build(scanId: String, keyframes: [KeyframePoseRecord]) -> ScanPosesRecord {
        ScanPosesRecord(scanId: scanId, frame: .arkit, keyframes: keyframes)
    }

    /// @description Write the pose record as pretty JSON to disk.
    /// @param poses The record to serialize.
    /// @param url Destination file URL (e.g. a temp `poses.json`).
    /// @throws Encoding or file-write errors.
    static func write(_ poses: ScanPosesRecord, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        let data = try encoder.encode(poses)
        try data.write(to: url, options: .atomic)
    }
}
