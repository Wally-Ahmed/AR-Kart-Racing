/*
 * ir_tag_pins.h — the TWO PINS of the TV-remote-style 38 kHz IR tag, and nothing else.
 *
 * This file was a pin RESERVATION while T3 was unbuilt. T3 is now implemented: the driver is
 * ir_tag.c, the public API and the design note are in ir_tag.h, and the normative on-air
 * format is in ir_tag_codec.h. What survives here is the pin truth, kept in its own tiny
 * header so the harness map has exactly one home and ir_tag.c consumes it rather than
 * re-declaring the numbers.
 *
 * The AR Kart IR tag is the same kind of low-power infrared link a television remote control
 * uses: a 38 kHz carrier, an IR LED behind a resistor, and a TSSP77038-class demodulating
 * receiver module. Nothing visible, nothing collimated.
 *
 * PIN HISTORY (2026-09-28): the emitter reservation was originally GPIO47, but 47 became the
 * as-built drive line (Plan M PWM, then the Plan RX SA1607RX pin-14 injection wire — see
 * motor_map.h). IR-TX therefore moved to GPIO14, the original planned drive pin, free under
 * both backends. GPIO21 remains the spare if 14 is ever taken.
 *
 * Both pins are free under BOTH drive backends — Plan M owns 47 / 41 / 42 (+48 for the status
 * pixel), Plan RX owns 47 / 39..42 (+48) — so ir_tag.c compiles into both images.
 *
 *   GPIO14 — IR tag EMITTER. GPIO14 -> 100 Ohm -> IR LED anode, cathode to GND. LED aimed
 *            FORWARD off the nose of the kart. Driven by an RMT TX channel with the
 *            peripheral's hardware 38 kHz carrier riding on the mark level.
 *   GPIO3  — IR tag RECEIVER input: the TSSP77038's OUT pin, idle HIGH, pulled LOW while a
 *            38 kHz burst is present.
 *            NOTE the TSSP77038 pinout is 1 GND / 2 VS / 3 OUT / 4 G — it is NOT the TSOP
 *            pinout. Check it against the datasheet before powering the module. VS is
 *            2.0..5.5 V, so the 3V3 rail is fine.
 *            GPIO3 is an ESP32-S3 strapping pin (JTAG source select) but it is sampled only at
 *            reset; ir_tag.c configures it as an input with the internal pull-up afterwards,
 *            which is inert as a strap and keeps an UNCONNECTED pin from producing edges.
 *
 * RMT budget: the S3 has 4 RMT TX channels. status_led.c takes one (WS2812 on GPIO48),
 * rx_inject.c takes one under Plan RX, ir_tag.c takes one. Three of four.
 *
 * Route taken for the carrier: RMT TX with native carrier modulation, i.e. option (b) of the
 * two that were researched. The LEDC route (option (a), LEDC_TIMER_2 gated between 0 % and
 * 50 % duty) was NOT taken, because the receiver has to answer "which kart shot me?", not just
 * "was there 38 kHz light?" — and LEDC_TIMER_2 is consequently still free.
 *
 * Authority: docs/research/arkart-s3cam-pinmap-2026-09-19.md section 5,
 *            docs/research/arkart-research-2026-09-19.md section 3.
 */

#pragma once

#define ARKART_PIN_IR_TAG_TX_RESERVED   14  /* 38 kHz IR tag emitter  — ir_tag.c, RMT + carrier */
#define ARKART_PIN_IR_TAG_RX_RESERVED    3  /* 38 kHz IR tag receiver — ir_tag.c, edge ISR      */
