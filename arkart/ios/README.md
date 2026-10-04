# ARKartPilot — the AR Kart pilot app (iOS, SwiftUI)

Native landscape iPhone cockpit for AR Kart. FPV video from the kart fills the
screen; the HUD, the touch controls and the ink splat are painted on top.
Talks to SpacetimeDB over **plain HTTP only** — there is no SpacetimeDB Swift
SDK and none is needed, so this target has **zero third-party dependencies**.

Implements design doc §8 (and §1 for controls and items).

---

## What it does

| Piece | Where |
|---|---|
| FPV — `WKWebView` on `http://<kart-ip>/stream` (WebKit decodes MJPEG natively) | `Sources/Views/FPVWebView.swift`, `Sources/Core/FPVPage.swift` |
| Touch controls — left steer strip, right hold-to-drive throttle, 2 item slots | `Sources/Views/ControlPads.swift` |
| Gamepad — `GCController` extendedGamepad, Xbox layout: RT throttle, left stick X steer, A/B fire | `Sources/Input/GamepadManager.swift` |
| 25 Hz `set_input` loop + 5 Hz HUD SQL poll | `Sources/Core/PilotEngine.swift` |
| The two HTTP adapters (reducer call, SQL) | `Sources/Core/STDBClient.swift` |
| SATS-JSON decoding | `Sources/Core/SATS.swift` |
| HUD query + decode | `Sources/Core/HUDQuery.swift`, `HUDState.swift` |
| HUD: position, lap, 2 slots, shield indicator, effect banners | `Sources/Views/HUDOverlay.swift` |
| Ink Splat screen overlay (4 s, fading) | `Sources/Views/InkOverlay.swift` |
| Settings sheet (server URL, kart 1/2, stream URL) | `Sources/Views/SettingsSheet.swift` |

### Wire contract

Taken from <https://spacetimedb.com/docs/http/database> and then **verified
against the live published `arkart` module** (SpacetimeDB 2.4.1) on 2026-09-20:

```
POST  http://<server>/v1/database/arkart/call/set_input     body: [kart_id, throttle, steer]   (JSON array)
POST  http://<server>/v1/database/arkart/call/use_item      body: [kart_id, slot]              (JSON array)
POST  http://<server>/v1/database/arkart/sql                body: ONE SQL statement (text/plain)
      -> [ {"schema": ProductType, "rows": [ProductValue, ...]} ]
```

> The docs say a SQL body may hold several `;`-separated statements. The 2.4.1
> server does **not**: it answers `Multiple SQL statements are not supported`
> (HTTP 400). The HUD therefore fires its four queries as four concurrent
> requests (`STDBClient.sqlBatch`) and stitches the results back in order.

```sql
SELECT * FROM progress  WHERE kart_id = N
SELECT * FROM inventory WHERE kart_id = N
SELECT * FROM effect    WHERE kart_id = N
SELECT * FROM config
```

Row encoding, as the live server actually emits it:

| Thing | Wire form |
|---|---|
| Row | positional JSON array matching `schema.elements` |
| `Option::some(v)` / `none` | `[0, v]` / `[1, []]` |
| `Timestamp` | `[micros_since_unix_epoch]` (a one-field product) |
| Item id (`slot_1`, `slot_2`) | `Option<String>` — `boost`, `stun`, `ink`, `dizzy`, `leader_strike`, `shield` |
| `effect.kind` | plain `String` — `slow` is Leader Strike |
| `config.state` | plain `String` — `setup` / `lobby` / `countdown` / `running` / `finished` |

All of that is decoded in `SATS.swift`, tolerantly (the older `{"some": v}`
named form still works). The two endpoint formats live in exactly one function
each — `STDBClient.callReducer` and `STDBClient.sql` — so a wire change is a
two-line fix.

Placement comes straight from `progress.placement`; the app never ranks karts
itself, so the module's comparator is the only one that exists.

`set_input` is sent **every tick even when nothing changed** — it doubles as the
keep-alive. The car bridge zeroes throttle when `input.updated_at` is older than
500 ms, so backgrounding the app parks the kart; `PilotEngine.stop()` also fires
one explicit zero on the way out.

---

## Build & run

### Prerequisites

* **Full Xcode** (not just Command Line Tools). Check with `xcodebuild -version`.
  If it errors with `requires Xcode`, install Xcode from the App Store, then:
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -runFirstLaunch
  ```
* **XcodeGen** (`brew install xcodegen`) — only to regenerate the project.

### Open it

```bash
cd arkart/ios
xcodegen generate          # regenerates ARKartPilot.xcodeproj from project.yml
open ARKartPilot.xcodeproj
```

`ARKartPilot.xcodeproj` is generated output — edit `project.yml`, never the
pbxproj. Files added under `Sources/` are picked up automatically on regenerate.

### Simulator build from the CLI

```bash
cd arkart/ios
xcodebuild -project ARKartPilot.xcodeproj -scheme ARKartPilot \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
```

---

## Install on a phone with FREE provisioning (no paid account)

This target is built to stay inside the free tier: **no entitlements file, no
capabilities, no push, no App Groups, no iCloud.** The only Info.plist privilege
is App Transport Security standing down for the plain-HTTP race LAN, which costs
nothing.

1. Xcode → **Settings → Accounts → +** → add your Apple ID (a normal free one).
2. Open `ARKartPilot.xcodeproj`, select the **ARKartPilot** target →
   **Signing & Capabilities**.
3. Tick **Automatically manage signing**, pick your **Personal Team**.
4. Change **Bundle Identifier** to something unique to you, e.g.
   `com.<yourname>.ARKartPilot`. (Free accounts get **3 app IDs per 7 days** —
   do not burn them experimenting.)
5. Plug the phone in, trust the computer, select it as the run destination, ⌘R.
6. First run only: on the phone, **Settings → General → VPN & Device Management
   → Developer App → Trust**.
7. The certificate expires after **7 days** — re-run from Xcode to renew.

One build installs on **both** pilot phones; each phone picks its kart in the
app's settings sheet.

Do this the day before the demo, not at 3am (design doc §11).

---

## Configure at the track

Tap the gear in the top-right:

* **Server URL** — the laptop running `spacetime start`, e.g.
  `http://192.168.8.2:3000`. The built-in default is `http://localhost:3000`,
  which **only works in the simulator** — on a real phone it points at the phone
  itself.
* **Kart** — 1 or 2. Decides which `kart_id` every reducer call carries and which
  rows the HUD polls.
* **FPV stream** — defaults to `http://192.168.8.10{1,2}/stream` derived from the
  kart number; untick *Derive from kart number* to type a different address.
* **Test connection** — runs `SELECT * FROM config` and shows the race state, so
  you know the phone can reach SpacetimeDB before you care about video.

The arrow button next to the gear re-arms the FPV stream if the video stalls.

## Flying it

* **Touch**: hold the right-hand bar to drive (release = brake; there is no
  reverse, matching the hardware), slide the left bar to steer (releases to
  centre), tap an item slot to fire it.
* **Gamepad**: pair an Xbox-layout controller in iOS Settings → it takes over
  automatically and a `PAD` badge appears. RT = throttle, left stick X = steer,
  A = slot 1, B = slot 2. Unplug it and touch comes straight back; control is
  forced to neutral across every hand-over.
* **Ink Splat** landing on you blacks out the screen for 4 s. It is *screen only* —
  the kart keeps doing exactly what you tell it, you just cannot see.
* **Dizzy Ray** flips your steering; the steer bar turns pink and says
  `STEER ⟲ SWAPPED`. The inversion itself happens at the car bridge.
* The cyan **SHIELD** badge mirrors the kart's onboard LED.

---

## Self-check

```bash
bash arkart/ios/tools/verify.sh
```

Stages:

1. `xcodegen generate` — the project definition is valid.
2. `swiftc -parse` over **every** source, views included.
3. `swiftc -typecheck` of `Core/` + `Input/` against the macOS SDK.
4. (3b) `swiftc -typecheck` of the UIKit-free views — `Theme`, `ControlPads`,
   `HUDOverlay`, `InkOverlay`.
   (3c) `swiftc -typecheck` of `RootView` + `SettingsSheet` with the four
   iOS-only view modifiers and `FPVWebView` shimmed. Between 3, 3b and 3c, every
   line of the app is type-checked except `FPVWebView`'s ~35 lines of WKWebView
   setup.
5. A **headless run of the real engine** against `tools/selfcheck/stub_server.py`,
   which replays the live server's exact encodings. Asserts the 25 Hz input rate,
   the 5 Hz × 4 HUD poll, the exact URLs/bodies/content-types, SATS decoding, the
   ink rising edge, the shield indicator, and that nothing is sent after `stop()`.
   If a real SpacetimeDB with the `arkart` module is answering on
   `127.0.0.1:3000` it additionally round-trips `set_input` through it for real
   (set `ARKART_LIVE_URL` to point elsewhere).
6. `xcodebuild` for the iOS simulator — skips loudly and exits 3 when full Xcode
   is missing.

---

*Stretch-hardware note: the optional IR layer is a TV-remote-style 38 kHz IR tag
on the kart. It is not part of this app; the `report_hit` path is server-side.*
