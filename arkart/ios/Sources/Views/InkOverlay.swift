import Foundation
import SwiftUI

/// Ink Splat (spec §1): the victim's **screen** is covered in ink blots for 4 s,
/// fading out. It has no physical effect whatsoever — the car keeps driving
/// exactly as commanded, the pilot just cannot see.
struct InkOverlay: View {
    /// When the splat finishes fading.
    let until: Date
    let duration: TimeInterval

    var body: some View {
        TimelineView(.animation) { context in
            let remaining = max(0, until.timeIntervalSince(context.date))
            let progress = 1 - min(1, remaining / max(duration, 0.001))   // 0 fresh → 1 gone
            GeometryReader { geo in
                ZStack {
                    ForEach(InkBlot.pattern) { blot in
                        Ellipse()
                            .fill(Color.black)
                            .frame(
                                width: geo.size.width * blot.w * (0.55 + 0.45 * min(1, progress * 6)),
                                height: geo.size.height * blot.h * (0.55 + 0.45 * min(1, progress * 6))
                            )
                            .rotationEffect(.degrees(blot.rotation))
                            .position(x: geo.size.width * blot.x, y: geo.size.height * blot.y)
                            .blur(radius: 7)
                    }
                }
                .opacity(1 - pow(progress, 1.7))
                .overlay(alignment: .center) {
                    if progress < 0.45 {
                        Text("INK SPLAT")
                            .font(.system(size: 30, weight: .black, design: .rounded))
                            .foregroundColor(.white.opacity(0.85 * (1 - progress / 0.45)))
                            .shadow(radius: 6)
                    }
                }
            }
            .allowsHitTesting(false)      // you are blinded, not disabled
            .ignoresSafeArea()
        }
    }
}

struct InkBlot: Identifiable {
    let id: Int
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let rotation: Double

    /// A fixed hand-placed splatter — deterministic so it never re-randomises
    /// mid-animation.
    static let pattern: [InkBlot] = [
        InkBlot(id: 0,  x: 0.22, y: 0.30, w: 0.34, h: 0.46, rotation: -18),
        InkBlot(id: 1,  x: 0.55, y: 0.22, w: 0.30, h: 0.34, rotation: 24),
        InkBlot(id: 2,  x: 0.78, y: 0.48, w: 0.36, h: 0.52, rotation: -8),
        InkBlot(id: 3,  x: 0.40, y: 0.66, w: 0.32, h: 0.40, rotation: 40),
        InkBlot(id: 4,  x: 0.12, y: 0.72, w: 0.24, h: 0.30, rotation: 12),
        InkBlot(id: 5,  x: 0.66, y: 0.80, w: 0.26, h: 0.28, rotation: -32),
        InkBlot(id: 6,  x: 0.92, y: 0.18, w: 0.20, h: 0.26, rotation: 6),
        InkBlot(id: 7,  x: 0.06, y: 0.16, w: 0.18, h: 0.22, rotation: -44),
        InkBlot(id: 8,  x: 0.48, y: 0.44, w: 0.22, h: 0.24, rotation: 16),
        InkBlot(id: 9,  x: 0.86, y: 0.88, w: 0.22, h: 0.22, rotation: -12),
        InkBlot(id: 10, x: 0.30, y: 0.06, w: 0.16, h: 0.18, rotation: 28),
        InkBlot(id: 11, x: 0.62, y: 0.58, w: 0.18, h: 0.20, rotation: -22)
    ]
}
