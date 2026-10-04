/**
 * Bootstrap: pick an adapter, wire the store to the renderer, delegate clicks.
 *
 * Adapter choice (URL flag, no rebuild needed):
 *   /                       → sdk, auto-falling back to http when bindings are missing
 *   /?adapter=sdk           → force WebSocket subscriptions (needs src/module_bindings/)
 *   /?adapter=http          → force HTTP reducer calls + SQL polling (works without bindings)
 *   /?adapter=mock          → simulated race, no server at all
 *   /?uri=ws://192.168.8.1:3000&module=arkart   → re-point at the venue laptop
 */

import './styles.css';
import { readUrlConfig } from './adapters/adapter.ts';
import { makeAdapter } from './adapters/factory.ts';
import { Store } from './store.ts';
import { render } from './ui/render.ts';

const { adapter: choice, config } = readUrlConfig(window.location.search);

const store = new Store(makeAdapter(choice, config));
const root = document.getElementById('app');
if (!root) throw new Error('#app missing from index.html');

/**
 * Swap the whole view in one shot. Every dynamic value the renderer emits is HTML-escaped at
 * the source (`esc()` in ui/render.ts) and the only inputs are our own module's rows, so the
 * markup is ours end to end; parsing it into a fragment and replacing the children keeps the
 * swap atomic (no half-painted frame) and leaves the container element itself untouched.
 */
function mount(html: string): void {
  const fragment = document.createRange().createContextualFragment(html);
  root!.replaceChildren(fragment);
}

let dirty = true;
store.subscribe(() => {
  dirty = true;
});

/**
 * Repaint at ~10 Hz. Effect countdowns, the countdown overlay and the clock are all time-based,
 * so the screen repaints on a timer rather than only on data change — trivial for a page this
 * size, and it keeps the countdown bars smooth. Data arrivals repaint sooner via `dirty`.
 */
function paint(): void {
  const now = Date.now();
  const state = store.get();
  if (state.toast && now - state.toast.at > 4000) store.clearToast();
  mount(render(store.get(), now));
  dirty = false;
}

setInterval(paint, 100);
setInterval(() => {
  if (dirty) paint();
}, 25);
paint();

root.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'abort':
      void store.abortRace();
      break;
    case 'begin-setup':
      void store.beginSetup();
      break;
    case 'confirm-track':
      void store.confirmTrack();
      break;
    case 'start-race':
      void store.startRace();
      break;
    case 'reset-race':
      void store.resetRace();
      break;
    case 'gate-up':
      store.moveGate(Number(el.dataset.index), -1);
      break;
    case 'gate-down':
      store.moveGate(Number(el.dataset.index), +1);
      break;
    case 'gate-drop':
      store.dropGate(Number(el.dataset.tag));
      break;
    case 'restore':
      store.restoreAll();
      break;
    case 'drive-toggle':
      store.toggleDrive();
      break;
    case 'drive-kart':
      store.selectDriveKart(Number(el.dataset.kart));
      break;
    default:
      break;
  }
  paint();
});

/**
 * Keyboard bindings — deliberately few, and every one of them modal or modifier-guarded:
 *
 *   Shift+Esc  ABORT (kills throttle on every kart, and disarms the drive control)
 *   Shift+D    arm / disarm the drive control
 *   ↑ ↓ ← → / WASD   drive the selected kart — ONLY while armed
 *
 * No race-flow reducer is keyboard-bound, so no stray keypress can start or reset a race, and
 * the drive keys are inert until the director arms them explicitly. ABORT is checked first so it
 * can never be shadowed by the drive control.
 */
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && ev.shiftKey) {
    ev.preventDefault();
    void store.abortRace();
    return;
  }
  if (ev.shiftKey && (ev.key === 'D' || ev.key === 'd')) {
    ev.preventDefault();
    store.toggleDrive();
    paint();
    return;
  }
  // A held arrow key autorepeats; the drive loop only needs the first one.
  if (ev.repeat) return;
  if (store.driveKeyDown(ev.key)) {
    ev.preventDefault(); // stop the arrows scrolling the standings out from under the judges
    paint();
  }
});

window.addEventListener('keyup', (ev) => {
  if (store.driveKeyUp(ev.key)) {
    ev.preventDefault();
    paint();
  }
});

// A key-up that lands in another window never reaches us, so a held throttle would stick.
// Both of these release every key; the loop stays armed, it just goes neutral.
window.addEventListener('blur', () => store.releaseDriveKeys());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) store.releaseDriveKeys();
});

store.start();
window.addEventListener('beforeunload', () => store.stop());
