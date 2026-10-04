/*
 * btn_remote.c — electrical finger on the stock remote's four buttons. See btn_remote.h for the
 * electrical contract, the pin map and the hold model; the one line worth repeating here is:
 *
 *      A BUTTON PIN IS NEVER DRIVEN HIGH. Pressed = pulled low (open drain). Released =
 *      high-impedance input, pulls disabled. Nothing else is ever written to these pads.
 *
 * Everything in this file runs in one of three places:
 *   - btn_remote_init(), once, from app_main before the console exists;
 *   - the console command entry points, from the console task;
 *   - btn_task(), a 5 ms tick of its own on core 1, which is the ONLY thing that advances the
 *     throttle chop and the command watchdog. It deliberately does not live in arkart_rxtx:
 *     that task's stack is sized to the RMT frame builder with nothing to spare, and it must
 *     not be made to miss a frame deadline by unrelated work.
 * All of them mutate state only under s_lock, and apply_locked() is the single place that ever
 * touches a pad.
 */

#include "btn_remote.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "btn_remote";

/* 5 ms is ~4 % of the default 120 ms chop window and two orders of magnitude cheaper than the
 * ~36 ms the car's decoder integrates over, so the chop lands well inside tolerance. */
#define BTN_TICK_MS         5

#define M(b)                ((uint8_t)(1u << (b)))
#define BTN_MASK_STEER      ((uint8_t)(M(BTN_LEFT) | M(BTN_RIGHT)))
#define BTN_MASK_DRIVE      ((uint8_t)(M(BTN_FWD)  | M(BTN_BACK)))
#define BTN_MASK_ALL        ((uint8_t)(BTN_MASK_STEER | BTN_MASK_DRIVE))

_Static_assert(BTN_COUNT == 4, "the mask type is a uint8_t bitfield over exactly four buttons");

#define NAME_BUF            48      /* "left+right+back+fwd" plus slack */

typedef struct {
    const char *name;               /* console name                        */
    const char *key;                /* the remote's own key designation    */
    gpio_num_t  pin;
} btn_def_t;

/* Index order == GPIO order 39,40,41,42, so `btnstat` reads down the harness. NOT key order:
 * 42 is FWD (K3) and 41 is BACK (K4) by the user's locked wiring. */
static const btn_def_t k_btns[BTN_COUNT] = {
    { "left",  "K1", (gpio_num_t)ARKART_PIN_BTN_LEFT  },
    { "right", "K2", (gpio_num_t)ARKART_PIN_BTN_RIGHT },
    { "back",  "K4", (gpio_num_t)ARKART_PIN_BTN_BACK  },
    { "fwd",   "K3", (gpio_num_t)ARKART_PIN_BTN_FWD   },
};

static SemaphoreHandle_t s_lock = NULL;
static bool              s_ready = false;

static uint8_t  s_held  = 0;        /* LOGICAL hold set — what the operator asked for        */
static uint8_t  s_phys  = 0;        /* ELECTRICAL set — what is actually pulled low now      */
static uint8_t  s_thr_pct      = BTN_THR_PCT_DEF;
static uint16_t s_window_ms    = BTN_WINDOW_MS_DEF;
static uint16_t s_watchdog_ms  = BTN_WATCHDOG_MS_DEF;
static int64_t  s_last_cmd_us  = 0; /* refreshed by press / release / thr                    */
static int64_t  s_phase_t0     = 0; /* chop window origin; reset so a press starts ON        */
static bool     s_wd_fired     = false;

/* ------------------------------------------------------------------------------------------
 * The two primitives. Nothing else in the file writes a pad.
 * ---------------------------------------------------------------------------------------- */

/* PRESS. Level register to 0 FIRST, so the pad's first driven state cannot be high, and only
 * then the output enable — as open drain, so the high-side driver stays disconnected and the
 * pad is physically incapable of sourcing into a finger holding the rubber button down. The
 * INPUT_ half of the mode keeps the input buffer on, so `btnstat` reports the real pad voltage
 * rather than an echo of our own intent. */
static void pin_press(gpio_num_t pin)
{
    (void)gpio_set_level(pin, 0);
    (void)gpio_set_direction(pin, GPIO_MODE_INPUT_OUTPUT_OD);
    (void)gpio_set_level(pin, 0);
}

/* RELEASE. Back to plain input; pulls stay disabled, so the remote's own pull-up is the only
 * thing holding the pad, exactly as when a thumb lifts off. */
static void pin_release(gpio_num_t pin)
{
    (void)gpio_set_direction(pin, GPIO_MODE_INPUT);
    (void)gpio_set_pull_mode(pin, GPIO_FLOATING);
}

/* ------------------------------------------------------------------------------------------
 * Throttle chop
 * ---------------------------------------------------------------------------------------- */

/* ON milliseconds per window for the drive key. 0 = never pressed, >= window = solid hold. */
static uint32_t chop_on_ms_locked(void)
{
    if (s_thr_pct >= 100) {
        return s_window_ms;
    }
    if (s_thr_pct == 0) {
        return 0;
    }
    uint32_t on = ((uint32_t)s_window_ms * (uint32_t)s_thr_pct) / 100u;
    if (on < BTN_ON_MS_FLOOR) {
        on = BTN_ON_MS_FLOOR;        /* below ~2 decoder frames a press is simply not seen */
    }
    if (on > (uint32_t)s_window_ms) {
        on = s_window_ms;
    }
    return on;
}

/* Which buttons should be electrically down right now. Steering is never chopped. */
static uint8_t desired_locked(int64_t now)
{
    uint8_t want = s_held;

    if ((s_held & BTN_MASK_DRIVE) != 0) {
        const uint32_t on_ms = chop_on_ms_locked();
        if (on_ms == 0) {
            want &= (uint8_t)~BTN_MASK_DRIVE;
        } else if (on_ms < (uint32_t)s_window_ms) {
            const int64_t win_us = (int64_t)s_window_ms * 1000;
            int64_t phase = now - s_phase_t0;
            if (phase < 0) {
                phase = 0;
            }
            phase %= win_us;
            if (phase >= (int64_t)on_ms * 1000) {
                want &= (uint8_t)~BTN_MASK_DRIVE;
            }
        }
    }
    return want;
}

/* Reconcile the pads with the desired set. Diff-driven: an unchanged pin is not re-written, so
 * a solid hold is a single press for its whole duration and not a 200 Hz re-assertion.
 *
 * RELEASES GO FIRST, in their own pass. That is what makes most-recent-wins true at the pad and
 * not just in the bookkeeping: on `press back` while FWD is held, the outgoing FWD pad is let go
 * before the incoming BACK pad is pulled down, so the remote's encoder never sees the two
 * shorted together — not even for the microseconds a single interleaved pass would have cost. */
static void apply_locked(int64_t now)
{
    const uint8_t want = desired_locked(now);

    for (int i = 0; i < BTN_COUNT; i++) {
        const uint8_t m = M(i);
        if ((s_phys & m) && !(want & m)) {
            pin_release(k_btns[i].pin);
            s_phys &= (uint8_t)~m;
        }
    }
    for (int i = 0; i < BTN_COUNT; i++) {
        const uint8_t m = M(i);
        if ((want & m) && !(s_phys & m)) {
            pin_press(k_btns[i].pin);
            s_phys |= m;
        }
    }
    s_phys = want;
}

/* ------------------------------------------------------------------------------------------
 * Names / printing
 * ---------------------------------------------------------------------------------------- */

const char *btn_remote_name(btn_id_t b)
{
    return ((int)b >= 0 && (int)b < (int)BTN_COUNT) ? k_btns[b].name : "?";
}

btn_id_t btn_remote_from_name(const char *name)
{
    if (name == NULL) {
        return BTN_COUNT;
    }
    for (int i = 0; i < BTN_COUNT; i++) {
        if (strcasecmp(name, k_btns[i].name) == 0) {
            return (btn_id_t)i;
        }
    }
    /* A couple of aliases, because at a bench at 2 a.m. nobody remembers which spelling. */
    if (strcasecmp(name, "forward") == 0) {
        return BTN_FWD;
    }
    if (strcasecmp(name, "backward") == 0 || strcasecmp(name, "rev") == 0 ||
        strcasecmp(name, "reverse") == 0) {
        return BTN_BACK;
    }
    return BTN_COUNT;
}

static void mask_str(uint8_t m, char *out, size_t cap)
{
    if (cap == 0) {
        return;
    }
    out[0] = '\0';
    bool first = true;
    for (int i = 0; i < BTN_COUNT; i++) {
        if (!(m & M(i))) {
            continue;
        }
        if (!first) {
            strlcat(out, "+", cap);
        }
        strlcat(out, k_btns[i].name, cap);
        first = false;
    }
    if (first) {
        strlcpy(out, "none", cap);
    }
}

/* The single-line response every command echoes. Printed OUTSIDE the lock. */
static void print_line(const char *verb, const char *arg, uint8_t held, uint8_t phys,
                       uint8_t dropped)
{
    char h[NAME_BUF];
    char p[NAME_BUF];
    char d[NAME_BUF];
    mask_str(held, h, sizeof(h));
    mask_str(phys, p, sizeof(p));

    if (dropped != 0) {
        mask_str(dropped, d, sizeof(d));
        printf("btn %s %s -> held [%s]  down [%s]  (auto-released %s: conflicting pair)\n",
               verb, arg, h, p, d);
    } else {
        printf("btn %s %s -> held [%s]  down [%s]\n", verb, arg, h, p);
    }
    fflush(stdout);
}

/* ------------------------------------------------------------------------------------------
 * Commands
 * ---------------------------------------------------------------------------------------- */

esp_err_t btn_remote_press(btn_id_t b)
{
    if (!s_ready) {
        ESP_LOGE(TAG, "button tap not initialised");
        return ESP_ERR_INVALID_STATE;
    }
    if ((int)b < 0 || (int)b >= (int)BTN_COUNT) {
        return ESP_ERR_INVALID_ARG;
    }

    const uint8_t m    = M(b);
    const uint8_t pair = (m & BTN_MASK_DRIVE) ? BTN_MASK_DRIVE : BTN_MASK_STEER;

    xSemaphoreTake(s_lock, portMAX_DELAY);
    const uint8_t dropped = (uint8_t)(s_held & pair & ~m);
    /* MOST-RECENT-WINS: the opposite member of the pair leaves the hold set in the same
     * operation as the new one joins it, so apply_locked() never sees both down. */
    s_held = (uint8_t)((s_held & ~pair) | m);
    const int64_t now = esp_timer_get_time();
    if (m & BTN_MASK_DRIVE) {
        s_phase_t0 = now;            /* a fresh drive press always begins with its ON phase */
    }
    s_last_cmd_us = now;
    s_wd_fired    = false;
    apply_locked(now);
    const uint8_t held = s_held;
    const uint8_t phys = s_phys;
    xSemaphoreGive(s_lock);

    print_line("press", btn_remote_name(b), held, phys, dropped);
    return ESP_OK;
}

esp_err_t btn_remote_release(btn_id_t b)
{
    if (!s_ready) {
        ESP_LOGE(TAG, "button tap not initialised");
        return ESP_ERR_INVALID_STATE;
    }
    if ((int)b < 0 || (int)b >= (int)BTN_COUNT) {
        return ESP_ERR_INVALID_ARG;
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_held = (uint8_t)(s_held & ~M(b));
    const int64_t now = esp_timer_get_time();
    s_last_cmd_us = now;
    s_wd_fired    = false;
    apply_locked(now);
    const uint8_t held = s_held;
    const uint8_t phys = s_phys;
    xSemaphoreGive(s_lock);

    print_line("release", btn_remote_name(b), held, phys, 0);
    return ESP_OK;
}

void btn_remote_release_all(void)
{
    if (!s_ready) {
        return;
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_held = 0;
    const int64_t now = esp_timer_get_time();
    s_last_cmd_us = now;
    s_wd_fired    = false;
    apply_locked(now);
    const uint8_t held = s_held;
    const uint8_t phys = s_phys;
    xSemaphoreGive(s_lock);

    print_line("release", "all", held, phys, 0);
}

esp_err_t btn_remote_set_throttle(long pct)
{
    if (!s_ready) {
        ESP_LOGE(TAG, "button tap not initialised");
        return ESP_ERR_INVALID_STATE;
    }
    if (pct < 0 || pct > 100) {
        ESP_LOGE(TAG, "thr must be 0..100 (100 = solid hold, 0 = drive key stays released)");
        return ESP_ERR_INVALID_ARG;
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_thr_pct = (uint8_t)pct;
    const int64_t now = esp_timer_get_time();
    s_phase_t0    = now;             /* re-phase so the new duty starts with its ON slice */
    s_last_cmd_us = now;
    s_wd_fired    = false;
    const uint32_t on_ms = chop_on_ms_locked();
    const uint16_t win   = s_window_ms;
    apply_locked(now);
    const uint8_t held = s_held;
    const uint8_t phys = s_phys;
    xSemaphoreGive(s_lock);

    char h[NAME_BUF];
    char p[NAME_BUF];
    mask_str(held, h, sizeof(h));
    mask_str(phys, p, sizeof(p));
    if (on_ms == 0) {
        printf("btn thr 0 -> drive key stays RELEASED (steer still works)  held [%s]\n", h);
    } else if (on_ms >= (uint32_t)win) {
        printf("btn thr %ld -> SOLID hold, no chopping  held [%s]  down [%s]\n", pct, h, p);
    } else {
        printf("btn thr %ld -> %u ms on / %u ms off per %u ms window (%u%% effective"
               "%s)  held [%s]  down [%s]\n",
               pct, (unsigned)on_ms, (unsigned)(win - on_ms), (unsigned)win,
               (unsigned)((on_ms * 100u) / win),
               (on_ms > ((uint32_t)win * (uint32_t)pct) / 100u) ? ", floored at the 50 ms"
                                                                  " decoder minimum" : "",
               h, p);
    }
    fflush(stdout);
    return ESP_OK;
}

/* The net layer's whole-state entry point. See btn_remote.h for why the console trio is not
 * usable at packet rate. Deliberately SILENT — net_drive.c calls this ~100 times a second. */
esp_err_t btn_remote_set_state(btn_drive_dir_t drive, btn_steer_dir_t steer, uint8_t thr_pct)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (thr_pct > 100) {
        thr_pct = 100;
    }

    /* Build the target set directly. One member of each pair at most, so the mutual exclusion
     * is structural here rather than a conflict to resolve. */
    uint8_t want = 0;
    if (drive == BTN_DRIVE_FWD) {
        want |= M(BTN_FWD);
    } else if (drive == BTN_DRIVE_BACK) {
        want |= M(BTN_BACK);
    }
    if (steer == BTN_STEER_LEFT) {
        want |= M(BTN_LEFT);
    } else if (steer == BTN_STEER_RIGHT) {
        want |= M(BTN_RIGHT);
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    const int64_t now = esp_timer_get_time();
    /* Re-base the chop window only when the DRIVE key changes. Re-basing on every call — which
     * is what btn_remote_set_throttle() does, correctly, for a human typing — would restart
     * every window inside its ON slice and turn any throttle into a solid hold. */
    if ((want & BTN_MASK_DRIVE) != (s_held & BTN_MASK_DRIVE)) {
        s_phase_t0 = now;
    }
    s_held        = want;
    s_thr_pct     = thr_pct;
    s_last_cmd_us = now;        /* this is what feeds the 300 ms leash at 50 Hz */
    s_wd_fired    = false;
    apply_locked(now);
    xSemaphoreGive(s_lock);

    return ESP_OK;
}

esp_err_t btn_remote_cfg_set(const char *key, long value)
{
    if (key == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (strcasecmp(key, "btn_thr_pct") == 0) {
        return btn_remote_set_throttle(value);
    }

    if (strcasecmp(key, "btn_window_ms") == 0) {
        if (value < BTN_WINDOW_MS_MIN || value > BTN_WINDOW_MS_MAX) {
            ESP_LOGE(TAG, "btn_window_ms must be %d..%d (throttle chop window)",
                     BTN_WINDOW_MS_MIN, BTN_WINDOW_MS_MAX);
            return ESP_ERR_INVALID_ARG;
        }
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_window_ms = (uint16_t)value;
        const int64_t now = esp_timer_get_time();
        s_phase_t0 = now;
        apply_locked(now);
        xSemaphoreGive(s_lock);
        ESP_LOGI(TAG, "set btn_window_ms = %ld", value);
        return ESP_OK;
    }

    if (strcasecmp(key, "btn_watchdog_ms") == 0) {
        if (value < 0 || value > BTN_WATCHDOG_MS_MAX) {
            ESP_LOGE(TAG, "btn_watchdog_ms must be 0..%d (0 = off)", BTN_WATCHDOG_MS_MAX);
            return ESP_ERR_INVALID_ARG;
        }
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_watchdog_ms = (uint16_t)value;
        s_last_cmd_us = esp_timer_get_time();   /* a fresh leash, not an instant trip */
        s_wd_fired    = false;
        xSemaphoreGive(s_lock);
        ESP_LOGI(TAG, "set btn_watchdog_ms = %ld%s", value, (value == 0) ? " (off)" : "");
        return ESP_OK;
    }

    /* Quiet miss on purpose: the console tries this module first and falls through. */
    return ESP_ERR_NOT_FOUND;
}

void btn_remote_status(void)
{
    if (!s_ready) {
        printf("button tap not initialised\n");
        return;
    }

    /* Snapshot under the lock, then read the pads and print outside it. */
    xSemaphoreTake(s_lock, portMAX_DELAY);
    const uint8_t  held   = s_held;
    const uint8_t  phys   = s_phys;
    const uint8_t  thr    = s_thr_pct;
    const uint16_t win    = s_window_ms;
    const uint16_t wdog   = s_watchdog_ms;
    const uint32_t on_ms  = chop_on_ms_locked();
    const int64_t  since  = esp_timer_get_time() - s_last_cmd_us;
    xSemaphoreGive(s_lock);

    int level[BTN_COUNT];
    for (int i = 0; i < BTN_COUNT; i++) {
        level[i] = gpio_get_level(k_btns[i].pin);
    }

    printf("\n--- stock-remote button tap ---------------------------------------------\n");
    printf("  dir    gpio  key  logical   electrical  pad  pin mode\n");
    for (int i = 0; i < BTN_COUNT; i++) {
        const bool h = (held & M(i)) != 0;
        const bool p = (phys & M(i)) != 0;
        printf("  %-5s   %2d   %-2s   %-8s  %-10s  %d    %s\n",
               k_btns[i].name, (int)k_btns[i].pin, k_btns[i].key,
               h ? "HELD" : "released",
               p ? "PRESSED" : "released",
               level[i],
               p ? "in+out open-drain, level 0" : "input, pulls disabled (floating)");
    }
    printf("  throttle      %u %%  ", (unsigned)thr);
    if (on_ms == 0) {
        printf("drive key held RELEASED\n");
    } else if (on_ms >= (uint32_t)win) {
        printf("solid hold, no chopping\n");
    } else {
        printf("%u ms on / %u ms off per %u ms window\n",
               (unsigned)on_ms, (unsigned)(win - on_ms), (unsigned)win);
    }
    printf("  btn_window_ms %u    btn_watchdog_ms %u%s    last command %lld ms ago\n",
           (unsigned)win, (unsigned)wdog, (wdog == 0) ? " (off)" : "", since / 1000);
    printf("  a pressed pin PULLS LOW only — never driven high, pulls always disabled.\n");
    printf("  pad reads 1 when released ONLY with the remote wired and powered (its own\n");
    printf("  pull-ups hold the pads high); unwired, a floating pad reads either way.\n");
    printf("-------------------------------------------------------------------------\n\n");
    fflush(stdout);
}

void btn_remote_print_help(void)
{
    printf("\n=========================================================================\n");
    printf(" STOCK-REMOTE BUTTON TAP — gpio%d left, gpio%d right, gpio%d back, gpio%d fwd\n",
           ARKART_PIN_BTN_LEFT, ARKART_PIN_BTN_RIGHT, ARKART_PIN_BTN_BACK,
           ARKART_PIN_BTN_FWD);
    printf("=========================================================================\n");
    printf(" DRIVE    press <fwd|back|left|right>    press and HOLD until released\n");
    printf("          release <fwd|back|left|right|all>\n");
    printf("          thr <0..100>                   drive-key chop: 100 = solid hold\n");
    printf("                                         (default), 0 = key stays released\n");
    printf(" INSPECT  btnstat                        per-button state, live pad level,\n");
    printf("                                         throttle/window/watchdog  [SAFE]\n");
    printf(" TUNE     set btn_window_ms <%d..%d>     chop window, default %d ms\n",
           BTN_WINDOW_MS_MIN, BTN_WINDOW_MS_MAX, BTN_WINDOW_MS_DEF);
    printf("          set btn_watchdog_ms <0..%d>  0 = off (bench default); >0 releases\n",
           BTN_WATCHDOG_MS_MAX);
    printf("                                         everything after that long with no\n");
    printf("                                         press/release/thr (net layer: 300)\n");
    printf("          set btn_thr_pct <0..100>       same as `thr`\n");
    printf("-------------------------------------------------------------------------\n");
    printf(" LEFT+RIGHT and FWD+BACK are mutually exclusive, most-recent-wins: pressing\n");
    printf(" fwd while back is held releases back in the same breath. fwd+left and the\n");
    printf(" like are legal and work together — the remote's encoder sends real combo\n");
    printf(" codes. A press PULLS THE PAD LOW through an open-drain pin and never drives\n");
    printf(" it high, so you can press the rubber button at the same time without a\n");
    printf(" fight. `stop` and ctrl-C release every button.\n");
    printf("=========================================================================\n\n");
    fflush(stdout);
}

/* ------------------------------------------------------------------------------------------
 * The chop / watchdog tick. Its own task: small, core 1, below the RMT frame task's priority
 * so it can never delay a frame, and silent — no per-tick printing at all.
 * ---------------------------------------------------------------------------------------- */
static void btn_task(void *arg)
{
    (void)arg;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(BTN_TICK_MS));

        const int64_t now = esp_timer_get_time();
        bool     fired = false;
        uint16_t wdog  = 0;

        xSemaphoreTake(s_lock, portMAX_DELAY);
        if (s_watchdog_ms > 0 && s_held != 0 &&
            (now - s_last_cmd_us) > (int64_t)s_watchdog_ms * 1000) {
            s_held     = 0;
            fired      = !s_wd_fired;
            s_wd_fired = true;
            wdog       = s_watchdog_ms;
        }
        apply_locked(now);
        xSemaphoreGive(s_lock);

        if (fired) {
            ESP_LOGW(TAG, "watchdog: %u ms with no press/release/thr — all buttons released",
                     (unsigned)wdog);
        }
    }
}

esp_err_t btn_remote_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (s_lock == NULL) {
        ESP_LOGE(TAG, "no memory for the button lock");
        return ESP_ERR_NO_MEM;
    }

    /* Park every pad as a floating input BEFORE anything else can look at it. Explicit about
     * both pulls: GPIO39..42 are the JTAG group and must not be left on whatever the ROM or a
     * gpio_reset_pin() default would give them — a pull-DOWN there is a permanent soft press,
     * and a pull-UP of ours only fights the remote's. The level register is pre-loaded to 0 as
     * well, so the first press has nothing to glitch from. */
    for (int i = 0; i < BTN_COUNT; i++) {
        const gpio_config_t cfg = {
            .pin_bit_mask = 1ULL << (unsigned)k_btns[i].pin,
            .mode         = GPIO_MODE_INPUT,
            .pull_up_en   = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type    = GPIO_INTR_DISABLE,
        };
        const esp_err_t err = gpio_config(&cfg);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "gpio%d (%s) config failed: %s",
                     (int)k_btns[i].pin, k_btns[i].name, esp_err_to_name(err));
            vSemaphoreDelete(s_lock);
            s_lock = NULL;
            return err;
        }
        (void)gpio_set_level(k_btns[i].pin, 0);
    }

    s_held        = 0;
    s_phys        = 0;
    s_thr_pct     = BTN_THR_PCT_DEF;
    s_window_ms   = BTN_WINDOW_MS_DEF;
    s_watchdog_ms = BTN_WATCHDOG_MS_DEF;
    s_last_cmd_us = esp_timer_get_time();
    s_phase_t0    = s_last_cmd_us;
    s_wd_fired    = false;
    s_ready       = true;

    /* Priority 4 on core 1: under the RMT frame task (5) so a 5 ms button tick can never push
     * a frame late, over the status LED, and off core 0 where WiFi and the HTTP stream live. */
    if (xTaskCreatePinnedToCore(btn_task, "arkart_btn", 2816, NULL, 4, NULL, 1) != pdPASS) {
        ESP_LOGE(TAG, "failed to create the button chop/watchdog task");
        s_ready = false;
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "stock-remote tap ready — left gpio%d, right gpio%d, back gpio%d, fwd gpio%d;"
                  " all released (input, pulls disabled)",
             ARKART_PIN_BTN_LEFT, ARKART_PIN_BTN_RIGHT, ARKART_PIN_BTN_BACK,
             ARKART_PIN_BTN_FWD);
    ESP_LOGI(TAG, "thr %u%% (solid), btn_window_ms %u, btn_watchdog_ms %u (off)",
             (unsigned)BTN_THR_PCT_DEF, (unsigned)BTN_WINDOW_MS_DEF,
             (unsigned)BTN_WATCHDOG_MS_DEF);
    return ESP_OK;
}
