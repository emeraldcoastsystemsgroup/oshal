/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — the real ARMeshGeometry -> ASCII PLY exporter. Purpose: parse every ARMeshAnchor's vertex/normal/index MTLBuffers, transform vertices into the ARKit world frame, merge all anchors, and write a valid PLY. No stubbed geometry (CLAUDE.md: no mock/stub deliverables).
 */

import Foundation
import ARKit
import Metal
import simd

/// @description Tally of what an export produced, surfaced in the UI + metadata.
struct PLYStats {
    let anchorCount: Int
    let vertexCount: Int
    let faceCount: Int
}

/// @description Errors the exporter can raise.
enum PLYExportError: LocalizedError {
    case noGeometry
    case unexpectedVertexFormat(MTLVertexFormat)
    case writeFailed(String)

    var errorDescription: String? {
        switch self {
        case .noGeometry:
            return "No mesh was captured yet. Walk the room until the overlay fills in, then stop."
        case .unexpectedVertexFormat(let f):
            return "Unexpected ARKit vertex format (\(f.rawValue)); expected float3."
        case .writeFailed(let why):
            return "Could not write the PLY file: \(why)"
        }
    }
}

/// @description Converts captured ARKit LiDAR mesh anchors into a single portable
/// ASCII `.ply` (point + face geometry with vertex normals). ASCII is chosen over
/// binary_little_endian on purpose: it is trivial to eyeball/diff and the OSHAL
/// import lane accepts ASCII or binary `.ply` equally — the extra bytes are a fair
/// trade for a scaffold you can verify by opening the file.
///
/// Buffer parsing is REAL, not stubbed:
///  - `ARMeshGeometry.vertices` is a `.float3` source; each vertex is read at
///    `offset + stride * i` as three contiguous floats (never reinterpreted as a
///    16-byte `SIMD3`, which would over-read a packed 12-byte stride).
///  - `ARMeshGeometry.normals` is read the same way (per-vertex).
///  - `ARMeshGeometry.faces` is a triangle index buffer; indices are read honoring
///    `bytesPerIndex` (UInt16 or UInt32) and `indexCountPerPrimitive`.
///  - Vertices are transformed by `anchor.transform` (anchor-local -> ARKit world);
///    normals by the rotation (upper-left 3x3) only. ARKit anchor transforms are
///    rigid, so the 3x3 is orthonormal and no inverse-transpose is needed.
///  - All anchors are merged into one PLY; per-anchor vertex index offsets are
///    added to the face indices so the merged face list stays valid.
enum PLYExporter {

    /// @description Export the merged mesh of the given anchors to an ASCII PLY.
    /// @param anchors The retained `ARMeshAnchor`s to merge (their MTLBuffers must
    ///        still be valid — export before reconfiguring the session).
    /// @param url Destination `.ply` file URL.
    /// @returns Tally of anchors/vertices/faces written.
    /// @throws `PLYExportError` on empty input, a surprise vertex format, or IO.
    @discardableResult
    static func export(anchors: [ARMeshAnchor], to url: URL) throws -> PLYStats {
        // Per-anchor vertex-index offset (prefix sum) so merged faces stay valid,
        // and the totals the PLY header must declare up front.
        var vertexOffsets: [Int] = []
        var totalVertices = 0
        var totalFaces = 0
        for anchor in anchors {
            // ARKit mesh vertices are packed float3; bail loudly if that ever changes
            // rather than silently mis-parsing the buffer.
            let format = anchor.geometry.vertices.format
            guard format == .float3 else { throw PLYExportError.unexpectedVertexFormat(format) }
            vertexOffsets.append(totalVertices)
            totalVertices += anchor.geometry.vertices.count
            totalFaces += anchor.geometry.faces.count
        }
        guard totalVertices > 0 else { throw PLYExportError.noGeometry }

        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let handle = try? FileHandle(forWritingTo: url) else {
            throw PLYExportError.writeFailed("could not open \(url.lastPathComponent) for writing")
        }
        defer { try? handle.close() }

        do {
            try handle.write(contentsOf: Data(header(vertices: totalVertices, faces: totalFaces).utf8))
            // Vertex block first (PLY requires all vertices before all faces).
            for anchor in anchors {
                try handle.write(contentsOf: Data(vertexBlock(for: anchor).utf8))
            }
            // Then the face block, offsetting each anchor's indices into merged space.
            for (i, anchor) in anchors.enumerated() {
                let block = faceBlock(for: anchor, vertexOffset: vertexOffsets[i])
                try handle.write(contentsOf: Data(block.utf8))
            }
        } catch let error as PLYExportError {
            throw error
        } catch {
            throw PLYExportError.writeFailed(error.localizedDescription)
        }

        return PLYStats(anchorCount: anchors.count, vertexCount: totalVertices, faceCount: totalFaces)
    }

    // MARK: - PLY text

    /// The ASCII PLY header for the merged totals (vertex xyz + normal, and faces).
    private static func header(vertices: Int, faces: Int) -> String {
        """
        ply
        format ascii 1.0
        comment Generated by OSHAL Spaces iOS Scanner (ARKit LiDAR mesh)
        comment Frame: ARKit world (meters, gravity-aligned, +Y up)
        element vertex \(vertices)
        property float x
        property float y
        property float z
        property float nx
        property float ny
        property float nz
        element face \(faces)
        property list uchar int vertex_indices
        end_header

        """
    }

    /// @description Build the vertex lines (world-space position + world-space
    /// normal) for one anchor by reading its vertex/normal MTLBuffers directly.
    private static func vertexBlock(for anchor: ARMeshAnchor) -> String {
        let geometry = anchor.geometry
        let vertices = geometry.vertices
        let normals = geometry.normals
        let transform = anchor.transform
        let normalRot = rotation(of: transform)

        let vBase = vertices.buffer.contents()
        let nBase = normals.buffer.contents()

        var out = String()
        out.reserveCapacity(vertices.count * 56)
        for i in 0..<vertices.count {
            let localV = readFloat3(vBase, offset: vertices.offset, stride: vertices.stride, index: i)
            let localN = readFloat3(nBase, offset: normals.offset, stride: normals.stride, index: i)
            let worldV = transformPoint(transform, localV)
            let worldN = simd_normalize(normalRot * localN)
            out += "\(fmt(worldV.x)) \(fmt(worldV.y)) \(fmt(worldV.z)) "
            out += "\(fmt(worldN.x)) \(fmt(worldN.y)) \(fmt(worldN.z))\n"
        }
        return out
    }

    /// @description Build the face lines for one anchor, adding `vertexOffset` to
    /// every index so they point into the merged vertex list.
    private static func faceBlock(for anchor: ARMeshAnchor, vertexOffset: Int) -> String {
        let faces = anchor.geometry.faces
        let perFace = faces.indexCountPerPrimitive // 3 for ARKit triangles
        let base = faces.buffer.contents()

        var out = String()
        out.reserveCapacity(faces.count * 16)
        for f in 0..<faces.count {
            out += String(perFace)
            for k in 0..<perFace {
                let idx = readIndex(base, bytesPerIndex: faces.bytesPerIndex, at: f * perFace + k)
                out += " \(Int(idx) + vertexOffset)"
            }
            out += "\n"
        }
        return out
    }

    // MARK: - Buffer reads

    /// Read a packed float3 at `offset + stride * index` as three contiguous
    /// floats. Reading three `Float`s (not a `SIMD3<Float>`) is deliberate: a
    /// `.float3` source is 12 bytes packed and `SIMD3<Float>` has 16-byte layout,
    /// so a bitcast would over-read the final element.
    private static func readFloat3(_ base: UnsafeMutableRawPointer, offset: Int, stride: Int, index: Int) -> SIMD3<Float> {
        let p = base.advanced(by: offset + stride * index).assumingMemoryBound(to: Float.self)
        return SIMD3<Float>(p[0], p[1], p[2])
    }

    /// Read one triangle index honoring the element's index width (UInt16/UInt32).
    private static func readIndex(_ base: UnsafeMutableRawPointer, bytesPerIndex: Int, at i: Int) -> UInt32 {
        if bytesPerIndex == 2 {
            return UInt32(base.advanced(by: i * 2).assumingMemoryBound(to: UInt16.self).pointee)
        }
        return base.advanced(by: i * 4).assumingMemoryBound(to: UInt32.self).pointee
    }

    // MARK: - Math

    /// Transform an anchor-local point into ARKit world space.
    private static func transformPoint(_ m: simd_float4x4, _ p: SIMD3<Float>) -> SIMD3<Float> {
        let r = m * SIMD4<Float>(p.x, p.y, p.z, 1)
        return SIMD3<Float>(r.x, r.y, r.z)
    }

    /// The rotation (upper-left 3x3) of a rigid transform, for rotating normals.
    private static func rotation(of m: simd_float4x4) -> simd_float3x3 {
        simd_float3x3(
            SIMD3<Float>(m.columns.0.x, m.columns.0.y, m.columns.0.z),
            SIMD3<Float>(m.columns.1.x, m.columns.1.y, m.columns.1.z),
            SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        )
    }

    /// Fixed 6-decimal formatting — enough for millimetre-scale room geometry.
    private static func fmt(_ x: Float) -> String {
        String(format: "%.6f", x)
    }
}
