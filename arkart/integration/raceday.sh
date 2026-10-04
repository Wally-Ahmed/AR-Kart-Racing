#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════
#  AR Kart — RACE DAY BRING-UP
#  One command, cold start, real hardware.  The venue counterpart to demo.sh.
# ══════════════════════════════════════════════════════════════════════════════
#
#   ./raceday.sh            bring the whole stack up (idempotent — safe to re-run)
#   ./raceday.sh stop       kill everything THIS script started
#   ./raceday.sh status     print the status block without touching anything
#   ./raceday.sh restart    stop, then up
#
# Options (any order, before or after the verb)
#   --fresh         publish with --delete-data=always.  WIPES the race state.
#                   Default is a plain publish: race day KEEPS its track and laps.
#   --no-publish    do not publish at all (fastest restart of the processes only)
#   --no-vision     skip the vision bridge (no cameras / no venv)
#   --no-director   skip the vite server (director + pilot pages)
#   --port N        preferred director port (default 5173; falls forward on collision)
#
# What it brings up
#   1. SpacetimeDB on :3000       — STARTED if absent, REUSED if already up
#   2. module `arkart`            — published to --server local
#   3. car bridge                 — BRIDGE_SOURCE=stdb (live WebSocket subscription,
#                                   generated bindings) against car-bridge/karts.json,
#                                   i.e. the VENUE address book, not the loopback one
#   4. vision bridge              — one detector per kart camera; offline cameras just
#                                   retry forever and never take the stack down
#   5. vite --host                — the director screen AND the phone pilot pages
#
# Hard rules this script obeys
#   * ALWAYS `--server local`.   NEVER `spacetime version upgrade`.  (CLI 2.4.1 matched set.)
#   * A pre-existing SpacetimeDB is adopted, never killed — `stop` leaves it running.
#   * It NEVER binds port 8089, and it never flashes firmware, and it never sudos.
#   * This script does NOT depend on demo.sh.  (But do not run demo.sh while this is
#     up: demo.sh wipes .run/ and runs a second car bridge on the same udp:7777.)
#
set -uo pipefail

# ── layout ────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARKART="$(cd "$HERE/.." && pwd)"
CB="$ARKART/car-bridge"
VISION="$ARKART/vision"
MODULE="$ARKART/module"
DIRECTOR="$ARKART/director"

DB=arkart
SRV=local
URL=http://127.0.0.1:3000
STDB_PORT=3000
FORBIDDEN_PORT=8089          # reserved elsewhere — never bind it

RUN="$HERE/.run"
KARTS_CB="$CB/karts.json"            # VENUE address book (kart_id -> UDP address)
KARTS_VISION="$VISION/karts.json"    # VENUE camera book  (kart_id -> MJPEG stream)

# ── options ───────────────────────────────────────────────────────────────────
ACTION=up
FRESH=0
PUBLISH=1
WANT_VISION=1
WANT_DIRECTOR=1
PORT_PREF=5173

while [ $# -gt 0 ]; do
  case "$1" in
    up|stop|down|status|restart) ACTION="$1" ;;
    --fresh)        FRESH=1 ;;
    --no-publish)   PUBLISH=0 ;;
    --no-vision)    WANT_VISION=0 ;;
    --no-director)  WANT_DIRECTOR=0 ;;
    --port)         PORT_PREF="${2:-5173}"; shift ;;
    -h|--help)      sed -n '2,40p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s  (try --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
[ "$ACTION" = "down" ] && ACTION=stop

# ── cosmetics ─────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'
  CYA=$'\033[36m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=''; RED=''; GRN=''; YEL=''; CYA=''; DIM=''; OFF=''
fi
banner() { printf '\n%s%s%s\n' "$BOLD$CYA" "$1" "$OFF"; }
step()   { printf '\n%s▸ %s%s\n' "$BOLD" "$1" "$OFF"; }
note()   { printf '  %s%s%s\n' "$DIM" "$1" "$OFF"; }
good()   { printf '  %sOK%s   %s\n' "$GRN" "$OFF" "$1"; }
warn()   { printf '  %sWARN%s %s\n' "$YEL" "$OFF" "$1"; }
fail()   { printf '  %sFAIL%s %s\n' "$RED" "$OFF" "$1"; }
die()    { fail "$1"; exit 1; }

mkdir -p "$RUN" || die "cannot create $RUN"

# ── pid / log bookkeeping ─────────────────────────────────────────────────────
#
# Everything this script starts gets a pid file under .run/.  `stop` kills exactly
# those and nothing else, which is what keeps a pre-existing SpacetimeDB safe: we
# only write .run/raceday-spacetime.pid when WE were the one that started it.
#
pidf() { echo "$RUN/raceday-$1.pid"; }
logf() { echo "$RUN/raceday-$1.log"; }

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

own_pid() {   # echoes the live pid we recorded for <name>, or nothing
  local f; f="$(pidf "$1")"
  [ -f "$f" ] || return 1
  local p; p="$(tr -dc '0-9' < "$f")"
  if alive "$p"; then echo "$p"; return 0; fi
  rm -f "$f"; return 1
}

record() { echo "$2" > "$(pidf "$1")"; }

stop_one() {  # <name> <human label>
  local name="$1" label="${2:-$1}" p i
  p="$(own_pid "$name" || true)"
  if [ -z "$p" ]; then
    rm -f "$(pidf "$name")"
    note "$label: not running"
    return 0
  fi
  kill "$p" 2>/dev/null
  i=0
  while [ "$i" -lt 30 ] && alive "$p"; do sleep 0.2; i=$((i + 1)); done
  if alive "$p"; then
    kill -9 "$p" 2>/dev/null
    sleep 0.3
    good "$label: pid $p killed (-9)"
  else
    good "$label: pid $p stopped"
  fi
  rm -f "$(pidf "$name")"
}

# ── helpers ───────────────────────────────────────────────────────────────────
listeners() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }

ping_stdb() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$URL/v1/ping" 2>/dev/null)" = "200" ]; }

# Wait until <pattern> shows up in <file>, or <timeout> seconds pass.  Never
# `sleep 1 && grep` a log a child is still opening — node's type-stripping and
# vite's cold start both take longer than that.
wait_for_log() { # <file> <extended-regex> <timeout_s>
  local f="$1" pat="$2" t="${3:-20}" i=0 n
  n=$((t * 5))
  while [ "$i" -lt "$n" ]; do
    if [ -f "$f" ] && grep -qE "$pat" "$f" 2>/dev/null; then return 0; fi
    sleep 0.2; i=$((i + 1))
  done
  return 1
}

# Every non-loopback IPv4 this laptop currently has, as "ip(interface)".
# `ipconfig getifaddr` returns nothing for the Internet-Sharing bridge, so parse
# ifconfig instead.
lan_ips() {
  ifconfig 2>/dev/null | awk '
    /^[a-z0-9]+:/ { ifn = $1; sub(":", "", ifn) }
    /^[ \t]*inet [0-9]/ {
      if (ifn !~ /^(lo0|gif|stf|utun|awdl|llw|anpi|ap1)/ && $2 != "127.0.0.1")
        print $2 "(" ifn ")"
    }'
}

# The address to hand to the phones and the judges' browser.  Preference, best first:
#   bridge*      the Mac-as-AP address when Internet Sharing is on   <- RACE DAY
#   a real lease a normal Wi-Fi/LAN address
#   192.0.0.x    the iPhone-USB tether link itself — only the tethering phone can use it
#   169.254.x.x  APIPA/link-local: a cable with no DHCP on it. Nearly useless; last resort.
advertise_ip() {
  local pair ip ifn first='' tether='' linklocal=''
  for pair in $(lan_ips); do
    ip="${pair%%(*}"; ifn="${pair#*(}"; ifn="${ifn%)}"
    case "$ifn" in bridge*) echo "$ip"; return 0 ;; esac
  done
  for pair in $(lan_ips); do
    ip="${pair%%(*}"
    case "$ip" in
      192.0.0.*)   [ -z "$tether" ] && tether="$ip"; continue ;;
      169.254.*)   [ -z "$linklocal" ] && linklocal="$ip"; continue ;;
    esac
    [ -z "$first" ] && first="$ip"
  done
  for ip in "$first" "$tether" "$linklocal"; do
    [ -n "$ip" ] && { echo "$ip"; return 0; }
  done
  echo 127.0.0.1
}

# True when there is no Internet-Sharing bridge interface, i.e. the Mac is not
# acting as the `arkart` access point yet and no kart or phone can reach it.
ap_is_down() {
  local pair ifn
  for pair in $(lan_ips); do
    ifn="${pair#*(}"; ifn="${ifn%)}"
    case "$ifn" in bridge*) return 1 ;; esac
  done
  return 0
}

# Pull "kart_id -> address" out of either karts.json and flag the placeholders.
# A dotless token (REAL_CAR_IP) is a placeholder, exactly as the bridge's
# isRoutableTarget() classifies it.
describe_karts() { # <file> <json key for the address>
  local f="$1" key="$2"
  [ -f "$f" ] || { echo "(missing $f)"; return 0; }
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [file, key] = process.argv.slice(1);
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      const out = (j.karts || []).map((k) => {
        const v = String(k[key] ?? "");
        const host = v.replace(/^[a-z]+:\/\//, "").split("/")[0].split(":")[0];
        const ph = !host || !host.includes(".") || /REAL_CAR_IP|CHANGE_?ME|x\.x\.x\.x/i.test(host);
        return `${k.kart_id}->${v || "(unset)"}${ph ? " [PLACEHOLDER]" : ""}`;
      });
      console.log(out.length ? out.join("  ") : "(no karts listed)");
    } catch (e) { console.log(`(unreadable: ${e.message})`); }
  ' "$f" "$key" 2>/dev/null || echo "(could not parse $f)"
}

has_placeholder() { case "$(describe_karts "$1" "$2")" in *PLACEHOLDER*) return 0 ;; esac; return 1; }

# config.state, read through the HTTP /sql endpoint. Rows come back POSITIONALLY
# encoded with a separate schema block, so the column has to be looked up by name
# and then indexed — there is no {"state": "..."} object to grep.
module_state() {
  curl -s -m 4 -H 'Content-Type: text/plain' \
    --data-binary 'SELECT * FROM config' "$URL/v1/database/$DB/sql" 2>/dev/null \
  | node -e '
      let s = ""; process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        try {
          const t = JSON.parse(s)[0];
          const names = t.schema.elements.map((e) => (e.name && e.name.some) || "");
          const i = names.indexOf("state");
          const row = t.rows[0];
          console.log(i >= 0 && row ? String(row[i]) : "?");
        } catch { console.log("?"); }
      });
    ' 2>/dev/null
}

# ══════════════════════════════════════════════════════════════════════════════
#  STOP
# ══════════════════════════════════════════════════════════════════════════════
do_stop() {
  banner " AR KART — RACE DAY: STOP"
  step "shutting down what raceday.sh started"
  # Bridge first: its SIGTERM handler sends three zero packets per kart, so the
  # cars park instantly instead of coasting into the 300 ms firmware watchdog.
  stop_one bridge   "car bridge"
  stop_one vision   "vision bridge"
  stop_one director "director/pilot (vite)"

  local own_stdb; own_stdb="$(own_pid spacetime || true)"
  if [ -n "$own_stdb" ]; then
    stop_one spacetime "SpacetimeDB (we started it)"
    # `spacetime start` may leave the standalone child holding :3000. Only ever
    # reap the port holder when the ownership marker says the server was ours.
    if [ -f "$RUN/raceday-spacetime.ours" ]; then
      local held; held="$(listeners "$STDB_PORT")"
      if [ -n "$held" ]; then
        note "reaping SpacetimeDB child still on :$STDB_PORT (pids: $held)"
        # shellcheck disable=SC2086
        kill $held 2>/dev/null
        sleep 0.5
        held="$(listeners "$STDB_PORT")"
        # shellcheck disable=SC2086
        [ -n "$held" ] && kill -9 $held 2>/dev/null
      fi
    fi
    rm -f "$RUN/raceday-spacetime.ours"
  else
    local held; held="$(listeners "$STDB_PORT")"
    if [ -n "$held" ]; then
      good "SpacetimeDB left running on :$STDB_PORT (pids: $held) — it was not ours"
    else
      note "SpacetimeDB: not running"
    fi
  fi

  rm -f "$RUN/raceday-director.port"
  printf '\n  %sstack down.%s  Logs kept: %s\n\n' "$BOLD" "$OFF" "$RUN/raceday-*.log"
}

# ══════════════════════════════════════════════════════════════════════════════
#  STATUS BLOCK
# ══════════════════════════════════════════════════════════════════════════════
status_block() {
  local ip port dport bline vline p
  ip="$(advertise_ip)"
  dport="$(cat "$RUN/raceday-director.port" 2>/dev/null || echo "$PORT_PREF")"

  banner "══════════════════ AR KART — RACE DAY STATUS ══════════════════"

  printf '  %slaptop LAN IP%s      %s\n' "$BOLD" "$OFF" "$(lan_ips | tr '\n' ' ')"
  printf '                      %sserving to the karts/phones at %s — they must be on this subnet%s\n' "$DIM" "$ip" "$OFF"
  if ap_is_down; then
    printf '                      %s!! no bridge* interface: INTERNET SHARING IS OFF, so the Mac is not%s\n' "$YEL" "$OFF"
    printf '                      %s   the `arkart` AP yet and no kart or phone can reach these URLs.%s\n' "$YEL" "$OFF"
    printf '                      %s   System Settings > General > Sharing > Internet Sharing:%s\n' "$YEL" "$OFF"
    printf '                      %s   share from "iPhone USB" to "Wi-Fi", SSID arkart / arkartarkart.%s\n' "$YEL" "$OFF"
  else
    printf '                      %sMac-as-AP is up (Internet Sharing: iPhone USB -> Wi-Fi, SSID `arkart`)%s\n' "$DIM" "$OFF"
  fi

  if ping_stdb; then
    if [ -f "$RUN/raceday-spacetime.ours" ]; then
      printf '  %sspacetime%s          %s/v1/ping -> 200  (STARTED by raceday, pid %s)\n' \
        "$BOLD" "$OFF" "$URL" "$(own_pid spacetime || echo '?')"
    else
      printf '  %sspacetime%s          %s/v1/ping -> 200  (REUSED — pre-existing, stop leaves it)\n' \
        "$BOLD" "$OFF" "$URL"
    fi
    printf '  %smodule%s             %s @ --server %s   config.state=%s\n' \
      "$BOLD" "$OFF" "$DB" "$SRV" "$(module_state || echo '?')"
  else
    printf '  %sspacetime%s          %sDOWN — %s/v1/ping did not answer%s\n' "$BOLD" "$OFF" "$RED" "$URL" "$OFF"
  fi

  p="$(own_pid bridge || true)"
  if [ -n "$p" ]; then
    bline="$(grep -m1 '^\[bridge\]' "$(logf bridge)" 2>/dev/null)"
    printf '  %scar bridge%s         pid %s  %s\n' "$BOLD" "$OFF" "$p" "${bline:-(startup line not written yet)}"
    grep -m1 'subscriptions applied' "$(logf bridge)" >/dev/null 2>&1 \
      && printf '                      %sstdb subscriptions applied — live WebSocket, generated bindings%s\n' "$DIM" "$OFF"
    if has_placeholder "$KARTS_CB" ip; then
      printf '                      %s!! a kart address is a PLACEHOLDER — nothing is transmitted to it.%s\n' "$YEL" "$OFF"
      printf '                      %s   fix: %s -> karts[].ip, then restart the bridge%s\n' "$YEL" "$KARTS_CB" "$OFF"
    fi
  else
    printf '  %scar bridge%s         %sNOT RUNNING%s\n' "$BOLD" "$OFF" "$RED" "$OFF"
  fi
  printf '                      %sUDP targets: %s%s\n' "$DIM" "$(describe_karts "$KARTS_CB" ip)" "$OFF"

  p="$(own_pid vision || true)"
  if [ -n "$p" ]; then
    vline="$(grep -cE 'watching ' "$(logf vision)" 2>/dev/null | tr -d ' ')"
    printf '  %svision bridge%s      pid %s  %s stream(s) being watched\n' "$BOLD" "$OFF" "$p" "${vline:-0}"
  elif [ "$WANT_VISION" = "0" ]; then
    printf '  %svision bridge%s      skipped (--no-vision)\n' "$BOLD" "$OFF"
  else
    printf '  %svision bridge%s      %sDEGRADED / not running%s — pilots can still drive; no gates are scored\n' \
      "$BOLD" "$OFF" "$YEL" "$OFF"
  fi
  printf '                      %scameras: %s%s\n' "$DIM" "$(describe_karts "$KARTS_VISION" stream_url)" "$OFF"

  p="$(own_pid director || true)"
  port="$dport"
  if [ -n "$p" ]; then
    printf '  %sdirector%s           http://%s:%s/?adapter=sdk&bindings=/src/module_bindings/index.ts  (pid %s)\n' \
      "$BOLD" "$OFF" "$ip" "$port" "$p"
    printf '                      %sHTTP fallback (always works): http://%s:%s/?adapter=http%s\n' "$DIM" "$ip" "$port" "$OFF"
    printf '  %spilot (phones)%s     http://%s:%s/pilot.html?kart=1   and   ?kart=2\n' "$BOLD" "$OFF" "$ip" "$port"
    local ptitle
    ptitle="$(curl -s -m 3 "http://127.0.0.1:$port/pilot.html" 2>/dev/null | sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p' | head -1)"
    case "$ptitle" in
      *Pilot*) printf '                      %sserved OK ("%s") — phones must be on SSID `arkart`%s\n' "$DIM" "$ptitle" "$OFF" ;;
      '')      printf '                      %s!! /pilot.html did not answer — drive from the director page instead%s\n' "$YEL" "$OFF" ;;
      *)       printf '                      %s!! /pilot.html served "%s", not the Pilot page — drive from the%s\n' "$YEL" "$ptitle" "$OFF"
               printf '                      %s   director page instead%s\n' "$YEL" "$OFF" ;;
    esac
  else
    printf '  %sdirector%s           %sNOT RUNNING%s\n' "$BOLD" "$OFF" "$RED" "$OFF"
  fi

  printf '  %slogs%s               %s/raceday-{spacetime,bridge,vision,director}.log\n' "$BOLD" "$OFF" "$RUN"

  cat <<EOF

  ${BOLD}── race control — copy/paste ──${OFF}
  S=$URL/v1/database/$DB/call
  P() { curl -s -o /dev/null -w "%{http_code} \$1\n" -X POST -H 'Content-Type: application/json' -d "\$2" "\$S/\$1"; }

  P begin_setup   '[]'                 # open the calibration lap
  P report_gate   '[1,7]'              # (manual gate entry: kart 1 saw tag 7)
  P confirm_track '[[]]'               # lock the first-seen order as the track
  P start_race    '[]'                 # 3 s countdown -> running
  P abort_race    '[]'                 # KILL SWITCH: thr=0 steer=0 on the wire
  P reset_race    '[]'                 # back to lobby between heats (track kept)

  ${DIM}abort_race wins over any stick: the bridge, not the phone, decides what the car gets.${OFF}
  ${BOLD}stop everything raceday started:${OFF}  $HERE/raceday.sh stop

EOF
}

# ══════════════════════════════════════════════════════════════════════════════
#  UP
# ══════════════════════════════════════════════════════════════════════════════
do_up() {
  banner " AR KART — RACE DAY BRING-UP"

  # ── 0. preflight ────────────────────────────────────────────────────────────
  step "0. preflight"
  command -v spacetime >/dev/null 2>&1 || die "spacetime CLI not on PATH"
  command -v node >/dev/null 2>&1      || die "node not on PATH (need >= 22.18)"
  command -v curl >/dev/null 2>&1      || die "curl not on PATH"
  command -v lsof >/dev/null 2>&1      || die "lsof not on PATH"
  [ -d "$MODULE" ] || die "module not found at $MODULE"
  [ -f "$KARTS_CB" ] || die "venue address book missing: $KARTS_CB"
  local stv
  stv="$(spacetime --version 2>&1 | sed -n 's/.*spacetimedb tool version \([0-9][0-9.]*\).*/\1/p' | head -1)"
  note "node $(node --version), spacetime CLI ${stv:-unknown} (expected 2.4.1 — NEVER run \`spacetime version upgrade\`), bash ${BASH_VERSION%%(*}"
  [ -n "$stv" ] && [ "$stv" != "2.4.1" ] \
    && warn "spacetime CLI is $stv, not the matched 2.4.1 — the bindings in module_bindings/ are 2.4.1"
  note "venue address book: $KARTS_CB  (NOT the loopback karts.local.json)"

  if [ ! -f "$HERE/module_bindings/index.ts" ] || [ ! -d "$HERE/node_modules/spacetimedb" ]; then
    note "generated bindings missing — running ./gen-bindings.sh"
    if [ -x "$HERE/gen-bindings.sh" ]; then
      "$HERE/gen-bindings.sh" >"$(logf bindings)" 2>&1 \
        || { tail -15 "$(logf bindings)"; die "bindings generation failed — see $(logf bindings)"; }
    else
      die "no bindings and no gen-bindings.sh — the bridge cannot use the stdb source"
    fi
  fi
  good "bindings present: $HERE/module_bindings/index.ts"

  # ── 1. SpacetimeDB — adopt or start, never kill ─────────────────────────────
  step "1. SpacetimeDB on :$STDB_PORT"
  if ping_stdb; then
    rm -f "$RUN/raceday-spacetime.ours" "$(pidf spacetime)"
    good "REUSED a SpacetimeDB that was already up (pids: $(listeners "$STDB_PORT")) — 'stop' will leave it alone"
  else
    local held; held="$(listeners "$STDB_PORT")"
    if [ -n "$held" ]; then
      die "something holds :$STDB_PORT (pids: $held) but /v1/ping does not answer — clear it by hand, I will not kill a stranger"
    fi
    note "starting: spacetime start --listen-addr 0.0.0.0:$STDB_PORT"
    spacetime start --listen-addr "0.0.0.0:$STDB_PORT" >"$(logf spacetime)" 2>&1 &
    local sp=$!
    record spacetime "$sp"
    : > "$RUN/raceday-spacetime.ours"
    local i=0
    while [ "$i" -lt 150 ]; do
      ping_stdb && break
      alive "$sp" || { tail -15 "$(logf spacetime)"; die "spacetime start died — see $(logf spacetime)"; }
      sleep 0.4; i=$((i + 1))
    done
    ping_stdb || { tail -15 "$(logf spacetime)"; die "SpacetimeDB never answered /v1/ping — see $(logf spacetime)"; }
    good "STARTED SpacetimeDB, pid $sp — $URL/v1/ping -> 200"
  fi
  spacetime server ping "$SRV" >/dev/null 2>&1 \
    && good "spacetime server ping $SRV -> online" \
    || warn "spacetime server ping $SRV failed (the HTTP ping is green, so this is a CLI server-config nit)"

  # ── 2. publish the module ───────────────────────────────────────────────────
  step "2. module \`$DB\` -> --server $SRV"
  if [ "$PUBLISH" = "0" ]; then
    note "skipped (--no-publish) — reusing whatever is published"
  elif [ "$FRESH" = "1" ]; then
    warn "--fresh: publishing with --delete-data=always — THE TRACK AND ALL LAPS ARE WIPED"
    ( cd "$MODULE" && spacetime publish "$DB" --server "$SRV" --delete-data=always --yes ) \
      >"$(logf publish)" 2>&1 \
      || { tail -20 "$(logf publish)"; die "publish --fresh failed — see $(logf publish)"; }
    good "published $DB (data wiped)"
  else
    # Race day keeps state: no --delete-data. If the schema moved under us the CLI
    # says so, and --fresh is the deliberate way out.
    if ( cd "$MODULE" && spacetime publish "$DB" --server "$SRV" --yes ) >"$(logf publish)" 2>&1; then
      good "published $DB (state PRESERVED — pass --fresh to wipe)"
    else
      tail -20 "$(logf publish)"
      fail "publish failed — see $(logf publish)"
      grep -qiE 'delete|destructive|incompatible|migrat' "$(logf publish)" \
        && die "the schema changed: re-run as ./raceday.sh --fresh (this WIPES the race state)"
      die "publish failed"
    fi
  fi

  # ── 3. car bridge — the LIVE source, not the sim ────────────────────────────
  step "3. car bridge  (BRIDGE_SOURCE=stdb — live subscription)"
  local bp; bp="$(own_pid bridge || true)"
  if [ -n "$bp" ]; then
    good "already running, pid $bp (idempotent — not starting a second one)"
  else
    local stray; stray="$(pgrep -f "$CB/src/index.ts" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
    if [ -n "$stray" ]; then
      warn "a car bridge is already running that raceday did not start (pids: $stray)."
      warn "two bridges on udp:7777 interleave sequence counters — NOT starting a second one."
      warn "kill it first:  kill $stray    then re-run ./raceday.sh"
    else
      # BRIDGE_SOURCE=stdb is the live-database mode: WebSocket subscription to
      # config/kart/input/effect through the generated bindings. `sql` is the
      # no-bindings fallback (HTTP /sql polling); `sim` is the no-database bench
      # sweep demo.sh uses. Race day wants stdb.
      BRIDGE_SOURCE=stdb \
      BRIDGE_BINDINGS="$HERE/module_bindings/index.ts" \
      KARTS_FILE="$KARTS_CB" \
      SPACETIME_URI="ws://localhost:$STDB_PORT" \
      SPACETIME_MODULE="$DB" \
        node "$CB/src/index.ts" >"$(logf bridge)" 2>&1 &
      bp=$!
      record bridge "$bp"
      if wait_for_log "$(logf bridge)" 'subscriptions applied' 25; then
        good "live on SpacetimeDB via generated bindings (WebSocket), pid $bp"
      elif alive "$bp"; then
        warn "bridge pid $bp is up but has not said 'subscriptions applied' yet — see $(logf bridge)"
      else
        tail -15 "$(logf bridge)"
        fail "car bridge died — see $(logf bridge)"
        rm -f "$(pidf bridge)"
        note "fallback if the bindings are the problem: BRIDGE_SOURCE=sql (HTTP /sql polling, nothing generated)"
      fi
    fi
  fi
  note "$(grep -m1 '^\[bridge\]' "$(logf bridge)" 2>/dev/null || echo '(no startup line yet)')"

  # ── 4. vision bridge — tolerant of dead cameras ─────────────────────────────
  step "4. vision bridge  (AprilTag 36h11 -> report_gate)"
  if [ "$WANT_VISION" = "0" ]; then
    note "skipped (--no-vision)"
  else
    local vp; vp="$(own_pid vision || true)"
    if [ -n "$vp" ]; then
      good "already running, pid $vp"
    elif [ ! -x "$VISION/.venv/bin/python" ]; then
      warn "no venv at $VISION/.venv — vision skipped, THE REST OF THE STACK IS UP"
      warn "fix: cd $VISION && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt"
    elif [ ! -f "$KARTS_VISION" ]; then
      warn "no camera book at $KARTS_VISION — vision skipped, the rest of the stack is up"
    else
      ( cd "$VISION" && exec ./.venv/bin/python -m arkart_vision.bridge --config "$KARTS_VISION" ) \
        >"$(logf vision)" 2>&1 &
      vp=$!
      record vision "$vp"
      # Offline/placeholder cameras are EXPECTED: the watcher logs
      # "cannot open ... — retrying" and keeps its thread alive, so the only real
      # failure is the process exiting. Give it a moment, then judge.
      wait_for_log "$(logf vision)" 'watching |report_gate' 12 >/dev/null 2>&1
      sleep 1
      if alive "$vp"; then
        good "running, pid $vp — $(grep -cE 'watching ' "$(logf vision)" 2>/dev/null | tr -d ' ') stream(s)"
        if grep -qE 'cannot open' "$(logf vision)" 2>/dev/null; then
          warn "at least one camera is unreachable — it retries forever; gates from that kart will not score"
        fi
      else
        rm -f "$(pidf vision)"
        warn "vision bridge exited — DEGRADED, continuing without it (see $(logf vision))"
        tail -5 "$(logf vision)" | sed 's/^/       /'
      fi
    fi
  fi
  note "cameras: $(describe_karts "$KARTS_VISION" stream_url)"

  # ── 5. director + pilot over the LAN ────────────────────────────────────────
  step "5. director + pilot pages  (vite --host)"
  if [ "$WANT_DIRECTOR" = "0" ]; then
    note "skipped (--no-director)"
  else
    local dp; dp="$(own_pid director || true)"
    if [ -n "$dp" ]; then
      good "already running, pid $dp on port $(cat "$RUN/raceday-director.port" 2>/dev/null || echo '?')"
    elif [ ! -x "$DIRECTOR/node_modules/.bin/vite" ]; then
      warn "vite not installed — director/pilot skipped.  fix: (cd $DIRECTOR && npm install)"
    else
      # Another leg may already hold 5173 with its own vite. Fall forward rather
      # than fight it, and NEVER land on 8089.
      local chosen='' cand
      for cand in "$PORT_PREF" 5174 5175 5176 5177; do
        [ "$cand" = "$FORBIDDEN_PORT" ] && continue
        local who; who="$(listeners "$cand")"
        if [ -n "$who" ]; then
          warn "port $cand is already in use (pids: $who) — trying the next one"
          continue
        fi
        chosen="$cand"; break
      done
      if [ -z "$chosen" ]; then
        warn "no free port in $PORT_PREF/5174-5177 — director/pilot not started"
      else
        [ "$chosen" = "$FORBIDDEN_PORT" ] && die "refusing to bind $FORBIDDEN_PORT"
        # Run the vite binary directly, not `npm run dev`: then $! IS vite and the
        # pid file can actually kill it instead of reaping an npm wrapper and
        # orphaning the server.
        ( cd "$DIRECTOR" && exec ./node_modules/.bin/vite --host --port "$chosen" --strictPort ) \
          >"$(logf director)" 2>&1 &
        dp=$!
        record director "$dp"
        echo "$chosen" > "$RUN/raceday-director.port"
        if wait_for_log "$(logf director)" 'Local:|ready in' 30; then
          good "vite serving on 0.0.0.0:$chosen (LAN-visible), pid $dp"
        elif alive "$dp"; then
          warn "vite pid $dp is up but has not printed its banner — see $(logf director)"
        else
          rm -f "$(pidf director)" "$RUN/raceday-director.port"
          warn "vite exited — director/pilot DEGRADED (see $(logf director))"
          tail -6 "$(logf director)" | sed 's/^/       /'
        fi
      fi
    fi
  fi

  status_block
}

# ══════════════════════════════════════════════════════════════════════════════
case "$ACTION" in
  up)      do_up ;;
  stop)    do_stop ;;
  status)  status_block ;;
  restart) do_stop; do_up ;;
esac
