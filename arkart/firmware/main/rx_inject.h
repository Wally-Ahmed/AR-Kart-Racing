/*
 * rx_inject.h — Plan RX: radio-socket injection into the kart's STOCK receiver/decoder board.
 *
 * ============================================================================================
 * WHAT THIS IS
 * ============================================================================================
 * Plan M (drive.c) throws the stock board away and drives the motors from ESP32 GPIOs through
 * kit transistors. Plan RX does the opposite: the stock single-chip board STAYS in the car, on
 * the car's own batteries, doing all the power work. Only its plug-in radio module is removed,
 * and the ESP32 impersonates that radio by bit-banging the demodulated pulse-train the module
 * used to hand the decoder.
 *
 * THE CHIP (bench-confirmed 2026-09-28): marked **SA1607RX 330**, SOP-16 — an RX-2B-family
 * five-function clone (forward / backward / left / right / turbo) for a 27 MHz toy system,
 * with the motor H-bridges integrated on-die.
 *
 * THE INJECTION POINT (bench-confirmed 2026-09-28): the RX-2B demodulated-data input, which on
 * this SOP-16 part is **pin 14**. The plug-in radio module's socket is a 2x2 pad square — two
 * diagonal pads = GND, one pad = V+ (battery), one pad = the pin-14 data net — so the wire can
 * land on either the socket's data pad or the pin-14 net itself, whichever is easier to solder.
 * Hookup is exactly TWO wires:
 *   ESP32 GPIO47 (ARKART_PIN_RX_DATA) -> the pin-14 data net (socket DATA pad)
 *   ESP32 GND                         -> the board's V- hole
 * The car board's V+ is deliberately NOT connected to the ESP32: the car batteries keep
 * powering the board. Two separate supplies, one shared ground. No transistors, no flyback
 * diodes, no H-bridge of ours at all — with this backend selected, GPIO41/42 and LEDC timer 1
 * are never touched.
 *
 * ============================================================================================
 * THE PROTOCOL — and how much of it we actually know
 * ============================================================================================
 * Knowing the family is not knowing the table: SA1607RX is a clone, and clone code tables do
 * sometimes deviate from the RX-2B/TX-2B reference. So the model is the family's — carrier-less
 * baseband bursts, a fixed pulse period, and a *pulse count* per function — while every number
 * below is a RUNTIME variable with a default, never a compile-time constant.
 *
 * TWO ways to get the real numbers, and `sniff` is the better one:
 *   `sniff` — the ESP32 releases the pin to high-impedance INPUT and just watches while the
 *             user presses buttons on the car's original 27 MHz remote. The car's own receiver
 *             front end demodulates onto the same pin-14 net, so every frame the decoder sees,
 *             we see. This reads the protocol out of the hardware: no guessing at all.
 *   `sweep` — the ESP32 transmits each pulse count in turn and the user reports which one moved
 *             which motor. Works even with no remote in hand (the car came without one, or its
 *             batteries are dead), and confirms that what we TRANSMIT is accepted, which is
 *             ultimately the thing that has to work.
 * Use `sniff` first when a working remote exists, then `sweep` to confirm; `set` and
 * `set code` write the calibrated values back live, either way.
 *
 * Frame shape (all four parts runtime-adjustable, any part can be switched off):
 *
 *      |<-- W1 section -->|<-sgap->|<---- function code section ---->|<- frame gap ->|
 *       _   _   _   _               _   _   _   _   _   _   _   _
 *      | |_| |_| |_| |_____________| |_| |_| |_| |_| |_| |_| |_| |___________________
 *       w1_pulses pulses            code[fn] pulses
 *
 *   period_us  500   one pulse cell, high for duty_pct of it            confidence: MEDIUM
 *   duty_pct    50   ~50 % is the family default                        confidence: MEDIUM
 *   w1_pulses    4   the "W1" sync/end section                          confidence: LOW-MED
 *   sgap_us    500   separation between W1 and the code section         confidence: LOW
 *   gap_ms       4   idle between repeats of the frame                  confidence: LOW
 *
 * The function ladder — the RX-2B/TX-2B reference table, which the SA1607RX is expected but
 * not guaranteed to follow. Note the pattern: base 10, step 6, ten slots. That regularity is
 * the strongest single piece of evidence that the table below is the right *shape* even where
 * an individual assignment is a guess.
 *
 *   slot  count  function                    confidence   sweep must confirm?
 *   ----  -----  --------------------------  -----------  -------------------
 *     0     10   FORWARD                     MED-HIGH     yes (the one that matters most)
 *     1     16   TURBO (forward + turbo)      MEDIUM      yes
 *     2     22   unassigned on many clones     LOW        yes — may be backward+turbo
 *     3     28   FORWARD + LEFT                LOW-MED    yes, AND check it is not +RIGHT
 *     4     34   FORWARD + RIGHT               LOW-MED    yes, AND check it is not +LEFT
 *     5     40   BACKWARD                     MED-HIGH    yes
 *     6     46   BACKWARD + RIGHT              LOW        yes, L/R may be swapped
 *     7     52   BACKWARD + LEFT               LOW        yes, L/R may be swapped
 *     8     58   LEFT                          MEDIUM     yes, L/R may be swapped
 *     9     64   RIGHT                         MEDIUM     yes, L/R may be swapped
 *
 * Idle = STOP TRANSMITTING. The decoder releases its motor outputs on loss of signal, so
 * "no frames" is the safe state and the watchdog kill is literally "stop the transmitter".
 *
 * ============================================================================================
 * THROTTLE — the stock decoder has none
 * ============================================================================================
 * An RX-2B output is on or off; there is no analogue throttle in the protocol. Proportional
 * throttle is therefore synthesised at FRAME level: over a rolling window of `window` frames
 * (default 10) the drive code is transmitted in round(thr/255 * window) of them and the rest
 * are idle. At the default timings one forward frame is ~11 ms, so a 10-frame window chops at
 * roughly 9 Hz — coarse, audible, and entirely adequate for a toy kart.
 *
 * Because one code carries both drive and steer, chopping the drive would chop the steering
 * too. `steerfill` (default on) fixes that: the OFF slots of the window transmit the PURE
 * LEFT/RIGHT code instead of idling, so the steer coil stays energised while the drive motor
 * gets its duty-cycled average.
 *
 * Implementation is the RMT TX peripheral, not an esp_timer/GPIO loop. Reasons: (a) the pulse
 * timing comes out of hardware, so WiFi and camera ISRs cannot jitter it — a 500 us cell is
 * well inside the range where a software loop visibly wobbles under load; (b) RMT is completely
 * disjoint from what the camera owns (LCD_CAM + GDMA + LEDC timer 0), so there is no conflict
 * to reason about; (c) the WS2812 status pixel already proves the RMT TX driver works on this
 * board, and the S3 has 4 TX channels, of which the pixel uses one.
 *
 * Contract: this file provides the SAME drive_init / drive_apply / drive_all_off /
 * drive_current_duty entry points as drive.c (see drive.h). Exactly one of the two
 * translation units is compiled, chosen by CONFIG_ARKART_DRIVE_BACKEND_*.
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------------------------------
 * Function ladder slots. The pulse COUNT for each slot lives in rx_cfg_t::code[] and is
 * runtime-writable; these enumerators are only names for the slots.
 * ---------------------------------------------------------------------------------------- */
typedef enum {
    RX_FN_FORWARD = 0,
    RX_FN_TURBO,
    RX_FN_SLOT2,            /* unassigned on many clones — kept so the ladder stays regular */
    RX_FN_FORWARD_LEFT,
    RX_FN_FORWARD_RIGHT,
    RX_FN_BACKWARD,
    RX_FN_BACKWARD_RIGHT,
    RX_FN_BACKWARD_LEFT,
    RX_FN_LEFT,
    RX_FN_RIGHT,
    RX_FN_COUNT
} rx_fn_t;

/* ---- hard bounds. Everything user-tunable is clamped to these, and the defaults below are
 *      _Static_assert-ed against them in rx_inject.c. ------------------------------------- */
#define RX_PERIOD_US_MIN        100
#define RX_PERIOD_US_MAX        5000     /* must stay under the 32767-tick RMT symbol field */
#define RX_DUTY_PCT_MIN         5
#define RX_DUTY_PCT_MAX         95
#define RX_W1_MAX               16
#define RX_W1_MULT_MIN          1
#define RX_W1_MULT_MAX          8        /* W1 pulse width in cells (extremes clamp at the
                                          * RMT tick ceiling in clamp_ticks)                  */
#define RX_SGAP_US_MAX          20000
#define RX_GAP_MS_MAX           100
#define RX_WINDOW_MIN           1
#define RX_WINDOW_MAX           32
#define RX_OFFSLOT_MS_MAX       500
#define RX_HOLD_MS_MIN          50
#define RX_HOLD_MS_MAX          10000
#define RX_SWEEPGAP_MS_MAX      10000
#define RX_PULSES_MIN           1
#define RX_PULSES_MAX           255      /* a code longer than this is not this chip family */
#define RX_SNIFFGAP_US_MIN      200      /* sniff: idle that ends a burst                    */
#define RX_SNIFFGAP_US_MAX      50000
#define RX_SNIFFREP_MS_MIN      100      /* sniff: how often a repeating count re-prints     */
#define RX_SNIFFREP_MS_MAX      10000
#define RX_CARRIER_KHZ_MAX      40000    /* RMT carrier ceiling: 80 MHz src / 2              */

/* ---- defaults (see the confidence table above) ------------------------------------------ */
#define RX_DEF_PERIOD_US        500
#define RX_DEF_DUTY_PCT         50
#define RX_DEF_W1_PULSES        4
#define RX_DEF_W1_MULT          4        /* TX-2B family: sync pulses run 4x the code cell —
                                          * measured on this board 2026-09-29: ~1264 us W1 vs
                                          * ~316 us code. The decoder finds frame start by
                                          * WIDTH, so w1mult=1 frames are never accepted.     */
#define RX_DEF_SGAP_US          500
#define RX_DEF_GAP_MS           4
#define RX_DEF_WINDOW           10
#define RX_DEF_THR_MIN_PCT      20       /* any non-zero throttle gets at least 20 % of the
                                          * window, else low stick does nothing at all       */
#define RX_DEF_INVERT           0        /* 1 if the socket's DATA line turns out active-low  */
#define RX_DEF_STEERFILL        1
#define RX_DEF_OFFSLOT_MS       0        /* 0 = idle for one frame time                       */
#define RX_DEF_HOLD_MS          1500     /* sweep: hold each count ~1.5 s                     */
#define RX_DEF_SWEEPGAP_MS      1000     /* sweep: 1 s gap so each count is distinguishable   */

/* Sniff defaults. The burst-splitting gap must be longer than an intra-frame idle (half a
 * pulse cell, ~250 us, or a section gap, ~500 us) and shorter than an inter-frame gap (~4 ms).
 * 2 ms sits in the middle of that window; `set sniffgap_us` moves it if a clone disagrees. */
#define RX_DEF_SNIFFGAP_US      2000
#define RX_DEF_SNIFFREP_MS      1000

/* RF-inject mode: 0 = baseband on the wire (pin-14 injection). Non-zero = OOK-modulate every
 * pulse with this carrier (kHz) so the wire can feed the board's ANTENNA input instead and the
 * receiver's own front end demodulates it into pin 14. 26667 kHz (80 MHz / 3) is the closest
 * the RMT divider lands to the 27.145 MHz toy band; the board's tuning trimmer bridges the
 * rest. Use `invert 0` with a carrier — the burst rides the pulse level. */
#define RX_DEF_CARRIER_KHZ      0

#define RX_LADDER_BASE          10
#define RX_LADDER_STEP          6

/* How long a console (bench) command stays in force without being refreshed. A walk-away can
 * then never leave a motor pinned: worst case the kart runs for this long. */
#define RX_CONSOLE_TIMEOUT_MS   10000

/* Sniff mode transmits nothing, so it gets a much longer leash: it ends by itself after this
 * long with no edge at all on the wire (remote put down, batteries dead, wire fell off). */
#define RX_SNIFF_AUTOSTOP_MS    120000

/* ------------------------------------------------------------------------------------------
 * Runtime-adjustable protocol + mapping configuration. Read/written only through the calls
 * below, which take the module lock.
 * ---------------------------------------------------------------------------------------- */
typedef struct {
    uint16_t period_us;
    uint16_t sgap_us;
    uint16_t gap_ms;
    uint16_t offslot_ms;
    uint16_t hold_ms;
    uint16_t sweepgap_ms;
    uint16_t sniffgap_us;     /* sniff: how much idle closes a burst                          */
    uint16_t sniffrep_ms;     /* sniff: re-print interval for a count that keeps repeating    */
    uint16_t carrier_khz;     /* 0 = baseband (pin 14); else OOK carrier for the ANT input    */
    uint8_t  duty_pct;
    uint8_t  w1_pulses;
    uint8_t  w1_mult;         /* W1 sync pulse width, in code cells (TX-2B uses 4)            */
    uint8_t  window;
    uint8_t  thr_min_pct;
    uint8_t  deadband;        /* steer deadband on the wire's 0..100 scale                    */
    uint8_t  invert;          /* 1 = DATA pad is active-low                                   */
    uint8_t  steerfill;       /* 1 = fill the window's OFF slots with the pure steer code     */
    uint16_t code[RX_FN_COUNT];
} rx_cfg_t;

/* ------------------------------------------------------------------------------------------
 * Backend lifecycle. drive_init() (drive.h) calls rx_inject_init(); nothing else should.
 * ---------------------------------------------------------------------------------------- */
esp_err_t rx_inject_init(void);

/* ------------------------------------------------------------------------------------------
 * Bench / calibration API. Every one of these takes console override: the net path
 * (drive_apply / drive_all_off) is ignored until `stop` or RX_CONSOLE_TIMEOUT_MS of silence.
 * ---------------------------------------------------------------------------------------- */

/* Transmit a single raw pulse count continuously until stopped. */
esp_err_t rx_inject_hold_code(uint16_t pulses);

/* Walk `from`..`to` inclusive (either direction), holding each count cfg.hold_ms with a
 * cfg.sweepgap_ms idle between, logging "N=<count> SENT" as each one starts. */
esp_err_t rx_inject_sweep(uint16_t from, uint16_t to);

/* LISTEN instead of transmitting: fully release the RMT TX channel, put ARKART_PIN_RX_DATA in
 * high-impedance INPUT with an edge interrupt, and print one summary line per burst seen on the
 * wire while the user presses buttons on the car's own 27 MHz remote. Ends on `stop` or after
 * RX_SNIFF_AUTOSTOP_MS with no edge, and restores full TX capability either way. */
esp_err_t rx_inject_sniff_start(void);

/* Drive through the NORMAL (throttle, steer) mapping, for a smoke test. `reverse` swaps the
 * forward codes for the backward ones — the wire protocol is forward-only, so reverse exists
 * on the bench path only. */
esp_err_t rx_inject_bench_drive(uint8_t throttle, int8_t steer, bool reverse);

/* Stop transmitting and hand control back to the net path. */
void rx_inject_stop(void);

/* Live tuning. `key` is one of the names printed by rx_inject_print_help(). Returns
 * ESP_ERR_NOT_FOUND for an unknown key and ESP_ERR_INVALID_ARG for an out-of-bounds value
 * (the bound is logged). */
esp_err_t rx_inject_cfg_set(const char *key, long value);

/* Retune one entry of the function ladder once the sweep has identified it, e.g. after
 * "N=12 SENT" moved the wheels forward: `set code fwd 12`. */
esp_err_t rx_inject_code_set(const char *name, long pulses);

/* Print the current config + ladder, and the one-screen command reference. */
void rx_inject_cfg_dump(void);
void rx_inject_print_help(void);

/* Slot name <-> slot, for the console. rx_fn_from_name() returns RX_FN_COUNT if unknown. */
const char *rx_fn_name(rx_fn_t fn);
rx_fn_t     rx_fn_from_name(const char *name);

#ifdef __cplusplus
}
#endif
