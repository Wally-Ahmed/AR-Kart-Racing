#include "drive.h"
#include "motor_map.h"

#include <stdbool.h>
#include <stdlib.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_rom_sys.h"

static const char *TAG = "drive";

/* Catch a mis-set throttle cap at compile time rather than at 2 a.m. on the track. A ceiling
 * below the motor's break-away duty means the kart silently never moves, which looks exactly
 * like a dead transistor or a bad solder joint. */
_Static_assert(ARKART_MAX_DUTY > 0 && ARKART_MAX_DUTY <= 100,
               "ARKART_MAX_DUTY is a percentage: it must be in 1..100");
_Static_assert(ARKART_DRIVE_DUTY_CEILING > ARKART_MIN_DUTY,
               "ARKART_MAX_DUTY caps the drive below ARKART_MIN_DUTY - the kart could never "
               "move. Raise ARKART_MAX_DUTY or lower ARKART_MIN_DUTY.");

typedef enum {
    STEER_SIDE_OFF = 0,
    STEER_SIDE_A,
    STEER_SIDE_B,
} steer_side_t;

static uint32_t      s_drive_duty = 0;
static steer_side_t  s_steer_side = STEER_SIDE_OFF;
static bool          s_ready      = false;

/* ---------------------------------------------------------------------------------------- */

static inline void set_duty(ledc_channel_t ch, uint32_t duty)
{
    if (duty > ARKART_DUTY_MAX) {
        duty = ARKART_DUTY_MAX;
    }
    /* ledc_set_duty_and_update() is the thread-safe one; the plain set_duty/update_duty pair
     * is not safe to interleave from two tasks. */
    ledc_set_duty_and_update(ARKART_LEDC_MODE, ch, duty, 0);
}

esp_err_t drive_init(void)
{
    esp_err_t err;

    /* ledc_set_duty_and_update() requires the LEDC fade service (found on hardware: without
     * this every duty write fails with "Fade service not installed" and the motors never move). */
    err = ledc_fade_func_install(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {   /* INVALID_STATE = already installed */
        ESP_LOGE(TAG, "ledc_fade_func_install failed: %s", esp_err_to_name(err));
        return err;
    }

    /* Park the pads at their safe level BEFORE LEDC takes them over. Between reset and this
     * point the pads float; on Variant P a floating steer pad can read as "energised" at the
     * level shifter. One gpio_set_level() closes that window. */
    const gpio_config_t park = {
        .pin_bit_mask = (1ULL << ARKART_PIN_DRIVE_PWM) |
                        (1ULL << ARKART_PIN_STEER_A) |
                        (1ULL << ARKART_PIN_STEER_B),
        .mode         = GPIO_MODE_OUTPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    err = gpio_config(&park);
    if (err != ESP_OK) {
        return err;
    }
    gpio_set_level(ARKART_PIN_DRIVE_PWM, ARKART_DRIVE_IDLE_PAD_LEVEL);
    gpio_set_level(ARKART_PIN_STEER_A,   ARKART_STEER_IDLE_PAD_LEVEL);
    gpio_set_level(ARKART_PIN_STEER_B,   ARKART_STEER_IDLE_PAD_LEVEL);

    /* Motor timer. NOT LEDC_TIMER_0 — the camera driver owns timer 0 for XCLK and sharing it
     * silently breaks the camera. */
    const ledc_timer_config_t timer = {
        .speed_mode      = ARKART_LEDC_MODE,
        .duty_resolution = ARKART_PWM_RES,
        .timer_num       = ARKART_LEDC_MOTOR_TIMER,
        .freq_hz         = ARKART_PWM_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    err = ledc_timer_config(&timer);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ledc_timer_config failed: %s", esp_err_to_name(err));
        return err;
    }

    const ledc_channel_config_t channels[] = {
        {
            .gpio_num   = ARKART_PIN_DRIVE_PWM,
            .speed_mode = ARKART_LEDC_MODE,
            .channel    = ARKART_LEDC_CH_DRIVE,
            .intr_type  = LEDC_INTR_DISABLE,
            .timer_sel  = ARKART_LEDC_MOTOR_TIMER,
            .duty       = 0,
            .hpoint     = 0,
            .flags      = { .output_invert = ARKART_DRIVE_OUTPUT_INVERT },
        },
        {
            .gpio_num   = ARKART_PIN_STEER_A,
            .speed_mode = ARKART_LEDC_MODE,
            .channel    = ARKART_LEDC_CH_STEER_A,
            .intr_type  = LEDC_INTR_DISABLE,
            .timer_sel  = ARKART_LEDC_MOTOR_TIMER,
            .duty       = 0,
            .hpoint     = 0,
            .flags      = { .output_invert = ARKART_STEER_OUTPUT_INVERT },
        },
        {
            .gpio_num   = ARKART_PIN_STEER_B,
            .speed_mode = ARKART_LEDC_MODE,
            .channel    = ARKART_LEDC_CH_STEER_B,
            .intr_type  = LEDC_INTR_DISABLE,
            .timer_sel  = ARKART_LEDC_MOTOR_TIMER,
            .duty       = 0,
            .hpoint     = 0,
            .flags      = { .output_invert = ARKART_STEER_OUTPUT_INVERT },
        },
    };

    for (size_t i = 0; i < sizeof(channels) / sizeof(channels[0]); i++) {
        err = ledc_channel_config(&channels[i]);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "ledc_channel_config[%u] failed: %s", (unsigned)i, esp_err_to_name(err));
            return err;
        }
    }

    s_drive_duty = 0;
    s_steer_side = STEER_SIDE_OFF;
    s_ready      = true;

    ESP_LOGI(TAG,
             "drive ready: PWM gpio%d ch%d, steer gpio%d/%d ch%d/%d, timer%d @ %d Hz %d-bit, "
             "variant %c (invert=%d)",
             ARKART_PIN_DRIVE_PWM, ARKART_LEDC_CH_DRIVE,
             ARKART_PIN_STEER_A, ARKART_PIN_STEER_B,
             ARKART_LEDC_CH_STEER_A, ARKART_LEDC_CH_STEER_B,
             ARKART_LEDC_MOTOR_TIMER, ARKART_PWM_FREQ_HZ, (int)ARKART_PWM_RES,
             ARKART_STEER_VARIANT_P_OR_N, ARKART_STEER_OUTPUT_INVERT);
    ESP_LOGI(TAG, "throttle window: min %d, ceiling %u (%d%% of %d), ramp %d/tick",
             ARKART_MIN_DUTY, (unsigned)ARKART_DRIVE_DUTY_CEILING,
             ARKART_MAX_DUTY, ARKART_DUTY_MAX, ARKART_MAX_RAMP);
    return ESP_OK;
}

/* ---------------------------------------------------------------------------------------- */

/* Map 0..255 wire throttle to a duty, lifting any non-zero request above the motor's
 * break-away deadband so that "a little throttle" actually moves the kart. */
static uint32_t throttle_to_duty(uint8_t throttle)
{
    if (throttle == 0) {
        return 0;
    }
    const uint32_t span = ARKART_DUTY_MAX - ARKART_MIN_DUTY;
    return ARKART_MIN_DUTY + (span * (uint32_t)throttle) / 255u;
}

static void apply_throttle(uint8_t throttle)
{
    uint32_t target = throttle_to_duty(throttle);

    /* Slew limit on the way UP only — this is the brownout guard. Coming DOWN is instant,
     * because every reason to reduce throttle (release, stun, watchdog, race abort) is a
     * safety reason and must not be delayed. */
    if (target > s_drive_duty) {
        const uint32_t step = target - s_drive_duty;
        if (step > ARKART_MAX_RAMP) {
            target = s_drive_duty + ARKART_MAX_RAMP;
        }
    }

    /* Absolute ceiling, applied AFTER the ramp so it is genuinely absolute — no ordering of
     * commands, and no accumulation of ramp steps, can ever push the duty past it. This is
     * what keeps the SINGLE drive 2N2222 inside its current rating; see ARKART_MAX_DUTY.
     * Clamping only ever lowers the value, so the "decreases are instant" safety asymmetry
     * above is untouched. */
    if (target > ARKART_DRIVE_DUTY_CEILING) {
        target = ARKART_DRIVE_DUTY_CEILING;
    }

    if (target != s_drive_duty) {
        s_drive_duty = target;
        set_duty(ARKART_LEDC_CH_DRIVE, target);
    }
}

static void steer_release(void)
{
    /* Both sides to zero. Order does not matter — neither side is energised at duty 0 in
     * either variant, because output_invert already accounts for the pad polarity. */
    set_duty(ARKART_LEDC_CH_STEER_A, 0);
    set_duty(ARKART_LEDC_CH_STEER_B, 0);
    s_steer_side = STEER_SIDE_OFF;
}

static void apply_steer(int8_t steer)
{
    int s = (int)steer * ARKART_STEER_SIGN;
    if (s >  100) s =  100;
    if (s < -100) s = -100;

    const int mag = abs(s);

    steer_side_t want = STEER_SIDE_OFF;
    uint32_t     duty = 0;

    if (mag >= ARKART_STEER_DEADBAND) {
        want = (s > 0) ? STEER_SIDE_A : STEER_SIDE_B;
        /* Partial deflection: scale from the coil's pull-in duty up to full. */
        const uint32_t span = ARKART_DUTY_MAX - ARKART_STEER_MIN_DUTY;
        duty = ARKART_STEER_MIN_DUTY + (span * (uint32_t)mag) / 100u;
    }

    if (want == STEER_SIDE_OFF) {
        if (s_steer_side != STEER_SIDE_OFF) {
            steer_release();
        }
        return;
    }

    if (want != s_steer_side) {
        /* Changing sides (or coming out of OFF). Take BOTH sides down, wait out the dead-time,
         * and only then energise the new side. Both sides on at once is cross-conduction. */
        steer_release();
        esp_rom_delay_us(ARKART_STEER_DEADTIME_US);
        s_steer_side = want;
    }

    if (want == STEER_SIDE_A) {
        set_duty(ARKART_LEDC_CH_STEER_A, duty);
    } else {
        set_duty(ARKART_LEDC_CH_STEER_B, duty);
    }
}

void drive_apply(uint8_t throttle, int8_t steer)
{
    if (!s_ready) {
        return;
    }
    apply_throttle(throttle);
    apply_steer(steer);
}

void drive_all_off(void)
{
    if (!s_ready) {
        return;
    }
    /* Instant, no ramp. */
    s_drive_duty = 0;
    set_duty(ARKART_LEDC_CH_DRIVE, 0);
    steer_release();
}

uint32_t drive_current_duty(void)
{
    return s_drive_duty;
}
