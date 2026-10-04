import Foundation

public struct STDBError: Error, CustomStringConvertible {
    public let message: String
    public let status: Int?

    public init(_ message: String, status: Int? = nil) {
        self.message = message
        self.status = status
    }

    public var description: String {
        if let status = status { return "HTTP \(status): \(message)" }
        return message
    }

    public var localizedDescription: String { description }
}

/// Plain-HTTP SpacetimeDB client. There is no SpacetimeDB Swift SDK and we do
/// not need one: the pilot app only calls reducers and polls SQL.
///
/// ENDPOINT CONTRACT — verified against https://spacetimedb.com/docs/http/database
/// on 2026-09-20:
///   * reducer: `POST /v1/database/:name_or_identity/call/:reducer`
///              body = JSON array of the reducer's arguments
///              optional `Authorization: Bearer <token>` (we stay anonymous on the LAN)
///   * SQL:     `POST /v1/database/:name_or_identity/sql`
///              body = one or more SQL statements separated by `;`
///              response = JSON array of `{"schema": ProductType, "rows": [ProductValue]}`
///
/// Both wire formats live in exactly one function each (`callReducer`, `sql`)
/// so a format change is a two-line fix.
public final class STDBClient: @unchecked Sendable {

    public private(set) var baseURL: URL
    public private(set) var module: String
    private let session: URLSession

    public init(baseURL: URL, module: String = "arkart", timeout: TimeInterval = 1.5) {
        self.baseURL = baseURL
        self.module = module
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout * 2
        config.waitsForConnectivity = false
        config.httpMaximumConnectionsPerHost = 6
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.allowsCellularAccess = true
        self.session = URLSession(configuration: config)
    }

    // MARK: - ADAPTER 1 — reducer call

    /// `POST /v1/database/<module>/call/<reducer>` with a JSON array body.
    @discardableResult
    public func callReducer(_ reducer: String, args: [Any]) async throws -> Data {
        let url = try endpoint("call/\(reducer)")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(
            withJSONObject: args,
            options: [.fragmentsAllowed]
        )
        return try await perform(request)
    }

    // MARK: - ADAPTER 2 — SQL query

    /// Runs several queries concurrently and returns their tables in the order
    /// the queries were given.
    ///
    /// SpacetimeDB 2.4.1 answers `Multiple SQL statements are not supported`
    /// (HTTP 400) to a `;`-separated body — verified against the live `arkart`
    /// module — so one statement per request it is. On the race LAN four
    /// parallel requests at 5 Hz is nothing.
    public func sqlBatch(_ queries: [String]) async throws -> [STDBTable] {
        guard !queries.isEmpty else { return [] }
        return try await withThrowingTaskGroup(of: (Int, [STDBTable]).self) { group in
            for (index, query) in queries.enumerated() {
                group.addTask { [self] in (index, try await sql(query)) }
            }
            var slots = [[STDBTable]](repeating: [], count: queries.count)
            for try await (index, tables) in group { slots[index] = tables }
            return slots.flatMap { $0 }
        }
    }

    /// `POST /v1/database/<module>/sql` with a raw SQL body — **one statement**.
    public func sql(_ query: String) async throws -> [STDBTable] {
        let url = try endpoint("sql")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // The body is SQL text, not JSON.
        request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(query.utf8)
        let data = try await perform(request)
        guard !data.isEmpty else { return [] }
        let json = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        guard let array = json as? [Any] else {
            // A single statement may come back unwrapped on some builds.
            if json is [String: Any] { return [STDBTable.decode(json)] }
            throw STDBError("unexpected SQL response shape")
        }
        return array.map(STDBTable.decode)
    }

    // MARK: - Plumbing

    private func endpoint(_ suffix: String) throws -> URL {
        guard var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw STDBError("bad server URL")
        }
        var path = comps.path
        while path.hasSuffix("/") { path.removeLast() }
        comps.path = path + "/v1/database/" + module + "/" + suffix
        guard let url = comps.url else { throw STDBError("bad server URL") }
        return url
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw STDBError(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw STDBError("no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw STDBError(body.isEmpty ? "request failed" : body, status: http.statusCode)
        }
        return data
    }
}
