import Combine
import Foundation

/// The pilot's whole runtime: two fixed-cadence loops over plain HTTP.
///
///   * 25 Hz — `set_input(kart_id, throttle, steer)`. Sent **every tick even when
///     nothing changed**: this POST is also the keep-alive. The car bridge zeroes
///     throttle when `input.updated_at` is older than 500 ms, so silence = stop.
///   * 5 Hz  — one SQL POST rebuilding the HUD (placement, lap, inventory slots,
///     active effects).
///
/// Deliberately UI-framework-free so it can be compiled and reasoned about
/// (and unit-tested) on its own.
@MainActor
public final class PilotEngine: ObservableObject {

    public static let inputHz: Double = 25
    public static let hudHz: Double = 5
    /// Spec §1: Ink Splat covers the victim's screen for 4 s. Screen only —
    /// the car is untouched.
    public static let inkDuration: TimeInterval = 4.0

    // MARK: Control state (0...1 throttle, -1...1 steer)

    @Published public private(set) var throttle: Double = 0
    @Published public private(set) var steer: Double = 0
    /// True while an extendedGamepad is attached; touch input is ignored then.
    @Published public var gamepadConnected: Bool = false {
        didSet {
            guard oldValue != gamepadConnected else { return }
            // Hand-over always starts from neutral, in either direction.
            throttle = 0
            steer = 0
        }
    }

    // MARK: HUD / link state

    @Published public private(set) var hud = HUDSnapshot()
    @Published public private(set) var linkUp: Bool = false
    @Published public private(set) var lastError: String?
    /// When non-nil, the ink overlay is painted and fades out by this instant.
    @Published public private(set) var inkUntil: Date?
    @Published public private(set) var inputsSent: Int = 0

    public let settings: AppSettings

    private var client: STDBClient?
    private var clientFingerprint: String = ""
    private var inputLoop: Task<Void, Never>?
    private var hudLoop: Task<Void, Never>?
    private var inkedEffectIDs: Set<Int> = []
    private var inkWasActive = false
    private var running = false

    /// Built from `RootView`, which is `@MainActor`, so this init is too.
    public init(settings: AppSettings = .shared) {
        self.settings = settings
    }

    // MARK: - Lifecycle

    public func start() {
        guard !running else { return }
        running = true
        rebuildClientIfNeeded()
        inputLoop = Task { [weak self] in
            await self?.runInputLoop()
        }
        hudLoop = Task { [weak self] in
            await self?.runHUDLoop()
        }
    }

    public func stop() {
        running = false
        inputLoop?.cancel()
        hudLoop?.cancel()
        inputLoop = nil
        hudLoop = nil
        throttle = 0
        steer = 0
        // Best-effort final zero so the kart parks the instant we background.
        let client = self.client
        let kart = settings.kartID
        Task.detached {
            try? await client?.callReducer("set_input", args: [kart, 0.0, 0.0])
        }
    }

    public func settingsChanged() {
        rebuildClientIfNeeded()
    }

    private func rebuildClientIfNeeded() {
        let fingerprint = settings.connectionFingerprint
        guard fingerprint != clientFingerprint || client == nil else { return }
        clientFingerprint = fingerprint
        guard let url = settings.serverURLValue else {
            client = nil
            linkUp = false
            lastError = "Server URL is not a valid URL"
            return
        }
        client = STDBClient(baseURL: url, module: "arkart")
        linkUp = false
        lastError = nil
    }

    // MARK: - Input (touch + gamepad)

    /// Touch controls. Ignored while a gamepad is attached (gamepad wins).
    public func setTouchThrottle(_ value: Double) {
        guard !gamepadConnected else { return }
        throttle = Self.clamp01(value)
    }

    public func setTouchSteer(_ value: Double) {
        guard !gamepadConnected else { return }
        steer = Self.clampSigned(value)
    }

    /// Gamepad axes — RT → throttle, left stick X → steer (Xbox layout).
    public func setPadThrottle(_ value: Double) {
        throttle = Self.clamp01(value)
    }

    public func setPadSteer(_ value: Double) {
        // Small stick dead-band so a resting thumb does not creep the wheels.
        let v = abs(value) < 0.08 ? 0 : value
        steer = Self.clampSigned(v)
    }

    public func releaseTouchControls() {
        guard !gamepadConnected else { return }
        throttle = 0
        steer = 0
    }

    // MARK: - Items

    /// Fires an inventory slot (1 or 2) via the `use_item` reducer.
    public func fire(slot: Int) {
        guard let client = client, hud.slot(slot) != nil else { return }
        let kart = settings.kartID
        Task { [weak self] in
            do {
                try await client.callReducer("use_item", args: [kart, slot])
                await self?.pollHUDOnce()       // snappy slot feedback
            } catch {
                self?.note(error: error)
            }
        }
    }

    // MARK: - Loops

    private func runInputLoop() async {
        let period = 1.0 / Self.inputHz
        while !Task.isCancelled {
            let started = Date()
            await sendInputOnce()
            let elapsed = Date().timeIntervalSince(started)
            let remaining = max(0, period - elapsed)
            if remaining > 0 {
                try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
            }
        }
    }

    private func sendInputOnce() async {
        guard let client = client else { return }
        let kart = settings.kartID
        // Sent unconditionally — this is the keep-alive, not a change feed.
        let args: [Any] = [kart, throttle, steer]
        do {
            try await client.callReducer("set_input", args: args)
            inputsSent &+= 1
            if !linkUp { linkUp = true }
            if lastError != nil { lastError = nil }
        } catch {
            note(error: error)
        }
    }

    private func runHUDLoop() async {
        let period = 1.0 / Self.hudHz
        while !Task.isCancelled {
            let started = Date()
            await pollHUDOnce()
            let elapsed = Date().timeIntervalSince(started)
            let remaining = max(0, period - elapsed)
            if remaining > 0 {
                try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
            }
        }
    }

    private func pollHUDOnce() async {
        guard let client = client else { return }
        let queries = HUDQuery.statements(kartID: settings.kartID)
        do {
            let tables = try await client.sqlBatch(queries)
            let snapshot = HUDQuery.decode(tables, previous: hud)
            applyInk(from: snapshot)
            hud = snapshot
            linkUp = true
        } catch {
            note(error: error)
        }
    }

    /// Rising-edge detection for Ink Splat. Prefers the effect row id (so two
    /// inks in a row both splat); falls back to "ink went from off to on".
    private func applyInk(from snapshot: HUDSnapshot) {
        let now = Date()
        let inks = snapshot.effects.filter { $0.kind == .ink && $0.isActive(at: now) }
        let isActive = !inks.isEmpty

        var trigger: ActiveEffect?
        for ink in inks {
            if let id = ink.rowID {
                if !inkedEffectIDs.contains(id) {
                    inkedEffectIDs.insert(id)
                    trigger = ink
                }
            } else if !inkWasActive {
                trigger = ink
            }
        }

        if let ink = trigger {
            inkUntil = ink.expiresAt ?? now.addingTimeInterval(Self.inkDuration)
        }

        // Forget ids that are gone so the set cannot grow all race.
        let liveIDs = Set(snapshot.effects.compactMap { $0.rowID })
        inkedEffectIDs.formIntersection(liveIDs)
        inkWasActive = isActive

        if let until = inkUntil, until <= now { inkUntil = nil }
    }

    public func clearInk() { inkUntil = nil }

    private func note(error: Error) {
        linkUp = false
        if let stdb = error as? STDBError {
            lastError = stdb.description
        } else {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Helpers

    static func clamp01(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(1, max(0, value))
    }

    static func clampSigned(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(1, max(-1, value))
    }
}
