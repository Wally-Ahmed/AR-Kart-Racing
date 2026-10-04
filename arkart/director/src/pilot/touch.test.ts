import { describe, expect, it, vi } from 'vitest';
import { DriveLoop, NEUTRAL, type DriveStatus } from '../drive.ts';
import {
  NEUTRAL_TOUCH,
  parseKartParam,
  STEER_DEADZONE,
  steerFromPointer,
  streamUrl,
  throttleDrag,
  THROTTLE_TRAVEL,
  vectorFromTouch,
  type PadRect,
} from './touch.ts';

/** A left-half steer pad on a 844×390 landscape phone: x 6..416, y 68..384. */
const steerPad: PadRect = { left: 6, top: 68, width: 410, height: 316 };
/** The throttle pad above the brake zone on the right half. */
const thrPad: PadRect = { left: 428, top: 68, width: 410, height: 196 };

const centreX = steerPad.left + steerPad.width / 2;

describe('steerFromPointer', () => {
  it('is straight at the centre of the pad', () => {
    expect(steerFromPointer(centreX, steerPad)).toBe(0);
  });

  it('reads left as negative and right as positive', () => {
    expect(steerFromPointer(centreX - 100, steerPad)).toBeLessThan(0);
    expect(steerFromPointer(centreX + 100, steerPad)).toBeGreaterThan(0);
  });

  it('reaches full lock before the edge, and never exceeds it', () => {
    // STEER_TRAVEL = 0.9, so 90% of the half-width is full lock.
    expect(steerFromPointer(steerPad.left, steerPad)).toBe(-1);
    expect(steerFromPointer(steerPad.left + steerPad.width, steerPad)).toBe(1);
    // A thumb that slides off the side of the phone still means full lock, not a wrapped value.
    expect(steerFromPointer(steerPad.left - 400, steerPad)).toBe(-1);
    expect(steerFromPointer(steerPad.left + steerPad.width + 400, steerPad)).toBe(1);
  });

  it('ignores a resting thumb inside the deadzone', () => {
    const half = (steerPad.width / 2) * 0.9;
    const justInside = centreX + half * (STEER_DEADZONE - 0.01);
    expect(steerFromPointer(justInside, steerPad)).toBe(0);
  });

  it('leaves no step at the edge of the deadzone', () => {
    const half = (steerPad.width / 2) * 0.9;
    const justOutside = centreX + half * (STEER_DEADZONE + 0.001);
    const out = steerFromPointer(justOutside, steerPad);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(0.01); // rescaled from 0, not jumped to 0.08
  });

  it('is monotonic across the pad', () => {
    let last = -Infinity;
    for (let x = steerPad.left; x <= steerPad.left + steerPad.width; x += 10) {
      const v = steerFromPointer(x, steerPad);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('is symmetric about the centre', () => {
    for (const d of [30, 90, 150]) {
      expect(steerFromPointer(centreX + d, steerPad)).toBeCloseTo(
        -steerFromPointer(centreX - d, steerPad),
        6,
      );
    }
  });

  it('survives a zero-width pad and a NaN coordinate instead of emitting NaN', () => {
    expect(steerFromPointer(100, { left: 0, top: 0, width: 0, height: 0 })).toBe(0);
    expect(steerFromPointer(Number.NaN, steerPad)).toBe(0);
  });
});

describe('throttleDrag', () => {
  const anchor = 200;
  const travel = thrPad.height * THROTTLE_TRAVEL;

  it('is zero the instant a thumb lands — a touch is never throttle', () => {
    expect(throttleDrag(anchor, anchor, thrPad)).toEqual({ anchorY: anchor, throttle: 0 });
  });

  it('grows as the thumb drags up and reaches 1 at full travel', () => {
    expect(throttleDrag(anchor, anchor - travel / 2, thrPad).throttle).toBeCloseTo(0.5, 2);
    expect(throttleDrag(anchor, anchor - travel, thrPad).throttle).toBe(1);
    expect(throttleDrag(anchor, anchor - travel * 3, thrPad).throttle).toBe(1);
  });

  it('keeps the anchor while the drag is upward', () => {
    expect(throttleDrag(anchor, anchor - 20, thrPad).anchorY).toBe(anchor);
  });

  it('sinks the anchor when the thumb drags below it, so coming back up responds at once', () => {
    const down = throttleDrag(anchor, anchor + 120, thrPad);
    expect(down).toEqual({ anchorY: anchor + 120, throttle: 0 });
    // From the sunk anchor, half the travel upward is half throttle again.
    expect(throttleDrag(down.anchorY, down.anchorY - travel / 2, thrPad).throttle).toBeCloseTo(
      0.5,
      2,
    );
  });

  it('never returns a negative throttle — the drive stage has no H-bridge', () => {
    for (const y of [anchor, anchor + 1, anchor + 500]) {
      expect(throttleDrag(anchor, y, thrPad).throttle).toBe(0);
    }
  });

  it('survives a zero-height pad and NaN coordinates', () => {
    expect(throttleDrag(anchor, 10, { left: 0, top: 0, width: 10, height: 0 }).throttle).toBe(0);
    expect(throttleDrag(anchor, Number.NaN, thrPad).throttle).toBe(0);
    expect(throttleDrag(Number.NaN, 10, thrPad).throttle).toBe(0);
  });
});

describe('vectorFromTouch', () => {
  it('is neutral with no thumbs down', () => {
    expect(vectorFromTouch(NEUTRAL_TOUCH)).toEqual(NEUTRAL);
  });

  it('treats a lifted steer thumb as straight, not as the last value', () => {
    expect(vectorFromTouch({ steer: null, throttle: 0.5, brake: false })).toEqual({
      throttle: 0.5,
      steer: 0,
    });
  });

  it('combines steering and throttle — multi-touch is the point', () => {
    expect(vectorFromTouch({ steer: -0.75, throttle: 0.4, brake: false })).toEqual({
      throttle: 0.4,
      steer: -0.75,
    });
  });

  it('lets the BRAKE zone outrank a held throttle', () => {
    expect(vectorFromTouch({ steer: 0.5, throttle: 1, brake: true })).toEqual({
      throttle: 0,
      steer: 0.5,
    });
  });

  it('clamps whatever the pads produce', () => {
    expect(vectorFromTouch({ steer: -9, throttle: 9, brake: false })).toEqual({
      throttle: 1,
      steer: -1,
    });
    expect(vectorFromTouch({ steer: Number.NaN, throttle: Number.NaN, brake: false })).toEqual(
      NEUTRAL,
    );
  });
});

describe('parseKartParam', () => {
  it('reads ?kart=N', () => {
    expect(parseKartParam('?kart=1')).toBe(1);
    expect(parseKartParam('?adapter=mock&kart=2')).toBe(2);
  });

  it('falls through to the picker rather than guessing', () => {
    for (const s of ['', '?', '?kart=', '?kart=one', '?kart=0', '?kart=-1', '?kart=1.5', '?k=1']) {
      expect(parseKartParam(s)).toBeNull();
    }
  });
});

describe('streamUrl', () => {
  it('builds the firmware MJPEG endpoint: port 80, /stream', () => {
    expect(streamUrl('192.168.8.101')).toBe('http://192.168.8.101/stream');
    expect(streamUrl(' 192.168.8.101 ')).toBe('http://192.168.8.101/stream');
    expect(streamUrl('kart1.local')).toBe('http://kart1.local/stream');
  });

  it('adds a cache-buster for the RETRY button so the dead stream is not re-served', () => {
    expect(streamUrl('192.168.8.101', 1234)).toBe('http://192.168.8.101/stream?r=1234');
  });

  it('rejects the karts.json placeholder and empty ips instead of hammering DNS', () => {
    expect(streamUrl('REAL_CAR_IP')).toBeNull();
    expect(streamUrl('')).toBeNull();
    expect(streamUrl(null)).toBeNull();
    expect(streamUrl(undefined)).toBeNull();
    expect(streamUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('DriveLoop with touch', () => {
  const harness = (hz = 25) => {
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

  it('sends the thumbs at 25 Hz and reports source `touch`', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness();
      loop.setTouch(NEUTRAL);
      loop.arm();
      loop.setTouch(vectorFromTouch({ steer: -0.5, throttle: 0.8, brake: false }));
      await vi.advanceTimersByTimeAsync(200);
      expect(sent.length).toBeGreaterThanOrEqual(4);
      expect(sent.at(-1)).toEqual([1, 0.8, -0.5]);
      expect(loop.get().source).toBe('touch');
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sending zeros after the thumbs lift — the frame is the keep-alive', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness();
      loop.setTouch(NEUTRAL);
      loop.arm();
      loop.setTouch({ throttle: 1, steer: 0 });
      await vi.advanceTimersByTimeAsync(80);
      loop.setTouch(NEUTRAL); // thumbs up → coast
      const before = sent.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(sent.length).toBeGreaterThan(before);
      expect(sent.at(-1)).toEqual([1, 0, 0]);
      expect(loop.get().source).toBe('touch'); // not 'keyboard' — this page has no keys
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing at all until armed', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness();
      loop.setTouch({ throttle: 1, steer: 1 });
      await vi.advanceTimersByTimeAsync(300);
      expect(sent).toEqual([]);
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('parks the kart on disarm and drops the thumbs', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness();
      loop.setTouch(NEUTRAL);
      loop.arm();
      loop.setTouch({ throttle: 1, steer: 0.6 });
      await vi.advanceTimersByTimeAsync(80);
      loop.disarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.at(-1)).toEqual([1, 0, 0]);
      const after = sent.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(sent.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the thumbs on blur, so a pointerup eaten by the app switcher cannot stick', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness();
      loop.setTouch(NEUTRAL);
      loop.arm();
      loop.setTouch({ throttle: 1, steer: 0 });
      await vi.advanceTimersByTimeAsync(80);
      expect(sent.at(-1)?.[1]).toBe(1);
      loop.releaseAll();
      await vi.advanceTimersByTimeAsync(80);
      expect(loop.get().vector).toEqual(NEUTRAL);
      expect(sent.at(-1)).toEqual([1, 0, 0]);
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('zeroes the kart it lets go of when the pilot re-claims another one', async () => {
    vi.useFakeTimers();
    try {
      const { loop, sent } = harness();
      loop.setTouch(NEUTRAL);
      loop.arm();
      loop.setTouch({ throttle: 0.9, steer: 0 });
      await vi.advanceTimersByTimeAsync(80);
      loop.selectKart(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toContainEqual([1, 0, 0]);
      await vi.advanceTimersByTimeAsync(80);
      expect(sent.at(-1)).toEqual([2, 0, 0]); // thumbs dropped by the hand-over
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a pushed gamepad override the thumbs, and hands back when it idles', async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<[number, number, number]> = [];
      let axis = 0.3;
      let trigger = 0.5;
      const loop = new DriveLoop(
        async (k, t, s) => {
          sent.push([k, t, s]);
        },
        () => {},
        25,
        () => [
          {
            connected: true,
            id: 'Pro Controller',
            axes: [axis, 0],
            buttons: [{}, {}, {}, {}, {}, {}, {}, { value: trigger }],
          },
        ],
      );
      loop.setTouch(NEUTRAL);
      loop.arm();
      loop.setTouch({ throttle: 0.2, steer: 0 });
      await vi.advanceTimersByTimeAsync(80);
      expect(loop.get().source).toBe('gamepad');
      expect(sent.at(-1)).toEqual([1, 0.5, 0.3]);

      axis = 0; // hands off the pad entirely
      trigger = 0;
      await vi.advanceTimersByTimeAsync(80);
      expect(loop.get().source).toBe('touch');
      expect(sent.at(-1)).toEqual([1, 0.2, 0]);
      loop.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
