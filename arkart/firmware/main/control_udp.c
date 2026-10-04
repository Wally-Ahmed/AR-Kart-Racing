#include "control_udp.h"
#include "drive.h"
#include "motor_map.h"
#include "status_led.h"
#include "wifi_sta.h"

#if defined(CONFIG_ARKART_DRIVE_BACKEND_RXINJECT)
/* Plan RX / button-tap builds actuate through the stock remote's buttons, not through
 * drive.h. rx_inject.c still provides drive.h (and still owns GPIO47 and the RMT frame
 * builder) so the bench console's `fwd`/`code`/`sniff` keep working — but the NET path drives
 * net_drive.c. One actuator per path, never both at once. */
#include "net_drive.h"
#endif

#include <errno.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

static const char *TAG = "control";

/* ------------------------------------------------------------------------------------------
 * Actuation seam. Exactly one of these pairs is compiled; both are called from the same two
 * places in control_task(), so the control logic above them is identical for both backends.
 * ---------------------------------------------------------------------------------------- */
#if defined(CONFIG_ARKART_DRIVE_BACKEND_RXINJECT)
#define ACTUATE_INIT()                  net_drive_init()
#define ACTUATE(thr, steer, flags)      net_drive_apply((thr), (steer), (flags))
/* Both failsafes, not one: the button tap is what the net path drives, and drive_all_off()
 * keeps the pre-existing guarantee that the RMT injector is silent on a dead link too (it
 * already declines while the bench console deliberately holds the transmitter). */
#define ACTUATE_OFF()                   do { net_drive_all_off(); drive_all_off(); } while (0)
#else
#define ACTUATE_INIT()                  ESP_OK
#define ACTUATE(thr, steer, flags)      drive_apply((thr), (steer))
#define ACTUATE_OFF()                   drive_all_off()
#endif

/* How long recvfrom() blocks before we come back round to service the watchdog and the
 * actuation tick. Shorter than the tick so a quiet link still ticks on time. */
#define RECV_TIMEOUT_MS   10

typedef struct {
    uint8_t  kart_id;
    uint16_t port;
} control_cfg_t;

static _Atomic bool s_link_alive = false;

/* Diagnostic counters / last-packet snapshot for `netstat`. Written here only; see
 * control_udp.h for why they are individually atomic and not collectively locked. */
static _Atomic uint8_t  s_st_throttle = 0;
static _Atomic int      s_st_steer    = 0;
static _Atomic uint8_t  s_st_flags    = 0;
static _Atomic uint16_t s_st_seq      = 0;
static _Atomic uint32_t s_st_src_ip   = 0;
static _Atomic uint16_t s_st_src_port = 0;
static _Atomic bool     s_st_have_src = false;
static _Atomic uint32_t s_st_accepted = 0;
static _Atomic uint32_t s_st_stale    = 0;
static _Atomic uint32_t s_st_foreign  = 0;
static _Atomic uint32_t s_st_resyncs  = 0;
static _Atomic int64_t  s_st_last_us  = 0;

/* ------------------------------------------------------------------------------------------
 * Sequence-number acceptance — strictly monotonic PER SOURCE.
 *
 * seq is a u16 that wraps. The rule: accept a packet only if it is NEWER than the last one
 * accepted from the same source, where "newer" is the standard serial-number comparison — cast
 * the difference to int16_t and require it to be positive. That tolerates wraparound
 * (65535 -> 0 reads as +1) while still dropping duplicates (diff 0) and out-of-order
 * stragglers (diff negative).
 *
 * Three escape hatches, because a bridge restart would otherwise lock us out for ~32k packets.
 * All three ADOPT the arriving seq as the new baseline rather than trusting the old one:
 *   - the source address or port changed: a different bridge process, with its own counter;
 *   - nothing valid has arrived for ARKART_SEQ_RESYNC_MS;
 *   - a jump further back than SEQ_RESTART_GAP, which is a restart, not a straggler.
 *
 * "Per source" here means ONE source at a time, not a table of them: exactly one bridge drives
 * a given kart_id, so a changed source address is a moved/restarted bridge rather than a
 * second concurrent pilot. Adopting its baseline is the correct response and costs no state.
 * ---------------------------------------------------------------------------------------- */
#define SEQ_RESTART_GAP   1024

static bool     s_seq_valid = false;
static uint16_t s_last_seq  = 0;

static bool seq_is_fresh(uint16_t seq)
{
    if (!s_seq_valid) {
        s_seq_valid = true;
        s_last_seq  = seq;
        atomic_fetch_add(&s_st_resyncs, 1);
        return true;
    }

    const int16_t diff = (int16_t)(seq - s_last_seq);

    if (diff > 0) {
        s_last_seq = seq;
        return true;
    }
    if (diff < -SEQ_RESTART_GAP) {
        /* Far in the past = the bridge restarted its counter. Adopt the new baseline. */
        ESP_LOGW(TAG, "seq restart detected (%u -> %u), resyncing", s_last_seq, seq);
        s_last_seq = seq;
        atomic_fetch_add(&s_st_resyncs, 1);
        return true;
    }
    return false;   /* duplicate or stale reorder */
}

/* ---------------------------------------------------------------------------------------- */

void control_udp_get_stats(control_udp_stats_t *out)
{
    if (out == NULL) {
        return;
    }
    out->link_alive      = atomic_load(&s_link_alive);
    out->have_src        = atomic_load(&s_st_have_src);
    out->throttle        = atomic_load(&s_st_throttle);
    out->steer           = (int8_t)atomic_load(&s_st_steer);
    out->flags           = atomic_load(&s_st_flags);
    out->seq             = atomic_load(&s_st_seq);
    out->src_ip          = atomic_load(&s_st_src_ip);
    out->src_port        = atomic_load(&s_st_src_port);
    out->accepted        = atomic_load(&s_st_accepted);
    out->dropped_stale   = atomic_load(&s_st_stale);
    out->dropped_foreign = atomic_load(&s_st_foreign);
    out->resyncs         = atomic_load(&s_st_resyncs);
    out->last_packet_us  = atomic_load(&s_st_last_us);
}

/* ---------------------------------------------------------------------------------------- */

static void control_task(void *arg)
{
    control_cfg_t cfg = *(control_cfg_t *)arg;
    free(arg);

    (void)ACTUATE_INIT();

    int sock = -1;

    /* Last accepted command. Held across ticks so the 50 Hz actuation cadence is independent
     * of the packet arrival rate. */
    uint8_t cmd_throttle = 0;
    int8_t  cmd_steer    = 0;
    uint8_t cmd_flags    = 0;

    int64_t last_packet_us = 0;     /* 0 = nothing ever received */
    int64_t last_tick_us   = 0;
    bool    tripped        = true;  /* start tripped: no link yet, motors must stay off */

    for (;;) {
        if (sock < 0) {
            sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
            if (sock < 0) {
                ESP_LOGE(TAG, "socket() failed: errno %d", errno);
                vTaskDelay(pdMS_TO_TICKS(500));
                continue;
            }

            struct sockaddr_in addr = {
                .sin_family      = AF_INET,
                .sin_port        = htons(cfg.port),
                .sin_addr.s_addr = htonl(INADDR_ANY),
            };
            if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
                ESP_LOGE(TAG, "bind(:%u) failed: errno %d", cfg.port, errno);
                close(sock);
                sock = -1;
                vTaskDelay(pdMS_TO_TICKS(500));
                continue;
            }

            const struct timeval tv = {
                .tv_sec  = 0,
                .tv_usec = RECV_TIMEOUT_MS * 1000,
            };
            setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

            ESP_LOGI(TAG, "listening on UDP :%u as kart_id %u", cfg.port, cfg.kart_id);
        }

        /* ---- receive ------------------------------------------------------------------- */
        uint8_t buf[32];
        struct sockaddr_storage src;
        socklen_t src_len = sizeof(src);

        const int n = recvfrom(sock, buf, sizeof(buf), 0, (struct sockaddr *)&src, &src_len);

        if (n == ARKART_PACKET_LEN &&
            buf[0] == ARKART_MAGIC_0 &&
            buf[1] == ARKART_MAGIC_1 &&
            buf[2] == cfg.kart_id) {

            const uint16_t seq = (uint16_t)buf[6] | ((uint16_t)buf[7] << 8);   /* little-endian */

            /* Per-source baseline. A changed address/port is a restarted or moved bridge with
             * its own counter, so its first packet must not be judged against the old one. */
            uint32_t sip  = 0;
            uint16_t spt  = 0;
            if (src.ss_family == AF_INET) {
                const struct sockaddr_in *in4 = (const struct sockaddr_in *)&src;
                sip = (uint32_t)in4->sin_addr.s_addr;
                spt = ntohs(in4->sin_port);
            }
            if (!atomic_load(&s_st_have_src) ||
                sip != atomic_load(&s_st_src_ip) || spt != atomic_load(&s_st_src_port)) {
                if (atomic_load(&s_st_have_src)) {
                    ESP_LOGI(TAG, "control source changed -> %u.%u.%u.%u:%u, adopting its seq",
                             (unsigned)(sip & 0xFFu), (unsigned)((sip >> 8) & 0xFFu),
                             (unsigned)((sip >> 16) & 0xFFu), (unsigned)((sip >> 24) & 0xFFu),
                             (unsigned)spt);
                }
                atomic_store(&s_st_src_ip, sip);
                atomic_store(&s_st_src_port, spt);
                atomic_store(&s_st_have_src, true);
                s_seq_valid = false;
            }

            const int64_t now_us = esp_timer_get_time();
            const bool stale_link = (last_packet_us == 0) ||
                                    ((now_us - last_packet_us) > (ARKART_SEQ_RESYNC_MS * 1000));
            if (stale_link) {
                s_seq_valid = false;    /* fresh start: whatever seq arrives becomes baseline */
            }

            if (seq_is_fresh(seq)) {
                cmd_throttle   = buf[3];
                cmd_steer      = (int8_t)buf[4];
                cmd_flags      = buf[5];
                last_packet_us = now_us;

                if (tripped) {
                    ESP_LOGI(TAG, "control link up");
                    tripped = false;
                }

                atomic_store(&s_st_throttle, cmd_throttle);
                atomic_store(&s_st_steer, (int)cmd_steer);
                atomic_store(&s_st_flags, cmd_flags);
                atomic_store(&s_st_seq, seq);
                atomic_store(&s_st_last_us, now_us);
                atomic_fetch_add(&s_st_accepted, 1);

                /* Actuate on the packet as well as on the tick, so a throttle-0 kill-switch
                 * packet releases the drive key on arrival instead of up to one tick later. */
                ACTUATE(cmd_throttle, cmd_steer, cmd_flags);
            } else {
                atomic_fetch_add(&s_st_stale, 1);
            }
        } else if (n > 0) {
            /* Malformed, foreign, or addressed to the other kart. Not an error, just noise on
             * the venue network — counted so `netstat` can show it, never logged per packet. */
            atomic_fetch_add(&s_st_foreign, 1);
            ESP_LOGD(TAG, "ignored %d-byte datagram", n);
        }
        /* n < 0 with EAGAIN is the ordinary timeout — fall through to the tick. */

        /* ---- watchdog + actuation tick ------------------------------------------------- */
        const int64_t now_us = esp_timer_get_time();

        const bool wd_expired = (last_packet_us == 0) ||
                                ((now_us - last_packet_us) > (ARKART_WATCHDOG_MS * 1000));

        if (wd_expired) {
            if (!tripped) {
                ESP_LOGW(TAG, "watchdog: no valid packet for %d ms — motors off",
                         ARKART_WATCHDOG_MS);
                tripped = true;
            }
            /* Hold the command at neutral so that when the link returns, the ramp starts from
             * a stop instead of snapping back to the last commanded throttle. */
            cmd_throttle = 0;
            cmd_steer    = 0;
            cmd_flags    = 0;
            ACTUATE_OFF();
            last_tick_us = now_us;
        } else if ((now_us - last_tick_us) >= (ARKART_CONTROL_TICK_MS * 1000)) {
            /* Fixed 50 Hz actuation cadence, independent of packet rate. Under Plan M that is
             * what makes drive.c's slew limit a predictable duty-per-second; under the button
             * tap it is also what feeds btn_remote's 300 ms command leash. */
            last_tick_us = now_us;
            ACTUATE(cmd_throttle, cmd_steer, cmd_flags);
        }

        atomic_store(&s_link_alive, !tripped);

        /* ---- status pixel --------------------------------------------------------------
         * Precedence is "what is actionable": while packets are arriving the link is proof
         * that the network is fine, so the shield colour wins — a cyan pixel means a shield is
         * up and a dim green one means armed-and-idle. Only once the link is DEAD does the
         * pixel distinguish between the two reasons it can be dead (no WiFi at all, or WiFi up
         * but nothing sending). */
        if (tripped) {
            status_led_set(wifi_sta_is_connected() ? LED_STATE_WATCHDOG : LED_STATE_NO_WIFI);
        } else if (cmd_flags & ARKART_FLAG_SHIELD) {
            status_led_set(LED_STATE_SHIELD);
        } else {
            status_led_set(LED_STATE_IDLE);
        }
    }
}

esp_err_t control_udp_start(uint8_t kart_id, uint16_t port)
{
    control_cfg_t *cfg = calloc(1, sizeof(control_cfg_t));
    if (cfg == NULL) {
        return ESP_ERR_NO_MEM;
    }
    cfg->kart_id = kart_id;
    cfg->port    = port;

    /* Core 1, above the LED task. Core 0 carries WiFi and the blocking MJPEG handler; keeping
     * actuation off that core is what stops a stalled video stream from stalling steering. */
    if (xTaskCreatePinnedToCore(control_task, "arkart_ctl", 4096, cfg, 6, NULL, 1) != pdPASS) {
        free(cfg);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool control_udp_link_alive(void)
{
    return atomic_load(&s_link_alive);
}
