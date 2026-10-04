#include "rx_console.h"

#include "btn_remote.h"
#include "ir_tag.h"
#include "net_drive.h"
#include "rx_inject.h"

#include <ctype.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "rx_console";

#define LINE_MAX_LEN    96
#define ARGV_MAX        6
#define POLL_MS         20

/* The console's own idea of the stick, so `steer -40` can follow `fwd 120` without resetting
 * the throttle, exactly like a pilot holding both. */
static uint8_t s_thr     = 0;
static int8_t  s_steer   = 0;
static bool    s_reverse = false;

static void prompt(void)
{
    printf("rx> ");
    fflush(stdout);
}

/* strtol with "did the whole token parse" checking — a typo must not read as 0. */
static bool parse_long(const char *tok, long *out)
{
    if (tok == NULL || *tok == '\0') {
        return false;
    }
    errno = 0;
    char *end = NULL;
    const long v = strtol(tok, &end, 0);
    if (errno != 0 || end == tok || (end != NULL && *end != '\0')) {
        return false;
    }
    *out = v;
    return true;
}

static uint8_t clamp_thr(long v)
{
    if (v < 0)   return 0;
    if (v > 255) return 255;
    return (uint8_t)v;
}

static int8_t clamp_steer(long v)
{
    if (v < -100) return -100;
    if (v >  100) return  100;
    return (int8_t)v;
}

static void cmd_dispatch(int argc, char **argv)
{
    const char *cmd = argv[0];

    if (strcasecmp(cmd, "help") == 0 || strcmp(cmd, "?") == 0) {
        rx_inject_print_help();
        btn_remote_print_help();
        net_drive_print_help();
        ir_tag_print_help();
        return;
    }

    if (strcasecmp(cmd, "show") == 0) {
        rx_inject_cfg_dump();
        return;
    }

    if (strcasecmp(cmd, "stop") == 0) {
        s_thr     = 0;
        s_steer   = 0;
        s_reverse = false;
        rx_inject_stop();
        /* `stop` means "nothing is driving this car" — that has to include a held button on
         * the stock remote, not just our own transmitter. */
        btn_remote_release_all();
        return;
    }

    /* ---- stock-remote button tap (btn_remote.c) ------------------------------------------ */

    if (strcasecmp(cmd, "press") == 0) {
        const btn_id_t b = (argc == 2) ? btn_remote_from_name(argv[1]) : BTN_COUNT;
        if (b == BTN_COUNT) {
            printf("usage: press <fwd|back|left|right>    press and hold on the stock remote\n");
            return;
        }
        (void)btn_remote_press(b);
        return;
    }

    if (strcasecmp(cmd, "release") == 0) {
        if (argc == 2 && strcasecmp(argv[1], "all") == 0) {
            btn_remote_release_all();
            return;
        }
        const btn_id_t b = (argc == 2) ? btn_remote_from_name(argv[1]) : BTN_COUNT;
        if (b == BTN_COUNT) {
            printf("usage: release <fwd|back|left|right|all>\n");
            return;
        }
        (void)btn_remote_release(b);
        return;
    }

    if (strcasecmp(cmd, "btnstat") == 0) {
        btn_remote_status();
        return;
    }

    /* ---- net drive layer (net_drive.c) --------------------------------------------------- */

    if (strcasecmp(cmd, "netstat") == 0) {
        net_drive_status();
        return;
    }

    if (strcasecmp(cmd, "net") == 0) {
        if (argc == 2 && strcasecmp(argv[1], "on") == 0) {
            (void)net_drive_enable(true);
            return;
        }
        if (argc == 2 && strcasecmp(argv[1], "off") == 0) {
            (void)net_drive_enable(false);
            return;
        }
        printf("usage: net on | net off      (off = packets parsed but no pad touched)\n");
        return;
    }

    if (strcasecmp(cmd, "netpkt") == 0) {
        /* netpkt <thr> [steer] [flags] [seq] — one real datagram to our own :port over the
         * lwip loopback. thr is SIGNED; omitted seq auto-increments. */
        long thr = 0, steer = 0, flags = 0, seq = -1;
        if (argc < 2 || argc > 5 || !parse_long(argv[1], &thr) ||
            (argc >= 3 && !parse_long(argv[2], &steer)) ||
            (argc >= 4 && !parse_long(argv[3], &flags)) ||
            (argc >= 5 && !parse_long(argv[4], &seq))) {
            printf("usage: netpkt <thr -255..255> [steer -127..127] [flags] [seq]\n");
            printf("       negative thr = reverse (flags bit1); flags bit0 = shield;\n");
            printf("       seq omitted auto-increments, given is sent verbatim (stale test)\n");
            return;
        }
        if (argc >= 5 && seq < 0) {
            printf("netpkt: an explicit seq must be 0..65535\n");
            return;
        }
        (void)net_drive_test_packet(thr, steer, flags, seq);
        return;
    }

    /* ---- IR tag layer (ir_tag.c) --------------------------------------------------------- */

    if (strcasecmp(cmd, "irtx") == 0) {
        if (argc != 1) {
            printf("usage: irtx                   fire one 38 kHz burst on GPIO14 now\n");
            return;
        }
        (void)ir_tag_fire();
        return;
    }

    if (strcasecmp(cmd, "irstat") == 0) {
        ir_tag_status();
        return;
    }

    if (strcasecmp(cmd, "ircheck") == 0) {
        (void)ir_tag_carrier_check();
        return;
    }

    if (strcasecmp(cmd, "irtest") == 0) {
        /* irtest <shooter_id> [n | bad | glitch] — replay a synthetic burst into the real
         * decoder. No IR hardware involved; the edges enter at the ISR's own queue. */
        long id = 0;
        if (argc < 2 || argc > 3 || !parse_long(argv[1], &id)) {
            printf("usage: irtest <shooter 1..15> [n | bad | glitch]\n");
            printf("       n       = that many clean copies in one burst (default 1)\n");
            printf("       bad     = correct framing, wrong check nibble  -> bad_check\n");
            printf("       glitch  = correct header, broken bit mark      -> bad_frame\n");
            return;
        }
        ir_test_mode_t mode = IR_TEST_CLEAN;
        long reps = 1;
        if (argc == 3) {
            if (strcasecmp(argv[2], "bad") == 0) {
                mode = IR_TEST_BAD;
            } else if (strcasecmp(argv[2], "glitch") == 0) {
                mode = IR_TEST_GLITCH;
            } else if (!parse_long(argv[2], &reps)) {
                printf("irtest: second argument is a copy count, `bad`, or `glitch`\n");
                return;
            }
        }
        (void)ir_tag_test_inject((uint32_t)id, (int)reps, mode);
        return;
    }

    if (strcasecmp(cmd, "thr") == 0) {
        long v = 0;
        if (argc != 2 || !parse_long(argv[1], &v)) {
            printf("usage: thr <0..100>          100 = solid hold, 0 = drive key released\n");
            return;
        }
        (void)btn_remote_set_throttle(v);
        return;
    }

    if (strcasecmp(cmd, "sniff") == 0) {
        if (argc != 1) {
            printf("usage: sniff                  (then press the car's own remote; `stop` ends it)\n");
            return;
        }
        s_thr = 0; s_steer = 0; s_reverse = false;
        (void)rx_inject_sniff_start();
        return;
    }

    if (strcasecmp(cmd, "sweep") == 0) {
        long from = 0, to = 0;
        if (argc != 3 || !parse_long(argv[1], &from) || !parse_long(argv[2], &to)) {
            printf("usage: sweep <from> <to>      e.g. sweep 4 70\n");
            return;
        }
        if (from < 0 || from > 65535 || to < 0 || to > 65535) {
            printf("sweep bounds out of range\n");
            return;
        }
        (void)rx_inject_sweep((uint16_t)from, (uint16_t)to);
        return;
    }

    if (strcasecmp(cmd, "code") == 0) {
        long n = 0;
        if (argc != 2 || !parse_long(argv[1], &n) || n < 0 || n > 65535) {
            printf("usage: code <n>               e.g. code 10   (then `stop`)\n");
            return;
        }
        (void)rx_inject_hold_code((uint16_t)n);
        return;
    }

    if (strcasecmp(cmd, "fwd") == 0 || strcasecmp(cmd, "back") == 0) {
        long v = 0;
        if (argc != 2 || !parse_long(argv[1], &v)) {
            printf("usage: %s <0..255>\n", cmd);
            return;
        }
        s_thr     = clamp_thr(v);
        s_reverse = (strcasecmp(cmd, "back") == 0);
        (void)rx_inject_bench_drive(s_thr, s_steer, s_reverse);
        return;
    }

    if (strcasecmp(cmd, "steer") == 0) {
        long v = 0;
        if (argc != 2 || !parse_long(argv[1], &v)) {
            printf("usage: steer <-100..100>\n");
            return;
        }
        s_steer = clamp_steer(v);
        (void)rx_inject_bench_drive(s_thr, s_steer, s_reverse);
        return;
    }

    if (strcasecmp(cmd, "set") == 0) {
        /* `set code <name> <n>` retunes the function ladder; `set <key> <v>` a timing. */
        if (argc == 4 && strcasecmp(argv[1], "code") == 0) {
            long n = 0;
            if (!parse_long(argv[3], &n)) {
                printf("usage: set code <name> <n>\n");
                return;
            }
            (void)rx_inject_code_set(argv[2], n);
            return;
        }
        long v = 0;
        if (argc != 3 || !parse_long(argv[2], &v)) {
            printf("usage: set <key> <value>   |   set code <name> <n>\n");
            return;
        }
        /* One `set` namespace over four modules: the three that miss quietly are asked first
         * (button tap, net layer, IR tag), then the injector, which is the one that reports
         * an unknown key. */
        if (btn_remote_cfg_set(argv[1], v) == ESP_ERR_NOT_FOUND &&
            net_drive_cfg_set(argv[1], v) == ESP_ERR_NOT_FOUND &&
            ir_tag_cfg_set(argv[1], v) == ESP_ERR_NOT_FOUND) {
            (void)rx_inject_cfg_set(argv[1], v);
        }
        return;
    }

    printf("unknown command '%s' — type `help`\n", cmd);
}

static void handle_line(char *line)
{
    char *argv[ARGV_MAX];
    int   argc = 0;
    char *save = NULL;

    for (char *tok = strtok_r(line, " \t", &save);
         tok != NULL && argc < ARGV_MAX;
         tok = strtok_r(NULL, " \t", &save)) {
        argv[argc++] = tok;
    }
    if (argc == 0) {
        return;
    }
    cmd_dispatch(argc, argv);
}

static void console_task(void *arg)
{
    (void)arg;

    /* Unbuffered stdin: we want each keystroke as it lands, not a libc line buffer. */
    setvbuf(stdin, NULL, _IONBF, 0);

    char   line[LINE_MAX_LEN];
    size_t len = 0;

    prompt();

    for (;;) {
        const int ch = getchar();

        if (ch == EOF) {
            /* The console VFS is non-blocking, and EOF is sticky on the FILE — clear it or
             * every later read returns EOF too and the console goes deaf. */
            clearerr(stdin);
            vTaskDelay(pdMS_TO_TICKS(POLL_MS));
            continue;
        }

        if (ch == '\r' || ch == '\n') {
            putchar('\n');
            fflush(stdout);
            line[len] = '\0';
            if (len > 0) {
                handle_line(line);
            }
            len = 0;
            prompt();
            continue;
        }

        if (ch == 0x7F || ch == '\b') {
            if (len > 0) {
                len--;
                printf("\b \b");
                fflush(stdout);
            }
            continue;
        }

        if (ch == 0x03) {                 /* ctrl-C at the bench means "stop the motors" */
            printf("^C\n");
            s_thr = 0; s_steer = 0; s_reverse = false;
            rx_inject_stop();
            btn_remote_release_all();     /* and let go of every remote button */
            len = 0;
            prompt();
            continue;
        }

        if (isprint(ch) && len < sizeof(line) - 1) {
            line[len++] = (char)ch;
            putchar(ch);                  /* local echo — idf.py monitor does not echo */
            fflush(stdout);
        }
    }
}

esp_err_t rx_console_start(void)
{
    rx_inject_print_help();
    btn_remote_print_help();
    net_drive_print_help();
    ir_tag_print_help();

    /* Core 0 with WiFi and the HTTP server: the console is not real-time, and core 1 is kept
     * for the control loop and the RMT frame task. Priority 3 is above the LED task and well
     * below both. */
    if (xTaskCreatePinnedToCore(console_task, "arkart_rxcon", 4608, NULL, 3, NULL, 0) != pdPASS) {
        ESP_LOGE(TAG, "failed to create the bench console task");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
