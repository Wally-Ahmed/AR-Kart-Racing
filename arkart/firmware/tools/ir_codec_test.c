/*
 * Host round-trip test for the AR Kart IR tag codec.
 *
 *   cc -std=c11 -Wall -Wextra -Werror -I<firmware>/main -o ir_codec_test ir_codec_test.c
 *
 * Drives ir_tag_codec.h exactly the way the firmware does:
 *   encode -> alternating mark/space intervals -> synthetic TSSP edges -> ir_dec_feed()
 * plus the acceptance ladder (check nibble, self-hit, per-shooter lockout) replicated from
 * ir_tag.c's accept_frame() with a fake clock, so the debounce semantics are tested too.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ir_tag_codec.h"

static int g_fail = 0;
static int g_pass = 0;

#define CHECK(cond, ...)                                                      \
    do {                                                                      \
        if (cond) { g_pass++; }                                               \
        else { g_fail++; printf("FAIL %s:%d  ", __FILE__, __LINE__);          \
               printf(__VA_ARGS__); printf("\n"); }                           \
    } while (0)

/* ---- the firmware's decode pipeline, minus FreeRTOS ------------------------------------- */

#define IR_MAX_INTERVAL_US 4000u

typedef struct {
    uint8_t  level;
    uint32_t ts;
} edge_t;

typedef struct {
    /* decoder */
    ir_dec_t dec;
    uint32_t prev_ts;
    int      have_prev;
    /* acceptance ladder */
    uint8_t  my_id;
    uint32_t lockout_ms;
    int64_t  seen_us[16];
    int64_t  now_us;          /* fake clock, advanced by the harness */
    /* counters, same names as ir_tag.c */
    unsigned framed, bad_frame, bad_check, self, debounce, hits;
    unsigned last_shooter;
} rx_t;

static void rx_init(rx_t *r, uint8_t my_id)
{
    memset(r, 0, sizeof(*r));
    ir_dec_reset(&r->dec);
    r->my_id      = my_id;
    r->lockout_ms = 400;
}

/* ir_tag.c accept_frame(), verbatim in behaviour */
static void rx_accept(rx_t *r, uint8_t payload)
{
    if (!ir_payload_ok(payload)) { r->bad_check++; return; }
    const uint8_t shooter = ir_payload_shooter(payload);
    if (shooter == r->my_id)     { r->self++; return; }
    const int64_t prev = r->seen_us[shooter];
    if (prev != 0 && (r->now_us - prev) < (int64_t)r->lockout_ms * 1000) {
        r->debounce++; return;
    }
    r->seen_us[shooter] = r->now_us;
    r->hits++;
    r->last_shooter = shooter;
}

/* ir_tag.c ir_rx_task() body, verbatim in behaviour */
static void rx_edge(rx_t *r, edge_t e)
{
    if (!r->have_prev) { r->prev_ts = e.ts; r->have_prev = 1; return; }
    const uint32_t dur = e.ts - r->prev_ts;
    r->prev_ts = e.ts;
    if (dur > IR_MAX_INTERVAL_US) { ir_dec_reset(&r->dec); return; }
    const ir_dec_ret_t ret = ir_dec_feed(&r->dec, dur, e.level != 0);
    if (ret == IR_DEC_ABORT) { r->bad_frame++; return; }
    if (ret != IR_DEC_FRAME) { return; }
    r->framed++;
    rx_accept(r, r->dec.payload);
}

/* ir_tag.c ir_tag_test_inject(), verbatim in behaviour */
static int inject(rx_t *r, uint32_t *t, uint8_t payload, int repeats, int glitch)
{
    uint16_t iv[IR_INTERVALS];
    const int n = ir_encode_intervals(payload, iv, IR_INTERVALS);
    if (n != IR_INTERVALS) return 0;
    if (glitch) iv[2] = 2000;

    int pushed = 0;
    for (int rep = 0; rep < repeats; rep++) {
        *t += (rep == 0) ? 2000u : IR_FRAME_GAP_US;
        rx_edge(r, (edge_t){ .level = 0, .ts = *t }); pushed++;
        for (int k = 0; k < n; k++) {
            *t += iv[k];
            rx_edge(r, (edge_t){ .level = (uint8_t)((k & 1) ? 0u : 1u), .ts = *t });
            pushed++;
        }
    }
    return pushed;
}

/* ---- tests ------------------------------------------------------------------------------ */

static void t_payload(void)
{
    printf("-- payload / check nibble\n");
    CHECK(ir_payload(1) == 0x1E, "payload(1) = 0x%02X, want 0x1E", ir_payload(1));
    CHECK(ir_payload(2) == 0x2D, "payload(2) = 0x%02X, want 0x2D", ir_payload(2));
    CHECK(ir_payload(15) == 0xF0, "payload(15) = 0x%02X, want 0xF0", ir_payload(15));
    CHECK(!ir_payload_ok(0x00), "all-zeros must not validate");
    CHECK(!ir_payload_ok(0xFF), "all-ones must not validate");
    CHECK(!ir_payload_ok(0x0F), "shooter 0 must not validate");
    for (unsigned id = 1; id <= 15; id++) {
        const uint8_t p = ir_payload((uint8_t)id);
        CHECK(ir_payload_ok(p), "payload 0x%02X for id %u must validate", p, id);
        CHECK(ir_payload_shooter(p) == id, "shooter(0x%02X) = %u, want %u",
              p, ir_payload_shooter(p), id);
        /* every single-bit corruption must be caught */
        for (int b = 0; b < 8; b++) {
            const uint8_t bad = (uint8_t)(p ^ (1u << b));
            CHECK(!ir_payload_ok(bad), "single-bit flip %d of 0x%02X slipped through (0x%02X)",
                  b, p, bad);
        }
    }
}

static void t_encode(void)
{
    printf("-- encode geometry\n");
    uint16_t iv[IR_INTERVALS];
    const int n = ir_encode_intervals(0xA5, iv, IR_INTERVALS);
    CHECK(n == IR_INTERVALS, "interval count %d, want %d", n, IR_INTERVALS);
    CHECK(n == 19, "IR_INTERVALS is %d, the format says 19", n);
    CHECK(iv[0] == IR_HDR_MARK_US, "iv[0] = %u", iv[0]);
    CHECK(iv[1] == IR_HDR_SPACE_US, "iv[1] = %u", iv[1]);
    CHECK(iv[18] == IR_TRAIL_MARK_US, "iv[18] = %u", iv[18]);
    for (int k = 2; k < 18; k += 2) {
        CHECK(iv[k] == IR_BIT_MARK_US, "iv[%d] = %u, every bit mark is %u", k, iv[k],
              (unsigned)IR_BIT_MARK_US);
    }
    /* 0xA5 = 1010 0101, MSB first */
    const int want[8] = { 1, 0, 1, 0, 0, 1, 0, 1 };
    for (int b = 0; b < 8; b++) {
        const uint16_t want_us = want[b] ? IR_ONE_SPACE_US : IR_ZERO_SPACE_US;
        CHECK(iv[3 + 2 * b] == want_us, "bit %d space = %u, want %u", b, iv[3 + 2 * b],
              want_us);
    }
    CHECK(IR_FRAME_MARK_US == 7800u, "IR_FRAME_MARK_US = %u, want 7800",
          (unsigned)IR_FRAME_MARK_US);

    uint32_t min_us = 0, max_us = 0;
    (void)ir_encode_intervals(0x00, iv, IR_INTERVALS);
    for (int k = 0; k < IR_INTERVALS; k++) min_us += iv[k];
    (void)ir_encode_intervals(0xFF, iv, IR_INTERVALS);
    for (int k = 0; k < IR_INTERVALS; k++) max_us += iv[k];
    CHECK(min_us == 13200u, "shortest frame %u us, want 13200", min_us);
    CHECK(max_us == 18000u, "longest frame %u us, want 18000", max_us);
    printf("   frame length %u..%u us, marks %u us\n", min_us, max_us,
           (unsigned)IR_FRAME_MARK_US);
}

static void t_roundtrip_all_ids(void)
{
    printf("-- round trip, every id, one clean copy\n");
    for (unsigned id = 1; id <= 15; id++) {
        rx_t r; rx_init(&r, 0 /* nothing is self */);
        uint32_t t = 1000000;
        inject(&r, &t, ir_payload((uint8_t)id), 1, 0);
        CHECK(r.framed == 1 && r.hits == 1 && r.last_shooter == id &&
              r.bad_frame == 0 && r.bad_check == 0 && r.debounce == 0,
              "id %u: framed=%u hits=%u last=%u bad_frame=%u bad_check=%u deb=%u",
              id, r.framed, r.hits, r.last_shooter, r.bad_frame, r.bad_check, r.debounce);
    }
}

static void t_debounce(void)
{
    printf("-- debounce: 3 copies of one burst collapse to 1 hit\n");
    rx_t r; rx_init(&r, 1);
    uint32_t t = 5000000;
    r.now_us = 5000000;
    inject(&r, &t, ir_payload(2), 3, 0);
    CHECK(r.framed == 3, "3 copies must all frame, got %u", r.framed);
    CHECK(r.hits == 1, "one burst must be ONE hit, got %u", r.hits);
    CHECK(r.debounce == 2, "2 copies must be swallowed, got %u", r.debounce);

    printf("-- a second burst INSIDE the lockout is still one hit\n");
    r.now_us += 399000;                        /* 399 ms < 400 ms */
    inject(&r, &t, ir_payload(2), 1, 0);
    CHECK(r.hits == 1, "inside the lockout: still 1 hit, got %u", r.hits);
    CHECK(r.debounce == 3, "debounce now 3, got %u", r.debounce);

    printf("-- a second burst BEYOND the lockout is a second hit\n");
    r.now_us += 2000;                          /* 401 ms total since the first hit */
    inject(&r, &t, ir_payload(2), 1, 0);
    CHECK(r.hits == 2, "beyond the lockout: 2 hits, got %u", r.hits);

    printf("-- the lockout is PER SHOOTER: another kart scores immediately\n");
    inject(&r, &t, ir_payload(3), 1, 0);
    CHECK(r.hits == 3, "a different shooter must not be debounced, got %u hits", r.hits);
    CHECK(r.last_shooter == 3, "last shooter %u, want 3", r.last_shooter);
}

static void t_self(void)
{
    printf("-- self-hit rejection\n");
    rx_t r; rx_init(&r, 2);
    uint32_t t = 9000000;
    inject(&r, &t, ir_payload(2), 1, 0);
    CHECK(r.framed == 1, "our own frame still decodes, got %u", r.framed);
    CHECK(r.self == 1 && r.hits == 0, "self=%u hits=%u, want 1/0", r.self, r.hits);
    /* and the other kart still gets through on the same receiver */
    inject(&r, &t, ir_payload(1), 1, 0);
    CHECK(r.hits == 1, "another kart must still score, got %u", r.hits);
}

static void t_corrupt(void)
{
    printf("-- corrupted payload (bad check nibble)\n");
    rx_t r; rx_init(&r, 1);
    uint32_t t = 12000000;
    inject(&r, &t, (uint8_t)(ir_payload(2) ^ 0x01u), 1, 0);
    CHECK(r.framed == 1, "framing is intact, got %u", r.framed);
    CHECK(r.bad_check == 1 && r.hits == 0, "bad_check=%u hits=%u, want 1/0",
          r.bad_check, r.hits);

    printf("-- corrupted framing (2000 us bit mark)\n");
    rx_t g; rx_init(&g, 1);
    uint32_t tg = 15000000;
    inject(&g, &tg, ir_payload(2), 1, 1);
    CHECK(g.framed == 0, "a glitched frame must never complete, got %u", g.framed);
    CHECK(g.bad_frame >= 1 && g.hits == 0, "bad_frame=%u hits=%u, want >=1/0",
          g.bad_frame, g.hits);
}

static void t_jitter(void)
{
    printf("-- tolerance: +/-25%% jitter on every interval still decodes\n");
    for (int sign = -1; sign <= 1; sign += 2) {
        rx_t r; rx_init(&r, 1);
        uint32_t t = 20000000;
        uint16_t iv[IR_INTERVALS];
        const int n = ir_encode_intervals(ir_payload(2), iv, IR_INTERVALS);
        for (int k = 0; k < n; k++) {
            iv[k] = (uint16_t)((int)iv[k] + sign * (int)iv[k] / 4);
        }
        /* replay by hand, since inject() re-encodes */
        t += 2000;
        rx_edge(&r, (edge_t){ .level = 0, .ts = t });
        for (int k = 0; k < n; k++) {
            t += iv[k];
            rx_edge(&r, (edge_t){ .level = (uint8_t)((k & 1) ? 0u : 1u), .ts = t });
        }
        CHECK(r.hits == 1, "jitter %+d%%: hits=%u framed=%u bad_frame=%u",
              sign * 25, r.hits, r.framed, r.bad_frame);
    }

    printf("-- resync: a glitched frame immediately followed by a good one\n");
    rx_t r; rx_init(&r, 1);
    uint32_t t = 30000000;
    inject(&r, &t, ir_payload(2), 1, 1);       /* glitched */
    inject(&r, &t, ir_payload(3), 1, 0);       /* good, right behind it */
    CHECK(r.hits == 1 && r.last_shooter == 3,
          "the frame after a glitch must still land: hits=%u last=%u",
          r.hits, r.last_shooter);

    printf("-- timestamp wrap across the 32-bit boundary\n");
    rx_t w; rx_init(&w, 1);
    uint32_t tw = 0xFFFFF000u;                 /* ~4 ms before the wrap */
    inject(&w, &tw, ir_payload(4), 1, 0);
    CHECK(w.hits == 1, "a frame straddling the wrap must decode: hits=%u bad_frame=%u",
          w.hits, w.bad_frame);
}

static void t_noise(void)
{
    printf("-- pure noise never produces a hit\n");
    rx_t r; rx_init(&r, 1);
    srand(20261004);
    uint32_t t = 40000000;
    for (int i = 0; i < 200000; i++) {
        t += (uint32_t)(50 + rand() % 3500);
        rx_edge(&r, (edge_t){ .level = (uint8_t)(rand() & 1), .ts = t });
    }
    printf("   200k random edges -> framed=%u bad_frame=%u bad_check=%u hits=%u\n",
           r.framed, r.bad_frame, r.bad_check, r.hits);
    CHECK(r.hits == 0, "random edges produced %u hit(s)", r.hits);
}

int main(void)
{
    t_payload();
    t_encode();
    t_roundtrip_all_ids();
    t_debounce();
    t_self();
    t_corrupt();
    t_jitter();
    t_noise();
    printf("\n%d checks passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
