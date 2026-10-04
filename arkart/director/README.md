# AR Kart — Director Screen

The judges' view and race control (spec `docs/design/arkart-game-software-v1.md` §9).
Vite + TypeScript, no UI framework. Runs in a browser tab on the laptop next to `spacetime start`.

- **Live standings** — big placement numbers, lap x/N, next gate, speed cap the car bridge is
  applying, live `set_input` telemetry, race-progress bar. Ordering comes from the module's own
  `progress.placement` whenever that column is usable (see *Placement* below); the header says
  which source is in play.
- **Inventory** — the 2 slots per kart (§1 D2), colour-coded per item.
- **Active effects** — chips with live countdown bars; `shield` shows `∞` (consumed on hit, never
  expires).
- **Event feed** — `event_log`, newest first, newest row flashes.
- **Track setup panel** — the §2 calibration-lap flow: BEGIN SETUP, `setup_seen` first-seen order
  building live, per-row reorder ▲▼ and remove ✕ (the manual-edit fallback), then CONFIRM TRACK
  with the ≥3-gates / no-duplicates check enforced before the button enables.
- **Race control** — START RACE / RESET RACE, and a big red **ABORT** (`abort_race`, the kill
  switch — also bound to **Shift+Esc**).
- **Drive control** — the laptop as a pilot station: keyboard or gamepad → `set_input` at 25 Hz
  (see *Drive control* below).
- **Phone pilot** — a second page in the same app, `/pilot.html?kart=N`: FPV video, touch throttle
  and steering, ARM/DISARM/hold-ABORT (see *Phone pilot* below).

## Run

```bash
cd arkart/director
npm install
npm run dev        # director: http://localhost:5173       (LAN-visible: host is on in vite.config)
                   # pilots:   http://<laptop-ip>:5173/pilot.html?kart=1
```

```bash
npm run build      # tsc --noEmit && vite build  → dist/  (both index.html and pilot.html)
npm run preview    # serve dist/ on :5174
npm test           # vitest run  (placement comparator, SQL decoding, drive + touch mapping, wire shape)
```

## Connecting it

The screen talks to SpacetimeDB through one seam — `src/adapters/` — chosen by URL flag, so the
transport can be changed at the venue without a rebuild.

| URL | Adapter | Needs |
|-----|---------|-------|
| `/` | **auto** — SDK first, falls back to HTTP | nothing |
| `/?adapter=sdk` | WebSocket subscriptions (the sponsor-demo path) | `src/module_bindings/` + `npm run dev` |
| `/?adapter=http` | reducer calls + `SELECT *` polling every 200 ms | nothing |
| `/?adapter=mock` | fully simulated race — no server, no karts | nothing |

Other params: `?uri=ws://192.168.8.1:3000` (venue laptop), `?module=arkart`, `?poll=200`,
`?bindings=./module_bindings/index.ts`.

**To light up the WebSocket path**, generate the bindings into this project and reload with
`?adapter=sdk`:

```bash
spacetime generate --lang typescript \
  --out-dir arkart/director/src/module_bindings \
  --project-path arkart/module
```

`src/adapters/sdk.ts` loads them by dynamic import, probing the accessor conventions that differ
between generator versions — `conn.db.setup_seen` vs `conn.db.setupSeen`, `reducers.begin_setup()`
vs `reducers.beginSetup()`, and `builder.withDatabaseName()` (SDK 2.x) vs `builder.withModuleName()`
(SDK 1.x) — so nothing else has to change.

**Reducer arguments are passed as ONE OBJECT on the SDK path**, keyed by the camelCase field names
in `module_bindings/<name>_reducer.ts` — `confirmTrack({ orderedTagIds })`,
`setInput({ kartId, throttle, steer })`. This is not cosmetic and it is not the HTTP convention
(which is a positional JSON array). Pinned to the installed `spacetimedb@2.10.1`:
`db_connection_impl.#makeReducers` builds each accessor as `(params) => serializeArgs(writer, params)`
and keys it by `accessorName`, which `reducers.ts` sets to `toCamelCase(name)`. A positional call
against a 2.x binding hands the serializer a bare number where it wants an object — a malformed
frame, not a clean error, which is exactly the kind of bug that eats a demo slot. `callReducer`
sends the object and falls back to positional for 1.x bindings.

Two things that bite here:

- **Run the SDK path under `npm run dev`.** The default bindings path is `/src/module_bindings/index.ts`,
  root-relative so it resolves the same on every route; the dev server serves and transforms it. A
  `./`-relative path would resolve against the *page* URL and hit Vite's SPA fallback, which returns
  `index.html` and fails to import as JS. In a production `vite build` the bindings are not bundled
  at all (the import is `@vite-ignore`d by design, since they may not exist at build time), so a
  `dist/` build has no `/src/...` to fetch and the auto adapter drops to HTTP polling. That is fine
  for the demo — run `dev` when you want the WebSocket path.
- **A live subscription is silent when nothing is happening.** The header's staleness check applies
  only to polling transports (`DirectorAdapter.pushes`), so an idle lobby on the SDK path keeps
  reading LIVE instead of flashing ERROR.

## Drive control

The iOS app (spec §8) is the real cockpit, but the laptop can pilot a kart on its own — for
bench-testing the car bridge before a phone is provisioned, and as the demo fallback when the
7-day free-provisioning certificate has expired. It drives through the **same reducer as the
phone**, `set_input` (spec §1 D1), so nothing in the control chain is special-cased.

```bash
cd arkart/director
npm run dev                                 # http://localhost:5173
```

Then open the screen pointed at the laptop running `spacetime start`:

| What you want | URL |
|---|---|
| Live module, WebSocket (sponsor path) | `http://localhost:5173/?adapter=sdk` |
| Live module, HTTP (works without bindings) | `http://localhost:5173/?adapter=http&uri=ws://127.0.0.1:3000` |
| Live module on the venue laptop | `http://localhost:5173/?uri=ws://192.168.8.2:3000` |
| No server at all (simulated race, keys move the sim kart) | `http://localhost:5173/?adapter=mock` |

Then: pick the kart chip → **ARM DRIVE** (or **Shift+D**) → drive.

```
↑ / W     throttle            ← → / A D   steer
↓ / S     brake               Shift+D     arm / disarm
Shift+Esc ABORT — kills every kart AND disarms the drive control
```

The panel shows the live vector, the frame counter and the age of the last frame; a send failure
is printed in the panel in red rather than toasted, because at 25 Hz a toast would be a strobe.

Five things are deliberate, and `src/drive.test.ts` pins each one:

- **Arming is explicit.** Until armed, the arrow keys do nothing — the judges' screen is not
  secretly live, and `keyRole()` returns `null` for every key the control does not own, so
  Shift+Esc and the browser's own shortcuts keep working while armed.
- **No reverse.** Throttle is 0..1: the Plan-M drive stage is a low-side NPN with no H-bridge on
  the rear motor. `↓`/`S` is a positive **brake** and it outranks the throttle key.
- **ABORT disarms.** Otherwise the kill switch would be a lie — `abort_race` zeroes the inputs and
  40 ms later the armed loop would write the held throttle straight back.
- **Every tick sends, changed or not.** The frame doubles as the keep-alive the car bridge's
  300 ms staleness watchdog is watching for. Disarming, switching kart and closing the tab each
  send one explicit zero frame, the same park `PilotEngine.stop()` does on the phone.
- **Losing focus releases the keys.** A key-up delivered to another window never arrives, so
  `blur`/`visibilitychange` go neutral (still armed) instead of leaving a throttle stuck on.

A gamepad takes over automatically while it is being pushed and hands straight back when it goes
idle — Xbox layout, RT throttle, left stick X steer, matching the phone's `GamepadManager`.

`HttpAdapter.setInput` posts the same body the phone does, `[kart_id, throttle, steer]`, and
deliberately does **not** trigger the courtesy re-poll that `call()` does: at 25 Hz that would
turn into ~225 SQL requests a second. `src/adapters/http.test.ts` pins the URL, content type and
body; the same body returns HTTP 200 from the live module.

## Phone pilot (`/pilot.html`)

The pilots' cockpit — a second page in this same Vite app, so one `npm run dev` serves both the
judges' screen and every phone on the AP. It **reuses `DriveLoop` and the adapters unchanged**: a
thumb produces the same `DriveVector` the arrow keys do, goes through the same `set_input` reducer
at the same 25 Hz, and gets the same explicit-zero park on disarm. There is no second control path
to keep in sync.

```bash
cd arkart/director
npm run dev                    # host: true is already in vite.config.ts — this IS the LAN serve
# (equivalently: npm run dev -- --host, or npm run dev -- --host --port 5173)
```

Vite prints the LAN address on start (`➜  Network: http://192.168.8.2:5173/`). Each pilot opens:

```
http://<laptop-ip>:5173/pilot.html?kart=1      ← pilot 1   (e.g. http://192.168.8.2:5173/pilot.html?kart=1)
http://<laptop-ip>:5173/pilot.html?kart=2      ← pilot 2
http://<laptop-ip>:5173/pilot.html             ← no ?kart → kart picker
```

Everything the director understands works here too (`?adapter=mock|http|sdk`, `?uri=`, `?module=`,
`?poll=`), plus `?novideo=1` to skip the FPV stream (bench use, or a pilot on a flaky link).

**Claim.** `?kart=N` claims kart N straight away; without it the page shows a picker built from the
module's own `kart` rows (name, id, ip; already-claimed karts are flagged) with a claim-by-number
fallback for a kart the module has not listed. Claiming rewrites the URL to `?kart=N`, so a reload
— or the phone browser killing the tab — lands back on the same car instead of the picker. One
phone, one kart, enforced socially: this is client-side selection, **not** server-side exclusivity.

**Controls**, phone in landscape:

```
┌───────────────────────────┬───────────────────────────┐
│  STEER — absolute x       │  THROTTLE — drag UP       │
│  pad centre = straight,   │  from wherever the thumb  │
│  edges = full lock,       │  landed; 55% of the pad's │
│  snaps to 0 on release    │  height = 0 → 1           │
│                           ├───────────────────────────┤
│                           │  BRAKE  (outranks thr.)   │
└───────────────────────────┴───────────────────────────┘
```

- **Steer is absolute, throttle is relative** — a thumb needs a findable centre on the steering
  pad, but an absolute vertical throttle would launch the car the instant a thumb landed half way
  up it. Throttle therefore starts at 0 wherever the thumb touches down. The throttle anchor sinks
  if the thumb drags below it and never rises, so over-shooting downward does not dead-zone the pad.
- **Multi-touch is the point.** Each pad owns one pointer id and captures it, so steering while
  throttling (and braking on top of both) are three independent gestures. Verified with real
  two- and three-finger touch sequences, not synthetic clicks.
- **Brake outranks throttle**, exactly as `S`/`↓` beats `W`/`↑` on the laptop — the Plan-M drive
  stage has no H-bridge, so brake is force-0, never reverse.
- Pointer events throughout, `touch-action: none`, `user-scalable=no`, no selection and no
  overscroll: nothing a thumb does scrolls, zooms or selects the page.
- A **gamepad paired to the phone** takes over for free while it is being pushed — `DriveLoop`
  already polls `navigator.getGamepads()` — and hands straight back to the thumbs when it idles.
- Screen Wake Lock is requested on ARM where the browser offers it. It needs a secure context, so
  over plain http on the venue AP it simply is not there; the failure is swallowed, and the MJPEG
  stream repainting the page does most of the job anyway.

**ARM / DISARM / ABORT.**

| Control | Gesture | Effect |
|---|---|---|
| **ARM** | one tap | from here the pads move a physical car; until then nothing is sent at all |
| **DISARM** | one tap | instant — one explicit zero frame parks the kart (`DriveLoop.disarm`) |
| **ABORT** | **hold 650 ms** | disarms, then `abort_race` — every kart killed, race back to lobby |

ABORT is **hold-to-fire, not double-tap** — the documented choice. It is race-wide, so one pilot's
pocket must not be able to end everyone's race: a jostled phone or a landed palm produces taps and
double-taps all day, but not 650 ms of continuous pressure on one target. The button fills as it
charges and releasing early cancels with no side effect. The pilot's own emergency stop is DISARM,
which stays a single instant tap — the hold only gates the button that also stops everyone else's
car. Like the director, ABORT disarms *first*: otherwise the armed loop would write the held
throttle back 40 ms after `abort_race` zeroed it.

`blur` and `visibilitychange` release every thumb (`DriveLoop.releaseAll`) — a `pointerup` eaten by
the app switcher, a notification or the screen locking must not stick a throttle open — and
`pagehide` disposes the loop, which parks the kart with one explicit zero.

**HUD** (top strip): claimed kart, race state, armed + frame counter, placement/lap, and a live
**THR/STR readout taken from the module's own `input` row** — not from local state, so it is proof
the frames are landing in SpacetimeDB, exactly like the director's telemetry column.

**FPV.** The kart's MJPEG stream in a plain `<img>`, URL built from the kart row's `ip`:

```
http://<kart-ip>/stream          # firmware/main/camera_stream.c: httpd on port 80, handler /stream,
                                 # multipart/x-mixed-replace; boundary=arkartframe, CORS *
```

It degrades gracefully in every direction: a `karts.json`-style placeholder ip (anything without a
`.` or `:`) is never requested at all, a dead stream trips a 6 s watchdog, and either way the page
shows a NO VIDEO notice (`pointer-events: none`, so it can never swallow a thumb) plus a **⟳ VID**
retry button in the topbar, clear of the pads. **Pilots keep driving without video.** The stream is
also only attached once the page's own `load` event has fired — an MJPEG `<img>` never finishes
loading, so attaching it inline leaves the phone spinning forever.

Tests: `src/pilot/touch.test.ts` pins the pointer→vector geometry (deadzone, full lock before the
edge, monotonic, symmetric, anchor-sinking, brake precedence, NaN/zero-size safety), the `?kart=`
parsing and the stream-URL shape, plus `DriveLoop`'s touch precedence against the keyboard and a
gamepad.

## Placement

SpacetimeDB decides the race, so the standings sort by the module's published
`progress.placement` whenever every kart carries a distinct 1..n value. Zeroes (pre-race),
duplicates (a mid-write snapshot) or a kart with no `progress` row fall back to the local
comparator in `placement.ts`. The standings header prints `placement: module` or
`placement: derived` so it is obvious on camera which one is driving the board.

The fallback comparator is:

```
lap DESC → clearedThisLap DESC → last_pass_at ASC → kart_id ASC
clearedThisLap = (next_idx === 0 ? track_length : next_idx)
```

**Note the wrap term — spec §1's literal "next_idx DESC" is wrong.** `next_idx` counts forward to
the gate being driven at, so it collapses to 0 exactly when a kart has cleared every gate and is
running at the start/finish line. Ranking on the raw field puts the leader dead last for the one
moment that matters most on camera. Confirmed against the live module: karts sit on the grid at
`next_idx = 1` (parked on seq 0, driving at seq 1), so `next_idx === 0` *only* ever means "lap
complete, on the line". `src/placement.test.ts` pins the wrap case, and asserts that the fallback
reproduces the module's ordering for it.

Pinned to the module source (`arkart/module/spacetimedb/src/index.ts`, `report_gate`): the advance
is `nextIdx = (p.nextIdx + 1) % len`, and `lap` increments **only** inside `if (p.nextIdx === 0)`
— i.e. on the physical start/finish crossing, never on the wrap past the last checkpoint. So
`(lap = 1, next_idx = 0)` means "lap 1 done *and* every gate of lap 2 cleared, on the line", which
ranks ahead of `(lap = 1, next_idx = 2)`.

*Event-log gotcha:* `passed gate 9 (lap 0, next idx 0)` followed immediately by
`FINISHED (1 laps)` looks like one pass incrementing the lap. It is **two** `report_gate` calls —
the last-checkpoint pass logging the on-the-line state, then the seq-0 crossing taking lap 0 → 1
and branching to the finish log instead of a passed-gate line. Do not read it as a single event.

## Layout

```
src/
  types.ts             row types mirroring spec §4 field-for-field (ms timestamps, null options)
  placement.ts         PURE derivation: comparator (incl. the lap-wrap fix), standings,
                       module-placement preference, effect/inventory helpers          ← tested
  placement.test.ts
  drive.ts             PURE key/pad → throttle+steer mapping, + the 25 Hz
                       set_input sender (DriveLoop)                          ← tested
  drive.test.ts
  store.ts             snapshot + local track-order draft + reducer dispatch
  ui/render.ts         UiState → HTML (every dynamic value escaped)
  main.ts              adapter choice, 10 Hz repaint, delegated clicks, key bindings
  adapters/
    adapter.ts         the DirectorAdapter contract + URL config
    auto.ts            sdk → http fallback (the default)
    sdk.ts             real TS SDK, bindings loaded by dynamic import
    http.ts            v1 REST: /call/:reducer + /sql
    http.test.ts       set_input on the wire, and DriveLoop through the adapter
    sql.ts             schema-driven decoder for the /sql wire format        ← tested
    sql.test.ts
    coerce.ts          option/variant/timestamp coercion
    rows.ts            raw rows → typed rows → snapshot
```

`placement.ts` is pure (no DOM, no SDK, no clock) so the ranking rule is unit-tested rather than
eyeballed on a leaderboard.

## Wire-format notes (verified against the live module, 2026-09-20)

These cost an hour to discover; `src/adapters/sql.test.ts` pins them with verbatim captures.

- `POST /v1/database/arkart/sql` **rejects multi-statement bodies** (`400 Multiple SQL statements
  are not supported`) — the nine tables are fetched as nine parallel requests per poll.
- Timestamps come back as a one-element product: `[1789886431045596]` micros → converted to epoch
  **ms** by the decoder.
- Options come back as `[tagIndex, value]`: `[1,[]]` = none, `[0,X]` = some. The index alone is
  meaningless without the schema, so decoding walks the `algebraic_type` tree beside the value.
- The module names the inventory columns **`slot_1` / `slot_2`** while the spec writes
  `slot1`/`slot2`; `coerce.pick()` bridges the two. It also carries extra columns the screen
  ignores (`config.id`, `effect.source_kart`, `setup_seen.seen_idx`, `event_log.id`).
- `config.state` and `effect.kind` are plain strings, not sum types.
- Reducer signatures confirmed from `/v1/database/arkart/schema?version=9`:
  `begin_setup()`, `confirm_track(orderedTagIds: Array<U32>)`, `start_race()`, `reset_race()`,
  `abort_race()` — all called with a JSON array body, e.g. `[[7,3,9]]` for `confirm_track`.
