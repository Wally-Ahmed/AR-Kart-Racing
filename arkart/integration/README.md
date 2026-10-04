# AR Kart — integration

Six components were built in parallel. This directory is where they are made to talk to each
other on the wire, and where that is **proved** rather than asserted.

```
  iOS pilot app          ┌──────────────────┐        car bridge            ESP32-S3-CAM
  (or pump.mjs) ──HTTP──▶│  SpacetimeDB     │──WS───▶  merges effects  ──UDP 50 Hz──▶  :7777
   set_input 20 Hz       │  module `arkart` │        onto live input       motors + WS2812
                         │  ALL game rules  │
  vision bridge ──HTTP──▶│                  │◀──WS──  director screen (judges' view)
   report_gate           └──────────────────┘
```

Everything in the middle of that diagram is real and running. What is missing is only the
hardware at the two ends — see **Gaps** at the bottom.

---

## Run it

```bash
cd arkart/integration
./demo.sh
```

That is the whole thing. It republishes the module, brings up a fake kart, the car bridge and a
stand-in pilot, drives a complete race, runs the real computer-vision detector over a synthetic
video, and prints a PASS/FAIL scoreboard. Roughly 2 minutes. Re-run it as often as you like — it
is idempotent and it kills every process it starts, including on Ctrl-C.

**Prerequisites**

| | |
|---|---|
| SpacetimeDB | `spacetime start` listening on `:3000` (CLI 2.4.1) |
| Node | ≥ 22.18 (native TypeScript — no build step) |
| Python | the vision venv at `arkart/vision/.venv` |
| Bindings | generated automatically by `demo.sh` if absent (`./gen-bindings.sh`) |

```bash
./demo.sh --no-publish    # reuse the module and data already published
```

Evidence for every run lands in `.run/` — `listen.log` (decoded packets), `bridge.log`,
`vision.log`, `pump.log`, `sql-fallback.log`.

---

## Conductor one-liners

`demo.sh` is the proof. These are for *driving* — bringing the stack up by hand, and poking it
while a real ESP is on the bench. All of them pass `--server local` explicitly, because the
`spacetime` CLI's default server on this machine is `dev` @ `:3050`, which is not running.

### 1. Stack up + module published + bridge driving from the SIM source

Starts SpacetimeDB (if it is not already up), republishes `arkart`, binds a fake kart on
`udp:7777`, then runs the bridge on `BRIDGE_SOURCE=sim` — a synthetic throttle/steer sweep with
no pilot and no database rows needed. **This is the kart bring-up command**: the car just
drives itself. Ctrl-C parks it.

```bash
cd ~/Documents/GitHub/2027-Hackathons/HOP-HACKS/arkart && (lsof -ti tcp:3000 >/dev/null 2>&1 || (spacetime start --listen-addr 0.0.0.0:3000 >/tmp/arkart-stdb.log 2>&1 &)) && until spacetime server ping local >/dev/null 2>&1; do sleep 0.5; done && (cd module && spacetime publish arkart --server local --delete-data=always --yes) && (node car-bridge/src/listen.ts >/tmp/arkart-listen.log 2>&1 &) && sleep 2 && KARTS_FILE="$PWD/integration/karts.local.json" BRIDGE_SOURCE=sim node car-bridge/src/index.ts
```

Watch the bytes the fake kart receives with `tail -f /tmp/arkart-listen.log`.

**To aim the same sweep at the real car instead of loopback**, drop the `KARTS_FILE` override so
the bridge reads the venue address book `car-bridge/karts.json` — and fill `REAL_CAR_IP` in
first (see `car-bridge/README.md` § The real car), or it will tell you it is a placeholder and
transmit nothing:

```bash
cd ~/Documents/GitHub/2027-Hackathons/HOP-HACKS/arkart/car-bridge && BRIDGE_SOURCE=sim node src/index.ts
```

### 2. Call `set_input` by hand

Two conditions gate a stick reaching the wire, and both bite:

1. **`config.state` must be `running`** — otherwise the bridge sends throttle 0. That is what
   makes `abort_race` a kill switch.
2. **The input must be less than 500 ms old.** The module stamps `input.updated_at` on every
   `set_input`; the bridge treats anything older as STALE and forces throttle *and* steer to 0,
   so a dead phone cannot leave a car pinned. **A one-shot `curl` is therefore invisible on the
   wire half a second later** — it proves the reducer, it does not drive the car.

```bash
# (a) make it live: lobby -> setup -> 3-gate track -> countdown -> running
S=http://127.0.0.1:3000/v1/database/arkart/call; P() { curl -s -o /dev/null -w "%{http_code} $1\n" -X POST -H 'Content-Type: application/json' -d "$2" "$S/$1"; }; P abort_race '[]'; P begin_setup '[]'; for t in 0 1 2; do P report_gate "[1,$t]"; done; P confirm_track '[[]]'; P start_race '[]'; sleep 4
```

```bash
# (b) HOLD the stick — this is the one that moves a car. Edit the file while it runs
#     (it is re-read every cycle) to change the stick without restarting.
echo '{"1":{"t":0.6,"s":-0.3},"2":{"t":0,"s":0}}' > /tmp/arkart-sticks.json && node ~/Documents/GitHub/2027-Hackathons/HOP-HACKS/arkart/integration/pump.mjs /tmp/arkart-sticks.json http://127.0.0.1:3000 arkart
```

Verified on the wire: `t: 0.6, s: -0.3` →
`kart=1 thr=153 steer=-38 flags=0x00 raw=414b0199da00…` (0.6 × 255 = 153; 0.3 × 127 = 38).

```bash
# (c) one-shot, for proving the reducer only: set_input <kart_id> <throttle 0..1> <steer -1..1>
curl -s -X POST -H 'Content-Type: application/json' -d '[1,0.6,-0.3]' http://127.0.0.1:3000/v1/database/arkart/call/set_input
```

```bash
# (d) the kill switch — drops the wire to thr=0 steer=0 with the stick still held down
curl -s -X POST -H 'Content-Type: application/json' -d '[]' http://127.0.0.1:3000/v1/database/arkart/call/abort_race
```

Equivalent through the CLI, if you prefer it:
`spacetime call arkart set_input 1 0.6 -0.3 --server local -y`.

Reducer args are a **positional** JSON array in declaration order; the named-object form
(`{"kartId":1,"tagId":0}`, camelCase) is also accepted. Wrong arity is a clean `400`.

> `set_kart 1 "Kart 1" "<ip>"` updates the module's `kart` row, which is **informational** — the
> bridge's address book is `car-bridge/karts.json`, not that table. Changing one does not change
> the other.

---

## What the script actually proves

### T0-SW — the software half of the control loop (15 checks)

The half of T0 that needs no hardware: **a stick movement becomes bytes on the wire.**

- A calibration lap through gates **7, 3, 9** builds the track in first-seen order;
  `confirm_track` writes it with seq 0 as start/finish; `start_race` → countdown → `running`
  (which also proves the module's scheduled `tick` reducer is firing).
- `npm run listen` binds `udp:7777` as a **fake kart**.
- The car bridge connects to SpacetimeDB **over WebSocket through the generated bindings** —
  the sponsor path, not a polling shim — and subscribes to `config`/`kart`/`input`/`effect`.
- `pump.mjs` POSTs `set_input` at 20 Hz, standing in for the phone.
- Then the actual assertion: move the stick, watch the bytes.

  | stick | packet |
  |---|---|
  | throttle 1.0, steer −1.0 | `41 4b 01 ff 81 00 …` → `thr=255 steer=-127` |
  | throttle 0.5, steer +1.0 | `41 4b 02 80 7f 00 …` → `thr=128 steer=127` |
  | throttle 0.5, steer +0.5 | `thr=128 steer=64` |

- **Sequence numbers**: every observed gap is exactly `+1`, across thousands of packets.
- **`abort_race` is a physical kill switch**: with the stick pinned at full throttle, one
  reducer call drops the wire to `thr=0 steer=0` — the pilot cannot override it, because the
  bridge, not the phone, decides what the car receives.

### T2 — items, from database row to packet byte (17 checks)

Each item is granted with `debug_grant` (deterministic — no waiting for a lucky roll), fired
with `use_item`, then checked **twice**: the `effect` row in SQL, and the bytes the kart receives.

| item | database | wire |
|---|---|---|
| `boost` | `boost` ×1.4, expiry set | `thr 128 → 178` |
| `stun` | `stun` ×0 on the rival | `thr → 0` for ~2 s, then back to `128` |
| `shield` | `shield`, **no expiry** | `flags=0x01` (WS2812 cyan) → absorbs one `report_hit` → `0x00`, never stunned |
| `leader_strike` | `slow` ×0.3 on P1 | `thr 128 → 38` |
| `dizzy` | `dizzy` on the rival | `steer +64 → −64` |
| `ink` | `ink` on the rival | **wire unchanged** — screen-only, by design |

> `boost` lands on **178**, not 179: the multiplier is an `f32`, and `f32(1.4)` is
> `1.39999997615814`, so `0.5 × 1.4 × 255 = 178.4999969`. Not a bug — arithmetic.

The shield case is the one worth watching at judging: it proves the module funnels *every*
offensive hit (items and the IR path) through one shield-check-then-effect code path.

### T1 — the vision loop (10 checks)

The track is re-laid to gates **0, 1, 2** to match the synthetic video, then the **real**
`cv2.aruco` detector runs over a 2-lap FPV clip and POSTs **real** `report_gate` calls (no
`--dry-run`):

- 6 gate passes detected, all accepted `HTTP 200`;
- `progress` advances **in order only** — `lap=1, next_idx=0`;
- kart 2, which has no camera, stays on the start line;
- `placement` recomputes to 1st / 2nd;
- `event_log` carries the passes in the exact order `1, 2, 0, 1, 2`;
- items are granted at checkpoints.

---

## The director screen (judges' view)

Not part of `demo.sh` — it is a browser window — but verified live against the same module:

```bash
cd arkart/director && npm run dev
```

| URL | result |
|---|---|
| `http://localhost:5173/?adapter=http` | **verified live** — `http live`, 2 karts, `placement: module`, full event feed |
| `http://localhost:5173/?adapter=sdk&bindings=/src/module_bindings/index.ts` | **verified live** — `sdk live`, WebSocket subscriptions, live `set_input` telemetry |

Two things about the SDK URL:

1. **`bindings=/src/module_bindings/index.ts` is required.** The adapter's default is
   `./module_bindings/index.ts`, which resolves against the *page* URL. Vite's dev server serves
   project sources under `/src/…`, so the default path hits the SPA fallback and returns HTML
   instead of a module. Passing the `/src/…` path fixes it with no rebuild.
2. **`sdk error` on an idle lobby is cosmetic.** `src/ui/render.ts:93` downgrades `live` to
   `error` when the snapshot is stale, and a push-based subscription pushes nothing while
   nothing changes. The moment any traffic flows (a pump, a race, a gate) the badge reads
   `sdk live`. The HTTP adapter never shows this because it repolls every 200 ms.

---

## Files here

| file | what it is |
|---|---|
| `demo.sh` | **the deliverable** — the whole end-to-end proof, with a PASS/FAIL scoreboard |
| `gen-bindings.sh` | regenerates the SpacetimeDB client bindings for both consumers |
| `module_bindings/` | generated bindings for the car bridge (Node-resolvable) |
| `pump.mjs` | stand-in for the iOS pilot: `set_input` at 20 Hz from a JSON file |
| `karts.local.json` | integration address book — both karts point at `127.0.0.1`. **Loopback only**; the venue/real-car file is `car-bridge/karts.json` |
| `fixtures/track-2lap.avi` | synthetic 2-lap FPV video (regenerated on demand) |
| `.run/` | last run's logs — the evidence |

### Why the bindings are generated twice

`spacetime generate` (CLI 2.4.1) emits code that needs two different treatments:

- **Extensionless relative imports** (`from "./config_table"`). Vite and `tsc`'s bundler
  resolution handle those; **Node's native ESM loader does not** and throws
  `ERR_MODULE_NOT_FOUND`. The car bridge runs `node src/index.ts` with no bundler, so its copy
  gets `.ts` extensions added. The director copy is left verbatim.
- **A bare `from "spacetimedb"` import.** Node resolves that from the importing file's own
  directory upwards, which is why this package has a `package.json` pinning
  **`spacetimedb@2.4.1`** — matching the server and the CLI, not the 2.10.1 on npm.

`gen-bindings.sh` also appends one **SDK 1.x compatibility alias** to both copies (see the next
section). Both directories are disposable build output; regenerate with `./gen-bindings.sh`.

---

## Defects found in other components

### 0. Revival, 2026-10-04 — what had rotted in two weeks

The stack was archived after HopHacks and brought back unchanged. Nothing in the module, the
bridge's rules or the wire format had decayed; three things in *this* directory had.

**`demo.sh` hung forever at T0.7, and it was this script's own fault.** The step probed the
bridge's SQL fallback like this:

```bash
SQLMODE=$(cd "$CB" && ENV=... node src/index.ts 2>&1 & BP=$!; sleep 4; kill $BP; wait $BP)
```

`cmd1 && cmd2 &` backgrounds the whole AND-list as a **subshell**, so `$!` is the wrapper's pid,
not node's. `kill $BP` reaped the wrapper and left node **orphaned** (`ps` showed `PPID 1`),
still holding the command-substitution pipe open — so `$( … )` never returned. It had been
invisible for as long as the fallback was broken, because node then self-exited with `fatal`
inside a second and the kill mechanics never mattered. **Defect 2 below getting fixed is what
turned this latent bug into a hang.** Now: log to a file rather than a pipe, `exec node` so `$!`
*is* node, kill the real pid with an escalation to `-9`, and register it in the EXIT trap.

**A phantom `FAIL fake kart failed to bind udp:7777`,** with empty evidence, while every
downstream packet assertion passed. `sleep 1` then `grep` a log the child is still opening —
Node's native type-stripping takes longer than that to reach its first line of output on a cold
cache. Replaced with a `wait_for_log <file> <pattern> <timeout>` deadline poll (the bridge check
already did this; `listen` and `pump` did not).

**`--no-publish` could never pass**, and not because of rot — the mode was documented but the
T1 `event_log` assertion was written against a virgin table: it compared *every* `passed gate`
entry to `['1','2','0','1','2']`. `event_log` is append-only and nothing clears it, so that only
holds on a fresh `--delete-data=always` publish; reusing a database meant the previous run's
passes were still there and the check failed by construction. It now asserts the **last five**
passes, sorted by id, which is true in both modes and still pins the ordering.

**Stale dep state** in `car-bridge/` — `npm install` restores it; `npm run check` is green at
98/98 (95 before this revival; +3 for the placeholder-address rule below).

Not rot, but worth knowing: **`spacetime server list` now has a different default server**
(`dev` @ `127.0.0.1:3050`) which is not running. Everything here passes `--server local`
explicitly, so it is unaffected — but a bare `spacetime list` / `spacetime logs` will fail with
`Connection refused` until you add `--server local`.

### 1. `withModuleName` → `withDatabaseName` (SDK 1.x → 2.x rename) — **worked around**

SpacetimeDB SDK **2.4.1** renamed the builder's "which database" method and dropped the old
name. Both consumers were written against the 1.x name:

| file | symptom |
|---|---|
| `car-bridge/src/sources/spacetime.ts` | its builder helper *silently skips* unknown methods, so the call became a no-op and `build()` failed with `Database name or address is required to connect to SpacetimeDB` |
| `director/src/adapters/sdk.ts:124` | calls it directly → `builder threw: DbConnection.builder(...).withUri(...).withModuleName is not a function` |

**Worked around in the generated bindings**, not in either component: `gen-bindings.sh` appends
a block to the generated `index.ts` that aliases `withModuleName` onto the builder prototype, so
the generated code answers to both names. Both consumers now connect unchanged.

**Permanent fix — half done:**

- ✅ `car-bridge/src/sources/spacetime.ts` **is fixed.** It probes `withDatabaseName` first and
  falls back to `withModuleName`, and every *required* builder step now throws if none of its
  known spellings exist, naming the methods the builder does have. (That helper's old
  skip-if-missing behaviour is what turned an API rename into a silent no-op, which is what made
  this hard to see.) Three tests in `car-bridge/test/adapter.test.ts` pin it: the 2.x name, the
  1.x fallback, and the loud failure when neither exists.
- ⬜ `director/src/adapters/sdk.ts:124` → `.withDatabaseName(this.cfg.module)`. Still outstanding,
  which is why **the alias block in `gen-bindings.sh` must stay** for now. Delete it only once
  the director is converted too.

### 2. The bridge's SQL-polling fallback was broken — **FIXED, now asserted**

`npm run sql` (`BRIDGE_SOURCE=sql`) used to fail immediately with
`[bridge] fatal: 400 Bad Request from http://localhost:3000/v1/database/arkart/sql`, because
`car-bridge/src/sources/sql.ts` sent four statements in one request and SpacetimeDB 2.4.1
answers `400 Multiple SQL statements are not supported`:

```bash
curl -X POST -H 'Content-Type: text/plain' \
  --data-binary 'SELECT * FROM config; SELECT * FROM kart;' \
  http://127.0.0.1:3000/v1/database/arkart/sql        # -> 400
```

It now issues the four `SELECT`s as four parallel single-statement POSTs (`Promise.all`, order
preserved) and decodes the positional `Timestamp` / `Option` encodings. `car-bridge`'s own
`test/adapter.test.ts` pins both behaviours, and **T0.7 here is now a real check rather than a
`WARN`** — it starts the fallback against the live database and asserts it reaches `conn=true`:

```
PASS SQL-polling fallback reads the live database (one single-statement POST per table)
     [bridge] state=lobby conn=true ticks=43  1: thr=0 str=0 …
```

Evidence lands in `.run/sql-fallback.log`. This is the no-bindings path: useful when
`spacetime generate` output is missing or mismatched, and a second independent read of the same
module.

---

## Gaps — what is still missing for a *full* T0

`demo.sh` proves the software loop completely. T0 in the spec is *a car that moves*, and three
physical steps are untouched by this script. Stated plainly:

### 1. No firmware has been flashed to a board

`arkart/firmware/` builds, but **nothing has run on an ESP32-S3-CAM**. The fake kart in
`demo.sh` is `npm run listen`, a Node process on the laptop — it proves the bridge emits the
right bytes, and nothing about whether the firmware consumes them.

To close it (`arkart/firmware/README.md`):

```bash
idf.py set-target esp32s3
idf.py menuconfig          # AR Kart Firmware -> SSID / password / kart id
idf.py build
idf.py -p /dev/cu.usbmodem* flash monitor
```

Then point `car-bridge/karts.json` at the board's DHCP address (the venue file — **not**
`integration/karts.local.json`, which is loopback-only) and re-run the T0 section. First things
to watch: the WS2812 on GPIO 48 for status, and the 300 ms watchdog — send one packet and the
motor should stop ~300 ms later.

`karts.json` is already staged for this: `kart_id 1` is the real car and its `ip` is the
placeholder **`REAL_CAR_IP`**, which is the one string to replace. The bridge loads and runs
with it in place — it classifies a dotless token as "not an address", marks the kart
`(PLACEHOLDER)` on its startup line and transmits nothing to it, rather than firing a failing
DNS lookup 50 times a second. See `car-bridge/README.md` § The real car.

**Before that**, the `// PROBE-TODO` constants in `firmware/main/motor_map.h` still need the
bench measurements (Station 0's five probes). Flashing with placeholder motor numbers is how a
car either does not move or does not stop.

### 2. No real camera has ever fed the vision bridge

T1 passes against `fixtures/track-2lap.avi`, a synthetic clip of rendered 36h11 tags: perfectly
lit, centred, motion-blur-free, and nothing like a car's camera. What is proven is the
detector → debounce → `report_gate` → module chain. What is **not** proven is detection range,
the 150 mm gate-post tag size, exposure on a moving car, or the debounce window against real
FPS jitter.

To close it: print the tags, flash a camera board, then

```bash
cd arkart/vision
./.venv/bin/python -m arkart_vision.bridge --kart 1 --source http://<kart-ip>/stream --display
```

**Never pass `--fps` to a live stream** — that flag is for file sources only.

### 3. The iOS pilot app has not been on a phone

`pump.mjs` stands in for it: same reducer, same rate, no UI. `arkart/ios/` has not been built
against full Xcode or installed on a device, so **free provisioning is unproven** — and that is
a 7-day-certificate, needs-the-phone-in-hand, cannot-be-automated step. Gamepad pairing
(`GCController`) and the `WKWebView` MJPEG view are likewise untested against real hardware.

The simulator's `localhost` points at the Mac, not at the karts, so a simulator run cannot
validate the track configuration either.

### Also not covered

- **T3 / IR tag** — out of scope by design. `report_hit` is implemented and tested (the shield
  path above uses it), but no IR hardware exists.
- **Two karts at once** — the module, bridge and director all handle two, and `demo.sh` drives
  both through the bridge, but only kart 1 has ever had a (synthetic) camera.
- **The venue network** — everything here is loopback. The GL.iNet Opal, DHCP leases and
  real UDP latency are unexercised.

### What that leaves

Every line between `set_input` and the 8 bytes on the wire is verified, and every line between a
tag sighting and a recomputed placement is verified. The remaining work is bench probes,
soldering, flashing and provisioning — hardware tasks, not software ones.
