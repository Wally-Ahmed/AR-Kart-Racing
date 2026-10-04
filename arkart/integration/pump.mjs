/**
 * Stand-in for the iOS pilot app: POST `set_input` at 20 Hz, forever.
 *
 *   node pump.mjs <sticks.json> [http-origin] [database]
 *
 * `sticks.json` is re-read every cycle, so the demo script can move the sticks
 * mid-race just by rewriting the file:
 *
 *   { "1": { "t": 0.5, "s": 0.5 }, "2": { "t": 0.5, "s": 0.5 } }
 *
 * Why this exists: the module stamps `input.updated_at` on every `set_input`,
 * and the car bridge treats any input older than 500 ms as STALE (throttle and
 * steer forced to 0 — a dead phone must not leave a car pinned). So a one-shot
 * curl is invisible on the wire a half-second later; a real pilot holds the
 * stick down at ~25 Hz, and so does this.
 */

import { readFileSync } from 'node:fs';

const [, , sticksPath, originArg, dbArg] = process.argv;
if (!sticksPath) {
  console.error('usage: node pump.mjs <sticks.json> [http-origin] [database]');
  process.exit(2);
}
const origin = originArg ?? 'http://127.0.0.1:3000';
const database = dbArg ?? 'arkart';
const url = `${origin}/v1/database/${database}/call/set_input`;

let sticks = {};
let sent = 0;
let failed = 0;

function reload() {
  try {
    sticks = JSON.parse(readFileSync(sticksPath, 'utf8'));
  } catch {
    /* mid-write by the demo script — keep the previous values for this cycle */
  }
}

async function cycle() {
  reload();
  for (const [kartId, v] of Object.entries(sticks)) {
    const body = JSON.stringify([Number(kartId), Number(v?.t ?? 0), Number(v?.s ?? 0)]);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) sent += 1;
      else failed += 1;
      // Drain the body so the socket is reused rather than leaked.
      await res.arrayBuffer();
    } catch {
      failed += 1;
    }
  }
}

reload();
console.log(`[pump] set_input -> ${url} @ 20 Hz from ${sticksPath}`);
const timer = setInterval(() => {
  void cycle();
}, 50);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(timer);
    console.log(`[pump] stopped — ${sent} accepted, ${failed} failed`);
    process.exit(0);
  });
}
