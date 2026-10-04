/*
 * ir_tag.c — the AR Kart TV-remote-style 38 kHz IR tag layer. See ir_tag.h for the design note
 * and ir_tag_codec.h for the normative on-air format.
 *
 * Layout of this file:
 *   1. configuration + counters
 *   2. TX  — RMT channel with the hardware 38 kHz carrier, burst builder, ir_tag_fire()
 *   3. RX  — GPIO3 edge ISR, edge queue, decoder task, lockout
 *   4. OUT — report task: one report_hit HTTP call per accepted hit
 *   5. test hooks + console surface (irtx / irstat / irtest / ircheck / set ir_*)
 */

#include "ir_tag.h"

#include "ir_tag_codec.h"
#include "ir_tag_pins.h"
#include "wifi_sta.h"

#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "driver/gpio.h"
#include "driver/pulse_cnt.h"
#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "esp_attr.h"
#include "esp_clk_tree.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "soc/gpio_struct.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "ir_tag";

#define IR_TX_PIN   ((gpio_num_t)ARKART_PIN_IR_TAG_TX_RESERVED)   /* GPIO14, IR LED + 100 R */
#define IR_RX_PIN   ((gpio_num_t)ARKART_PIN_IR_TAG_RX_RESERVED)   /* GPIO3,  TSSP77038 OUT  */

/* 1 RMT tick = 1 us. The CARRIER divider is derived from the RMT GROUP clock, not from this
 * resolution (esp_driver_rmt/src/rmt_tx.c: total_ticks = group->resolution_hz / frequency_hz),
 * so a convenient 1 MHz channel costs nothing in carrier accuracy — and it keeps every interval,
 * including the 20 ms inter-copy gap, inside one 15-bit RMT duration field. */
#define IR_RMT_RESOLUTION_HZ   1000000u

#define IR_EDGE_QUEUE_LEN       256
#define IR_POST_QUEUE_LEN         4
#define IR_MAX_SYMBOLS          128   /* 10 symbols per copy -> up to 12 copies */
#define IR_MAX_REPEATS            8

/* Any interval longer than this cannot be part of a legal frame (the longest is the 2400 us
 * header mark, whose upper tolerance bound is 3120 us). Treated as idle: the state machine is
 * reset SILENTLY, so a long gap is not counted as a framing error. */
#define IR_MAX_INTERVAL_US     4000u

/* ---------------------------------------------------------------------------------------- */
/* 1. configuration + counters                                                              */
/* ---------------------------------------------------------------------------------------- */

typedef struct {
    uint32_t ts;        /* low 32 bits of esp_timer_get_time(), us — wrap-safe in subtraction */
    uint8_t  level;     /* the level AFTER the edge: 1 = a MARK just ended, 0 = a SPACE did   */
} ir_edge_t;

static bool              s_ready     = false;
static uint8_t           s_my_id     = 0;        /* this kart, 1..15 to be encodable */
static bool              s_id_ok     = false;

static rmt_channel_handle_t s_tx_chan = NULL;
static rmt_encoder_handle_t s_tx_enc  = NULL;
static SemaphoreHandle_t    s_tx_lock = NULL;

static QueueHandle_t     s_edges     = NULL;
static QueueHandle_t     s_posts     = NULL;

/* tunables — written by the console, read by the decoder/report tasks */
static volatile uint32_t s_lockout_ms = ARKART_IR_LOCKOUT_MS_DEF;
static volatile uint32_t s_repeats    = ARKART_IR_REPEATS_DEF;
/* 0 = off, 1 = on (gated on the WiFi link), 2 = FORCED (bench only — post even with the link
 * down, so the esp_http_client path can be exercised with no access point in the room; the
 * attempt simply fails and is counted). */
static volatile uint8_t  s_post_mode  = 1;

/* counters — only the owning task increments; the console reads them unlocked, which is fine
 * for a printout (see control_udp.h for the same trade). */
static volatile uint32_t s_tx_bursts   = 0;
static volatile uint32_t s_tx_frames   = 0;
static volatile uint32_t s_edges_seen  = 0;
static volatile uint32_t s_isr_drops   = 0;
static volatile uint32_t s_inj_drops   = 0;
static volatile uint32_t s_frames_ok   = 0;   /* framing complete, before the check nibble */
static volatile uint32_t s_bad_frame   = 0;
static volatile uint32_t s_bad_check   = 0;
static volatile uint32_t s_self        = 0;
static volatile uint32_t s_debounce    = 0;
static volatile uint32_t s_hits        = 0;
static volatile uint32_t s_last_shoot  = 0;
static volatile int64_t  s_last_hit_us = 0;
static volatile uint32_t s_post_ok     = 0;
static volatile uint32_t s_post_fail   = 0;
static volatile uint32_t s_post_skip   = 0;
static volatile uint32_t s_post_drop   = 0;
static volatile int      s_post_status = 0;

/* per-shooter lockout: index is the 4-bit shooter id, 0 = never hit by that id */
static int64_t s_seen_us[16];

/* carrier bookkeeping, filled at init so `irstat` can prove the modulation */
static uint32_t s_group_hz    = 0;
static uint32_t s_carrier_div = 0;
static uint32_t s_carrier_hz  = 0;

static char s_url[128];

/* ---------------------------------------------------------------------------------------- */
/* 2. TX                                                                                    */
/* ---------------------------------------------------------------------------------------- */

/* Builds `repeats` copies of one frame into RMT symbols. 19 intervals is odd, so the tenth
 * symbol's second half is free: it carries the inter-copy gap, which also parks the pad low at
 * the end of the burst. Returns the symbol count, or 0 if it does not fit. */
#define IR_SYMS_PER_COPY   ((IR_INTERVALS + 1) / 2)       /* 10 */

static int build_burst(uint8_t payload, int repeats, rmt_symbol_word_t *out, int cap,
                       uint32_t *air_us)
{
    uint16_t iv[IR_INTERVALS];
    const int n = ir_encode_intervals(payload, iv, IR_INTERVALS);
    if (n != IR_INTERVALS || repeats < 1) {
        return 0;
    }
    const int need = IR_SYMS_PER_COPY * repeats;
    if (need > cap) {
        return 0;
    }

    uint32_t frame_us = 0;
    for (int k = 0; k < n; k++) {
        frame_us += iv[k];
    }
    if (air_us != NULL) {
        *air_us = (frame_us + IR_FRAME_GAP_US) * (uint32_t)repeats;
    }

    memset(out, 0, sizeof(rmt_symbol_word_t) * (size_t)need);
    for (int r = 0; r < repeats; r++) {
        rmt_symbol_word_t *f = &out[r * IR_SYMS_PER_COPY];
        for (int k = 0; k < n; k++) {
            rmt_symbol_word_t *w = &f[k / 2];
            if ((k & 1) == 0) {                 /* even index = MARK  = carrier on  */
                w->level0    = 1;
                w->duration0 = iv[k];
            } else {                            /* odd index  = SPACE = carrier off */
                w->level1    = 0;
                w->duration1 = iv[k];
            }
        }
        f[IR_SYMS_PER_COPY - 1].level1    = 0;
        f[IR_SYMS_PER_COPY - 1].duration1 = IR_FRAME_GAP_US;
    }
    return need;
}

/* The one place a burst is actually transmitted. Serialised by s_tx_lock; blocks until the
 * channel has drained so a caller can never overlap two bursts. */
static esp_err_t tx_burst(int repeats)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!s_id_ok) {
        ESP_LOGE(TAG, "kart id %u cannot be carried on air — set ARKART_KART_ID to 1..15",
                 (unsigned)s_my_id);
        return ESP_ERR_INVALID_STATE;
    }
    if (repeats < 1)              repeats = 1;
    if (repeats > IR_MAX_REPEATS) repeats = IR_MAX_REPEATS;

    static rmt_symbol_word_t syms[IR_MAX_SYMBOLS];

    if (xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(1000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    uint32_t air_us = 0;
    const int nsym = build_burst(ir_payload(s_my_id), repeats, syms, IR_MAX_SYMBOLS, &air_us);
    esp_err_t err = (nsym > 0) ? ESP_OK : ESP_ERR_INVALID_SIZE;

    if (err == ESP_OK) {
        const rmt_transmit_config_t tc = {
            .loop_count = 0,
            .flags = { .eot_level = 0 },
        };
        err = rmt_transmit(s_tx_chan, s_tx_enc, syms,
                           sizeof(rmt_symbol_word_t) * (size_t)nsym, &tc);
        if (err == ESP_OK) {
            (void)rmt_tx_wait_all_done(s_tx_chan, pdMS_TO_TICKS(air_us / 1000 + 200));
            s_tx_bursts++;
            s_tx_frames += (uint32_t)repeats;
        } else {
            ESP_LOGE(TAG, "rmt_transmit failed: %s", esp_err_to_name(err));
        }
    }

    xSemaphoreGive(s_tx_lock);
    return err;
}

esp_err_t ir_tag_fire(void)
{
    const int rep = (int)s_repeats;
    const esp_err_t err = tx_burst(rep);
    if (err == ESP_OK) {
        printf("irtx: shooter=%u payload=0x%02X %d copy(ies), carrier %u Hz on GPIO%d\n",
               (unsigned)s_my_id, ir_payload(s_my_id), rep,
               (unsigned)s_carrier_hz, (int)IR_TX_PIN);
    }
    return err;
}

/* ---------------------------------------------------------------------------------------- */
/* 3. RX                                                                                    */
/* ---------------------------------------------------------------------------------------- */

static bool push_edge(uint8_t level, uint32_t ts)
{
    const ir_edge_t e = { .ts = ts, .level = level };
    return xQueueSend(s_edges, &e, 0) == pdTRUE;
}

static void IRAM_ATTR ir_rx_isr(void *arg)
{
    (void)arg;
    const ir_edge_t e = {
        .ts    = (uint32_t)esp_timer_get_time(),
        .level = (uint8_t)gpio_get_level(IR_RX_PIN),
    };
    if (xQueueSendFromISR(s_edges, &e, NULL) != pdTRUE) {
        s_isr_drops++;
    }
}

/* The whole acceptance ladder for one framed payload. Returns the disposition string that goes
 * on the single console line, or NULL when the frame was rejected (counter already bumped). */
static const char *accept_frame(uint8_t payload, uint8_t *out_shooter)
{
    if (!ir_payload_ok(payload)) {
        s_bad_check++;
        return NULL;
    }
    const uint8_t shooter = ir_payload_shooter(payload);
    if (s_id_ok && shooter == s_my_id) {
        s_self++;                      /* our own LED bouncing off a wall — never a hit */
        return NULL;
    }
    const int64_t now = esp_timer_get_time();
    const int64_t prev = s_seen_us[shooter];
    if (prev != 0 && (now - prev) < (int64_t)s_lockout_ms * 1000) {
        s_debounce++;                  /* the 2nd/3rd copy of the same burst */
        return NULL;
    }
    s_seen_us[shooter] = now;
    s_hits++;
    s_last_shoot  = shooter;
    s_last_hit_us = now;
    *out_shooter  = shooter;

    if (s_post_mode == 0) {
        return "off";
    }
    if (s_post_mode == 1 && !wifi_sta_is_connected()) {
        s_post_skip++;
        return "skipped:no-wifi";
    }
    if (xQueueSend(s_posts, &shooter, 0) != pdTRUE) {
        s_post_drop++;
        return "dropped:queue-full";
    }
    return "queued";
}

static void ir_rx_task(void *arg)
{
    (void)arg;

    ir_dec_t dec;
    ir_dec_reset(&dec);

    uint32_t prev_ts  = 0;
    bool     have_prev = false;
    ir_edge_t e;

    for (;;) {
        if (xQueueReceive(s_edges, &e, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        s_edges_seen++;

        if (!have_prev) {
            prev_ts   = e.ts;
            have_prev = true;
            continue;
        }
        const uint32_t dur = e.ts - prev_ts;      /* unsigned: correct across the 71 min wrap */
        prev_ts = e.ts;

        if (dur > IR_MAX_INTERVAL_US) {
            ir_dec_reset(&dec);                   /* idle, not an error */
            continue;
        }

        const ir_dec_ret_t r = ir_dec_feed(&dec, dur, e.level != 0);
        if (r == IR_DEC_ABORT) {
            s_bad_frame++;
            continue;
        }
        if (r != IR_DEC_FRAME) {
            continue;
        }
        s_frames_ok++;

        uint8_t shooter = 0;
        const char *disp = accept_frame(dec.payload, &shooter);
        if (disp == NULL) {
            continue;
        }
        /* The ONE per-event line. Everything else about the IR layer is on demand via irstat. */
        ESP_LOGI(TAG, "IR HIT shooter=%u victim=%u post=%s",
                 (unsigned)shooter, (unsigned)s_my_id, disp);
    }
}

/* ---------------------------------------------------------------------------------------- */
/* 4. OUT — report_hit                                                                      */
/* ---------------------------------------------------------------------------------------- */

/*
 * POST /v1/database/<db>/call/report_hit   body: [shooter, victim]
 *
 * Exactly the convention the vision bridge uses for report_gate
 * (vision/arkart_vision/reducer.py): the body is a JSON array of POSITIONAL arguments and the
 * request is anonymous (no Authorization header), which the SpacetimeDB HTTP API accepts.
 * Signature confirmed against the live module:
 *     spacetime describe arkart reducer report_hit --json  ->  shooter: U32, victim: U32
 */
static void post_report_hit(uint8_t shooter)
{
    char body[32];
    snprintf(body, sizeof(body), "[%u,%u]", (unsigned)shooter, (unsigned)s_my_id);

    const esp_http_client_config_t cfg = {
        .url        = s_url,
        .method     = HTTP_METHOD_POST,
        .timeout_ms = 1500,
    };
    esp_http_client_handle_t cli = esp_http_client_init(&cfg);
    if (cli == NULL) {
        s_post_fail++;
        return;
    }
    esp_http_client_set_header(cli, "Content-Type", "application/json");
    esp_http_client_set_post_field(cli, body, (int)strlen(body));

    const esp_err_t err = esp_http_client_perform(cli);
    if (err == ESP_OK) {
        s_post_status = esp_http_client_get_status_code(cli);
        if (s_post_status >= 200 && s_post_status < 300) {
            s_post_ok++;
        } else {
            s_post_fail++;
            ESP_LOGW(TAG, "report_hit(%u,%u) -> HTTP %d",
                     (unsigned)shooter, (unsigned)s_my_id, s_post_status);
        }
    } else {
        s_post_fail++;
        s_post_status = -1;
        ESP_LOGW(TAG, "report_hit(%u,%u) POST failed: %s",
                 (unsigned)shooter, (unsigned)s_my_id, esp_err_to_name(err));
    }
    esp_http_client_cleanup(cli);
}

static void ir_post_task(void *arg)
{
    (void)arg;
    uint8_t shooter = 0;
    for (;;) {
        if (xQueueReceive(s_posts, &shooter, portMAX_DELAY) == pdTRUE) {
            post_report_hit(shooter);
        }
    }
}

/* ---------------------------------------------------------------------------------------- */
/* 5. test hooks + console surface                                                          */
/* ---------------------------------------------------------------------------------------- */

esp_err_t ir_tag_test_inject(uint32_t shooter, int repeats, ir_test_mode_t mode)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!ir_id_valid(shooter)) {
        printf("irtest: shooter id must be 1..15 (0 and >15 are not encodable)\n");
        return ESP_ERR_INVALID_ARG;
    }
    if (repeats < 1)              repeats = 1;
    if (repeats > IR_MAX_REPEATS) repeats = IR_MAX_REPEATS;

    uint8_t payload = ir_payload((uint8_t)shooter);
    const char *mname = "clean";
    if (mode == IR_TEST_BAD) {
        payload ^= 0x01u;                       /* check nibble no longer complements the id */
        mname = "bad-check";
    }

    uint16_t iv[IR_INTERVALS];
    const int n = ir_encode_intervals(payload, iv, IR_INTERVALS);
    if (n != IR_INTERVALS) {
        return ESP_FAIL;
    }
    if (mode == IR_TEST_GLITCH) {
        iv[2] = 2000;                           /* first bit's MARK, far out of spec */
        mname = "glitch";
    }

    /* Synthesise the TSSP77038's own output: idle HIGH, LOW for the length of each mark. The
     * edges go into the SAME queue the ISR feeds, so the decode path is bit-identical. */
    uint32_t t = (uint32_t)esp_timer_get_time();
    int pushed = 0, dropped = 0;
    for (int r = 0; r < repeats; r++) {
        t += (r == 0) ? 2000u : IR_FRAME_GAP_US;    /* idle before this copy */
        if (push_edge(0, t)) pushed++; else dropped++;   /* falling: first mark begins */
        for (int k = 0; k < n; k++) {
            t += iv[k];
            /* even index = a MARK ended -> line returns HIGH; odd = a SPACE ended -> LOW */
            if (push_edge((k & 1) ? 0u : 1u, t)) pushed++; else dropped++;
        }
    }
    s_inj_drops += (uint32_t)dropped;

    printf("irtest: %d copy(ies) of payload 0x%02X (shooter %u, %s) -> %d synthetic edges"
           "%s\n", repeats, payload, (unsigned)shooter, mname, pushed,
           dropped ? " (QUEUE FULL, some dropped)" : "");
    return ESP_OK;
}

/* `ircheck` transmits ONE long unmodulated-data symbol — a continuous carrier — instead of a
 * frame, so the measurement window is unambiguous and the arithmetic has no payload in it.
 * 25 ms is the longest that still fits one 15-bit RMT duration field at 1 MHz. Non-blocking:
 * the caller counts edges while it plays. */
#define IR_CHECK_CARRIER_US   25000u
#define IR_CHECK_POLL_US       5000u

static esp_err_t tx_continuous_carrier(void)
{
    static rmt_symbol_word_t one;
    one.level0    = 1;                       /* carrier ON for the whole duration */
    one.duration0 = IR_CHECK_CARRIER_US;
    one.level1    = 0;
    one.duration1 = 100;
    const rmt_transmit_config_t tc = { .loop_count = 0, .flags = { .eot_level = 0 } };
    return rmt_transmit(s_tx_chan, s_tx_enc, &one, sizeof(one), &tc);
}

esp_err_t ir_tag_carrier_check(void)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }

    pcnt_unit_handle_t unit = NULL;
    pcnt_channel_handle_t chan = NULL;
    const pcnt_unit_config_t ucfg = { .low_limit = -1, .high_limit = 30000 };
    esp_err_t err = pcnt_new_unit(&ucfg, &unit);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "pcnt_new_unit failed: %s", esp_err_to_name(err));
        return err;
    }

    /*
     * THE TRAP, and why the two lines around pcnt_new_channel() are not optional.
     *
     * pcnt_new_channel() runs gpio_config() on the edge pin. Any mode with an output bit —
     * which `io_loop_back` sets, and which we NEED so the pad keeps driving the LED — makes
     * gpio_config() call gpio_output_enable(), and that ends with
     *
     *     esp_rom_gpio_connect_out_signal(gpio_num, SIG_GPIO_OUT_IDX, false, false);
     *
     * (esp_driver_gpio/src/gpio.c:218). SIG_GPIO_OUT_IDX means "the plain GPIO output
     * register drives this pad", so the RMT TX signal is silently unrouted and the pad goes
     * dead: the first version of this function measured 0 Hz for exactly that reason.
     *
     * GPIO.func_out_sel_cfg[pin] IS that routing. Saving it before and writing it back after
     * re-attaches whichever RMT channel we were given without this module having to know its
     * channel id, and gpio_config() never touched the INPUT routing PCNT just installed.
     */
    const uint32_t saved_out_sel = GPIO.func_out_sel_cfg[(int)IR_TX_PIN].val;

    const pcnt_chan_config_t ccfg = {
        .edge_gpio_num  = (int)IR_TX_PIN,
        .level_gpio_num = -1,
        .flags = { .io_loop_back = 1 },      /* keep the pad an output as well as an input */
    };
    err = pcnt_new_channel(unit, &ccfg, &chan);

    GPIO.func_out_sel_cfg[(int)IR_TX_PIN].val = saved_out_sel;   /* give the pad back to RMT */

    if (err == ESP_OK) {
        err = pcnt_channel_set_edge_action(chan, PCNT_CHANNEL_EDGE_ACTION_INCREASE,
                                                 PCNT_CHANNEL_EDGE_ACTION_HOLD);
    }
    if (err == ESP_OK) {
        err = pcnt_channel_set_level_action(chan, PCNT_CHANNEL_LEVEL_ACTION_KEEP,
                                                  PCNT_CHANNEL_LEVEL_ACTION_KEEP);
    }
    if (err == ESP_OK) err = pcnt_unit_enable(unit);
    if (err == ESP_OK) err = pcnt_unit_clear_count(unit);
    if (err == ESP_OK) err = pcnt_unit_start(unit);

    int      count    = 0;
    uint32_t poll_rise = 0;
    uint32_t poll_us   = 0;

    if (err == ESP_OK) {
        if (xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(1000)) != pdTRUE) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = tx_continuous_carrier();
            if (err == ESP_OK) {
                /* Independent cross-check: count the pad's rising edges with the CPU while
                 * the carrier plays. Interrupts stay enabled, so this reads a few tenths of a
                 * percent low — it is a sanity check on PCNT, not the primary number. */
                esp_rom_delay_us(1500);                 /* let the transfer get going */
                const int64_t t0 = esp_timer_get_time();
                int prev = gpio_get_level(IR_TX_PIN);
                int64_t t1 = t0;
                do {
                    const int now = gpio_get_level(IR_TX_PIN);
                    if (now && !prev) poll_rise++;
                    prev = now;
                    t1 = esp_timer_get_time();
                } while ((uint32_t)(t1 - t0) < IR_CHECK_POLL_US);
                poll_us = (uint32_t)(t1 - t0);
                (void)rmt_tx_wait_all_done(s_tx_chan, pdMS_TO_TICKS(200));
                s_tx_bursts++;
            }
            xSemaphoreGive(s_tx_lock);
        }
        (void)pcnt_unit_stop(unit);
        (void)pcnt_unit_get_count(unit, &count);
    }

    (void)pcnt_unit_disable(unit);
    if (chan) (void)pcnt_del_channel(chan);
    (void)pcnt_del_unit(unit);
    GPIO.func_out_sel_cfg[(int)IR_TX_PIN].val = saved_out_sel;   /* and again after teardown */

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ircheck failed: %s", esp_err_to_name(err));
        return err;
    }

    const uint32_t pcnt_hz = (count > 0)
        ? (uint32_t)(((uint64_t)count * 1000000ull) / IR_CHECK_CARRIER_US) : 0;
    const uint32_t poll_hz = (poll_us > 0)
        ? (uint32_t)(((uint64_t)poll_rise * 1000000ull) / poll_us) : 0;

    printf("ircheck: GPIO%d, one continuous %u us carrier burst\n",
           (int)IR_TX_PIN, (unsigned)IR_CHECK_CARRIER_US);
    printf("         PCNT   %d rising edges over %u us        -> %u Hz\n",
           count, (unsigned)IR_CHECK_CARRIER_US, (unsigned)pcnt_hz);
    printf("         CPU    %u rising edges over %u us        -> %u Hz (approx, IRQs on)\n",
           (unsigned)poll_rise, (unsigned)poll_us, (unsigned)poll_hz);
    printf("         RMT    group clock %u Hz / div %u         -> %u Hz (nominal %u, duty %.2f)\n",
           (unsigned)s_group_hz, (unsigned)s_carrier_div, (unsigned)s_carrier_hz,
           (unsigned)IR_CARRIER_HZ, (double)IR_CARRIER_DUTY);
    if (count == 0 && poll_rise == 0) {
        printf("         0 edges on BOTH counters: the pad's input path never reached them —\n"
               "         the RMT divider line above is still authoritative for the carrier.\n");
    }
    return ESP_OK;
}

void ir_tag_status(void)
{
    const int64_t now = esp_timer_get_time();
    char ip[16];
    wifi_sta_ip_str(ip, sizeof(ip));

    printf("-- ir tag ------------------------------------------------------------\n");
    printf("  state      %s   kart_id %u (%s)   post %s\n",
           s_ready ? "ready" : "NOT INITIALISED", (unsigned)s_my_id,
           s_id_ok ? "encodable" : "NOT ENCODABLE, needs 1..15",
           (s_post_mode == 0) ? "off" : (s_post_mode == 1) ? "on" : "FORCED (bench)");
    printf("  pins       TX GPIO%-2d (IR LED + 100R, forward)    RX GPIO%-2d (TSSP77038 OUT)\n",
           (int)IR_TX_PIN, (int)IR_RX_PIN);
    printf("  carrier    %u Hz achieved  (group %u Hz / div %u; nominal %u, duty %.2f)\n",
           (unsigned)s_carrier_hz, (unsigned)s_group_hz, (unsigned)s_carrier_div,
           (unsigned)IR_CARRIER_HZ, (double)IR_CARRIER_DUTY);
    printf("  frame      hdr %u/%u us, bit mark %u us, space %u=0 / %u=1, trail %u us\n",
           (unsigned)IR_HDR_MARK_US, (unsigned)IR_HDR_SPACE_US, (unsigned)IR_BIT_MARK_US,
           (unsigned)IR_ZERO_SPACE_US, (unsigned)IR_ONE_SPACE_US, (unsigned)IR_TRAIL_MARK_US);
    printf("  burst      %u copy(ies), %u us gap   lockout %u ms per shooter id\n",
           (unsigned)s_repeats, (unsigned)IR_FRAME_GAP_US, (unsigned)s_lockout_ms);
    printf("  TX         %u burst(s), %u frame(s) on air\n",
           (unsigned)s_tx_bursts, (unsigned)s_tx_frames);
    printf("  RX         %u edges, %u framed, %u HIT(s)\n",
           (unsigned)s_edges_seen, (unsigned)s_frames_ok, (unsigned)s_hits);
    printf("  rejects    bad_frame %u  bad_check %u  self %u  debounce %u\n",
           (unsigned)s_bad_frame, (unsigned)s_bad_check, (unsigned)s_self,
           (unsigned)s_debounce);
    printf("  queue      isr_drops %u  inject_drops %u\n",
           (unsigned)s_isr_drops, (unsigned)s_inj_drops);
    if (s_hits > 0) {
        printf("  last hit   shooter %u, %lld ms ago\n",
               (unsigned)s_last_shoot, (long long)((now - s_last_hit_us) / 1000));
    } else {
        printf("  last hit   none\n");
    }
    printf("  report     %s\n", s_url);
    printf("             ok %u  fail %u  skipped(no wifi) %u  dropped %u  last HTTP %d\n",
           (unsigned)s_post_ok, (unsigned)s_post_fail, (unsigned)s_post_skip,
           (unsigned)s_post_drop, s_post_status);
    printf("             wifi %s ip %s\n", wifi_sta_is_connected() ? "up" : "DOWN", ip);
    printf("----------------------------------------------------------------------\n");
}

esp_err_t ir_tag_cfg_set(const char *key, long value)
{
    if (key == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    if (strcasecmp(key, "ir_lockout_ms") == 0) {
        if (value < 0 || value > 10000) {
            printf("ir_lockout_ms: 0..10000 (0 disables the debounce entirely)\n");
            return ESP_ERR_INVALID_ARG;
        }
        s_lockout_ms = (uint32_t)value;
        printf("ir_lockout_ms = %u\n", (unsigned)s_lockout_ms);
        return ESP_OK;
    }
    if (strcasecmp(key, "ir_repeats") == 0) {
        if (value < 1 || value > IR_MAX_REPEATS) {
            printf("ir_repeats: 1..%d\n", IR_MAX_REPEATS);
            return ESP_ERR_INVALID_ARG;
        }
        s_repeats = (uint32_t)value;
        printf("ir_repeats = %u\n", (unsigned)s_repeats);
        return ESP_OK;
    }
    if (strcasecmp(key, "ir_post") == 0) {
        if (value < 0 || value > 2) {
            printf("ir_post: 0 = off, 1 = on (needs the WiFi link), 2 = forced (bench)\n");
            return ESP_ERR_INVALID_ARG;
        }
        s_post_mode = (uint8_t)value;
        printf("ir_post = %u (%s)\n", (unsigned)s_post_mode,
               (s_post_mode == 0) ? "off" : (s_post_mode == 1) ? "on" : "FORCED, bench only");
        return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}

void ir_tag_print_help(void)
{
    printf("-- ir tag (38 kHz TV-remote-style) -----------------------------------\n");
    printf("  irtx                     fire one burst on GPIO%d now\n", (int)IR_TX_PIN);
    printf("  irstat                   TX/RX counters, rejects, carrier, post state\n");
    printf("  irtest <id> [n|bad|glitch]  replay a synthetic burst through the real\n");
    printf("                           decoder: n copies (default 1), `bad` = wrong\n");
    printf("                           check nibble, `glitch` = broken framing\n");
    printf("  ircheck                  measure the carrier on-chip with PCNT\n");
    printf("  set ir_lockout_ms <ms>   per-shooter debounce window (default %d)\n",
           ARKART_IR_LOCKOUT_MS_DEF);
    printf("  set ir_repeats <1..%d>    frame copies per burst (default %d)\n",
           IR_MAX_REPEATS, ARKART_IR_REPEATS_DEF);
    printf("  set ir_post <0|1|2>      report_hit posting: off / on / forced (bench,\n");
    printf("                           posts with the link down so the HTTP path runs)\n");
    printf("----------------------------------------------------------------------\n");
}

/* ---------------------------------------------------------------------------------------- */
/* init                                                                                     */
/* ---------------------------------------------------------------------------------------- */

esp_err_t ir_tag_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    s_my_id = (uint8_t)CONFIG_ARKART_KART_ID;
    s_id_ok = ir_id_valid(s_my_id);
    memset(s_seen_us, 0, sizeof(s_seen_us));

    snprintf(s_url, sizeof(s_url), "http://%s:%d/v1/database/%s/call/report_hit",
             CONFIG_ARKART_STDB_HOST, CONFIG_ARKART_STDB_PORT, CONFIG_ARKART_STDB_DB);

    s_edges = xQueueCreate(IR_EDGE_QUEUE_LEN, sizeof(ir_edge_t));
    s_posts = xQueueCreate(IR_POST_QUEUE_LEN, sizeof(uint8_t));
    s_tx_lock = xSemaphoreCreateMutex();
    if (s_edges == NULL || s_posts == NULL || s_tx_lock == NULL) {
        ESP_LOGE(TAG, "out of memory");
        return ESP_ERR_NO_MEM;
    }

    /* ---- TX: RMT channel + hardware 38 kHz carrier ---- */
    const rmt_tx_channel_config_t chan_cfg = {
        .gpio_num          = IR_TX_PIN,
        .clk_src           = RMT_CLK_SRC_APB,
        .resolution_hz     = IR_RMT_RESOLUTION_HZ,
        .mem_block_symbols = 48,                 /* one S3 RMT block; bursts stream if longer */
        .trans_queue_depth = 2,
        /* io_loop_back feeds the pad back into the input matrix so `ircheck` can count the
         * carrier with PCNT. It does not change what the pad drives. */
        .flags = { .io_loop_back = 1 },
    };
    esp_err_t err = rmt_new_tx_channel(&chan_cfg, &s_tx_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_tx_channel(GPIO%d) failed: %s", (int)IR_TX_PIN,
                 esp_err_to_name(err));
        return err;
    }
    const rmt_copy_encoder_config_t enc_cfg = {};
    err = rmt_new_copy_encoder(&enc_cfg, &s_tx_enc);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_copy_encoder failed: %s", esp_err_to_name(err));
        return err;
    }
    err = rmt_enable(s_tx_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_enable failed: %s", esp_err_to_name(err));
        return err;
    }
    const rmt_carrier_config_t cc = {
        .frequency_hz = IR_CARRIER_HZ,
        .duty_cycle   = IR_CARRIER_DUTY,
        .flags = { .polarity_active_low = 0 },   /* carrier rides on the MARK (high) level */
    };
    err = rmt_apply_carrier(s_tx_chan, &cc);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_apply_carrier(38 kHz) failed: %s", esp_err_to_name(err));
        return err;
    }

    /* The driver derives the carrier divider from the RMT GROUP clock, not from the channel
     * resolution (esp_driver_rmt/src/rmt_tx.c:879). Reproduce its arithmetic so `irstat` can
     * state the achieved frequency instead of the requested one. */
    if (esp_clk_tree_src_get_freq_hz((soc_module_clk_t)RMT_CLK_SRC_APB,
                                     ESP_CLK_TREE_SRC_FREQ_PRECISION_CACHED,
                                     &s_group_hz) != ESP_OK || s_group_hz == 0) {
        s_group_hz = 80000000u;                  /* APB default on the S3 */
    }
    s_carrier_div = s_group_hz / IR_CARRIER_HZ;
    s_carrier_hz  = (s_carrier_div > 0) ? (s_group_hz / s_carrier_div) : 0;

    /* ---- RX: GPIO3 edge ISR ---- */
    const gpio_config_t rx_cfg = {
        .pin_bit_mask = 1ULL << (int)IR_RX_PIN,
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_ENABLE,      /* TSSP OUT is idle-high; also keeps an
                                                  * UNCONNECTED pin quiet (no phantom edges) */
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_ANYEDGE,
    };
    err = gpio_config(&rx_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_config(GPIO%d) failed: %s", (int)IR_RX_PIN, esp_err_to_name(err));
        return err;
    }
    err = gpio_install_isr_service(0);
    if (err == ESP_ERR_INVALID_STATE) {
        err = ESP_OK;                            /* someone else already installed it */
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_install_isr_service failed: %s", esp_err_to_name(err));
        return err;
    }
    err = gpio_isr_handler_add(IR_RX_PIN, ir_rx_isr, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_isr_handler_add(GPIO%d) failed: %s", (int)IR_RX_PIN,
                 esp_err_to_name(err));
        return err;
    }

    /* Decoder on core 1 (prio 5: under the 50 Hz control task at 6, over the button tap at 4),
     * reporter on core 0 with WiFi and the HTTP stack. */
    if (xTaskCreatePinnedToCore(ir_rx_task, "arkart_irrx", 3072, NULL, 5, NULL, 1) != pdPASS) {
        ESP_LOGE(TAG, "failed to create the IR decoder task");
        return ESP_ERR_NO_MEM;
    }
    if (xTaskCreatePinnedToCore(ir_post_task, "arkart_irpost", 5120, NULL, 3, NULL, 0) != pdPASS) {
        ESP_LOGE(TAG, "failed to create the IR report task");
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    ESP_LOGI(TAG, "IR tag ready — TX GPIO%d @ %u Hz, RX GPIO%d, kart %u%s, report %s",
             (int)IR_TX_PIN, (unsigned)s_carrier_hz, (int)IR_RX_PIN, (unsigned)s_my_id,
             s_id_ok ? "" : " (NOT ENCODABLE — needs 1..15)", s_url);
    return ESP_OK;
}
