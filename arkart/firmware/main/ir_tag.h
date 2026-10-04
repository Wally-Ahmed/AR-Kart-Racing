/*
 * ir_tag.h — AR Kart tier-3 IR TAG LAYER: the TV-remote-style 38 kHz infrared tag.
 *
 * This is the same kind of low-power infrared link a television remote control uses — a 38 kHz
 * carrier and a TSSP77038-class demodulating receiver module. Nothing visible, nothing
 * collimated, no beam: an IR LED behind a 100 Ohm resistor, aimed forward off the front of the
 * kart, and a receiver module facing out so another kart can tag this one.
 *
 * ============================================================================================
 * WHAT IT DOES
 * ============================================================================================
 *   TX   GPIO14 drives the IR LED. `ir_tag_fire()` sends one BURST: IR_REPEATS copies of this
 *        kart's 8-bit frame (see ir_tag_codec.h for the normative on-air format), with the
 *        38 kHz carrier produced by the RMT peripheral's hardware carrier generator.
 *   RX   GPIO3 reads the TSSP77038's demodulated output. Every edge is timestamped in an ISR
 *        and pushed to a queue; a decoder task runs the duration state machine, rejects
 *        malformed frames, rejects a bad check nibble, rejects OUR OWN id (self-hit), and
 *        debounces so that one physical burst produces exactly ONE hit event.
 *   OUT  each accepted hit produces (a) exactly one console line and (b) one
 *        `report_hit(shooter, victim)` HTTP call to SpacetimeDB, posted from its own task so
 *        the decoder never blocks on the network. The call is skipped while WiFi is down —
 *        counted, not retried, never fatal.
 *
 * ============================================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ============================================================================================
 * No game logic. The firmware does NOT know about shields, stuns, items or race state, and it
 * must not: `report_hit` in the SpacetimeDB module routes every offensive hit — items and IR
 * alike — through one `applyOffensive()` function that consumes a shield if the victim has one
 * and otherwise inserts the stun. Verified against the live module:
 *
 *     event_log #64  "Kart 1 SHIELD absorbed IR TAG SHOT from kart 2"
 *
 * The shield row disappeared and NO stun effect was inserted. The reducer also silently drops
 * shooter == victim and a victim with no `progress` row, so a stray report can never corrupt a
 * race. SHIELD-ABSORBS-ONE-HIT IS SERVER-SIDE AND COMPLETE — the firmware's only job is to
 * report honestly. (The firmware rejects its own id anyway, one hop earlier, so a kart can
 * never burn its own shield on its own LED reflecting off a wall.)
 *
 * ============================================================================================
 * DEBOUNCE — one burst, one hit
 * ============================================================================================
 * A burst is IR_REPEATS (3) copies of the frame, 114 ms of air time worst case, and a wall or
 * a shiny floor can reflect each copy back into the receiver a second time. Every copy decodes
 * to the same payload, so the raw decode rate for ONE trigger pull is 3..8 frames.
 *
 * The lockout is therefore PER SHOOTER ID: after a hit from shooter N is accepted, further
 * frames from N are dropped for ARKART_IR_LOCKOUT_MS (default 400 ms, `set ir_lockout_ms`).
 *   - 400 ms is > 3x the 114 ms burst, with margin for a slow repeat and for reflections.
 *   - It is per-id, not global, so two karts shooting you a few tens of ms apart both score.
 *   - The module's IR stun lasts 1.5 s, so a second hit from the same shooter inside 400 ms
 *     would be a no-op server-side in any case: nothing is lost by swallowing it.
 * `irstat` reports the number swallowed (`debounce`) separately from every other reject class,
 * so a mis-tuned lockout is visible rather than silent.
 *
 * ============================================================================================
 * DECODE ARCHITECTURE
 * ============================================================================================
 *   GPIO3 ANY_EDGE ISR  ->  edge queue (256 x 8 bytes)  ->  decoder task  ->  post queue  ->
 *   report task  ->  HTTP POST
 *
 * The ISR does three things and nothing else: read the clock, read the level, enqueue. It never
 * touches the state machine. The decoder task (core 1, prio 5 — under the 50 Hz control task at
 * 6, over the button-tap task at 4) converts consecutive timestamps into interval durations and
 * feeds ir_dec_feed(). Deliberately NOT inside rx_inject's transmit task: that task's stack is
 * tight and its timing is the car's radio protocol, which must not be perturbed by an IR frame
 * arriving.
 *
 * Timestamps are the low 32 bits of esp_timer_get_time(). They wrap every ~71.6 minutes;
 * unsigned subtraction makes the interval correct across the wrap, and the decoder only ever
 * uses differences.
 *
 * ============================================================================================
 * HARDWARE — NOT WIRED YET (as of this file landing)
 * ============================================================================================
 * Both halves are software-complete and software-verified; neither part is soldered.
 *   GPIO14  ->  100 Ohm  ->  IR LED anode, cathode to GND. LED aimed FORWARD.
 *   TSSP77038 breakout:  PINOUT IS 1 GND / 2 VS / 3 OUT / 4 G  — this is NOT the TSOP pinout.
 *                        VS = 2.0..5.5 V (3V3 is fine), OUT -> GPIO3, GND -> GND.
 * GPIO3 is an ESP32-S3 strapping pin (JTAG source select) but it is only sampled at reset; this
 * module configures it as an input with the internal pull-up after boot, which is inert as a
 * strap. The internal pull-up also means an UNCONNECTED GPIO3 idles high and produces no edges,
 * which is exactly why the whole RX path can be tested today with `irtest`.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Per-shooter debounce window. See the header note. */
#define ARKART_IR_LOCKOUT_MS_DEF   400

/* Copies of the frame per burst, and the silence between them (ir_tag_codec.h owns the gap). */
#define ARKART_IR_REPEATS_DEF        3

/* ------------------------------------------------------------------------------------------
 * Bring-up. Claims the third RMT TX channel (status_led has one, the Plan RX injector has
 * another), applies the 38 kHz carrier, parks GPIO14 low, arms the GPIO3 edge ISR, and starts
 * the decoder and report tasks. Safe on a board with no IR hardware attached: an unconnected
 * GPIO14 drives nothing and an unconnected GPIO3 idles high.
 *
 * Call AFTER drive_init() (so the Plan RX injector has already taken its RMT channel) and
 * after status_led_init().
 * ---------------------------------------------------------------------------------------- */
esp_err_t ir_tag_init(void);

/* ------------------------------------------------------------------------------------------
 * Fire one burst now — `irtx`. BLOCKS for the whole burst (~114 ms worst case) because it waits
 * for the RMT channel to drain; call it from the console or a non-real-time task, never from
 * the control loop. Returns ESP_ERR_INVALID_STATE when this kart's id cannot be encoded
 * (ARKART_KART_ID must be 1..15).
 * ---------------------------------------------------------------------------------------- */
esp_err_t ir_tag_fire(void);

/* ------------------------------------------------------------------------------------------
 * `ircheck` — measure the carrier ON-CHIP, with no instruments and no wires.
 *
 * A PCNT unit is attached to GPIO14's input path (the RMT channel is created with
 * io_loop_back, so the pad feeds the input matrix while RMT drives it), one burst is fired, and
 * the carrier edges are counted. One frame contains IR_FRAME_MARK_US of marks regardless of
 * payload, so  measured_hz = edges / (IR_FRAME_MARK_US * repeats) * 1e6. Prints both the
 * measured value and the value the RMT driver's own divider arithmetic produces.
 * ---------------------------------------------------------------------------------------- */
esp_err_t ir_tag_carrier_check(void);

/* ------------------------------------------------------------------------------------------
 * `irtest` — LOOPBACK WITHOUT WIRES.
 *
 * Synthesises the exact edge sequence a TSSP77038 would put on GPIO3 for a burst from
 * `shooter`, and pushes it into the SAME edge queue the ISR feeds. Everything above the queue —
 * interval measurement, the state machine, the check nibble, the self-hit filter, the lockout,
 * the console line, the HTTP post — runs identically to a real photon.
 *
 *   mode 0  clean frames: `repeats` copies, one burst. Expect exactly ONE hit.
 *   mode 1  "bad": correct framing, WRONG check nibble. Expect a `bad_check` reject.
 *   mode 2  "glitch": correct header, then a 2000 us bit mark. Expect a `bad_frame` reject.
 * ---------------------------------------------------------------------------------------- */
typedef enum {
    IR_TEST_CLEAN  = 0,
    IR_TEST_BAD    = 1,
    IR_TEST_GLITCH = 2,
} ir_test_mode_t;

esp_err_t ir_tag_test_inject(uint32_t shooter, int repeats, ir_test_mode_t mode);

/* `irstat` — TX count, decoded frames, accepted hits, last shooter, every reject class, the
 * debounce drops, the carrier numbers, the pins and the post counters. Reads only. */
void ir_tag_status(void);

/* `set ir_lockout_ms | ir_repeats | ir_post <0|1|2>`. Returns ESP_ERR_NOT_FOUND quietly for an
 * unknown key so the console's single `set` namespace can fall through to the other modules.
 *
 * ir_post 2 is a BENCH mode: it posts even while the WiFi link is down, which is the only way
 * to run the esp_http_client path at all with no access point in the room. The attempt fails
 * and is counted in `post fail`; race builds leave it at 1. */
esp_err_t ir_tag_cfg_set(const char *key, long value);

/* One-screen command reference for the IR tag layer. */
void ir_tag_print_help(void);

#ifdef __cplusplus
}
#endif
