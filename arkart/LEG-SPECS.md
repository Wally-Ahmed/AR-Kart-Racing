# AR Kart BUILD — leg dispatch dossier (conductor artifact)

Written 2026-09-20 ~02:30 by the conductor immediately after the FIRST WAVE of six Opus legs was
killed ~3 min in (user restarting the session for a model upgrade — build order **"start the
build"** was given 02:20 and STANDS; the kill was infrastructural, not a cancellation).

**How to re-dispatch:** six parallel Agent calls in ONE message, `subagent_type: "general-purpose"`,
`model: "opus"`, one prompt each from the sections below, verbatim. Conductor then verifies each
report against its acceptance line per CLAUDE.md § BUILD LOOP (two-strike → Fable@max escalation).

**SPEED RULE (user, 2026-09-20 ~02:45 — standing, saved in CLAUDE.md):** build for speed, finish
fast. APPEND THIS TO EVERY LEG PROMPT at dispatch: "SPEED: kick long installs/downloads off in
the background immediately and write code while they run; batch independent tool calls; choose
the fastest working option over polish; report the moment your acceptance line is met." The
conductor dispatches every dispatchable leg at once (cap lifted beyond ~6 if warranted) and
verifies legs as their reports land — never wait for the full wave.

**First-wave residue:** legs died during setup, so expect: possible partial `arkart/<part>/`
scaffolding (safe to overwrite), XcodeGen already brew-installed, a possibly-orphaned background
ESP-IDF install (firmware leg had just started one — check for a partial `~/esp` or similar clone
before re-installing). Each re-dispatched leg should treat its directory as reclaimable scratch.

**Cross-leg contract (conductor-dictated, repeated in each prompt):** module name `arkart`; local
server http://localhost:3000; UDP packet = 8 bytes `'A'(0x41),'K'(0x4B), kart_id u8, throttle u8,
steer i8, flags u8 (bit0=shield), seq u16 LITTLE-ENDIAN` → `<kart-ip>:7777`; MJPEG at
`http://<kart-ip>/stream`; kart ids 1 and 2; `karts.json` maps id→ip. Binding spec =
`docs/design/arkart-game-software-v1.md`. Probe constants land ONLY in
`arkart/firmware/main/motor_map.h` as `PROBE-TODO` placeholders.

---

## Leg 1 — module (`arkart/module/`)

You are BUILDER LEG "module" in a conductor-pattern build (AR Kart @ HopHacks — submission is TODAY, Sunday 2026-09-20, so bias to a working MVP over polish). Work at maximum depth and rigor.

REPO ROOT: /Users/wally/Documents/GitHub/2027-Hackathons/HOP-HACKS
YOUR EXCLUSIVE DIRECTORY: arkart/module/ (create with mkdir -p; NEVER modify any file outside it; read-only access to docs/ is fine). Do NOT run any git commands. Do NOT scan the repo — read ONLY the files named here.

READ FIRST: docs/design/arkart-game-software-v1.md — the binding spec. Your sections: §1 (game rules), §2 (track setup), §4 (SpacetimeDB module — your component), §10 (tiers). Implement §4 faithfully.

TASK: Build the authoritative SpacetimeDB game-server module in TYPESCRIPT (SpacetimeDB now supports TS as a module language), module name exactly `arkart`.
- Tables: config, kart, input, track, setup_seen, progress, inventory, effect (expires_at is OPTIONAL — shield has no expiry), event_log — fields per spec §4.
- Reducers: set_input, report_gate, use_item, report_hit, begin_setup, confirm_track, start_race, reset_race, abort_race, tick (scheduled reducer for effect expiry etc.).
- Game rules (spec §1): items granted at EVERY checkpoint pass, random from 6, max 2 inventory slots; Boost ×1.4/2s self; Stun Shot (victim throttle forced 0, 2s); Ink Splat (victim screen only, 4s — module just records the effect, clients render); Dizzy Ray (steer inverted, 4s — applied at the car bridge); Leader Strike (kind `slow`, ×0.3/3s, targets CURRENT 1st place); Shield (absorbs exactly one incoming hit, no expiry). Placement ordering: lap DESC, next_idx DESC, ts ASC (earlier wins ties).
- Track setup (spec §2): begin_setup → race state `setup`; report_gate during setup appends first-seen tag order to setup_seen; confirm_track copies setup_seen→track (seq 0 = start/finish) and transitions setup→lobby. During `running`, report_gate only advances a kart whose next expected checkpoint matches; lap increments at seq 0; grants an item on every valid pass.
- Guard: when race state ≠ running, set_input is stored but the bridge zeroes throttle — additionally have logic tolerate inputs in any state without error.

TOOLCHAIN: check `spacetime version`; if missing, install the official SpacetimeDB CLI (curl installer from spacetimedb.com). The TS module API is NEW — do not trust memory: fetch current docs via the Context7 MCP tools (resolve-library-id "spacetimedb" then query-docs) or WebFetch https://spacetimedb.com/docs. Get the real decorators/API for tables, reducers, scheduled reducers in TS.

CONTRACT (conductor-dictated, other legs build against it): module name `arkart`; local server http://localhost:3000 (`spacetime start` default); kart ids 1 and 2.

SELF-CHECK before reporting: `spacetime start` locally, `spacetime publish` the module as `arkart`, then run a scripted smoke you write at arkart/module/smoke.sh: begin_setup → report_gate tags 7,3,9 (calibration) → confirm_track → start_race → set_input → report_gate progression through a full lap → use_item → report_hit where a shield absorbs → verify placement/inventory/effect state via `spacetime sql`. Also write arkart/module/README.md with exact run commands.

ACCEPTANCE LINE: "module publishes to a local spacetime instance and smoke.sh passes end-to-end, with SQL output showing correct placement, inventory (max 2), and effect rows."

TWO-STRIKE RULE: any single defect gets at most 2 fix attempts; after the 2nd failure STOP touching the affected files and report BLOCKED with both attempts' diffs and reasoning.

FINAL REPORT FORMAT (your final text — raw data for the conductor, not prose for a human):
STATUS: DONE|PARTIAL|BLOCKED
FILES: <list>
SELF-CHECK: <commands run + key output lines verbatim>
ACCEPTANCE: <met? evidence>
DEVIATIONS/ASSUMPTIONS: <list — esp. any spec ambiguity you resolved>
CONDUCTOR-VERIFY: <exact commands for the conductor to re-run>

---

## Leg 2 — car-bridge (`arkart/car-bridge/`)

You are BUILDER LEG "car-bridge" in a conductor-pattern build (AR Kart @ HopHacks — submission TODAY Sun 2026-09-20; working MVP over polish). Work at maximum depth and rigor.

REPO ROOT: /Users/wally/Documents/GitHub/2027-Hackathons/HOP-HACKS
YOUR EXCLUSIVE DIRECTORY: arkart/car-bridge/ (mkdir -p; NEVER modify anything outside it; docs/ is read-only). No git commands. Read ONLY the files named here.

READ FIRST: docs/design/arkart-game-software-v1.md §3 (topology), §5 (car bridge — your component), §6 (firmware contract/packet).

TASK: Node + TypeScript daemon — the enforcer between SpacetimeDB and the karts.
- Subscribes to kart, input, effect, config tables (SpacetimeDB TS client SDK @clockworklabs/spacetimedb-sdk; SPACETIME_URI env, default ws://localhost:3000, module `arkart`).
- IMPORTANT ISOLATION: the module is being built in parallel, so generated bindings don't exist yet. Put ALL SpacetimeDB access behind a thin adapter interface (your own row types matching spec §4 field-for-field); keep the game logic PURE and unit-testable. Live-wire hookup happens at conductor integration — code it, but it need not be exercised in tests.
- Per-kart 50 Hz loop: cap = product of all active boost/slow multipliers for that kart (floor 0.2); thr = stunned ? 0 : round(input.throttle × cap); str = dizzy-active ? −input.steer : input.steer; flags bit0 = shield active; race state ≠ running → thr = 0 (kill switch).
- Packet (conductor-dictated contract, firmware implements the same): exactly 8 bytes: byte0 'A' (0x41), byte1 'K' (0x4B), byte2 kart_id u8, byte3 throttle u8 (0–255), byte4 steer i8 (−127..127), byte5 flags u8 (bit0 = shield LED), bytes6–7 seq u16 LITTLE-ENDIAN, monotonically increasing. UDP to each kart's IP:7777, from a config file arkart/car-bridge/karts.json mapping kart_id → ip (ids 1 and 2).

SELF-CHECK: `npx tsc --noEmit` clean AND `npm test` passing unit tests that cover at minimum: golden byte-vectors for the packet encoder (including negative steer two's-complement and seq LE wraparound), effect merging (boost alone, boost+slow stacking to the 0.2 floor, stun zeroing, dizzy inversion, shield flag bit), and the not-running kill switch. Write arkart/car-bridge/README.md with run commands.

ACCEPTANCE LINE: "tsc clean and all unit tests pass, including golden packet byte-vectors matching the dictated 8-byte LE format."

TWO-STRIKE RULE: max 2 fix attempts per defect; on the 2nd failure STOP touching affected files, report BLOCKED with both attempts' diffs + reasoning.

FINAL REPORT FORMAT (raw data for the conductor):
STATUS: DONE|PARTIAL|BLOCKED
FILES: <list>
SELF-CHECK: <commands + key output verbatim>
ACCEPTANCE: <met? evidence>
DEVIATIONS/ASSUMPTIONS: <list>
CONDUCTOR-VERIFY: <exact commands>

---

## Leg 3 — firmware (`arkart/firmware/`)

You are BUILDER LEG "firmware" in a conductor-pattern build (AR Kart @ HopHacks — submission TODAY Sun 2026-09-20; working MVP over polish). Work at maximum depth and rigor.

REPO ROOT: /Users/wally/Documents/GitHub/2027-Hackathons/HOP-HACKS
YOUR EXCLUSIVE DIRECTORY: arkart/firmware/ (mkdir -p; NEVER modify anything outside it; docs/ read-only; the OLD firmware/payload/ dir is a different shelved project — do not touch or copy it). No git commands.

READ FIRST (targeted, nothing else): docs/design/arkart-game-software-v1.md §6 (firmware contract — your component); then `ls docs/research/` and read the pin-map/PWM research doc and the relevant camera/FPV sections of the car/tag/FPV brief there. The research is authoritative on pins and LEDC timer allocation.

HARDWARE: ESP32-S3-CAM board (OV3660 sensor, N16R8 = 16MB flash / 8MB PSRAM). Pins (from research, verify in the doc): drive motor PWM GPIO14 (low-side NPN pair, forward-only); steer coil H-bridge GPIO41 + GPIO42 (NEVER both on — enforce dead-time; polarity/variant behind #defines since Variant P vs N is undecided); WS2812 status LED GPIO48 (RMT); GPIO47 + GPIO3 RESERVED for the TV-remote-style 38 kHz IR tag feature (T3 stretch — reserve pins with comments only, implement nothing). The camera driver owns LEDC timer0 — allocate drive PWM on a DIFFERENT LEDC timer.

TASK: ESP-IDF app:
1. WiFi STA (SSID/pass + kart_id via Kconfig).
2. MJPEG HTTP stream served at http://<ip>/stream (esp32-camera component; conductor-dictated URL other legs depend on).
3. UDP listener on :7777 parsing the 8-byte control packet: byte0 'A', byte1 'K', byte2 kart_id (ignore packets for other ids), byte3 throttle u8, byte4 steer i8, byte5 flags u8 (bit0 = shield), bytes6–7 seq u16 LITTLE-ENDIAN (drop stale/duplicate seq, tolerate wraparound).
4. 300 ms watchdog: no valid packet → throttle PWM 0 and steer released.
5. Throttle → LEDC PWM on GPIO14 with a slew/ramp cap; steer → H-bridge with dead-time.
6. WS2812: cyan while flags bit0 set; otherwise a dim idle color; distinct blink while unconnected/watchdog-tripped.
7. arkart/firmware/main/motor_map.h holds ALL probe-dependent constants as placeholders each marked `// PROBE-TODO`: MIN_DUTY (deadband), STEER_SIGN, STEER_VARIANT_P_OR_N, MAX_RAMP. Bench-probe numbers drop in later — this is the designed landing spot.

WORDING RULE (hard): in every comment/doc, IR hardware is only ever "TV-remote-style 38 kHz IR tag" — never gun/weapon/shoot phrasing for the hardware.

TOOLCHAIN: check `idf.py --version`. If ESP-IDF isn't installed, install v5.x properly (git clone --depth 1 the release branch, ./install.sh esp32s3, source export.sh). If installation genuinely fails after honest attempts, deliver complete code + exact build instructions and report PARTIAL with the reason — never claim a build you didn't run.

SELF-CHECK: `idf.py set-target esp32s3 && idf.py build` succeeds. Write arkart/firmware/README.md (build/flash/monitor commands, Kconfig options, where probe constants go).

ACCEPTANCE LINE: "idf.py build succeeds for esp32s3 with camera stream, UDP control, watchdog, and WS2812 all compiled in; motor_map.h carries the PROBE-TODO constants."

TWO-STRIKE RULE: max 2 fix attempts per defect; on the 2nd failure STOP touching affected files, report BLOCKED with both attempts' diffs + reasoning.

FINAL REPORT FORMAT (raw data for the conductor):
STATUS: DONE|PARTIAL|BLOCKED
FILES: <list>
SELF-CHECK: <commands + key output verbatim>
ACCEPTANCE: <met? evidence>
DEVIATIONS/ASSUMPTIONS: <list — esp. pin or timer decisions>
CONDUCTOR-VERIFY: <exact commands>

---

## Leg 4 — vision (`arkart/vision/`)

You are BUILDER LEG "vision" in a conductor-pattern build (AR Kart @ HopHacks — submission TODAY Sun 2026-09-20; working MVP over polish). Work at maximum depth and rigor.

REPO ROOT: /Users/wally/Documents/GitHub/2027-Hackathons/HOP-HACKS
YOUR EXCLUSIVE DIRECTORY: arkart/vision/ (mkdir -p; NEVER modify anything outside it; docs/ read-only). No git commands. Read ONLY the files named here.

READ FIRST: docs/design/arkart-game-software-v1.md §7 (vision bridge — your component) and §2 (what report_gate must receive); then `ls docs/research/` and read the AprilTag/aruco detection recipe section (§4g) of the car/tag/FPV research brief there.

TASK: Python service that watches each kart's FPV feed and reports gate passes:
- Config file arkart/vision/karts.json: kart_id → MJPEG stream URL (conductor contract: http://<kart-ip>/stream, kart ids 1 and 2).
- OpenCV consumption of MJPEG; cv2.aruco with DICT_APRILTAG_36h11 (tags are 150 mm gate-post markers).
- Debounce: a tag counts as a pass only after N consecutive detection frames, then a per-(kart, tag) cooldown so one physical pass fires exactly once. Tunable constants at the top.
- On a pass: HTTP POST to the SpacetimeDB reducer — http://localhost:3000/v1/database/arkart/call/report_gate with the (kart_id, tag_id) args. VERIFY the current call-endpoint arg format against real SpacetimeDB HTTP-API docs (Context7 MCP "spacetimedb" or WebFetch https://spacetimedb.com/docs) — don't guess; wrap it in one small adapter function so the format is fixable in one place.
- venv + requirements.txt (opencv-contrib-python, numpy, requests or httpx, pytest).

SELF-CHECK: pytest suite passing, covering at minimum: a synthetic frame generated with cv2.aruco.generateImageMarker for tag 7 is detected as 7; the debounce/cooldown state machine (N-frame confirm, single fire, cooldown re-arm); the reducer call with HTTP mocked (correct URL + payload shape). Write arkart/vision/README.md with run commands.

ACCEPTANCE LINE: "pytest passes: synthetic 36h11 tag detected with correct id, debounce fires exactly once per pass, mocked report_gate call has the documented endpoint format."

TWO-STRIKE RULE: max 2 fix attempts per defect; on the 2nd failure STOP touching affected files, report BLOCKED with both attempts' diffs + reasoning.

FINAL REPORT FORMAT (raw data for the conductor):
STATUS: DONE|PARTIAL|BLOCKED
FILES: <list>
SELF-CHECK: <commands + key output verbatim>
ACCEPTANCE: <met? evidence>
DEVIATIONS/ASSUMPTIONS: <list>
CONDUCTOR-VERIFY: <exact commands>

---

## Leg 5 — ios (`arkart/ios/`)

You are BUILDER LEG "ios" in a conductor-pattern build (AR Kart @ HopHacks — submission TODAY Sun 2026-09-20; working MVP over polish). Work at maximum depth and rigor.

REPO ROOT: /Users/wally/Documents/GitHub/2027-Hackathons/HOP-HACKS
YOUR EXCLUSIVE DIRECTORY: arkart/ios/ (mkdir -p; NEVER modify anything outside it; docs/ read-only; the OLD ios/DonorDuelPilot dir is a different shelved project — do not touch it). No git commands. Read ONLY the files named here.

READ FIRST: docs/design/arkart-game-software-v1.md §8 (iOS pilot app — your component), §1 (controls + items for the HUD).

TASK: Native SwiftUI iPhone app "ARKartPilot", landscape, free-provisioning friendly (NO paid-account entitlements, no push, no special capabilities — must run via Xcode free provisioning, 7-day profile):
- FPV: full-screen WKWebView pointed at the kart's MJPEG stream (conductor contract: http://<kart-ip>/stream) — WKWebView renders MJPEG natively, do not parse frames.
- Touch controls overlaid: right-side vertical throttle (hold-to-drive), left-side horizontal steer, two item-slot buttons.
- Gamepad: GCController extendedGamepad, Xbox layout — RT = throttle, left-stick X = steer, A = fire slot 1, B = fire slot 2. Gamepad overrides touch while connected.
- Settings sheet: server URL (default http://localhost:3000), kart id (1 or 2), stream URL.
- Networking — plain HTTP only (NO SpacetimeDB Swift SDK exists; none needed): POST the `set_input` reducer on module `arkart` at 25 Hz on a timer, sending even when unchanged (it is the keep-alive); poll the HUD at 5 Hz via POST /v1/database/arkart/sql (placement, lap, inventory slots, active effects). Verify both endpoint formats against real SpacetimeDB HTTP-API docs (WebFetch https://spacetimedb.com/docs) — wrap each in one adapter function.
- HUD: position/lap, two inventory slots with item icons/names, shield indicator; when an Ink Splat effect targets THIS kart, splat an ink overlay over the screen for 4 s (screen-only effect — the car is unaffected).
- Item names in UI: Boost, Stun Shot, Ink Splat, Dizzy Ray, Leader Strike, Shield. WORDING RULE for any comments/docs mentioning the stretch IR hardware: "TV-remote-style 38 kHz IR tag" — never gun/weapon hardware phrasing (in-game item NAMES above are fine).
- Project structure: prefer XcodeGen (brew install xcodegen if missing — first wave already installed it) with project.yml so the pbxproj is generated; hand-rolled pbxproj acceptable if you must.

SELF-CHECK: `xcodebuild -scheme ARKartPilot -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build` succeeds (list available SDKs first; adapt destination if needed). If Xcode is genuinely unusable on this machine, report PARTIAL honestly with exact user steps — never claim a build you didn't run. Write arkart/ios/README.md (open/build/run + free-provisioning steps).

ACCEPTANCE LINE: "xcodebuild simulator build succeeds; app contains FPV WebView, touch+GCController input at 25 Hz set_input, 5 Hz HUD poll, ink overlay, shield indicator."

TWO-STRIKE RULE: max 2 fix attempts per defect; on the 2nd failure STOP touching affected files, report BLOCKED with both attempts' diffs + reasoning.

FINAL REPORT FORMAT (raw data for the conductor):
STATUS: DONE|PARTIAL|BLOCKED
FILES: <list>
SELF-CHECK: <commands + key output verbatim>
ACCEPTANCE: <met? evidence>
DEVIATIONS/ASSUMPTIONS: <list>
CONDUCTOR-VERIFY: <exact commands>

---

## Leg 6 — director (`arkart/director/`)

You are BUILDER LEG "director" in a conductor-pattern build (AR Kart @ HopHacks — submission TODAY Sun 2026-09-20; working MVP over polish). Work at maximum depth and rigor.

REPO ROOT: /Users/wally/Documents/GitHub/2027-Hackathons/HOP-HACKS
YOUR EXCLUSIVE DIRECTORY: arkart/director/ (mkdir -p; NEVER modify anything outside it; docs/ read-only). No git commands. Read ONLY the files named here.

READ FIRST: docs/design/arkart-game-software-v1.md §9 (director screen — your component), §2 (track-setup flow it drives), §1 (placement rules).

TASK: Web app (Vite + TypeScript) — the judges' view and race control, using the SpacetimeDB TS client SDK (@clockworklabs/spacetimedb-sdk; SPACETIME_URI default ws://localhost:3000, module `arkart`):
- Live subscriptions: race state, karts with computed placement (lap DESC, next checkpoint idx DESC, ts ASC — earlier wins ties), per-kart inventory (2 slots), active effects with countdowns, scrolling event_log feed.
- Track-setup panel: Begin Setup, live setup_seen first-seen tag order, Confirm Track, then Start Race / Reset Race.
- A big red ABORT button → abort_race.
- Make it read as a slick race-director console (dark, large placement numbers) — judges look at this screen.
- ISOLATION: the module is built in parallel, so generated bindings don't exist yet. Put SDK access behind a thin adapter with your own row types matching spec §4 field-for-field; keep placement/derivation logic pure and unit-tested. Live hookup happens at conductor integration.

SELF-CHECK: `npm run build` clean (tsc + vite build) AND `npm test` passing a unit test of the placement comparator (lap/next_idx/ts ordering incl. tie). Write arkart/director/README.md with run commands.

ACCEPTANCE LINE: "vite+tsc build clean; placement comparator unit test passes; UI includes setup panel, live standings, effects, event feed, ABORT."

TWO-STRIKE RULE: max 2 fix attempts per defect; on the 2nd failure STOP touching affected files, report BLOCKED with both attempts' diffs + reasoning.

FINAL REPORT FORMAT (raw data for the conductor):
STATUS: DONE|PARTIAL|BLOCKED
FILES: <list>
SELF-CHECK: <commands + key output verbatim>
ACCEPTANCE: <met? evidence>
DEVIATIONS/ASSUMPTIONS: <list>
CONDUCTOR-VERIFY: <exact commands>
