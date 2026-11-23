import AVFoundation
import Foundation
import SubEtha
import SubEthaCore

/// Edge transports between phones, no network. One gossip node holds what this phone has seen:
/// - Sound: "Send by sound" plays a message as a modem frame (a gossip `deliver`, spec
///   §11.1/§11.4); "Listen" decodes what the microphone hears.
/// - QR: "Show as QR" animates a message as fountain-coded QR frames (spec §11.2); "Scan QR"
///   decodes them from the camera.
/// - Bluetooth: `AppleBle` connects to nearby phones (and Web Bluetooth pages) and gossips
///   (spec §11.3/§11.4), so messages hop between phones in range.
/// - LAN: `AppleLan` finds phones on the same Wi-Fi by UDP multicast and gossips with them
///   (spec §11.5). Needs Apple's multicast entitlement on a device.
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
    @Published private(set) var lan = false
    @Published private(set) var lanPeers = 0
    @Published private(set) var bridging = false
    @Published private(set) var heard: [String] = []
    /// The animated QR code being shown, if any.
    @Published private(set) var qr: QrSender?
    @Published private(set) var scanning = false
    @Published private(set) var status = ""

    private let node = EdgeGossipNode(requireSignatures: false)
    private let audio = AppleAudio()
    private var ble: AppleBle?
    private var bridge: EdgeBridge?
    private var lanLink: AppleLan?
    private var lanPeerTimer: Timer?
    private lazy var listener = SoundListener { [weak self] payload in
        Task { @MainActor in self?.accept(payload, via: "sound") }
    }
    private lazy var qrReceiver = QrReceiver { [weak self] payload in self?.accept(payload, via: "QR") }
    private lazy var sender = AudioLink(sampleRate: Int(AppleAudio.playbackRate), play: { [weak self] samples in
        self?.audio.play(samples) { Task { @MainActor in self?.sending = false } }
    }, onPayload: { _ in })

    private var now: UInt64 { UInt64(Date().timeIntervalSince1970) }

    /// A new envelope for `text`, also held by the node (so Bluetooth peers get it) and uplinked.
    private func publishLocally(_ text: String) -> String? {
        node.subscribe(topic: topic)
        let env: [String: Any] = ["id": Core.newMessageId(), "time": now, "topic": topic, "message": text, "hops": 1]
        guard let data = try? JSONSerialization.data(withJSONObject: env, options: [.withoutEscapingSlashes]),
              let json = String(data: data, encoding: .utf8) else { return nil }
        _ = try? node.publish(envelopeJson: json, nowSecs: now)
        resyncLinks()
        if let bridge { Task { await bridge.uplink(json) } }
        return json
    }

    func send(_ text: String) {
        guard let json = publishLocally(text) else { return }
        do {
            sending = true
            try sender.send(try Edge.deliverPayload([json]))
            status = "Sent \(text.count) characters by sound" + (ble != nil ? " and Bluetooth" : "")
        } catch {
            sending = false
            status = "Couldn't send: \(error.localizedDescription)"
        }
    }

    /// Shows `text` as an animated QR code, or hides the one showing.
    func toggleQr(_ text: String) {
        if qr != nil { qr = nil; return }
        guard !text.isEmpty, let json = publishLocally(text) else { return }
        do {
            let sender = try QrSender(payload: try Edge.deliverPayload([json]))
            qr = sender
            status = "Showing \(sender.sourceBlocks) block(s) as QR frames"
        } catch {
            status = "Couldn't make QR frames: \(error.localizedDescription)"
        }
    }

    func toggleScanning() {
        if scanning { scanning = false; status = "Stopped scanning"; return }
        AVCaptureDevice.requestAccess(for: .video) { granted in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard granted else { self.status = "Camera permission denied (Settings → Doorbell)"; return }
                self.node.subscribe(topic: self.topic)
                self.scanning = true
                self.status = "Point the camera at an animated QR code"
            }
        }
    }

    /// One scanned QR string.
    func onQrText(_ text: String) {
        guard let p = qrReceiver.push(text) else { return }
        if !p.complete { status = "QR: \(p.known) of \(p.total) blocks" }
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
        let b = AppleBle(node: node, queue: DispatchQueue(label: "us.subetha.sample.ble"),
                         onMessage: { [weak self] env in Task { @MainActor in self?.received(env, via: "Bluetooth") } },
                         onStatus: { [weak self] text, count in Task { @MainActor in self?.status = text; self?.peers = count } })
        b.start()
        ble = b
        bluetooth = true
        status = "Starting Bluetooth…"
    }

    /// Joins or leaves the LAN (UDP multicast on the current Wi-Fi network).
    func toggleLan() {
        if let lanLink {
            lanLink.stop()
            self.lanLink = nil
            lanPeerTimer?.invalidate()
            lanPeerTimer = nil
            lan = false
            lanPeers = 0
            status = "Left the LAN"
            return
        }
        node.subscribe(topic: topic)
        let l = AppleLan(node: node, onMessage: { [weak self] env in Task { @MainActor in self?.received(env, via: "LAN") } })
        do {
            try l.start()
        } catch {
            status = "Couldn't join the LAN: \(error.localizedDescription). Multicast on iOS needs the com.apple.developer.networking.multicast entitlement."
            return
        }
        lanLink = l
        lan = true
        status = "On the LAN as \(l.nodeId)"
        lanPeerTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.lanPeers = self?.lanLink?.peerCount ?? 0 }
        }
    }

    /// Tells Bluetooth and LAN peers what the node holds.
    private func resyncLinks() {
        ble?.resyncAll()
        lanLink?.resync()
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

    private func accept(_ payload: Data, via: String) {
        Edge.acceptPayload(node, payload).forEach { received($0, via: via) }
    }

    /// A new envelope from an edge link: show it, pass it on to Bluetooth peers, and uplink it.
    private func received(_ env: String, via: String) {
        if let m = Self.text(env) { heard.insert("\(via): \(m)", at: 0); status = "Heard a message by \(via)" }
        resyncLinks() // the sender already knows; other peers may not (multi-hop)
        if let bridge { Task { await bridge.uplink(env) } }
    }

    private func downlinked(_ env: String) {
        resyncLinks()
        if let m = Self.text(env) { heard.insert("relay: \(m)", at: 0) }
    }

    private static func text(_ env: String) -> String? {
        (try? JSONValue.parse(env))?["message"]?.stringValue
    }
}

/// Microphone buffers → modem decoder, on its own queue (AudioLink isn't thread-safe).
final class SoundListener: @unchecked Sendable {
    private let queue = DispatchQueue(label: "us.subetha.sample.sound")
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
