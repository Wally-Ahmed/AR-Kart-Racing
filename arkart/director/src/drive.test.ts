import { describe, expect, it, vi } from 'vitest';
import {
  clampSteer,
  clampThrottle,
  driveFromGamepad,
  driveFromKeys,
  DriveLoop,
  isNeutral,
  keyRole,
  NEUTRAL,
  sameVector,
  type DriveStatus,
  type PadLike,
} from './drive.ts';

const pad = (axes: number[], buttons: Array<{ value?: number; pressed?: boolean }>): PadLike => ({
  connected: true,
  id: 'Xbox Wireless Controller',
  axes,
  buttons,
});

describe('keyRole', () => {
  it('claims arrows and WASD, in both cases', () => {
    expect(keyRole('ArrowUp')).toBe('throttle');
    expect(keyRole('w')).toBe('throttle');
    expect(keyRole('W')).toBe('throttle');
    expect(keyRole('ArrowDown')).toBe('brake');
    expect(keyRole('S')).toBe('brake');
    expect(keyRole('ArrowLeft')).toBe('left');
    expect(keyRole('a')).toBe('left');
    expect(keyRole('ArrowRight')).toBe('right');
    expect(keyRole('d')).toBe('right');
  });

  it('leaves every other key alone — Shift+Esc (ABORT) must survive arming', () => {
    for (const k of ['Escape', 'Shift', 'Enter', ' ', 'r', 'q', 'F5', 'Tab']) {
      expect(keyRole(k)).toBeNull();
    }
  });
});

describe('driveFromKeys', () => {
  it('is neutral with nothing held', () => {
    expect(driveFromKeys([])).toEqual(NEUTRAL);
  });

  it('maps throttle and steering to full deflection', () => {
    expect(driveFromKeys(['ArrowUp'])).toEqual({ throttle: 1, steer: 0 });
    expect(driveFromKeys(['ArrowLeft'])).toEqual({ throttle: 0, steer: -1 });
    expect(driveFromKeys(['ArrowRight'])).toEqual({ throttle: 0, steer: 1 });
    expect(driveFromKeys(['w', 'd'])).toEqual({ throttle: 1, steer: 1 });
  });

  it('cancels opposite steering instead of picking a winner', () => {
    expect(driveFromKeys(['ArrowLeft', 'ArrowRight'])).toEqual({ throttle: 0, steer: 0 });
    expect(driveFromKeys(['ArrowUp', 'a', 'd'])).toEqual({ throttle: 1, steer: 0 });
  });

  it('lets the brake beat the throttle — down is a brake, never reverse', () => {
    expect(driveFromKeys(['ArrowUp', 'ArrowDown'])).toEqual({ throttle: 0, steer: 0 });
    expect(driveFromKeys(['s', 'w', 'd'])).toEqual({ throttle: 0, steer: 1 });
  });

  it('never emits negative throttle — the drive stage has no H-bridge', () => {
    for (const held of [['ArrowDown'], ['s'], ['ArrowDown', 'ArrowLeft']]) {
      expect(driveFromKeys(held).throttle).toBe(0);
    }
  });

  it('ignores keys it does not own', () => {
    expect(driveFromKeys(['Escape', 'Shift', 'ArrowUp'])).toEqual({ throttle: 1, steer: 0 });
  });
});

describe('driveFromGamepad', () => {
  it('returns null when there is no pad, so the keyboard keeps control', () => {
    expect(driveFromGamepad(null)).toBeNull();
    expect(driveFromGamepad(undefined)).toBeNull();
    expect(driveFromGamepad({ connected: false, axes: [1], buttons: [] })).toBeNull();
  });

  it('reads RT as analogue throttle and left stick X as steer (Xbox layout, as the phone does)', () => {
    expect(driveFromGamepad(pad([0.5, 0], [{ value: 0 }, {}, {}, {}, {}, {}, {}, { value: 0.8 }]))).toEqual(
      { throttle: 0.8, steer: 0.5 },
    );
  });

  it('accepts A as a digital throttle when the trigger reports no value', () => {
    expect(driveFromGamepad(pad([0, 0], [{ pressed: true }]))).toEqual({ throttle: 1, steer: 0 });
  });

  it('applies a deadzone so stick slop is not steering', () => {
    expect(driveFromGamepad(pad([0.05, 0], [{}]))!.steer).toBe(0);
    expect(driveFromGamepad(pad([-0.4, 0], [{}]))!.steer).toBe(-0.4);
  });

  it('clamps out-of-range axis reports', () => {
    expect(driveFromGamepad(pad([-3, 0], [{ value: 9 }, {}, {}, {}, {}, {}, {}, { value: 9 }]))).toEqual({
      throttle: 1,
      steer: -1,
    });
  });
});

describe('clamps', () => {
  it('holds throttle in 0..1 and steer in -1..1', () => {
    expect(clampThrottle(-1)).toBe(0);
    expect(clampThrottle(2)).toBe(1);
    expect(clampThrottle(0.3334)).toBe(0.333);
    expect(clampSteer(-2)).toBe(-1);
    expect(clampSteer(2)).toBe(1);
  });

  it('treats NaN as neutral rather than forwarding it to the module', () => {
    expect(clampThrottle(Number.NaN)).toBe(0);
    expect(clampSteer(Number.NaN)).toBe(0);
  });
});

describe('vector helpers', () => {
  it('isNeutral / sameVector', () => {
    expect(isNeutral(NEUTRAL)).toBe(true);
    expect(isNeutral({ throttle: 0, steer: 0.3 })).toBe(false);
    expect(sameVector({ throttle: 1, steer: 0 }, { throttle: 1, steer: 0 })).toBe(true);
    expect(sameVector({ throttle: 1, steer: 0 }, { throttle: 1, steer: 0.1 })).toBe(false);
  });
});

describe('DriveLoop', () => {
  const harness = (hz = 1000) => {
    const sent: Array<[number, number, number]> = [];
    const seen: DriveStatus[] = [];
    const loop = new DriveLoop(
      async (kartId, throttle, steer) => {
        sent.push([kartId, throttle, steer]);
      },
      (s) => seen.push(s),
      hz,
      () => [],
    );
    return { loop, sent, seen };
  };

  it('ignores keys until armed — no stray keypress can move a car', () => {
    const { loop } = harness();
    expect(loop.keyDown('ArrowUp')).toBe(false);
    expect(loop.get().armed).toBe(false);
    expect(loop.get().vector).toEqual(NEUTRAL);
    loop.dispose();
  });

  it('claims only its own keys once armed', () => {
    const { loop } = harness();
    loop.arm();
    expect(loop.keyDown('ArrowUp')).toBe(true);
    expect(loop.keyDown('Escape')).toBe(false);
    loop.dispose();
  });

  it('sends every tick while armed — the frame is also the keep-alive', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness(25);
      loop.arm();
      loop.keyDown('ArrowUp');
      await vi.advanceTimersByTimeAsync(200); // 5 ticks at 25 Hz
      expect(sent.length).toBeGreaterThanOrEqual(4);
      expect(sent.every(([kart, thr]) => kart === 1 && thr === 1)).toBe(true);
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('parks the kart with an explicit zero on disarm', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness(25);
      loop.arm();
      loop.keyDown('ArrowUp');
      await vi.advanceTimersByTimeAsync(80);
      loop.disarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.at(-1)).toEqual([1, 0, 0]);
      const after = sent.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(sent.length).toBe(after); // nothing is sent once disarmed
    } finally {
      vi.useRealTimers();
    }
  });

  it('zeroes the kart it is letting go of when the selection changes', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness(25);
      loop.arm();
      loop.keyDown('ArrowUp');
      await vi.advanceTimersByTimeAsync(80);
      loop.selectKart(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toContainEqual([1, 0, 0]);
      expect(loop.get().kartId).toBe(2);
      await vi.advanceTimersByTimeAsync(80);
      expect(sent.at(-1)?.[0]).toBe(2);
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a stuck throttle when the window loses focus', () => {
    const { loop } = harness();
    loop.arm();
    loop.keyDown('ArrowUp');
    loop.releaseAll();
    expect(loop.get().vector).toEqual(NEUTRAL);
    loop.dispose();
  });

  it('surfaces a send failure instead of swallowing it', async () => {
    vi.useFakeTimers();
    try {
      const seen: DriveStatus[] = [];
      const loop = new DriveLoop(
        async () => {
          throw new Error('HTTP 500 no such reducer');
        },
        (s) => seen.push(s),
        25,
        () => [],
      );
      loop.arm();
      await vi.advanceTimersByTimeAsync(80);
      expect(loop.get().error).toContain('HTTP 500');
      expect(seen.some((s) => s.error !== null)).toBe(true);
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an active pad take over, and hands straight back when it goes idle', async () => {
    vi.useFakeTimers();
    try {
      let live: PadLike | null = pad([0.6, 0], [{}, {}, {}, {}, {}, {}, {}, { value: 0.4 }]);
      const sent: Array<[number, number, number]> = [];
      const loop = new DriveLoop(
        async (k, t, s) => {
          sent.push([k, t, s]);
        },
        () => {},
        25,
        () => [live],
      );
      loop.arm();
      await vi.advanceTimersByTimeAsync(80);
      expect(loop.get().source).toBe('gamepad');
      expect(sent.at(-1)).toEqual([1, 0.4, 0.6]);

      live = pad([0, 0], [{}, {}, {}, {}, {}, {}, {}, { value: 0 }]); // thumbs off
      loop.keyDown('ArrowUp');
      await vi.advanceTimersByTimeAsync(80);
      expect(loop.get().source).toBe('keyboard');
      expect(sent.at(-1)).toEqual([1, 1, 0]);
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
