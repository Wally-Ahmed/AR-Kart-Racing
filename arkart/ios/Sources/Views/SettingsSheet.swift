import SwiftUI

@MainActor
struct SettingsSheet: View {
    @ObservedObject var settings: AppSettings
    let onApply: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var testResult: String?
    @State private var testing = false

    var body: some View {
        NavigationView {
            Form {
                Section {
                    TextField("http://192.168.8.2:3000", text: $settings.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .keyboardType(.URL)
                } header: {
                    Text("SpacetimeDB server")
                } footer: {
                    Text("Module `arkart`. On a real phone this must be the laptop's LAN address — `localhost` only works in the simulator.")
                }

                Section {
                    Picker("Kart", selection: $settings.kartID) {
                        Text("Kart 1").tag(1)
                        Text("Kart 2").tag(2)
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("This phone drives")
                }

                Section {
                    Toggle("Derive from kart number", isOn: $settings.streamAuto)
                    TextField("http://192.168.8.101/stream", text: $settings.streamURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .keyboardType(.URL)
                        .disabled(settings.streamAuto)
                        .foregroundColor(settings.streamAuto ? .secondary : .primary)
                } header: {
                    Text("FPV stream")
                } footer: {
                    Text("The kart's MJPEG endpoint, rendered straight by WKWebView.")
                }

                Section {
                    Button {
                        runTest()
                    } label: {
                        HStack {
                            Text(testing ? "Testing…" : "Test connection")
                            Spacer()
                            if let result = testResult {
                                Text(result)
                                    .font(.caption)
                                    .foregroundColor(result.hasPrefix("OK") ? .green : .red)
                                    .lineLimit(2)
                            }
                        }
                    }
                    .disabled(testing)
                }
            }
            .navigationTitle("Pilot setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onApply()
                        dismiss()
                    }
                }
            }
        }
    }

    @MainActor
    private func runTest() {
        guard let url = settings.serverURLValue else {
            testResult = "Bad URL"
            return
        }
        testing = true
        testResult = nil
        let client = STDBClient(baseURL: url, module: "arkart", timeout: 3)
        Task {
            do {
                let tables = try await client.sql("SELECT * FROM config")
                let rows = tables.first?.rows.count ?? 0
                let state = tables.first?.first?.tag("state") ?? "?"
                testResult = "OK · config rows \(rows) · state \(state)"
            } catch {
                testResult = (error as? STDBError)?.description ?? error.localizedDescription
            }
            testing = false
        }
    }
}
