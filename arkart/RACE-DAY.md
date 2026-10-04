# AR Kart — RACE DAY

The rehearsal checklist. Work it top to bottom; nothing below a step is true until that step is.
`integration/demo.sh` proves the software on loopback — **this** document is the one that gets a
car moving in a room full of people.

```
T-30  (0) network: the Mac becomes the `arkart` AP
T-25  (1) power: packs in, chargers out, JST OFF while flashing
T-15  (2) boards: flash identity -> btnstat -> netstat IP -> karts.json
T-5   (3) bring-up: ./raceday.sh  (one command, cold start)
T-2   (4) track: begin_setup -> calibration lap -> confirm_track -> start_race
T-1   (5) kill switches: rehearse all four BEFORE the first public heat
        (6) IR tag: ir_post + loopback + the shield demo
        (7) failure drills: practise them while nobody is watching
```

---

## 0. Network — **the Mac IS the access point**

This is the canonical topology. The original plan (iPhone **Personal Hotspot over Wi-Fi**) is
**dead**: that hotspot hands out IPv6 only, with no IPv4, so nothing on it could reach
`http://<laptop>:3000` or the UDP port. Do not retry it under pressure.

```
iPhone ──USB cable──▶ Mac ──Internet Sharing──▶ Wi-Fi "arkart"  ──▶ karts + pilot phones
         (uplink)      (AP + SpacetimeDB + bridge + vite)
```

1. **Cable the iPhone to the Mac** and trust the computer. An `en*` interface appears with
   `192.0.0.2` — that is the USB tether link itself, *not* the race network.
2. **System Settings → General → Sharing → Internet Sharing**
   - *Share your connection from:* **iPhone USB**
   - *To computers using:* **Wi-Fi**
   - **Wi-Fi Options…** → Network Name **`arkart`**, Security **WPA2/WPA3 Personal**,
     Password **`arkartarkart`**
   - Toggle Internet Sharing **on** and confirm.
3. **Verify the AP is really up.** A `bridge100` interface must exist with an IPv4 address
   (typically `192.168.2.1`):

   ```bash
   ifconfig bridge100 | grep 'inet '
   ```

   `./integration/raceday.sh status` says this out loud — it prints every LAN IP and warns
   `INTERNET SHARING IS OFF` when there is no `bridge*` interface. **That address is the one
   everything else uses**: karts, phones, the judges' browser.

> The SSID and password are not arbitrary — they are the firmware's compiled-in defaults
> (`ARKART_WIFI_SSID` / `ARKART_WIFI_PASSWORD`). Changing one means reflashing both cars.

4. **Phones join `arkart`.** The iPhone providing the USB uplink must stay *off* that Wi-Fi;
   it can still reach the Mac over the cable at `http://192.0.0.2:<port>/` — worth testing once
   so you know it works before you need it.
5. **If the IR tag layer is live**, `ARKART_STDB_HOST` in `menuconfig` must be the `bridge100`
   address. Its Kconfig default is `192.168.4.1`, which is wrong for Internet Sharing. Nothing
   else in the firmware talks to SpacetimeDB, so this only affects `report_hit`.

---

## 1. Power

- **Cars:** 3×AA each, fresh. Count a spare set per car and keep them in one labelled bag.
- **⚠ NEVER flash or run `idf.py monitor` with the battery JST connected.** USB 5 V and the pack
  both feeding the same rail is how a board or a regulator dies. Flash → unplug USB → *then*
  connect the JST.
- **Plan M boards only:** set the MT3608 to **5.00 V with a meter, before** its output ever
  touches the ESP32.
- **Charge list** (do this while flashing, not after):
  - laptop ≥ 80 % — it is the AP, the server, the bridge and the director
  - the uplink iPhone — if it dies, the whole network dies
  - each pilot phone
  - the gamepad
  - the power bank (spare uplink / spare phone charge)

---

## 2. Boards — one car at a time

The button-tap drive path (`btn_remote.c` + `net_drive.c`) **only compiles into the Plan RX
build**; under Plan M those same pads are the steer-coil H-bridge. Build it per car:

```bash
source ~/esp/esp-idf/export.sh
cd HOP-HACKS/arkart/firmware

idf.py -B build.planrx -D SDKCONFIG=sdkconfig.planrx.out \
       -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.planrx" build
```

### 2a. Flash identity — the one per-car difference

`idf.py menuconfig` → **AR Kart Firmware**:

| setting | car 1 | car 2 |
|---|---|---|
| `ARKART_KART_ID` | **1** | **2** |
| WiFi SSID / password | `arkart` / `arkartarkart` | same |
| SpacetimeDB host | the `bridge100` IP | same |

Flash over the **CH340 UART port** (`/dev/cu.wchusbserial*`) — it is the reliable one; the
native-USB port is `/dev/cu.usbmodem*`:

```bash
idf.py -B build.planrx -D SDKCONFIG=sdkconfig.planrx.out -p /dev/cu.wchusbserial* flash monitor
# exit the monitor with Ctrl-]
```

Byte 2 of every control packet carries the kart id and the firmware **drops packets addressed to
anyone else** — so two cars flashed with the same id is the failure where both twitch to one
pilot's stick.

### 2b. `btnstat` — the harness check

With the remote **wired and powered**, type `btnstat` at the console. All four pads must read
**1 released / 0 pressed**:

| pad | GPIO |
|---|---|
| left | 39 |
| right | 40 |
| back | 41 |
| fwd | 42 |

> A pad reads 1 when released **only** because the remote's own pull-ups hold it high. An
> unwired, floating pad reads either way — so a pass on an unpowered remote proves nothing.
> Power the remote first, then read.

Then prove motion by hand before any network is involved:

```
press fwd        # the car should move
release all
press left ; release all
```

`tools/con.py` drives this console over serial **without resetting the board** (`rts=False`,
`dtr=False`), and sends several lines in one write so e.g. `netpkt 255` and `btnstat` both land
inside the 300 ms watchdog window.

### 2c. `netstat` → capture the IP → `karts.json`

`netstat` prints the kart's WiFi state and its IP. Put that address in **two** files:

| file | field | value |
|---|---|---|
| `car-bridge/karts.json` | `karts[].ip` | the kart's IP — **replaces `REAL_CAR_IP`** |
| `vision/karts.json` | `karts[].stream_url` | `http://<kart-ip>/stream` |

Both files are read **once at startup, not watched** — restart the bridge after editing
(`./raceday.sh stop && ./raceday.sh --no-publish`). Until `REAL_CAR_IP` is replaced the bridge
runs normally and simply transmits nothing to that kart, marking it `(PLACEHOLDER)` on its
startup line and in the race-day status block.

`car-bridge/karts.json` is the **venue** address book. `integration/karts.local.json` is
loopback-only and belongs to `demo.sh`.

---

## 3. Bring-up — one command

```bash
cd HOP-HACKS/arkart/integration
./raceday.sh
```

It adopts a SpacetimeDB that is already up (and never kills it), publishes `arkart` **without**
wiping data, starts the car bridge on the live subscription (`BRIDGE_SOURCE=stdb`), starts the
vision bridge, serves the director + pilot pages with `vite --host`, and prints the status block.
Idempotent — re-run it as often as you like.

| | |
|---|---|
| `./raceday.sh` | bring everything up / top everything back up |
| `./raceday.sh status` | the status block, touching nothing |
| `./raceday.sh stop` | kill exactly what it started (a pre-existing SpacetimeDB survives) |
| `./raceday.sh restart` | stop, then up |
| `./raceday.sh --fresh` | publish with `--delete-data=always` — **WIPES the track and all laps** |
| `./raceday.sh --no-publish` | fastest restart: processes only |
| `./raceday.sh --no-vision` / `--no-director` | skip a component |

### The status block must show all five

1. **laptop LAN IP** — the `bridge100` address, and **no** `INTERNET SHARING IS OFF` warning.
2. **spacetime** — `/v1/ping -> 200`, and `module arkart @ --server local` with a `config.state`.
3. **car bridge** — a pid, `subscriptions applied`, and a `karts=` line with
   **no `(PLACEHOLDER)`**: `karts=1@192.168.2.x:7777 2@192.168.2.y:7777`.
4. **vision bridge** — a pid and `2 stream(s) being watched`, with no
   `at least one camera is unreachable` warning.
5. **director / pilot** — URLs on the `bridge100` IP:
   - judges' screen `http://<laptop-ip>:5173/?adapter=sdk&bindings=/src/module_bindings/index.ts`
   - HTTP fallback `http://<laptop-ip>:5173/?adapter=http` (always works)
   - pilots `http://<laptop-ip>:5173/pilot.html?kart=1` and `?kart=2`, with the status block
     confirming `served OK ("AR Kart — Pilot")`

**Read the port off the status block before you read it out loud.** If something else already
held 5173, raceday falls forward to 5174 and says so — the phones must be told the real number.
The status block fetches `/pilot.html` and prints its `<title>`: it must say **`AR Kart — Pilot`**.
Anything else (or nothing) means the phones will get the wrong page — drive from the director
screen instead.

Do **not** run `demo.sh` while this is up: it wipes `.run/` and starts a second car bridge on the
same `udp:7777`, and two bridges interleave their sequence counters.

---

## 4. Track — the calibration lap

Gates are **gate-post** AprilTags (36h11, 150 mm), not floor markers. The order you first see
them in *is* the track.

1. **`begin_setup`** — clears `setup_seen`, state → `setup`.
2. **Walk the calibration lap**: carry/push kart 1 past every gate in race order. Each sighting
   appears live in the director's **Track setup panel** in first-seen order. No camera? Enter
   them by hand: `report_gate '[1,<tag>]'` per gate.
3. **Fix the order if needed** — per-row ▲▼ reorder and ✕ remove in that panel.
4. **`confirm_track`** — enabled only at ≥ 3 gates with no duplicates. Writes the track with
   **seq 0 = start/finish**; state → `lobby`.
5. **`start_race`** — 3 s countdown → `running`. Karts start on the line (`lap 0, next_idx 1`).
6. **Between heats: `reset_race`** — back to `lobby`, progress/inventories/effects cleared,
   **the track is preserved**. Only re-run `begin_setup` if the gates physically moved.

Progress only advances **in gate order**, so a kart that misses a gate keeps circling until it
takes it. Items are granted at **every** checkpoint, 2 slots max.

---

## 5. Kill switches — rehearse all four, in this order

| # | switch | what it does | how to prove it |
|---|---|---|---|
| 1 | **`abort_race`** | `config.state` leaves `running` → the bridge sends `thr=0 steer=0` at 50 Hz no matter what the stick says | hold full throttle, hit it, car stops instantly |
| 2 | **300 ms watchdog** | no valid packet for 300 ms → firmware kills throttle and releases steer | hold throttle, `./raceday.sh stop` (or pull the laptop off the AP) — the car stops ~⅓ s later on its own |
| 3 | **`net off`** | the kart's own console refuses the net path entirely until `net on` | type it with a pilot flooring it; `netstat` shows `[net off]` |
| 4 | **the AA pack** | last resort | pull it |

The director screen has a big red **ABORT** button bound to `abort_race`, also on **Shift+Esc**.

> The pilot **cannot** override any of these: the bridge, not the phone, decides what the car
> receives. That is the sentence to say to a judge, and #1 is the demo that backs it.

---

## 6. IR tag

Optional by design — the race works without it. If it is in:

1. **Enable posting:** `set ir_post 1` (needs the WiFi link). `irstat` shows the post state plus
   every reject class. `ir_post 2` is a bench mode that posts with the link down.
2. **Loopback first, no wires:** `irtest 1 3` replays a synthetic TSSP edge sequence into the
   real decoder — interval measurement, framing, check nibble, self-hit filter, lockout, console
   line and the HTTP post all run exactly as for a real photon. Also try `irtest 1 bad` and
   `irtest 1 glitch` and watch `irstat` count the rejects.
3. **Carrier sanity:** `ircheck` measures the 38 kHz carrier on-chip.
4. **Desk-distance live retest:** aim car 1's TX LED (GPIO 14) at car 2's TSSP77038 (GPIO 3)
   from ~30 cm, confirm a hit, then repeat at real track distance. `irstat` on the **victim**
   is the instrument. One trigger pull decodes 3–8 frames; the 400 ms per-shooter lockout
   swallows the duplicates and counts them separately.
5. **The shield demo — the one to show judges.** Shield absorption is entirely server-side:
   `report_hit` and every item both route through the module's single `applyOffensive()`.

   ```
   debug_grant  [2,"shield"]     # kart 2 gets a shield
   use_item     [2,1]            # flags bit0 -> 0x01, WS2812 GPIO48 goes CYAN
   <tag kart 2>                  # the shield is CONSUMED, no stun, pixel goes dark
   <tag kart 2 again>            # now it stuns
   ```

   The point: one shield-check-then-effect code path for items *and* IR, and the firmware just
   reports honestly — it does not decide.

---

## 7. Failure drills — practise before anyone is watching

**A kart drops Wi-Fi.** The 300 ms watchdog stops it; it re-associates by itself. `netstat` shows
link state and the accepted / stale / foreign / resync counters. **If DHCP gave it a new lease,
the bridge is still talking to the old address** — update `car-bridge/karts.json` and
`vision/karts.json`, then restart the bridge (those files are read once at startup).

**Bridge restart.** `./raceday.sh stop` then `./raceday.sh --no-publish` (~3 s). On SIGTERM the
bridge sends three zero packets per kart, so the cars park immediately instead of coasting into
the watchdog. The sequence counter restarts from 0; harmless — the firmware resyncs and counts it.
If the bindings ever misbehave, `BRIDGE_SOURCE=sql` is the no-bindings fallback (HTTP `/sql`
polling, same rule engine).

**Module republish.** From `arkart/module`:
`spacetime publish arkart --server local --yes` — keeps the data. Always `--server local`;
**never** `spacetime version upgrade` (the CLI, the server and the generated bindings are a
matched 2.4.1 set). Only a schema change needs `--delete-data=always` (= `./raceday.sh --fresh`),
**which wipes the track and every lap** — re-do §4 afterwards. The bridge and the director
reconnect by themselves; restart the bridge if it sulks.

**Camera stream dead.** **The pilots drive blind and the race continues** — FPV is a nicety and
the control loop does not depend on it. The vision bridge retries forever
(`cannot open … — retrying`) and never takes the stack down. While it is dark, score gates by
hand: `report_gate '[<kart>,<tag>]'` from the director or a curl.

**A phone can't load the pilot page.** In order:
1. Is it on SSID **`arkart`** — not cellular, not the venue Wi-Fi?
2. Is the **port** the one the status block printed? 5174, not 5173, if something else had 5173.
3. Is `--host` on? `raceday.sh` always passes it; a hand-started `vite` without it binds
   localhost only and no phone can ever reach it.
4. Wrong page? `curl -s http://<ip>:<port>/pilot.html | grep -i '<title>'` must print
   `AR Kart — Pilot`. If it does not, use the **director screen** as the drive station
   (keyboard or gamepad → `set_input` at 25 Hz).
5. Last resort: the tethering iPhone reaches the Mac over the USB cable at
   `http://192.0.0.2:<port>/`.

**Nothing works and the judges are here.** `./raceday.sh --no-vision --no-director` gets
SpacetimeDB + the module + the bridge up in seconds, and the director screen can be opened
later with `?adapter=http`, which needs nothing generated. Drive from the director, score gates
by hand, show the abort switch. That still demonstrates the whole sponsor path.

---

## Race control — copy/paste

`./raceday.sh` prints this block at the end of every bring-up.

```bash
S=http://127.0.0.1:3000/v1/database/arkart/call
P() { curl -s -o /dev/null -w "%{http_code} $1\n" -X POST \
      -H 'Content-Type: application/json' -d "$2" "$S/$1"; }

P begin_setup   '[]'        # open the calibration lap
P report_gate   '[1,7]'     # manual gate entry: kart 1 saw tag 7
P confirm_track '[[]]'      # lock the first-seen order as the track
P start_race    '[]'        # 3 s countdown -> running
P abort_race    '[]'        # KILL SWITCH
P reset_race    '[]'        # back to lobby between heats (track kept)
```

Reducer arguments are a **positional** JSON array in declaration order. A one-shot `set_input`
curl proves the reducer but **does not move a car** — the bridge treats input older than 500 ms
as stale and zeroes it, so a stick has to be *held*. Logs for everything live in
`integration/.run/raceday-*.log`.
