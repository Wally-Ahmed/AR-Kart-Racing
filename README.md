# AR Kart Racing

Real-life Mario Kart, built from stock toy RC cars. Nothing inside the car is modified —
an ESP32-S3-CAM rides on each car and electrically "presses" the buttons of the car's own
stock remote, which is mounted inside the shell. The same board streams first-person video
over Wi-Fi and fires/receives a 38 kHz infrared "tag" beam for item combat.

## How it drives

Phone (web pilot) → SpacetimeDB `set_input` reducer → TypeScript car-bridge → 50 Hz UDP →
ESP32 → open-drain button presses on the stock remote → the car's own radio does the rest.
A 300 ms watchdog releases everything if the link drops; aborting the race is a global kill
switch.

## The pieces

| Directory | What it is |
|---|---|
| `arkart/firmware/` | ESP-IDF firmware: button tap (`btn_remote`), UDP net drive (`net_drive`), IR tag TX/RX (`ir_tag`), camera streaming |
| `arkart/module/` | SpacetimeDB module (TypeScript): race state, gates, laps, placement, six items, shield absorb |
| `arkart/car-bridge/` | Subscribes to the module, merges item effects, emits the 50 Hz UDP drive packets |
| `arkart/vision/` | Python AprilTag gate detection → `report_gate` reducer (laps and placement) |
| `arkart/director/` | Judges' live race screen + drive control (web) |
| `arkart/director/pilot.html` | Phone cockpit: FPV video, touch pads, arm/abort |
| `arkart/ios/` | Native SwiftUI pilot (optional; the web pilot is the primary) |
| `arkart/integration/` | End-to-end test harness + `raceday.sh` one-command bring-up |
| `arkart/RACE-DAY.md` | Event-day checklist |
| `docs/design/` | The narrated build walkthrough (open `arkart-build-sheet-tour.html`) |

## Build walkthrough

`docs/design/arkart-build-sheet-tour.html` is a 10-scene narrated tour of the whole hardware
build — serve the `docs/design/` directory with any static server and press play.

## Quick start (bench)

```bash
cd arkart/integration && ./raceday.sh     # spacetime + module + bridge + vision + web
```

See `arkart/RACE-DAY.md` for the full bring-up and failure drills.
