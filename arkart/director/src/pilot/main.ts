/**
 * AR Kart — phone web pilot (spec §8, web replacement for D3's native iOS app).
 *
 * One phone, one kart, one page. It opens on the laptop's own `arkart` AP:
 *
 *     http://<laptop-ip>:5173/pilot.html?kart=1
 *
 * and drives through **exactly** the path the director laptop uses — `DriveLoop` → the adapter →
 * the `set_input` reducer at 25 Hz (spec §1 D1). Nothing about the control chain is special-cased
 * for a thumb: the touch pads produce the same `DriveVector` the arrow keys and a gamepad do, and
 * the 25 Hz write doubles as the keep-alive the car bridge's 300 ms staleness watchdog watches for.
 *
 * URL flags (same as the director, plus two of our own):
 *   ?kart=N        claim kart N on load, skipping the picker
 *   ?novideo=1     don't attach the MJPEG stream (bench use, or a pilot on a flaky link)
 *   ?adapter=mock|http|sdk   ?uri=ws://192.168.8.1:3000   ?module=arkart   ?poll=200
 *
 * SAFETY, in the order a pilot meets it:
 *   1. **Claim before anything.** No kart selected → no loop, no pads, nothing can be sent.
 *   2. **Explicit ARM.** Until armed the pads are inert and no `set_input` is written at all.
 *   3. **DISARM is one tap** and sends an explicit zero frame (`DriveLoop.disarm`).
 *   4. **ABORT is HOLD-to-fire** (650 ms) — see `ABORT_HOLD_MS`.
 *   5. **Brake outranks throttle** (`vectorFromTouch`), and blur / tab-hide / lock releases every
 *      thumb (`DriveLoop.releaseAll`) so a `pointerup` eaten by the app switcher cannot stick a
 *      throttle open.
 */

import './pilot.css';
import { readUrlConfig } from '../adapters/adapter.ts';
import { makeAdapter } from '../adapters/factory.ts';
import { DriveLoop, initialDriveStatus, NEUTRAL, type DriveStatus } from '../drive.ts';
import {
  NEUTRAL_TOUCH,
  parseKartParam,
  steerFromPointer,
  streamUrl,
  throttleDrag,
  vectorFromTouch,
  type PadRect,
  type TouchState,
} from './touch.ts';
import {
  EMPTY_SNAPSHOT,
  type ConnectionStatus,
  type KartRow,
  type RaceSnapshot,
} from '../types.ts';

/**
 * How long ABORT must be held.
 *
 * **HOLD, not double-tap** — the documented choice. ABORT is race-wide (`abort_race` zeroes every
 * kart's throttle and drops the race to lobby), so one pilot's pocket must not be able to fire it:
 * a phone being jostled, or a palm landing on the glass, produces taps and double-taps all day,
 * but it does not produce 650 ms of continuous pressure on one 86 px target. The fill bar makes the
 * gesture discoverable without a legend, and releasing early cancels with no side effect.
 *
 * The pilot's own emergency stop is DISARM, which is a single tap and instant — ABORT's hold only
 * gates the button that also stops everyone else's car.
 */
const ABORT_HOLD_MS = 650;

/** FPV is declared dead if no frame has decoded in this long; the retry button re-attaches. */
const FPV_TIMEOUT_MS = 6000;

const { adapter: choice, config } = readUrlConfig(window.location.search);
const query = new URLSearchParams(window.location.search);
const videoWanted = query.get('novideo') !== '1';

const adapter = makeAdapter(choice, config);

const root = document.getElementById('pilot');
if (!root) throw new Error('#pilot missing from pilot.html');

let snapshot: RaceSnapshot = EMPTY_SNAPSHOT;
let connection: { status: ConnectionStatus; detail: string } = {
  status: 'connecting',
  detail: adapter.endpoint,
};
let claimed: number | null = parseKartParam(window.location.search);
let drive: DriveStatus = initialDriveStatus(claimed ?? 1);
let loop: DriveLoop | null = null;

adapter.start((ev) => {
  if (ev.type === 'snapshot') snapshot = ev.snapshot;
  else connection = { status: ev.status, detail: ev.detail };
});

// ---------------------------------------------------------------- tiny DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The whole page is built with `createElement` + `textContent` — no HTML strings anywhere, so the
 * kart names and error texts coming out of the module can never be markup, and the 10 Hz HUD
 * refresh mutates a handful of text nodes instead of reparsing a document fragment under a thumb.
 */

// ---------------------------------------------------------------- claim screen

function kartLabel(k: KartRow): string {
  return k.name?.trim() ? k.name : `Kart ${k.kart_id}`;
}

function showClaim(): void {
  const wrap = el('div', 'claim');
  wrap.append(el('h1', undefined, 'AR Kart — pilot'));
  wrap.append(
    el(
      'p',
      undefined,
      'Pick your kart. One phone, one kart — take the one with your car’s colour on it.',
    ),
  );

  const list = el('div', 'claim-list');
  const empty = el('p', undefined, 'waiting for the module’s kart list…');
  const manualRow = el('div', 'claim-list');
  const manual = el('input');
  manual.type = 'number';
  manual.min = '1';
  manual.value = '1';
  manual.className = 'claim-kart';
  manual.setAttribute('aria-label', 'kart number');
  manual.style.flex = '0 0 96px';
  const manualGo = el('button', 'claim-kart', 'Claim by number');
  manualGo.setAttribute('data-test', 'claim-manual');
  manualGo.addEventListener('click', () => {
    const n = Number(manual.value);
    if (Number.isInteger(n) && n > 0) claim(n);
  });
  manualRow.append(manual, manualGo);

  wrap.append(list, empty, el('p', undefined, 'Not listed? Claim it by number:'), manualRow);
  root!.replaceChildren(wrap);

  // The kart table arrives with the first snapshot, which may be a poll interval away.
  const paint = (): void => {
    if (!document.body.contains(wrap)) {
      clearInterval(timer);
      return;
    }
    const karts = snapshot.karts;
    empty.style.display = karts.length ? 'none' : 'block';
    if (list.childElementCount !== karts.length) {
      list.replaceChildren();
      for (const k of karts) {
        const btn = el('button', 'claim-kart');
        btn.setAttribute('data-test', `claim-${k.kart_id}`);
        btn.append(el('b', undefined, kartLabel(k)));
        btn.append(el('span', undefined, `#${k.kart_id} · ${k.ip || 'no ip'}`));
        if (k.pilot_identity) btn.classList.add('taken');
        btn.addEventListener('click', () => claim(k.kart_id));
        list.append(btn);
      }
    }
  };
  const timer = setInterval(paint, 400);
  paint();
}

/**
 * Claiming is CLIENT-SIDE selection (server-side exclusivity is out of scope for this tier): the
 * kart id goes into the URL so a reload, or the phone's own crash-and-reopen, lands on the same car
 * instead of back on the picker.
 */
function claim(kartId: number): void {
  claimed = kartId;
  query.set('kart', String(kartId));
  history.replaceState(null, '', `${window.location.pathname}?${query.toString()}`);
  showCockpit(kartId);
}

// ---------------------------------------------------------------- cockpit

function showCockpit(kartId: number): void {
  const touch: TouchState = { ...NEUTRAL_TOUCH };

  loop = new DriveLoop(
    (id, throttle, steer) => adapter.setInput(id, throttle, steer),
    (s) => {
      drive = s;
    },
  );
  loop.selectKart(kartId);
  // Declares "this page drives by thumb", so the HUD source stays `touch` between gestures.
  loop.setTouch(NEUTRAL);

  const pushTouch = (): void => {
    loop?.setTouch(vectorFromTouch(touch));
  };

  // ---- structure

  const stage = el('div', 'stage');

  const fpv = el('div', 'fpv');
  const img = el('img');
  img.alt = 'kart FPV';
  img.decoding = 'async';
  fpv.append(img);

  const fallback = el('div', 'fpv-fallback');
  const fallbackUrl = el('code');
  fallback.append(
    el('strong', undefined, 'no video'),
    fallbackUrl,
    el('em', undefined, 'the kart drives fine without it — the pads still work'),
  );
  const retry = el('button', 'btn-retry hide');
  retry.setAttribute('data-test', 'fpv-retry');
  retry.append(el('span', undefined, '⟳ VID'));

  const topbar = el('div', 'topbar');
  const hud = el('div', 'hud');
  const chipKart = el('div', 'chip kart');
  const chipState = el('div', 'chip state');
  const chipArm = el('div', 'chip disarmed');
  const chipPos = el('div', 'chip');
  const chipTele = el('div', 'chip tele-chip');
  const tele = el('div', 'tele');
  const telThr = el('b', 'v-thr', '0.00');
  const telStr = el('b', 'v-str', '+0.00');
  tele.append(el('span', undefined, 'THR'), telThr, el('span', undefined, 'STR'), telStr);
  chipTele.append(tele);
  const chipErr = el('div', 'chip err hide');
  hud.append(chipKart, chipState, chipArm, chipPos, chipTele, chipErr);

  const buttons = el('div', 'buttons');
  const btnArm = el('button', 'btn btn-arm', 'ARM');
  btnArm.setAttribute('data-test', 'arm');
  const btnAbort = el('button', 'btn btn-abort');
  btnAbort.setAttribute('data-test', 'abort');
  const abortFill = el('div', 'fill');
  btnAbort.append(abortFill, el('span', 'lbl', 'ABORT'));
  buttons.append(retry, btnArm, btnAbort);
  topbar.append(hud, buttons);

  const pads = el('div', 'pads');

  const padSteer = el('div', 'pad col-steer pad-steer');
  padSteer.setAttribute('data-test', 'pad-steer');
  const knob = el('div', 'steer-knob');
  const steerOut = el('div', 'steer-readout', '+0.00');
  padSteer.append(el('div', 'cap', 'STEER'), el('div', 'steer-centre'), knob, steerOut);

  const colRight = el('div', 'col-right');
  const padThr = el('div', 'pad pad-throttle');
  padThr.setAttribute('data-test', 'pad-throttle');
  const thrBar = el('div', 'thr-bar');
  const thrOut = el('div', 'thr-readout', '0.00');
  padThr.append(
    thrBar,
    el('div', 'cap', 'THROTTLE'),
    el('div', 'thr-hint', 'DRAG UP'),
    thrOut,
  );
  const padBrake = el('div', 'pad pad-brake', 'BRAKE');
  padBrake.setAttribute('data-test', 'pad-brake');
  colRight.append(padThr, padBrake);
  pads.append(padSteer, colRight);

  const banner = el('div', 'banner hide');
  const rotate = el('div', 'rotate', 'TURN THE PHONE SIDEWAYS');

  stage.append(fpv, fallback, topbar, pads, banner, rotate);
  root!.replaceChildren(stage);

  // ---- FPV

  let fpvTimer: ReturnType<typeof setTimeout> | null = null;
  /** One switch for the whole degraded state: notice visible, RETRY offered in the topbar. */
  const setFpvOffline = (off: boolean): void => {
    stage.classList.toggle('novideo', off);
    // No point offering RETRY when video was switched off deliberately.
    retry.classList.toggle('hide', !off || !videoWanted);
  };
  const armFpvWatchdog = (): void => {
    if (fpvTimer) clearTimeout(fpvTimer);
    fpvTimer = setTimeout(() => setFpvOffline(true), FPV_TIMEOUT_MS);
  };

  /**
   * An MJPEG `<img>` NEVER finishes loading — `multipart/x-mixed-replace` holds the connection
   * open for as long as the pilot watches — and an unreachable car does not finish either. Either
   * way the browser's `load` event would never fire, which on a phone means a spinner that never
   * stops and (worse) any work deferred to `window.onload` never running. So the stream is only
   * ever attached once the page itself has finished loading. Measured, not theorised: with the
   * `src` set inline this page's `load` event timed out at 30 s against an unreachable kart ip.
   */
  const whenPageLoaded = (fn: () => void): void => {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn, { once: true });
  };

  const attachFpv = (bust: number): void => {
    const ip = snapshot.karts.find((k) => k.kart_id === kartId)?.ip ?? null;
    const url = streamUrl(ip, bust);
    fallbackUrl.textContent = url ?? `kart ${kartId} has no usable ip`;
    if (!videoWanted) {
      // Video switched off deliberately: no notice, no RETRY — just a clean black cockpit.
      img.classList.add('off');
      setFpvOffline(false);
      return;
    }
    if (url === null) {
      img.classList.add('off');
      setFpvOffline(true);
      return;
    }
    img.classList.remove('off');
    setFpvOffline(false);
    whenPageLoaded(() => {
      img.src = url;
      armFpvWatchdog();
    });
  };
  img.addEventListener('load', () => {
    setFpvOffline(false);
    armFpvWatchdog(); // each decoded multipart frame re-arms it; a frozen stream trips it
  });
  img.addEventListener('error', () => {
    if (fpvTimer) clearTimeout(fpvTimer);
    img.classList.add('off');
    setFpvOffline(true);
  });
  retry.addEventListener('click', () => attachFpv(Date.now()));
  // The kart's ip comes from the module, so wait for the first snapshot before attaching.
  let fpvAttached = false;

  // ---- pads: one owning pointer each, so steering while throttling is two independent gestures

  let steerPointer: number | null = null;
  let thrPointer: number | null = null;
  let brakePointer: number | null = null;
  let steerRect: PadRect = { left: 0, top: 0, width: 0, height: 0 };
  let thrRect: PadRect = { left: 0, top: 0, width: 0, height: 0 };
  let anchorY = 0;

  const rectOf = (node: HTMLElement): PadRect => {
    const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  /** Pointer capture fails on a synthetic event (and on a pointer the UA already released). */
  const capture = (node: HTMLElement, id: number): void => {
    try {
      node.setPointerCapture(id);
    } catch {
      /* non-fatal: the element's own listeners still see the moves */
    }
  };

  const paintSteer = (): void => {
    const s = touch.steer ?? 0;
    knob.style.left = `${50 + s * 45}%`;
    steerOut.textContent = `${s >= 0 ? '+' : ''}${s.toFixed(2)}`;
    padSteer.classList.toggle('live', steerPointer !== null);
  };
  const paintThrottle = (): void => {
    thrBar.style.height = `${Math.round((touch.brake ? 0 : touch.throttle) * 100)}%`;
    thrOut.textContent = touch.throttle.toFixed(2);
    padThr.classList.toggle('live', thrPointer !== null);
    padBrake.classList.toggle('live', touch.brake);
  };

  padSteer.addEventListener('pointerdown', (ev) => {
    if (steerPointer !== null) return;
    if (ev.cancelable) ev.preventDefault();
    steerPointer = ev.pointerId;
    steerRect = rectOf(padSteer);
    capture(padSteer, ev.pointerId);
    touch.steer = steerFromPointer(ev.clientX, steerRect);
    pushTouch();
    paintSteer();
  });
  padSteer.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== steerPointer) return;
    if (ev.cancelable) ev.preventDefault();
    touch.steer = steerFromPointer(ev.clientX, steerRect);
    pushTouch();
    paintSteer();
  });

  padThr.addEventListener('pointerdown', (ev) => {
    if (thrPointer !== null) return;
    if (ev.cancelable) ev.preventDefault();
    thrPointer = ev.pointerId;
    thrRect = rectOf(padThr);
    anchorY = ev.clientY;
    capture(padThr, ev.pointerId);
    touch.throttle = 0; // a thumb landing is never throttle — it only anchors the drag
    pushTouch();
    paintThrottle();
  });
  padThr.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== thrPointer) return;
    if (ev.cancelable) ev.preventDefault();
    const next = throttleDrag(anchorY, ev.clientY, thrRect);
    anchorY = next.anchorY;
    touch.throttle = next.throttle;
    pushTouch();
    paintThrottle();
  });

  padBrake.addEventListener('pointerdown', (ev) => {
    if (brakePointer !== null) return;
    if (ev.cancelable) ev.preventDefault();
    brakePointer = ev.pointerId;
    capture(padBrake, ev.pointerId);
    touch.brake = true;
    pushTouch();
    paintThrottle();
  });

  /** Release whichever gesture this pointer owned. `null` releases everything (blur/hide). */
  const releasePointer = (id: number | null): void => {
    if (id === null || id === steerPointer) {
      steerPointer = null;
      touch.steer = null; // snaps to straight
    }
    if (id === null || id === thrPointer) {
      thrPointer = null;
      touch.throttle = 0; // coast — DriveLoop keeps sending the zero every tick
    }
    if (id === null || id === brakePointer) {
      brakePointer = null;
      touch.brake = false;
    }
    pushTouch();
    paintSteer();
    paintThrottle();
  };

  // On window, not the pads: a capture released early (iOS does this on a system gesture) would
  // otherwise deliver the up somewhere we are not listening and leave a pad stuck on.
  window.addEventListener('pointerup', (ev) => releasePointer(ev.pointerId));
  window.addEventListener('pointercancel', (ev) => releasePointer(ev.pointerId));

  // ---- arm / abort

  btnArm.addEventListener('click', () => {
    if (!loop) return;
    loop.toggle();
    if (loop.get().armed) void requestWakeLock();
    else void releaseWakeLock();
    paint();
  });

  let abortTimer: ReturnType<typeof setTimeout> | null = null;
  let abortStart = 0;
  let abortRaf = 0;
  const abortCancel = (): void => {
    if (abortTimer) clearTimeout(abortTimer);
    abortTimer = null;
    if (abortRaf) cancelAnimationFrame(abortRaf);
    abortRaf = 0;
    abortFill.style.inset = '0 100% 0 0';
  };
  const abortTickFill = (): void => {
    const pct = Math.min(1, (Date.now() - abortStart) / ABORT_HOLD_MS);
    abortFill.style.inset = `0 ${Math.round((1 - pct) * 100)}% 0 0`;
    if (pct < 1) abortRaf = requestAnimationFrame(abortTickFill);
  };
  const abortBegin = (ev: PointerEvent): void => {
    if (abortTimer) return;
    if (ev.cancelable) ev.preventDefault();
    capture(btnAbort, ev.pointerId);
    abortStart = Date.now();
    abortTickFill();
    abortTimer = setTimeout(() => {
      abortCancel();
      // Disarm FIRST: `abort_race` zeroes the module's inputs, and 40 ms later an armed loop
      // would write the held throttle straight back (the director makes the same ordering choice).
      loop?.disarm();
      void releaseWakeLock();
      void adapter
        .abortRace()
        .then(() => toast('ABORT sent — every kart killed, race back to lobby', 'err'))
        .catch((err: unknown) => toast(`ABORT FAILED — ${message(err)}`, 'err'));
      paint();
    }, ABORT_HOLD_MS);
  };
  btnAbort.addEventListener('pointerdown', abortBegin);
  btnAbort.addEventListener('pointerup', abortCancel);
  btnAbort.addEventListener('pointercancel', abortCancel);
  btnAbort.addEventListener('pointerleave', abortCancel);

  // ---- banners

  let toastText: { text: string; kind: 'warn' | 'err'; at: number } | null = null;
  function toast(text: string, kind: 'warn' | 'err'): void {
    toastText = { text, kind, at: Date.now() };
  }

  // ---- HUD

  function paint(): void {
    const kart = snapshot.karts.find((k) => k.kart_id === kartId);
    chipKart.replaceChildren(
      document.createTextNode('KART '),
      el('b', undefined, kart ? kartLabel(kart) : String(kartId)),
    );
    chipState.dataset.state = snapshot.config.state;
    chipState.replaceChildren(
      document.createTextNode('RACE '),
      el('b', undefined, snapshot.config.state.toUpperCase()),
    );

    chipArm.textContent = drive.armed ? `ARMED · ${drive.frames} f` : 'DISARMED';
    chipArm.className = `chip ${drive.armed ? 'armed' : 'disarmed'}`;
    btnArm.textContent = drive.armed ? 'DISARM' : 'ARM';
    btnArm.dataset.armed = drive.armed ? '1' : '0';

    // Proof-of-landing: these two come from the MODULE's `input` row, not from our own thumbs.
    const row = snapshot.inputs.find((i) => i.kart_id === kartId);
    telThr.textContent = (row?.throttle ?? 0).toFixed(2);
    const st = row?.steer ?? 0;
    telStr.textContent = `${st >= 0 ? '+' : ''}${st.toFixed(2)}`;

    const prog = snapshot.progress.find((p) => p.kart_id === kartId);
    if (prog) {
      chipPos.classList.remove('hide');
      chipPos.replaceChildren(
        document.createTextNode('P'),
        el('b', undefined, String(prog.placement || '—')),
        document.createTextNode(` · LAP ${prog.lap}/${snapshot.config.lap_count}`),
      );
    } else {
      chipPos.classList.add('hide');
    }

    const err = drive.error ?? (connection.status === 'error' || connection.status === 'offline'
      ? connection.detail
      : null);
    chipErr.textContent = err ? err.slice(0, 90) : '';
    chipErr.classList.toggle('hide', !err);

    // One banner slot, highest-priority message wins.
    let text = '';
    let kind: 'warn' | 'err' = 'warn';
    if (toastText && Date.now() - toastText.at < 4000) {
      text = toastText.text;
      kind = toastText.kind;
    } else if (drive.armed && snapshot.config.state !== 'running') {
      text = `race is ${snapshot.config.state} — the bridge holds throttle at 0 until it is RUNNING`;
    } else if (!drive.armed) {
      text = 'tap ARM to take the kart · hold ABORT to kill the whole race';
    } else if (drive.source === 'gamepad') {
      text = `gamepad driving — ${drive.padName ?? 'pad'}`;
    }
    banner.textContent = text;
    banner.className = `banner ${text ? kind : 'hide'}`;

    if (!fpvAttached && snapshot.karts.length > 0) {
      fpvAttached = true;
      attachFpv(0);
    }
  }

  setInterval(paint, 100);
  paint();
}

// ---------------------------------------------------------------- lifecycle

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Keep the screen awake while armed. Best-effort by design: Wake Lock needs a secure context, so
 * over plain http on the venue AP it simply is not there — hence the swallowed failure and the
 * `?novideo`-style absence of any error path. The MJPEG stream repainting the page does most of
 * this job anyway.
 */
let wakeLock: { release: () => Promise<void> } | null = null;

async function requestWakeLock(): Promise<void> {
  const api = (
    navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
    }
  ).wakeLock;
  if (!api) return;
  try {
    wakeLock = await api.request('screen');
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock(): Promise<void> {
  try {
    await wakeLock?.release();
  } catch {
    /* already gone */
  }
  wakeLock = null;
}

// A `pointerup` that lands in the app switcher, a notification shade or the lock screen never
// reaches us, so a held throttle would stick. Both of these release every thumb; the loop stays
// armed and simply goes neutral — identical to the director's blur handling.
window.addEventListener('blur', () => loop?.releaseAll());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) loop?.releaseAll();
});
// Leaving the page for real parks the kart with an explicit zero.
window.addEventListener('pagehide', () => {
  loop?.dispose();
  adapter.stop();
});

if (claimed !== null) showCockpit(claimed);
else showClaim();
