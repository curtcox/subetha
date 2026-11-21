import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The HTTP layer. `URLSessionTransport` is the default; tests and apps can supply their own.
public protocol HTTPTransport: Sendable {
    /// A whole response body.
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
    /// A streaming response, as lines. On a non-2xx status the stream holds the error body.
    /// Cancelling the calling task must close the connection.
    func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    public let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SubEthaClientError.invalidResponse("not HTTP") }
        return (data, http)
    }

    public func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw SubEthaClientError.invalidResponse("not HTTP") }
        let stream = AsyncThrowingStream<String, Error> { continuation in
            let task = Task {
                do {
                    for try await line in bytes.lines { continuation.yield(line) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (stream, http)
    }
}
