/**
 * Mock adapter — a self-contained simulated race.
 *
 * Why it exists: the director screen must be demoable (and stylable) with no server, no module
 * and no karts. It reimplements just enough of spec §4's reducer semantics — checkpoint order,
 * lap wrap, placement recompute, 2-slot item grants, effect expiry, event log — to drive every
 * pixel of the UI. It is NOT the game; the module is authoritative. Nothing else imports it.
 */

import type { AdapterConfig, AdapterListener, DirectorAdapter } from './adapter.ts';
import { placementComparator } from '../placement.ts';
import type {
  EffectRow,
  EventLogRow,
  InputRow,
  InventoryRow,
  ItemKind,
  KartRow,
  ProgressRow,
  RaceSnapshot,
  RaceState,
  SetupSeenRow,
  TrackRow,
} from '../types.ts';

const ITEM_POOL: Array<{ item: ItemKind; weight: number }> = [
  { item: 'boost', weight: 25 },
  { item: 'shield', weight: 20 },
  { item: 'stun', weight: 15 },
  { item: 'ink', weight: 15 },
  { item: 'dizzy', weight: 15 },
  { item: 'leader_strike', weight: 10 },
];

const EFFECT_SPEC: Record<ItemKind, { kind: EffectRow['kind']; ms: number | null; mult: number }> = {
  boost: { kind: 'boost', ms: 2000, mult: 1.4 },
  stun: { kind: 'stun', ms: 2000, mult: 0 },
  ink: { kind: 'ink', ms: 4000, mult: 1 },
  dizzy: { kind: 'dizzy', ms: 4000, mult: 1 },
  leader_strike: { kind: 'slow', ms: 3000, mult: 0.3 },
  shield: { kind: 'shield', ms: null, mult: 1 },
};

const GATE_TAGS = [17, 23, 31, 42, 58];
const TICK_MS = 100;
/** How long a human `set_input` frame holds a kart against the simulated pilot. */
const PILOT_HOLD_MS = 600;

function rollItem(rand: () => number): ItemKind {
  const total = ITEM_POOL.reduce((a, p) => a + p.weight, 0);
  let x = rand() * total;
  for (const p of ITEM_POOL) {
    x -= p.weight;
    if (x <= 0) return p.item;
  }
  return 'boost';
}

/** Deterministic-ish PRNG so a demo run looks the same twice if we want it to. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockAdapter implements DirectorAdapter {
  readonly name = 'mock';
  readonly endpoint = 'simulated race (no server)';

  private listener: AdapterListener | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rand = mulberry32(0xa2ca27);
  private nextEffectId = 1;

  private state: RaceState = 'setup';
  private countdownEndsAt: number | null = null;
  private lapCount = 3;
  private karts: KartRow[] = [
    { kart_id: 1, name: 'SCARLET', ip: '10.0.0.11', pilot_identity: 'pilot-a' },
    { kart_id: 2, name: 'COBALT', ip: '10.0.0.12', pilot_identity: 'pilot-b' },
  ];
  private track: TrackRow[] = [];
  private setupSeen: SetupSeenRow[] = [];
  private progress = new Map<number, ProgressRow>();
  private inventory = new Map<number, InventoryRow>();
  private effects: EffectRow[] = [];
  private events: EventLogRow[] = [];
  private inputs = new Map<number, InputRow>();
  /**
   * Karts a human is driving through `set_input`, and when their last frame landed.
   *
   * The simulated pilots overwrite `inputs` every tick, so without this the drive control would
   * be invisible in mock mode. A kart whose last human frame is within `PILOT_HOLD_MS` is left
   * to the human — the same staleness rule the car bridge applies (spec §1 D1), just slacker so
   * a dropped frame does not flicker the kart back to the simulation.
   */
  private piloted = new Map<number, number>();
  /** virtual distance to the next gate, 0..1 */
  private toNextGate = new Map<number, number>();
  private nextSetupSightingAt = 0;

  constructor(_cfg: AdapterConfig) {
    void _cfg;
  }

  start(listener: AdapterListener): void {
    this.listener = listener;
    this.log('director screen online — mock race engine');
    listener({ type: 'status', status: 'live', detail: 'MOCK — simulated race, no server' });
    this.nextSetupSightingAt = Date.now() + 900;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listener = null;
  }

  async beginSetup(): Promise<void> {
    this.state = 'setup';
    this.track = [];
    this.setupSeen = [];
    this.progress.clear();
    this.inventory.clear();
    this.effects = [];
    this.nextSetupSightingAt = Date.now() + 900;
    this.log('SETUP began — drive the calibration lap');
    this.emit();
  }

  async confirmTrack(ordered: number[]): Promise<void> {
    if (ordered.length < 3) throw new Error('need at least 3 checkpoints');
    if (new Set(ordered).size !== ordered.length) throw new Error('duplicate tag ids');
    this.track = ordered.map((tag_id, seq) => ({ seq, tag_id }));
    this.state = 'lobby';
    this.log(`TRACK confirmed — ${ordered.length} gates, start/finish = tag ${ordered[0]}`);
    this.emit();
  }

  async startRace(): Promise<void> {
    if (this.track.length < 3) throw new Error('confirm a track first');
    this.state = 'countdown';
    this.countdownEndsAt = Date.now() + 3000;
    this.effects = [];
    for (const k of this.karts) {
      this.progress.set(k.kart_id, {
        kart_id: k.kart_id,
        lap: 0,
        // Karts start ON the start/finish gate (seq 0), so the first gate they drive at is
        // seq 1 — same grid state the module writes. `next_idx === 0` therefore only ever
        // means "every gate cleared, running at the line", which is what the wrap fix assumes.
        next_idx: this.track.length > 1 ? 1 : 0,
        last_pass_at: Date.now(),
        placement: 0,
        finished_at: null,
      });
      this.inventory.set(k.kart_id, { kart_id: k.kart_id, slot1: null, slot2: null });
      this.toNextGate.set(k.kart_id, 0);
    }
    this.log('COUNTDOWN — 3…');
    this.emit();
  }

  async resetRace(): Promise<void> {
    this.state = 'lobby';
    this.countdownEndsAt = null;
    this.progress.clear();
    this.inventory.clear();
    this.effects = [];
    this.inputs.clear();
    this.piloted.clear();
    this.log('RACE reset — back to lobby (track kept)');
    this.emit();
  }

  async abortRace(): Promise<void> {
    this.state = 'lobby';
    this.countdownEndsAt = null;
    this.effects = [];
    for (const [id, input] of this.inputs) this.inputs.set(id, { ...input, throttle: 0 });
    this.log('*** ABORT *** — throttle killed on every kart');
    this.emit();
  }

  /**
   * The pilot reducer. Writes the `input` row the kart card renders, and claims the kart from the
   * simulated pilot so the keys visibly move it (`simulateRunning` honours `piloted`).
   *
   * Silent: 25 writes a second must not produce 25 event-log lines, and `emit()` is left to the
   * next simulation tick — the screen repaints at 10 Hz regardless.
   */
  async setInput(kartId: number, throttle: number, steer: number): Promise<void> {
    const now = Date.now();
    this.piloted.set(kartId, now);
    this.inputs.set(kartId, { kart_id: kartId, throttle, steer, updated_at: now });
  }

  // ---- simulation ---------------------------------------------------------

  private tick(): void {
    const now = Date.now();
    const before = this.effects.length;
    this.effects = this.effects.filter((e) => e.expires_at === null || e.expires_at > now);
    let dirty = this.effects.length !== before;

    if (this.state === 'setup') {
      if (now >= this.nextSetupSightingAt && this.setupSeen.length < GATE_TAGS.length) {
        const tag = GATE_TAGS[this.setupSeen.length];
        this.setupSeen.push({ tag_id: tag, first_seen_at: now });
        this.log(`gate sighted — tag ${tag} (#${this.setupSeen.length})`);
        this.nextSetupSightingAt = now + 1400 + this.rand() * 900;
        dirty = true;
      }
    } else if (this.state === 'countdown') {
      if (this.countdownEndsAt !== null && now >= this.countdownEndsAt) {
        this.state = 'running';
        this.countdownEndsAt = null;
        this.log('GREEN LIGHT — race is running');
      }
      dirty = true;
    } else if (this.state === 'running') {
      dirty = this.simulateRunning(now) || dirty;
    }

    if (dirty) this.emit();
    else this.emit(); // countdowns/effect bars are time-based; repaint every tick anyway
  }

  private simulateRunning(now: number): boolean {
    let dirty = false;
    for (const kart of this.karts) {
      const p = this.progress.get(kart.kart_id);
      if (!p || p.finished_at !== null) continue;
      const mine = this.effects.filter((e) => e.kart_id === kart.kart_id);
      const stunned = mine.some((e) => e.kind === 'stun');
      const cap = Math.max(
        0.2,
        mine
          .filter((e) => e.kind === 'boost' || e.kind === 'slow')
          .reduce((acc, e) => acc * e.multiplier, 1),
      );
      // A human at the keyboard outranks the simulated pilot, but a stun still zeroes them —
      // the effect is applied by the module/bridge, not by the pilot, exactly as on real hardware.
      const pilotedAt = this.piloted.get(kart.kart_id) ?? 0;
      const human = now - pilotedAt < PILOT_HOLD_MS ? this.inputs.get(kart.kart_id) : undefined;
      const throttle = stunned ? 0 : (human?.throttle ?? 0.55 + this.rand() * 0.35);
      this.inputs.set(kart.kart_id, {
        kart_id: kart.kart_id,
        throttle,
        steer: human?.steer ?? Math.sin(now / 900 + kart.kart_id) * 0.6,
        updated_at: human ? pilotedAt : now,
      });
      const advance = (throttle * cap * TICK_MS) / 2600;
      const d = (this.toNextGate.get(kart.kart_id) ?? 0) + advance;
      if (d >= 1) {
        this.toNextGate.set(kart.kart_id, d - 1);
        this.passGate(kart, p, now);
        dirty = true;
      } else {
        this.toNextGate.set(kart.kart_id, d);
      }

      // Occasionally a pilot fires a held item.
      if (!stunned && this.rand() < 0.012) dirty = this.fireItem(kart.kart_id, now) || dirty;
    }

    if (this.progress.size > 0 && [...this.progress.values()].every((p) => p.finished_at !== null)) {
      this.state = 'finished';
      this.log('RACE FINISHED — results frozen');
      dirty = true;
    }
    return dirty;
  }

  private passGate(kart: KartRow, p: ProgressRow, now: number): void {
    const idx = p.next_idx;
    const tag = this.track[idx]?.tag_id ?? 0;
    let lap = p.lap;
    let nextIdx: number;
    if (idx === 0) {
      // Crossing seq 0 with every other gate already cleared completes the lap (spec §1).
      lap += 1;
      nextIdx = this.track.length > 1 ? 1 : 0;
      this.log(`${kart.name} completes lap ${lap}/${this.lapCount}`);
    } else {
      nextIdx = (idx + 1) % this.track.length;
      this.log(`${kart.name} → gate ${idx} (tag ${tag})`);
    }
    const finished = lap >= this.lapCount;
    this.progress.set(kart.kart_id, {
      ...p,
      lap,
      next_idx: nextIdx,
      last_pass_at: now,
      finished_at: finished ? now : null,
    });
    if (finished) this.log(`🏁 ${kart.name} FINISHES`);
    this.grantItem(kart, now);
    this.recomputePlacements();
  }

  private grantItem(kart: KartRow, _now: number): void {
    const inv = this.inventory.get(kart.kart_id) ?? {
      kart_id: kart.kart_id,
      slot1: null,
      slot2: null,
    };
    const item = rollItem(this.rand);
    if (inv.slot1 === null) this.inventory.set(kart.kart_id, { ...inv, slot1: item });
    else if (inv.slot2 === null) this.inventory.set(kart.kart_id, { ...inv, slot2: item });
    else {
      this.log(`${kart.name} item lost — both slots full`);
      return;
    }
    this.log(`${kart.name} picks up ${item.replace('_', ' ')}`);
  }

  private fireItem(kartId: number, now: number): boolean {
    const inv = this.inventory.get(kartId);
    if (!inv) return false;
    const slot = inv.slot1 !== null ? 1 : inv.slot2 !== null ? 2 : 0;
    if (slot === 0) return false;
    const item = slot === 1 ? inv.slot1 : inv.slot2;
    if (!item) return false;
    this.inventory.set(kartId, slot === 1 ? { ...inv, slot1: null } : { ...inv, slot2: null });

    const me = this.karts.find((k) => k.kart_id === kartId)!;
    const spec = EFFECT_SPEC[item];
    const selfTargeted = item === 'boost' || item === 'shield';
    let targetId = kartId;
    if (item === 'leader_strike') {
      targetId = this.orderedProgress()[0]?.kart_id ?? kartId;
    } else if (!selfTargeted) {
      targetId = this.karts.find((k) => k.kart_id !== kartId)?.kart_id ?? kartId;
    }
    const target = this.karts.find((k) => k.kart_id === targetId)!;

    // Shield absorbs the next incoming hit (spec §1 hit resolution).
    if (!selfTargeted) {
      const shieldIdx = this.effects.findIndex(
        (e) => e.kart_id === targetId && e.kind === 'shield',
      );
      if (shieldIdx >= 0) {
        this.effects.splice(shieldIdx, 1);
        this.log(`${target.name} SHIELD absorbs ${me.name}'s ${item.replace('_', ' ')}`);
        return true;
      }
    }

    this.effects.push({
      id: this.nextEffectId++,
      kart_id: targetId,
      kind: spec.kind,
      multiplier: spec.mult,
      expires_at: spec.ms === null ? null : now + spec.ms,
    });
    this.log(
      selfTargeted
        ? `${me.name} uses ${item.replace('_', ' ')}`
        : `${me.name} hits ${target.name} with ${item.replace('_', ' ')}`,
    );
    return true;
  }

  private orderedProgress(): ProgressRow[] {
    return [...this.progress.values()].sort(placementComparator(this.track.length));
  }

  private recomputePlacements(): void {
    this.orderedProgress().forEach((row, i) => {
      this.progress.set(row.kart_id, { ...row, placement: i + 1 });
    });
  }

  private log(text: string): void {
    this.events.push({ at: Date.now(), text });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  private snapshot(): RaceSnapshot {
    return {
      config: {
        lap_count: this.lapCount,
        item_roll_pct: 100,
        state: this.state,
        countdown_ends_at: this.countdownEndsAt,
      },
      karts: [...this.karts],
      inputs: [...this.inputs.values()],
      track: [...this.track],
      setupSeen: [...this.setupSeen],
      progress: [...this.progress.values()],
      inventory: [...this.inventory.values()],
      effects: [...this.effects],
      events: [...this.events],
    };
  }

  private emit(): void {
    this.listener?.({ type: 'snapshot', snapshot: this.snapshot() });
  }
}
