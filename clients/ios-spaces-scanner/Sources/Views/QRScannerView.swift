/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — AVFoundation QR pairing scanner. Purpose: read a QR that encodes {host, token} (or an oshalpair:// URL) so the operator can pair without typing a long token.
 */

import SwiftUI
import AVFoundation

/// @description A full-screen camera QR scanner presented as a sheet. On a decoded
/// payload it parses `{ "host": ..., "token": ... }` JSON (or an
/// `oshalpair://pair?host=&token=` URL) and returns the pair via `onPair`.
struct QRScannerView: UIViewControllerRepresentable {
    /// Called with (host, token) once a valid QR is decoded.
    let onPair: (String, String) -> Void
    /// Called to dismiss (cancel or after a successful decode).
    let onFinish: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onCode = context.coordinator.handle
        return controller
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}

    /// @description Bridges the raw QR string to the (host, token) parse + callback.
    final class Coordinator {
        private let parent: QRScannerView
        private var handled = false

        init(_ parent: QRScannerView) { self.parent = parent }

        /// Parse a decoded QR payload; on success emit the pair and finish once.
        func handle(_ raw: String) {
            guard !handled, let pair = Self.parse(raw) else { return }
            handled = true
            parent.onPair(pair.host, pair.token)
            parent.onFinish()
        }

        /// Accept either a JSON object or an `oshalpair://` URL.
        static func parse(_ raw: String) -> (host: String, token: String)? {
            if let data = raw.data(using: .utf8),
               let obj = try? JSONDecoder().decode([String: String].self, from: data),
               let host = obj["host"], let token = obj["token"] {
                return (host, token)
            }
            if let comps = URLComponents(string: raw),
               comps.scheme == "oshalpair",
               let host = comps.queryItems?.first(where: { $0.name == "host" })?.value,
               let token = comps.queryItems?.first(where: { $0.name == "token" })?.value {
                return (host, token)
            }
            return nil
        }
    }
}

/// @description A minimal `AVCaptureSession` view controller that emits decoded QR
/// strings. Starts the session on a background queue (startRunning blocks) and
/// keeps the preview layer sized to the view.
final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let sessionQueue = DispatchQueue(label: "com.emeraldcoastsystemsgroup.oshal.qr")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sessionQueue.async { [weak self] in
            guard let self, !self.session.isRunning else { return }
            self.session.startRunning()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    /// Wire the camera input + a metadata output limited to QR codes.
    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue else { return }
        onCode?(value)
    }
}
