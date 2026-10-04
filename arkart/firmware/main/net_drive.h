/*
 * net_drive.h — the NET DRIVE LAYER for the button-tap backend (Plan RX builds only).
 *
 * ============================================================================================
 * WHAT THIS IS
 * ============================================================================================
 * control_udp.c already receives the car bridge's 8-byte control packet, validates it, runs the
 * sequence-number filter and the 300 ms failsafe. Under Plan M it hands the result to drive.c,
 * which PWMs motors. This module is the equivalent hand-off for the stock-remote button tap:
 * it turns one (throttle, steer, flags) triple into the SET of remote buttons that should be
 * held, and asks btn_remote.c to hold exactly that set.
 *
 * It is the only thing in the tree that calls btn_remote_set_state(), and it consumes
 * btn_remote's public API only — the pin map, the open-drain press rule and GPIO39..42's
 * semantics all stay inside btn_remote.c, untouched.
 *
 * ============================================================================================
 * THE MAPPING, AND WHERE EVERY NUMBER COMES FROM
 * ============================================================================================
 * The wire contract (car-bridge/src/packet.ts, which is authoritative and was NOT changed):
 *
 *      [3] throttle  u8   0..255   — a MAGNITUDE. The bridge never sends a negative throttle;
 *                                    the byte is unsigned, so 200 means "200 forward", never
 *                                    "-56". There is no reverse field on the wire.
 *      [4] steer     i8  -127..127 — two's complement, + = right.
 *      [5] flags     u8            — bit0 = shield (ARKART_FLAG_SHIELD).
 *
 * DRIVE DIRECTION. The remote has a real BACK button (GPIO41), so reverse is physically
 * available, but the packet has no field for it. Rather than redefine byte 3 as an i8 — which
 * would silently turn every throttle above 127 that the bridge already sends into reverse —
 * this layer reads direction from flags **bit1**, ARKART_FLAG_REVERSE. The bridge sets flags
 * from `shield ? 0x01 : 0x00` and nothing else, so bit1 is always 0 today and the behaviour is
 * exactly "forward only" until the bridge opts in. One `| FLAG_REVERSE` on the bridge side
 * turns reverse on; nothing else has to change. See the report/README note — this is an
 * ADDITIVE extension of the contract, flagged for sign-off, not a reinterpretation of it.
 *
 *      throttle > ARKART_NET_THR_DEADBAND  ->  FWD held (or BACK if flags bit1)
 *      throttle <= ARKART_NET_THR_DEADBAND ->  drive key RELEASED, chop percentage 0
 *      steer * ARKART_STEER_SIGN >  +ARKART_STEER_DEADBAND  ->  RIGHT held
 *      steer * ARKART_STEER_SIGN <  -ARKART_STEER_DEADBAND  ->  LEFT  held
 *      otherwise                                            ->  both steer keys released
 *
 * DEADBANDS.
 *   Throttle: ARKART_NET_THR_DEADBAND = 8 of 255, ~3 %. A gamepad trigger at rest reports a
 *   couple of counts of noise and the bridge passes it through unquantised, so a bare `> 0`
 *   test would hold the drive key down on a resting stick. 8 sits above that noise and far
 *   below the smallest throttle the bridge ever produces deliberately (its stun value is a
 *   hard 0 and its slowest meaningful command is the pilot's own stick). Because 0 <= 8, the
 *   bridge's kill switch — it zeroes throttle whenever the race state is not `running` — is
 *   satisfied by the same comparison: throttle 0 always releases the drive key.
 *   Steer: ARKART_STEER_DEADBAND (12 of 127, ~9 %) is reused verbatim from motor_map.h, so the
 *   two backends ignore the same stick slop and a pilot feels one car, not two.
 *
 * THROTTLE SHAPING. btn_remote chops the drive key over a window to fake proportional
 * throttle, in percent. The scale is linear: pct = round(throttle * 100 / 255). Note that
 * btn_remote floors the ON phase at BTN_ON_MS_FLOOR (50 ms of the 120 ms window, ~42 %)
 * because the car's decoder needs ~2 frames of a code before it acts — so every pct from 1 to
 * ~41 drives the car at the same ~42 % effective duty. That floor is the car's, not ours, and
 * btnstat prints the real on/off split so it is never a mystery.
 *
 * ============================================================================================
 * PRECEDENCE — who owns the four pads
 * ============================================================================================
 * The bench console (`press`, `release`, `thr`) and this layer both drive btn_remote, so
 * ownership is explicit and it changes with the control link, not with a mode flag:
 *
 *   LINK DOWN (no valid packet for ARKART_WATCHDOG_MS, which includes "since boot") —
 *       net_drive is DISARMED. It does not touch a pad. btn_watchdog_ms is left at 0, so a
 *       console `press fwd` holds indefinitely, exactly as btn_remote.h documents for the
 *       bench. This is the state the board boots in.
 *
 *   LINK UP (a valid packet was accepted) —
 *       net_drive ARMS on that packet: it forces btn_watchdog_ms to ARKART_WATCHDOG_MS
 *       (300 ms) and from then on writes the COMPLETE button set every control tick (20 ms).
 *       A console press during a live link is therefore overridden within one tick — the
 *       pilot's stick wins over the keyboard, which is the only safe precedence once a car is
 *       on a track. The 300 ms leash is a second, independent failsafe: even if the control
 *       task itself died mid-hold, btn_remote's own tick releases every button.
 *
 *   LINK LOST while armed —
 *       net_drive DISARMS: all buttons released, chop percentage back to 100, and
 *       btn_watchdog_ms restored to 0 so the console regains its indefinite hold.
 *
 *   `net off` (console) —
 *       a bench kill. net_drive disarms and stays out of the way however many packets arrive,
 *       so a human at the console can always win. `net on` restores it. Default is on.
 *
 * To stop a net-driven car the real answer is the bridge's kill switch (throttle 0), not the
 * console: `stop` releases the pads but a live link re-asserts them 20 ms later.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Throttle counts (of 255) at or below which the drive key is released. See the header note:
 * chosen above gamepad-at-rest noise, and low enough that the bridge's throttle-0 kill switch
 * lands inside it. */
#define ARKART_NET_THR_DEADBAND   8

/* One-time setup. Logs the mapping it will apply; touches no pad. Called by the control task
 * before it binds the socket. Safe to call more than once. */
esp_err_t net_drive_init(void);

/* Apply one accepted control packet. Called from the control task on every accepted packet and
 * on every ARKART_CONTROL_TICK_MS tick while the link is alive. Silent: no printing at all. */
void net_drive_apply(uint8_t throttle, int8_t steer, uint8_t flags);

/* Failsafe / link-down path. Idempotent and cheap when already disarmed (one atomic load), so
 * the control task can call it from its tripped branch as often as it likes. */
void net_drive_all_off(void);

/* True while this layer owns the pads (i.e. the control link is alive and `net off` is not
 * set). */
bool net_drive_is_armed(void);

/* `net on` / `net off`, and the `set net_*` keys. Returns ESP_ERR_NOT_FOUND quietly for an
 * unknown key so the console's one `set` namespace can fall through to the other modules. */
esp_err_t net_drive_enable(bool on);
esp_err_t net_drive_cfg_set(const char *key, long value);

/* `netstat` — everything the net path knows: WiFi + IP, link state, the last accepted packet,
 * what it mapped to, the shield bit and the status-pixel state, the deadbands, and the
 * accepted/dropped counters. Reads only; changes nothing. */
void net_drive_status(void);

/* One-screen command reference for the net path. */
void net_drive_print_help(void);

/* ------------------------------------------------------------------------------------------
 * `netpkt` — send one REAL control datagram to this board's own control socket over the lwip
 * loopback interface (127.0.0.1:CONFIG_ARKART_UDP_PORT).
 *
 * It exercises the production path end to end — socket, recvfrom, magic/kart filter, sequence
 * filter, mapping, pads — with only the WiFi radio hop left out, which is what makes the net
 * layer testable on a bench with no access point. A single socket bound to a FIXED local port
 * is reused for every call, so the control task sees one stable source address and the
 * sequence filter behaves exactly as it does for the real bridge.
 *
 *   throttle_signed  -255..255. Negative = magnitude + ARKART_FLAG_REVERSE, which is precisely
 *                    what the laptop generator script does, so `netpkt -120` and a remote
 *                    `--thr -120` put identical bytes on the socket.
 *   seq              < 0 uses an auto-incrementing counter; >= 0 is sent verbatim, which is how
 *                    a stale/duplicate sequence number is tested.
 * ---------------------------------------------------------------------------------------- */
esp_err_t net_drive_test_packet(long throttle_signed, long steer, long flags, long seq);

#ifdef __cplusplus
}
#endif
