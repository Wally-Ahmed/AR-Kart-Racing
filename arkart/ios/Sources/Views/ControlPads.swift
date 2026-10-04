import SwiftUI

/// Right-side vertical throttle. Hold to drive; release snaps to zero
/// (the design has no brake and no reverse — releasing IS the brake).
struct ThrottlePad: View {
    let value: Double
    let enabled: Bool
    let onChange: (Double) -> Void
    let onRelease: () -> Void

    @State private var touching = false

    var body: some View {
        GeometryReader { geo in
            let h = max(geo.size.height, 1)
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(Color.black.opacity(0.38))

                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [Theme.accent.opacity(0.95), Theme.accent.opacity(0.35)],
                            startPoint: .bottom, endPoint: .top
                        )
                    )
                    .frame(height: h * CGFloat(min(max(value, 0), 1)))
                    .animation(.linear(duration: 0.05), value: value)

                VStack {
                    Text("GAS")
                        .font(.system(size: 11, weight: .heavy, design: .rounded))
                        .foregroundColor(.white.opacity(0.7))
                        .padding(.top, 10)
                    Spacer()
                    Text("\(Int(min(max(value, 0), 1) * 100))")
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundColor(.white)
                        .padding(.bottom, 8)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .stroke(touching ? Theme.accent : Theme.hudStroke, lineWidth: touching ? 2 : 1)
            )
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        guard enabled else { return }
                        touching = true
                        onChange(Double(1 - (drag.location.y / h)))
                    }
                    .onEnded { _ in
                        touching = false
                        onRelease()
                    }
            )
            .opacity(enabled ? 1 : 0.35)
        }
    }
}

/// Left-side horizontal steering strip. Centre = straight; release re-centres.
struct SteerPad: View {
    let value: Double
    let enabled: Bool
    let inverted: Bool          // Dizzy Ray is live — warn the pilot
    let onChange: (Double) -> Void
    let onRelease: () -> Void

    @State private var touching = false

    var body: some View {
        GeometryReader { geo in
            let w = max(geo.size.width, 1)
            let clamped = CGFloat(min(max(value, -1), 1))
            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(Color.black.opacity(0.38))

                // Centre detent
                Rectangle()
                    .fill(Color.white.opacity(0.25))
                    .frame(width: 2)

                // Deflection bar, growing out from the centre
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(inverted ? EffectKind.dizzy.tint : Theme.good)
                    .frame(width: max(4, abs(clamped) * w / 2))
                    .offset(x: clamped * w / 4)
                    .animation(.linear(duration: 0.05), value: value)

                Circle()
                    .fill(Color.white)
                    .frame(width: 26, height: 26)
                    .offset(x: clamped * w / 2 - clamped * 13)
                    .animation(.linear(duration: 0.05), value: value)

                VStack {
                    Spacer()
                    Text(inverted ? "STEER ⟲ SWAPPED" : "STEER")
                        .font(.system(size: 11, weight: .heavy, design: .rounded))
                        .foregroundColor(inverted ? EffectKind.dizzy.tint : .white.opacity(0.7))
                        .padding(.bottom, 8)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .stroke(touching ? Theme.good : Theme.hudStroke, lineWidth: touching ? 2 : 1)
            )
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        guard enabled else { return }
                        touching = true
                        onChange(Double((drag.location.x / w) * 2 - 1))
                    }
                    .onEnded { _ in
                        touching = false
                        onRelease()
                    }
            )
            .opacity(enabled ? 1 : 0.35)
        }
    }
}

/// One inventory slot: icon, item name, and the gamepad button that fires it.
struct ItemSlotButton: View {
    let slot: Int
    let item: Item?
    let padHint: String        // "A" / "B"
    let showPadHint: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: item?.symbolName ?? "questionmark")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(item?.tint ?? Color.white.opacity(0.25))
                Text(item?.displayName ?? "EMPTY")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundColor(item == nil ? .white.opacity(0.35) : .white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(width: 92, height: 62)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.black.opacity(0.5))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(item?.tint.opacity(0.9) ?? Theme.hudStroke, lineWidth: item == nil ? 1 : 2)
            )
            .overlay(alignment: .topTrailing) {
                Text(showPadHint ? padHint : "\(slot)")
                    .font(.system(size: 9, weight: .heavy, design: .rounded))
                    .foregroundColor(.black)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.85)))
                    .offset(x: -6, y: 6)
            }
        }
        .buttonStyle(.plain)
        .disabled(item == nil)
    }
}
