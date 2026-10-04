#include "camera_stream.h"
#include "motor_map.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "esp_camera.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "camera";

/* ------------------------------------------------------------------------------------------
 * OV3660 / ESP32-S3-CAM DVP pin map.
 * Identical across the Freenove, Goouuu and ESP32-S3-EYE boards — all three use the
 * CAMERA_MODEL_ESP32S3_EYE map. Verified against arduino-esp32 camera_pins.h.
 * These 14 pins (4-13, 15-18) are why the motor pins had to be 14/41/42.
 * ---------------------------------------------------------------------------------------- */
#define CAM_PIN_PWDN    (-1)
#define CAM_PIN_RESET   (-1)
#define CAM_PIN_XCLK    15
#define CAM_PIN_SIOD     4
#define CAM_PIN_SIOC     5
#define CAM_PIN_D7      16
#define CAM_PIN_D6      17
#define CAM_PIN_D5      18
#define CAM_PIN_D4      12
#define CAM_PIN_D3      10
#define CAM_PIN_D2       8
#define CAM_PIN_D1       9
#define CAM_PIN_D0      11
#define CAM_PIN_VSYNC    6
#define CAM_PIN_HREF     7
#define CAM_PIN_PCLK    13

#define PART_BOUNDARY "arkartframe"

static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char *STREAM_PART         = "Content-Type: image/jpeg\r\n"
                                         "Content-Length: %u\r\n"
                                         "X-Timestamp: %d.%06d\r\n\r\n";

static httpd_handle_t s_server = NULL;

/* ---------------------------------------------------------------------------------------- */

esp_err_t camera_stream_init_sensor(void)
{
    camera_config_t config = {
        .pin_pwdn     = CAM_PIN_PWDN,
        .pin_reset    = CAM_PIN_RESET,
        .pin_xclk     = CAM_PIN_XCLK,
        .pin_sccb_sda = CAM_PIN_SIOD,
        .pin_sccb_scl = CAM_PIN_SIOC,
        .pin_d7       = CAM_PIN_D7,
        .pin_d6       = CAM_PIN_D6,
        .pin_d5       = CAM_PIN_D5,
        .pin_d4       = CAM_PIN_D4,
        .pin_d3       = CAM_PIN_D3,
        .pin_d2       = CAM_PIN_D2,
        .pin_d1       = CAM_PIN_D1,
        .pin_d0       = CAM_PIN_D0,
        .pin_vsync    = CAM_PIN_VSYNC,
        .pin_href     = CAM_PIN_HREF,
        .pin_pclk     = CAM_PIN_PCLK,

        .xclk_freq_hz = 20000000,          /* drop to 16 MHz if WiFi throughput degrades      */

        /* The camera driver generates XCLK with LEDC. It owns timer 0 / channel 0 and every
         * motor PWM in this firmware deliberately lives on timer 1 (see motor_map.h). Sharing
         * this timer is the documented way to get "camera_probe failed" / invalid frames. */
        .ledc_timer   = LEDC_TIMER_0,
        .ledc_channel = LEDC_CHANNEL_0,

        .pixel_format = PIXFORMAT_JPEG,    /* never raw: LCD_CAM + GDMA into PSRAM is the S3's
                                            * documented bottleneck, JPEG keeps frames small  */
        .frame_size   = FRAMESIZE_VGA,     /* AprilTag math in the research doc assumes VGA   */
        .jpeg_quality = 12,                /* 0..63, LOWER is better quality; 10-15 streams   */
        .fb_count     = 2,
        .fb_location  = CAMERA_FB_IN_PSRAM,
        .grab_mode    = CAMERA_GRAB_LATEST, /* never serve a stale frame to the pilot         */
    };

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_camera_init failed: 0x%x (%s)", err, esp_err_to_name(err));
        ESP_LOGE(TAG, "if this says camera_probe failed, suspect the LEDC timer or the ribbon");
        return err;
    }

    sensor_t *s = esp_camera_sensor_get();
    if (s != NULL) {
        /* The OV3660 ships upside down and colour-shifted relative to the OV2640 the
         * reference sketches assume. */
        if (s->id.PID == OV3660_PID) {
            s->set_vflip(s, 1);
            s->set_brightness(s, 1);
            s->set_saturation(s, -2);
        }
        ESP_LOGI(TAG, "sensor PID 0x%02x initialised", s->id.PID);
    }

    return ESP_OK;
}

/* ---------------------------------------------------------------------------------------- */

static esp_err_t stream_handler(httpd_req_t *req)
{
    esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
    if (res != ESP_OK) {
        return res;
    }
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "X-Framerate", "30");

    ESP_LOGI(TAG, "stream client attached");

    char part_buf[96];
    uint32_t frames = 0;
    const int64_t t_start = esp_timer_get_time();

    while (true) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (fb == NULL) {
            ESP_LOGE(TAG, "frame grab failed");
            res = ESP_FAIL;
            break;
        }

        uint8_t *jpg_buf = fb->buf;
        size_t   jpg_len = fb->len;
        bool     owned   = false;   /* true when frame2jpg allocated a separate buffer */

        if (fb->format != PIXFORMAT_JPEG) {
            /* Only reachable if someone changes pixel_format above. Kept so that change does
             * not silently stream garbage. */
            if (!frame2jpg(fb, 80, &jpg_buf, &jpg_len)) {
                esp_camera_fb_return(fb);
                ESP_LOGE(TAG, "JPEG compression failed");
                res = ESP_FAIL;
                break;
            }
            owned = true;
        }

        struct timeval ts = { .tv_sec = fb->timestamp.tv_sec, .tv_usec = fb->timestamp.tv_usec };

        res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
        if (res == ESP_OK) {
            const int hlen = snprintf(part_buf, sizeof(part_buf), STREAM_PART,
                                      (unsigned)jpg_len, (int)ts.tv_sec, (int)ts.tv_usec);
            res = httpd_resp_send_chunk(req, part_buf, hlen);
        }
        if (res == ESP_OK) {
            res = httpd_resp_send_chunk(req, (const char *)jpg_buf, jpg_len);
        }

        if (owned) {
            free(jpg_buf);
        }
        esp_camera_fb_return(fb);

        if (res != ESP_OK) {
            break;      /* client went away — normal, not an error worth shouting about */
        }
        frames++;
    }

    const int64_t elapsed_ms = (esp_timer_get_time() - t_start) / 1000;
    ESP_LOGI(TAG, "stream client gone after %u frames in %lld ms", (unsigned)frames, elapsed_ms);
    return res;
}

static esp_err_t index_handler(httpd_req_t *req)
{
    static const char page[] =
        "<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\">"
        "<title>AR Kart</title>"
        "<style>body{margin:0;background:#101014;color:#e8e8ef;font:14px system-ui;"
        "display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px}"
        "img{width:100%;max-width:640px;border-radius:8px;background:#000}</style>"
        "<h3>AR Kart &mdash; kart camera</h3>"
        "<img src=\"/stream\" alt=\"kart FPV\">"
        "<p>MJPEG at <code>/stream</code> &middot; control on UDP :7777</p>";
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, page, HTTPD_RESP_USE_STRLEN);
}

esp_err_t camera_stream_start_server(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port      = 80;
    config.ctrl_port        = 32768;
    config.stack_size       = 8192;
    config.max_uri_handlers = 4;
    config.lru_purge_enable = true;
    /* The stream handler is a blocking while(true) loop, so it holds its worker for as long as
     * the client watches. Pin the whole HTTP server to core 0 next to WiFi and leave core 1
     * entirely to the control loop — a stalled video stream must never stall steering. */
    config.core_id          = 0;
    config.task_priority    = 4;

    esp_err_t err = httpd_start(&s_server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }

    const httpd_uri_t stream_uri = {
        .uri      = "/stream",
        .method   = HTTP_GET,
        .handler  = stream_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t index_uri = {
        .uri      = "/",
        .method   = HTTP_GET,
        .handler  = index_handler,
        .user_ctx = NULL,
    };

    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &stream_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &index_uri));

    ESP_LOGI(TAG, "MJPEG server up: http://<kart-ip>/stream");
    return ESP_OK;
}
