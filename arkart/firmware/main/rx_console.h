/*
 * rx_console.h — bench console for the Plan RX backend.
 *
 * A line parser on the default console (UART0 @ 115200 in this project's sdkconfig, so
 * `idf.py monitor` is all you need — type into it). It drives both calibration paths: `sniff`
 * (release the pin, read the real protocol off the wire from the car's own remote) and `sweep`
 * (transmit candidate counts and watch what moves). Deliberately NOT esp_console/linenoise:
 * this has to work while the camera, WiFi and the control loop are all running, with no extra
 * driver installed on the console UART and no history/completion machinery to go wrong at a
 * bench at 2 a.m. It is ~150 lines of getchar().
 *
 * Only compiled when CONFIG_ARKART_DRIVE_BACKEND_RXINJECT and CONFIG_ARKART_RXINJECT_CONSOLE
 * are both set. The command reference lives in rx_inject_print_help().
 */

#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Prints the one-screen help and starts the reader task. Call after drive_init(). */
esp_err_t rx_console_start(void);

#ifdef __cplusplus
}
#endif
