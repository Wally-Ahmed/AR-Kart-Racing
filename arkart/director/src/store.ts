/**
 * The screen's state: the last snapshot from the adapter + purely local UI state
 * (the track-order draft the director is editing, and the last action's result banner).
 */

import type { DirectorAdapter } from './adapters/adapter.ts';
import { DriveLoop, initialDriveStatus, type DriveStatus } from './drive.ts';
import { moveItem } from './placement.ts';
import { EMPTY_SNAPSHOT, type ConnectionInfo, type RaceSnapshot } from './types.ts';

export interface Toast {
  kind: 'ok' | 'err';
  text: string;
  at: number;
}

export interface UiState {
  snapshot: RaceSnapshot;
  connection: ConnectionInfo;
  /** Working copy of the gate order, seeded from `setup_seen` first-seen order (spec §2). */
  draftOrder: number[];
  /** Tags the director has struck from the draft (strays). */
  dropped: number[];
  toast: Toast | null;
  /** True while a director reducer call is in flight. */
  busy: boolean;
  /** Keyboard/gamepad drive control — `set_input` from this laptop (see `drive.ts`). */
  drive: DriveStatus;
}

export class Store {
  /**
   * The 25 Hz `set_input` sender. Constructed before `state` is read so `state.drive` can be
   * seeded from it, and never auto-armed: arming is a deliberate click or Shift+D.
   */
  private readonly driveLoop: DriveLoop;

  private state: UiState = {
    snapshot: EMPTY_SNAPSHOT,
    connection: {
      status: 'connecting',
      source: '—',
      detail: '',
      lastUpdateAt: null,
      pushes: false,
    },
    draftOrder: [],
    dropped: [],
    toast: null,
    busy: false,
    drive: initialDriveStatus(),
  };

  private subscribers = new Set<(s: UiState) => void>();

  constructor(private readonly adapter: DirectorAdapter) {
    this.state.connection.source = adapter.name;
    this.state.connection.detail = adapter.endpoint;
    this.state.connection.pushes = adapter.pushes ?? false;
    this.driveLoop = new DriveLoop(
      (kartId, throttle, steer) => adapter.setInput(kartId, throttle, steer),
      (drive) => this.patch({ drive }, true),
    );
  }

  get(): UiState {
    return this.state;
  }

  subscribe(fn: (s: UiState) => void): () => void {
    this.subscribers.add(fn);
    fn(this.state);
    return () => this.subscribers.delete(fn);
  }

  start(): void {
    this.adapter.start((ev) => {
      if (ev.type === 'snapshot') {
        this.patch({
          snapshot: ev.snapshot,
          draftOrder: this.syncDraft(ev.snapshot),
          connection: {
            ...this.state.connection,
            lastUpdateAt: Date.now(),
            pushes: this.adapter.pushes ?? false,
          },
        });
      } else {
        this.patch({
          connection: {
            ...this.state.connection,
            status: ev.status,
            source: this.adapter.name,
            detail: ev.detail,
            pushes: this.adapter.pushes ?? false,
          },
        });
      }
    });
  }

  stop(): void {
    this.driveLoop.dispose(); // parks the kart before the socket goes away
    this.adapter.stop();
  }

  // ---- drive control (set_input from this laptop) ---------------------------

  /**
   * Arming is explicit and reported as a toast, because from this moment the arrow keys move a
   * physical car. Disarming sends one zero frame (`DriveLoop.disarm`).
   */
  toggleDrive(): void {
    this.driveLoop.toggle();
    const d = this.driveLoop.get();
    this.patch({
      drive: d,
      toast: {
        kind: 'ok',
        text: d.armed
          ? `DRIVE ARMED — kart ${d.kartId} · arrows/WASD · Shift+D to disarm`
          : 'drive disarmed — throttle zeroed',
        at: Date.now(),
      },
    });
  }

  selectDriveKart(kartId: number): void {
    this.driveLoop.selectKart(kartId);
    this.patch({ drive: this.driveLoop.get() });
  }

  /** @returns true when the drive control consumed the key, so the caller can swallow it. */
  driveKeyDown(key: string): boolean {
    return this.driveLoop.keyDown(key);
  }

  driveKeyUp(key: string): boolean {
    return this.driveLoop.keyUp(key);
  }

  releaseDriveKeys(): void {
    this.driveLoop.releaseAll();
  }

  /**
   * Keep the draft in first-seen order, appending gates as the calibration lap reveals them
   * and never resurrecting ones the director dropped. Order edits by the director survive.
   */
  private syncDraft(snapshot: RaceSnapshot): number[] {
    const seen = snapshot.setupSeen.map((s) => s.tag_id);
    const dropped = new Set(this.state.dropped);
    const kept = this.state.draftOrder.filter((t) => seen.includes(t) && !dropped.has(t));
    for (const tag of seen) {
      if (!kept.includes(tag) && !dropped.has(tag)) kept.push(tag);
    }
    return kept;
  }

  // ---- local draft editing -------------------------------------------------

  moveGate(index: number, delta: number): void {
    this.patch({ draftOrder: moveItem(this.state.draftOrder, index, index + delta) });
  }

  dropGate(tagId: number): void {
    this.patch({
      draftOrder: this.state.draftOrder.filter((t) => t !== tagId),
      dropped: [...this.state.dropped, tagId],
    });
  }

  restoreAll(): void {
    this.patch({ dropped: [] }, true);
    this.patch({ draftOrder: this.syncDraft(this.state.snapshot) });
  }

  // ---- director actions ----------------------------------------------------

  beginSetup = () =>
    this.run('Begin setup', async () => {
      this.patch({ draftOrder: [], dropped: [] }, true);
      await this.adapter.beginSetup();
    });

  confirmTrack = () =>
    this.run(`Confirm track (${this.state.draftOrder.length} gates)`, () =>
      this.adapter.confirmTrack([...this.state.draftOrder]),
    );

  startRace = () => this.run('Start race', () => this.adapter.startRace());
  resetRace = () => this.run('Reset race', () => this.adapter.resetRace());
  /**
   * ABORT also disarms the drive control. Without this the kill switch would be a lie whenever
   * the laptop is piloting: `abort_race` zeroes the module's inputs, and 40 ms later the armed
   * drive loop writes the held throttle straight back.
   */
  abortRace = () =>
    this.run('ABORT', async () => {
      this.driveLoop.disarm();
      this.patch({ drive: this.driveLoop.get() }, true);
      await this.adapter.abortRace();
    });

  private async run(label: string, fn: () => Promise<void>): Promise<void> {
    this.patch({ busy: true });
    try {
      await fn();
      this.patch({ busy: false, toast: { kind: 'ok', text: `${label} ✓`, at: Date.now() } });
    } catch (err) {
      this.patch({
        busy: false,
        toast: {
          kind: 'err',
          text: `${label} failed — ${err instanceof Error ? err.message : String(err)}`,
          at: Date.now(),
        },
      });
    }
  }

  clearToast(): void {
    if (this.state.toast) this.patch({ toast: null });
  }

  private patch(next: Partial<UiState>, silent = false): void {
    this.state = { ...this.state, ...next };
    if (!silent) for (const fn of this.subscribers) fn(this.state);
  }
}
