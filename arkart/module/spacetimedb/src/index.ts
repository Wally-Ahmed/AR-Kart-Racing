/**
 * AR Kart — authoritative SpacetimeDB game server module.
 *
 * Implements docs/design/arkart-game-software-v1.md §1 (game rules), §2 (track setup),
 * §4 (tables + reducers). Every game rule lives here; nothing outside the DB decides anything.
 *
 * Naming: source is camelCase, the module's default CASE_CONVERSION_POLICY is SnakeCase, so
 * the canonical (SQL / `spacetime call`) names are snake_case:
 *   setInput  -> set_input      kartId -> kart_id      setupSeen table -> setup_seen
 */

import { schema, table, t } from 'spacetimedb/server';
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Race state machine (config.state). */
const S_SETUP = 'setup';
const S_LOBBY = 'lobby';
const S_COUNTDOWN = 'countdown';
const S_RUNNING = 'running';
const S_FINISHED = 'finished';

const MICROS = 1_000n;
const SEC = 1_000_000n;

const COUNTDOWN_MICROS = 3n * SEC;
const TICK_INTERVAL_MICROS = 100n * MICROS; // 100 ms

/** Item ids — spec §1 "Items (D2)". Stored as strings so every client speaks them over plain HTTP. */
const ITEM_BOOST = 'boost';
const ITEM_STUN = 'stun';
const ITEM_INK = 'ink';
const ITEM_DIZZY = 'dizzy';
const ITEM_LEADER_STRIKE = 'leader_strike';
const ITEM_SHIELD = 'shield';

const ALL_ITEMS = [
  ITEM_BOOST,
  ITEM_STUN,
  ITEM_INK,
  ITEM_DIZZY,
  ITEM_LEADER_STRIKE,
  ITEM_SHIELD,
];

/** Weighted roll table, spec §1 (weights sum to 100). */
const ITEM_WEIGHTS: Array<[string, number]> = [
  [ITEM_BOOST, 25],
  [ITEM_STUN, 15],
  [ITEM_INK, 15],
  [ITEM_DIZZY, 15],
  [ITEM_LEADER_STRIKE, 10],
  [ITEM_SHIELD, 20],
];

/** Effect kinds — what the car bridge enforces. */
const K_BOOST = 'boost';
const K_STUN = 'stun';
const K_INK = 'ink';
const K_DIZZY = 'dizzy';
const K_SLOW = 'slow'; // Leader Strike
const K_SHIELD = 'shield';

const BOOST_MULT = 1.4;
const BOOST_MICROS = 2n * SEC;
const STUN_MICROS = 2n * SEC;
const INK_MICROS = 4n * SEC;
const DIZZY_MICROS = 4n * SEC;
const SLOW_MULT = 0.3;
const SLOW_MICROS = 3n * SEC;
const IR_STUN_MICROS = 1_500n * MICROS; // 1.5 s — IR Tag Shot (stretch, §1)

const DEFAULT_LAP_COUNT = 3;
const DEFAULT_ITEM_ROLL_PCT = 100;
const MIN_CHECKPOINTS = 3; // spec §2 constraint

/** Demo fleet — conductor contract: kart ids 1 and 2. */
const KART_SEED: Array<[number, string, string]> = [
  [1, 'Kart 1', '192.168.8.101'],
  [2, 'Kart 2', '192.168.8.102'],
];

// ---------------------------------------------------------------------------
// Tables (spec §4)
// ---------------------------------------------------------------------------

/** Singleton race config + state machine. Always exactly one row, id = 0. */
const config = table(
  { name: 'config', public: true },
  {
    id: t.u32().primaryKey(), // always 0
    lapCount: t.u32(),
    itemRollPct: t.u32(),
    state: t.string(),
    countdownEndsAt: t.option(t.timestamp()),
  }
);

const kart = table(
  { name: 'kart', public: true },
  {
    kartId: t.u32().primaryKey(),
    name: t.string(),
    ip: t.string(),
    pilotIdentity: t.option(t.identity()),
  }
);

/** Rewritten ~25 Hz per kart by the pilot app. */
const input = table(
  { name: 'input', public: true },
  {
    kartId: t.u32().primaryKey(),
    throttle: t.f32(), // 0..1
    steer: t.f32(), // -1..1
    updatedAt: t.timestamp(),
  }
);

/** The confirmed ordered checkpoint list. seq 0 = start/finish. */
const track = table(
  { name: 'track', public: true },
  {
    seq: t.u32().primaryKey(),
    tagId: t.u32(),
  }
);

/** Scratch table filled during the calibration lap (state == setup). */
const setupSeen = table(
  { name: 'setup_seen', public: true },
  {
    tagId: t.u32().primaryKey(),
    firstSeenAt: t.timestamp(),
    seenIdx: t.u32(), // first-seen order, 0-based
  }
);

const progress = table(
  { name: 'progress', public: true },
  {
    kartId: t.u32().primaryKey(),
    lap: t.u32(),
    nextIdx: t.u32(), // index into `track` of the next expected checkpoint
    lastPassAt: t.timestamp(),
    placement: t.u32(), // 1 = leader
    finishedAt: t.option(t.timestamp()),
  }
);

/** Max 2 slots by construction (spec §1). */
const inventory = table(
  { name: 'inventory', public: true },
  {
    kartId: t.u32().primaryKey(),
    // `.name()` pins the canonical column name: the module's SnakeCase policy would
    // otherwise publish these as `slot_1` / `slot_2`, and spec §4 says slot1 / slot2.
    slot1: t.option(t.string()).name('slot1'),
    slot2: t.option(t.string()).name('slot2'),
  }
);

/** Live effects. `expiresAt` unset == shield (consumed on hit, never by time). */
const effect = table(
  { name: 'effect', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kartId: t.u32().index('btree'),
    kind: t.string(),
    multiplier: t.f32(),
    expiresAt: t.option(t.timestamp()),
    sourceKart: t.u32(), // 0 == system/self
  }
);

/** Director-screen ticker. */
const eventLog = table(
  { name: 'event_log', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    text: t.string(),
  }
);

/** ~100 ms heartbeat: expires effects, drives the countdown -> running transition. */
const tickTimer = table(
  {
    name: 'tick_timer',
    scheduled: (): any => tick,
  },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  }
);

const spacetimedb = schema({
  config,
  kart,
  input,
  track,
  setupSeen,
  progress,
  inventory,
  effect,
  eventLog,
  tickTimer,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(ctx: Ctx, text: string): void {
  ctx.db.eventLog.insert({ id: 0n, at: ctx.timestamp, text });
}

function cfg(ctx: Ctx) {
  const row = ctx.db.config.id.find(0);
  if (!row) throw new Error('config row missing — module not initialized');
  return row;
}

function setState(ctx: Ctx, state: string, countdownEndsAt?: Timestamp): void {
  const c = cfg(ctx);
  ctx.db.config.id.update({ ...c, state, countdownEndsAt });
}

function at(ctx: Ctx, deltaMicros: bigint): Timestamp {
  return new Timestamp(ctx.timestamp.microsSinceUnixEpoch + deltaMicros);
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function trackLength(ctx: Ctx): number {
  return [...ctx.db.track.iter()].length;
}

function tagAtSeq(ctx: Ctx, seq: number): number | null {
  const row = ctx.db.track.seq.find(seq);
  return row ? row.tagId : null;
}

/** Every live effect row for a kart. */
function effectsOf(ctx: Ctx, kartId: number) {
  return [...ctx.db.effect.kartId.filter(kartId)];
}

/** Clear all effect rows (race reset / abort). */
function clearEffects(ctx: Ctx): void {
  for (const e of [...ctx.db.effect.iter()]) ctx.db.effect.id.delete(e.id);
}

function clearInventories(ctx: Ctx): void {
  for (const inv of [...ctx.db.inventory.iter()]) {
    ctx.db.inventory.kartId.update({ ...inv, slot1: undefined, slot2: undefined });
  }
}

/**
 * Progress-within-the-lap used for ordering.
 *
 * `nextIdx` wraps back to 0 after the last checkpoint is cleared, so the literal
 * "next_idx DESC" of spec §1 would rank the kart closest to the finish line LAST.
 * We rank on checkpoints-cleared-this-lap instead, which is identical to next_idx
 * everywhere except that wrap. (Documented deviation; see README.)
 */
function lapProgress(nextIdx: number, len: number): number {
  return nextIdx === 0 ? len : nextIdx;
}

/** Recompute `placement` for every kart: lap DESC, lap-progress DESC, last_pass_at ASC. */
function recomputePlacements(ctx: Ctx): void {
  const len = trackLength(ctx);
  const rows = [...ctx.db.progress.iter()];
  rows.sort((a, b) => {
    if (a.lap !== b.lap) return b.lap - a.lap;
    const pa = lapProgress(a.nextIdx, len);
    const pb = lapProgress(b.nextIdx, len);
    if (pa !== pb) return pb - pa;
    const ta = a.lastPassAt.microsSinceUnixEpoch;
    const tb = b.lastPassAt.microsSinceUnixEpoch;
    if (ta !== tb) return ta < tb ? -1 : 1; // earlier wins ties
    return a.kartId - b.kartId;
  });
  rows.forEach((r, i) => {
    const placement = i + 1;
    if (r.placement !== placement) {
      ctx.db.progress.kartId.update({ ...r, placement });
    }
  });
}

/** Karts ordered by current placement (1 first). */
function byPlacement(ctx: Ctx) {
  return [...ctx.db.progress.iter()].sort((a, b) => a.placement - b.placement);
}

/**
 * Rival target (spec §1): the kart one placement AHEAD; the leader targets the kart behind.
 * Returns null in a solo race.
 */
function rivalOf(ctx: Ctx, shooter: number): number | null {
  const order = byPlacement(ctx);
  if (order.length < 2) return null;
  const i = order.findIndex(p => p.kartId === shooter);
  if (i < 0) return null;
  return i === 0 ? order[1].kartId : order[i - 1].kartId;
}

/**
 * Leader Strike target: whoever is in 1st place. If the shooter IS the leader we fall back to
 * the kart behind, mirroring the spec's own "the leader targets the kart behind instead" rule.
 */
function leaderTarget(ctx: Ctx, shooter: number): number | null {
  const order = byPlacement(ctx);
  if (order.length === 0) return null;
  const leader = order[0];
  if (leader.kartId !== shooter) return leader.kartId;
  return order.length > 1 ? order[1].kartId : null;
}

/** Consume an active shield if present. Returns true when the hit was absorbed. */
function consumeShield(ctx: Ctx, victim: number): boolean {
  for (const e of effectsOf(ctx, victim)) {
    if (e.kind === K_SHIELD) {
      ctx.db.effect.id.delete(e.id);
      return true;
    }
  }
  return false;
}

function insertEffect(
  ctx: Ctx,
  kartId: number,
  kind: string,
  multiplier: number,
  durationMicros: bigint | null,
  sourceKart: number
): void {
  ctx.db.effect.insert({
    id: 0n,
    kartId,
    kind,
    multiplier,
    expiresAt: durationMicros === null ? undefined : at(ctx, durationMicros),
    sourceKart,
  });
}

/**
 * Single entry point for every offensive hit (items AND the IR Tag Shot), so the
 * shield-check-then-effect rule is literally the same code path (spec §4 report_hit).
 */
function applyOffensive(
  ctx: Ctx,
  shooter: number,
  victim: number,
  kind: string,
  multiplier: number,
  durationMicros: bigint,
  label: string
): void {
  if (consumeShield(ctx, victim)) {
    log(ctx, `Kart ${victim} SHIELD absorbed ${label} from kart ${shooter}`);
    return;
  }
  insertEffect(ctx, victim, kind, multiplier, durationMicros, shooter);
  log(ctx, `Kart ${shooter} hit kart ${victim} with ${label}`);
}

function rollItem(ctx: Ctx): string {
  const total = ITEM_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let roll = ctx.random.integerInRange(1, total);
  for (const [item, w] of ITEM_WEIGHTS) {
    roll -= w;
    if (roll <= 0) return item;
  }
  return ITEM_BOOST;
}

/** Put an item into a free slot. Both full -> the grant is lost (spec §1). */
function grantItem(ctx: Ctx, kartId: number, item: string): boolean {
  const inv = ctx.db.inventory.kartId.find(kartId);
  if (!inv) return false;
  if (inv.slot1 == null) {
    ctx.db.inventory.kartId.update({ ...inv, slot1: item });
    return true;
  }
  if (inv.slot2 == null) {
    ctx.db.inventory.kartId.update({ ...inv, slot2: item });
    return true;
  }
  return false;
}

function seedKart(ctx: Ctx, kartId: number, name: string, ip: string): void {
  if (!ctx.db.kart.kartId.find(kartId)) {
    ctx.db.kart.insert({ kartId, name, ip, pilotIdentity: undefined });
  }
  if (!ctx.db.input.kartId.find(kartId)) {
    ctx.db.input.insert({ kartId, throttle: 0, steer: 0, updatedAt: ctx.timestamp });
  }
  if (!ctx.db.progress.kartId.find(kartId)) {
    ctx.db.progress.insert({
      kartId,
      lap: 0,
      nextIdx: 0,
      lastPassAt: ctx.timestamp,
      placement: kartId,
      finishedAt: undefined,
    });
  }
  if (!ctx.db.inventory.kartId.find(kartId)) {
    ctx.db.inventory.insert({ kartId, slot1: undefined, slot2: undefined });
  }
}

/** Put every kart back on the start line. Karts start ON gate 0, so next expected is seq 1. */
function resetProgress(ctx: Ctx): void {
  const len = trackLength(ctx);
  const startIdx = len > 1 ? 1 : 0;
  for (const p of [...ctx.db.progress.iter()]) {
    ctx.db.progress.kartId.update({
      ...p,
      lap: 0,
      nextIdx: startIdx,
      lastPassAt: ctx.timestamp,
      placement: p.kartId,
      finishedAt: undefined,
    });
  }
  clearInventories(ctx);
  clearEffects(ctx);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const init = spacetimedb.init(ctx => {
  if (!ctx.db.config.id.find(0)) {
    ctx.db.config.insert({
      id: 0,
      lapCount: DEFAULT_LAP_COUNT,
      itemRollPct: DEFAULT_ITEM_ROLL_PCT,
      state: S_SETUP,
      countdownEndsAt: undefined,
    });
  }
  for (const [id, name, ip] of KART_SEED) seedKart(ctx, id, name, ip);

  if ([...ctx.db.tickTimer.iter()].length === 0) {
    ctx.db.tickTimer.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.interval(TICK_INTERVAL_MICROS),
    });
  }
  log(ctx, 'arkart module initialized');
});

export const onConnect = spacetimedb.clientConnected(_ctx => {});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

// ---------------------------------------------------------------------------
// Reducers — control path (spec §4)
// ---------------------------------------------------------------------------

/**
 * set_input — called ~25 Hz per phone. Stored in EVERY race state without error;
 * the car bridge is what zeroes throttle while state != running (spec §5).
 */
export const setInput = spacetimedb.reducer(
  { kartId: t.u32(), throttle: t.f32(), steer: t.f32() },
  (ctx, { kartId, throttle, steer }) => {
    const thr = clamp(throttle, 0, 1);
    const str = clamp(steer, -1, 1);
    const row = ctx.db.input.kartId.find(kartId);
    if (row) {
      ctx.db.input.kartId.update({ ...row, throttle: thr, steer: str, updatedAt: ctx.timestamp });
    } else {
      ctx.db.input.insert({ kartId, throttle: thr, steer: str, updatedAt: ctx.timestamp });
    }
  }
);

/**
 * report_gate — the vision bridge's only call. Behaviour branches on config.state:
 *   setup   : append first-seen tag to setup_seen
 *   running : advance the kart IFF this is its expected next checkpoint
 *   else    : ignored
 */
export const reportGate = spacetimedb.reducer(
  { kartId: t.u32(), tagId: t.u32() },
  (ctx, { kartId, tagId }) => {
    const c = cfg(ctx);

    if (c.state === S_SETUP) {
      if (!ctx.db.setupSeen.tagId.find(tagId)) {
        const seenIdx = [...ctx.db.setupSeen.iter()].length;
        ctx.db.setupSeen.insert({ tagId, firstSeenAt: ctx.timestamp, seenIdx });
        log(ctx, `Setup: gate ${tagId} seen (#${seenIdx})`);
      }
      return;
    }

    if (c.state !== S_RUNNING) return;

    const p = ctx.db.progress.kartId.find(kartId);
    if (!p || p.finishedAt != null) return;

    const len = trackLength(ctx);
    if (len === 0) return;

    const expected = tagAtSeq(ctx, p.nextIdx);
    if (expected === null || expected !== tagId) return; // wrong gate: no shortcutting

    // Advance.
    let lap = p.lap;
    const nextIdx = (p.nextIdx + 1) % len;
    if (p.nextIdx === 0) {
      lap = p.lap + 1; // crossing start/finish completes a lap
    }

    let finishedAt: Timestamp | undefined = undefined;
    const finishing = lap >= c.lapCount;
    if (finishing) finishedAt = ctx.timestamp;

    ctx.db.progress.kartId.update({
      ...p,
      lap,
      nextIdx,
      lastPassAt: ctx.timestamp,
      finishedAt,
    });

    // Power-up grant on EVERY valid checkpoint pass (spec §1).
    if (!finishing) {
      const pct = c.itemRollPct;
      if (pct > 0 && ctx.random.integerInRange(1, 100) <= pct) {
        const item = rollItem(ctx);
        if (grantItem(ctx, kartId, item)) {
          log(ctx, `Kart ${kartId} picked up ${item} at gate ${tagId}`);
        } else {
          log(ctx, `Kart ${kartId} lost a ${item} at gate ${tagId} (inventory full)`);
        }
      }
    }

    recomputePlacements(ctx);

    if (finishing) {
      const place = ctx.db.progress.kartId.find(kartId)?.placement ?? 1;
      log(ctx, `Kart ${kartId} FINISHED (${c.lapCount} laps) in P${place}`);
      setState(ctx, S_FINISHED);
      clearEffects(ctx);
    } else {
      log(ctx, `Kart ${kartId} passed gate ${tagId} (lap ${lap}, next idx ${nextIdx})`);
    }
  }
);

/** use_item — pop the slot, resolve target from live placements, apply through the shield gate. */
export const useItem = spacetimedb.reducer(
  { kartId: t.u32(), slot: t.u32() },
  (ctx, { kartId, slot }) => {
    const c = cfg(ctx);
    if (c.state !== S_RUNNING) return;

    const inv = ctx.db.inventory.kartId.find(kartId);
    if (!inv) return;

    const item = slot === 1 ? inv.slot1 : slot === 2 ? inv.slot2 : undefined;
    if (item == null) return;

    // Pop first: an item is spent whether or not it finds a target.
    if (slot === 1) {
      ctx.db.inventory.kartId.update({ ...inv, slot1: undefined });
    } else {
      ctx.db.inventory.kartId.update({ ...inv, slot2: undefined });
    }

    switch (item) {
      case ITEM_BOOST:
        insertEffect(ctx, kartId, K_BOOST, BOOST_MULT, BOOST_MICROS, kartId);
        log(ctx, `Kart ${kartId} used BOOST`);
        return;

      case ITEM_SHIELD:
        // Refresh rather than stack: one shield at a time.
        for (const e of effectsOf(ctx, kartId)) {
          if (e.kind === K_SHIELD) ctx.db.effect.id.delete(e.id);
        }
        insertEffect(ctx, kartId, K_SHIELD, 1.0, null, kartId);
        log(ctx, `Kart ${kartId} raised SHIELD`);
        return;

      case ITEM_STUN: {
        const v = rivalOf(ctx, kartId);
        if (v === null) return;
        applyOffensive(ctx, kartId, v, K_STUN, 0.0, STUN_MICROS, 'STUN');
        return;
      }

      case ITEM_INK: {
        const v = rivalOf(ctx, kartId);
        if (v === null) return;
        applyOffensive(ctx, kartId, v, K_INK, 1.0, INK_MICROS, 'INK');
        return;
      }

      case ITEM_DIZZY: {
        const v = rivalOf(ctx, kartId);
        if (v === null) return;
        applyOffensive(ctx, kartId, v, K_DIZZY, 1.0, DIZZY_MICROS, 'DIZZY');
        return;
      }

      case ITEM_LEADER_STRIKE: {
        const v = leaderTarget(ctx, kartId);
        if (v === null) return;
        applyOffensive(ctx, kartId, v, K_SLOW, SLOW_MULT, SLOW_MICROS, 'LEADER STRIKE');
        return;
      }

      default:
        log(ctx, `Kart ${kartId} used unknown item ${item}`);
        return;
    }
  }
);

/** report_hit — IR Tag Shot (stretch). Same shield-check-then-effect path as every item. */
export const reportHit = spacetimedb.reducer(
  { shooter: t.u32(), victim: t.u32() },
  (ctx, { shooter, victim }) => {
    const c = cfg(ctx);
    if (c.state !== S_RUNNING) return;
    if (shooter === victim) return;
    if (!ctx.db.progress.kartId.find(victim)) return;
    applyOffensive(ctx, shooter, victim, K_STUN, 0.0, IR_STUN_MICROS, 'IR TAG SHOT');
  }
);

// ---------------------------------------------------------------------------
// Reducers — track setup (spec §2) and race control
// ---------------------------------------------------------------------------

/** begin_setup — director. Enter the calibration phase and clear the scratch list. */
export const beginSetup = spacetimedb.reducer(ctx => {
  for (const row of [...ctx.db.setupSeen.iter()]) ctx.db.setupSeen.tagId.delete(row.tagId);
  clearEffects(ctx);
  setState(ctx, S_SETUP);
  log(ctx, 'Setup started — drive the calibration lap');
});

/**
 * confirm_track — director. Validates, writes `track`, transitions setup -> lobby.
 * An empty list means "use the calibration order in setup_seen" (the primary path);
 * a non-empty list is the manual / drag-reordered path.
 */
export const confirmTrack = spacetimedb.reducer(
  { orderedTagIds: t.array(t.u32()) },
  (ctx, { orderedTagIds }) => {
    let tags = [...orderedTagIds];
    if (tags.length === 0) {
      tags = [...ctx.db.setupSeen.iter()]
        .sort((a, b) => a.seenIdx - b.seenIdx)
        .map(r => r.tagId);
    }

    if (tags.length < MIN_CHECKPOINTS) {
      throw new Error(`track needs at least ${MIN_CHECKPOINTS} checkpoints, got ${tags.length}`);
    }
    const seen = new Set<number>();
    for (const tag of tags) {
      if (seen.has(tag)) throw new Error(`duplicate tag ${tag} in track`);
      seen.add(tag);
    }

    for (const row of [...ctx.db.track.iter()]) ctx.db.track.seq.delete(row.seq);
    tags.forEach((tagId, seq) => ctx.db.track.insert({ seq, tagId }));

    resetProgress(ctx);
    recomputePlacements(ctx);
    setState(ctx, S_LOBBY);
    log(ctx, `Track confirmed: ${tags.length} gates [${tags.join(', ')}] (seq 0 = start/finish)`);
  }
);

/** start_race — lobby -> countdown. `tick` promotes countdown -> running. */
export const startRace = spacetimedb.reducer(ctx => {
  const c = cfg(ctx);
  if (trackLength(ctx) < MIN_CHECKPOINTS) throw new Error('no confirmed track — run setup first');
  if (c.state === S_RUNNING || c.state === S_COUNTDOWN) return;

  resetProgress(ctx);
  recomputePlacements(ctx);
  setState(ctx, S_COUNTDOWN, at(ctx, COUNTDOWN_MICROS));
  log(ctx, 'Countdown!');
});

/** reset_race — back to lobby with a clean slate, track preserved (spec §2). */
export const resetRace = spacetimedb.reducer(ctx => {
  resetProgress(ctx);
  recomputePlacements(ctx);
  setState(ctx, S_LOBBY);
  log(ctx, 'Race reset');
});

/** abort_race — THE KILL SWITCH. state != running makes the bridge zero throttle instantly. */
export const abortRace = spacetimedb.reducer(ctx => {
  clearEffects(ctx);
  setState(ctx, S_LOBBY);
  log(ctx, 'RACE ABORTED — karts disarmed');
});

/** tick — ~100 ms. Expires effects and closes the countdown. */
export const tick = spacetimedb.reducer(
  { timer: tickTimer.rowType },
  (ctx, _args) => {
    const now = ctx.timestamp.microsSinceUnixEpoch;

    for (const e of [...ctx.db.effect.iter()]) {
      if (e.expiresAt != null && e.expiresAt.microsSinceUnixEpoch <= now) {
        ctx.db.effect.id.delete(e.id);
      }
    }

    const c = cfg(ctx);
    if (c.state === S_COUNTDOWN) {
      if (c.countdownEndsAt == null || c.countdownEndsAt.microsSinceUnixEpoch <= now) {
        setState(ctx, S_RUNNING);
        log(ctx, 'GO!');
      }
    }
  }
);

// ---------------------------------------------------------------------------
// Operator / demo helpers (not in spec §4 — additive, used by the bridge + smoke test)
// ---------------------------------------------------------------------------

/** set_kart — point the car bridge at a kart's real LAN address. */
export const setKart = spacetimedb.reducer(
  { kartId: t.u32(), name: t.string(), ip: t.string() },
  (ctx, { kartId, name, ip }) => {
    const row = ctx.db.kart.kartId.find(kartId);
    if (row) {
      ctx.db.kart.kartId.update({ ...row, name, ip });
    } else {
      seedKart(ctx, kartId, name, ip);
      const created = ctx.db.kart.kartId.find(kartId);
      if (created) ctx.db.kart.kartId.update({ ...created, name, ip });
    }
    log(ctx, `Kart ${kartId} configured as ${name} @ ${ip}`);
  }
);

/** set_config — tune laps / item roll chance between races. */
export const setConfig = spacetimedb.reducer(
  { lapCount: t.u32(), itemRollPct: t.u32() },
  (ctx, { lapCount, itemRollPct }) => {
    const c = cfg(ctx);
    ctx.db.config.id.update({
      ...c,
      lapCount: lapCount < 1 ? 1 : lapCount,
      itemRollPct: itemRollPct > 100 ? 100 : itemRollPct,
    });
    log(ctx, `Config: ${lapCount} laps, item roll ${itemRollPct}%`);
  }
);

/** debug_grant — deterministically place a known item in a free slot (smoke test + stage demos). */
export const debugGrant = spacetimedb.reducer(
  { kartId: t.u32(), item: t.string() },
  (ctx, { kartId, item }) => {
    if (!ALL_ITEMS.includes(item)) throw new Error(`unknown item ${item}`);
    const ok = grantItem(ctx, kartId, item);
    log(ctx, ok ? `DEBUG granted ${item} to kart ${kartId}` : `DEBUG grant lost (full): ${item}`);
  }
);
