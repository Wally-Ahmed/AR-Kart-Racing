import Foundation

/// One row of the module's `effect` table, as far as the pilot cares.
public struct ActiveEffect: Equatable, Identifiable {
    public let rowID: Int?
    public let kind: EffectKind
    public let multiplier: Double
    /// `nil` = no expiry. Shield has none — it is consumed by a hit.
    public let expiresAt: Date?

    public init(rowID: Int?, kind: EffectKind, multiplier: Double, expiresAt: Date?) {
        self.rowID = rowID
        self.kind = kind
        self.multiplier = multiplier
        self.expiresAt = expiresAt
    }

    public var id: String {
        if let rowID = rowID { return "\(rowID)" }
        return "\(kind.rawValue)-\(expiresAt?.timeIntervalSince1970 ?? 0)"
    }

    public func isActive(at now: Date = Date()) -> Bool {
        guard let expiresAt = expiresAt else { return true }
        return expiresAt > now
    }

    public func remaining(at now: Date = Date()) -> TimeInterval? {
        guard let expiresAt = expiresAt else { return nil }
        return max(0, expiresAt.timeIntervalSince(now))
    }
}

/// Everything the HUD draws, rebuilt from each 5 Hz SQL poll.
public struct HUDSnapshot: Equatable {
    public var raceState: String = "—"
    public var lap: Int = 0
    public var lapCount: Int = 3
    public var nextIdx: Int = 0
    public var placement: Int? = nil
    public var finished: Bool = false
    public var slot1: Item? = nil
    public var slot2: Item? = nil
    public var effects: [ActiveEffect] = []
    public var updatedAt: Date? = nil

    public init() {}

    public func slot(_ index: Int) -> Item? { index == 1 ? slot1 : slot2 }

    public func active(_ kind: EffectKind, at now: Date = Date()) -> ActiveEffect? {
        effects.first { $0.kind == kind && $0.isActive(at: now) }
    }

    public func isShielded(at now: Date = Date()) -> Bool { active(.shield, at: now) != nil }
    public func isStunned(at now: Date = Date()) -> Bool { active(.stun, at: now) != nil }
    public func isDizzy(at now: Date = Date()) -> Bool { active(.dizzy, at: now) != nil }
    public func isBoosting(at now: Date = Date()) -> Bool { active(.boost, at: now) != nil }
    public func isSlowed(at now: Date = Date()) -> Bool { active(.slow, at: now) != nil }

    /// Banners worth shouting about, in priority order. Ink is deliberately
    /// excluded — it paints the whole screen instead.
    public func banners(at now: Date = Date()) -> [EffectKind] {
        var out: [EffectKind] = []
        for kind in [EffectKind.stun, .dizzy, .slow, .boost] where active(kind, at: now) != nil {
            out.append(kind)
        }
        return out
    }

    public var placementLabel: String {
        guard let placement = placement, placement >= 1 else { return "—" }
        return "P\(placement)"
    }

    public var lapLabel: String { "\(min(lap + 1, max(lapCount, 1)))/\(max(lapCount, 1))" }

    public var isRunning: Bool { raceState.lowercased() == "running" }
}
