import SwiftUI

/// The cockpit: FPV underneath, everything else painted on top.
@MainActor
struct RootView: View {

    @StateObject private var settings = AppSettings.shared
    @StateObject private var engine = PilotEngine(settings: AppSettings.shared)
    @StateObject private var gamepad = GamepadManager()

    @State private var showSettings = false
    @State private var reloadToken = 0
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // 1 — FPV video
            if let url = settings.streamURLValue {
                FPVWebView(url: url, reloadToken: reloadToken)
                    .ignoresSafeArea()
            } else {
                noStreamPlaceholder
            }

            // 2 — Ink Splat: screen-only, over the video but under the controls
            if let until = engine.inkUntil {
                InkOverlay(until: until, duration: PilotEngine.inkDuration)
            }

            // 3 — HUD + controls
            controlLayer
        }
        .statusBarHidden(true)
        .sheet(isPresented: $showSettings) {
            SettingsSheet(settings: settings) {
                applySettings()
            }
        }
        .onAppear { boot() }
        .onDisappear { engine.stop() }
        .onChange(of: gamepad.connected) { connected in
            // A pad takes over the moment it appears; touch resumes when it goes.
            engine.gamepadConnected = connected
        }
        .onChange(of: scenePhase) { phase in
            // Backgrounding must park the kart: we stop sending, and the car
            // bridge zeroes throttle on input older than 500 ms.
            if phase == .active {
                engine.start()
            } else {
                engine.stop()
            }
        }
    }

    // MARK: - Layers

    private var controlLayer: some View {
        VStack(spacing: 0) {
            HUDOverlay(
                hud: engine.hud,
                linkUp: engine.linkUp,
                lastError: engine.lastError,
                kartID: settings.kartID,
                gamepadConnected: engine.gamepadConnected,
                onSettings: { showSettings = true },
                onReloadStream: { reloadToken &+= 1 }
            )

            Spacer(minLength: 0)

            HStack(alignment: .bottom, spacing: 12) {
                SteerPad(
                    value: engine.steer,
                    enabled: !engine.gamepadConnected,
                    inverted: engine.hud.isDizzy(),
                    onChange: { engine.setTouchSteer($0) },
                    onRelease: { engine.setTouchSteer(0) }
                )
                .frame(height: 104)
                .frame(maxWidth: 260)

                Spacer(minLength: 0)

                HStack(spacing: 10) {
                    ItemSlotButton(
                        slot: 1,
                        item: engine.hud.slot1,
                        padHint: "A",
                        showPadHint: engine.gamepadConnected,
                        action: { engine.fire(slot: 1) }
                    )
                    ItemSlotButton(
                        slot: 2,
                        item: engine.hud.slot2,
                        padHint: "B",
                        showPadHint: engine.gamepadConnected,
                        action: { engine.fire(slot: 2) }
                    )
                }

                Spacer(minLength: 0)

                ThrottlePad(
                    value: engine.throttle,
                    enabled: !engine.gamepadConnected,
                    onChange: { engine.setTouchThrottle($0) },
                    onRelease: { engine.setTouchThrottle(0) }
                )
                .frame(width: 84, height: 190)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    private var noStreamPlaceholder: some View {
        VStack(spacing: 10) {
            Image(systemName: "video.slash.fill")
                .font(.system(size: 34, weight: .bold))
                .foregroundColor(.white.opacity(0.5))
            Text("No FPV stream URL")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundColor(.white.opacity(0.7))
            Button("Open settings") { showSettings = true }
                .foregroundColor(Theme.accent)
        }
    }

    // MARK: - Wiring

    @MainActor
    private func boot() {
        gamepad.onThrottle = { value in engine.setPadThrottle(value) }
        gamepad.onSteer = { value in engine.setPadSteer(value) }
        gamepad.onFire = { slot in engine.fire(slot: slot) }
        gamepad.start()
        engine.gamepadConnected = gamepad.connected
        engine.start()
    }

    @MainActor
    private func applySettings() {
        if settings.streamAuto {
            settings.streamURL = AppSettings.defaultStreamURL(kartID: settings.kartID)
        }
        engine.settingsChanged()
        reloadToken &+= 1
    }
}
