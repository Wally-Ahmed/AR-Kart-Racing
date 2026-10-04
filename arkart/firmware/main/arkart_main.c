/*
 * arkart_main.c — AR Kart kart-side firmware entry point.
 *
 * What runs on the kart, and nothing else:
 *   - WiFi STA                      (credentials + kart_id from Kconfig)
 *   - MJPEG camera stream           http://<kart-ip>/stream
 *   - UDP control listener :7777    8-byte packets from the car bridge, 50 Hz
 *   - 300 ms watchdog               no packet -> throttle 0, steer released
 *   - WS2812 status pixel           cyan on shield, dim green idle, blinks when unhappy
 *
 * There is no SpacetimeDB client here, no game logic, no item logic. The car bridge has
 * already decided everything by the time a packet lands; the kart just actuates.
 *
 * Core split (this matters):
 *   core 0 — WiFi + the HTTP/MJPEG server. The stream handler blocks its worker for as long
 *            as a client is watching, which is exactly why it is kept off core 1.
 *   core 1 — control loop + status LED. Steering keeps working while video is stalled.
 *
 * Boot order matters too: the camera is initialised FIRST so it claims LEDC timer 0 for XCLK
 * before the motor driver configures timer 1. Sharing timer 0 with a motor PWM is the
 * documented way to get "camera_probe failed".
 */

#include <stdio.h>

#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "camera_stream.h"
#include "control_udp.h"
#include "drive.h"
#include "ir_tag.h"        /* T3: the TV-remote-style 38 kHz IR tag (GPIO14 TX / GPIO3 RX) */
#include "motor_map.h"
#include "status_led.h"
#include "wifi_sta.h"

/* Plan RX only: the stock-remote button tap (GPIO39/40/41/42) and the bench console that
 * calibrates the injected radio protocol. Plan M builds compile neither — 41/42 are its steer
 * coil (see main/CMakeLists.txt). */
#if defined(CONFIG_ARKART_DRIVE_BACKEND_RXINJECT)
#include "btn_remote.h"
#if defined(CONFIG_ARKART_RXINJECT_CONSOLE)
#include "rx_console.h"
#endif
#endif

#if defined(CONFIG_ARKART_DRIVE_BACKEND_RXINJECT)
#define ARKART_BACKEND_NAME  "Plan RX (radio-socket injection)"
#else
#define ARKART_BACKEND_NAME  "Plan M (PWM / kit transistors)"
#endif

static const char *TAG = "arkart";

void app_main(void)
{
    ESP_LOGI(TAG, "AR Kart firmware — kart_id %d, drive backend: %s",
             CONFIG_ARKART_KART_ID, ARKART_BACKEND_NAME);

    /* 1. Status pixel first, so every later failure has a visible signal. */
    ESP_ERROR_CHECK(status_led_init());
    status_led_set(LED_STATE_NO_WIFI);

#if defined(CONFIG_ARKART_DRIVE_BACKEND_RXINJECT)
    /* 1b. The stock-remote button tap, as early as possible and long before the console can
     *     take a command: its whole job on this line is to park GPIO39..42 as floating inputs,
     *     i.e. "every button released", whatever those JTAG-group pads were doing out of reset.
     *     A press is only ever a pull to ground, so no car can move because of this call. */
    ESP_ERROR_CHECK(btn_remote_init());
#endif

    /* 2. Camera before motors — it claims LEDC timer 0 / channel 0 for XCLK. */
    esp_err_t cam_err = camera_stream_init_sensor();
    if (cam_err != ESP_OK) {
        /* A dead camera is a bad demo but a working kart: the pilot loses FPV and the vision
         * bridge loses this kart's gates, while driving and the failsafe still work. Carry on
         * rather than rebooting into a loop. */
        ESP_LOGE(TAG, "camera init failed (%s) — continuing without video",
                 esp_err_to_name(cam_err));
    }

    /* 3. Motors. Everything parks de-energised. */
    ESP_ERROR_CHECK(drive_init());
    drive_all_off();

    /* 3a. The IR tag layer. After drive_init() so the Plan RX injector has already taken its
     *     RMT channel; it takes the third (status_led holds the first). Nothing is wired to
     *     GPIO14 or GPIO3 yet, which is harmless: the LED pin drives air and the receiver pin
     *     idles high on its internal pull-up. `irtest` exercises the whole decode path without
     *     either of them. */
    ESP_ERROR_CHECK(ir_tag_init());

#if defined(CONFIG_ARKART_DRIVE_BACKEND_RXINJECT) && defined(CONFIG_ARKART_RXINJECT_CONSOLE)
    /* 3b. Plan RX: the bench console, before WiFi — a calibration session needs no network,
     *     and the protocol constants it tunes are guesses until it has been run. */
    ESP_ERROR_CHECK(rx_console_start());
#endif

    /* 4. Network. */
    ESP_ERROR_CHECK(wifi_sta_start());

    /* 5. Control listener starts immediately — it does not need the link to be up, and it is
     *    what holds the motors off until a valid packet arrives. */
    ESP_ERROR_CHECK(control_udp_start((uint8_t)CONFIG_ARKART_KART_ID,
                                      (uint16_t)CONFIG_ARKART_UDP_PORT));

    /* 6. The HTTP server needs an interface, so it waits for the join. */
    if (wifi_sta_wait_connected(30000)) {
        if (cam_err == ESP_OK) {
            ESP_ERROR_CHECK(camera_stream_start_server());
        }
    } else {
        ESP_LOGW(TAG, "no WiFi after 30 s — kart stays parked; reconnect runs in background");
    }

    /* Heartbeat. Cheap, and it is the one line that tells you at 3 a.m. whether the kart is
     * alive but unlinked, or hung. */
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        ESP_LOGI(TAG, "wifi=%d link=%d duty=%u heap=%u",
                 (int)wifi_sta_is_connected(),
                 (int)control_udp_link_alive(),
                 (unsigned)drive_current_duty(),
                 (unsigned)esp_get_free_heap_size());
    }
}
