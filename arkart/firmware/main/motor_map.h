/*
 * motor_map.h — AR Kart kart-side firmware: the ONE place probe-dependent numbers live.
 *
 * Everything in this file that is marked `// PROBE-TODO` is a placeholder waiting on the
 * bench-probe session described in the build sheet ("Before you solder — the five probes").
 * Nothing else in the firmware hard-codes these numbers: drop the measured values in here,
 * rebuild, reflash. That is the whole change.
 *
 * Hardware context (Plan M — direct drive from kit parts, no stock-receiver tap):
 *   - Rear drive motor  : low-side SINGLE 2N2222, PWM from GPIO14. FORWARD ONLY (no reverse;
 *                         stuck karts are hand-marshalled). The kit holds exactly ten 2N2222
 *                         and each kart needs four for the steer bridge, so both karts get one
 *                         drive transistor and there are zero spares. If more parts turn up,
 *                         a second device paralleled onto the same gate line doubles the
 *                         headroom and changes nothing in this firmware except that
 *                         ARKART_MAX_DUTY can go back to 100.
 *   - Front steer coil  : H-bridge on GPIO41 / GPIO42. The two sides are NEVER on together —
 *                         the driver enforces a dead-time between sides.
 *   - Status pixel      : WS2812 on GPIO48 (RMT).
 *
 * Pin authority: docs/research/arkart-s3cam-pinmap-2026-09-19.md
 * Contract authority: docs/design/arkart-game-software-v1.md section 6.
 */

#pragma once

#include <stdint.h>

#include "driver/ledc.h"

/* ------------------------------------------------------------------------------------------
 * 1. Pin assignment (fixed by the pin-map research — the camera owns GPIO 4-13 and 15-18)
 * ---------------------------------------------------------------------------------------- */

#define ARKART_PIN_DRIVE_PWM      47   /* rear drive motor, single low-side NPN, forward only.
                                        * AS-BUILT 2026-09-20: soldered to GPIO47 (not the
                                        * planned 14) — 47 was the unused IR-tag TX reservation,
                                        * safe: no camera/LEDC conflict. If the T3 IR feature
                                        * ever lands, it takes GPIO14 or 21 instead.           */
#define ARKART_PIN_STEER_A        41   /* steer coil H-bridge side A                          */
#define ARKART_PIN_STEER_B        42   /* steer coil H-bridge side B                          */
#define ARKART_PIN_STATUS_LED     48   /* onboard WS2812 pixel line                           */

/* GPIO21 is the pin-map's "motor B / reverse" slot. Plan M drops reverse, so it stays
 * unconfigured and free. Listed here only so nobody reassigns it by accident. */
#define ARKART_PIN_RESERVED_REVERSE  21

/* ------------------------------------------------------------------------------------------
 * 2. LEDC allocation — the camera driver owns TIMER_0 / CHANNEL_0 for XCLK.
 *    Touching timer 0 kills the camera ("camera_probe failed" / invalid frames).
 *    All motor PWM therefore lives on TIMER_1, channels 1..3.
 * ---------------------------------------------------------------------------------------- */

#define ARKART_LEDC_MODE          LEDC_LOW_SPEED_MODE   /* the S3 has low-speed mode only     */
#define ARKART_LEDC_MOTOR_TIMER   LEDC_TIMER_1          /* NOT timer 0 — that is the camera   */
#define ARKART_LEDC_CH_DRIVE      LEDC_CHANNEL_1
#define ARKART_LEDC_CH_STEER_A    LEDC_CHANNEL_2
#define ARKART_LEDC_CH_STEER_B    LEDC_CHANNEL_3

/* LEDC_TIMER_2 is reserved for the T3 stretch feature (see ir_tag_pins.h). Nothing uses it
 * today. LEDC_TIMER_3 is spare. */

/* PWM carrier for the drive + steer outputs. One timer serves all three channels, so this
 * frequency and resolution apply to every motor output.
 * 13-bit at 1 kHz is legal on the S3 (80 MHz / 1 kHz = 80000 counts >= 8192). */
#define ARKART_PWM_FREQ_HZ        1000                  /* PROBE-TODO: raise toward 5 kHz if
                                                         * the drive 2N2222 sings audibly and
                                                         * stays cool; drop if it gets hot.
                                                         * With one transistor instead of two,
                                                         * heat is the thing to watch.        */
#define ARKART_PWM_RES            LEDC_TIMER_13_BIT
#define ARKART_DUTY_MAX           ((1 << 13) - 1)       /* 8191 = full on                     */

/* ------------------------------------------------------------------------------------------
 * 3. THE PROBE CONSTANTS — these are the numbers the bench session produces.
 * ---------------------------------------------------------------------------------------- */

/* MIN_DUTY — the drive motor's deadband floor.
 * Below this duty the rear motor buzzes but does not turn the wheels. Any non-zero throttle
 * command is lifted to at least this duty so that "a little throttle" actually moves the kart.
 * HOW TO MEASURE: on the bench supply at 4.50 V, ramp duty from 0 until the wheels break away
 * under the kart's own weight on carpet. Take that duty, add ~5 %.
 * 8191 * 0.30 = 2457 is a typical starting guess for a Five Below-class drive motor. */
#define ARKART_MIN_DUTY           1310    // MEASURED 2026-09-20 bench: wheels barely turn at
                                          // 0.50 V of 4.50 V (11 %) free-running in air; set to
                                          // 16 % for load margin. Re-tune upward on carpet if
                                          // low throttle stalls the kart.

/* MAX_RAMP — slew limit, in duty counts per 20 ms control tick, applied on the way UP only.
 * This is the brownout guard: the single most likely failure is motor inrush collapsing the
 * 3.3 V rail and killing the camera mid-race. Ramping the duty instead of stepping it keeps
 * the inrush spread over several ticks.
 * Decreases (including the watchdog kill) are applied INSTANTLY and never ramped — safety
 * always wins over smoothness.
 * 820 counts/tick = 0 -> full in ~10 ticks = ~200 ms.
 * HOW TO MEASURE: scope the 3.3 V rail on a 0 -> full throttle step. Lower this until the rail
 * no longer dips below ~3.0 V and the camera survives the step. */
#define ARKART_MAX_RAMP           820     // PROBE-TODO: lower until the 3V3 rail stops dipping

/* MAX_DUTY — absolute throttle ceiling, in PERCENT of full duty. 100 = no cap.
 * This is the single-transistor guard. Each kart drives its rear motor through ONE 2N2222
 * (the kit's ten devices go four-to-a-steer-bridge plus one drive, twice over, with no
 * spares), so the drive device carries the whole motor current alone instead of sharing it
 * with a paralleled twin. A 2N2222 is a 600 mA continuous part; a stalled toy drive motor
 * will happily ask for more than that and take the transistor with it.
 * Capping duty caps the average current, which is the cheap way to stay inside the device
 * with no extra parts.
 * HOW TO SET: read probe (2), the motor run + stall current measurement at 4.50 V.
 *   single-2N2222 drive — set from probe (2) stall current: ~60-70% if stall lands in
 *   0.8-2 A at 4.5 V.
 * Below ~0.8 A stall you can leave this at 100. Above ~2 A, cap harder AND expect to feel
 * the transistor get hot — that is the case where a second device really is needed.
 * NOTE this is a hard ceiling applied after the ramp, so it also bounds the worst-case
 * inrush that ARKART_MAX_RAMP is spreading out. */
#define ARKART_MAX_DUTY           60      // MEASURED 2026-09-20 bench (probe 2 @ 4.50 V):
                                          // free-run 0.23 A, pinch-stall 2.35 A. Stall is just
                                          // past the 2 A band edge on a single 2N2222, so cap
                                          // at the low end (60). If the fallback ladder yields
                                          // a second drive device, parallel it and set 100.

/* Derived — the ceiling in 13-bit duty counts. Do not edit by hand. */
#define ARKART_DRIVE_DUTY_CEILING  (((uint32_t)ARKART_DUTY_MAX * (uint32_t)ARKART_MAX_DUTY) / 100u)

/* STEER_SIGN — which way is left.
 * +1 means a positive steer value energises side A (GPIO41). If the kart steers the wrong way
 * on the first drive test, flip this to -1. No rewiring, no resoldering.
 * HOW TO MEASURE: command steer = +100, see which way the wheels point. */
#define ARKART_STEER_SIGN         (+1)    // PROBE-TODO: flip to -1 if the kart steers backwards

/* STEER_VARIANT_P_OR_N — which H-bridge got built.
 * The Plan M kit audit decides this at the bench and it is still undecided:
 *   'N' = Variant N — all-NPN low-side bridge. Drive HIGH to energise a side.
 *         ~60 % steering authority, no level shifters, builds from the kit as-is.
 *   'P' = Variant P — complementary NPN/PNP with level shifters. The shifter inverts, so the
 *         pad must be driven LOW to energise a side. Full authority, needs PNPs in the kit.
 * The driver keeps the SAME abstraction either way: duty 0 = coil off, duty max = full
 * deflection. Only the pad polarity changes, via the LEDC output_invert flag below.
 * HOW TO MEASURE: this is a build decision, not a measurement — set it to whichever bridge you
 * actually soldered. */
#define ARKART_STEER_VARIANT_P_OR_N   'N'   // PROBE-TODO: 'N' all-NPN, or 'P' complementary

/* Derived from the variant — do not edit by hand. */
#if ARKART_STEER_VARIANT_P_OR_N == 'P'
#define ARKART_STEER_OUTPUT_INVERT    1   /* level shifter inverts: pad LOW = coil energised  */
#define ARKART_STEER_IDLE_PAD_LEVEL   1   /* safe pad level before LEDC takes the pin over    */
#else
#define ARKART_STEER_OUTPUT_INVERT    0   /* all-NPN: pad HIGH = coil energised               */
#define ARKART_STEER_IDLE_PAD_LEVEL   0
#endif

/* The drive stage is a single low-side NPN in both variants: pad HIGH = motor on. If a bench
 * probe ever shows otherwise (an inverting gate driver sneaks in), flip this. */
#define ARKART_DRIVE_OUTPUT_INVERT    0   // PROBE-TODO: 1 only if the drive stage inverts
#define ARKART_DRIVE_IDLE_PAD_LEVEL   0

/* ------------------------------------------------------------------------------------------
 * 4. Tuning constants that are probe-adjacent but less likely to move
 * ---------------------------------------------------------------------------------------- */

/* Steer commands whose magnitude is below this (on the wire scale of 0..100) mean "centre":
 * the coil is de-energised and the return spring recentres the wheels. Stops the coil cooking
 * itself on stick noise. */
#define ARKART_STEER_DEADBAND     12      // PROBE-TODO: raise if the coil buzzes at stick centre

/* Minimum duty that actually pulls the steer coil over against its return spring. Same idea as
 * ARKART_MIN_DUTY, for the other motor. */
#define ARKART_STEER_MIN_DUTY     3200    // PROBE-TODO: measured coil pull-in duty

/* Dead-time inserted between de-energising one bridge side and energising the other.
 * Both sides on at once = cross-conduction = dead transistors. The driver ALWAYS takes both sides
 * to zero and waits this long before it energises the opposite side. */
#define ARKART_STEER_DEADTIME_US  500     // PROBE-TODO: raise if the bridge gets warm on

/* ------------------------------------------------------------------------------------------
 * 5. Control-loop timing (contract — do not tune without the car bridge agreeing)
 * ---------------------------------------------------------------------------------------- */

#define ARKART_CONTROL_TICK_MS    20      /* 50 Hz actuation tick — matches the bridge's 50 Hz */
#define ARKART_WATCHDOG_MS        300     /* no valid packet for this long -> everything off   */

/* If no packet has been seen for this long, the next packet is treated as a fresh start and
 * the sequence-number tracker resets (the car bridge restarted and its seq went back to 0). */
#define ARKART_SEQ_RESYNC_MS      1000

/* ------------------------------------------------------------------------------------------
 * 6. PLAN RX — radio-socket injection (only used when the drive backend is RXINJECT)
 *
 * The other way to make a kart move: leave the stock single-chip receiver-decoder board in the
 * car, on the car's own batteries, and pull out its plug-in radio module. The ESP32 then
 * impersonates that radio, bit-banging the demodulated pulse-train straight into the decoder's
 * DATA input. No transistors, no flyback diodes, no H-bridge of ours — with this backend
 * selected, sections 2-4 above are dead code and GPIO41/42 and LEDC timer 1 are never touched.
 *
 * Bench-confirmed 2026-09-28: the decoder is marked SA1607RX 330 (SOP-16), an RX-2B-family
 * five-function 27 MHz clone, and the injection point is its demodulated-data input, PIN 14.
 * The radio-module socket is a 2x2 pad square — two diagonal pads = GND, one pad = V+
 * (battery), one pad = that same pin-14 data net — so solder to whichever of the two is easier.
 * HOOKUP IS EXACTLY TWO WIRES:
 *   ESP32 ARKART_PIN_RX_DATA -> SA1607RX pin 14 / the socket's DATA pad
 *   ESP32 GND                -> the board's V- hole
 * The car board's V+ pad is deliberately NOT connected to the ESP32: the car batteries keep
 * powering the board. Two supplies, one shared ground. Nothing else gets soldered.
 *
 * Protocol constants (pulse period, W1 section, the function-code ladder) are NOT here — they
 * are RUNTIME variables in rx_inject.c, because a clone's code table can deviate from the
 * RX-2B reference and a live `sweep` is the only way to know. See rx_inject.h for the table
 * and its confidence levels. This file holds only the pin.
 * ---------------------------------------------------------------------------------------- */

/* Its own #define rather than an alias of ARKART_PIN_DRIVE_PWM: today both are 47 (the
 * as-built free pin), but a kart could end up with the injection wire on a different pin from
 * the one a Plan M kart uses for the drive transistor, and then these must diverge. Changing
 * this is the whole change — rx_inject.c compile-time-asserts it clears the camera pins
 * (GPIO 4-13, 15-18) and the WS2812 (GPIO48). */
#define ARKART_PIN_RX_DATA        47
