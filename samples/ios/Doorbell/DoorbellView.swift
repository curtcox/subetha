import SwiftUI
import SubEtha

struct DoorbellView: View {
    @EnvironmentObject private var model: DoorbellModel

    var body: some View {
        NavigationStack {
            Form {
                if !model.connected {
                    Section("Connect") {
                        SecureField("Token", text: $model.token)
                        TextField("Topic", text: $model.topic)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Base URL", text: $model.baseURL)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                        Button("Subscribe", action: model.connect)
                            .disabled(model.token.isEmpty || model.topic.isEmpty)
                    }
                } else {
                    Section {
                        Button("Ring \"ding\"", action: model.ring).disabled(model.busy)
                        Button("Route & cost (dry run)", action: model.estimateCost).disabled(model.busy)
                        Button("Disconnect", role: .destructive, action: model.disconnect)
                    }
                }
                Section {
                    Text(model.status).font(.footnote).foregroundStyle(.secondary)
                }
                if let estimate = model.estimate {
                    Section("Route & cost") {
                        Text(estimate).font(.footnote.monospaced())
                    }
                }
                Section("Inbox") {
                    if model.inbox.isEmpty {
                        Text("No messages yet").foregroundStyle(.secondary)
                    }
                    ForEach(Array(model.inbox.enumerated()), id: \.offset) { _, m in
                        VStack(alignment: .leading) {
                            Text(m.title ?? m.topic).font(.headline)
                            Text(m.message ?? "")
                            if let t = m.time {
                                Text(Date(timeIntervalSince1970: TimeInterval(t)), style: .time)
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Doorbell")
        }
    }
}

struct EdgeView: View {
    var body: some View {
        NavigationStack {
            List {
                Text("Offline delivery over BLE (store-and-forward gossip), data-over-sound (16-FSK audio modem) and animated QR (fountain codes) come from the Rust core: sdk/core edge::ble, edge::gossip, edge::audio and edge::qr, through the SubEthaCore package (UniFFI).")
                Text("This screen is a stub (track F). The app supplies the radios: CoreBluetooth with the core's GATT UUIDs and MTU chunking, AVAudioEngine at 48 kHz, and AVCaptureSession frames for QR.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .navigationTitle("Edge")
        }
    }
}
