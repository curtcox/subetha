import AVFoundation
import Foundation
import SubEtha
import SubEthaCore

/// Edge transports between phones, no network. One gossip node holds what this phone has seen:
/// - Sound: "Send by sound" plays a message as a modem frame (a gossip `deliver`, spec
///   §11.1/§11.4); "Listen" decodes what the microphone hears.
/// - Bluetooth: `AppleBle` connects to nearby phones (and Web Bluetooth pages) and gossips
///   (spec §11.3/§11.4), so messages hop between phones in range.
/// - Bridge: with the Doorbell tab connected, relay messages on the topic enter the node (and
///   reach Bluetooth peers), and messages heard over the edge are published to the relay. One
///   online phone is then the gateway for offline phones nearby (PLAN §3).
@MainActor
final class EdgeModel: ObservableObject {
    @Published var topic = "@me/doorbell"
    @Published private(set) var listening = false
    @Published private(set) var sending = false
    @Published private(set) var bluetooth = false
    @Published private(set) var peers = 0
    @Published private(set) var bridging = false
    @Published private(set) var heard: [String] = []
    @Published private(set) var status = ""

    private let node = EdgeGossipNode(requireSignatures: false)
    private let audio = AppleAudio()
    private var ble: AppleBle?
    private var bridge: EdgeBridge?
    private lazy var listener = SoundListener { [weak self] payload in
        Task { @MainActor in self?.accept(payload) }
    }
    private lazy var sender = AudioLink(sampleRate: Int(AppleAudio.playbackRate), play: { [weak self] samples in
        self?.audio.play(samples) { Task { @MainActor in self?.sending = false } }
    }, onPayload: { _ in })

    private var now: UInt64 { UInt64(Date().timeIntervalSince1970) }

    func send(_ text: String) {
        node.subscribe(topic: topic)
        let env: [String: Any] = ["id": Core.newMessageId(), "time": now, "topic": topic, "message": text, "hops": 1]
        guard let data = try? JSONSerialization.data(withJSONObject: env, options: [.withoutEscapingSlashes]),
              let json = String(data: data, encoding: .utf8) else { return }
        _ = try? node.publish(envelopeJson: json, nowSecs: now)
        ble?.resyncAll()
        if let bridge { Task { await bridge.uplink(json) } }
        do {
            sending = true
            try sender.send(try Edge.deliverPayload([json]))
            status = "Sent \(text.count) characters by sound" + (ble != nil ? " and Bluetooth" : "")
        } catch {
            sending = false
            status = "Couldn't send: \(error.localizedDescription)"
        }
    }

    func toggleListening() {
        if listening {
            audio.stopRecording()
            listening = false
            status = "Stopped listening"
            return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard granted else { self.status = "Microphone permission denied (Settings → Doorbell)"; return }
                self.node.subscribe(topic: self.topic)
                let listener = self.listener
                do {
                    try self.audio.record { samples, rate in listener.feed(samples, rate: rate) }
                    self.listening = true
                    self.status = "Listening…"
                } catch {
                    self.status = "Couldn't listen: \(error.localizedDescription)"
                }
            }
        }
    }

    func toggleBluetooth() {
        if let ble {
            ble.stop()
            self.ble = nil
            bluetooth = false
            peers = 0
            return
        }
        node.subscribe(topic: topic)
        let b = AppleBle(node: node, queue: DispatchQueue(label: "org.subetha.sample.ble"),
                         onMessage: { [weak self] env in Task { @MainActor in self?.received(env, via: "Bluetooth") } },
                         onStatus: { [weak self] text, count in Task { @MainActor in self?.status = text; self?.peers = count } })
        b.start()
        ble = b
        bluetooth = true
        status = "Starting Bluetooth…"
    }

    /// Bridges the topic between the relay (`client`, from the Doorbell tab) and the edge.
    /// Uplinked messages are billed to that token like any other publish.
    func toggleBridge(client: SubEtha?) {
        if let bridge {
            bridge.close()
            self.bridge = nil
            bridging = false
            status = "Bridge off"
            return
        }
        guard let client else { status = "Connect on the Doorbell tab first"; return }
        bridge = EdgeBridge(client: client, node: node, topics: [topic], since: "10m",
                            onDownlink: { [weak self] env in Task { @MainActor in self?.downlinked(env) } },
                            onError: { [weak self] error in Task { @MainActor in self?.status = "Bridge: \(error.localizedDescription)" } })
        bridging = true
        status = "Bridging \(topic) to the relay"
    }

    private func accept(_ payload: Data) {
        Edge.acceptPayload(node, payload).forEach { received($0, via: "sound") }
    }

    /// A new envelope from an edge link: show it, pass it on to Bluetooth peers, and uplink it.
    private func received(_ env: String, via: String) {
        if let m = Self.text(env) { heard.insert("\(via): \(m)", at: 0); status = "Heard a message by \(via)" }
        ble?.resyncAll() // the sender already knows; other peers may not (multi-hop)
        if let bridge { Task { await bridge.uplink(env) } }
    }

    private func downlinked(_ env: String) {
        ble?.resyncAll()
        if let m = Self.text(env) { heard.insert("relay: \(m)", at: 0) }
    }

    private static func text(_ env: String) -> String? {
        (try? JSONValue.parse(env))?["message"]?.stringValue
    }
}

/// Microphone buffers → modem decoder, on its own queue (AudioLink isn't thread-safe).
final class SoundListener: @unchecked Sendable {
    private let queue = DispatchQueue(label: "org.subetha.sample.sound")
    private let onPayload: (Data) -> Void
    private var link: AudioLink?

    init(onPayload: @escaping (Data) -> Void) { self.onPayload = onPayload }

    func feed(_ samples: [Float], rate: Int) {
        queue.async {
            if self.link == nil { self.link = AudioLink(sampleRate: rate, play: { _ in }, onPayload: self.onPayload) }
            self.link?.onSamples(samples)
        }
    }
}
