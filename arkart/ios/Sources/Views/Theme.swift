import SwiftUI

enum Theme {
    static let hudBG = Color.black.opacity(0.45)
    static let hudStroke = Color.white.opacity(0.18)
    static let good = Color(red: 0.22, green: 0.92, blue: 0.55)
    static let bad = Color(red: 1.0, green: 0.31, blue: 0.33)
    static let warn = Color(red: 1.0, green: 0.76, blue: 0.20)
    static let shield = Color(red: 0.35, green: 0.90, blue: 1.0)   // matches the kart's cyan LED
    static let accent = Color(red: 1.0, green: 0.52, blue: 0.10)
}

extension Item {
    var tint: Color {
        switch self {
        case .boost:        return Theme.accent
        case .stun:         return Theme.warn
        case .ink:          return Color(red: 0.55, green: 0.40, blue: 0.95)
        case .dizzy:        return Color(red: 0.95, green: 0.45, blue: 0.80)
        case .leaderStrike: return Color(red: 0.99, green: 0.84, blue: 0.29)
        case .shield:       return Theme.shield
        }
    }
}

extension EffectKind {
    var tint: Color {
        switch self {
        case .boost:  return Theme.accent
        case .stun:   return Theme.bad
        case .ink:    return Color(red: 0.55, green: 0.40, blue: 0.95)
        case .dizzy:  return Color(red: 0.95, green: 0.45, blue: 0.80)
        case .slow:   return Theme.warn
        case .shield: return Theme.shield
        }
    }
}

/// Small rounded chrome used by every HUD element.
struct HUDPanel: ViewModifier {
    var padding: CGFloat = 10
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, padding)
            .padding(.vertical, padding * 0.6)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.hudBG)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Theme.hudStroke, lineWidth: 1)
            )
    }
}

extension View {
    func hudPanel(padding: CGFloat = 10) -> some View {
        modifier(HUDPanel(padding: padding))
    }
}
