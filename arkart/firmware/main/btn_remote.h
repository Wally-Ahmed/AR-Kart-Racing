/*
 * btn_remote.h — Plan B: press the STOCK REMOTE's buttons electrically.
 *
 * ============================================================================================
 * WHAT THIS IS
 * ============================================================================================
 * Plan M drives the car's motors from ESP32 GPIOs. Plan RX (rx_inject.c) impersonates the car's
 * plug-in radio module on the receiver board's demodulated-data pin. This module does neither:
 * the car keeps its stock radio link completely intact, and the ESP32 sits on the TRANSMITTER
 * side, pressing the buttons of the car's own hand remote (HS-4023T) the way a thumb does.
 *
 * Nothing about the protocol has to be known for this to work — the remote's own encoder still
 * generates the frames, including the real multi-button combo codes (bench-verified: the encoder
 * emits a distinct code for e.g. forward+left, so a drive button and a steer button pressed
 * together behave exactly as they do under a thumb).
 *
 * ============================================================================================
 * THE ELECTRICAL CONTRACT — read this before touching the code
 * ============================================================================================
 * Each remote button is a momentary short from its key pad to ground. The remote's encoder idles
 * those pads HIGH through its own internal pull-ups, and the remote is powered from the ESP32's
 * own 3V3 rail, so the two sides share a rail and a ground and there is no level translation
 * anywhere.
 *
 *   "press"   = pull the pad to 0 V.
 *   "release" = let go of the pad entirely (high-impedance), and let the remote's pull-up
 *               take it back high.
 *
 *   >>> THE PIN IS NEVER, EVER DRIVEN HIGH. <<<
 *
 * That is the one hard rule here, and it is not a style preference: a human can be pressing the
 * physical rubber button at the same instant the firmware presses it. The rubber button is a
 * dead short to ground. A pin driven high into that short is a push-pull driver fighting a
 * short circuit through the ESP32's pad — tens of mA through a pad rated for 40, for as long as
 * the finger is down.
 *
 * Two independent defences are used, deliberately belt-and-braces:
 *   1. ORDER. The output LEVEL register is written to 0 BEFORE the output enable is set, so the
 *      pad's very first driven state is low. There is no window in which the pad is an enabled
 *      output holding a stale 1.
 *   2. OPEN DRAIN. The pressed state is GPIO_MODE_INPUT_OUTPUT_OD, not GPIO_MODE_OUTPUT. In
 *      open-drain the pad physically cannot source current: the high-side driver is disconnected,
 *      so even a future bug that writes level 1 just releases the pad instead of fighting a
 *      finger. The INPUT_ half keeps the input buffer alive in both states, which is what lets
 *      `btnstat` read the TRUE pad voltage (and therefore see a human's finger) rather than
 *      reporting back only what the firmware intended.
 *
 * Pulls are explicitly DISABLED in both states. The remote supplies the only pull-up in the
 * system; adding ours would just load its pad, and a pull-DOWN would be a permanent soft press.
 * At boot the four pads are configured floating-input before anything else can touch them, so
 * "all buttons released" is the state the firmware comes up in regardless of what the pins did
 * during reset.
 *
 * ============================================================================================
 * THE PIN MAP (locked by the user 2026-10-04)
 * ============================================================================================
 *   GPIO39 — LEFT   (remote key K1)
 *   GPIO40 — RIGHT  (remote key K2)
 *   GPIO41 — BACK   (remote key K4)
 *   GPIO42 — FWD    (remote key K3)
 *
 * 41/42 are deliberately NOT in naive key order: the user's harness has 42 = forward and
 * 41 = back. Do not "fix" that.
 *
 * GPIO39..42 are the S3's JTAG group (MTCK/MTDO/MTDI/MTMS). JTAG is routed to the USB-Serial-JTAG
 * peripheral by default on this board, so all four are plain GPIOs — which is also why no SD/MMC
 * interface may ever be enabled here: GPIO39/40 are only free because the SD interface never
 * mounts. Under the Plan M backend GPIO41/42 are the steer-coil H-bridge (motor_map.h), so this
 * module is compiled ONLY for Plan RX builds, where drive.c is not in the image at all.
 *
 * ============================================================================================
 * HOLD MODEL
 * ============================================================================================
 * The module holds a SET of buttons until told otherwise — there is no auto-release timer on the
 * bench path (see the optional watchdog below). Two pairs are mutually exclusive, because they
 * are on the real remote too: LEFT/RIGHT and FWD/BACK. Conflicts resolve MOST-RECENT-WINS: a
 * `press fwd` while BACK is held releases BACK first, in the same operation, so the two are never
 * shorted down together even for one tick. One drive button plus one steer button is legal and
 * is the normal driving case.
 *
 * THROTTLE. The remote has no throttle — a key is down or up. Proportional throttle is therefore
 * synthesised by chopping the DRIVE key only (steering is never chopped: a half-energised steer
 * coil just centres): over a window of `btn_window_ms` (default 120) the drive key is held down
 * for thr% of the window and released for the rest. The ON phase is floored at BTN_ON_MS_FLOOR
 * (50 ms) because the car's decoder needs roughly two frames (~36 ms) of a code before it acts;
 * a shorter press is simply not seen, so without the floor low throttle would read as "dead"
 * rather than "slow". `thr 100` (the default) is a solid hold with no chopping at all, and
 * `thr 0` keeps the pad released while the logical hold stays, so steering still works.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Button identity. The enumerator ORDER matches the GPIO order 39,40,41,42 so that `btnstat`
 * reads top-to-bottom like the harness does; it is not the remote's key order. */
typedef enum {
    BTN_LEFT = 0,       /* gpio39, remote key K1 */
    BTN_RIGHT,          /* gpio40, remote key K2 */
    BTN_BACK,           /* gpio41, remote key K4 */
    BTN_FWD,            /* gpio42, remote key K3 */
    BTN_COUNT
} btn_id_t;

#define ARKART_PIN_BTN_LEFT     39
#define ARKART_PIN_BTN_RIGHT    40
#define ARKART_PIN_BTN_BACK     41
#define ARKART_PIN_BTN_FWD      42

/* Throttle-chop window. The lower bound is the ON floor itself: a window that short can only
 * ever be a solid hold, which is harmless but pointless. */
#define BTN_WINDOW_MS_MIN       50
#define BTN_WINDOW_MS_MAX       2000
#define BTN_WINDOW_MS_DEF       120

/* Shortest press the car's decoder actually registers (~2 frames ≈ 36 ms, rounded up with
 * margin). Any non-zero throttle gets at least this much ON time. */
#define BTN_ON_MS_FLOOR         50

/* Command watchdog. 0 = off, which is the bench default: a human at a serial console cannot type
 * fast enough to keep a 300 ms leash fed, and a surprise release mid-test is worse than none.
 * The net layer will set 300 once it drives this module. */
#define BTN_WATCHDOG_MS_DEF     0
#define BTN_WATCHDOG_MS_MAX     60000

#define BTN_THR_PCT_DEF         100

/* ------------------------------------------------------------------------------------------
 * Lifecycle. Call once at boot, before the console exists: it parks all four pads as floating
 * inputs ("all released") and starts the chop/watchdog task.
 * ---------------------------------------------------------------------------------------- */
esp_err_t btn_remote_init(void);

/* ------------------------------------------------------------------------------------------
 * Press / release. Both are idempotent, both refresh the watchdog, and both apply the
 * pair-exclusion rule described above.
 * ---------------------------------------------------------------------------------------- */
esp_err_t btn_remote_press(btn_id_t b);
esp_err_t btn_remote_release(btn_id_t b);
void      btn_remote_release_all(void);

/* Throttle shaping for the DRIVE pair only, 0..100 %. Refreshes the watchdog. */
esp_err_t btn_remote_set_throttle(long pct);

/* ------------------------------------------------------------------------------------------
 * WHOLE-STATE entry point — the one the NET layer uses (net_drive.c).
 *
 * The console's press/release/thr trio is wrong for a 50 Hz caller in two ways: each call
 * prints a line, and each throttle call re-phases the chop window (so a caller that re-sent
 * the same throttle every 20 ms would restart every window inside its ON slice and hold the
 * drive key down permanently). This sets the COMPLETE desired state in one quiet, idempotent
 * operation instead:
 *
 *   - no printing at all, so it is safe at packet rate;
 *   - one apply pass, so releases still precede presses and the FWD/BACK and LEFT/RIGHT
 *     exclusions hold by construction — the pair can never be down together even for a tick;
 *   - the chop phase is re-based ONLY when the drive key itself changes, so a steady stream of
 *     identical commands leaves the chop running;
 *   - it refreshes the command watchdog, which is how a 50 Hz stream keeps the 300 ms leash
 *     fed, and how silence releases everything;
 *   - it REPLACES whatever was held, including a console `press` — that is the documented
 *     net-wins precedence (see net_drive.h).
 *
 * thr_pct is clamped to 0..100 and has the same meaning as btn_remote_set_throttle()'s: 100 is
 * a solid hold, 0 keeps the drive key released while steering still works.
 * ---------------------------------------------------------------------------------------- */
typedef enum {
    BTN_DRIVE_NONE = 0,
    BTN_DRIVE_FWD,
    BTN_DRIVE_BACK,
} btn_drive_dir_t;

typedef enum {
    BTN_STEER_NONE = 0,
    BTN_STEER_LEFT,
    BTN_STEER_RIGHT,
} btn_steer_dir_t;

esp_err_t btn_remote_set_state(btn_drive_dir_t drive, btn_steer_dir_t steer, uint8_t thr_pct);

/* Live tuning for this module's keys: btn_window_ms, btn_watchdog_ms, btn_thr_pct.
 * Returns ESP_ERR_NOT_FOUND *quietly* for anything else, so a shared `set <key> <value>`
 * command can try this module first and fall through to another one. */
esp_err_t btn_remote_cfg_set(const char *key, long value);

/* `btnstat` — per-button logical state, electrical state, live pad level and pin mode, plus the
 * throttle/window/watchdog settings. Reads hardware; changes nothing. */
void btn_remote_status(void);

/* One-screen command reference for this module. */
void btn_remote_print_help(void);

/* Name <-> id, for the console. btn_remote_from_name() returns BTN_COUNT if unknown. Accepted:
 * left, right, fwd/forward, back/backward/rev/reverse. */
btn_id_t    btn_remote_from_name(const char *name);
const char *btn_remote_name(btn_id_t b);

#ifdef __cplusplus
}
#endif
