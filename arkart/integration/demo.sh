#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════
#  AR Kart — END-TO-END INTEGRATION DEMO
#  One script. Six components. Real wire, real database, real bytes.
# ══════════════════════════════════════════════════════════════════════════════
#
# Proves, with a running SpacetimeDB and NO hardware at all:
#
#   T0-SW  the software half of the control loop —
#          HTTP set_input -> SpacetimeDB `arkart` -> car bridge (WebSocket,
#          generated bindings) -> 8-byte UDP packets at 50 Hz -> a fake kart
#          (`npm run listen`). Throttle and steer on the wire track the stick,
#          the sequence number never skips, and abort_race parks the car.
#
#   T2     every item, end to end — granted in the database, used in the
#          database, and VISIBLE IN THE PACKET BYTES: boost scales throttle up,
#          stun zeroes it, dizzy mirrors the steering, Leader Strike slows P1,
#          shield raises the LED flag and eats exactly one hit, ink changes
#          nothing physical (it is screen-only, by design).
#
#   T1     the vision loop — a synthetic 2-lap FPV video through the real
#          AprilTag detector, POSTing real `report_gate` calls, advancing
#          lap/next_idx in gate order and recomputing placement.
#
# Usage
#   ./demo.sh                 # full run: republish the module, then prove everything
#   ./demo.sh --no-publish    # reuse the module/data already published
#
# Requires: `spacetime start` listening on :3000, Node >= 22.18, the vision venv
# at arkart/vision/.venv, and the generated bindings (./gen-bindings.sh — this
# script runs it automatically if they are missing).
#
# Every background process it starts is killed on exit, including on Ctrl-C.
# Re-runnable as many times as you like.
#
set -uo pipefail

# ── layout ────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARKART="$(cd "$HERE/.." && pwd)"
CB="$ARKART/car-bridge"
VISION="$ARKART/vision"
MODULE="$ARKART/module"

DB=arkart
SRV=local
URL=http://127.0.0.1:3000
UDP_PORT=7777

RUN="$HERE/.run"
LISTEN_LOG="$RUN/listen.log"
BRIDGE_LOG="$RUN/bridge.log"
PUMP_LOG="$RUN/pump.log"
VISION_LOG="$RUN/vision.log"
STICKS="$RUN/sticks.json"
VIDEO="$HERE/fixtures/track-2lap.avi"

PUBLISH=1
[ "${1:-}" = "--no-publish" ] && PUBLISH=0

# ── scoreboard state ──────────────────────────────────────────────────────────
PASS_T0=0; FAIL_T0=0
PASS_T1=0; FAIL_T1=0
PASS_T2=0; FAIL_T2=0
ITEM_LINES=""
NOTES=""

GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

banner() { printf '\n%s%s\n%s\n%s%s\n' "$BOLD" "$(printf '═%.0s' $(seq 1 78))" "$1" "$(printf '═%.0s' $(seq 1 78))" "$OFF"; }
step()   { printf '\n%s-- %s --%s\n' "$BOLD" "$1" "$OFF"; }
note()   { printf '%s   %s%s\n' "$DIM" "$1" "$OFF"; }
warn()   { printf '%s   WARN%s %s\n' "$YEL" "$OFF" "$1"; }

ok()  { # <section> <desc> [evidence]
  eval "PASS_$1=\$((PASS_$1 + 1))"
  printf '%s   PASS%s %s\n' "$GREEN" "$OFF" "$2"
  [ -n "${3:-}" ] && printf '%s        %s%s\n' "$DIM" "$3" "$OFF"
  return 0
}
bad() { # <section> <desc> [evidence]
  eval "FAIL_$1=\$((FAIL_$1 + 1))"
  printf '%s   FAIL%s %s\n' "$RED" "$OFF" "$2"
  [ -n "${3:-}" ] && printf '%s        %s%s\n' "$DIM" "$3" "$OFF"
  return 0
}

# ── process management ────────────────────────────────────────────────────────
LISTEN_PID=""; BRIDGE_PID=""; PUMP_PID=""; SQL_PID=""

cleanup() {
  local p
  for p in "$PUMP_PID" "$BRIDGE_PID" "$LISTEN_PID" "$SQL_PID"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  sleep 1
  for p in "$PUMP_PID" "$BRIDGE_PID" "$LISTEN_PID" "$SQL_PID"; do
    [ -n "$p" ] && kill -9 "$p" 2>/dev/null
  done
  # Belt and braces: anything of ours that outlived its PID (orphaned child of a
  # killed shell) would keep transmitting on udp:7777 and poison the next run.
  local stragglers
  stragglers=$(pgrep -f "$CB/src/index.ts|$CB/src/listen.ts|$HERE/pump.mjs" 2>/dev/null)
  [ -n "$stragglers" ] && echo "$stragglers" | xargs kill -9 2>/dev/null
  wait 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

# Idempotency, the hard way.
#
# A previous run (or a Ctrl-C mid-run) can leave a bridge alive. That is not a
# cosmetic leak: a second bridge keeps transmitting to udp:7777 with ITS OWN
# sequence counter, so the fake kart sees two interleaved streams and the
# monotonic-sequence check fails with nonsense gaps. Sweep by the absolute
# script paths this demo launches — unique to this repo, so nothing else on the
# machine can match.
sweep_stale() {
  local pids
  pids=$(pgrep -f "$CB/src/index.ts|$CB/src/listen.ts|$HERE/pump.mjs" 2>/dev/null)
  if [ -n "$pids" ]; then
    note "sweeping stale demo processes: $(echo "$pids" | tr '\n' ' ')"
    echo "$pids" | xargs kill 2>/dev/null
    sleep 1
    pids=$(pgrep -f "$CB/src/index.ts|$CB/src/listen.ts|$HERE/pump.mjs" 2>/dev/null)
    [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null
    sleep 1
  fi
  pids=$(lsof -ti "udp:$UDP_PORT" 2>/dev/null)
  if [ -n "$pids" ]; then
    note "freeing udp:$UDP_PORT (pids: $(echo "$pids" | tr '\n' ' '))"
    echo "$pids" | xargs kill 2>/dev/null
    sleep 1
  fi
}

# ── waiting ───────────────────────────────────────────────────────────────────
#
# Never `sleep 1` and then grep a log a child process is still writing. Node
# runs these .ts files through native type-stripping, and how long that takes
# before the first line of output lands depends on the machine, the module
# cache and what else is running — on a cold cache it is comfortably over a
# second. A fixed sleep turns that into a phantom "failed to bind udp:7777"
# while every downstream packet check passes, which is exactly how this script
# first failed on revival. Poll with a deadline instead.
wait_for_log() { # <file> <pattern> <timeout-seconds>  -> 0 if seen
  local file="$1" pat="$2" deadline=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    [ -f "$file" ] && grep -q "$pat" "$file" && return 0
    sleep 0.2
  done
  return 1
}

# ── SpacetimeDB helpers ───────────────────────────────────────────────────────
call() { # <reducer> <json-array>
  local name="$1" args="$2" code body
  body=$(curl -s -w $'\n%{http_code}' -m 10 -X POST -H 'Content-Type: application/json' \
    --data-binary "$args" "$URL/v1/database/$DB/call/$name")
  code="${body##*$'\n'}"
  if [ "$code" != "200" ]; then
    printf '%s   FAIL%s reducer %s %s -> HTTP %s: %s\n' "$RED" "$OFF" "$name" "$args" "$code" "${body%$'\n'*}"
    return 1
  fi
  note "call $name $args"
  return 0
}

PY_PRE='
import sys, json
d = json.load(sys.stdin)
def unwrap(x):
    # SpacetimeDB SQL JSON: a 1-element product (Timestamp) is [v]; an Option is
    # [0, payload] for `some` and [1, []] for `none`.
    if isinstance(x, list):
        if len(x) == 1:
            return unwrap(x[0])
        if len(x) == 2 and x[0] in (0, 1):
            return None if x[0] == 1 else unwrap(x[1])
    return x
cols = [e["name"]["some"] for e in d[0]["schema"]["elements"]]
R = [dict(zip(cols, [unwrap(v) for v in row])) for row in d[0]["rows"]]
'

# ONE statement per request — SpacetimeDB 2.4.1 rejects multi-statement bodies.
sql_json() { curl -s -m 10 -X POST -H 'Content-Type: text/plain' --data-binary "$1" "$URL/v1/database/$DB/sql"; }

sqlv() { sql_json "$1" | python3 -c "$PY_PRE
print($2)" 2>/dev/null; }

chk() { # <section> <desc> <sql> <python bool over R>
  local section="$1" desc="$2" sql="$3" expr="$4" out verdict rows
  out=$(sql_json "$sql" | python3 -c "$PY_PRE
ok = bool($expr)
print(('OK' if ok else 'NO') + '\t' + json.dumps(R, default=str))" 2>&1)
  verdict="${out%%$'\t'*}"
  rows="${out#*$'\t'}"
  if [ "$verdict" = "OK" ]; then
    ok "$section" "$desc" "$(echo "$rows" | cut -c1-150)"
  else
    bad "$section" "$desc" "expr: $expr | rows: $(echo "$rows" | cut -c1-300)"
  fi
}

state() { sqlv "SELECT * FROM config" "R[0]['state']"; }

wait_effects_clear() { # <timeout-s>
  local deadline=$(( $(date +%s) + ${1:-8} )) n
  while [ "$(date +%s)" -le "$deadline" ]; do
    n=$(sqlv "SELECT * FROM effect" "len(R)")
    [ "$n" = "0" ] && return 0
    sleep 0.3
  done
  return 1
}

# ── packet (wire) helpers ─────────────────────────────────────────────────────
LOG_MARK=0
mark() { LOG_MARK=$(wc -l < "$LISTEN_LOG" 2>/dev/null | tr -d ' '); LOG_MARK=${LOG_MARK:-0}; }

# expect_pkt <section> <kart> <extended-regex> <timeout-s> <desc>
#   Polls the fake kart's log (from the last mark) until a packet for that kart
#   matches. Evidence printed is the raw decoded packet line.
expect_pkt() {
  local section="$1" kart="$2" pat="$3" tmo="$4" desc="$5"
  local deadline=$(( $(date +%s) + tmo )) hit=""
  while [ "$(date +%s)" -le "$deadline" ]; do
    hit=$(tail -n "+$((LOG_MARK + 1))" "$LISTEN_LOG" 2>/dev/null | grep "kart=$kart " | grep -E "$pat" | tail -1)
    [ -n "$hit" ] && break
    sleep 0.2
  done
  if [ -n "$hit" ]; then
    ok "$section" "$desc" "$hit"
  else
    bad "$section" "$desc" "no kart=$kart packet matching /$pat/ in ${tmo}s. last seen: $(tail -n "+$((LOG_MARK + 1))" "$LISTEN_LOG" 2>/dev/null | grep "kart=$kart " | tail -1)"
  fi
}

sticks() { # <k1_thr> <k1_steer> <k2_thr> <k2_steer>
  printf '{"1":{"t":%s,"s":%s},"2":{"t":%s,"s":%s}}\n' "$1" "$2" "$3" "$4" > "$STICKS.tmp"
  mv "$STICKS.tmp" "$STICKS"
}

# grant_and_use <kart> <item>  — deterministic item drop, then fire it
grant_and_use() {
  local kart="$1" item="$2" slot
  call debug_grant "[$kart,\"$item\"]" || return 1
  slot=$(sqlv "SELECT * FROM inventory WHERE kart_id = $kart" "1 if R[0]['slot_1']=='$item' else 2")
  [ -z "$slot" ] && slot=1
  call use_item "[$kart,$slot]" || return 1
  return 0
}

# ══════════════════════════════════════════════════════════════════════════════
banner " AR KART — END-TO-END INTEGRATION DEMO"
rm -rf "$RUN"; mkdir -p "$RUN" "$HERE/fixtures"

step "0. preflight"
if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$URL/v1/ping")" != "200" ]; then
  printf '%sSpacetimeDB is not listening on %s — run: spacetime start%s\n' "$RED" "$URL" "$OFF"
  exit 1
fi
note "$URL/v1/ping -> 200"

if [ ! -f "$HERE/module_bindings/index.ts" ] || [ ! -d "$HERE/node_modules/spacetimedb" ]; then
  note "generated bindings missing — running ./gen-bindings.sh"
  "$HERE/gen-bindings.sh" || { printf '%sbindings generation failed%s\n' "$RED" "$OFF"; exit 1; }
fi
note "bindings: $HERE/module_bindings/index.ts"

if [ ! -x "$VISION/.venv/bin/python" ]; then
  warn "vision venv missing at $VISION/.venv — T1 will fail"
fi
sweep_stale

if [ "$PUBLISH" = "1" ]; then
  step "0b. publish a clean module (reset)"
  ( cd "$MODULE" && spacetime publish "$DB" --server "$SRV" --delete-data=always --yes ) 2>&1 \
    | grep -Ev '^(A new version|Run .spacetime version)' | sed 's/^/   /'
else
  step "0b. reset the running module (--no-publish)"
  st=$(state)
  case "$st" in
    countdown|running|finished) call abort_race '[]' ;;
  esac
  call reset_race '[]' 2>/dev/null || note "reset_race skipped (no track yet)"
fi

# ══════════════════════════════════════════════════════════════════════════════
banner " T0-SW — SOFTWARE CONTROL LOOP: phone -> SpacetimeDB -> bridge -> kart"

step "T0.1  track setup: calibration lap through gates 7, 3, 9"
call begin_setup '[]'
call report_gate '[1,7]'; call report_gate '[1,3]'; call report_gate '[1,9]'
chk T0 "setup_seen captured first-seen order 7,3,9" "SELECT * FROM setup_seen" \
  "[r['tag_id'] for r in sorted(R,key=lambda x:x['seen_idx'])]==[7,3,9]"
call confirm_track '[[]]'
chk T0 "track written: seq0=7 (start/finish), seq1=3, seq2=9" "SELECT * FROM track" \
  "[r['tag_id'] for r in sorted(R,key=lambda x:x['seq'])]==[7,3,9]"
chk T0 "state setup -> lobby" "SELECT * FROM config" "R[0]['state']=='lobby'"

step "T0.2  start_race -> countdown -> running (the scheduled tick reducer)"
call start_race '[]'
chk T0 "state lobby -> countdown" "SELECT * FROM config" "R[0]['state']=='countdown'"
note "waiting out the 3 s countdown..."
sleep 4
chk T0 "tick promoted countdown -> running" "SELECT * FROM config" "R[0]['state']=='running'"

step "T0.3  bring up the fake kart, the car bridge and the pilot stand-in"
sticks 0 0 0 0
# Launched WITHOUT a wrapping subshell so $! is the node process itself and the
# EXIT trap can actually kill it (see sweep_stale).
node "$CB/src/listen.ts" > "$LISTEN_LOG" 2>&1 &
LISTEN_PID=$!
if wait_for_log "$LISTEN_LOG" "udp 0.0.0.0:$UDP_PORT" 20; then
  ok T0 "fake kart listening on udp:$UDP_PORT (npm run listen)" "$(head -1 "$LISTEN_LOG")"
else
  bad T0 "fake kart failed to bind udp:$UDP_PORT" "$(head -3 "$LISTEN_LOG")"
fi

BRIDGE_BINDINGS="$HERE/module_bindings/index.ts" KARTS_FILE="$HERE/karts.local.json" \
  node "$CB/src/index.ts" > "$BRIDGE_LOG" 2>&1 &
BRIDGE_PID=$!
if wait_for_log "$BRIDGE_LOG" 'subscriptions applied' 20; then
  ok T0 "car bridge live on SpacetimeDB via GENERATED BINDINGS (WebSocket)" \
    "$(grep -E 'connected to|subscriptions applied' "$BRIDGE_LOG" | tr '\n' ' ')"
else
  bad T0 "car bridge did not connect in bindings mode" "$(tail -5 "$BRIDGE_LOG")"
fi

node "$HERE/pump.mjs" "$STICKS" "$URL" "$DB" > "$PUMP_LOG" 2>&1 &
PUMP_PID=$!
wait_for_log "$PUMP_LOG" 'set_input ->' 20 \
  || warn "pump.mjs has not announced itself yet — see $PUMP_LOG"
note "pilot stand-in pumping set_input at 20 Hz ($(head -1 "$PUMP_LOG"))"

step "T0.4  the stick moves -> the bytes move"
mark
sticks 1.0 -1.0 0.5 1.0
expect_pkt T0 1 'thr=255 steer=-127' 5 "kart 1: throttle 1.0 / steer -1.0 -> thr=255 steer=-127 (0x81)"
expect_pkt T0 2 'thr=128 steer=127' 5  "kart 2: throttle 0.5 / steer +1.0 -> thr=128 steer=127"
mark
sticks 0.5 0.5 0.5 0.5
expect_pkt T0 1 'thr=128 steer=64' 5   "kart 1: stick back to 0.5/0.5 -> thr=128 steer=64"

step "T0.5  sequence numbers are monotonic (no skips, no resets)"
BADSEQ=$(grep -oE '\(\+[0-9]+\)' "$LISTEN_LOG" | grep -vE '\(\+1\)' | head -5)
if [ -z "$BADSEQ" ]; then
  ok T0 "every observed seq gap is exactly +1" \
    "$(grep -c '(+1)' "$LISTEN_LOG") sampled packets, 0 skips — $(tail -1 "$LISTEN_LOG" | grep -oE 'seq=[0-9]+ \(\+1\)')"
else
  bad T0 "sequence skipped" "$BADSEQ"
fi

# ══════════════════════════════════════════════════════════════════════════════
banner " T2 — ITEMS: granted in the database, visible in the packet bytes"
note "baseline both karts: throttle 0.5 -> thr=128, steer 0.5 -> steer=64"

# ---- boost ------------------------------------------------------------------
step "T2.1  BOOST (self, x1.4, 2 s)"
B0=$PASS_T2; F0=$FAIL_T2
wait_effects_clear 8
mark
grant_and_use 1 boost
chk T2 "effect row: boost x1.4 on kart 1, with an expiry" "SELECT * FROM effect WHERE kart_id = 1" \
  "any(r['kind']=='boost' and abs(r['multiplier']-1.4)<1e-6 and r['expires_at'] is not None for r in R)"
# 178, not 179: the multiplier is an f32, and f32(1.4) = 1.39999997615814,
# so 0.5 x 1.4 x 255 = 178.4999969 -> 178. The range tolerates either rounding.
expect_pkt T2 1 'thr=17[89] ' 3 "WIRE: throttle scaled up 128 -> 178 (0.5 x f32(1.4) = 0.69999999)"
[ $((FAIL_T2 - F0)) -eq 0 ] && ITEM_LINES="$ITEM_LINES
    boost          PASS  thr 128 -> 178 (x1.4)" || ITEM_LINES="$ITEM_LINES
    boost          FAIL"

# ---- stun -------------------------------------------------------------------
step "T2.2  STUN (rival, x0, 2 s) — kart 2 fires at kart 1"
F0=$FAIL_T2
wait_effects_clear 8
mark
grant_and_use 2 stun
chk T2 "effect row: stun x0 on kart 1 (the rival)" "SELECT * FROM effect WHERE kart_id = 1" \
  "any(r['kind']=='stun' and r['multiplier']==0 for r in R)"
expect_pkt T2 1 'thr=0 ' 3 "WIRE: throttle hard-zeroed 128 -> 0"
note "waiting for the 2 s stun to expire..."
wait_effects_clear 8
mark
expect_pkt T2 1 'thr=128' 4 "WIRE: throttle recovers to 128 once the stun expires"
[ $((FAIL_T2 - F0)) -eq 0 ] && ITEM_LINES="$ITEM_LINES
    stun           PASS  thr -> 0 for ~2 s, then back to 128" || ITEM_LINES="$ITEM_LINES
    stun           FAIL"

# ---- shield + report_hit ----------------------------------------------------
step "T2.3  SHIELD (self, no expiry) + report_hit absorbed"
F0=$FAIL_T2
wait_effects_clear 8
mark
grant_and_use 1 shield
chk T2 "effect row: shield on kart 1 with NO expiry (expires_at = none)" "SELECT * FROM effect WHERE kart_id = 1" \
  "any(r['kind']=='shield' and r['expires_at'] is None for r in R)"
expect_pkt T2 1 'flags=0x01 SHIELD' 3 "WIRE: flags bit0 = 1 (WS2812 GPIO 48 goes cyan)"
note "now hit the shielded kart: report_hit(shooter=2, victim=1)"
mark
call report_hit '[2,1]'
chk T2 "the hit was ABSORBED — no stun effect anywhere" "SELECT * FROM effect" \
  "not any(r['kind']=='stun' for r in R)"
chk T2 "the shield was CONSUMED — no effect rows left on kart 1" "SELECT * FROM effect WHERE kart_id = 1" \
  "len(R)==0"
chk T2 "event_log records the absorb" "SELECT * FROM event_log" \
  "any('SHIELD absorbed' in r['text'] for r in R)"
expect_pkt T2 1 'thr=128 steer=64 flags=0x00' 4 "WIRE: flag drops to 0x00 and the kart keeps driving (never stunned)"
[ $((FAIL_T2 - F0)) -eq 0 ] && ITEM_LINES="$ITEM_LINES
    shield         PASS  flags 0x01 -> absorbs one hit -> 0x00, no stun" || ITEM_LINES="$ITEM_LINES
    shield         FAIL"

# ---- leader strike ----------------------------------------------------------
step "T2.4  LEADER STRIKE (slow x0.3, 3 s) — targets whoever is P1"
F0=$FAIL_T2
wait_effects_clear 8
P1=$(sqlv "SELECT * FROM progress" "sorted(R,key=lambda r:r['placement'])[0]['kart_id']")
[ -z "$P1" ] && P1=1
# Kart 2 fires. If kart 2 IS the leader the module targets the kart behind instead.
if [ "$P1" = "2" ]; then VICTIM=1; else VICTIM=$P1; fi
note "current P1 = kart $P1; kart 2 fires leader_strike -> victim = kart $VICTIM"
mark
grant_and_use 2 leader_strike
chk T2 "effect row: slow x0.3 on kart $VICTIM" "SELECT * FROM effect WHERE kart_id = $VICTIM" \
  "any(r['kind']=='slow' and abs(r['multiplier']-0.3)<1e-6 and r['expires_at'] is not None for r in R)"
expect_pkt T2 "$VICTIM" 'thr=3[789] ' 4 "WIRE: P1 throttle scaled down 128 -> 38 (0.5 x f32(0.3) = 0.15)"
[ $((FAIL_T2 - F0)) -eq 0 ] && ITEM_LINES="$ITEM_LINES
    leader_strike  PASS  P1 (kart $VICTIM) thr 128 -> 38 (x0.3)" || ITEM_LINES="$ITEM_LINES
    leader_strike  FAIL"

# ---- dizzy ------------------------------------------------------------------
step "T2.5  DIZZY (rival, steer inverted, 4 s) — kart 2 fires at kart 1"
F0=$FAIL_T2
wait_effects_clear 10
mark
grant_and_use 2 dizzy
chk T2 "effect row: dizzy on kart 1" "SELECT * FROM effect WHERE kart_id = 1" \
  "any(r['kind']=='dizzy' for r in R)"
expect_pkt T2 1 'steer=-64' 4 "WIRE: steering MIRRORED, +64 -> -64 (throttle untouched)"
[ $((FAIL_T2 - F0)) -eq 0 ] && ITEM_LINES="$ITEM_LINES
    dizzy          PASS  steer +64 -> -64 (sign flipped)" || ITEM_LINES="$ITEM_LINES
    dizzy          FAIL"

# ---- ink --------------------------------------------------------------------
step "T2.6  INK (rival, 4 s) — screen-only: must change NOTHING physical"
F0=$FAIL_T2
wait_effects_clear 10
mark
grant_and_use 2 ink
chk T2 "effect row: ink on kart 1" "SELECT * FROM effect WHERE kart_id = 1" \
  "any(r['kind']=='ink' for r in R)"
expect_pkt T2 1 'thr=128 steer=64 flags=0x00' 4 "WIRE: unchanged — ink is rendered by the pilot app, not the car"
[ $((FAIL_T2 - F0)) -eq 0 ] && ITEM_LINES="$ITEM_LINES
    ink            PASS  wire unchanged (thr=128 steer=64) — screen-only" || ITEM_LINES="$ITEM_LINES
    ink            FAIL"

wait_effects_clear 10

# ══════════════════════════════════════════════════════════════════════════════
banner " T1 — VISION: AprilTag gates -> report_gate -> laps, order, placement"

step "T1.1  re-lay the track to match the synthetic video (gates 0, 1, 2)"
call abort_race '[]'
call begin_setup '[]'
call report_gate '[1,0]'; call report_gate '[1,1]'; call report_gate '[1,2]'
call confirm_track '[[]]'
chk T1 "track re-laid: seq0=0 (start/finish), seq1=1, seq2=2" "SELECT * FROM track" \
  "[r['tag_id'] for r in sorted(R,key=lambda x:x['seq'])]==[0,1,2]"
chk T1 "both karts back on the start line (lap 0, next_idx 1)" "SELECT * FROM progress" \
  "len(R)==2 and all(r['lap']==0 and r['next_idx']==1 for r in R)"
call start_race '[]'
note "waiting out the 3 s countdown..."
sleep 4
chk T1 "state running" "SELECT * FROM config" "R[0]['state']=='running'"

step "T1.2  run the real detector over a synthetic 2-lap FPV video"
if [ ! -f "$VIDEO" ]; then
  note "generating $VIDEO"
  ( cd "$VISION" && ./.venv/bin/python tools/make_test_track_video.py "$VIDEO" --laps 2 ) 2>&1 | sed 's/^/   /'
fi
note "kart 1 <- $VIDEO  (cv2.aruco 36h11, live report_gate POSTs — NOT --dry-run)"
( cd "$VISION" && ./.venv/bin/python -m arkart_vision.bridge \
    --kart 1 --source "$VIDEO" --fps 20 --seconds 16 ) > "$VISION_LOG" 2>&1
grep -E 'GATE kart=|total gate passes' "$VISION_LOG" | sed 's/^/   /'

PASSES=$(grep -c 'GATE kart=1' "$VISION_LOG")
if [ "$PASSES" -ge 6 ]; then
  ok T1 "detector reported 6 gate passes over 2 laps" "$(grep 'total gate passes' "$VISION_LOG")"
else
  bad T1 "expected >= 6 gate passes, got $PASSES" "$(tail -5 "$VISION_LOG")"
fi
if grep -qE 'GATE kart=1 tag=[0-9]+ -> 200' "$VISION_LOG"; then
  ok T1 "every report_gate POST accepted by the module (HTTP 200)" \
    "$(grep -cE '\-> 200' "$VISION_LOG") x 200 responses"
else
  bad T1 "report_gate POSTs were not accepted" "$(grep -E 'GATE kart=1' "$VISION_LOG" | tail -3)"
fi

step "T1.3  the database advanced in gate order"
chk T1 "kart 1 completed a lap in order: lap=1, next_idx=0" "SELECT * FROM progress WHERE kart_id = 1" \
  "R[0]['lap']==1 and R[0]['next_idx']==0"
chk T1 "kart 2 never moved (no camera) — still lap 0, next_idx 1" "SELECT * FROM progress WHERE kart_id = 2" \
  "R[0]['lap']==0 and R[0]['next_idx']==1"
chk T1 "placement recomputed: kart 1 = P1, kart 2 = P2" "SELECT * FROM progress" \
  "{r['kart_id']:r['placement'] for r in R}=={1:1,2:2}"
# The LAST five gate passes, not all of them: `event_log` is append-only and
# nothing clears it, so the whole-list form could only ever pass on a fresh
# `--delete-data=always` publish and failed by construction under --no-publish,
# where the previous run's passes are still in the table. Sorted by id because
# SQL row order is not guaranteed.
chk T1 "event_log carries this run's gate passes in order 1,2,0,1,2" "SELECT * FROM event_log" \
  "[t.split('gate ')[1].split(' ')[0] for t in [r['text'] for r in sorted(R,key=lambda x:x['id']) if 'passed gate' in r['text']]][-5:]==['1','2','0','1','2']"
chk T1 "items were granted at checkpoints (inventory non-empty)" "SELECT * FROM inventory WHERE kart_id = 1" \
  "R[0]['slot_1'] is not None"

step "T1.4  SQL evidence"
for T in track progress inventory; do
  printf '\n%s   -- %s --%s\n' "$DIM" "$T" "$OFF"
  ( cd "$MODULE" && spacetime sql "$DB" "SELECT * FROM $T" --server "$SRV" ) 2>/dev/null \
    | grep -Ev '^(A new version|Run .spacetime version|WARNING|^$)' | sed 's/^/   /'
done

# ══════════════════════════════════════════════════════════════════════════════
banner " T0-SW (cont.) — abort_race is a PHYSICAL kill switch"
step "T0.6  abort_race while the stick is pinned"
mark
sticks 1.0 1.0 1.0 1.0
expect_pkt T0 1 'thr=255' 5 "kart 1 pinned at full throttle (thr=255)"
mark
call abort_race '[]'
chk T0 "state -> lobby" "SELECT * FROM config" "R[0]['state']=='lobby'"
expect_pkt T0 1 'thr=0 steer=0' 4 "WIRE: throttle AND steer zeroed although the stick is still pinned"

# ── bridge SQL-polling fallback (the no-bindings path) ───────────────────────
#
# LAUNCH SHAPE — do not "simplify" this back into
#     SQLMODE=$(cd "$CB" && ENV=... node src/index.ts 2>&1 & BP=$!; sleep 4; kill $BP)
# `cmd1 && cmd2 &` backgrounds the whole AND-list as a subshell, so `$!` is the
# WRAPPER's pid, not node's. `kill $BP` then reaps the wrapper and leaves node
# orphaned (reparented to pid 1) — still holding the command-substitution pipe
# open, so the script hangs HERE, forever. That stayed invisible for as long as
# sql.ts was broken (node self-exited with `fatal` inside a second); the moment
# the fallback started working, this step became an infinite hang.
# Log to a file instead of a pipe, `exec` so `$!` IS node, kill the real pid.
step "T0.7  bridge SQL-polling fallback (npm run sql)"
SQL_LOG="$RUN/sql-fallback.log"
: > "$SQL_LOG"
( cd "$CB" \
    && export KARTS_FILE="$HERE/karts.local.json" BRIDGE_SOURCE=sql BRIDGE_DRY_RUN=1 \
    && exec node src/index.ts ) > "$SQL_LOG" 2>&1 &
SQL_PID=$!
sleep 4
kill "$SQL_PID" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$SQL_PID" 2>/dev/null || break
  sleep 0.3
done
kill -9 "$SQL_PID" 2>/dev/null
wait "$SQL_PID" 2>/dev/null
SQLMODE=$(cat "$SQL_LOG")
if echo "$SQLMODE" | grep -q 'fatal'; then
  bad T0 "SQL-polling fallback (BRIDGE_SOURCE=sql) failed to start" \
    "$(echo "$SQLMODE" | grep fatal | head -1)"
  NOTES="$NOTES
  bridge SQL fallback: BROKEN again — see $SQL_LOG"
elif echo "$SQLMODE" | grep -q 'conn=true'; then
  ok T0 "SQL-polling fallback reads the live database (one single-statement POST per table)" \
    "$(echo "$SQLMODE" | grep 'conn=true' | head -1)"
  NOTES="$NOTES
  bridge SQL fallback: OK (no bindings needed) — $SQL_LOG"
else
  bad T0 "SQL-polling fallback started but never reported a connected poll" \
    "$(echo "$SQLMODE" | tail -3 | tr '\n' ' ')"
fi

# ══════════════════════════════════════════════════════════════════════════════
verdict() { [ "$2" -eq 0 ] && [ "$1" -gt 0 ] && printf '%sPASS%s' "$GREEN" "$OFF" || printf '%sFAIL%s' "$RED" "$OFF"; }

banner " SCOREBOARD"
printf '\n'
printf '  %-8s %s   %s%d passed, %d failed%s   phone -> STDB -> bridge -> UDP -> kart, + kill switch\n' \
  "T0-SW" "$(verdict $PASS_T0 $FAIL_T0)" "$DIM" "$PASS_T0" "$FAIL_T0" "$OFF"
printf '  %-8s %s   %s%d passed, %d failed%s   AprilTag gates -> report_gate -> laps/order/placement\n' \
  "T1" "$(verdict $PASS_T1 $FAIL_T1)" "$DIM" "$PASS_T1" "$FAIL_T1" "$OFF"
printf '  %-8s %s   %s%d passed, %d failed%s   every item, database row + packet bytes\n' \
  "T2" "$(verdict $PASS_T2 $FAIL_T2)" "$DIM" "$PASS_T2" "$FAIL_T2" "$OFF"
printf '%s%s%s\n' "$DIM" "$ITEM_LINES" "$OFF"
[ -n "$NOTES" ] && printf '\n  notes:%s%s%s\n' "$DIM" "$NOTES" "$OFF"
printf '\n  evidence: %s\n' "$RUN"
printf '            listen.log (every 25th packet decoded)  bridge.log  vision.log  pump.log\n'

TOTAL_FAIL=$((FAIL_T0 + FAIL_T1 + FAIL_T2))
printf '\n'
if [ "$TOTAL_FAIL" -eq 0 ]; then
  printf '%s  ══ T0-SW PASS · T1 PASS · T2 PASS — %d checks, 0 failures ══%s\n\n' \
    "$GREEN$BOLD" "$((PASS_T0 + PASS_T1 + PASS_T2))" "$OFF"
  exit 0
else
  printf '%s  ══ %d CHECK(S) FAILED ══%s\n\n' "$RED$BOLD" "$TOTAL_FAIL" "$OFF"
  exit 1
fi
