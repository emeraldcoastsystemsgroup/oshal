/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — multipart URLSession client for POST /api/spaces/scans/import. Purpose: stream the .ply + a JSON metadata part to the swarm with a Bearer token, report upload progress, and surface { scanId, status } / readable errors.
 */

import Foundation
import UIKit

// ---------------------------------------------------------------------------
// CONTRACT / RECONCILIATION KNOBS (see README "Ingest contract").
// The server side of POST /api/spaces/scans/import is built concurrently by
// another agent. These field names are the reconciliation points; change them
// here (one place) if the server's final contract differs.
//   - kFileFieldName defaults to "model" to match the EXISTING import route
//     (src/app/routes/spaces-routes.ts uses multer .single('model') per
//     docs/architecture/spatial-capture-playbook.md). The task's generic contract
//     just says "the .ply file part"; "model" is the safe, already-shipped name.
//   - kMetadataFieldName carries the JSON metadata part from the task contract.
//   - A plain "title" text part is ALSO sent (mirrors metadata.name) so the
//     existing route — which reads req.body.title — names the scan even if it does
//     not yet parse the JSON metadata part. Harmless to a server that ignores it.
// ---------------------------------------------------------------------------

/// The multipart field name for the `.ply` binary part.
private let kFileFieldName = "model"
/// The multipart field name for the JSON metadata part.
private let kMetadataFieldName = "metadata"
/// A plain-text scan-name part for back-compat with the existing import route.
private let kTitleFieldName = "title"

/// @description The metadata JSON part sent alongside the `.ply`. `sourceKind`
/// is fixed to `lidar-ios`; `poses` optionally embeds the full `ScanPoses` so the
/// swarm can reconcile a metric, gravity-aligned frame without a second request.
struct ScanImportMetadata: Encodable {
    let name: String
    let sourceKind: String
    let capturedAt: String   // ISO8601
    let deviceModel: String
    let client: String
    let mesh: MeshSummary
    let poses: ScanPosesRecord?

    struct MeshSummary: Encodable {
        let anchorCount: Int
        let vertexCount: Int
        let faceCount: Int
    }
}

/// @description The server's import response. Parsed leniently: the task contract
/// is `{ scanId, status }`; the existing route returns `{ scan: { id, status } }`.
/// Either shape yields a scan id + status.
struct ScanImportResult {
    let scanId: String
    let status: String
}

/// @description Errors surfaced by the upload flow, each with a user-readable message.
enum UploadError: LocalizedError {
    case notPaired
    case missingFile
    case http(status: Int, body: String)
    case unreadableResponse(String)

    var errorDescription: String? {
        switch self {
        case .notPaired:
            return "Not paired. Add your OSHAL host URL and pairing token on the Pair tab first."
        case .missingFile:
            return "The exported .ply file is missing. Re-run the scan and export."
        case .http(let status, let body):
            return "Server returned HTTP \(status). \(body)"
        case .unreadableResponse(let detail):
            return "The server response could not be read: \(detail)"
        }
    }
}

/// @description Uploads a captured scan to the OSHAL Spaces swarm as
/// `multipart/form-data` (the `.ply` file part + a JSON metadata part) with a
/// `Authorization: Bearer <token>` header. Streams the body from a temp file via
/// `URLSession.upload(for:fromFile:delegate:)` so a large mesh is not held in RAM,
/// and reports send progress through the delegate.
final class ScanUploadClient {

    /// @description Import a captured scan.
    /// @param capture The exported scan (ply + poses + stats).
    /// @param name The user-chosen scan name (metadata `name`).
    /// @param endpoint The resolved `/api/spaces/scans/import` URL.
    /// @param token The device-pairing bearer token.
    /// @param onProgress Called on the main thread with 0.0...1.0 upload fraction.
    /// @returns The server's `{ scanId, status }`.
    /// @throws `UploadError` on a missing file, non-2xx, or an unreadable response.
    func importScan(
        capture: CapturedScan,
        name: String,
        endpoint: URL,
        token: String,
        onProgress: @escaping (Double) -> Void
    ) async throws -> ScanImportResult {
        guard FileManager.default.fileExists(atPath: capture.plyURL.path) else {
            throw UploadError.missingFile
        }

        let metadata = ScanImportMetadata(
            name: name.isEmpty ? capture.suggestedName : name,
            sourceKind: "lidar-ios",
            capturedAt: ISO8601DateFormatter().string(from: capture.capturedAt),
            deviceModel: DeviceInfo.modelIdentifier,
            client: "oshal-ios-spaces-scanner/0.1",
            mesh: .init(
                anchorCount: capture.stats.anchorCount,
                vertexCount: capture.stats.vertexCount,
                faceCount: capture.stats.faceCount
            ),
            poses: capture.poses
        )

        let boundary = "oshal.\(UUID().uuidString)"
        let bodyURL = try buildBody(plyURL: capture.plyURL, metadata: metadata, boundary: boundary)
        defer { try? FileManager.default.removeItem(at: bodyURL) }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let progress = UploadProgressDelegate(onProgress: onProgress)
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: bodyURL, delegate: progress)

        guard let http = response as? HTTPURLResponse else {
            throw UploadError.unreadableResponse("no HTTP status")
        }
        let bodyText = String(data: data, encoding: .utf8) ?? ""
        guard (200...299).contains(http.statusCode) else {
            throw UploadError.http(status: http.statusCode, body: Self.readableError(bodyText))
        }
        return try Self.parseResult(data: data, fallbackBody: bodyText)
    }

    // MARK: - Body building

    /// @description Assemble the multipart body to a temp file: the JSON metadata
    /// part, then the `.ply` file part streamed in 1 MB chunks (never fully in RAM).
    /// @returns The temp file URL of the assembled body.
    private func buildBody(plyURL: URL, metadata: ScanImportMetadata, boundary: String) throws -> URL {
        let bodyURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("upload-\(UUID().uuidString).multipart")
        FileManager.default.createFile(atPath: bodyURL.path, contents: nil)
        let handle = try FileHandle(forWritingTo: bodyURL)
        defer { try? handle.close() }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let metadataJSON = try encoder.encode(metadata)

        // Plain-text title part (back-compat with the existing route's req.body.title).
        var titlePart = "--\(boundary)\r\n"
        titlePart += "Content-Disposition: form-data; name=\"\(kTitleFieldName)\"\r\n\r\n"
        titlePart += metadata.name
        try handle.write(contentsOf: Data(titlePart.utf8))

        var preamble = "\r\n--\(boundary)\r\n"
        preamble += "Content-Disposition: form-data; name=\"\(kMetadataFieldName)\"\r\n"
        preamble += "Content-Type: application/json\r\n\r\n"
        try handle.write(contentsOf: Data(preamble.utf8))
        try handle.write(contentsOf: metadataJSON)

        var fileHeader = "\r\n--\(boundary)\r\n"
        fileHeader += "Content-Disposition: form-data; name=\"\(kFileFieldName)\"; filename=\"\(plyURL.lastPathComponent)\"\r\n"
        fileHeader += "Content-Type: application/octet-stream\r\n\r\n"
        try handle.write(contentsOf: Data(fileHeader.utf8))

        try Self.appendFile(plyURL, to: handle)

        try handle.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
        return bodyURL
    }

    /// Stream a file into the body handle in bounded chunks.
    private static func appendFile(_ url: URL, to handle: FileHandle) throws {
        let reader = try FileHandle(forReadingFrom: url)
        defer { try? reader.close() }
        let chunkSize = 1 << 20 // 1 MB
        while true {
            let chunk = try reader.read(upToCount: chunkSize) ?? Data()
            if chunk.isEmpty { break }
            try handle.write(contentsOf: chunk)
        }
    }

    // MARK: - Response parsing

    /// Parse `{ scanId, status }` or `{ scan: { id, status } }` into a result.
    private static func parseResult(data: Data, fallbackBody: String) throws -> ScanImportResult {
        struct Wire: Decodable {
            let scanId: String?
            let status: String?
            struct Scan: Decodable { let id: String?; let status: String? }
            let scan: Scan?
        }
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data) else {
            throw UploadError.unreadableResponse(fallbackBody.isEmpty ? "empty body" : fallbackBody)
        }
        guard let id = wire.scanId ?? wire.scan?.id else {
            throw UploadError.unreadableResponse("no scanId in response: \(fallbackBody)")
        }
        let status = wire.status ?? wire.scan?.status ?? "queued"
        return ScanImportResult(scanId: id, status: status)
    }

    /// Pull a readable message out of a JSON error body (`{ "error": "..." }`),
    /// else return the raw (trimmed) body text.
    private static func readableError(_ body: String) -> String {
        if let data = body.data(using: .utf8),
           let obj = try? JSONDecoder().decode([String: String].self, from: data),
           let message = obj["error"] {
            return message
        }
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "No response body." : String(trimmed.prefix(300))
    }
}

/// @description A per-task delegate that forwards upload send-progress to a
/// main-thread closure. Kept separate so `ScanUploadClient` stays a plain client.
private final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
    private let onProgress: (Double) -> Void

    init(onProgress: @escaping (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        let fraction = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
        DispatchQueue.main.async { self.onProgress(min(max(fraction, 0), 1)) }
    }
}
