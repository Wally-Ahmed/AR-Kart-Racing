/*
 * wifi_sta.h — plain WiFi station bring-up with indefinite reconnect.
 *
 * Credentials and the optional static IP come from Kconfig (idf.py menuconfig ->
 * "AR Kart Firmware"), so the same source tree flashes two karts by changing one menu value.
 *
 * Power save is forced OFF (WIFI_PS_NONE): the default modem sleep adds tens of milliseconds
 * of jitter to both the MJPEG stream and the 50 Hz control datagrams.
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Brings up NVS, netif, the event loop and the station. Returns once the first connection
 * attempt has been started; it does not block until the link is up. */
esp_err_t wifi_sta_start(void);

/* Blocks until the station has an IP, or until timeout_ms elapses. */
bool wifi_sta_wait_connected(uint32_t timeout_ms);

bool wifi_sta_is_connected(void);

/* This station's current IPv4 address as dotted quad, or "0.0.0.0" when it has none. Writes at
 * most cap bytes including the NUL; cap >= 16 is always enough. This is the address the car
 * bridge and the vision bridge have to be told about, so it is also what `netstat` prints. */
void wifi_sta_ip_str(char *out, size_t cap);

#ifdef __cplusplus
}
#endif
