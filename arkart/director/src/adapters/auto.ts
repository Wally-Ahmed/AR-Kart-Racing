/**
 * Auto adapter — the default. Tries the real SDK subscription path first and silently falls back
 * to the HTTP polling path if the generated bindings are not there yet (or the socket refuses).
 *
 * Why: the WebSocket path is the sponsor-demo showpiece, but it needs `src/module_bindings/`,
 * which only exists after `spacetime generate`. The HTTP path needs nothing and is already
 * verified against the live module. This keeps the plain URL working in both worlds — the header
 * always shows which transport actually won.
 */

import type { AdapterConfig, AdapterEvent, AdapterListener, DirectorAdapter } from './adapter.ts';
import { HttpAdapter } from './http.ts';
import { SdkAdapter } from './sdk.ts';

export class AutoAdapter implements DirectorAdapter {
  private active: DirectorAdapter;
  private listener: AdapterListener | null = null;
  private fellBack = false;

  constructor(private readonly cfg: AdapterConfig) {
    this.active = new SdkAdapter(cfg);
  }

  get name(): string {
    return this.fellBack ? 'http*' : this.active.name;
  }

  get endpoint(): string {
    return this.active.endpoint;
  }

  get pushes(): boolean {
    return this.active.pushes ?? false;
  }

  start(listener: AdapterListener): void {
    this.listener = listener;
    this.active.start((ev) => this.onEvent(ev));
  }

  stop(): void {
    this.active.stop();
    this.listener = null;
  }

  beginSetup = () => this.active.beginSetup();
  confirmTrack = (ordered: number[]) => this.active.confirmTrack(ordered);
  startRace = () => this.active.startRace();
  resetRace = () => this.active.resetRace();
  abortRace = () => this.active.abortRace();
  // Read `this.active` at call time, not at construction: the drive loop keeps calling this 25×
  // a second across a fallback, and must follow the transport that actually won.
  setInput = (kartId: number, throttle: number, steer: number) =>
    this.active.setInput(kartId, throttle, steer);

  private onEvent(ev: AdapterEvent): void {
    if (!this.fellBack && ev.type === 'status' && ev.status === 'offline') {
      this.fellBack = true;
      this.active.stop();
      this.active = new HttpAdapter(this.cfg);
      this.listener?.({
        type: 'status',
        status: 'connecting',
        detail: `no websocket bindings — falling back to HTTP polling`,
      });
      this.active.start((e) => this.listener?.(e));
      return;
    }
    this.listener?.(ev);
  }
}
