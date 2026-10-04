# `arkart` — SpacetimeDB game-server module (TypeScript)

The authoritative AR Kart game server. Implements
[`docs/design/arkart-game-software-v1.md`](../../docs/design/arkart-game-software-v1.md)
§1 (game rules), §2 (track setup) and §4 (tables + reducers). Every game rule is a reducer;
nothing outside the database decides anything.

- Module language: **TypeScript** (`spacetimedb/server`, pinned to **2.4.1** to match the
  installed `spacetime` CLI — do not let npm float it to 2.10.x while the CLI is 2.4.1).
- Database name: **`arkart`**
- Local server: **http://localhost:3000** (`spacetime start` default)

---

## Run it

```bash
# 1. start the local SpacetimeDB instance (leave running, port 3000)
spacetime start --listen-addr 0.0.0.0:3000

# 2. install module deps (once)
cd arkart/module/spacetimedb && npm install

# 3. build + publish (from arkart/module/)
cd arkart/module
spacetime build
spacetime publish arkart --server local --delete-data=always --yes

# 4. end-to-end smoke test (publishes, then drives a whole race)
./smoke.sh              # full run, republishes first
./smoke.sh --no-publish # reuse the currently published module/data

# 5. poke at it
spacetime sql  arkart "SELECT * FROM progress" --server local
spacetime call arkart start_race --server local -y
spacetime logs arkart --server local -f
```

`spacetime.json` pins `server: local` and `spacetime.local.json` pins `database: arkart`, so
plain `spacetime publish` / `spacetime sql arkart "..."` from `arkart/module/` also work.

### HTTP (what the vision bridge and the iOS app actually use — no SDK needed)

```bash
# call a reducer: positional args as a JSON array
curl -X POST -H 'Content-Type: application/json' -d '[1,7]' \
  http://localhost:3000/v1/database/arkart/call/report_gate

# read state: raw SQL, JSON back
curl -X POST -H 'Content-Type: text/plain' -d 'SELECT * FROM progress' \
  http://localhost:3000/v1/database/arkart/sql
```

Both work **anonymously** on the LAN (demo-grade auth, spec §4 "Auth"). In the SQL JSON
response a `Timestamp` column is `[micros]`, and an optional column is `[0, payload]` for
`some` / `[1, []]` for `none`.

---

## Schema contract (canonical snake_case names — code against these)

| Table | Columns |
|---|---|
| `config` | `id`(=0), `lap_count`, `item_roll_pct`, `state`, `countdown_ends_at?` |
| `kart` | `kart_id` PK, `name`, `ip`, `pilot_identity?` |
| `input` | `kart_id` PK, `throttle` f32 0..1, `steer` f32 -1..1, `updated_at` |
| `track` | `seq` PK, `tag_id` — **seq 0 = start/finish** |
| `setup_seen` | `tag_id` PK, `first_seen_at`, `seen_idx` |
| `progress` | `kart_id` PK, `lap`, `next_idx`, `last_pass_at`, `placement`, `finished_at?` |
| `inventory` | `kart_id` PK, **`slot_1?`**, **`slot_2?`** |
| `effect` | `id` PK auto, `kart_id`, `kind`, `multiplier` f32, `expires_at?`, `source_kart` |
| `event_log` | `id` PK auto, `at`, `text` |
| `tick_timer` | scheduled, 100 ms |

> ⚠ **`slot_1` / `slot_2`, not `slot1` / `slot2`.** The module's default
> `CASE_CONVERSION_POLICY` is `SnakeCase` and it inserts an underscore before a trailing
> digit. In SDK 2.4.1 an explicit `.name('slot1')` is converted too (nothing lands in
> `misc_exports`), so the only way to get `slot1` would be to flip the whole module to
> `CaseConversionPolicy.None` and hand-write every identifier. Not worth it on demo day —
> **clients must read `slot_1` / `slot_2`.** Every other column matches spec §4 exactly.

**`state`** ∈ `setup` | `lobby` | `countdown` | `running` | `finished`.
**Item ids** (inventory slots): `boost` `stun` `ink` `dizzy` `leader_strike` `shield`.
**Effect kinds**: `boost` `stun` `ink` `dizzy` `slow` `shield` (`slow` = Leader Strike).

### Reducers

| Reducer | Args | Notes |
|---|---|---|
| `set_input` | `kart_id, throttle, steer` | ~25 Hz per phone. Clamped. Accepted in **every** state without error — the bridge is what zeroes throttle while `state != running`. |
| `report_gate` | `kart_id, tag_id` | Vision bridge. `setup` → append first-seen tag; `running` → advance only on the expected next checkpoint; otherwise ignored. |
| `use_item` | `kart_id, slot` | `slot` is 1 or 2. No-op unless `running`. |
| `report_hit` | `shooter, victim` | IR Tag Shot (stretch): 1.5 s stun through the same shield gate. |
| `begin_setup` | — | → `setup`, clears `setup_seen`. |
| `confirm_track` | `ordered_tag_ids: u32[]` | Validates (≥3, no dupes), writes `track`, `setup` → `lobby`. **An empty array adopts the calibration order in `setup_seen`**; a non-empty array is the manual/drag-reorder path. |
| `start_race` | — | `lobby` → `countdown` (3 s); `tick` promotes it to `running`. |
| `reset_race` | — | → `lobby`, progress/inventory/effects cleared, **track preserved**. |
| `abort_race` | — | **THE KILL SWITCH** → `lobby`, all effects cleared. |
| `tick` | scheduled | 100 ms: expires `effect` rows, closes the countdown. |
| `set_kart` | `kart_id, name, ip` | *extra* — point the car bridge at a kart's real LAN IP. |
| `set_config` | `lap_count, item_roll_pct` | *extra* — tune between races. |
| `debug_grant` | `kart_id, item` | *extra* — deterministically drop a known item in a free slot (used by `smoke.sh` and handy for a staged demo). |

### Item behaviour (spec §1)

| Item | Effect row | Target |
|---|---|---|
| `boost` | `boost` ×1.4, 2 s | self |
| `stun` | `stun` ×0, 2 s | rival |
| `ink` | `ink`, 4 s | rival (client renders; touches nothing physical) |
| `dizzy` | `dizzy`, 4 s | rival (bridge inverts steer) |
| `leader_strike` | `slow` ×0.3, 3 s | current 1st place |
| `shield` | `shield`, **`expires_at` unset** | self — absorbs exactly one incoming hit |

Grants: one weighted roll (25/15/15/15/10/20) on **every** valid checkpoint pass, gated by
`config.item_roll_pct`. Both slots full → the grant is lost (logged to `event_log`).

Every offensive hit — item **and** `report_hit` — goes through one function, so the
shield-check-then-effect rule is literally the same code path.

---

## Resolved spec ambiguities

1. **Placement at the lap wrap.** Spec §1 says rank by `next_idx` DESC, but `next_idx`
   resets to 0 after the last checkpoint is cleared — the kart closest to the finish line
   would sort *last*. Placement therefore ranks on **checkpoints-cleared-this-lap**
   (`next_idx == 0 ? track_len : next_idx`), identical to the spec everywhere except that
   wrap. Order is: `lap` DESC, cleared DESC, `last_pass_at` ASC (earlier wins ties),
   `kart_id` as the final tiebreak.
2. **Karts start on the line.** `start_race` / `reset_race` set `lap = 0, next_idx = 1`, so
   the first expected gate is checkpoint 1 and crossing seq 0 completes a lap. A 3-gate
   track therefore grants 3 items per lap.
3. **Leader Strike fired by the leader** targets the kart *behind* instead of self,
   mirroring the spec's own rival rule ("the leader targets the kart behind instead").
4. **Race end**: the race goes to `finished` the moment the **first** kart completes
   `lap_count` ("results frozen", spec §1). All effects are cleared at that point.
5. **Items are strings**, not an enum type — every client speaks plain JSON over HTTP.
6. **No AprilTag whitelist check** at `confirm_track` (R§4g's printed-tag whitelist is not
   in this repo); duplicates and `< 3` checkpoints are rejected.
7. **Auth is demo-grade** per spec §4 — reducers trust the `kart_id` argument; `ctx.sender`
   is not checked. Do not expose this server off the race LAN.

## Files

```
arkart/module/
  spacetime.json          server = local
  spacetime.local.json    database = arkart
  smoke.sh                end-to-end test (46 assertions)
  README.md               this file
  CLAUDE.md               SpacetimeDB TS API reference (from `spacetime init`)
  spacetimedb/
    package.json          spacetimedb pinned to 2.4.1
    tsconfig.json
    src/index.ts          the entire module
```
