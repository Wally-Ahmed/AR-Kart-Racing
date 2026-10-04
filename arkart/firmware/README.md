# AR Kart — kart-side firmware (ESP32-S3-CAM)

Everything that runs **on the kart**. Nothing else: no SpacetimeDB client, no game rules, no
item logic. By the time a control packet reaches this firmware the car bridge has already
decided what the kart is allowed to do, so the firmware's whole job is to actuate it and to
refuse to move when the link goes quiet.

| Capability | Where it lands |
|---|---|
| WiFi STA | SSID / password / kart id from `menuconfig` |
| MJPEG camera stream | `http://<kart-ip>/stream` (plus a check page at `/`) |
| UDP control listener | `:7777`, 8-byte packet, 50 Hz |
| Failsafe | no valid packet for **300 ms** → throttle 0, steer released |
| Status pixel | WS2812 on GPIO48 |
| TV-remote-style 38 kHz IR tag | **built** — TX GPIO14, RX GPIO3, `report_hit` over HTTP. Software-verified; **LED and receiver not soldered yet.** See **The IR tag layer** below. |

---

## Build, flash, monitor

ESP-IDF **v5.3.2** (installed at `~/esp/esp-idf`). Every shell needs the export script once:

```bash
source ~/esp/esp-idf/export.sh
cd HOP-HACKS/arkart/firmware

idf.py set-target esp32s3     # only needed once, or after deleting sdkconfig
idf.py menuconfig             # -> "AR Kart Firmware" -> set SSID / password / kart id
idf.py build

idf.py -p /dev/cu.usbmodem* flash monitor     # exit the monitor with Ctrl-]
```

The board has **two USB-C ports**. The CH340 UART port enumerates as `/dev/cu.wchusbserial*`
and is the reliable one for flashing; the native-USB port shows up as `/dev/cu.usbmodem*`.
`ls /dev/cu.*` before and after plugging it in if you are unsure which is which.

If a build ever gets strange after changing `sdkconfig.defaults`:

```bash
idf.py fullclean && idf.py set-target esp32s3 && idf.py build
```

### macOS SSL note

The ESP-IDF installer and the component manager both download over HTTPS with the framework
Python, which on this machine ships without a linked CA bundle. If you see
`CERTIFICATE_VERIFY_FAILED`, export the bundle before running anything:

```bash
export SSL_CERT_FILE=$(python3 -c "import certifi; print(certifi.where())")
```

(Or run `/Applications/Python 3.14/Install Certificates.command` once and forget about it.)

---

## Drive backends — Plan M and Plan RX

The teardown found the **same Tornado chassis with two different receiver boards** (the factory
varies the RX so two cars can race), so the firmware carries two drive backends. Both implement
the same `drive.h` contract — `drive_init` / `drive_apply(throttle, steer)` / `drive_all_off` /
`drive_current_duty`, driven by the same 50 Hz tick and the same 300 ms watchdog — so
`arkart_main.c` and `control_udp.c` are identical either way. **Exactly one is compiled**, by a
Kconfig choice; `main/CMakeLists.txt` picks the source file.

| | **Plan M** (`DRIVE_BACKEND_PWM`, default) | **Plan RX** (`DRIVE_BACKEND_RXINJECT`) |
|---|---|---|
| Stock board | discarded | **stays in the car, on the car's own batteries** |
| Soldering | 2N2222 drive + 4-transistor steer bridge + flyback diodes | **two wires** |
| ESP32 pins | GPIO47 PWM, GPIO41/42 steer | GPIO47 (`ARKART_PIN_RX_DATA`) only |
| Peripheral | LEDC timer 1, 3 channels | one RMT TX channel |
| Throttle | real PWM duty, slew-limited | frame-level duty cycling (the decoder is on/off) |
| Reverse | none (transistor is single-ended) | protocol has it; bench path only so far |
| Source | `main/drive.c` | `main/rx_inject.c` + `main/rx_console.c` |

**Plan RX in one paragraph.** The stock decoder — bench-confirmed as **SA1607RX 330** (SOP-16),
an RX-2B-family five-function 27 MHz clone with integrated motor H-bridges — keeps doing all the
power work. Its plug-in radio module is removed and the ESP32 impersonates it, bit-banging the
demodulated pulse-train into the chip's data input, **pin 14** (equivalently the radio socket's
DATA pad, the same net). Hookup is `GPIO47 → pin 14` and `ESP32 GND → the board's V- hole`; the
board's V+ stays unconnected. RMT, not a software timing loop, so WiFi and camera interrupts
cannot jitter a 500 µs pulse cell. The same single wire also works in reverse: `sniff` releases
the pin to a high-impedance input and reads the real protocol off it while the car's own remote
is pressed, because the car's receiver front end demodulates onto that very net.

### Building each car

```bash
source ~/esp/esp-idf/export.sh
cd HOP-HACKS/arkart/firmware

# Plan M — the transistor car (also what a plain `idf.py build` gives you)
idf.py -B build.planm  -D SDKCONFIG=sdkconfig.planm.out \
       -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.planm"  build

# Plan RX — the stock-board car
idf.py -B build.planrx -D SDKCONFIG=sdkconfig.planrx.out \
       -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.planrx" build

# flash whichever, adding the kart id for that car
idf.py -B build.planrx -D SDKCONFIG=sdkconfig.planrx.out -p /dev/cu.wchusbserial* flash monitor
```

Separate `-B` build directories and `-D SDKCONFIG=` files mean the two cars never invalidate
each other's build. `idf.py menuconfig` → **AR Kart Firmware → Drive backend** does the same
thing interactively for the default `build/` tree. Remember `ARKART_KART_ID` is still a
per-car setting on top of the backend choice.

### The Plan RX bench console

Printed on boot and by `help`. It is a plain line parser on the console UART (115 200) — type
straight into `idf.py monitor`. **The pulse-count ladder in the firmware is the RX-2B reference
table, not a measured SA1607RX table; clones deviate, so the sweep is the ground truth.**

| Command | What it does |
|---|---|
| **`sniff`** | **stop transmitting, release the pin to high-Z input, and print the REAL protocol** off the wire while you press the car's own 27 MHz remote. See below. `stop` ends it; auto-stops after 120 s with no edge. |
| `sweep <from> <to>` | no remote in hand? walk every pulse count in the range, ~1.5 s each with a 1 s gap, logging `N=<count> SENT`. Watch which count moves which motor. Works in either direction. |
| `code <n>` | hold one pulse count until `stop` |
| `set code <name> <n>` | write a confirmed count into the ladder. Names: `fwd turbo slot2 fwdleft fwdright back backright backleft left right` |
| `fwd <0..255>` | drive through the normal `(throttle, steer)` mapping |
| `back <0..255>` | the same, using the BACKWARD codes (bench only — the wire protocol is still forward-only) |
| `steer <-100..100>` | set steer, keep the current throttle |
| `stop` | silence the transmitter (or end a sniff) and hand control back to the net path. Ctrl-C does the same. |
| `set <key> <value>` | `period_us duty_pct gap_ms w1 sgap_us window thr_min_pct deadband offslot_ms invert steerfill hold_ms sweepgap_ms sniffgap_us sniffrep_ms` |
| `show` / `help` | current timings + ladder / this reference |

## The net drive layer — bridge packet → stock-remote buttons

`main/net_drive.c` is what makes a **Plan RX build drive the car from the network**: the control
packet that `control_udp.c` already receives, filters and failsafes is turned into the SET of
remote buttons `btn_remote.c` should hold. It is compiled only with the RXINJECT backend (those
pads are Plan M's steer-coil H-bridge) and it consumes `btn_remote.h` only — the pin map and the
open-drain press rule stay where they are.

| Field on the wire | What the net layer does with it |
| --- | --- |
| `throttle` u8 0..255 | `> 8` (~3 %) holds the drive key; `<= 8` releases it. Magnitude becomes `btn_remote`'s chop percentage, linearly: `pct = thr*100/255`. **`thr 0` is the bridge's kill switch** — it zeroes throttle whenever the race state is not `running` — and the same comparison releases the key on the packet, not a tick later. |
| `steer` i8 -127..127 | `> +12` → RIGHT, `< -12` → LEFT, inside → both released. The deadband is `ARKART_STEER_DEADBAND` and the sign is `ARKART_STEER_SIGN`, both shared with Plan M so the two cars feel the same. |
| `flags` bit0 | shield → cyan WS2812 on GPIO48 (unchanged behaviour, `status_led.c`). |
| `flags` bit1 | **reverse**, new and additive: holds BACK instead of FWD. The remote has a real BACK button but the packet has no direction field, and byte 3 is unsigned — reading it as an i8 would turn every throttle above 127 the bridge already sends into reverse. The bridge sets `flags` from `shield ? 0x01 : 0x00` and nothing else, so bit1 is always 0 today and the net path is forward-only until the bridge opts in with one `\| FLAG_REVERSE`. |

Throttle shaping has a floor that is the *car's*, not ours: `btn_remote` holds the drive key for
at least 50 ms of the 120 ms window because the decoder needs ~2 frames of a code before it
acts, so every percentage from 1 to ~41 drives at the same ~42 % effective duty. `btnstat`
prints the real on/off split, so it is never a mystery.

**Who owns the four pads** — it follows the control link, not a mode flag:

| State | Owner | `btn_watchdog_ms` |
| --- | --- | --- |
| No valid packet for 300 ms (including since boot) | the bench console; `press fwd` holds indefinitely | 0 (off) |
| A valid packet accepted → link up | the net layer, rewriting the whole button set every 20 ms; a console `press` is overridden within one tick | **forced to 300** |
| Link lost while armed | handed back: everything released, chop back to 100 %, console hold restored | 0 (off) |
| `net off` | the console, whatever arrives — a bench kill so a human can always win | 0 (off) |

The 300 ms leash is a *second*, independent failsafe: the control task's own watchdog releases
the buttons, and `btn_remote`'s tick would release them even if that task died mid-hold. To
stop a net-driven car the real answer is the bridge's kill switch, not the console — `stop`
releases the pads but a live link re-asserts them 20 ms later.

Sequence numbers are strictly monotonic **per source** (serial-number comparison, so 65535 → 0
is +1 and duplicates/reorders are dropped), with three baseline-adoption hatches so a restarted
bridge is not locked out for ~32k packets: a changed source address/port, a silence longer than
`ARKART_SEQ_RESYNC_MS`, and a backwards jump bigger than 1024.

### Net-path console commands (Plan RX)

| Command | What it does |
| --- | --- |
| `netstat` | WiFi + IP, link state, source address, accepted / stale / foreign / resync counters, the last accepted packet, what it mapped to, the status-pixel state and the deadbands. Reads only. |
| `netpkt <thr> [steer] [flags] [seq]` | send **one real datagram** to this board's own `:7777` over the lwip loopback interface, exercising socket → `recvfrom` → magic/kart filter → seq filter → mapping → pads. `thr` is SIGNED (negative = reverse). An omitted `seq` auto-increments; an explicit one is sent verbatim, which is how a stale or duplicate seq is tested. This is what makes the net layer testable with no access point in the room. |
| `net off` / `net on` | the bench kill above. Default on. |

### Bench tools — `tools/`

| Tool | What it is for |
| --- | --- |
| `tools/arkart_pktgen.py` | the laptop-side stand-in for the car bridge: byte-identical 8-byte packets at 50 Hz over the LAN, so `netpkt -120` on the board and `--thr -120` from the laptop are the same test. `--count`/`--seq`/`--freeze-seq` cover the stale-sequence case, `--src-port` pins the source so the per-source seq filter sees one sender. |
| `tools/ir_codec_test.c` | host round-trip test for the IR codec: `cc -std=c11 -Wall -Wextra -Werror -Imain -o t tools/ir_codec_test.c && ./t`. 215 checks — encode → synthetic TSSP edges → decode, every id, every single-bit corruption, ±25 % jitter, timestamp wrap, 200 k random edges, and the debounce / self-hit ladder on a fake clock. No ESP-IDF needed. |
| `tools/con.py` | drives the bench console over `/dev/cu.usbserial-10` without resetting the board (`rts=False`, `dtr=False`) and prints the transcript. Several lines in one invocation are written in a single write, so e.g. `netpkt 255` and `btnstat` land inside the 300 ms watchdog window. macOS has no `timeout`; this does the waiting. |

```bash
PY=$(echo ~/.espressif/python_env/*/bin/python)

# hold full forward for 2 s at 50 Hz (needs the kart's IP — `netstat` prints it)
$PY tools/arkart_pktgen.py --host <kart-ip> --thr 255 --duration 2 --src-port 7778
# half throttle, so the chop shaping shows up in `btnstat`
$PY tools/arkart_pktgen.py --host <kart-ip> --thr 128 --duration 2 --src-port 7778
# reverse (flags bit1), steer right, shield on
$PY tools/arkart_pktgen.py --host <kart-ip> --thr -120 --steer 100 --shield --duration 2
# one packet with an already-used sequence number: must be dropped as stale
$PY tools/arkart_pktgen.py --host <kart-ip> --thr 255 --count 1 --seq 3 --freeze-seq

# read the board back
$PY tools/con.py 'netstat'
$PY tools/con.py 'netpkt 255' 'btnstat'      # same, with no access point in the room
```

### `sniff` — read the protocol instead of guessing it

The car's own receiver front end demodulates the original remote onto the **same** pin-14 net we
inject into. So if the ESP32 lets go of the pin and just watches, every frame the decoder sees,
we see. This is the best calibration path by a wide margin: it reads the answer out of the
hardware rather than inferring it from which count made a wheel turn.

```
rx> sniff
I rx_inject: SNIFF listening on gpio47 (high-Z input) — transmitter released
I rx_inject: press buttons on the car's own 27 MHz remote, one function at a time; `stop` when done
I rx_inject: SNIFF burst: 14 pulses (4+10), period 508us, duty 49%, gap 3.9ms, sgap 750us, idle=low  <<< NEW
I rx_inject:              ^ count 10 seen x38 so far
I rx_inject: SNIFF burst: 14 pulses (4+40), period 509us, duty 49%, gap 3.9ms, sgap 748us, idle=low  <<< NEW
rx> stop

--- SNIFF summary ---------------------------------------------------------
  80 bursts, 5 distinct code counts, 0 dropped edges, idle=low
   code   w1  total  repeats  period  duty   sgap
     10    4     14       20   508us   49%    750us
     40    4     44       18   508us   49%    750us
     ...
  Suggested — VERIFY each against the button you actually pressed:
  set code fwd       10
  set code turbo     16
  set code back      40
  set code left      58
  set code right     64
---------------------------------------------------------------------------
```

Reading the output:

- **`14 pulses (4+10)`** — the burst held 14 cells with one internal idle much longer than the
  rest, i.e. a **W1 section of 4** then a **function code of 10**. That second number is what
  `set code` wants, and it is what the summary's `code` column and the suggestions use.
- **`gap`/`sgap`** are *silence since the last edge*, so each includes the trailing low half of
  the cell before it. Our own transmitter's `gap_ms 4` + `period_us 500` reads back as ~4.25 ms,
  and `sgap_us 500` as ~750 µs. That is correct, not an error — it is what the decoder sees.
- **`idle=low`** is the line's resting level, sampled between bursts. If it reads `high`, set
  `invert 1` so the transmitter matches.
- **`ODD EDGES`** on a line means an edge was missed (see the caveat below) — re-press the button.
- A held button repeats its frame every ~11 ms. The first sighting of each count prints at once
  (`<<< NEW`); after that a count re-prints at most once per `sniffrep_ms` (1 s) with a running
  `x<n>` tally, so the console stays readable and you can still call out "that was FORWARD".
- Nothing at all? Check the remote's batteries, the wire on pin 14, the shared ground, and that
  **the car's own board is powered** — its receiver is what does the demodulating.

`set sniffgap_us` (default 2000) is the idle that ends a burst. It must sit above an intra-frame
idle (~250–750 µs) and below the inter-frame gap (~4 ms); it is adjustable *mid-session*, so if
a clone's timings differ you can retune and re-press without restarting.

**How the pin is released.** `sniff` runs inside the same task that owns every `rmt_transmit()`,
between frames — so there is no window in which one task could transmit onto a pin another task
has turned into an input, and no handshake to get wrong. That task then (1) `rmt_disable()` +
`rmt_del_channel()`, which un-routes RMT from the pad and frees its memory block, and (2)
`gpio_config(GPIO_MODE_INPUT)` with **both pulls disabled**, which clears the pad's output enable
and points the OE mux back at the GPIO register — so even a stale peripheral route cannot drive
the line, and no pull resistor biases a line somebody else is driving. On `stop` the reverse runs
through the identical code the boot path uses. While sniffing, `code`/`sweep`/`fwd`/`back`/`steer`
are refused with a message, and the UDP path (including the watchdog's `drive_all_off`) is inert.

**Capture** is a GPIO any-edge interrupt timestamping into a 1024-entry lock-free ring, drained
every 5 ms. RMT RX was the alternative and was rejected because it ends a receive on a *fixed*
idle threshold chosen **before** capture — the very guess sniffing exists to eliminate — and
because a held button would overrun its 48-symbol block. Edge timestamping keeps the threshold a
runtime knob and touches no shared peripheral: the WS2812's RMT channel, the camera's
LCD_CAM/GDMA/LEDC-timer-0 and WiFi are all untouched. Cost is one interrupt per edge, ~4 kHz.
*Caveat:* the ISR service is installed without `ESP_INTR_FLAG_IRAM` (that would force every other
GPIO handler in the system to be IRAM-safe), so an edge arriving while the flash cache is
disabled — an NVS write, say — is lost. It shows up as `ODD EDGES` on that one burst.

A typical calibration: `sniff` → press each function on the remote in turn → `stop` → paste the
suggested `set code …` lines you can vouch for → `fwd 180` and `steer -60` to confirm the kart
obeys what we now *transmit* → `stop`. With no remote available, `sweep 4 70` does the same job
from the other end.

**Safety.** The UDP watchdog is unchanged: no valid packet for 300 ms and the transmitter stops,
which is how the decoder releases the motors. Bench commands deliberately *override* that
watchdog — that is what makes them bench commands — so every *transmitting* one carries its own
**10 s hard timeout**: not refreshed within 10 s and the transmitter stops and the network gets
control back. A sweep refreshes it each time it advances, so a long sweep survives while a wedged
one does not. `sniff` transmits nothing at all, so nothing can be pinned; it gets the longer
**120 s no-edge** leash instead.

---

## Kconfig options — `idf.py menuconfig` → **AR Kart Firmware**

| Option | Default | Notes |
|---|---|---|
| `ARKART_DRIVE_BACKEND` | Plan M (PWM) | Choice: `PWM` (`drive.c`) or `RXINJECT` (`rx_inject.c`). See **Drive backends** above. |
| `ARKART_RXINJECT_CONSOLE` | on (RXINJECT only) | The bench calibration console. Off only for a race build where nothing may be typed at the kart. |
| `ARKART_WIFI_SSID` | `arkart` | Use your own travel AP on a clean channel. Venue WiFi loses demos. |
| `ARKART_WIFI_PASSWORD` | `arkartarkart` | Empty for an open AP. |
| `ARKART_KART_ID` | `1` | **The only per-kart difference in the whole firmware.** Flash kart 2 with `2`. Packets whose byte 2 is a different id are dropped. |
| `ARKART_UDP_PORT` | `7777` | The car bridge hard-codes 7777. Change both or neither. |
| `ARKART_STDB_HOST` | `192.168.4.1` | **IR tag only.** Where `report_hit` is POSTed — the laptop running `spacetime start`, on the kart's own network. |
| `ARKART_STDB_PORT` | `3000` | `spacetime start`'s default. |
| `ARKART_STDB_DB` | `arkart` | The published module name. |
| `ARKART_USE_STATIC_IP` | off | Turn on to skip the "which address did it get this time" step. |
| `ARKART_STATIC_IP` / `_GW` / `_NETMASK` | `192.168.4.11` / `.1` / `255.255.255.0` | Only when the above is on. |

Build config that is not in this menu (flash size, PSRAM, partitions, camera sensor list)
lives in `sdkconfig.defaults` and is commented there.

---

## The control packet

Sent by the car bridge, 50 Hz per kart, UDP. **8 bytes, exactly** — anything else is ignored.

| Byte | Field | Meaning |
|---|---|---|
| 0 | `'A'` | magic |
| 1 | `'K'` | magic |
| 2 | `kart_id` u8 | dropped silently if it is not this kart |
| 3 | `throttle` u8 | 0–255, **forward only** (no reverse in Plan M) |
| 4 | `steer` i8 | −100…+100 |
| 5 | `flags` u8 | bit0 = shield active → cyan pixel |
| 6–7 | `seq` u16 | **little-endian** |

`seq` is checked with a wrapping serial-number comparison: a packet is accepted only when
`(int16_t)(seq - last_seq) > 0`, so duplicates and out-of-order stragglers are dropped and the
65535 → 0 wrap is handled. Two escape hatches keep a bridge restart from locking the kart out:
a gap of more than 1 s resyncs the baseline, and a jump backwards of more than 1024 is read as
a restarted counter rather than a straggler.

Quick manual test without the bridge — throttle 0x40, steer +30, no shield, seq 1:

```bash
printf 'AK\x01\x40\x1e\x00\x01\x00' | nc -u -w1 <kart-ip> 7777
```

Send it repeatedly (faster than every 300 ms) or the watchdog will cut in — which is itself
the easiest way to verify the watchdog: send one packet, watch the motor stop ~300 ms later.

---

## Reading the status pixel

The one WS2812 on GPIO48 is the whole health display, readable from across the track:

| Pixel | Meaning |
|---|---|
| **Cyan, solid** | shield item up (`flags` bit0) |
| **Dim green, solid** | connected, armed, driving normally |
| **Red, fast blink (~5 Hz)** | not on WiFi |
| **Amber, slow blink (~1.25 Hz)** | on WiFi, but the 300 ms control watchdog has tripped — motors are off |

---

## Where the probe constants go

**`main/motor_map.h`, and nowhere else.** Every number the bench session produces is a
`// PROBE-TODO` line in that one file; no other source file hard-codes a motor number. Measure,
edit the header, `idf.py build flash`.

| Constant | What it is | How it gets measured |
|---|---|---|
| `ARKART_MIN_DUTY` | drive-motor deadband floor | on the bench supply at 4.50 V, ramp duty until the wheels break away under the kart's own weight on carpet; add ~5 % |
| `ARKART_MAX_RAMP` | slew cap, duty counts per 20 ms tick | scope the 3.3 V rail on a 0→full throttle step; lower until the rail stops dipping below ~3.0 V and the camera survives |
| `ARKART_MAX_DUTY` | **absolute throttle ceiling, in percent** (100 = no cap) | from probe ② stall current at 4.50 V: **~60–70 % if stall lands in 0.8–2 A**. Below ~0.8 A leave it at 100; above ~2 A cap harder. This is the single-transistor guard — see below. |
| `ARKART_STEER_SIGN` | which way is left | command steer +100, see which way the wheels point; flip to `-1` if wrong |
| `ARKART_STEER_VARIANT_P_OR_N` | `'N'` all-NPN bridge or `'P'` complementary + level shifters | a build decision, not a measurement — set it to the bridge you actually soldered |

Secondary, same file, same treatment: `ARKART_PWM_FREQ_HZ`, `ARKART_STEER_DEADBAND`,
`ARKART_STEER_MIN_DUTY`, `ARKART_STEER_DEADTIME_US`, `ARKART_DRIVE_OUTPUT_INVERT`.

The P/N variant only changes **pad polarity**, via the LEDC `output_invert` flag. The rest of
the driver keeps the same meaning either way: duty 0 = coil off, duty max = full deflection.

### One drive transistor, not two

The kit holds exactly ten 2N2222. Each kart spends four on its steer bridge, which leaves
**one** for the drive motor on each of the two karts — no paralleled twin, no spares. The
drive device therefore carries the whole motor current by itself, and a 2N2222 is a 600 mA
continuous part while a stalled toy drive motor will ask for considerably more.

`ARKART_MAX_DUTY` is the guard. It caps average current with no extra parts, and it is applied
**after** the ramp in `drive.c`, so it is a genuinely absolute ceiling: no sequence of commands
and no accumulation of ramp steps can get past it. Clamping only ever lowers the duty, so the
"decreases are instant" safety rule is unaffected.

Two compile-time assertions in `drive.c` catch a mis-set cap: `ARKART_MAX_DUTY` must be 1–100,
and the resulting ceiling must sit above `ARKART_MIN_DUTY` — otherwise the kart would silently
never move, which on the track looks exactly like a dead transistor or a cold solder joint.
`drive_init()` also logs the resulting throttle window at boot.

If more 2N2222s turn up, a second device paralleled onto the same base line doubles the
headroom and changes nothing in this firmware except that `ARKART_MAX_DUTY` can go back
to `100`.

---

## The IR tag layer — T3, `main/ir_tag.c`

A TV-remote-style 38 kHz infrared tag: the same kind of low-power IR link a television remote
uses. It rides with **both** drive backends, because its two pins are free under both.

**Hardware is NOT soldered yet.** The software is complete and verified; the LED and the
receiver module are a later bench step.

```
GPIO14  ->  100 R  ->  IR LED anode, cathode to GND.  LED aimed FORWARD off the nose.
GPIO3   <-  TSSP77038 breakout OUT.   PINOUT IS 1 GND / 2 VS / 3 OUT / 4 G  — NOT the TSOP
            pinout. VS 2.0..5.5 V, so 3V3 is fine.
```

### On-air format

Normative definition and the only copy of the numbers: **`main/ir_tag_codec.h`**. It is pure
`static inline` C with no ESP dependencies, so the same encoder and decoder compile on a host.

```
carrier   38.0 kHz, 1/3 duty, RMT hardware carrier on the MARK level
coding    pulse-distance (NEC-style), MSB first
frame     HEADER  mark 2400 us, space 600 us
          8 BITS  mark 600 us, then space 600 us = 0 / 1200 us = 1
          TRAILER mark 600 us, then silence
payload   bits 7..4  shooter kart id, 1..15 (0 invalid, never sent)
          bits 3..0  check = (~id) & 0x0F — the nibble complement, as NEC does
burst     3 copies of the frame, 20 ms apart. 114 ms of air time worst case.
```

Frame length 13.2 ms (payload `0x00`) to 18.0 ms (`0xFF`). `IR_FRAME_MARK_US` = 7800 µs of
carrier-on time per frame, independent of payload — that constant is what `ircheck` divides by.

### Decode path, and the debounce

```
GPIO3 ANY_EDGE ISR  ->  edge queue (256)  ->  decoder task (core 1, prio 5)
                                          ->  post queue (4)  ->  report task (core 0, prio 3)
```

The ISR reads the clock, reads the level, enqueues — nothing else. It is deliberately **not**
inside `rx_inject`'s transmit task, whose timing is the car's radio protocol.

Lockout is **per shooter id**, default 400 ms (`set ir_lockout_ms`). One burst is 3 frames plus
reflections, so the raw decode rate for one trigger pull is 3–8 frames; 400 ms swallows all of
them with margin while letting a *different* kart score immediately. The module's IR stun is
1.5 s, so a second hit from the same shooter inside 400 ms would be a server-side no-op anyway.
`irstat` counts the swallowed ones separately, so a mis-tuned lockout is visible, not silent.

### Reporting a hit

One concise console line per accepted hit, and one HTTP call:

```
POST http://<ARKART_STDB_HOST>:<PORT>/v1/database/<DB>/call/report_hit
Content-Type: application/json

[shooter, victim]
```

Same positional-JSON reducer convention the vision bridge uses for `report_gate`
(`vision/arkart_vision/reducer.py`), anonymous, posted from its own task so the decoder never
blocks on the network. Skipped and counted while the link is down — never retried, never fatal.

**Shield absorption is entirely server-side.** `report_hit` routes through the module's single
`applyOffensive()`, which consumes a shield if the victim has one and otherwise inserts the
stun; it also drops `shooter == victim` and an unknown victim. The firmware does nothing
special — it reports honestly and the module decides.

### IR console commands (Plan RX)

| | |
|---|---|
| `irtx` | fire one burst on GPIO14 now |
| `irstat` | TX/RX counters, every reject class, carrier numbers, post state |
| `irtest <id> [n\|bad\|glitch]` | **loopback with no wires**: replay a synthetic TSSP edge sequence into the real decoder. `n` clean copies, `bad` = wrong check nibble, `glitch` = broken framing |
| `ircheck` | measure the carrier **on-chip** with PCNT + a CPU edge poll |
| `set ir_lockout_ms <ms>` | per-shooter debounce window |
| `set ir_repeats <1..8>` | frame copies per burst |
| `set ir_post <0\|1\|2>` | posting off / on / forced (bench: posts with the link down, so the HTTP path runs with no AP in the room) |

`irtest` enters at the ISR's own queue, so interval measurement, the state machine, the check
nibble, the self-hit filter, the lockout, the console line and the HTTP post all run exactly as
they do for a real photon. That is what makes the whole RX half testable before anything is
soldered.

`ircheck` note: `pcnt_new_channel()` runs `gpio_config()` on the edge pin, and any mode with an
output bit makes that end in `esp_rom_gpio_connect_out_signal(pin, SIG_GPIO_OUT_IDX)` —
silently unrouting RMT from the pad. `ir_tag.c` saves and restores
`GPIO.func_out_sel_cfg[14]` around the call for exactly that reason. The first version of the
function measured 0 Hz because of it.

---

## Pins and timers (do not reshuffle without re-reading the research)

```
camera DVP   GPIO 4-13, 15-18     14 pins — this is why the motors are on 14/41/42
drive PWM    GPIO 14 (Plan M)     single low-side 2N2222, forward only, duty-capped
             GPIO 47 (Plan RX)    the SA1607RX pin-14 injection wire
steer A / B  GPIO 41 / 42         H-bridge, never both on — driver enforces dead-time
status pixel GPIO 48              WS2812, RMT TX
IR tag TX    GPIO 14              38 kHz IR LED, RMT TX + hardware carrier — main/ir_tag.c
IR tag RX    GPIO 3               TSSP77038 OUT, GPIO edge ISR (strapping pin, inert after reset)
free         GPIO 21              pin-map's reverse slot; Plan M drops reverse
```

> GPIO14 is the Plan M drive PWM **and** the IR LED. They are never in one image in a way that
> conflicts: Plan M cars do not get an IR LED on 14. Pick one per car; `motor_map.h` and
> `ir_tag_pins.h` are the two places that say which.

**The camera driver owns `LEDC_TIMER_0` / `LEDC_CHANNEL_0`** for XCLK. All motor PWM is on
`LEDC_TIMER_1` (channels 1–3). Putting a motor on timer 0 is the documented way to get
`camera_probe failed` / "Got invalid frame from camera!".

**The IR tag uses no LEDC at all** — it took route (b) of the two that were researched, RMT TX
with the peripheral's native carrier modulation, because the receiver has to answer "*which*
kart shot me", not just "was there 38 kHz light". So `LEDC_TIMER_2`, which was reserved for the
LEDC route, is still free, and so is timer 3.

**RMT TX channel budget** (the S3 has 4): `status_led` 1, `rx_inject` 1 under Plan RX,
`ir_tag` 1. Three of four.

Boot order in `app_main()` enforces this: status pixel → **camera** → motors → WiFi → control
listener → HTTP server.

## Core split

| Core | Carries |
|---|---|
| 0 | WiFi + the HTTP/MJPEG server (the stream handler blocks its worker for as long as a client watches) |
| 0 | …and the IR tag's report task (prio 3) — it is an HTTP client, so it belongs with the stack |
| 1 | control loop (prio 6) + IR decoder task (prio 5) + button tap (prio 4) + status LED task (prio 2) |

That split is the point: a stalled video stream can never stall steering.

---

## Files

```
CMakeLists.txt            project
partitions.csv            3 MB factory app on 16 MB flash, no OTA
sdkconfig.defaults        flash / PSRAM / brownout / camera sensor selection
sdkconfig.planm           overlay: select the Plan M (PWM) drive backend
sdkconfig.planrx          overlay: select the Plan RX (injection) drive backend
main/
  arkart_main.c           boot order, heartbeat log
  wifi_sta.c/.h           STA + forever-reconnect, WIFI_PS_NONE
  camera_stream.c/.h      OV3660 init + /stream MJPEG + / check page
  control_udp.c/.h        packet parse, seq freshness, 300 ms watchdog, 50 Hz tick
  drive.h                 the drive contract BOTH backends implement
  drive.c                 Plan M: LEDC throttle w/ slew cap, H-bridge steer w/ dead-time
  rx_inject.c/.h          Plan RX: RX-2B/SA1607RX pulse-train injection over RMT,
                          plus `sniff` — the pin released to input, edges timestamped
  rx_console.c/.h         Plan RX: the sniff / sweep / set / smoke-test bench console
  status_led.c/.h         WS2812 over RMT (hand-rolled encoder, no extra component)
  net_drive.c/.h          Plan RX: bridge packet -> the set of remote buttons to hold
  btn_remote.c/.h         Plan RX: the stock remote's four buttons on GPIO39..42
  motor_map.h             >>> ALL PROBE-TODO CONSTANTS LIVE HERE <<< (+ the Plan RX pin)
  ir_tag.c/.h             T3 IR tag: 38 kHz TX on GPIO14, edge decode on GPIO3,
                          per-shooter debounce, report_hit over HTTP, irtest loopback
  ir_tag_codec.h          >>> THE ON-AIR FORMAT <<< pure static-inline C, host-testable
  ir_tag_pins.h           the IR tag's two pins, and why they are those two
  Kconfig.projbuild       the "AR Kart Firmware" menu
  idf_component.yml       espressif/esp32-camera ^2.0.0
```

## Known-good failure behaviour

- **Camera fails to init** → logged, firmware continues. The pilot loses FPV and the vision
  bridge loses this kart's gates; driving and the failsafe still work. Better a blind kart
  than a boot loop.
- **WiFi never joins** → kart stays parked (the watchdog never releases), reconnect keeps
  running in the background, pixel blinks red.
- **Bridge dies mid-race** → watchdog trips in 300 ms, motors off, pixel goes amber. On Plan RX
  "motors off" means the transmitter goes silent, and the stock decoder releases its outputs on
  loss of signal — the same failsafe, one layer further out.
- **Plan RX, bench console active** → the console owns the transmitter and the 300 ms watchdog is
  logged-and-ignored (once a second) until `stop` or the 10 s bench timeout. This is deliberate:
  a calibration session must not be interrupted by a kart that has no bridge talking to it.
- **Brownout on motor inrush** is the single most likely hardware failure. `ARKART_MAX_RAMP`
  is the software half of the mitigation; bulk capacitance at the motor terminals is the
  other half, and the firmware cannot substitute for it.
