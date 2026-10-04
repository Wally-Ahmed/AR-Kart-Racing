/*
 * net_drive.c — control packet -> stock-remote button set. See net_drive.h for the mapping,
 * the deadband rationale and the ownership/precedence rules; this file is just the machinery.
 *
 * Threading. net_drive_apply() / net_drive_all_off() are called ONLY from the control task
 * (arkart_ctl, core 1). net_drive_status() / net_drive_test_packet() / net_drive_enable() are
 * called only from the console task (core 0). The two share nothing but a handful of _Atomic
 * scalars that the control task writes and the console reads — a diagnostic print can see a
 * mix of two consecutive packets' fields and that is fine; it is a print. Everything that
 * actually touches a pad goes through btn_remote.c, which has its own mutex.
 *
 * Silence. net_drive_apply() runs at ~100 Hz (every accepted packet plus every 20 ms tick) and
 * prints nothing, ever. The only log lines in the hot path's reach are the single ARM and
 * DISARM transitions.
 */

#include "net_drive.h"

#include "btn_remote.h"
#include "control_udp.h"
#include "motor_map.h"
#include "status_led.h"
#include "wifi_sta.h"

#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "lwip/sockets.h"

static const char *TAG = "net_drive";

/* The loopback test sender binds here. Any free port works; a FIXED one is the point, so the
 * control task sees one stable source address across calls and the sequence filter is exercised
 * instead of being reset by an ephemeral port on every packet. */
#define NET_TEST_SRC_PORT   (CONFIG_ARKART_UDP_PORT + 1)

/* ------------------------------------------------------------------------------------------
 * State. Written by the control task, read by the console.
 * ---------------------------------------------------------------------------------------- */
static _Atomic bool s_enabled = true;    /* `net off` bench kill                              */
static _Atomic bool s_armed   = false;   /* this layer owns the four pads                     */

/* Last applied mapping, for `netstat`. */
static _Atomic uint8_t s_last_thr   = 0;
static _Atomic int     s_last_steer = 0;
static _Atomic uint8_t s_last_flags = 0;
static _Atomic int     s_last_drive = (int)BTN_DRIVE_NONE;
static _Atomic int     s_last_steer_dir = (int)BTN_STEER_NONE;
static _Atomic uint8_t s_last_pct   = 0;
static _Atomic uint32_t s_arm_count = 0;

/* Console-side only. */
static int      s_test_sock = -1;
static uint16_t s_test_seq  = 0;

/* ------------------------------------------------------------------------------------------
 * Arm / disarm — the whole of the precedence rule, in two functions.
 * ---------------------------------------------------------------------------------------- */

static void net_arm(void)
{
    /* FORCE the command watchdog on for as long as the net owns the pads. btn_remote's bench
     * default is 0 (off) because a human cannot feed a 300 ms leash by typing; a 50 Hz bridge
     * feeds it trivially, and it is the failsafe that survives even this task dying. */
    (void)btn_remote_cfg_set("btn_watchdog_ms", ARKART_WATCHDOG_MS);
    atomic_store(&s_armed, true);
    atomic_fetch_add(&s_arm_count, 1);
    ESP_LOGI(TAG, "ARMED — net owns gpio39..42; btn_watchdog_ms forced to %d ms, full button "
                  "set rewritten every %d ms (console press/release is overridden)",
             ARKART_WATCHDOG_MS, ARKART_CONTROL_TICK_MS);
}

static void net_disarm(void)
{
    /* One atomic, quiet call: every button released and the chop percentage back to the bench
     * default, so what the console inherits is exactly btn_remote's documented boot state. */
    (void)btn_remote_set_state(BTN_DRIVE_NONE, BTN_STEER_NONE, BTN_THR_PCT_DEF);
    (void)btn_remote_cfg_set("btn_watchdog_ms", 0);

    atomic_store(&s_armed, false);
    atomic_store(&s_last_thr, 0);
    atomic_store(&s_last_steer, 0);
    atomic_store(&s_last_flags, 0);
    atomic_store(&s_last_drive, (int)BTN_DRIVE_NONE);
    atomic_store(&s_last_steer_dir, (int)BTN_STEER_NONE);
    atomic_store(&s_last_pct, 0);

    ESP_LOGI(TAG, "DISARMED — all buttons released, chop back to %d %%, btn_watchdog_ms 0 "
                  "(console hold restored)", BTN_THR_PCT_DEF);
}

/* ------------------------------------------------------------------------------------------
 * The mapping
 * ---------------------------------------------------------------------------------------- */

void net_drive_apply(uint8_t throttle, int8_t steer, uint8_t flags)
{
    if (!atomic_load(&s_enabled)) {
        /* `net off`: refuse ownership no matter how many packets arrive. */
        if (atomic_load(&s_armed)) {
            net_disarm();
        }
        return;
    }

    if (!atomic_load(&s_armed)) {
        net_arm();
    }

    /* Drive. Direction from flags bit1 (see net_drive.h — additive, always 0 from today's
     * bridge); magnitude from the unsigned throttle byte. */
    btn_drive_dir_t drive = BTN_DRIVE_NONE;
    uint8_t         pct   = 0;

    if (throttle > ARKART_NET_THR_DEADBAND) {
        drive = (flags & ARKART_FLAG_REVERSE) ? BTN_DRIVE_BACK : BTN_DRIVE_FWD;
        /* Linear, rounded. Never rounds a live throttle down to 0 %, which would read as a
         * released key while the pilot is holding the trigger. */
        pct = (uint8_t)(((uint32_t)throttle * 100u + 127u) / 255u);
        if (pct == 0) {
            pct = 1;
        }
    }

    /* Steer. ARKART_STEER_SIGN and ARKART_STEER_DEADBAND are motor_map.h's, shared with
     * Plan M on purpose: one car feel, one place to flip a reversed harness. */
    btn_steer_dir_t steer_dir = BTN_STEER_NONE;
    const int       st        = (int)steer * (ARKART_STEER_SIGN);

    if (st > ARKART_STEER_DEADBAND) {
        steer_dir = BTN_STEER_RIGHT;
    } else if (st < -ARKART_STEER_DEADBAND) {
        steer_dir = BTN_STEER_LEFT;
    }

    (void)btn_remote_set_state(drive, steer_dir, pct);

    atomic_store(&s_last_thr, throttle);
    atomic_store(&s_last_steer, (int)steer);
    atomic_store(&s_last_flags, flags);
    atomic_store(&s_last_drive, (int)drive);
    atomic_store(&s_last_steer_dir, (int)steer_dir);
    atomic_store(&s_last_pct, pct);
}

void net_drive_all_off(void)
{
    /* The control task calls this on every loop iteration while tripped, so the common case
     * has to be one atomic load and nothing else. */
    if (!atomic_load(&s_armed)) {
        return;
    }
    net_disarm();
}

bool net_drive_is_armed(void)
{
    return atomic_load(&s_armed);
}

/* ------------------------------------------------------------------------------------------
 * Console surface
 * ---------------------------------------------------------------------------------------- */

esp_err_t net_drive_enable(bool on)
{
    atomic_store(&s_enabled, on);
    if (!on && atomic_load(&s_armed)) {
        net_disarm();
    }
    printf("net drive %s%s\n", on ? "ON" : "OFF",
           on ? " — the next valid packet arms it"
              : " — packets are parsed and counted but no pad is touched");
    fflush(stdout);
    return ESP_OK;
}

esp_err_t net_drive_cfg_set(const char *key, long value)
{
    if (key == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (strcasecmp(key, "net_enable") == 0) {
        return net_drive_enable(value != 0);
    }
    /* Quiet miss: the console's single `set` namespace falls through to the other modules. */
    return ESP_ERR_NOT_FOUND;
}

static const char *drive_name(int d)
{
    switch ((btn_drive_dir_t)d) {
    case BTN_DRIVE_FWD:  return "FWD";
    case BTN_DRIVE_BACK: return "BACK";
    default:             return "none";
    }
}

static const char *steer_name(int s)
{
    switch ((btn_steer_dir_t)s) {
    case BTN_STEER_LEFT:  return "LEFT";
    case BTN_STEER_RIGHT: return "RIGHT";
    default:              return "none";
    }
}

static const char *led_name(led_state_t st)
{
    switch (st) {
    case LED_STATE_SHIELD:   return "CYAN (shield)";
    case LED_STATE_IDLE:     return "dim green (armed, no shield)";
    case LED_STATE_WATCHDOG: return "amber blink (link dead)";
    default:                 return "red blink (no WiFi)";
    }
}

void net_drive_status(void)
{
    control_udp_stats_t s;
    control_udp_get_stats(&s);

    char ip[16];
    wifi_sta_ip_str(ip, sizeof(ip));

    const uint8_t flags = atomic_load(&s_last_flags);
    const int64_t now   = esp_timer_get_time();

    printf("\n--- net drive layer -----------------------------------------------------\n");
    printf("  wifi          %s   ip %s   ssid \"%s\"\n",
           wifi_sta_is_connected() ? "CONNECTED" : "down", ip, CONFIG_ARKART_WIFI_SSID);
    printf("  socket        UDP :%d   kart_id %d   loopback test source port %d\n",
           CONFIG_ARKART_UDP_PORT, CONFIG_ARKART_KART_ID, NET_TEST_SRC_PORT);
    printf("  ownership     %s%s   (arm cycles %u)\n",
           atomic_load(&s_armed) ? "ARMED — net owns gpio39..42"
                                 : "disarmed — console owns gpio39..42",
           atomic_load(&s_enabled) ? "" : "   [net off]",
           (unsigned)atomic_load(&s_arm_count));
    printf("  link          %s", s.link_alive ? "UP" : "DOWN");
    if (s.last_packet_us != 0) {
        printf("   last valid packet %lld ms ago", (now - s.last_packet_us) / 1000);
    } else {
        printf("   no valid packet since boot");
    }
    printf("   watchdog %d ms\n", ARKART_WATCHDOG_MS);
    if (s.have_src) {
        printf("  source        %u.%u.%u.%u:%u\n",
               (unsigned)(s.src_ip & 0xFFu), (unsigned)((s.src_ip >> 8) & 0xFFu),
               (unsigned)((s.src_ip >> 16) & 0xFFu), (unsigned)((s.src_ip >> 24) & 0xFFu),
               (unsigned)s.src_port);
    } else {
        printf("  source        none yet\n");
    }
    printf("  counters      accepted %u   stale/dup dropped %u   foreign dropped %u"
           "   resyncs %u\n",
           (unsigned)s.accepted, (unsigned)s.dropped_stale, (unsigned)s.dropped_foreign,
           (unsigned)s.resyncs);
    printf("  last packet   thr %u   steer %+d   flags 0x%02x%s   seq %u\n",
           (unsigned)atomic_load(&s_last_thr), atomic_load(&s_last_steer),
           (unsigned)flags,
           (flags & ARKART_FLAG_SHIELD) ? " SHIELD" : "",
           (unsigned)s.seq);
    printf("  mapped to     drive %-4s   steer %-5s   chop %u %%\n",
           drive_name(atomic_load(&s_last_drive)),
           steer_name(atomic_load(&s_last_steer_dir)),
           (unsigned)atomic_load(&s_last_pct));
    printf("  status pixel  gpio%d  %s\n",
           ARKART_PIN_STATUS_LED, led_name(status_led_get()));
    printf("  deadbands     throttle > %d of 255 to engage   |steer| > %d of 127 to turn"
           "   steer sign %+d\n",
           ARKART_NET_THR_DEADBAND, ARKART_STEER_DEADBAND, ARKART_STEER_SIGN);
    printf("  reverse       flags bit1 (0x%02x); today's bridge never sets it, so the net path"
           " is forward-only\n", ARKART_FLAG_REVERSE);
    printf("-------------------------------------------------------------------------\n\n");
    fflush(stdout);
}

void net_drive_print_help(void)
{
    printf("\n=========================================================================\n");
    printf(" NET DRIVE LAYER — the car bridge's 8-byte packet -> remote buttons\n");
    printf("=========================================================================\n");
    printf(" INSPECT  netstat                         wifi/ip, link, last packet, what it\n");
    printf("                                          mapped to, counters           [SAFE]\n");
    printf(" TEST     netpkt <thr> [steer] [flags] [seq]\n");
    printf("                                          send ONE real datagram to this board's\n");
    printf("                                          own :%d over lwip loopback. thr is\n",
           CONFIG_ARKART_UDP_PORT);
    printf("                                          SIGNED -255..255 (negative = reverse,\n");
    printf("                                          flags bit1). seq omitted = auto-increment,\n");
    printf("                                          given = verbatim (that is how a stale seq\n");
    printf("                                          is tested).\n");
    printf(" GATE     net off | net on                bench kill: `off` keeps the net out of\n");
    printf("                                          the pads whatever arrives (default on)\n");
    printf("-------------------------------------------------------------------------\n");
    printf(" thr > %d of 255 holds FWD (BACK if flags bit1) and sets the chop to\n",
           ARKART_NET_THR_DEADBAND);
    printf(" thr*100/255 %%; thr 0 releases the drive key — that is the bridge's kill\n");
    printf(" switch, it zeroes throttle whenever the race state is not `running`.\n");
    printf(" |steer| > %d of 127 holds LEFT/RIGHT, inside it both are released.\n",
           ARKART_STEER_DEADBAND);
    printf(" PRECEDENCE: a live link ARMS this layer, forces btn_watchdog_ms to %d and\n",
           ARKART_WATCHDOG_MS);
    printf(" overrides `press` within %d ms. %d ms of silence releases everything and\n",
           ARKART_CONTROL_TICK_MS, ARKART_WATCHDOG_MS);
    printf(" hands the pads back to the console (btn_watchdog_ms 0 = indefinite hold).\n");
    printf("=========================================================================\n\n");
    fflush(stdout);
}

/* ------------------------------------------------------------------------------------------
 * The loopback test sender
 * ---------------------------------------------------------------------------------------- */

esp_err_t net_drive_test_packet(long throttle_signed, long steer, long flags, long seq)
{
    if (throttle_signed < -255 || throttle_signed > 255) {
        printf("netpkt: thr must be -255..255 (negative = reverse)\n");
        return ESP_ERR_INVALID_ARG;
    }
    if (steer < -127 || steer > 127) {
        printf("netpkt: steer must be -127..127\n");
        return ESP_ERR_INVALID_ARG;
    }
    if (flags < 0 || flags > 255) {
        printf("netpkt: flags must be 0..255 (bit0 shield, bit1 reverse)\n");
        return ESP_ERR_INVALID_ARG;
    }
    if (seq > 65535) {
        printf("netpkt: seq must be 0..65535 (or omitted to auto-increment)\n");
        return ESP_ERR_INVALID_ARG;
    }

    if (s_test_sock < 0) {
        s_test_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (s_test_sock < 0) {
            printf("netpkt: socket() failed, errno %d\n", errno);
            return ESP_FAIL;
        }
        const struct sockaddr_in local = {
            .sin_family      = AF_INET,
            .sin_port        = htons(NET_TEST_SRC_PORT),
            .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
        };
        if (bind(s_test_sock, (const struct sockaddr *)&local, sizeof(local)) < 0) {
            printf("netpkt: bind(127.0.0.1:%d) failed, errno %d\n", NET_TEST_SRC_PORT, errno);
            close(s_test_sock);
            s_test_sock = -1;
            return ESP_FAIL;
        }
    }

    uint8_t  thr   = (uint8_t)((throttle_signed < 0) ? -throttle_signed : throttle_signed);
    uint8_t  fl    = (uint8_t)flags;
    if (throttle_signed < 0) {
        fl |= ARKART_FLAG_REVERSE;
    }
    const uint16_t use_seq = (seq < 0) ? s_test_seq++ : (uint16_t)seq;

    uint8_t pkt[ARKART_PACKET_LEN];
    pkt[0] = ARKART_MAGIC_0;
    pkt[1] = ARKART_MAGIC_1;
    pkt[2] = (uint8_t)CONFIG_ARKART_KART_ID;
    pkt[3] = thr;
    pkt[4] = (uint8_t)(int8_t)steer;
    pkt[5] = fl;
    pkt[6] = (uint8_t)(use_seq & 0xFFu);
    pkt[7] = (uint8_t)(use_seq >> 8);

    const struct sockaddr_in dst = {
        .sin_family      = AF_INET,
        .sin_port        = htons(CONFIG_ARKART_UDP_PORT),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
    };

    const int n = sendto(s_test_sock, pkt, sizeof(pkt), 0,
                         (const struct sockaddr *)&dst, sizeof(dst));
    if (n != (int)sizeof(pkt)) {
        printf("netpkt: sendto failed (%d), errno %d\n", n, errno);
        return ESP_FAIL;
    }

    printf("netpkt -> 127.0.0.1:%d  AK kart %d  thr %u  steer %+ld  flags 0x%02x%s%s  seq %u\n",
           CONFIG_ARKART_UDP_PORT, CONFIG_ARKART_KART_ID, (unsigned)thr, steer, (unsigned)fl,
           (fl & ARKART_FLAG_SHIELD) ? " SHIELD" : "",
           (fl & ARKART_FLAG_REVERSE) ? " REVERSE" : "",
           (unsigned)use_seq);
    fflush(stdout);
    return ESP_OK;
}

esp_err_t net_drive_init(void)
{
    ESP_LOGI(TAG, "net drive layer ready — thr>%d of 255 presses %s, |steer|>%d of 127 presses "
                  "LEFT/RIGHT, thr<=%d releases the drive key",
             ARKART_NET_THR_DEADBAND, "FWD (BACK on flags bit1)", ARKART_STEER_DEADBAND,
             ARKART_NET_THR_DEADBAND);
    ESP_LOGI(TAG, "disarmed at boot: the console keeps gpio39..42 until the first valid packet");
    return ESP_OK;
}
