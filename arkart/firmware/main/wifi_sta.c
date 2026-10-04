#include "wifi_sta.h"
#include "status_led.h"

#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs_flash.h"

static const char *TAG = "wifi";

#define WIFI_CONNECTED_BIT   BIT0

static EventGroupHandle_t s_events   = NULL;
static _Atomic bool       s_connected = false;
static esp_netif_t       *s_netif    = NULL;

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;

    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
        return;
    }

    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        atomic_store(&s_connected, false);
        xEventGroupClearBits(s_events, WIFI_CONNECTED_BIT);
        status_led_set(LED_STATE_NO_WIFI);
        ESP_LOGW(TAG, "disconnected — retrying");
        /* Retry forever. A kart that gives up on the venue WiFi is a brick on the track;
         * the firmware watchdog already guarantees it sits still while it is offline. */
        vTaskDelay(pdMS_TO_TICKS(500));
        esp_wifi_connect();
        return;
    }

    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *event = (const ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "connected — stream at http://" IPSTR "/stream, control on UDP :%d",
                 IP2STR(&event->ip_info.ip), CONFIG_ARKART_UDP_PORT);
        atomic_store(&s_connected, true);
        xEventGroupSetBits(s_events, WIFI_CONNECTED_BIT);
    }
}

#if CONFIG_ARKART_USE_STATIC_IP
static void apply_static_ip(esp_netif_t *netif)
{
    esp_netif_dhcpc_stop(netif);

    esp_netif_ip_info_t ip = { 0 };
    ip.ip.addr      = esp_ip4addr_aton(CONFIG_ARKART_STATIC_IP);
    ip.gw.addr      = esp_ip4addr_aton(CONFIG_ARKART_STATIC_GW);
    ip.netmask.addr = esp_ip4addr_aton(CONFIG_ARKART_STATIC_NETMASK);

    const esp_err_t err = esp_netif_set_ip_info(netif, &ip);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "static IP failed (%s) — falling back to DHCP", esp_err_to_name(err));
        esp_netif_dhcpc_start(netif);
        return;
    }
    ESP_LOGI(TAG, "static IP %s", CONFIG_ARKART_STATIC_IP);
}
#endif

esp_err_t wifi_sta_start(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    s_events = xEventGroupCreate();
    if (s_events == NULL) {
        return ESP_ERR_NO_MEM;
    }

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_netif = esp_netif_create_default_wifi_sta();

#if CONFIG_ARKART_USE_STATIC_IP
    apply_static_ip(s_netif);
#endif

    const wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        &on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                        &on_wifi_event, NULL, NULL));

    wifi_config_t sta = { 0 };
    strlcpy((char *)sta.sta.ssid,     CONFIG_ARKART_WIFI_SSID,     sizeof(sta.sta.ssid));
    strlcpy((char *)sta.sta.password, CONFIG_ARKART_WIFI_PASSWORD, sizeof(sta.sta.password));
    sta.sta.threshold.authmode = WIFI_AUTH_OPEN;   /* accept open venue APs too */

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_start());

    /* No modem sleep. Jitter here shows up directly as laggy video and laggy steering. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

    ESP_LOGI(TAG, "station started, joining \"%s\"", CONFIG_ARKART_WIFI_SSID);
    return ESP_OK;
}

bool wifi_sta_wait_connected(uint32_t timeout_ms)
{
    if (s_events == NULL) {
        return false;
    }
    const EventBits_t bits = xEventGroupWaitBits(s_events, WIFI_CONNECTED_BIT,
                                                 pdFALSE, pdTRUE,
                                                 pdMS_TO_TICKS(timeout_ms));
    return (bits & WIFI_CONNECTED_BIT) != 0;
}

bool wifi_sta_is_connected(void)
{
    return atomic_load(&s_connected);
}

void wifi_sta_ip_str(char *out, size_t cap)
{
    if (out == NULL || cap == 0) {
        return;
    }
    esp_netif_ip_info_t ip = { 0 };
    if (s_netif == NULL || esp_netif_get_ip_info(s_netif, &ip) != ESP_OK) {
        strlcpy(out, "0.0.0.0", cap);
        return;
    }
    snprintf(out, cap, IPSTR, IP2STR(&ip.ip));
}
