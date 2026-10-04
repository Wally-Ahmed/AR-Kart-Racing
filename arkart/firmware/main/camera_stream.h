/*
 * camera_stream.h — OV3660 capture + the MJPEG endpoint the rest of the stack consumes.
 *
 * Contract (fixed by the conductor; the vision bridge and the iOS pilot app both hard-code it):
 *     http://<kart-ip>/stream     multipart/x-mixed-replace MJPEG
 *
 * Also serves a one-page index at / so a human can sanity-check the kart from a browser.
 */

#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Initialise the OV3660 (auto-detected by the esp32-camera driver over SCCB).
 * Claims LEDC timer 0 / channel 0 for XCLK — call this BEFORE drive_init(). */
esp_err_t camera_stream_init_sensor(void);

/* Start the HTTP server carrying /stream. Requires WiFi to be up. */
esp_err_t camera_stream_start_server(void);

#ifdef __cplusplus
}
#endif
