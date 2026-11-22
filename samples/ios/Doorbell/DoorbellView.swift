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
    @EnvironmentObject private var doorbell: DoorbellModel
    @EnvironmentObject private var edge: EdgeModel
    @State private var text = "Ding dong"

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Two phones, no network: one plays a message as a 16-FSK modem frame, the other listens and decodes it (about 50 bytes a second). With Bluetooth on, phones in range gossip what they hold, so a message hops from phone to phone. Same topic on all of them.")
                        .font(.footnote).foregroundStyle(.secondary)
                    TextField("Topic", text: $edge.topic)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Message", text: $text)
                }
                Section("Sound") {
                    Button("Send by sound") { edge.send(text) }
                        .disabled(edge.sending || text.isEmpty)
                    Button(edge.listening ? "Stop listening" : "Listen", action: edge.toggleListening)
                }
                Section("Bluetooth and relay") {
                    Button(edge.bluetooth ? "Bluetooth off (\(edge.peers) peers)" : "Bluetooth on", action: edge.toggleBluetooth)
                    Button(edge.bridging ? "Stop bridging" : "Bridge to relay") { edge.toggleBridge(client: doorbell.connectedClient) }
                        .disabled(!edge.bridging && !doorbell.connected)
                }
                if !edge.status.isEmpty {
                    Section { Text(edge.status).font(.footnote).foregroundStyle(.secondary) }
                }
                Section("Heard") {
                    if edge.heard.isEmpty { Text("Nothing yet").foregroundStyle(.secondary) }
                    ForEach(Array(edge.heard.enumerated()), id: \.offset) { _, m in Text(m) }
                }
            }
            .navigationTitle("Edge")
        }
    }
}
