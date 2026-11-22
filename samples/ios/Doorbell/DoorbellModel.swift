import Foundation
import SubEtha

/// The scripted doorbell flow: connect, subscribe, inbox, ring, dry-run cost.
@MainActor
final class DoorbellModel: ObservableObject {
    @Published var token = ""
    @Published var topic = "@me/doorbell"
    @Published var baseURL = SubEtha.defaultBaseURL.absoluteString
    @Published private(set) var connected = false
    @Published private(set) var status = "Not connected"
    @Published private(set) var inbox: [Message] = []
    @Published private(set) var estimate: String?
    @Published private(set) var busy = false

    private var client: SubEtha?

    /// The connected client, for the Edge tab's relay bridge.
    var connectedClient: SubEtha? { connected ? client : nil }
    private var subscription: Task<Void, Never>?

    func connect() {
        guard let url = URL(string: baseURL) else { status = "Bad base URL"; return }
        let client = SubEtha(baseURL: url, token: token.trimmingCharacters(in: .whitespaces))
        self.client = client
        subscription?.cancel()
        connected = true
        status = "Connecting…"
        inbox = []
        estimate = nil
        let topic = self.topic
        let options = SubscribeOptions(
            since: "1h",
            onOpen: { [weak self] in Task { @MainActor in self?.status = "Subscribed to \(topic)" } },
            onError: { [weak self] error in Task { @MainActor in self?.status = "Reconnecting: \(error.localizedDescription)" } }
        )
        subscription = Task { [weak self] in
            do {
                for try await m in client.messages([topic], options: options) {
                    self?.inbox.insert(m, at: 0)
                }
            } catch {
                self?.status = Self.describe(error)
                self?.connected = false
            }
        }
    }

    func disconnect() {
        subscription?.cancel()
        connected = false
        status = "Not connected"
    }

    func ring() {
        run { client, topic in
            _ = try await client.publish(topic, "ding", PublishOptions(title: "Doorbell", tags: ["bell"]))
        }
    }

    func estimateCost() {
        run { [weak self] client, topic in
            let e = try await client.estimate(topic, "ding", PublishOptions(title: "Doorbell", route: Route(mode: .all)))
            let plan = e.plan.map { step in
                step.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.jsonString())" }.joined(separator: ", ")
            }.joined(separator: "\n")
            self?.estimate = String(format: "Worst case $%.6f\n", e.estimateUSD) + plan
        }
    }

    private func run(_ action: @escaping @MainActor (SubEtha, String) async throws -> Void) {
        guard let client else { return }
        busy = true
        let topic = self.topic
        Task {
            defer { self.busy = false }
            do { try await action(client, topic) } catch { self.status = Self.describe(error) }
        }
    }

    private static func describe(_ error: Error) -> String {
        if let e = error as? SubEthaError { return "\(e.code) (HTTP \(e.status))" }
        return error.localizedDescription
    }
}
