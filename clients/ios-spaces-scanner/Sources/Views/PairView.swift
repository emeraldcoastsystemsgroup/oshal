/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — Pair screen. Purpose: capture the OSHAL host URL + device-pairing token (typed or via QR), store them in Keychain, and show the paired state.
 */

import SwiftUI

/// @description The Pair screen: enter (or scan) the OSHAL host URL + device
/// pairing token. Values persist in the Keychain via `PairingStore`. The token
/// field is a `SecureField` and the stored token is never shown back.
struct PairView: View {
    @EnvironmentObject private var pairing: PairingStore

    @State private var host: String = ""
    @State private var token: String = ""
    @State private var showScanner = false
    @State private var errorText: String?
    @State private var saved = false

    var body: some View {
        NavigationStack {
            Form {
                Section("OSHAL host") {
                    TextField("https://oshal.example.com", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                Section("Pairing token") {
                    SecureField("Bearer token from the cockpit", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan pairing QR", systemImage: "qrcode.viewfinder")
                    }
                }
                if let errorText {
                    Section { Text(errorText).foregroundStyle(.red) }
                }
                Section {
                    Button("Save pairing") { save() }
                        .disabled(host.isEmpty || token.isEmpty)
                    if pairing.isPaired {
                        Button("Forget pairing", role: .destructive) { pairing.clear(); saved = false }
                    }
                }
                Section("Status") {
                    LabeledContent("Paired", value: pairing.isPaired ? "Yes" : "No")
                    if !pairing.hostURL.isEmpty {
                        LabeledContent("Host", value: pairing.hostURL)
                    }
                    if saved { Text("Saved to Keychain.").foregroundStyle(.green) }
                }
            }
            .navigationTitle("Pair device")
            .onAppear { host = pairing.hostURL }
            .sheet(isPresented: $showScanner) {
                QRScannerView(
                    onPair: { scannedHost, scannedToken in
                        host = scannedHost
                        token = scannedToken
                        save()
                    },
                    onFinish: { showScanner = false }
                )
                .ignoresSafeArea()
            }
        }
    }

    /// Persist the entered host/token, surfacing a validation error on failure.
    private func save() {
        do {
            try pairing.save(host: host, token: token)
            errorText = nil
            saved = true
            token = "" // clear the in-memory field once it is safely in Keychain
        } catch {
            errorText = error.localizedDescription
            saved = false
        }
    }
}
