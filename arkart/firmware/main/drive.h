/*
 * drive.h — motor actuation for the AR Kart kart-side firmware.
 *
 * Owns GPIO14 (rear drive motor PWM) and GPIO41/42 (front steer coil H-bridge), all on
 * LEDC timer 1. Every probe-dependent number comes from motor_map.h.
 *
 * Safety invariants this module guarantees:
 *   1. The two steer bridge sides are never energised at the same time; a dead-time is
 *      inserted whenever the side changes.
 *   2. Throttle INCREASES are slew-limited (brownout guard); throttle DECREASES are instant.
 *   3. drive_all_off() is always instant and always safe to call from any context.
 */

#pragma once

#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Configure the LEDC timer and the three motor channels. Leaves everything de-energised.
 * Must be called AFTER the camera is initialised, so the camera has already claimed LEDC
 * timer 0 / channel 0 and there is no doubt about who owns what. */
esp_err_t drive_init(void);

/* Apply one control tick.
 *   throttle : 0..255, straight off the wire. 0 = coasting (no reverse, no braking).
 *   steer    : -100..+100, straight off the wire. Sign is corrected by ARKART_STEER_SIGN.
 * Call this at ARKART_CONTROL_TICK_MS cadence — the slew limit is expressed per call. */
void drive_apply(uint8_t throttle, int8_t steer);

/* Failsafe. Throttle duty to zero immediately (no ramp), both steer bridge sides released.
 * Called by the 300 ms watchdog and on any state the kart must not move in. */
void drive_all_off(void);

/* Current drive duty, for logging/telemetry. */
uint32_t drive_current_duty(void);

#ifdef __cplusplus
}
#endif
