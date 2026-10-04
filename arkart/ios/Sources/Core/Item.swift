import Foundation

/// The six-item pool (design doc §1 "Items"). `displayName` is the wording the
/// spec fixes for the UI — do not paraphrase it on screen.
///
/// The stretch "IR Tag Shot" uses a TV-remote-style 38 kHz IR tag on the kart;
/// it is deliberately absent here because the MVP ships without that layer.
public enum Item: String, CaseIterable, Identifiable, Codable, Sendable {
    case boost
    case stun
    case ink
    case dizzy
    case leaderStrike
    case shield

    public var id: String { rawValue }

    /// Exact on-screen wording.
    public var displayName: String {
        switch self {
        case .boost:        return "Boost"
        case .stun:         return "Stun Shot"
        case .ink:          return "Ink Splat"
        case .dizzy:        return "Dizzy Ray"
        case .leaderStrike: return "Leader Strike"
        case .shield:       return "Shield"
        }
    }

    /// SF Symbol used for the inventory slot icon.
    public var symbolName: String {
        switch self {
        case .boost:        return "bolt.fill"
        case .stun:         return "hand.raised.fill"
        case .ink:          return "drop.fill"
        case .dizzy:        return "arrow.triangle.2.circlepath"
        case .leaderStrike: return "crown.fill"
        case .shield:       return "shield.fill"
        }
    }

    /// One-line effect reminder shown under the slot name.
    public var blurb: String {
        switch self {
        case .boost:        return "×1.4 speed · 2s"
        case .stun:         return "rival stops · 2s"
        case .ink:          return "rival's screen · 4s"
        case .dizzy:        return "rival steers backwards · 4s"
        case .leaderStrike: return "1st place ×0.3 · 3s"
        case .shield:       return "absorbs one hit"
        }
    }

    /// Declaration order of the module's `Item` sum type. Used only when the
    /// server hands us a positional SATS tag (`{"2": []}`) instead of a name.
    public static let satsOrder: [Item] = [.boost, .stun, .ink, .dizzy, .leaderStrike, .shield]

    /// Tolerant parse: accepts `boost`, `Boost`, `BOOST`, `stun_shot`,
    /// `StunShot`, `leader_strike`, `slow` (the module's kind for Leader
    /// Strike) and bare variant indices.
    public static func parse(_ raw: String?) -> Item? {
        guard let raw = raw else { return nil }
        let key = raw.lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
        switch key {
        case "boost":                                  return .boost
        case "stun", "stunshot":                       return .stun
        case "ink", "inksplat":                        return .ink
        case "dizzy", "dizzyray":                      return .dizzy
        case "leaderstrike", "slow", "strike":         return .leaderStrike
        case "shield":                                 return .shield
        default:
            if let idx = Int(key), idx >= 0, idx < satsOrder.count { return satsOrder[idx] }
            return nil
        }
    }
}

/// `effect.kind` as the module writes it. Note `slow` is Leader Strike's kind.
public enum EffectKind: String, CaseIterable, Codable, Sendable {
    case boost
    case stun
    case ink
    case dizzy
    case slow
    case shield

    public static let satsOrder: [EffectKind] = [.boost, .stun, .ink, .dizzy, .slow, .shield]

    public static func parse(_ raw: String?) -> EffectKind? {
        guard let raw = raw else { return nil }
        let key = raw.lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
        switch key {
        case "boost":                          return .boost
        case "stun", "stunshot":               return .stun
        case "ink", "inksplat":                return .ink
        case "dizzy", "dizzyray":              return .dizzy
        case "slow", "leaderstrike":           return .slow
        case "shield":                         return .shield
        default:
            if let idx = Int(key), idx >= 0, idx < satsOrder.count { return satsOrder[idx] }
            return nil
        }
    }

    public var bannerText: String {
        switch self {
        case .boost:  return "BOOST"
        case .stun:   return "STUNNED"
        case .ink:    return "INKED"
        case .dizzy:  return "CONTROLS SWAPPED"
        case .slow:   return "LEADER STRIKE"
        case .shield: return "SHIELD UP"
        }
    }

    public var symbolName: String {
        switch self {
        case .boost:  return "bolt.fill"
        case .stun:   return "hand.raised.fill"
        case .ink:    return "drop.fill"
        case .dizzy:  return "arrow.triangle.2.circlepath"
        case .slow:   return "tortoise.fill"
        case .shield: return "shield.fill"
        }
    }
}
