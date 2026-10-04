# AR Kart — vision bridge

One `cv2.aruco` detector loop per kart MJPEG stream. Decodes AprilTag **36h11** gate-post
markers, debounces them so one physical pass fires exactly once, and POSTs each confirmed
pass to the SpacetimeDB `report_gate` reducer.

**The bridge only reports sightings.** The module decides what a sighting *means* — setup-phase
ordering vs in-race checkpoint vs ignored (spec §7). There is deliberately zero game logic here.

Implements `docs/design/arkart-game-software-v1.md` §7, which is the
`docs/research/arkart-research-2026-09-19.md` §4(g) recipe.

## Setup

```bash
cd arkart/vision
python3.12 -m venv .venv            # 3.12 is the proven interpreter
./.venv/bin/pip install -r requirements.txt
```

`.venv/` is gitignored, so this is the first step on a fresh machine. Python **3.14 also
works** as of 2026-10-04 — `opencv-contrib-python` 4.14 now ships a cp314 wheel, and the
full suite passes on 3.14.3 — so plain `python3 -m venv .venv` is fine if 3.12 isn't around.
Verify with `./.venv/bin/python -m pytest` (expect 57 passed).

## Run

```bash
# normal race operation — reads ./karts.json, posts to the local STDB server
./.venv/bin/python -m arkart_vision.bridge

# same, but log gates instead of posting them (STDB not up yet)
./.venv/bin/python -m arkart_vision.bridge --dry-run

# with detection overlay windows (press q to quit)
./.venv/bin/python -m arkart_vision.bridge --display

# bench: point a laptop webcam at a printed tag and watch it fire
./.venv/bin/python -m arkart_vision.bridge --kart 1 --source 0 --dry-run --display

# bench: one kart only, explicit stream URL
./.venv/bin/python -m arkart_vision.bridge --kart 2 --source http://192.168.8.102/stream
```

| Flag | Meaning |
|---|---|
| `--config PATH` | karts.json to use (default `./karts.json`) |
| `--kart ID` | watch only this kart |
| `--source X` | override the stream: a URL, a webcam index (`0`), or a video file |
| `--dry-run` | log gate passes, POST nothing |
| `--display` | OpenCV overlay window per kart |
| `--seconds N` | auto-stop after N seconds (bench/CI) |
| `--fps N` | cap the loop rate — **only** needed for video-file sources (see below) |
| `--loop-source` | replay a video file from the top when it ends. Off by default — see below |
| `-v` | debug logging |

## karts.json

```json
{
  "stdb": { "base_url": "http://localhost:3000", "database": "arkart" },
  "tag_whitelist": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  "karts": [
    { "kart_id": 1, "name": "kart-1", "stream_url": "http://192.168.8.101/stream" },
    { "kart_id": 2, "name": "kart-2", "stream_url": "http://192.168.8.102/stream" }
  ]
}
```

Only `karts` is required; everything else falls back to the constants in
`arkart_vision/config.py`. `STDB_BASE_URL`, `STDB_DATABASE` and `STDB_TOKEN` env vars also
override. **At the venue, the only thing you should need to edit is the two IPs.**

## The reducer call

Verified 2026-09-20 against the SpacetimeDB HTTP API reference
(`docs/docs/00300-resources/00200-reference/00200-http-api/00300-database.md`,
clockworklabs/SpacetimeDB @ master):

```
POST /v1/database/:name_or_identity/call/:reducer
Content-Type: application/json

[kart_id, tag_id]
```

- The body is **a JSON array of positional arguments** — not a named object.
- `Authorization: Bearer <spacetime token>` is optional; absent means the call is anonymous,
  which is exactly what the LAN demo wants (spec §4, "auth: demo-grade").

So a gate pass by kart 1 through tag 7 is:

```
POST http://localhost:3000/v1/database/arkart/call/report_gate
[1, 7]
```

**If Clockwork ever changes that wire format, `build_reducer_request()` in
`arkart_vision/reducer.py` is the single function to edit.** Nothing else in the package
builds a URL or a body.

POSTs run on a small worker pool with a 1 s timeout, so a slow or dead server costs zero
detector frames, and every failure is logged and swallowed — a dropped gate must never kill
the loop.

## Debounce — "one pass fires exactly once"

State is keyed `{kart_id: {tag_id: ...}}`, never a global "tag seen" flag: both karts may be
looking at the same gate post at the same instant and both are legitimate, independent passes.

Per `(kart, tag)`:

1. **Confirm** — `CONFIRM_FRAMES` (2) detections, all inside a `CONFIRM_WINDOW_S` (0.5 s)
   sliding window. `MISS_TOLERANCE_FRAMES` (1) forgives one blurred/corrupted frame mid-streak.
2. **Latch** — once fired, it cannot fire again until the tag has *left the frame*. This is
   what makes a 100-frame stare at a gate produce one event, not 99.
3. **Cooldown** — `COOLDOWN_S` (1.5 s) after a fire. Second belt: a tag that flickers out and
   straight back in (blur, a passing wheel) is still the same physical pass.

Every tunable is a constant at the top of `arkart_vision/config.py`. Nothing else hard-codes
a number.

### Tuning at the venue

| Symptom | Knob |
|---|---|
| Gates missed at speed | more light on the course first (R§4c — biggest lever), then `CONFIRM_FRAMES` → 1 |
| One pass fires twice | `COOLDOWN_S` up |
| Two laps in a row, second lap's gate ignored | `COOLDOWN_S` down |
| Phantom gates | `ERROR_CORRECTION_RATE` down from 0.6; tighten `TAG_WHITELIST` |
| Tags only decode up close | `MIN_MARKER_PERIMETER_RATE` down; bigger tags beat higher resolution |

## Tests

```bash
cd arkart/vision
./.venv/bin/python -m pytest          # 57 tests, ~3 s, no hardware, no network
```

Covers: synthetic `generateImageMarker` tags decoding back to the right ID (incl. tag 7),
multi-tag frames, whitelist rejection; the full debounce state machine (N-frame confirm,
single fire per pass, cooldown re-arm on lap 2, per-kart/per-tag isolation, a simulated
3-gate × 3-lap course); stream lifecycle (endless source reconnects, finite file ends — see
below); and the reducer call with HTTP mocked (URL, positional array payload, Bearer header,
error swallowing).

## End-to-end acceptance check (no hardware, no SpacetimeDB)

One command. It generates the synthetic lap video **and its ground truth**, stands up a
recording stub on the one HTTP route the bridge uses, runs the real bridge against the video
with `report_gate` pointed at that stub, and asserts the recorded call sequence equals the
ground truth exactly:

```bash
./.venv/bin/python tools/e2e_gate_check.py          # exit 0 = acceptance met
./.venv/bin/python tools/e2e_gate_check.py -v --keep # + bridge log, keep artifacts
```

It runs two phases, because the two ways to aim the bridge resolve the STDB base URL by
different routes and both have to work:

| Phase | Aimed by | Covers |
|---|---|---|
| A | `--source` + `STDB_BASE_URL` env | bench path, 1 kart |
| B | `karts.json` → `stdb.base_url` | **real demo path**, 2 karts at once (per-kart isolation) |

Asserted: gate order, kart ids, exact call count (which is what rules out double-fires),
reducer name, positional-array body, `Content-Type`, anonymous (no `Authorization`), and that
no other HTTP route is ever touched. The stub binds an **ephemeral** port, so it never
collides with anything.

### Doing it by hand

```bash
./.venv/bin/python tools/make_test_track_video.py /tmp/track.avi --laps 2 --truth /tmp/track.truth.json
./.venv/bin/python -m arkart_vision.bridge --kart 1 --source /tmp/track.avi --dry-run --fps 20
```

Expect exactly `GATE tag=0`, `1`, `2`, `0`, `1`, `2` and `total gate passes: 6`, matching
`gate_order` in the truth file. No `--seconds` needed: a video file now ends the run when it
runs out (below).

`--fps 20` still matters: a video file decodes as fast as the CPU allows, which compresses
14 s of footage into a fraction of a second and lets the wall-clock cooldown swallow laps.
A live MJPEG stream paces itself, so **never pass `--fps` in the real demo.**

### A finite file ENDS; a live stream reconnects forever

`MJPEGStream` treats a dead stream as a normal state and re-opens it — correct for an
ESP32-S3-CAM that browns out mid-race. Applied to a video *file*, that same reflex replays the
footage from the top, and a replayed lap is indistinguishable from a real one. That used to
make the bench test above a stopwatch race: `--seconds 16` passed with ~0.3 s of margin, and
`--seconds 17` reported **7** gate passes for a 6-gate video.

So the two cases are now told apart by source kind (`stream.is_finite_source`):

- **local video file** → the run stops at end of file (`source exhausted (end of file)`).
  Pass `--loop-source` to opt back into replaying it, e.g. for a kiosk loop.
- **MJPEG URL or webcam index** → reconnects forever, exactly as before. The race demo is
  unaffected.

## Physical setup that the code assumes

From R§4(f)–(g) — get these wrong and no amount of tuning saves you:

- **150 mm tags, one per US Letter sheet, printed matte.** Glossy under venue lighting blows a
  black cell out to white.
- **On gate posts / low walls at camera height, facing oncoming traffic — not on the floor.**
  A floor tag is at near-grazing incidence for its entire approach, i.e. the worst angle and
  the shortest dwell simultaneously.
- **Camera VGA 640×480, `jpeg_quality` 10–12.** Range ~1.4 m with 36h11.
- **Light the course.** Shorter exposure = shorter blur streak. Highest-ROI reliability fix
  there is.

## Layout

```
arkart/vision/
├── karts.json                     kart_id -> MJPEG URL, + STDB target
├── requirements.txt
├── pytest.ini
├── arkart_vision/
│   ├── config.py                  ALL tunables + karts.json loader
│   ├── detector.py                cv2.aruco 36h11 wrapper + render_tag()
│   ├── debounce.py                per-(kart,tag) confirm/latch/cooldown machine
│   ├── reducer.py                 THE SpacetimeDB HTTP adapter
│   ├── stream.py                  MJPEG reader with auto-reconnect
│   └── bridge.py                  main — one thread per kart
├── tools/
│   ├── make_test_track_video.py   synthetic lap video + --truth ground truth
│   └── e2e_gate_check.py          one-command end-to-end acceptance check
└── tests/
```

## Pointing it at the real module

The bridge never needs a code change to find SpacetimeDB — only `karts.json` or the
environment. Two knobs, and **`karts.json` wins on the normal run path**:

| Run path | Base URL comes from | Override with |
|---|---|---|
| `python -m arkart_vision.bridge` (reads `karts.json`) | `stdb.base_url` in `karts.json` | edit that field |
| `--source ...` (bench override) | `config.STDB_BASE_URL` | `STDB_BASE_URL` env var |

`karts.json` already ships pointed at the local module (`http://localhost:3000`, database
`arkart`), which is what `spacetime start` serves — so for the live demo there is normally
**nothing to change here at all**. Only the two kart IPs need editing at the venue.

```bash
# live module, default local STDB (http://localhost:3000, db "arkart")
./.venv/bin/python -m arkart_vision.bridge

# live module on another host/port, without editing karts.json (bench path only)
STDB_BASE_URL=http://10.0.0.7:3000 STDB_DATABASE=arkart \
  ./.venv/bin/python -m arkart_vision.bridge --kart 1 --source /tmp/track.avi --fps 20
```

`STDB_DATABASE` and `STDB_TOKEN` work the same way (`config.py`). A token is optional; absent
means an anonymous call, which is what the LAN demo wants.
