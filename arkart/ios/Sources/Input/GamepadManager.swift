import Combine
import Foundation
import GameController

/// Xbox-layout controller support (design doc §1 "Controls"):
///   RT            → throttle
///   left stick X  → steer
///   A             → fire slot 1
///   B             → fire slot 2
///
/// Connect/disconnect is handled live; touch keeps working whenever no pad is
/// attached, and the pad takes priority the moment one is.
@MainActor
public final class GamepadManager: ObservableObject {

    @Published public private(set) var connected: Bool = false
    @Published public private(set) var controllerName: String = ""

    public var onThrottle: (@MainActor (Double) -> Void)?
    public var onSteer: (@MainActor (Double) -> Void)?
    public var onFire: (@MainActor (Int) -> Void)?

    private var observers: [NSObjectProtocol] = []

    public init() {}

    public func start() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .GCControllerDidConnect, object: nil, queue: .main
        ) { [weak self] note in
            let controller = note.object as? GCController
            Task { @MainActor [weak self] in
                if let controller = controller { self?.attach(controller) }
                self?.refresh()
            }
        })
        observers.append(center.addObserver(
            forName: .GCControllerDidDisconnect, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refresh()
            }
        })

        for controller in GCController.controllers() { attach(controller) }
        refresh()
        GCController.startWirelessControllerDiscovery(completionHandler: {})
    }

    public func stop() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        GCController.stopWirelessControllerDiscovery()
    }

    private func refresh() {
        let pads = GCController.controllers().filter { $0.extendedGamepad != nil }
        connected = !pads.isEmpty
        controllerName = pads.first?.vendorName ?? ""
        if !connected {
            // Neutral on unplug so a dropped pad can never leave throttle pinned.
            onThrottle?(0)
            onSteer?(0)
        }
    }

    private func attach(_ controller: GCController) {
        guard let pad = controller.extendedGamepad else { return }

        pad.valueChangedHandler = { [weak self] gamepad, _ in
            let throttle = Double(gamepad.rightTrigger.value)
            let steer = Double(gamepad.leftThumbstick.xAxis.value)
            Task { @MainActor [weak self] in
                self?.onThrottle?(throttle)
                self?.onSteer?(steer)
            }
        }

        pad.buttonA.pressedChangedHandler = { [weak self] _, _, pressed in
            guard pressed else { return }
            Task { @MainActor [weak self] in self?.onFire?(1) }
        }

        pad.buttonB.pressedChangedHandler = { [weak self] _, _, pressed in
            guard pressed else { return }
            Task { @MainActor [weak self] in self?.onFire?(2) }
        }
    }
}
