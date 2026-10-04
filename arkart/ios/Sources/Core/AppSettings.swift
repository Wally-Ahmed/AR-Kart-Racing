import Combine
import Foundation

/// Pilot configuration, persisted in UserDefaults so a phone remembers its kart
/// across the 7-day free-provisioning reinstalls.
///
/// Intentionally not actor-isolated: it is created in a SwiftUI property
/// initializer and only ever touched from the main thread.
public final class AppSettings: ObservableObject {

    public static let shared = AppSettings()

    public enum Key {
        public static let serverURL = "arkart.serverURL"
        public static let kartID = "arkart.kartID"
        public static let streamURL = "arkart.streamURL"
        public static let streamAuto = "arkart.streamAuto"
    }

    /// SpacetimeDB HTTP endpoint. NOTE: the default below is the spec's
    /// `http://localhost:3000`, which only works in the simulator — on a real
    /// phone this must be the laptop's LAN address (e.g. http://192.168.8.2:3000).
    @Published public var serverURL: String {
        didSet { defaults.set(serverURL, forKey: Key.serverURL) }
    }

    /// 1 or 2.
    @Published public var kartID: Int {
        didSet {
            defaults.set(kartID, forKey: Key.kartID)
            if streamAuto { streamURL = Self.defaultStreamURL(kartID: kartID) }
        }
    }

    /// Kart MJPEG stream — conductor contract is `http://<kart-ip>/stream`.
    @Published public var streamURL: String {
        didSet { defaults.set(streamURL, forKey: Key.streamURL) }
    }

    /// While true, picking a kart rewrites the stream URL to that kart's default IP.
    @Published public var streamAuto: Bool {
        didSet { defaults.set(streamAuto, forKey: Key.streamAuto) }
    }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let kart = defaults.object(forKey: Key.kartID) as? Int ?? 1
        self.kartID = (kart == 2) ? 2 : 1
        self.serverURL = defaults.string(forKey: Key.serverURL) ?? "http://localhost:3000"
        self.streamURL = defaults.string(forKey: Key.streamURL)
            ?? Self.defaultStreamURL(kartID: kart)
        self.streamAuto = defaults.object(forKey: Key.streamAuto) as? Bool ?? true
    }

    /// GL.iNet Opal hands out 192.168.8.x; karts get static leases .101 / .102.
    public static func defaultStreamURL(kartID: Int) -> String {
        "http://192.168.8.\(100 + max(1, min(kartID, 2)))/stream"
    }

    public var serverURLValue: URL? {
        URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public var streamURLValue: URL? {
        URL(string: streamURL.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Bumped whenever a field that requires rebuilding the client changes.
    public var connectionFingerprint: String { "\(serverURL)|\(kartID)" }
}
