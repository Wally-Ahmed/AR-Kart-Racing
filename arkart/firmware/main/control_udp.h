/*
 * control_udp.h — the kart's only control input.
 *
 * The car bridge (TS/Node, the enforcer) sends one 8-byte datagram per kart at 50 Hz to
 * UDP :7777. The kart never talks to SpacetimeDB; the bridge has already merged item effects,
 * clamped throttle for race state, and applied the dizzy steer inversion. Everything the
 * firmware does with this packet is mechanical.
 *
 * Wire format — 8 bytes, exactly:
 *   [0] 'A'        magic
 *   [1] 'K'        magic
 *   [2] kart_id    u8   — packets addressed to another kart are dropped silently
 *   [3] throttle   u8   — 0..255, forward only
 *   [4] steer      i8   — -100..+100
 *   [5] flags      u8   — bit0 = shield active (drives the cyan status pixel)
 *                         bit1 = reverse, consumed ONLY by the button-tap net layer
 *                                (net_drive.h). The bridge never sets it today, so every
 *                                backend behaves exactly as before: forward only.
 *   [6] seq        u16  LITTLE-ENDIAN, low byte
 *   [7] seq             high byte
 *
 * The byte layout above is car-bridge/src/packet.ts's, which is authoritative. Note that
 * throttle is UNSIGNED: 200 means 200 forward, never -56.
 *
 * Safety: if no valid packet arrives for ARKART_WATCHDOG_MS (300 ms), throttle goes to zero
 * and the steer coil is released. A kart can never run away on WiFi loss, a crashed bridge,
 * or a backgrounded pilot app.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ARKART_PACKET_LEN    8
#define ARKART_MAGIC_0       'A'
#define ARKART_MAGIC_1       'K'
#define ARKART_FLAG_SHIELD   0x01u
#define ARKART_FLAG_REVERSE  0x02u

/* Starts the control task (pinned to core 1, away from WiFi and the camera on core 0).
 * Call after drive_init(). */
esp_err_t control_udp_start(uint8_t kart_id, uint16_t port);

/* True once at least one valid packet has been seen and the watchdog has not tripped since. */
bool control_udp_link_alive(void);

/* ------------------------------------------------------------------------------------------
 * Diagnostic snapshot for the `netstat` console command.
 *
 * Every field is written by the control task and read by the console with no lock between
 * them: each one is individually atomic, but two fields can come from two consecutive packets.
 * That is deliberate — this is a print, and a mutex in the receive path to make a bench
 * printout self-consistent would be the wrong trade.
 * ---------------------------------------------------------------------------------------- */
typedef struct {
    bool     link_alive;
    bool     have_src;
    uint8_t  throttle;        /* last ACCEPTED packet's fields                             */
    int8_t   steer;
    uint8_t  flags;
    uint16_t seq;
    uint32_t src_ip;          /* network byte order, as it came off the socket              */
    uint16_t src_port;        /* host order                                                */
    uint32_t accepted;
    uint32_t dropped_stale;   /* right magic + right kart, but a stale or duplicate seq     */
    uint32_t dropped_foreign; /* wrong length, wrong magic, or another kart's packet         */
    uint32_t resyncs;         /* seq baselines adopted: new source, restart, or long silence */
    int64_t  last_packet_us;  /* esp_timer_get_time() of the last accepted packet; 0 = never */
} control_udp_stats_t;

void control_udp_get_stats(control_udp_stats_t *out);

#ifdef __cplusplus
}
#endif
