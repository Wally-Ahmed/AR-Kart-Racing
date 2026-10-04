import SwiftUI

/// Top HUD strip: placement, lap, race state, shield, live effect banners,
/// link health and the settings button.
struct HUDOverlay: View {
    let hud: HUDSnapshot
    let linkUp: Bool
    let lastError: String?
    let kartID: Int
    let gamepadConnected: Bool
    let onSettings: () -> Void
    let onReloadStream: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                placementBadge
                lapBadge
                stateBadge
                if hud.isShielded() { shieldBadge }
                Spacer(minLength: 8)
                if gamepadConnected { padBadge }
                linkBadge
                controlButtons
            }

            bannerRow
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
    }

    // MARK: - Pieces

    private var placementBadge: some View {
        VStack(spacing: 0) {
            Text(hud.placementLabel)
                .font(.system(size: 30, weight: .black, design: .rounded))
                .foregroundColor(hud.placement == 1 ? Theme.warn : .white)
            Text("POSITION")
                .font(.system(size: 8, weight: .heavy, design: .rounded))
                .foregroundColor(.white.opacity(0.55))
        }
        .hudPanel(padding: 12)
    }

    private var lapBadge: some View {
        VStack(spacing: 0) {
            Text(hud.lapLabel)
                .font(.system(size: 26, weight: .black, design: .rounded))
                .foregroundColor(.white)
            Text("LAP")
                .font(.system(size: 8, weight: .heavy, design: .rounded))
                .foregroundColor(.white.opacity(0.55))
        }
        .hudPanel(padding: 12)
    }

    private var stateBadge: some View {
        VStack(spacing: 0) {
            Text(hud.raceState.uppercased())
                .font(.system(size: 13, weight: .heavy, design: .rounded))
                .foregroundColor(hud.isRunning ? Theme.good : Theme.warn)
            Text("KART \(kartID)")
                .font(.system(size: 8, weight: .heavy, design: .rounded))
                .foregroundColor(.white.opacity(0.55))
        }
        .hudPanel(padding: 12)
    }

    /// Mirrors the kart's onboard cyan LED (spec §1: Shield lights the LED).
    private var shieldBadge: some View {
        HStack(spacing: 5) {
            Image(systemName: "shield.fill")
                .font(.system(size: 15, weight: .bold))
            Text("SHIELD")
                .font(.system(size: 11, weight: .heavy, design: .rounded))
        }
        .foregroundColor(Theme.shield)
        .hudPanel(padding: 12)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Theme.shield, lineWidth: 2)
        )
    }

    private var padBadge: some View {
        Text("PAD")
            .font(.system(size: 10, weight: .heavy, design: .rounded))
            .foregroundColor(Theme.good)
            .hudPanel(padding: 8)
    }

    private var linkBadge: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(linkUp ? Theme.good : Theme.bad)
                .frame(width: 8, height: 8)
            Text(linkUp ? "STDB" : (lastError.map { short($0) } ?? "NO LINK"))
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundColor(.white.opacity(0.8))
                .lineLimit(1)
                .frame(maxWidth: 150, alignment: .leading)
        }
        .hudPanel(padding: 8)
    }

    private var controlButtons: some View {
        HStack(spacing: 6) {
            Button(action: onReloadStream) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Theme.hudBG))
            }
            .buttonStyle(.plain)

            Button(action: onSettings) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Theme.hudBG))
            }
            .buttonStyle(.plain)
        }
    }

    private var bannerRow: some View {
        HStack(spacing: 8) {
            ForEach(hud.banners(), id: \.rawValue) { kind in
                HStack(spacing: 5) {
                    Image(systemName: kind.symbolName)
                        .font(.system(size: 12, weight: .bold))
                    Text(kind.bannerText)
                        .font(.system(size: 12, weight: .heavy, design: .rounded))
                }
                .foregroundColor(.black)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(kind.tint))
            }
            Spacer()
        }
        .animation(.easeInOut(duration: 0.15), value: hud.banners().map { $0.rawValue })
    }

    private func short(_ text: String) -> String {
        text.count > 26 ? String(text.prefix(26)) + "…" : text
    }
}
