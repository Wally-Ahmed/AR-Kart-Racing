/**
 * The rule engine (docs/design/arkart-game-software-v1.md §5).
 * Every item in the D2 list gets a test, plus the kill switch.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CAP_FLOOR,
  INPUT_STALE_MS,
  computeCommand,
  isEffectActive,
  speedCap,
  steerToByte,
  throttleToByte,
} from '../src/logic.ts';
import { FLAG_SHIELD } from '../src/packet.ts';
import type { EffectKind, EffectRow, RaceState, WorldSnapshot } from '../src/types.ts';

const NOW = 1_700_000_000_000;

let nextEffectId = 1;
function fx(kartId: number, kind: EffectKind, multiplier = 1, expiresAt: number | null = NOW + 5000): EffectRow {
  return { id: nextEffectId++, kartId, kind, multiplier, expiresAt };
}

function world(opts: {
  state?: RaceState;
  inputs?: Array<{ kartId: number; throttle: number; steer: number; ageMs?: number }>;
  effects?: EffectRow[];
}): WorldSnapshot {
  const snap: WorldSnapshot = {
    config: {
      lapCount: 3,
      itemRollPct: 100,
      state: opts.state ?? 'running',
      countdownEndsAt: null,
    },
    karts: [
      { kartId: 1, name: 'kart-1', ip: '192.168.8.101', pilotIdentity: null },
      { kartId: 2, name: 'kart-2', ip: '192.168.8.102', pilotIdentity: null },
    ],
    inputs: new Map(),
    effects: opts.effects ?? [],
  };
  for (const i of opts.inputs ?? []) {
    snap.inputs.set(i.kartId, {
      kartId: i.kartId,
      throttle: i.throttle,
      steer: i.steer,
      updatedAt: NOW - (i.ageMs ?? 0),
    });
  }
  return snap;
}

const fullAhead = (kartId = 1, steer = 0) => [{ kartId, throttle: 1.0, steer }];

describe('quantisation', () => {
  it('throttle 0..1 -> u8 0..255', () => {
    assert.equal(throttleToByte(0), 0);
    assert.equal(throttleToByte(1), 255);
    assert.equal(throttleToByte(0.5), 128); // round(127.5) = 128
    assert.equal(throttleToByte(2), 255, 'clamped');
    assert.equal(throttleToByte(-1), 0, 'clamped');
  });

  it('steer -1..1 -> i8 -127..127, symmetric about zero', () => {
    assert.equal(steerToByte(1), 127);
    assert.equal(steerToByte(-1), -127);
    assert.equal(steerToByte(0), 0);
    assert.equal(steerToByte(0.5), 64);
    assert.equal(steerToByte(-0.5), -64, 'mirror image of +0.5');
    assert.equal(steerToByte(2), 127, 'clamped');
    assert.equal(steerToByte(-2), -127, 'clamped');
    assert.ok(!Object.is(steerToByte(-0.001), -0), 'no negative zero on the wire');
  });
});

describe('speedCap — effect merging', () => {
  it('no effects -> 1.0', () => {
    assert.equal(speedCap([]), 1);
  });

  it('boost alone multiplies', () => {
    assert.equal(speedCap([fx(1, 'boost', 1.5)]), 1.5);
  });

  it('slow alone multiplies', () => {
    assert.equal(speedCap([fx(1, 'slow', 0.5)]), 0.5);
  });

  it('boost and slow stack multiplicatively', () => {
    assert.equal(speedCap([fx(1, 'boost', 2.0), fx(1, 'slow', 0.5)]), 1.0);
    assert.equal(speedCap([fx(1, 'boost', 1.5), fx(1, 'boost', 2.0)]), 3.0);
  });

  it('stacking slows bottoms out at the 0.2 floor', () => {
    assert.equal(CAP_FLOOR, 0.2);
    assert.equal(speedCap([fx(1, 'slow', 0.5), fx(1, 'slow', 0.3)]), 0.2, '0.15 -> floor');
    assert.equal(
      speedCap([fx(1, 'slow', 0.5), fx(1, 'slow', 0.5), fx(1, 'slow', 0.5)]),
      0.2,
      '0.125 -> floor',
    );
    assert.equal(speedCap([fx(1, 'slow', 0)]), 0.2, 'a zero multiplier cannot beat the floor');
    assert.equal(speedCap([fx(1, 'boost', 2.0), fx(1, 'slow', 0.1)]), 0.2, 'exactly at the floor');
  });

  it('ink, shield, stun and dizzy never touch the cap', () => {
    assert.equal(speedCap([fx(1, 'ink', 0.1), fx(1, 'shield', 0), fx(1, 'dizzy', 0)]), 1);
    assert.equal(speedCap([fx(1, 'stun', 0)]), 1, 'stun zeroes throttle, it does not scale it');
  });
});

describe('effect expiry', () => {
  it('an effect with no expiry never times out (shield: consumed on hit)', () => {
    assert.equal(isEffectActive(fx(1, 'shield', 1, null), NOW + 1e9), true);
  });

  it('an expired effect is inactive and is ignored by the engine', () => {
    const expired = fx(1, 'slow', 0.5, NOW - 1);
    assert.equal(isEffectActive(expired, NOW), false);
    const r = computeCommand(1, world({ inputs: fullAhead(), effects: [expired] }), NOW);
    assert.equal(r.trace.cap, 1, 'expired slow does not apply');
    assert.equal(r.command.throttle, 255);
  });
});

describe('computeCommand', () => {
  it('baseline: running, fresh input, no effects -> straight passthrough', () => {
    const r = computeCommand(1, world({ inputs: [{ kartId: 1, throttle: 1, steer: 1 }] }), NOW);
    assert.deepEqual(r.command, { kartId: 1, throttle: 255, steer: 127, flags: 0 });
  });

  it('boost alone scales throttle up', () => {
    const r = computeCommand(
      1,
      world({ inputs: [{ kartId: 1, throttle: 0.5, steer: 0 }], effects: [fx(1, 'boost', 1.5)] }),
      NOW,
    );
    assert.equal(r.trace.cap, 1.5);
    assert.equal(r.trace.throttleUnit, 0.75);
    assert.equal(r.command.throttle, 191); // round(0.75 * 255)
  });

  it('boost saturates at the wire maximum instead of overflowing', () => {
    const r = computeCommand(
      1,
      world({ inputs: fullAhead(), effects: [fx(1, 'boost', 2.0)] }),
      NOW,
    );
    assert.equal(r.trace.throttleUnit, 2.0);
    assert.equal(r.command.throttle, 255);
  });

  it('boost + slow stacking down to the floor', () => {
    const r = computeCommand(
      1,
      world({
        inputs: fullAhead(),
        effects: [fx(1, 'boost', 2.0), fx(1, 'slow', 0.5), fx(1, 'slow', 0.1)],
      }),
      NOW,
    );
    assert.equal(r.trace.cap, 0.2, '2.0*0.5*0.1 = 0.1 -> floored at 0.2');
    assert.equal(r.command.throttle, 51, 'round(0.2 * 255)');
  });

  it('stun zeroes throttle even under a huge boost, but leaves steering', () => {
    const r = computeCommand(
      1,
      world({
        inputs: [{ kartId: 1, throttle: 1, steer: 1 }],
        effects: [fx(1, 'boost', 5.0), fx(1, 'stun', 1)],
      }),
      NOW,
    );
    assert.equal(r.trace.stunned, true);
    assert.equal(r.command.throttle, 0);
    assert.equal(r.command.steer, 127, 'a stunned kart can still be pointed');
  });

  it('dizzy inverts steering and nothing else', () => {
    const w = world({
      inputs: [{ kartId: 1, throttle: 0.8, steer: 0.5 }],
      effects: [fx(1, 'dizzy', 1)],
    });
    const r = computeCommand(1, w, NOW);
    assert.equal(r.trace.dizzy, true);
    assert.equal(r.command.steer, -64, 'exactly the negation of the undizzy value');
    assert.equal(
      r.command.throttle,
      computeCommand(1, world({ inputs: [{ kartId: 1, throttle: 0.8, steer: 0.5 }] }), NOW).command
        .throttle,
      'throttle untouched by dizzy',
    );
  });

  it('dizzy is an exact mirror at every deflection', () => {
    for (const steer of [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]) {
      const plain = computeCommand(1, world({ inputs: [{ kartId: 1, throttle: 0, steer }] }), NOW);
      const spun = computeCommand(
        1,
        world({ inputs: [{ kartId: 1, throttle: 0, steer }], effects: [fx(1, 'dizzy', 1)] }),
        NOW,
      );
      // `| 0` normalises the -0 that negating 0 produces; the wire has no -0.
      assert.equal(spun.command.steer, -plain.command.steer | 0, `steer=${steer}`);
    }
  });

  it('shield raises flags bit0 and touches nothing else', () => {
    const r = computeCommand(
      1,
      world({ inputs: fullAhead(), effects: [fx(1, 'shield', 1, null)] }),
      NOW,
    );
    assert.equal(r.command.flags, FLAG_SHIELD);
    assert.equal(r.command.flags & 0x01, 1);
    assert.equal(r.command.throttle, 255);
    assert.equal(r.trace.cap, 1);
  });

  it('no shield -> flags 0', () => {
    const r = computeCommand(1, world({ inputs: fullAhead() }), NOW);
    assert.equal(r.command.flags, 0);
  });

  it('shield LED stays lit even when the race is not running', () => {
    const r = computeCommand(
      1,
      world({ state: 'lobby', inputs: fullAhead(), effects: [fx(1, 'shield', 1, null)] }),
      NOW,
    );
    assert.equal(r.command.throttle, 0);
    assert.equal(r.command.flags, FLAG_SHIELD);
  });

  it('ink is screen-only: motion is untouched', () => {
    const r = computeCommand(
      1,
      world({ inputs: [{ kartId: 1, throttle: 1, steer: 1 }], effects: [fx(1, 'ink', 1)] }),
      NOW,
    );
    assert.equal(r.trace.ink, true);
    assert.deepEqual(r.command, { kartId: 1, throttle: 255, steer: 127, flags: 0 });
  });

  it('another kart’s effects never leak across', () => {
    const r = computeCommand(
      1,
      world({
        inputs: fullAhead(),
        effects: [fx(2, 'stun', 1), fx(2, 'slow', 0.2), fx(2, 'shield', 1, null)],
      }),
      NOW,
    );
    assert.deepEqual(r.command, { kartId: 1, throttle: 255, steer: 0, flags: 0 });
  });

  it('all six items at once on one kart', () => {
    const r = computeCommand(
      1,
      world({
        inputs: [{ kartId: 1, throttle: 1, steer: 1 }],
        effects: [
          fx(1, 'boost', 1.5),
          fx(1, 'slow', 0.5),
          fx(1, 'ink', 1),
          fx(1, 'dizzy', 1),
          fx(1, 'shield', 1, null),
          fx(1, 'stun', 1),
        ],
      }),
      NOW,
    );
    assert.equal(r.trace.cap, 0.75);
    assert.equal(r.command.throttle, 0, 'stun wins over the cap');
    assert.equal(r.command.steer, -127, 'dizzy still inverts');
    assert.equal(r.command.flags, FLAG_SHIELD);
  });
});

describe('kill switch — race state', () => {
  for (const state of ['setup', 'lobby', 'countdown', 'finished'] as RaceState[]) {
    it(`state "${state}" forces throttle 0 at full stick`, () => {
      const r = computeCommand(1, world({ state, inputs: [{ kartId: 1, throttle: 1, steer: 1 }] }), NOW);
      assert.equal(r.trace.running, false);
      assert.equal(r.command.throttle, 0);
      assert.equal(r.command.steer, 0, 'steer coil de-energised too');
    });
  }

  it('state "running" is the only one that lets throttle through', () => {
    const r = computeCommand(1, world({ state: 'running', inputs: fullAhead() }), NOW);
    assert.equal(r.trace.running, true);
    assert.equal(r.command.throttle, 255);
  });

  it('a missing config row (bridge started before the module) parks the karts', () => {
    const w = world({ inputs: fullAhead() });
    w.config = null;
    const r = computeCommand(1, w, NOW);
    assert.equal(r.command.throttle, 0);
  });

  it('abort_race (running -> lobby) is a physical kill switch mid-boost', () => {
    const effects = [fx(1, 'boost', 2.0)];
    const before = computeCommand(1, world({ state: 'running', inputs: fullAhead(), effects }), NOW);
    const after = computeCommand(1, world({ state: 'lobby', inputs: fullAhead(), effects }), NOW);
    assert.equal(before.command.throttle, 255);
    assert.equal(after.command.throttle, 0);
  });
});

describe('stale input', () => {
  it('input older than 500 ms zeroes throttle and centres steer', () => {
    const r = computeCommand(
      1,
      world({ inputs: [{ kartId: 1, throttle: 1, steer: 1, ageMs: INPUT_STALE_MS + 1 }] }),
      NOW,
    );
    assert.equal(r.trace.stale, true);
    assert.equal(r.command.throttle, 0);
    assert.equal(r.command.steer, 0);
  });

  it('input exactly at the staleness boundary is still live', () => {
    const r = computeCommand(
      1,
      world({ inputs: [{ kartId: 1, throttle: 1, steer: 1, ageMs: INPUT_STALE_MS }] }),
      NOW,
    );
    assert.equal(r.trace.stale, false);
    assert.equal(r.command.throttle, 255);
  });

  it('a kart with no input row at all is parked', () => {
    const r = computeCommand(2, world({ inputs: fullAhead(1) }), NOW);
    assert.equal(r.trace.stale, true);
    assert.deepEqual(r.command, { kartId: 2, throttle: 0, steer: 0, flags: 0 });
  });
});

describe('defensive clamping', () => {
  it('out-of-range input from a misbehaving client cannot produce an invalid packet', () => {
    const r = computeCommand(
      1,
      world({ inputs: [{ kartId: 1, throttle: 99, steer: -99 }] }),
      NOW,
    );
    assert.equal(r.command.throttle, 255);
    assert.equal(r.command.steer, -127);
  });

  it('NaN input degrades to zero, not to a thrown packet', () => {
    const r = computeCommand(
      1,
      world({ inputs: [{ kartId: 1, throttle: NaN, steer: NaN }] }),
      NOW,
    );
    assert.equal(r.command.throttle, 0);
    assert.equal(r.command.steer, 0);
  });

  it('a garbage multiplier is ignored rather than poisoning the cap', () => {
    assert.equal(speedCap([fx(1, 'slow', NaN)]), 1);
    assert.equal(speedCap([fx(1, 'boost', -3)]), 1);
  });
});
