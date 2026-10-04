# AR Kart — car bridge

The enforcer between SpacetimeDB and the karts.

```
SpacetimeDB `arkart`  ──subscribe──▶  car bridge  ──UDP 50 Hz──▶  ESP32-S3-CAM :7777
 (config/kart/input/effect)            (this pkg)                  (throttle, steer, shield LED)
```

Every game rule is decided by the module; this process only *applies* them:
it merges each kart's live effects onto that kart's live input, quantises the
result, and pushes an 8-byte packet to the kart 50 times a second. If the race
is not `running`, it pushes zero throttle — that is what makes `abort_race()` a
physical kill switch.

Spec: `docs/design/arkart-game-software-v1.md` §3 (topology), §5 (this component),
§6 (firmware contract).

---

## Run it

Requires **Node >= 22.18** (native TypeScript type-stripping; developed on 25.6).
No build step — Node runs the `.ts` files directly.

```bash
cd arkart/car-bridge
npm install

npm run check      # tsc --noEmit + unit tests   <- the self-check
npm test           # unit tests only
npm run typecheck  # tsc --noEmit only

npm start          # live: SpacetimeDB via the generated bindings
npm run sql        # live: SpacetimeDB via the HTTP /sql endpoint (no bindings needed)
npm run sim        # no database at all — synthetic throttle/steer sweep
npm run listen     # debug: pretend to be a kart, print incoming packets
```

Bench-test the whole path with two terminals and no hardware:

```bash
# terminal 1
npm run listen
# terminal 2 — point both karts at the laptop
printf '{"port":7777,"karts":[{"kart_id":1,"ip":"127.0.0.1"},{"kart_id":2,"ip":"127.0.0.1"}]}' > /tmp/karts.json
KARTS_FILE=/tmp/karts.json npm run sim
```

### Environment

| var | default | meaning |
|---|---|---|
| `SPACETIME_URI` | `ws://localhost:3000` | SpacetimeDB WebSocket URI |
| `SPACETIME_MODULE` | `arkart` | module name |
| `SPACETIME_HTTP` | derived from `SPACETIME_URI` | HTTP origin for the `sql` source |
| `BRIDGE_SOURCE` | `stdb` | `stdb` \| `sql` \| `sim` |
| `BRIDGE_BINDINGS` | `../../module/src/module_bindings/index.ts` | import path of the module's generated TS bindings |
| `KARTS_FILE` | `./karts.json` | kart_id → IP address book |
| `TICK_HZ` | `50` | UDP send rate per kart |
| `BRIDGE_DRY_RUN` | `0` | `1` = compute + encode but open no socket |
| `BRIDGE_VERBOSE` | `1` | `0` = silence the once-a-second status line |

### `karts.json`

```json
{
  "port": 7777,
  "karts": [
    { "kart_id": 1, "name": "kart-1-real", "ip": "REAL_CAR_IP" },
    { "kart_id": 2, "name": "kart-2", "ip": "192.168.8.102" }
  ]
}
```

This file, not the `kart` table, is the address book — at the venue you only
edit the two IPs once the karts have DHCP leases on the Opal. A `port` may be
set per kart to override the file default.

#### The real car — **fill in one string**

`kart_id 1` is the car being built now, and its `ip` is the placeholder
**`REAL_CAR_IP`**. One edit makes it live:

1. Flash the board and read the IP it prints on boot (`idf.py -p /dev/cu.usbmodem* monitor`),
   or take it from the GL.iNet Opal's DHCP client list.
2. Put that address in `karts.json` → `karts[kart_id == 1].ip`, replacing
   `REAL_CAR_IP`. **That is the only edit** — the port is already 7777 per the
   firmware contract §6.
3. Restart the bridge. `karts.json` is read once at startup, not watched.

`kart_id` here must match the board's `ARKART_KART_ID` (`idf.py menuconfig`)
**and** a row in the module's `kart` table (the module is seeded with karts 1
and 2). The packet's byte 2 carries this id and the firmware drops packets
addressed to anyone else.

**Until it is filled in, nothing breaks.** `isRoutableTarget()` in
`src/config.ts` classifies a dotless token like `REAL_CAR_IP` as a placeholder
rather than a hostname, so the kart loads with `configured: false`:

- the bridge starts normally, and the other kart is driven as usual;
- the startup line marks it — `karts=1@REAL_CAR_IP:7777(PLACEHOLDER) 2@192.168.8.102:7777`;
- the rule engine still runs for that kart and its sequence counter still
  advances, so filling the address in later shifts nothing downstream;
- `UdpSink` drops its datagrams and says so **once** (`[udp] kart 1 … is a
  placeholder`), counting them in `stats.skipped`. Without that check the 50 Hz
  loop would fire a failing DNS lookup fifty times a second, forever.

A *configured but unreachable* address (right IP, board powered off) needs no
special handling and never did: the datagram is simply lost, the error is
counted, and the firmware's 300 ms watchdog stops the motors.

> The integration harness uses its own loopback address book,
> `../integration/karts.local.json` (both karts → `127.0.0.1`), so `demo.sh` is
> unaffected by anything in this file.

---

## The wire contract (§6)

Exactly **8 bytes**, sent to `<kart ip>:7777`:

| off | size | field | encoding |
|---|---|---|---|
| 0 | 1 | magic | `'A'` = `0x41` |
| 1 | 1 | magic | `'K'` = `0x4B` |
| 2 | 1 | `kart_id` | u8 |
| 3 | 1 | `throttle` | u8, 0–255 |
| 4 | 1 | `steer` | **i8**, −127…127 (two's complement) |
| 5 | 1 | `flags` | u8; **bit0 = shield LED** (WS2812 GPIO 48, cyan) |
| 6–7 | 2 | `seq` | **u16 LITTLE-ENDIAN**, monotonically increasing, wraps at 65536 |

Worked examples (`test/packet.test.ts` holds these as golden vectors):

```
kart 1, full throttle, hard right, seq 1      41 4b 01 ff 7f 00 01 00
kart 2, half throttle, hard LEFT,  seq 2      41 4b 02 80 81 00 02 00      (-127 -> 0x81)
kart 2, shield up, stopped,        seq 0      41 4b 02 00 00 01 00 00
kart 1, seq 258                               41 4b 01 00 00 00 02 01      (LE: 02 01)
```

Firmware side (§6): parse it, LEDC PWM on GPIO 14 for throttle, sign of `steer`
to the H-bridge on GPIO 41/42, `flags & 1` to the WS2812, and **no valid packet
for 300 ms → motors off**.

---

## The rules it enforces (§5)

Per kart, every 20 ms:

```
cap   = product of every ACTIVE boost/slow multiplier for this kart, floored at 0.2
thr   = stunned ? 0 : input.throttle * cap          (and 0 unless config.state == running)
str   = dizzy ? -input.steer : input.steer
flags = shield_active ? 0x01 : 0x00
```

- **Ink** and **shield** never touch motion — ink is screen-only on the phone,
  shield is a flag and an LED.
- **Stun** hard-zeroes throttle regardless of how large a boost is stacked on it.
- An effect with no `expires_at` never times out (that is the shield: the module
  deletes the row when it is consumed).
- `state != running` → throttle 0 **and** steer 0. Lobby, countdown, finished and
  `abort_race()` all park the karts.
- **Stale input** (`updated_at` older than 500 ms — phone backgrounded, app dead)
  → throttle 0 and steer 0. A kart with no `input` row at all is stale by
  definition.
- An unrecognised `effect.kind` or `config.state` is dropped / falls back to
  `lobby`; the bridge never guesses its way into moving a car.
- Ctrl-C sends three zero packets per kart, continuing the sequence, so the karts
  stop immediately rather than coasting to the firmware watchdog.

---

## Layout

```
src/
  types.ts            row types mirroring the module's tables (§4) — OUR copy
  logic.ts            the rule engine. PURE: no clock, no sockets, no SDK
  packet.ts           the 8-byte encoder/decoder + the u16 sequence counter
  bridge.ts           the 50 Hz loop: snapshot -> rules -> packet -> sink
  config.ts           env vars + karts.json (incl. the placeholder-address rule)
  udp.ts              the UDP sink: one socket, N karts, placeholders skipped
  normalize.ts        raw SpacetimeDB/JSON rows -> our row types
  source.ts           the WorldSource interface (the SpacetimeDB seam)
  sources/
    spacetime.ts      live WebSocket path via the module's generated bindings
    sql.ts            fallback: poll the HTTP /sql endpoint, no bindings needed
    sim.ts            synthetic source + MutableSource (used by the tests)
    park.ts           decorator that forces "not running" for the shutdown park
  index.ts            daemon entry
  listen.ts           debug UDP listener
test/
  packet.test.ts      golden byte-vectors, two's complement, seq LE + wraparound
  logic.test.ts       effect merging, cap floor, stun/dizzy/shield, kill switch
  bridge.test.ts      the loop end-to-end into a recording sink
  adapter.test.ts     row normalisation, karts.json, SQL response decoding
```

---

## Integration notes (for the conductor)

**The SpacetimeDB seam is deliberately loose.** The module leg builds `arkart` in
parallel, so its generated bindings do not exist in this tree. Everything
database-shaped sits behind the `WorldSource` interface in `src/source.ts`; the
rule engine only ever sees `WorldSnapshot` built from our own row types. Wiring
up the real thing should be **one env var, no code change**:

```bash
spacetime generate --lang typescript --out-dir ../module/src/module_bindings
BRIDGE_BINDINGS=../../module/src/module_bindings/index.ts npm start
```

`src/sources/spacetime.ts` loads that path through a *variable* import specifier
(so `tsc` neither resolves nor type-checks it) and expects only the standard
generated surface — `DbConnection.builder().withUri().withDatabaseName().onConnect().build()`,
`conn.subscriptionBuilder().onApplied().subscribe([...])`, `conn.db.<table>.iter()`.
It subscribes to `config`, `kart`, `input` and `effect`.

SDK **2.4.1 renamed `withModuleName` to `withDatabaseName`**. The builder probes
the new name first and falls back to the old one, so both SDK generations work
with no patching of the generated bindings. Every *required* builder step now
throws if none of its known spellings exist, naming the methods the builder does
have — silently skipping an unknown method is what turned that rename into a
ghost failure that surfaced much later as `Database name or address is required`.

**If the bindings are not ready, `npm run sql` still proves the bridge against
the real database**: it polls `POST {http origin}/v1/database/arkart/sql` at
20 Hz, needs nothing generated, and feeds the identical rule engine. Use it as
the integration-day fallback.

Two things about that endpoint, both learned the hard way against a live
SpacetimeDB 2.4.1 and both now covered by tests:

- **One statement per request.** A multi-statement body is answered with
  `400 Multiple SQL statements are not supported`, so the four table queries go
  out as four parallel POSTs (`Promise.all`, order preserved).
- **Rows come back POSITIONALLY encoded.** A `Timestamp` is a one-element array
  `[1789894296001911]`, and an `Option<T>` is `[tagIndex, payload]` — `[1, []]`
  for `none`, `[0, [micros]]` for `some`. `src/normalize.ts` decodes both. Before
  it did, every `updated_at` read as 0 (so every input looked stale and the
  bridge commanded throttle 0 forever) and every `expires_at` read as null (so no
  timed boost/slow/stun/dizzy ever expired). `test/adapter.test.ts` pins the
  exact live payloads as a regression guard.

**Field-name drift is already absorbed.** `src/normalize.ts` reads every column
under both `snake_case` and `camelCase`, unwraps `Option` (`{tag:'none'|'some'}`),
unwraps tagged enums (`{tag:'Running'}`), and converts `Timestamp` micros to
epoch millis. If the module names a column something else entirely, add the
alias in one place there.

**Known deviations from the v1 spec text**, both conductor-dictated:

1. §5's packet sketch says `steer i8 -100..100`; the conductor's contract (and
   this implementation, and the firmware) uses the full **i8 −127…127**.
2. §5 does not say what happens to *steering* when input goes stale or the race
   leaves `running`. This implementation centres the steer coil as well as
   zeroing throttle, rather than leaving the coil energised at the last
   commanded deflection with no pilot attached.

**Assumption:** §5 writes `thr = input.throttle * cap` in normalised 0–1 terms
while the packet carries a u8, so the bridge quantises with
`round(clamp(throttle * cap, 0, 1) * 255)` — i.e. a boost saturates at 255 rather
than wrapping. Steer likewise: `sign * round(|steer| * 127)`, rounded on the
magnitude so a dizzy-inverted stick is an exact mirror of the stick.

`@clockworklabs/spacetimedb-sdk` is pinned to **1.3.3** as an *optional*
dependency: that package is deprecated in favour of `spacetimedb` (now 2.10.1),
and its `2.0.0` shim declares a dependency on `spacetimedb@next` — a dist-tag
that does not exist, so `npm i` fails with `ETARGET`. Nothing in this package
imports the SDK statically, so the version can change, the package can be
swapped for `spacetimedb`, or it can be absent entirely without breaking `tsc`
or the tests. Whatever the module leg's bindings import is what actually gets
used at runtime.
