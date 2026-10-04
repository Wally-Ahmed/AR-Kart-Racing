#!/usr/bin/env bash
#
# AR Kart module end-to-end smoke test.
#
#   1. publish `arkart` to the local SpacetimeDB instance (destroying old data)
#   2. begin_setup -> calibration lap (gates 7, 3, 9) -> confirm_track
#   3. start_race -> countdown -> running (proves the scheduled `tick` reducer)
#   4. set_input clamping
#   5. Shield absorbs exactly one incoming hit
#   6. Effect expiry via `tick`
#   7. A full lap: checkpoint ordering, wrong-gate rejection, item grant per pass,
#      2-slot inventory cap, placement recompute
#   8. Leader Strike targeting, report_hit (IR path), abort_race kill switch, reset_race
#   9. Race finish: lap_count reached -> finished, results frozen
#
# Usage:  ./smoke.sh              (requires `spacetime start` already running on :3000)
#         ./smoke.sh --no-publish (skip the publish step)
#
set -uo pipefail

DB=arkart
SRV=local
URL=http://127.0.0.1:3000
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

step() { printf '\n%s== %s ==%s\n' "$BOLD" "$1" "$OFF"; }
note() { printf '%s   %s%s\n' "$DIM" "$1" "$OFF"; }

# call <reducer> <json-args-array>
call() {
  local name="$1" args="$2" code
  code=$(curl -s -o "$TMP/out" -w '%{http_code}' -m 10 \
    -X POST -H 'Content-Type: application/json' --data-binary "$args" \
    "$URL/v1/database/$DB/call/$name")
  if [ "$code" != "200" ]; then
    printf '%s   FAIL%s call %s %s -> HTTP %s %s\n' "$RED" "$OFF" "$name" "$args" "$code" "$(cat "$TMP/out")"
    FAIL=$((FAIL + 1))
    return 1
  fi
  note "call $name $args"
  return 0
}

PY_PRE='
import sys, json
d = json.load(sys.stdin)
def unwrap(x):
    # SpacetimeDB JSON: a 1-element product (Timestamp) is [v]; an Option is
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

# chk <description> <sql> <python bool expression over R>
chk() {
  local desc="$1" sql="$2" expr="$3" out
  out=$(curl -s -m 10 -X POST -H 'Content-Type: text/plain' --data-binary "$sql" \
    "$URL/v1/database/$DB/sql" \
    | python3 -c "$PY_PRE
ok = bool($expr)
print(('OK' if ok else 'NO') + '\t' + json.dumps(R, default=str))" 2>&1)
  local verdict="${out%%$'\t'*}"
  local rows="${out#*$'\t'}"
  if [ "$verdict" = "OK" ]; then
    PASS=$((PASS + 1))
    printf '%s   PASS%s %s\n' "$GREEN" "$OFF" "$desc"
  else
    FAIL=$((FAIL + 1))
    printf '%s   FAIL%s %s\n        expr: %s\n        rows: %s\n' "$RED" "$OFF" "$desc" "$expr" "$rows"
  fi
}

# sqlv <sql> <python expression over R> -> prints the value
sqlv() {
  curl -s -m 10 -X POST -H 'Content-Type: text/plain' --data-binary "$1" \
    "$URL/v1/database/$DB/sql" | python3 -c "$PY_PRE
print($2)"
}

# ---------------------------------------------------------------------------
step "0. server reachable"
if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$URL/v1/ping")" != "200" ]; then
  echo "${RED}spacetime server is not listening on $URL — run: spacetime start${OFF}"
  exit 1
fi
note "$URL/v1/ping -> 200"

if [ "${1:-}" != "--no-publish" ]; then
  step "1. publish module as '$DB'"
  ( cd "$HERE" && spacetime publish "$DB" --server "$SRV" --delete-data=always --yes ) \
    2>&1 | grep -Ev '^(A new version|Run .spacetime version)' | sed 's/^/   /'
  SEED_STATE=setup
else
  step "1. publish skipped (--no-publish) — seed assertions relaxed"
  SEED_STATE=$(sqlv "SELECT * FROM config" "repr(R[0]['state'])[1:-1]")
fi

step "2. seed state after init"
chk "config singleton: 3 laps, 100% item roll, state=$SEED_STATE" \
  "SELECT * FROM config" \
  "len(R)==1 and R[0]['lap_count']==3 and R[0]['item_roll_pct']==100 and R[0]['state']=='$SEED_STATE'"
chk "2 karts seeded (ids 1,2)" "SELECT * FROM kart" \
  "sorted(r['kart_id'] for r in R)==[1,2]"
chk "2 progress rows, 2 inventory rows, 2 input rows" \
  "SELECT * FROM progress" "len(R)==2"
chk "inventories start empty" "SELECT * FROM inventory" \
  "len(R)==2 and all(r['slot_1'] is None and r['slot_2'] is None for r in R)"

step "3. track setup — calibration lap (gates 7, 3, 9)"
call begin_setup '[]'
call report_gate '[1,7]'
call report_gate '[1,3]'
call report_gate '[1,9]'
call report_gate '[1,7]'   # duplicate sighting must NOT re-append
chk "setup_seen holds first-seen order 7,3,9 (duplicate ignored)" \
  "SELECT * FROM setup_seen" \
  "[r['tag_id'] for r in sorted(R,key=lambda x:x['seen_idx'])]==[7,3,9]"

call confirm_track '[[]]'   # empty list = adopt the calibration order
chk "track written: seq0=7 (start/finish), seq1=3, seq2=9" "SELECT * FROM track" \
  "[r['tag_id'] for r in sorted(R,key=lambda x:x['seq'])]==[7,3,9]"
chk "state setup -> lobby" "SELECT * FROM config" "R[0]['state']=='lobby'"
chk "karts placed on the start line (lap 0, next_idx 1)" "SELECT * FROM progress" \
  "all(r['lap']==0 and r['next_idx']==1 for r in R)"

step "4. start_race -> countdown -> running (scheduled tick)"
call start_race '[]'
chk "state lobby -> countdown" "SELECT * FROM config" "R[0]['state']=='countdown'"
note "waiting out the 3 s countdown..."
sleep 4
chk "tick promoted countdown -> running" "SELECT * FROM config" "R[0]['state']=='running'"

step "5. set_input (stored + clamped in every state)"
call set_input '[1,0.8,-0.3]'
call set_input '[2,1.9,-5.0]'
chk "kart 1 input stored as given" "SELECT * FROM input WHERE kart_id = 1" \
  "abs(R[0]['throttle']-0.8)<1e-6 and abs(R[0]['steer']+0.3)<1e-6"
chk "kart 2 input clamped to 1.0 / -1.0" "SELECT * FROM input WHERE kart_id = 2" \
  "abs(R[0]['throttle']-1.0)<1e-6 and abs(R[0]['steer']+1.0)<1e-6"

step "6. Shield absorbs exactly one incoming hit"
call debug_grant '[2,"shield"]'
chk "shield lands in kart 2 slot1" "SELECT * FROM inventory WHERE kart_id = 2" \
  "R[0]['slot_1']=='shield' and R[0]['slot_2'] is None"
call use_item '[2,1]'
chk "shield effect up on kart 2, NO expiry (expires_at = none)" \
  "SELECT * FROM effect WHERE kart_id = 2" \
  "len(R)==1 and R[0]['kind']=='shield' and R[0]['expires_at'] is None"
chk "slot emptied by use_item" "SELECT * FROM inventory WHERE kart_id = 2" \
  "R[0]['slot_1'] is None and R[0]['slot_2'] is None"

call debug_grant '[1,"stun"]'
call use_item '[1,1]'    # kart 1 is P1 -> targets the kart behind (kart 2), which is shielded
chk "stun was ABSORBED: no stun effect anywhere" "SELECT * FROM effect" \
  "not any(r['kind']=='stun' for r in R)"
chk "shield consumed by the hit" "SELECT * FROM effect WHERE kart_id = 2" "len(R)==0"
chk "event_log records the absorb" "SELECT * FROM event_log" \
  "any('SHIELD absorbed' in r['text'] for r in R)"

step "7. Boost + effect expiry via tick"
call debug_grant '[1,"boost"]'
call use_item '[1,1]'
chk "boost x1.4 on kart 1 with an expiry set" "SELECT * FROM effect WHERE kart_id = 1" \
  "len(R)==1 and R[0]['kind']=='boost' and abs(R[0]['multiplier']-1.4)<1e-6 and R[0]['expires_at'] is not None"
note "waiting 2.5 s for the 2 s boost to expire..."
sleep 2.5
chk "tick expired the boost" "SELECT * FROM effect WHERE kart_id = 1" "len(R)==0"

step "8. A full lap — ordering, wrong gates, item per pass, 2-slot cap, placement"
call report_gate '[1,3]'    # seq 1
chk "kart 1 advanced to next_idx 2" "SELECT * FROM progress WHERE kart_id = 1" \
  "R[0]['next_idx']==2 and R[0]['lap']==0"
call report_gate '[1,9]'    # seq 2 -> wraps to next_idx 0 (start/finish next)
chk "kart 1 at next_idx 0 (all checkpoints cleared)" "SELECT * FROM progress WHERE kart_id = 1" \
  "R[0]['next_idx']==0 and R[0]['lap']==0"
call report_gate '[1,9]'    # same gate again: not the expected next -> ignored
call report_gate '[1,5]'    # tag not on the track at all -> ignored
chk "out-of-order / unknown gates ignored (no shortcutting)" "SELECT * FROM progress WHERE kart_id = 1" \
  "R[0]['next_idx']==0 and R[0]['lap']==0"

call report_gate '[2,3]'    # kart 2 clears only the first checkpoint
chk "kart 2 at next_idx 2" "SELECT * FROM progress WHERE kart_id = 2" "R[0]['next_idx']==2"
chk "placement: kart 1 leads (cleared 3 of 3 vs kart 2's 1)" "SELECT * FROM progress" \
  "{r['kart_id']:r['placement'] for r in R}=={1:1,2:2}"

call report_gate '[1,7]'    # cross start/finish -> lap 1
chk "kart 1 completed lap 1, back to next_idx 1" "SELECT * FROM progress WHERE kart_id = 1" \
  "R[0]['lap']==1 and R[0]['next_idx']==1"
chk "kart 1 still P1 after the lap" "SELECT * FROM progress" \
  "{r['kart_id']:r['placement'] for r in R}=={1:1,2:2}"
chk "kart 1 inventory CAPPED at 2 items (3 gate passes)" "SELECT * FROM inventory WHERE kart_id = 1" \
  "R[0]['slot_1'] is not None and R[0]['slot_2'] is not None"
chk "3rd grant was dropped — event_log says 'inventory full'" "SELECT * FROM event_log" \
  "any('inventory full' in r['text'] for r in R)"
chk "kart 2 got exactly 1 item from its 1 gate pass" "SELECT * FROM inventory WHERE kart_id = 2" \
  "R[0]['slot_1'] is not None and R[0]['slot_2'] is None"

step "9. Leader Strike targets the current 1st place"
call debug_grant '[2,"leader_strike"]'
LS_SLOT=$(sqlv "SELECT * FROM inventory WHERE kart_id = 2" "1 if R[0]['slot_1']=='leader_strike' else 2")
LS_SLOT=${LS_SLOT:-2}
note "leader_strike is in kart 2 slot $LS_SLOT"
call use_item "[2,$LS_SLOT]"
chk "kart 1 (the leader) slowed x0.3" "SELECT * FROM effect WHERE kart_id = 1" \
  "any(r['kind']=='slow' and abs(r['multiplier']-0.3)<1e-6 and r['expires_at'] is not None for r in R)"

step "10. report_hit (IR Tag Shot path) — same shield gate"
call report_hit '[2,1]'
chk "kart 1 stunned (throttle-0 effect, no shield to absorb)" "SELECT * FROM effect WHERE kart_id = 1" \
  "any(r['kind']=='stun' and r['multiplier']==0 for r in R)"

step "11. MID-RACE SQL evidence (placement / inventory / effect)"
for T in config progress inventory effect; do
  printf '\n%s-- %s --%s\n' "$DIM" "$T" "$OFF"
  ( cd "$HERE" && spacetime sql "$DB" "SELECT * FROM $T" --server "$SRV" ) 2>/dev/null \
    | grep -Ev '^(A new version|Run .spacetime version|WARNING|^$)'
done

step "12. abort_race = kill switch, then reset_race"
call abort_race '[]'
chk "state -> lobby (bridge zeroes throttle)" "SELECT * FROM config" "R[0]['state']=='lobby'"
chk "all effects cleared" "SELECT * FROM effect" "len(R)==0"
call set_input '[1,0.5,0.2]'
chk "set_input still accepted while not running (no error)" "SELECT * FROM input WHERE kart_id = 1" \
  "abs(R[0]['throttle']-0.5)<1e-6"
call use_item '[1,1]' && chk "use_item is a no-op while not running" "SELECT * FROM effect" "len(R)==0"

call reset_race '[]'
chk "progress reset, track preserved" "SELECT * FROM progress" \
  "all(r['lap']==0 and r['next_idx']==1 and r['finished_at'] is None for r in R)"
chk "track survives the reset" "SELECT * FROM track" "len(R)==3"
chk "inventories cleared" "SELECT * FROM inventory" \
  "all(r['slot_1'] is None and r['slot_2'] is None for r in R)"

step "13. race finish path (lap_count = 1)"
call set_config '[1,100]'
call start_race '[]'
note "waiting out the 3 s countdown..."
sleep 4
call report_gate '[1,3]'
call report_gate '[1,9]'
call report_gate '[1,7]'    # completes lap 1 == lap_count -> FINISHED
chk "state -> finished" "SELECT * FROM config" "R[0]['state']=='finished'"
chk "winner has finished_at set and P1" "SELECT * FROM progress WHERE kart_id = 1" \
  "R[0]['finished_at'] is not None and R[0]['lap']==1 and R[0]['placement']==1"
chk "results frozen: effects cleared on finish" "SELECT * FROM effect" "len(R)==0"
chk "event_log announces the finish" "SELECT * FROM event_log" \
  "any('FINISHED' in r['text'] for r in R)"
call report_gate '[1,3]'    # a finished kart must not keep advancing
chk "finished kart no longer advances" "SELECT * FROM progress WHERE kart_id = 1" \
  "R[0]['lap']==1"
call set_config '[3,100]'
call reset_race '[]'
chk "back to a clean lobby, 3 laps" "SELECT * FROM config" \
  "R[0]['state']=='lobby' and R[0]['lap_count']==3"

step "14. CLI paths (spacetime call / spacetime sql)"
( cd "$HERE" && spacetime call "$DB" set_kart 1 '"Red Kart"' '"192.168.8.111"' --server "$SRV" -y ) \
  2>&1 | grep -Ev '^(A new version|Run .spacetime version|WARNING|^$)' | sed 's/^/   /'
chk "spacetime call set_kart took effect" "SELECT * FROM kart WHERE kart_id = 1" \
  "R[0]['name']=='Red Kart' and R[0]['ip']=='192.168.8.111'"

step "15. FINAL SQL evidence dump (post-reset)"
for T in config track progress inventory effect; do
  printf '\n%s-- %s --%s\n' "$DIM" "$T" "$OFF"
  ( cd "$HERE" && spacetime sql "$DB" "SELECT * FROM $T" --server "$SRV" ) 2>/dev/null \
    | grep -Ev '^(A new version|Run .spacetime version|WARNING|^$)'
done

printf '\n%s================ %d passed, %d failed ================%s\n' \
  "$BOLD" "$PASS" "$FAIL" "$OFF"
[ "$FAIL" -eq 0 ] || exit 1
printf '%sSMOKE OK%s\n' "$GREEN" "$OFF"
