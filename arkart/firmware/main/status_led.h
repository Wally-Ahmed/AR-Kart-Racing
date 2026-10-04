/*
 * status_led.h — the single WS2812 pixel on GPIO48 as the kart's state display.
 *
 * You can read the kart's whole health across the room:
 *   CYAN, solid          shield item is up (flags bit0 from the car bridge)
 *   dim GREEN, solid     connected, armed, no shield — normal running state
 *   RED, fast blink      not on WiFi yet (or WiFi dropped)
 *   AMBER, slow blink    on WiFi but the 300 ms control watchdog has tripped — motors are off
 *
 * Driven from its own low-priority task via RMT TX. Uses one of the S3's four RMT TX
 * channels; the T3 TV-remote-style 38 kHz IR tag feature (unbuilt) would take another.
 */

#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    LED_STATE_NO_WIFI = 0,   /* fast red blink   — no network                                */
    LED_STATE_WATCHDOG,      /* slow amber blink — network up, control link dead, motors off */
    LED_STATE_IDLE,          /* dim green        — connected and armed                       */
    LED_STATE_SHIELD,        /* cyan             — shield active                             */
} led_state_t;

esp_err_t status_led_init(void);

/* Safe to call from any task at any rate; the LED task picks up the latest value. */
void status_led_set(led_state_t state);

/* The state currently being displayed — for `netstat`, so the shield bit can be verified
 * without anyone having to look at the pixel. */
led_state_t status_led_get(void);

#ifdef __cplusplus
}
#endif
