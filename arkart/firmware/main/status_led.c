#include "status_led.h"
#include "motor_map.h"

#include <stdatomic.h>
#include <stdint.h>
#include <string.h>

#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "status_led";

/* 10 MHz RMT resolution => one tick is 100 ns, which makes the WS2812 bit timings integers. */
#define LED_RMT_RESOLUTION_HZ   10000000u
#define LED_REFRESH_MS          50          /* 20 Hz — enough for a crisp blink, costs nothing */

static rmt_channel_handle_t s_chan    = NULL;
static rmt_encoder_handle_t s_encoder = NULL;

static _Atomic int s_state = LED_STATE_NO_WIFI;

/* WS2812 wants GRB order, MSB first. */
static void led_write_rgb(uint8_t r, uint8_t g, uint8_t b)
{
    if (s_chan == NULL || s_encoder == NULL) {
        return;
    }
    const uint8_t grb[3] = { g, r, b };
    const rmt_transmit_config_t tx_cfg = {
        .loop_count = 0,
    };
    if (rmt_transmit(s_chan, s_encoder, grb, sizeof(grb), &tx_cfg) == ESP_OK) {
        /* Blocking wait keeps the >50 us reset gap between frames implicit: the task then
         * sleeps LED_REFRESH_MS, which is three orders of magnitude longer than the latch. */
        rmt_tx_wait_all_done(s_chan, pdMS_TO_TICKS(100));
    }
}

static void led_task(void *arg)
{
    (void)arg;
    uint32_t phase = 0;

    for (;;) {
        const led_state_t st = (led_state_t)atomic_load(&s_state);
        phase++;

        switch (st) {
        case LED_STATE_SHIELD:
            /* Cyan, solid. Bright — a shield is worth seeing from the far side of the track. */
            led_write_rgb(0, 160, 160);
            break;

        case LED_STATE_IDLE:
            /* Dim green: connected, armed, nothing special happening. */
            led_write_rgb(0, 12, 4);
            break;

        case LED_STATE_WATCHDOG:
            /* Slow amber blink (~1.25 Hz): link to the car bridge is dead, motors are off. */
            if ((phase / 8) % 2) {
                led_write_rgb(120, 60, 0);
            } else {
                led_write_rgb(0, 0, 0);
            }
            break;

        case LED_STATE_NO_WIFI:
        default:
            /* Fast red blink (~5 Hz): distinctly more urgent than the watchdog blink. */
            if ((phase / 2) % 2) {
                led_write_rgb(140, 0, 0);
            } else {
                led_write_rgb(0, 0, 0);
            }
            break;
        }

        vTaskDelay(pdMS_TO_TICKS(LED_REFRESH_MS));
    }
}

esp_err_t status_led_init(void)
{
    esp_err_t err;

    const rmt_tx_channel_config_t chan_cfg = {
        .gpio_num          = ARKART_PIN_STATUS_LED,
        .clk_src           = RMT_CLK_SRC_DEFAULT,
        .resolution_hz     = LED_RMT_RESOLUTION_HZ,
        .mem_block_symbols = 64,
        .trans_queue_depth = 4,
    };
    err = rmt_new_tx_channel(&chan_cfg, &s_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_tx_channel failed: %s", esp_err_to_name(err));
        return err;
    }

    /* WS2812 bit cells, in 100 ns ticks:
     *   0 bit : 0.3 us high, 0.9 us low
     *   1 bit : 0.9 us high, 0.3 us low  */
    const rmt_bytes_encoder_config_t bytes_cfg = {
        .bit0 = { .level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9 },
        .bit1 = { .level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3 },
        .flags = { .msb_first = 1 },
    };
    err = rmt_new_bytes_encoder(&bytes_cfg, &s_encoder);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_bytes_encoder failed: %s", esp_err_to_name(err));
        return err;
    }

    err = rmt_enable(s_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_enable failed: %s", esp_err_to_name(err));
        return err;
    }

    /* Pinned to core 1 with the control loop, away from the WiFi/camera interrupt load on
     * core 0 — Espressif's own guidance for RMT. */
    if (xTaskCreatePinnedToCore(led_task, "arkart_led", 2560, NULL, 2, NULL, 1) != pdPASS) {
        ESP_LOGE(TAG, "failed to create LED task");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "WS2812 status pixel on gpio%d", ARKART_PIN_STATUS_LED);
    return ESP_OK;
}

void status_led_set(led_state_t state)
{
    atomic_store(&s_state, (int)state);
}

led_state_t status_led_get(void)
{
    return (led_state_t)atomic_load(&s_state);
}
