/*
 * rx_inject.c — Plan RX backend: bit-bang the stock decoder's radio protocol on GPIO47.
 *
 * Target: SA1607RX 330 (SOP-16), an RX-2B-family five-function 27 MHz toy receiver-decoder.
 * The wire lands on its demodulated-data input, pin 14 (equivalently the radio socket's DATA
 * pad, which is the same net); ESP32 GND goes to the board's V- hole; the car batteries keep
 * powering the board.
 *
 * Implements the drive.h contract (drive_init / drive_apply / drive_all_off /
 * drive_current_duty) so control_udp.c and arkart_main.c are unchanged. Exactly one of
 * drive.c (Plan M) and this file is compiled — see main/CMakeLists.txt.
 *
 * Protocol, confidence levels and the throttle/steer mapping are documented in rx_inject.h.
 */

#include "rx_inject.h"

#include "drive.h"
#include "motor_map.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "driver/gpio.h"
#include "driver/rmt_common.h"
#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "rx_inject";

/* ------------------------------------------------------------------------------------------
 * Compile-time guards. Everything user-tunable has a hard bound in rx_inject.h; these make
 * sure the DEFAULTS sit inside those bounds and that the bounds themselves are physically
 * implementable, so a bad edit fails the build instead of the kart.
 * ---------------------------------------------------------------------------------------- */

/* One RMT symbol half is a 15-bit duration field. At the 1 MHz resolution we use, one tick is
 * 1 us, so a single pulse half must stay under 32768 us. */
#define RX_RMT_RESOLUTION_HZ    1000000u
#define RX_RMT_MAX_TICKS        32767u

_Static_assert(RX_PERIOD_US_MAX <= RX_RMT_MAX_TICKS,
               "RX_PERIOD_US_MAX must fit one RMT symbol half at 1 us resolution");
_Static_assert(RX_PERIOD_US_MIN >= 2 && RX_PERIOD_US_MIN < RX_PERIOD_US_MAX,
               "period bounds are inverted or too small to split into high+low");
_Static_assert(RX_DUTY_PCT_MIN >= 1 && RX_DUTY_PCT_MAX <= 99,
               "duty must leave a non-zero high AND low half");
_Static_assert(RX_WINDOW_MIN >= 1, "a throttle window of zero frames would divide by zero");
_Static_assert(RX_PULSES_MIN >= 1 && RX_PULSES_MAX <= 255,
               "pulse counts are held in a uint16 but bounded to a sane toy-protocol range");
_Static_assert(RX_LADDER_BASE + RX_LADDER_STEP * (RX_FN_COUNT - 1) <= RX_PULSES_MAX,
               "the default function ladder does not fit inside RX_PULSES_MAX");

_Static_assert(RX_DEF_PERIOD_US   >= RX_PERIOD_US_MIN && RX_DEF_PERIOD_US <= RX_PERIOD_US_MAX,
               "RX_DEF_PERIOD_US out of bounds");
_Static_assert(RX_DEF_DUTY_PCT    >= RX_DUTY_PCT_MIN  && RX_DEF_DUTY_PCT  <= RX_DUTY_PCT_MAX,
               "RX_DEF_DUTY_PCT out of bounds");
_Static_assert(RX_DEF_W1_PULSES   <= RX_W1_MAX,           "RX_DEF_W1_PULSES out of bounds");
_Static_assert(RX_DEF_SGAP_US     <= RX_SGAP_US_MAX,      "RX_DEF_SGAP_US out of bounds");
_Static_assert(RX_DEF_GAP_MS      <= RX_GAP_MS_MAX,       "RX_DEF_GAP_MS out of bounds");
_Static_assert(RX_DEF_WINDOW      >= RX_WINDOW_MIN && RX_DEF_WINDOW <= RX_WINDOW_MAX,
               "RX_DEF_WINDOW out of bounds");
_Static_assert(RX_DEF_THR_MIN_PCT <= 100,                 "RX_DEF_THR_MIN_PCT out of bounds");
_Static_assert(RX_DEF_OFFSLOT_MS  <= RX_OFFSLOT_MS_MAX,   "RX_DEF_OFFSLOT_MS out of bounds");
_Static_assert(RX_DEF_HOLD_MS     >= RX_HOLD_MS_MIN && RX_DEF_HOLD_MS <= RX_HOLD_MS_MAX,
               "RX_DEF_HOLD_MS out of bounds");
_Static_assert(RX_DEF_SWEEPGAP_MS <= RX_SWEEPGAP_MS_MAX,  "RX_DEF_SWEEPGAP_MS out of bounds");
_Static_assert(RX_DEF_SNIFFGAP_US >= RX_SNIFFGAP_US_MIN && RX_DEF_SNIFFGAP_US <= RX_SNIFFGAP_US_MAX,
               "RX_DEF_SNIFFGAP_US out of bounds");
_Static_assert(RX_DEF_SNIFFREP_MS >= RX_SNIFFREP_MS_MIN && RX_DEF_SNIFFREP_MS <= RX_SNIFFREP_MS_MAX,
               "RX_DEF_SNIFFREP_MS out of bounds");
_Static_assert(RX_SNIFFGAP_US_MAX <= 65535 && RX_SNIFFREP_MS_MAX <= 65535,
               "sniff bounds must fit the uint16_t fields they are stored in");
/* The burst splitter can only separate an intra-frame section gap from an inter-frame gap if
 * the burst-closing threshold can be set above the former and below the latter. */
_Static_assert(RX_SNIFFGAP_US_MIN < RX_DEF_SNIFFGAP_US && RX_DEF_SNIFFGAP_US < RX_SNIFFGAP_US_MAX,
               "the default sniff gap must sit inside its own adjustable range");
_Static_assert(RX_DEF_INVERT      <= 1 && RX_DEF_STEERFILL <= 1, "flags are 0 or 1");
_Static_assert(ARKART_STEER_DEADBAND <= 100,
               "ARKART_STEER_DEADBAND is on the wire's 0..100 steer scale");

/* Pin sanity. The camera owns GPIO 4-13 and 15-18; the WS2812 owns 48. Injecting the radio
 * protocol into either would be a very confusing afternoon. */
_Static_assert(!(ARKART_PIN_RX_DATA >= 4  && ARKART_PIN_RX_DATA <= 13) &&
               !(ARKART_PIN_RX_DATA >= 15 && ARKART_PIN_RX_DATA <= 18),
               "ARKART_PIN_RX_DATA collides with a camera pin (GPIO 4-13 / 15-18)");
_Static_assert(ARKART_PIN_RX_DATA != ARKART_PIN_STATUS_LED,
               "ARKART_PIN_RX_DATA collides with the WS2812 status pixel");
_Static_assert(ARKART_PIN_RX_DATA >= 0 && ARKART_PIN_RX_DATA <= 48,
               "ARKART_PIN_RX_DATA is not a GPIO on this part");

/* Worst-case frame: the longest W1 section, the longest code section, and up to four symbols
 * of gap (sgap + inter-frame gap, each split across at most two symbols). */
#define RX_GAP_SYM_SLACK    8
#define RX_SYM_CAP          (RX_W1_MAX + RX_PULSES_MAX + RX_GAP_SYM_SLACK)
_Static_assert(RX_SYM_CAP >= RX_W1_MAX + RX_PULSES_MAX + 4,
               "symbol buffer cannot hold a worst-case frame");

/* ------------------------------------------------------------------------------------------
 * Module state
 * ---------------------------------------------------------------------------------------- */

typedef enum {
    RX_MODE_IDLE = 0,   /* not transmitting; the decoder releases the motors            */
    RX_MODE_DRIVE,      /* the normal (throttle, steer) mapping                         */
    RX_MODE_RAW,        /* hold one raw pulse count (console `code`)                    */
    RX_MODE_SWEEP,      /* walk a range of pulse counts (console `sweep`)               */
    RX_MODE_SNIFF,      /* transmit NOTHING; listen on the wire (console `sniff`)       */
} rx_mode_t;

static rx_cfg_t s_cfg = {
    .period_us   = RX_DEF_PERIOD_US,
    .sgap_us     = RX_DEF_SGAP_US,
    .gap_ms      = RX_DEF_GAP_MS,
    .offslot_ms  = RX_DEF_OFFSLOT_MS,
    .hold_ms     = RX_DEF_HOLD_MS,
    .sweepgap_ms = RX_DEF_SWEEPGAP_MS,
    .sniffgap_us = RX_DEF_SNIFFGAP_US,
    .sniffrep_ms = RX_DEF_SNIFFREP_MS,
    .carrier_khz = RX_DEF_CARRIER_KHZ,
    .duty_pct    = RX_DEF_DUTY_PCT,
    .w1_pulses   = RX_DEF_W1_PULSES,
    .w1_mult     = RX_DEF_W1_MULT,
    .window      = RX_DEF_WINDOW,
    .thr_min_pct = RX_DEF_THR_MIN_PCT,
    .deadband    = ARKART_STEER_DEADBAND,
    .invert      = RX_DEF_INVERT,
    .steerfill   = RX_DEF_STEERFILL,
    /* The ladder: base 10, step 6. See the confidence table in rx_inject.h — the sweep is
     * the ground truth and `set code <name> <n>` writes the answer back. */
    .code = {
        [RX_FN_FORWARD]        = RX_LADDER_BASE + RX_LADDER_STEP * 0,   /* 10 */
        [RX_FN_TURBO]          = RX_LADDER_BASE + RX_LADDER_STEP * 1,   /* 16 */
        [RX_FN_SLOT2]          = RX_LADDER_BASE + RX_LADDER_STEP * 2,   /* 22 */
        [RX_FN_FORWARD_LEFT]   = RX_LADDER_BASE + RX_LADDER_STEP * 3,   /* 28 */
        [RX_FN_FORWARD_RIGHT]  = RX_LADDER_BASE + RX_LADDER_STEP * 4,   /* 34 */
        [RX_FN_BACKWARD]       = RX_LADDER_BASE + RX_LADDER_STEP * 5,   /* 40 */
        [RX_FN_BACKWARD_RIGHT] = RX_LADDER_BASE + RX_LADDER_STEP * 6,   /* 46 */
        [RX_FN_BACKWARD_LEFT]  = RX_LADDER_BASE + RX_LADDER_STEP * 7,   /* 52 */
        [RX_FN_LEFT]           = RX_LADDER_BASE + RX_LADDER_STEP * 8,   /* 58 */
        [RX_FN_RIGHT]          = RX_LADDER_BASE + RX_LADDER_STEP * 9,   /* 64 */
    },
};

static const char *const k_fn_names[RX_FN_COUNT] = {
    "fwd", "turbo", "slot2", "fwdleft", "fwdright",
    "back", "backright", "backleft", "left", "right",
};

static SemaphoreHandle_t   s_lock  = NULL;
static rmt_channel_handle_t s_chan = NULL;
static rmt_encoder_handle_t s_enc  = NULL;
static bool                s_ready = false;

/* Command state (all guarded by s_lock) */
static rx_mode_t s_mode      = RX_MODE_IDLE;
static uint8_t   s_thr       = 0;
static int8_t    s_steer     = 0;
static bool      s_reverse   = false;    /* bench-only: use the BACKWARD codes               */
static uint16_t  s_raw       = 0;
static bool      s_console   = false;    /* bench override: the net path is ignored          */
static int64_t   s_deadline  = 0;        /* console auto-stop deadline, esp_timer us         */

/* Sweep state (guarded by s_lock) */
static uint16_t  s_sw_cur       = 0;
static uint16_t  s_sw_to        = 0;
static int       s_sw_step      = 1;
static bool      s_sw_holding   = false;
static int64_t   s_sw_phase_end = 0;
static uint32_t  s_sw_announced = 0xFFFFFFFFu;

/* Telemetry only — read without the lock by drive_current_duty(). */
static volatile uint32_t s_pseudo_duty = 0;

/* Frame scratch. Single writer (the TX task), so no lock needed. */
static rmt_symbol_word_t s_syms[RX_SYM_CAP];

/* ------------------------------------------------------------------------------------------
 * Frame construction
 * ---------------------------------------------------------------------------------------- */

static inline uint16_t clamp_ticks(uint32_t us)
{
    if (us < 1u)                 return 1u;
    if (us > RX_RMT_MAX_TICKS)   return (uint16_t)RX_RMT_MAX_TICKS;
    return (uint16_t)us;
}

/* OOK carrier for RF-inject mode: modulates the pulse level with carrier_khz so the wire can
 * drive the ANT input through the receiver's own front end. 0 disables (baseband, pin 14). */
static void apply_carrier(void)
{
    if (s_chan == NULL) {
        return;
    }
    const rmt_carrier_config_t cc = {
        .frequency_hz = (uint32_t)s_cfg.carrier_khz * 1000u,
        .duty_cycle   = 0.5f,
        .flags        = { .polarity_active_low = (s_cfg.invert != 0), .always_on = 0 },
    };
    const esp_err_t err = rmt_apply_carrier(s_chan, &cc);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_apply_carrier(%u kHz) failed: %s",
                 (unsigned)s_cfg.carrier_khz, esp_err_to_name(err));
    } else if (s_cfg.carrier_khz != 0) {
        ESP_LOGI(TAG, "carrier ON: %u kHz OOK on the pulse level — wire to ANT, keep invert 0",
                 (unsigned)s_cfg.carrier_khz);
    } else {
        ESP_LOGI(TAG, "carrier OFF — baseband on the wire (pin-14 injection)");
    }
}

static size_t append_pulse(size_t n, uint32_t high_us, uint32_t low_us, uint32_t hi, uint32_t lo)
{
    if (n >= RX_SYM_CAP) {
        return n;
    }
    s_syms[n].level0    = hi;
    s_syms[n].duration0 = clamp_ticks(high_us);
    s_syms[n].level1    = lo;
    s_syms[n].duration1 = clamp_ticks(low_us);
    return n + 1;
}

/* Idle for `us` at the line's idle level, split across as many symbols as it takes. */
static size_t append_idle(size_t n, uint32_t us, uint32_t lo)
{
    while (us > 0 && n < RX_SYM_CAP) {
        uint32_t chunk = us;
        if (chunk > 2u * RX_RMT_MAX_TICKS) {
            chunk = 2u * RX_RMT_MAX_TICKS;
        }
        const uint32_t d0 = (chunk + 1u) / 2u;
        const uint32_t d1 = chunk - d0;
        s_syms[n].level0    = lo;
        s_syms[n].duration0 = clamp_ticks(d0);
        s_syms[n].level1    = lo;
        s_syms[n].duration1 = (d1 > 0) ? clamp_ticks(d1) : 1u;
        n++;
        us -= chunk;
    }
    return n;
}

static uint32_t frame_us(const rx_cfg_t *c, uint16_t pulses)
{
    const uint32_t mult = c->w1_mult ? c->w1_mult : 1u;
    return ((uint32_t)c->w1_pulses * mult + (uint32_t)pulses) * (uint32_t)c->period_us +
           (uint32_t)c->sgap_us + (uint32_t)c->gap_ms * 1000u;
}

static size_t build_frame(const rx_cfg_t *c, uint16_t pulses)
{
    const uint32_t hi = c->invert ? 0u : 1u;
    const uint32_t lo = c->invert ? 1u : 0u;

    uint32_t high_us = ((uint32_t)c->period_us * (uint32_t)c->duty_pct) / 100u;
    if (high_us < 1u)                      high_us = 1u;
    if (high_us > (uint32_t)c->period_us - 1u) high_us = (uint32_t)c->period_us - 1u;
    const uint32_t low_us = (uint32_t)c->period_us - high_us;

    if (pulses > RX_PULSES_MAX) pulses = RX_PULSES_MAX;

    /* W1 sync pulses are w1_mult code cells wide — the decoder identifies frame start by
     * pulse WIDTH, so these must be visibly longer than the code cells that follow. */
    const uint32_t w1_period = (uint32_t)c->period_us * (c->w1_mult ? c->w1_mult : 1u);
    uint32_t w1_high = (w1_period * (uint32_t)c->duty_pct) / 100u;
    if (w1_high < 1u)             w1_high = 1u;
    if (w1_high > w1_period - 1u) w1_high = w1_period - 1u;
    const uint32_t w1_low = w1_period - w1_high;

    size_t n = 0;
    for (uint8_t i = 0; i < c->w1_pulses; i++) {
        n = append_pulse(n, w1_high, w1_low, hi, lo);
    }
    if (c->sgap_us > 0 && c->w1_pulses > 0) {
        n = append_idle(n, c->sgap_us, lo);
    }
    for (uint16_t i = 0; i < pulses; i++) {
        n = append_pulse(n, high_us, low_us, hi, lo);
    }
    if (c->gap_ms > 0) {
        n = append_idle(n, (uint32_t)c->gap_ms * 1000u, lo);
    }
    return n;
}

/* Transmit exactly one frame and wait for it to finish. Timing comes out of RMT hardware, so
 * preemption here only stretches the gap BETWEEN frames — never a pulse. */
static void tx_frame(const rx_cfg_t *c, uint16_t pulses)
{
    if (!s_ready || pulses < RX_PULSES_MIN) {
        vTaskDelay(pdMS_TO_TICKS(5));
        return;
    }

    const size_t n = build_frame(c, pulses);
    if (n == 0) {
        vTaskDelay(pdMS_TO_TICKS(5));
        return;
    }

    const rmt_transmit_config_t tc = {
        .loop_count = 0,
        .flags = { .eot_level = c->invert ? 1u : 0u },
    };

    const esp_err_t err = rmt_transmit(s_chan, s_enc, s_syms,
                                       n * sizeof(rmt_symbol_word_t), &tc);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_transmit failed: %s", esp_err_to_name(err));
        vTaskDelay(pdMS_TO_TICKS(20));
        return;
    }
    const uint32_t wait_ms = frame_us(c, pulses) / 1000u + 200u;
    (void)rmt_tx_wait_all_done(s_chan, pdMS_TO_TICKS(wait_ms));
}

static uint32_t off_slot_ms(const rx_cfg_t *c, uint16_t pulses)
{
    if (c->offslot_ms > 0) {
        return c->offslot_ms;
    }
    const uint32_t ms = (frame_us(c, pulses) + 999u) / 1000u;
    return (ms < 1u) ? 1u : ms;
}

/* ------------------------------------------------------------------------------------------
 * The (throttle, steer) -> (function code, frame count) mapping.
 *
 * Pure function of the command and the config, deliberately: it is the one piece of this
 * backend whose arithmetic cannot be checked by watching the car, so it is kept separable and
 * side-effect free.
 *
 *   thr  |steer|   ON-slot code                 OFF-slot code
 *   ---- -------   ----------------------------  --------------------------------------
 *     0   < db     (nothing — stay silent)       idle
 *     0   >= db    LEFT / RIGHT (every slot)     LEFT / RIGHT
 *    >0   < db     FORWARD   (BACKWARD if rev)   idle
 *    >0   >= db    FORWARD_LEFT / _RIGHT         LEFT / RIGHT if steerfill, else idle
 *                  (BACKWARD_LEFT / _RIGHT)
 *
 * Steer sign: after ARKART_STEER_SIGN, positive = RIGHT and negative = LEFT. If the kart turns
 * the wrong way, flip ARKART_STEER_SIGN in motor_map.h — the same one-line fix Plan M uses,
 * no rewiring and no protocol change.
 * ---------------------------------------------------------------------------------------- */
typedef struct {
    rx_fn_t  fn_drive;      /* code for the ON slots of the window                          */
    rx_fn_t  fn_steer;      /* pure steer code, for OFF slots and for standstill turning    */
    bool     steering;      /* the stick is outside the deadband                            */
    uint32_t on_frames;     /* how many of cfg.window frames carry fn_drive; 0 = no drive   */
} rx_plan_t;

static rx_plan_t plan_from_command(const rx_cfg_t *c, uint8_t thr, int8_t steer, bool rev)
{
    rx_plan_t p;

    int s = (int)steer * ARKART_STEER_SIGN;
    if (s >  100) s =  100;
    if (s < -100) s = -100;

    const int  mag   = (s < 0) ? -s : s;
    const bool right = (s > 0);

    p.steering = (mag >= (int)c->deadband);
    p.fn_steer = right ? RX_FN_RIGHT : RX_FN_LEFT;

    if (!p.steering) {
        p.fn_drive = rev ? RX_FN_BACKWARD : RX_FN_FORWARD;
    } else if (rev) {
        p.fn_drive = right ? RX_FN_BACKWARD_RIGHT : RX_FN_BACKWARD_LEFT;
    } else {
        p.fn_drive = right ? RX_FN_FORWARD_RIGHT : RX_FN_FORWARD_LEFT;
    }

    /* Frame-level duty cycling: the stock decoder is on/off, so proportional throttle is
     * `on_frames` drive frames out of every `window`. A non-zero stick always buys at least
     * thr_min_pct of the window, or low throttle would be indistinguishable from no throttle. */
    p.on_frames = 0;
    if (thr > 0) {
        uint32_t on = ((uint32_t)c->window * (uint32_t)thr + 127u) / 255u;
        const uint32_t floor_frames =
            ((uint32_t)c->window * (uint32_t)c->thr_min_pct + 99u) / 100u;
        if (on < floor_frames)   on = floor_frames;
        if (on < 1u)             on = 1u;
        if (on > c->window)      on = c->window;
        p.on_frames = on;
    }
    return p;
}

/* Defined further down; the sniff session below hands the pin over and takes it back. */
static esp_err_t rx_tx_hw_open(void);
static void      rx_tx_hw_close(void);
static void      release_console_locked(void);

/* ==========================================================================================
 * SNIFF — read the protocol out of the hardware instead of guessing it.
 *
 * The car's own 27 MHz receiver front end demodulates the original remote onto the very net we
 * inject into (SA1607RX pin 14). So if we let go of the pin and just watch it, every frame the
 * decoder sees, we see — pulse counts, cell period, duty, frame gaps, the lot. That is ground
 * truth, not a datasheet guess.
 *
 * CAPTURE: a GPIO any-edge interrupt timestamping into a lock-free ring, drained by the TX task.
 * Chosen over RMT RX for three reasons:
 *   1. RMT RX ends a receive on a FIXED idle threshold configured before capture starts — but
 *      the whole point of sniffing is that we do not yet know the timings, so any threshold we
 *      picked would be the same guess we are trying to eliminate. With edge timestamps the
 *      burst-splitting threshold is a RUNTIME knob (`set sniffgap_us`) applied in software,
 *      after the fact, and it can be changed and the next press re-read in seconds.
 *   2. No symbol-memory ceiling. A held button repeats frames indefinitely; RMT RX would need
 *      partial-receive plumbing and could overflow its 48-symbol block, whereas a 1024-entry
 *      ring drained every 5 ms has ~50x headroom at the worst-case edge rate.
 *   3. It touches no shared peripheral at all, so the WS2812's RMT channel, the camera's
 *      LCD_CAM/GDMA and LEDC timer 0, and WiFi are all provably unaffected. The cost is one
 *      interrupt per edge: at a 500 us cell that is 4 kHz, which is nothing on a 240 MHz S3.
 *
 * The handler is IRAM_ATTR so its latency does not depend on a flash fetch, but the ISR service
 * is installed WITHOUT ESP_INTR_FLAG_IRAM: that would force every other GPIO handler in the
 * system to be IRAM-safe too, which is not ours to promise. The only consequence is that edges
 * arriving while the flash cache is disabled (an NVS write, say) are lost — acceptable in a
 * bench mode, and visible as an odd edge count on the affected burst.
 * ========================================================================================== */

#define SNIFF_RING_LEN      1024u                    /* power of two                         */
#define SNIFF_RING_MASK     (SNIFF_RING_LEN - 1u)
#define SNIFF_TABLE_MAX     24                       /* distinct pulse counts remembered     */
#define SNIFF_SECTION_RATIO 2u                       /* "this idle is a section gap" factor  */
_Static_assert((SNIFF_RING_LEN & SNIFF_RING_MASK) == 0, "SNIFF_RING_LEN must be a power of two");

/* Edge timestamps, in microseconds truncated to 32 bits. The truncation is deliberate: every
 * consumer works in unsigned differences, which are exact across the ~71 minute wrap. */
static volatile uint32_t s_snf_ring[SNIFF_RING_LEN];
static volatile uint32_t s_snf_head  = 0;            /* written by the ISR only              */
static volatile uint32_t s_snf_tail  = 0;            /* written by the task only             */
static volatile uint32_t s_snf_drops = 0;
static bool              s_snf_isr_service = false;

static void IRAM_ATTR sniff_isr(void *arg)
{
    (void)arg;
    const uint32_t now  = (uint32_t)esp_timer_get_time();
    const uint32_t head = s_snf_head;
    const uint32_t next = (head + 1u) & SNIFF_RING_MASK;
    if (next == s_snf_tail) {
        s_snf_drops++;              /* the task fell behind; the burst will read as odd */
        return;
    }
    s_snf_ring[head] = now;
    s_snf_head       = next;
}

/* ---- one analysed burst ------------------------------------------------------------------ */
typedef struct {
    uint32_t edges;          /* edges seen in this burst                                     */
    uint32_t pulses;         /* complete high+low cells; edges/2                             */
    uint32_t period_us;      /* mean(active) + mean(intra-burst idle)                        */
    uint32_t duty_pct;       /* mean(active) / period                                        */
    uint32_t high_us;        /* mean(active) — the only timing a 1-pulse burst can report    */
    uint32_t gap_us;         /* idle since the previous burst ended; 0 if this is the first   */
    bool     have_gap;
    /* section split: a burst whose longest internal idle dwarfs the others is really
     * "W1 pulses + section gap + code pulses", which is exactly our own frame model. */
    bool     split;
    uint32_t sect_a;         /* pulses before the long idle (the W1 section)                 */
    uint32_t sect_b;         /* pulses after it (the function code section)                   */
    uint32_t sgap_us;        /* the long idle itself                                          */
    uint32_t code_pulses;    /* sect_b when split, else pulses — what `set code` wants        */
    bool     odd_edges;      /* an odd edge count means an edge was missed somewhere          */
} rx_burst_t;

/* ---- the grouper: a pure state machine over the edge stream ------------------------------ */
typedef struct {
    uint32_t gap_us;             /* idle at or above this closes a burst                     */
    bool     in_burst;
    uint32_t prev_edge_us;
    bool     have_prev_edge;
    /* accumulator for the burst being built */
    uint32_t first_us;
    uint32_t edges;
    uint32_t sum_active, n_active;
    uint32_t sum_idle,   n_idle;
    uint32_t max_idle;
    uint32_t max_idle_iv;       /* interval index of max_idle                               */
    /* previous burst */
    bool     have_prev_burst;
    uint32_t prev_burst_end_us;
} rx_sniff_state_t;

static void sniff_state_init(rx_sniff_state_t *s, uint32_t gap_us)
{
    memset(s, 0, sizeof(*s));
    s->gap_us = gap_us;
}

/* Turn the accumulator into a finished burst record. */
static void sniff_finalise(const rx_sniff_state_t *s, rx_burst_t *b)
{
    memset(b, 0, sizeof(*b));

    b->edges     = s->edges;
    b->odd_edges = ((s->edges & 1u) != 0u);
    b->pulses    = (s->edges + 1u) / 2u;          /* 2 edges per cell; round an odd one up  */

    b->high_us   = s->n_active ? (s->sum_active / s->n_active) : 0u;
    const uint32_t mean_idle = s->n_idle ? (s->sum_idle / s->n_idle) : 0u;
    b->period_us = b->high_us + mean_idle;
    b->duty_pct  = b->period_us ? ((b->high_us * 100u) / b->period_us) : 0u;

    b->have_gap  = s->have_prev_burst;
    b->gap_us    = s->have_prev_burst ? (s->first_us - s->prev_burst_end_us) : 0u;

    /* Section split. Needs at least two internal idles to have something to compare against;
     * the long one must dwarf the mean of the others by SNIFF_SECTION_RATIO. */
    b->code_pulses = b->pulses;
    if (s->n_idle >= 2u && s->max_idle > 0u) {
        const uint32_t others_sum = s->sum_idle - s->max_idle;
        const uint32_t others_n   = s->n_idle - 1u;
        const uint32_t others_mean = others_n ? (others_sum / others_n) : 0u;
        if (others_mean > 0u && s->max_idle >= others_mean * SNIFF_SECTION_RATIO) {
            /* Idle intervals sit at odd interval indices: index j is the idle that follows
             * pulse number (j + 1) / 2. */
            const uint32_t before = (s->max_idle_iv + 1u) / 2u;
            if (before > 0u && before < b->pulses) {
                b->split       = true;
                b->sect_a      = before;
                b->sect_b      = b->pulses - before;
                b->sgap_us     = s->max_idle;
                b->code_pulses = b->sect_b;
            }
        }
    }
}

/* Feed one edge timestamp. Returns true (and fills *out) when this edge closed a burst. */
static bool sniff_feed_edge(rx_sniff_state_t *s, uint32_t t_us, rx_burst_t *out)
{
    if (!s->have_prev_edge || !s->in_burst) {
        /* First edge ever, or the first edge after a flushed burst: open a new burst. */
        s->in_burst       = true;
        s->have_prev_edge = true;
        s->prev_edge_us   = t_us;
        s->first_us       = t_us;
        s->edges          = 1;
        s->sum_active = s->n_active = 0;
        s->sum_idle   = s->n_idle   = 0;
        s->max_idle   = s->max_idle_iv = 0;
        return false;
    }

    const uint32_t delta = t_us - s->prev_edge_us;      /* wrap-safe */

    if (delta >= s->gap_us) {
        /* The line went quiet long enough: the burst ended at the PREVIOUS edge, and this edge
         * starts the next one. */
        sniff_finalise(s, out);
        s->have_prev_burst   = true;
        s->prev_burst_end_us = s->prev_edge_us;

        s->first_us   = t_us;
        s->edges      = 1;
        s->sum_active = s->n_active = 0;
        s->sum_idle   = s->n_idle   = 0;
        s->max_idle   = s->max_idle_iv = 0;
        s->prev_edge_us = t_us;
        s->in_burst     = true;
        return true;
    }

    /* Inside the burst. Interval index edges-1: even = the active half of a cell, odd = the
     * idle half. Which is which follows from structure alone — the first edge of a burst is
     * always the one that leaves idle — so no per-edge level read is needed in the ISR. */
    const uint32_t iv = s->edges - 1u;
    if ((iv & 1u) == 0u) {
        s->sum_active += delta;
        s->n_active++;
    } else {
        s->sum_idle += delta;
        s->n_idle++;
        if (delta > s->max_idle) {
            s->max_idle    = delta;
            s->max_idle_iv = iv;
        }
    }
    s->edges++;
    s->prev_edge_us = t_us;
    return false;
}

/* Close out a burst whose trailing idle has now exceeded the threshold. This is what emits the
 * LAST burst after a button is released — nothing else would. */
static bool sniff_flush(rx_sniff_state_t *s, uint32_t now_us, rx_burst_t *out)
{
    if (!s->in_burst || !s->have_prev_edge) {
        return false;
    }
    if ((now_us - s->prev_edge_us) < s->gap_us) {
        return false;
    }
    sniff_finalise(s, out);
    s->have_prev_burst   = true;
    s->prev_burst_end_us = s->prev_edge_us;
    s->in_burst          = false;
    return true;
}

/* ---- the distinct-count table: rate limiting with a repeat counter ----------------------- */
typedef struct {
    uint32_t code;              /* key: the code-section pulse count                        */
    uint32_t repeats;
    uint32_t last_total, last_w1, last_sgap_us;
    uint32_t sum_period, sum_duty, sum_gap_us;
    uint32_t first_seen_us;
    uint32_t last_print_us;
    uint32_t printed_repeats;
} sniff_entry_t;

static sniff_entry_t s_snf_tab[SNIFF_TABLE_MAX];
static int           s_snf_tab_n  = 0;
static uint32_t      s_snf_bursts = 0;
static bool          s_snf_idle_low = true;

/* Find or create the entry for a code count. Returns NULL when the table is full (which only
 * happens on pure noise — 24 distinct counts is far more than a five-function remote has). */
static sniff_entry_t *sniff_tab_get(uint32_t code, uint32_t now_us, bool *is_new)
{
    for (int i = 0; i < s_snf_tab_n; i++) {
        if (s_snf_tab[i].code == code) {
            *is_new = false;
            return &s_snf_tab[i];
        }
    }
    if (s_snf_tab_n >= SNIFF_TABLE_MAX) {
        *is_new = false;
        return NULL;
    }
    sniff_entry_t *e = &s_snf_tab[s_snf_tab_n++];
    memset(e, 0, sizeof(*e));
    e->code          = code;
    e->first_seen_us = now_us;
    *is_new          = true;
    return e;
}

/* Print one burst line, at most once per cfg.sniffrep_ms for a count that keeps repeating.
 * A held button repeats a frame every ~11 ms; without this the console would scroll at 90
 * lines a second and the user could not read the count they just produced. */
static void sniff_report(const rx_burst_t *b, const rx_cfg_t *c, uint32_t now_us)
{
    s_snf_bursts++;

    bool is_new = false;
    sniff_entry_t *e = sniff_tab_get(b->code_pulses, now_us, &is_new);

    if (e == NULL) {
        /* Table full: 24 distinct counts means noise, not a five-function remote. Keep the
         * console usable by rate-limiting these the same way a repeat is limited — an
         * unthrottled path here would scroll the summary off the screen. */
        static uint32_t last_overflow_us = 0;
        static bool     have_overflow    = false;
        if (have_overflow &&
            (now_us - last_overflow_us) < ((uint32_t)c->sniffrep_ms * 1000u)) {
            return;
        }
        last_overflow_us = now_us;
        have_overflow    = true;
        ESP_LOGW(TAG, "SNIFF: more than %d distinct counts — this looks like noise, not a "
                      "remote. Raise `set sniffgap_us` or check the ground.", SNIFF_TABLE_MAX);
    }

    if (e != NULL) {
        e->repeats++;
        e->last_total   = b->pulses;
        e->last_w1      = b->split ? b->sect_a : 0u;
        e->last_sgap_us = b->split ? b->sgap_us : 0u;
        e->sum_period  += b->period_us;
        e->sum_duty    += b->duty_pct;
        e->sum_gap_us  += b->gap_us;

        if (!is_new) {
            const bool due = (now_us - e->last_print_us) >= ((uint32_t)c->sniffrep_ms * 1000u);
            if (!due || e->printed_repeats == e->repeats) {
                return;
            }
        }
        e->last_print_us   = now_us;
        e->printed_repeats = e->repeats;
    }

    char gap[24];
    if (b->have_gap) {
        snprintf(gap, sizeof(gap), "%u.%ums", (unsigned)(b->gap_us / 1000u),
                 (unsigned)((b->gap_us % 1000u) / 100u));
    } else {
        snprintf(gap, sizeof(gap), "first");
    }

    char tail[48];
    if (b->split) {
        snprintf(tail, sizeof(tail), ", sgap %uus", (unsigned)b->sgap_us);
    } else {
        tail[0] = '\0';
    }

    const char *idle = s_snf_idle_low ? "low" : "high";
    const char *mark = is_new ? "  <<< NEW" : "";

    if (b->pulses <= 1u) {
        /* Degenerate: one cell means one active interval and no idle to pair it with, so there
         * is no period to report. Say so rather than inventing one. */
        ESP_LOGI(TAG, "SNIFF burst: 1 pulse, high %uus, period n/a, gap %s, idle=%s%s%s",
                 (unsigned)b->high_us, gap, idle, b->odd_edges ? ", ODD EDGES" : "", mark);
        return;
    }

    if (b->split) {
        ESP_LOGI(TAG, "SNIFF burst: %u pulses (%u+%u), period %uus, duty %u%%, gap %s%s, "
                      "idle=%s%s%s",
                 (unsigned)b->pulses, (unsigned)b->sect_a, (unsigned)b->sect_b,
                 (unsigned)b->period_us, (unsigned)b->duty_pct, gap, tail, idle,
                 b->odd_edges ? ", ODD EDGES" : "",
                 is_new ? "  <<< NEW" : "");
    } else {
        ESP_LOGI(TAG, "SNIFF burst: %u pulses, period %uus, duty %u%%, gap %s, idle=%s%s%s",
                 (unsigned)b->pulses, (unsigned)b->period_us, (unsigned)b->duty_pct,
                 gap, idle, b->odd_edges ? ", ODD EDGES" : "", mark);
    }

    if (e != NULL && !is_new) {
        ESP_LOGI(TAG, "             ^ count %u seen x%u so far",
                 (unsigned)b->code_pulses, (unsigned)e->repeats);
    }
}

/* ---- the optional nice touch: turn the observed counts into `set code` lines -------------
 * Pure function so it can be unit-tested. `counts` must be sorted ascending.
 * Writes at most `cap` lines into `out` (each NUL-terminated, RX_SUGGEST_LINE long) and
 * returns how many it wrote. `*anchor_shifted` reports that the counts did NOT sit on the
 * reference base-10 ladder and a shifted base had to be assumed — which the caller must say
 * out loud, because the slot NAMES are then only as good as that assumption. */
#define RX_SUGGEST_LINE  64

static int sniff_suggest(const uint32_t *counts, int n, char out[][RX_SUGGEST_LINE], int cap,
                         bool *anchor_shifted, uint32_t *anchor_out)
{
    *anchor_shifted = false;
    *anchor_out     = RX_LADDER_BASE;
    if (n <= 0) {
        return 0;
    }

    /* Prefer the reference anchor: every observed count lands on base 10, step 6, inside the
     * ten known slots. If even one does not, fall back to anchoring on the smallest count. */
    bool fits_reference = true;
    for (int i = 0; i < n; i++) {
        if (counts[i] < RX_LADDER_BASE ||
            ((counts[i] - RX_LADDER_BASE) % RX_LADDER_STEP) != 0u ||
            ((counts[i] - RX_LADDER_BASE) / RX_LADDER_STEP) >= (uint32_t)RX_FN_COUNT) {
            fits_reference = false;
            break;
        }
    }
    const uint32_t anchor = fits_reference ? (uint32_t)RX_LADDER_BASE : counts[0];
    *anchor_shifted = !fits_reference;
    *anchor_out     = anchor;

    int w = 0;
    for (int i = 0; i < n && w < cap; i++) {
        const uint32_t c = counts[i];
        if (c >= anchor && ((c - anchor) % RX_LADDER_STEP) == 0u &&
            ((c - anchor) / RX_LADDER_STEP) < (uint32_t)RX_FN_COUNT) {
            const rx_fn_t fn = (rx_fn_t)((c - anchor) / RX_LADDER_STEP);
            snprintf(out[w], RX_SUGGEST_LINE, "  set code %-9s %-3u", rx_fn_name(fn), (unsigned)c);
        } else {
            snprintf(out[w], RX_SUGGEST_LINE,
                     "  # count %-3u fits no slot — assign it by hand", (unsigned)c);
        }
        w++;
    }
    return w;
}

static void sniff_summary(void)
{
    /* selection-sort the table by repeats, descending: the counts the user leaned on first */
    for (int i = 0; i < s_snf_tab_n; i++) {
        int best = i;
        for (int j = i + 1; j < s_snf_tab_n; j++) {
            if (s_snf_tab[j].repeats > s_snf_tab[best].repeats) {
                best = j;
            }
        }
        if (best != i) {
            const sniff_entry_t t = s_snf_tab[i];
            s_snf_tab[i] = s_snf_tab[best];
            s_snf_tab[best] = t;
        }
    }

    printf("\n--- SNIFF summary ---------------------------------------------------------\n");
    printf("  %u bursts, %d distinct code counts, %u dropped edges, idle=%s\n",
           (unsigned)s_snf_bursts, s_snf_tab_n, (unsigned)s_snf_drops,
           s_snf_idle_low ? "low" : "high");
    if (s_snf_tab_n == 0) {
        printf("  NOTHING SEEN. Check: remote batteries, the wire on pin 14, a shared ground,\n");
        printf("  and that the car's own board is powered — its receiver does the demodulating.\n");
        printf("---------------------------------------------------------------------------\n\n");
        fflush(stdout);
        return;
    }

    printf("   code   w1  total  repeats  period  duty   sgap\n");
    for (int i = 0; i < s_snf_tab_n; i++) {
        const sniff_entry_t *e = &s_snf_tab[i];
        const uint32_t n = e->repeats ? e->repeats : 1u;
        printf("   %4u  %3u  %5u  %7u  %4uus  %3u%%  %5uus\n",
               (unsigned)e->code, (unsigned)e->last_w1, (unsigned)e->last_total,
               (unsigned)e->repeats, (unsigned)(e->sum_period / n),
               (unsigned)(e->sum_duty / n), (unsigned)e->last_sgap_us);
    }

    /* Suggestions, in ascending count order so the ladder is readable. */
    uint32_t counts[SNIFF_TABLE_MAX];
    for (int i = 0; i < s_snf_tab_n; i++) {
        counts[i] = s_snf_tab[i].code;
    }
    for (int i = 1; i < s_snf_tab_n; i++) {           /* insertion sort, ascending */
        const uint32_t v = counts[i];
        int j = i - 1;
        while (j >= 0 && counts[j] > v) { counts[j + 1] = counts[j]; j--; }
        counts[j + 1] = v;
    }

    char lines[SNIFF_TABLE_MAX][RX_SUGGEST_LINE];
    bool shifted = false;
    uint32_t anchor = 0;
    const int nl = sniff_suggest(counts, s_snf_tab_n, lines, SNIFF_TABLE_MAX, &shifted, &anchor);

    printf("\n  Suggested — VERIFY each against the button you actually pressed:\n");
    if (shifted) {
        printf("  # these counts do NOT sit on the reference base-%d ladder; assuming base %u,\n",
               RX_LADDER_BASE, (unsigned)anchor);
        printf("  # so the slot NAMES below are a guess about ordering, not a measurement.\n");
    }
    for (int i = 0; i < nl; i++) {
        printf("%s\n", lines[i]);
    }
    printf("---------------------------------------------------------------------------\n\n");
    fflush(stdout);
}

/* ---- hardware handover ------------------------------------------------------------------- */

static esp_err_t sniff_hw_open(void)
{
    s_snf_head = s_snf_tail = 0;
    s_snf_drops = 0;

    /* Input, no pulls, any-edge interrupt. The mode/pull half of this is the high-Z guarantee
     * (see rx_tx_hw_close); the intr_type half is the capture. */
    const gpio_config_t in = {
        .pin_bit_mask = (1ULL << ARKART_PIN_RX_DATA),
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_ANYEDGE,
    };
    esp_err_t err = gpio_config(&in);
    if (err != ESP_OK) {
        return err;
    }

    if (!s_snf_isr_service) {
        err = gpio_install_isr_service(0);   /* NOT ESP_INTR_FLAG_IRAM — see the block comment */
        if (err == ESP_ERR_INVALID_STATE) {
            err = ESP_OK;                    /* somebody else already installed it: fine */
        }
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "gpio_install_isr_service failed: %s", esp_err_to_name(err));
            return err;
        }
        s_snf_isr_service = true;
    }

    err = gpio_isr_handler_add(ARKART_PIN_RX_DATA, sniff_isr, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_isr_handler_add failed: %s", esp_err_to_name(err));
        return err;
    }
    return ESP_OK;
}

static void sniff_hw_close(void)
{
    (void)gpio_intr_disable(ARKART_PIN_RX_DATA);
    (void)gpio_isr_handler_remove(ARKART_PIN_RX_DATA);
    (void)gpio_set_intr_type(ARKART_PIN_RX_DATA, GPIO_INTR_DISABLE);
}

/* ---- the session ------------------------------------------------------------------------
 * Runs INSIDE the TX task, which is the whole trick: the task that owns every rmt_transmit()
 * is the task that releases and reclaims the channel, so there is no window in which one task
 * could transmit onto a pin another task has turned into an input. No handshake, no flag
 * protocol, nothing to get wrong.
 * -------------------------------------------------------------------------------------- */
static void sniff_session(void)
{
    rx_cfg_t c;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    c = s_cfg;
    xSemaphoreGive(s_lock);

    rx_tx_hw_close();                      /* <- pin is high-Z input from here on */

    if (sniff_hw_open() != ESP_OK) {
        ESP_LOGE(TAG, "sniff could not claim the pin — restoring the transmitter");
        sniff_hw_close();
        (void)rx_tx_hw_open();
        xSemaphoreTake(s_lock, portMAX_DELAY);
        release_console_locked();
        xSemaphoreGive(s_lock);
        return;
    }

    s_snf_tab_n    = 0;
    s_snf_bursts   = 0;
    s_snf_idle_low = (gpio_get_level(ARKART_PIN_RX_DATA) == 0);

    rx_sniff_state_t st;
    sniff_state_init(&st, c.sniffgap_us);

    ESP_LOGI(TAG, "SNIFF listening on gpio%d (high-Z input) — transmitter released",
             ARKART_PIN_RX_DATA);
    ESP_LOGI(TAG, "press buttons on the car's own 27 MHz remote, one function at a time; "
                  "`stop` when done (auto-stop after %d s with no edge)",
             RX_SNIFF_AUTOSTOP_MS / 1000);
    ESP_LOGI(TAG, "burst threshold %u us, repeat re-print every %u ms "
                  "(`set sniffgap_us` / `set sniffrep_ms`)",
             (unsigned)c.sniffgap_us, (unsigned)c.sniffrep_ms);

    int64_t last_edge_us = esp_timer_get_time();
    bool    stopped_by_user = false;

    for (;;) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        const rx_mode_t mode = s_mode;
        c = s_cfg;                          /* pick up live `set sniffrep_ms` etc. */
        xSemaphoreGive(s_lock);

        if (mode != RX_MODE_SNIFF) {
            stopped_by_user = true;
            break;
        }
        st.gap_us = c.sniffgap_us;          /* retunable mid-session */

        /* Drain the ring. */
        rx_burst_t b;
        while (s_snf_tail != s_snf_head) {
            const uint32_t t = s_snf_ring[s_snf_tail];
            s_snf_tail = (s_snf_tail + 1u) & SNIFF_RING_MASK;
            last_edge_us = esp_timer_get_time();
            if (sniff_feed_edge(&st, t, &b)) {
                sniff_report(&b, &c, (uint32_t)last_edge_us);
            }
        }

        const int64_t now = esp_timer_get_time();

        /* Emit a burst whose trailing silence has now passed the threshold. */
        if (sniff_flush(&st, (uint32_t)now, &b)) {
            sniff_report(&b, &c, (uint32_t)now);
        }

        /* Between bursts the line is at its resting level: that is the idle level to report. */
        if (!st.in_burst) {
            s_snf_idle_low = (gpio_get_level(ARKART_PIN_RX_DATA) == 0);
        }

        if ((now - last_edge_us) > ((int64_t)RX_SNIFF_AUTOSTOP_MS * 1000)) {
            ESP_LOGW(TAG, "SNIFF auto-stop: no edge for %d s", RX_SNIFF_AUTOSTOP_MS / 1000);
            break;
        }

        vTaskDelay(pdMS_TO_TICKS(5));
    }

    sniff_summary();

    sniff_hw_close();
    const esp_err_t err = rx_tx_hw_open();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "could not restore the transmitter after sniffing: %s — reboot the kart",
                 esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "SNIFF done — transmitter restored on gpio%d, net control resumed",
                 ARKART_PIN_RX_DATA);
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_mode == RX_MODE_SNIFF) {          /* auto-stop path; `stop` already did this */
        release_console_locked();
    }
    xSemaphoreGive(s_lock);
    (void)stopped_by_user;
}

/* ------------------------------------------------------------------------------------------
 * The transmitter task
 * ---------------------------------------------------------------------------------------- */

/* The sweep's own refresh of the bench watchdog. It must outlast one full count period
 * (hold + gap) at ANY legal pacing, or a slow sweep would shoot itself; it must still be a
 * hard bound, so a sweep that somehow stopped advancing dies within one extra timeout. */
static inline int64_t sweep_deadline(int64_t now, const rx_cfg_t *c)
{
    return now + ((int64_t)c->hold_ms + (int64_t)c->sweepgap_ms +
                  (int64_t)RX_CONSOLE_TIMEOUT_MS) * 1000;
}

static void release_console_locked(void)
{
    s_console = false;
    s_mode    = RX_MODE_IDLE;
    s_thr     = 0;
    s_steer   = 0;
    s_reverse = false;
}

/* One step of the sweep state machine. Call with s_lock held; it only reads the clock and
 * shuffles the sweep statics, so it is unit-testable on a fake clock — which matters, because
 * an off-by-one here silently skips the count that would have identified FORWARD.
 *
 * Phases alternate HOLD (transmit *out_cur) -> GAP (silence) -> next count, and the sweep ends
 * after the GAP that follows the final count, releasing the console override. */
static void sweep_advance_locked(int64_t now, const rx_cfg_t *c,
                                 bool *out_holding, bool *out_done,
                                 uint16_t *out_cur, bool *out_announce)
{
    bool done = false;

    if (now >= s_sw_phase_end) {
        if (s_sw_holding) {
            /* End of the hold: idle for the gap so the next count is distinguishable. */
            s_sw_holding   = false;
            s_sw_phase_end = now + (int64_t)c->sweepgap_ms * 1000;
            s_deadline     = sweep_deadline(now, c);
        } else if (s_sw_cur == s_sw_to) {
            done = true;
            release_console_locked();
        } else {
            s_sw_cur       = (uint16_t)((int)s_sw_cur + s_sw_step);
            s_sw_holding   = true;
            s_sw_phase_end = now + (int64_t)c->hold_ms * 1000;
            s_deadline     = sweep_deadline(now, c);
        }
    }

    *out_holding  = s_sw_holding;
    *out_cur      = s_sw_cur;
    *out_done     = done;
    *out_announce = false;

    if (s_sw_holding && s_sw_announced != (uint32_t)s_sw_cur) {
        s_sw_announced = s_sw_cur;
        *out_announce  = true;
    }
}

static void rx_tx_task(void *arg)
{
    (void)arg;
    uint8_t slot = 0;

    for (;;) {
        rx_cfg_t  c;
        rx_mode_t mode;
        uint8_t   thr;
        int8_t    st;
        bool      rev;
        uint16_t  raw;
        bool      console;
        int64_t   deadline;

        xSemaphoreTake(s_lock, portMAX_DELAY);
        c        = s_cfg;
        mode     = s_mode;
        thr      = s_thr;
        st       = s_steer;
        rev      = s_reverse;
        raw      = s_raw;
        console  = s_console;
        deadline = s_deadline;
        xSemaphoreGive(s_lock);

        const int64_t now = esp_timer_get_time();

        /* Bench hard timeout. A console command that is never refreshed expires, so walking
         * away from the bench cannot leave a motor pinned. The sweep engine refreshes this
         * every time it advances to a new count, so a healthy sweep never trips it.
         * SNIFF is exempt: it transmits nothing, so nothing can be pinned, and it has its own
         * much longer no-edge auto-stop. (It also never reaches here while running, because
         * sniff_session() does not return until it is over — belt and braces.) */
        if (console && mode != RX_MODE_SNIFF && now > deadline) {
            xSemaphoreTake(s_lock, portMAX_DELAY);
            release_console_locked();
            xSemaphoreGive(s_lock);
            s_pseudo_duty = 0;
            ESP_LOGW(TAG, "bench command not refreshed for %d ms — transmitter stopped, "
                          "net control resumed", RX_CONSOLE_TIMEOUT_MS);
            continue;
        }

        switch (mode) {

        case RX_MODE_SNIFF:
            /* Blocks for the whole listening session and restores the transmitter itself. */
            s_pseudo_duty = 0;
            sniff_session();
            break;

        case RX_MODE_RAW:
            s_pseudo_duty = ARKART_DUTY_MAX;
            tx_frame(&c, raw);
            break;

        case RX_MODE_SWEEP: {
            bool     done     = false;
            bool     holding  = false;
            bool     announce = false;
            uint16_t cur      = 0;

            xSemaphoreTake(s_lock, portMAX_DELAY);
            sweep_advance_locked(now, &c, &holding, &done, &cur, &announce);
            xSemaphoreGive(s_lock);

            if (announce) {
                /* THE line the bench operator watches: which count moved which motor. */
                ESP_LOGI(TAG, "N=%u SENT", (unsigned)cur);
            }
            if (done) {
                s_pseudo_duty = 0;
                ESP_LOGI(TAG, "sweep complete — transmitter stopped, net control resumed");
                break;
            }
            if (holding) {
                s_pseudo_duty = ARKART_DUTY_MAX;
                tx_frame(&c, cur);
            } else {
                s_pseudo_duty = 0;
                vTaskDelay(pdMS_TO_TICKS(10));
            }
            break;
        }

        case RX_MODE_DRIVE: {
            const rx_plan_t p = plan_from_command(&c, thr, st, rev);

            s_pseudo_duty =
                (uint32_t)(((uint64_t)ARKART_DUTY_MAX * p.on_frames) / (uint32_t)c.window);

            if (p.on_frames == 0u) {
                slot = 0;
                if (p.steering) {
                    tx_frame(&c, c.code[p.fn_steer]);   /* stand still and turn the wheels */
                } else {
                    vTaskDelay(pdMS_TO_TICKS(10));      /* nothing to say: stay silent     */
                }
                break;
            }

            if (slot >= c.window) {
                slot = 0;
            }
            if ((uint32_t)slot < p.on_frames) {
                tx_frame(&c, c.code[p.fn_drive]);
            } else if (p.steering && c.steerfill) {
                tx_frame(&c, c.code[p.fn_steer]);
            } else {
                vTaskDelay(pdMS_TO_TICKS(off_slot_ms(&c, c.code[p.fn_drive])));
            }
            slot++;
            if (slot >= c.window) {
                slot = 0;
            }
            break;
        }

        case RX_MODE_IDLE:
        default:
            slot          = 0;
            s_pseudo_duty = 0;
            vTaskDelay(pdMS_TO_TICKS(10));
            break;
        }
    }
}

/* ------------------------------------------------------------------------------------------
 * Init
 * ---------------------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------------------------
 * TX hardware lifecycle. Split out of rx_inject_init() so that `sniff` can hand the pin over
 * and hand it back using EXACTLY the same code the boot path uses.
 *
 * ONLY the rx_tx_task ever calls these, and only from between transmissions — which is what
 * makes the handover race-free without any cross-task handshake. See sniff_session().
 * ---------------------------------------------------------------------------------------- */

static esp_err_t rx_tx_hw_open(void)
{
    /* Park the DATA pad at its idle level BEFORE the RMT channel claims it. Between reset and
     * this point the pad floats, and a floating DATA input can look to the decoder like a
     * stream of garbage functions — which is a car that lurches at power-on. */
    const gpio_config_t park = {
        .pin_bit_mask = (1ULL << ARKART_PIN_RX_DATA),
        .mode         = GPIO_MODE_OUTPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&park);
    if (err != ESP_OK) {
        return err;
    }
    gpio_set_level(ARKART_PIN_RX_DATA, s_cfg.invert ? 1 : 0);

    /* One more RMT TX channel. The WS2812 pixel already holds one; the S3 has four, and the
     * camera uses LCD_CAM/GDMA/LEDC-timer-0, none of which is RMT. */
    /* (carrier is applied right after rmt_enable below, and re-applied on `set carrier_khz`) */
    const rmt_tx_channel_config_t chan_cfg = {
        .gpio_num          = ARKART_PIN_RX_DATA,
        .clk_src           = RMT_CLK_SRC_DEFAULT,
        .resolution_hz     = RX_RMT_RESOLUTION_HZ,   /* 1 tick = 1 us */
        .mem_block_symbols = 48,                    /* one S3 RMT block; frames stream in    */
        .trans_queue_depth = 4,
    };
    err = rmt_new_tx_channel(&chan_cfg, &s_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_tx_channel failed: %s", esp_err_to_name(err));
        s_chan = NULL;
        return err;
    }

    const rmt_copy_encoder_config_t enc_cfg = {};   /* the copy encoder has no options */
    err = rmt_new_copy_encoder(&enc_cfg, &s_enc);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_copy_encoder failed: %s", esp_err_to_name(err));
        s_enc = NULL;
        return err;
    }

    err = rmt_enable(s_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_enable failed: %s", esp_err_to_name(err));
        return err;
    }
    if (s_cfg.carrier_khz != 0) {
        apply_carrier();
    }
    return ESP_OK;
}

/* Give the pin up completely. Afterwards ARKART_PIN_RX_DATA is a HIGH-IMPEDANCE INPUT: nothing
 * of ours can drive it, so there is zero contention with the signal the car's own receiver front
 * end puts on the pin-14 net.
 *
 * Three things have to be true for that, and each has its own line below:
 *   1. no transmission is in flight  — guaranteed by the caller: the only caller is the task
 *      that owns every rmt_transmit(), and tx_frame() always rmt_tx_wait_all_done()s before
 *      returning, so at this point the channel is quiescent by construction;
 *   2. the RMT peripheral is detached from the pad — rmt_disable() + rmt_del_channel(); the
 *      driver un-routes its output signal from the GPIO matrix as it deletes the channel;
 *   3. the pad's OUTPUT ENABLE is off — gpio_config(GPIO_MODE_INPUT) clears it and points the
 *      OE mux back at the GPIO register, so even a stale peripheral route cannot drive the pad.
 *      Both pull resistors are disabled too: a pull would bias a line somebody else is driving.
 * (3) alone would be sufficient for high-Z; (2) is done anyway so the channel and its RMT
 * memory block are genuinely free while we listen. */
static void rx_tx_hw_close(void)
{
    if (s_chan != NULL) {
        (void)rmt_disable(s_chan);
        (void)rmt_del_channel(s_chan);
        s_chan = NULL;
    }
    if (s_enc != NULL) {
        (void)rmt_del_encoder(s_enc);
        s_enc = NULL;
    }

    const gpio_config_t hiz = {
        .pin_bit_mask = (1ULL << ARKART_PIN_RX_DATA),
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    (void)gpio_config(&hiz);
}

esp_err_t rx_inject_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (s_lock == NULL) {
        return ESP_ERR_NO_MEM;
    }

    const esp_err_t err = rx_tx_hw_open();
    if (err != ESP_OK) {
        return err;
    }

    s_mode   = RX_MODE_IDLE;
    s_ready  = true;

    /* Core 1 with the control loop and the status pixel, away from the WiFi + camera interrupt
     * load on core 0. Priority 5 sits just under the control task (6) so a late frame can
     * never delay the watchdog. */
    if (xTaskCreatePinnedToCore(rx_tx_task, "arkart_rxtx", 3584, NULL, 5, NULL, 1) != pdPASS) {
        ESP_LOGE(TAG, "failed to create the RX injection task");
        s_ready = false;
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "Plan RX ready: gpio%d -> SA1607RX pin 14 (DATA), RMT @ 1 us ticks, "
                  "idle level %d", ARKART_PIN_RX_DATA, s_cfg.invert ? 1 : 0);
    ESP_LOGI(TAG, "frame: W1 %u pulses + %u us gap + code pulses, cell %u us @ %u%%, "
                  "inter-frame %u ms; throttle window %u frames (min %u%%)",
             (unsigned)s_cfg.w1_pulses, (unsigned)s_cfg.sgap_us, (unsigned)s_cfg.period_us,
             (unsigned)s_cfg.duty_pct, (unsigned)s_cfg.gap_ms, (unsigned)s_cfg.window,
             (unsigned)s_cfg.thr_min_pct);
    ESP_LOGW(TAG, "the ladder is the RX-2B reference table, not a measured SA1607RX table — "
                  "run `sniff` (with the car's own remote) or `sweep 4 70` before trusting it");
    return ESP_OK;
}

/* ------------------------------------------------------------------------------------------
 * drive.h contract — the reason control_udp.c and arkart_main.c need no changes
 * ---------------------------------------------------------------------------------------- */

esp_err_t drive_init(void)
{
    return rx_inject_init();
}

void drive_apply(uint8_t throttle, int8_t steer)
{
    if (!s_ready) {
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (!s_console) {
        s_mode    = RX_MODE_DRIVE;
        s_thr     = throttle;
        s_steer   = steer;
        s_reverse = false;
    }
    xSemaphoreGive(s_lock);
}

void drive_all_off(void)
{
    if (!s_ready) {
        return;
    }
    bool suppressed = false;

    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_console) {
        suppressed = true;           /* bench mode: the console owns the transmitter */
    } else {
        s_mode    = RX_MODE_IDLE;
        s_thr     = 0;
        s_steer   = 0;
        s_reverse = false;
    }
    xSemaphoreGive(s_lock);

    if (suppressed) {
        /* Loud, but at most once a second: the watchdog is firing and being ignored because a
         * human asked for bench control. RX_CONSOLE_TIMEOUT_MS is what ends it. */
        static int64_t last_us = 0;
        const int64_t now = esp_timer_get_time();
        if (now - last_us > 1000000) {
            last_us = now;
            ESP_LOGW(TAG, "drive_all_off ignored — bench console holds the transmitter "
                          "(type `stop`, or wait for the %d ms timeout)",
                     RX_CONSOLE_TIMEOUT_MS);
        }
    } else {
        s_pseudo_duty = 0;
    }
}

/* There is no analogue duty in this backend — the stock decoder is on/off. What the heartbeat
 * log wants is "how hard is this kart being driven", so report the frame-level duty cycle
 * scaled onto the same 0..ARKART_DUTY_MAX range Plan M prints. */
uint32_t drive_current_duty(void)
{
    return s_pseudo_duty;
}

/* ------------------------------------------------------------------------------------------
 * Bench / calibration API
 * ---------------------------------------------------------------------------------------- */

static void take_console_locked(void)
{
    s_console  = true;
    s_deadline = esp_timer_get_time() + (int64_t)RX_CONSOLE_TIMEOUT_MS * 1000;
}

/* Nothing may transmit while the pin is an input. Every transmit-side entry point checks this
 * first; `stop` is the only way out (or the no-edge auto-stop). */
static bool sniff_active(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    const bool busy = (s_mode == RX_MODE_SNIFF);
    xSemaphoreGive(s_lock);
    if (busy) {
        ESP_LOGE(TAG, "sniffing — the pin is an input and the transmitter is released. "
                      "`stop` first.");
    }
    return busy;
}

esp_err_t rx_inject_sniff_start(void)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_mode == RX_MODE_SNIFF) {
        xSemaphoreGive(s_lock);
        ESP_LOGW(TAG, "already sniffing");
        return ESP_OK;
    }
    s_mode    = RX_MODE_SNIFF;
    s_thr     = 0;
    s_steer   = 0;
    s_reverse = false;
    take_console_locked();
    /* Belt and braces: park the generic bench deadline past the sniff auto-stop as well as
     * exempting SNIFF from the check, so neither mechanism can cut a session short. */
    s_deadline = esp_timer_get_time() + ((int64_t)RX_SNIFF_AUTOSTOP_MS + 5000) * 1000;
    xSemaphoreGive(s_lock);

    /* The TX task picks this up within one frame (~11 ms), releases the RMT channel and starts
     * listening. It does the hardware work, not us — see sniff_session(). */
    ESP_LOGI(TAG, "SNIFF requested — releasing the transmitter...");
    return ESP_OK;
}

esp_err_t rx_inject_hold_code(uint16_t pulses)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (sniff_active()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (pulses < RX_PULSES_MIN || pulses > RX_PULSES_MAX) {
        ESP_LOGE(TAG, "code must be %d..%d", RX_PULSES_MIN, RX_PULSES_MAX);
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_raw  = pulses;
    s_mode = RX_MODE_RAW;
    take_console_locked();
    xSemaphoreGive(s_lock);
    ESP_LOGI(TAG, "holding N=%u (auto-stop in %d ms unless refreshed)",
             (unsigned)pulses, RX_CONSOLE_TIMEOUT_MS);
    return ESP_OK;
}

esp_err_t rx_inject_sweep(uint16_t from, uint16_t to)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (sniff_active()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (from < RX_PULSES_MIN || from > RX_PULSES_MAX ||
        to   < RX_PULSES_MIN || to   > RX_PULSES_MAX) {
        ESP_LOGE(TAG, "sweep bounds must be %d..%d", RX_PULSES_MIN, RX_PULSES_MAX);
        return ESP_ERR_INVALID_ARG;
    }

    const int64_t now = esp_timer_get_time();

    xSemaphoreTake(s_lock, portMAX_DELAY);
    const uint32_t hold = s_cfg.hold_ms;
    const uint32_t gap  = s_cfg.sweepgap_ms;
    s_sw_cur       = from;
    s_sw_to        = to;
    s_sw_step      = (to >= from) ? 1 : -1;
    s_sw_holding   = true;
    s_sw_phase_end = now + (int64_t)hold * 1000;
    s_sw_announced = 0xFFFFFFFFu;
    s_mode         = RX_MODE_SWEEP;
    take_console_locked();
    s_deadline     = sweep_deadline(now, &s_cfg);   /* long enough for the first count */
    xSemaphoreGive(s_lock);

    const unsigned count = (from <= to) ? (unsigned)(to - from + 1) : (unsigned)(from - to + 1);
    ESP_LOGI(TAG, "sweep %u -> %u : %u counts, %u ms each + %u ms gap, ~%u s total",
             (unsigned)from, (unsigned)to, count, (unsigned)hold, (unsigned)gap,
             (unsigned)((count * (hold + gap)) / 1000u));
    ESP_LOGI(TAG, "watch for `N=<count> SENT` and note which one moves which motor");
    return ESP_OK;
}

esp_err_t rx_inject_bench_drive(uint8_t throttle, int8_t steer, bool reverse)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (sniff_active()) {
        return ESP_ERR_INVALID_STATE;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_mode    = RX_MODE_DRIVE;
    s_thr     = throttle;
    s_steer   = steer;
    s_reverse = reverse;
    take_console_locked();
    xSemaphoreGive(s_lock);
    ESP_LOGI(TAG, "bench drive: thr %u steer %d %s (auto-stop in %d ms)",
             (unsigned)throttle, (int)steer, reverse ? "REVERSE" : "forward",
             RX_CONSOLE_TIMEOUT_MS);
    return ESP_OK;
}

void rx_inject_stop(void)
{
    if (!s_ready) {
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    const bool was_sniffing = (s_mode == RX_MODE_SNIFF);
    release_console_locked();
    xSemaphoreGive(s_lock);
    s_pseudo_duty = 0;

    if (was_sniffing) {
        /* The TX task notices within 5 ms, prints the summary and puts the RMT channel back;
         * it owns that hardware, so we must not touch it from here. */
        ESP_LOGI(TAG, "stopping the sniff session — summary and transmitter restore follow");
    } else {
        ESP_LOGI(TAG, "stopped — transmitter silent, net control resumed");
    }
}

/* ---- live tuning ------------------------------------------------------------------------ */

typedef struct {
    const char *key;
    uint16_t    off;        /* offsetof into rx_cfg_t                                       */
    uint8_t     is16;       /* 1 = uint16_t field, 0 = uint8_t field                        */
    long        min;
    long        max;
    const char *desc;
} cfg_field_t;

static const cfg_field_t k_fields[] = {
    { "period_us",   offsetof(rx_cfg_t, period_us),   1, RX_PERIOD_US_MIN, RX_PERIOD_US_MAX, "pulse cell width" },
    { "duty_pct",    offsetof(rx_cfg_t, duty_pct),    0, RX_DUTY_PCT_MIN,  RX_DUTY_PCT_MAX,  "high fraction of the cell" },
    { "gap_ms",      offsetof(rx_cfg_t, gap_ms),      1, 0,                RX_GAP_MS_MAX,    "idle between frame repeats" },
    { "w1",          offsetof(rx_cfg_t, w1_pulses),   0, 0,                RX_W1_MAX,        "pulses in the W1 sync section" },
    { "w1mult",      offsetof(rx_cfg_t, w1_mult),     0, RX_W1_MULT_MIN,   RX_W1_MULT_MAX,   "W1 pulse width, in code cells" },
    { "sgap_us",     offsetof(rx_cfg_t, sgap_us),     1, 0,                RX_SGAP_US_MAX,   "gap between W1 and the code" },
    { "window",      offsetof(rx_cfg_t, window),      0, RX_WINDOW_MIN,    RX_WINDOW_MAX,    "frames per throttle window" },
    { "thr_min_pct", offsetof(rx_cfg_t, thr_min_pct), 0, 0,                100,              "floor for non-zero throttle" },
    { "deadband",    offsetof(rx_cfg_t, deadband),    0, 0,                100,              "steer deadband, 0..100 scale" },
    { "offslot_ms",  offsetof(rx_cfg_t, offslot_ms),  1, 0,                RX_OFFSLOT_MS_MAX,"OFF-slot idle, 0 = one frame" },
    { "invert",      offsetof(rx_cfg_t, invert),      0, 0,                1,                "1 = DATA pad is active-low" },
    { "steerfill",   offsetof(rx_cfg_t, steerfill),   0, 0,                1,                "steer in the OFF slots" },
    { "hold_ms",     offsetof(rx_cfg_t, hold_ms),     1, RX_HOLD_MS_MIN,   RX_HOLD_MS_MAX,   "sweep: hold per count" },
    { "sweepgap_ms", offsetof(rx_cfg_t, sweepgap_ms), 1, 0,                RX_SWEEPGAP_MS_MAX,"sweep: gap between counts" },
    { "sniffgap_us", offsetof(rx_cfg_t, sniffgap_us), 1, RX_SNIFFGAP_US_MIN, RX_SNIFFGAP_US_MAX, "sniff: idle that ends a burst" },
    { "sniffrep_ms", offsetof(rx_cfg_t, sniffrep_ms), 1, RX_SNIFFREP_MS_MIN, RX_SNIFFREP_MS_MAX, "sniff: repeat re-print interval" },
    { "carrier_khz", offsetof(rx_cfg_t, carrier_khz), 1, 0,                RX_CARRIER_KHZ_MAX, "0 = baseband; else OOK carrier (ANT)" },
};
#define K_FIELD_COUNT   (sizeof(k_fields) / sizeof(k_fields[0]))

static long cfg_field_get(const cfg_field_t *f, const rx_cfg_t *cfg)
{
    const uint8_t *base = (const uint8_t *)cfg;
    if (f->is16) {
        uint16_t v;
        memcpy(&v, base + f->off, sizeof(v));
        return (long)v;
    }
    return (long)*(base + f->off);
}

esp_err_t rx_inject_cfg_set(const char *key, long value)
{
    if (key == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    for (size_t i = 0; i < K_FIELD_COUNT; i++) {
        const cfg_field_t *f = &k_fields[i];
        if (strcasecmp(key, f->key) != 0) {
            continue;
        }
        if (value < f->min || value > f->max) {
            ESP_LOGE(TAG, "%s must be %ld..%ld (%s)", f->key, f->min, f->max, f->desc);
            return ESP_ERR_INVALID_ARG;
        }
        xSemaphoreTake(s_lock, portMAX_DELAY);
        uint8_t *base = (uint8_t *)&s_cfg;
        if (f->is16) {
            const uint16_t v = (uint16_t)value;
            memcpy(base + f->off, &v, sizeof(v));
        } else {
            *(base + f->off) = (uint8_t)value;
        }
        xSemaphoreGive(s_lock);
        ESP_LOGI(TAG, "set %s = %ld", f->key, value);
        if (strcasecmp(key, "carrier_khz") == 0 || strcasecmp(key, "invert") == 0) {
            apply_carrier();    /* polarity flag tracks invert, so both keys re-apply */
        }
        return ESP_OK;
    }
    ESP_LOGE(TAG, "unknown key '%s' — type `help` for the list", key);
    return ESP_ERR_NOT_FOUND;
}

const char *rx_fn_name(rx_fn_t fn)
{
    return ((int)fn >= 0 && (int)fn < (int)RX_FN_COUNT) ? k_fn_names[fn] : "?";
}

rx_fn_t rx_fn_from_name(const char *name)
{
    if (name != NULL) {
        for (int i = 0; i < RX_FN_COUNT; i++) {
            if (strcasecmp(name, k_fn_names[i]) == 0) {
                return (rx_fn_t)i;
            }
        }
    }
    return RX_FN_COUNT;
}

esp_err_t rx_inject_code_set(const char *name, long pulses)
{
    const rx_fn_t fn = rx_fn_from_name(name);
    if (fn == RX_FN_COUNT) {
        ESP_LOGE(TAG, "unknown function '%s' — type `show` for the ladder", name ? name : "");
        return ESP_ERR_NOT_FOUND;
    }
    if (pulses < RX_PULSES_MIN || pulses > RX_PULSES_MAX) {
        ESP_LOGE(TAG, "pulse count must be %d..%d", RX_PULSES_MIN, RX_PULSES_MAX);
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_cfg.code[fn] = (uint16_t)pulses;
    xSemaphoreGive(s_lock);
    ESP_LOGI(TAG, "set code %s = %ld pulses", rx_fn_name(fn), pulses);
    return ESP_OK;
}

void rx_inject_cfg_dump(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    const rx_cfg_t c = s_cfg;
    const rx_mode_t mode = s_mode;
    const bool console = s_console;
    xSemaphoreGive(s_lock);

    static const char *const mode_names[] = { "idle", "drive", "raw-code", "sweep", "sniff" };
    _Static_assert(sizeof(mode_names) / sizeof(mode_names[0]) == (size_t)RX_MODE_SNIFF + 1,
                   "mode_names must name every rx_mode_t");

    printf("\n--- Plan RX state -------------------------------------------------------\n");
    printf("  DATA pad      gpio%d   mode %s%s\n", ARKART_PIN_RX_DATA,
           mode_names[(int)mode], console ? "  [BENCH OVERRIDE]" : "");
    printf("  timing        ");
    for (size_t i = 0; i < K_FIELD_COUNT; i++) {
        printf("%s=%ld  ", k_fields[i].key, cfg_field_get(&k_fields[i], &c));
        if ((i % 5) == 4 && i + 1 < K_FIELD_COUNT) {
            printf("\n                ");
        }
    }
    printf("\n  frame         W1 %u + gap %u us + code, cell %u us @ %u%%, +%u ms\n",
           (unsigned)c.w1_pulses, (unsigned)c.sgap_us, (unsigned)c.period_us,
           (unsigned)c.duty_pct, (unsigned)c.gap_ms);
    printf("  function ladder (pulse counts — `set code <name> <n>` to retune):\n");
    for (int i = 0; i < RX_FN_COUNT; i++) {
        printf("      %-10s %3u%s", k_fn_names[i], (unsigned)c.code[i],
               ((i % 3) == 2) ? "\n" : "");
    }
    printf("\n  a FORWARD frame is %u us long; one %u-frame window is ~%u ms\n",
           (unsigned)frame_us(&c, c.code[RX_FN_FORWARD]), (unsigned)c.window,
           (unsigned)((frame_us(&c, c.code[RX_FN_FORWARD]) * c.window) / 1000u));
    printf("-------------------------------------------------------------------------\n\n");
    fflush(stdout);
}

void rx_inject_print_help(void)
{
    printf("\n=========================================================================\n");
    printf(" PLAN RX — radio-socket injection, bench console   (DATA = gpio%d, + GND)\n",
           ARKART_PIN_RX_DATA);
    printf("=========================================================================\n");
    printf(" LISTEN      sniff               BEST: release the pin to high-Z input and read\n");
    printf("                                 the REAL protocol off the wire while you press\n");
    printf("                                 the car's own 27 MHz remote. One line per burst:\n");
    printf("                                 pulse count, period, duty, gap, idle level.\n");
    printf("                                 `stop` ends it (auto-stop %ds with no edge).\n",
           RX_SNIFF_AUTOSTOP_MS / 1000);
    printf(" CALIBRATE   sweep <from> <to>   no remote? transmit each count, ~%u ms each,\n",
           (unsigned)RX_DEF_HOLD_MS);
    printf("                                 logs `N=<count> SENT` — note what moves\n");
    printf("             code <n>            hold ONE pulse count until `stop`\n");
    printf("             set code <name> <n> write a confirmed count into the ladder\n");
    printf("                                 names: fwd turbo slot2 fwdleft fwdright\n");
    printf("                                        back backright backleft left right\n");
    printf(" SMOKE TEST  fwd <0..255>        drive via the normal mapping\n");
    printf("             back <0..255>       same, using the BACKWARD codes (bench only)\n");
    printf("             steer <-100..100>   set steer, keep throttle\n");
    printf("             stop                silence the transmitter, resume net control\n");
    printf(" TUNE        set <key> <value>   period_us duty_pct gap_ms w1 sgap_us\n");
    printf("                                 window thr_min_pct deadband offslot_ms\n");
    printf("                                 invert steerfill hold_ms sweepgap_ms\n");
    printf("                                 sniffgap_us sniffrep_ms\n");
    printf(" INSPECT     show                current timings + ladder      help   this\n");
    printf("-------------------------------------------------------------------------\n");
    printf(" Chip: SA1607RX 330 (SOP-16), RX-2B-family 5-function. Wire -> its pin 14\n");
    printf(" (demodulated data), ESP32 GND -> board V-. The pulse counts in the ladder\n");
    printf(" are the RX-2B REFERENCE table, not a measured one: clones deviate, so\n");
    printf(" `sniff` (or failing that `sweep`) is the ground truth. TRANSMITTING bench\n");
    printf(" commands auto-stop after %d ms without a refresh, so a walk-away cannot\n",
           RX_CONSOLE_TIMEOUT_MS);
    printf(" pin a motor; `sniff` transmits nothing and so gets the longer leash.\n");
    printf("=========================================================================\n\n");
    fflush(stdout);
}
