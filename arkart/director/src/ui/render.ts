/**
 * Render — one pure function from UiState to an HTML string, painted into #app.
 *
 * Deliberately framework-free: the whole screen is a handful of rows, repainting it at 10 Hz
 * costs nothing, and there is no build-time risk to a hackathon submission. Interactivity is
 * a single delegated click handler in `main.ts` reading `data-action` attributes.
 */

import { buildStandings, effectRemainingMs, validateTrackOrder, type Standing } from '../placement.ts';
import type { UiState } from '../store.ts';
import { EFFECT_META, ITEM_META, type InputRow, type RaceState } from '../types.ts';

const ORDINALS = ['', 'st', 'nd', 'rd'];
const ordinal = (n: number) => (n > 3 && n < 21 ? 'th' : (ORDINALS[n % 10] ?? 'th'));

export function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const clockFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const STATE_BLURB: Record<RaceState, string> = {
  setup: 'defining the track — drive the calibration lap',
  lobby: 'track confirmed · karts idle · throttle held at zero',
  countdown: 'lights out in…',
  running: 'race is live',
  finished: 'results frozen',
};

export function render(state: UiState, now: number): string {
  const { snapshot } = state;
  const standings = buildStandings({
    karts: snapshot.karts,
    progress: snapshot.progress,
    inventory: snapshot.inventory,
    effects: snapshot.effects,
    track: snapshot.track,
    lapCount: snapshot.config.lap_count,
    now,
  });
  const inputs = new Map(snapshot.inputs.map((i) => [i.kart_id, i]));

  return `
    ${topbar(state, now)}
    <main class="grid">
      <section class="standings" aria-label="Live standings">
        ${sectionHead(
          'LIVE STANDINGS',
          `${standings.length} karts · ${snapshot.track.length} gates · ${snapshot.config.lap_count} laps · placement: ${
            standings[0]?.source ?? 'derived'
          }`,
        )}
        ${
          standings.length
            ? standings
                .map((s) =>
                  kartCard(s, {
                    trackLen: snapshot.track.length,
                    lapCount: snapshot.config.lap_count,
                    input: inputs.get(s.kart.kart_id),
                    now,
                  }),
                )
                .join('')
            : emptyBox('No karts registered yet — the module seeds the <code>kart</code> table on init.')
        }
        ${countdownOverlay(state, now)}
      </section>
      <aside class="rail">
        ${setupPanel(state)}
        ${controls(state)}
        ${drivePanel(state, now)}
        ${eventFeed(state, now)}
      </aside>
    </main>
    ${toastBar(state)}
  `;
}

// ---------------------------------------------------------------- top bar

function topbar(state: UiState, now: number): string {
  const { config } = state.snapshot;
  const c = state.connection;
  // Only a POLLING transport can go stale — a live subscription is simply silent when the race
  // is idle, and flashing ERROR at the judges over an idle lobby is worse than no indicator.
  const stale = !c.pushes && c.lastUpdateAt !== null && now - c.lastUpdateAt > 3000;
  const status = stale && c.status === 'live' ? 'error' : c.status;
  return `
    <header class="topbar">
      <div class="brand">AR<b>KART</b><span>DIRECTOR</span></div>
      <div class="state-block">
        <div class="statepill" data-state="${esc(config.state)}">${esc(config.state).toUpperCase()}</div>
        <div class="state-blurb">${esc(STATE_BLURB[config.state])}</div>
      </div>
      <div class="spacer"></div>
      <div class="conn" title="${esc(c.detail)}">
        <span class="dot" data-status="${esc(status)}"></span>
        <div>
          <div class="conn-src">${esc(c.source)}<span class="conn-status">${esc(status)}</span></div>
          <div class="conn-detail">${esc(c.detail || '—')}</div>
        </div>
      </div>
      <div class="clock">${esc(clockFmt.format(now))}</div>
      <button class="abort" data-action="abort" title="abort_race — kills throttle on every kart">
        <span class="abort-glyph">⏻</span> ABORT
      </button>
    </header>`;
}

function sectionHead(title: string, sub: string): string {
  return `<div class="sec-head"><h2>${esc(title)}</h2><span>${esc(sub)}</span></div>`;
}

function emptyBox(html: string): string {
  return `<div class="empty">${html}</div>`;
}

// ------------------------------------------------------------- standings

function kartCard(
  s: Standing,
  opts: { trackLen: number; lapCount: number; input: InputRow | undefined; now: number },
): string {
  const { trackLen, lapCount, input, now } = opts;
  const p = s.progress;
  const nextTag = trackLen > 0 ? p.next_idx : null;
  const gap =
    s.placement === 1
      ? 'LEADER'
      : s.gateGap > 0
        ? `−${s.gateGap} gate${s.gateGap === 1 ? '' : 's'}`
        : 'on pace';
  const throttle = Math.round((input?.throttle ?? 0) * 100);
  const steer = Math.round((input?.steer ?? 0) * 100);
  return `
    <article class="kart" data-place="${s.placement}" data-finished="${s.finished}">
      <div class="pos">
        <span class="posnum">${s.placement}</span><span class="possuf">${ordinal(s.placement)}</span>
      </div>
      <div class="kbody">
        <div class="krow1">
          <h3>${esc(s.kart.name)}</h3>
          <span class="kid">#${esc(s.kart.kart_id)}</span>
          <span class="kip">${esc(s.kart.ip || 'no ip')}</span>
          <span class="gap ${s.placement === 1 ? 'lead' : ''}">${esc(gap)}</span>
          ${s.finished ? '<span class="fin">🏁 FINISHED</span>' : ''}
        </div>
        <div class="krow2">
          <div class="lapbig">LAP <b>${p.lap}</b><i>/${esc(lapCount)}</i></div>
          <div class="nextgate">NEXT GATE <b>${nextTag === null ? '—' : `#${nextTag}`}</b></div>
          <div class="cap" title="speed cap the car bridge is applying">CAP <b>×${s.speedCap.toFixed(2)}</b></div>
          <div class="telem" title="last set_input frame">
            THR <b>${throttle}%</b> · STR <b>${steer > 0 ? '+' : ''}${steer}</b>
          </div>
        </div>
        <div class="bar"><i style="width:${(s.raceFraction * 100).toFixed(1)}%"></i></div>
        <div class="krow3">
          <div class="slots">${slotBox(s.slots[0], 1)}${slotBox(s.slots[1], 2)}</div>
          <div class="fx">${
            s.effects.length
              ? s.effects.map((e) => effectChip(e.kind, effectRemainingMs(e, now))).join('')
              : '<span class="fx-none">no active effects</span>'
          }</div>
        </div>
      </div>
    </article>`;
}

function slotBox(item: Standing['slots'][0], n: number): string {
  if (!item) return `<div class="slot empty"><span class="slotn">${n}</span></div>`;
  const meta = ITEM_META[item];
  return `<div class="slot" style="--item:${meta.color}">
      <span class="slotn">${n}</span>
      <span class="slotglyph">${meta.glyph}</span>
      <span class="slotlabel">${esc(meta.label)}</span>
    </div>`;
}

function effectChip(kind: keyof typeof EFFECT_META, remainingMs: number | null): string {
  const meta = EFFECT_META[kind];
  const secs = remainingMs === null ? '∞' : (remainingMs / 1000).toFixed(1);
  const pct = remainingMs === null ? 100 : Math.min(100, (remainingMs / 4000) * 100);
  return `<span class="chip" style="--fx:${meta.color}">
      <span class="chipglyph">${meta.glyph}</span>${esc(meta.label)}
      <b>${esc(secs)}${remainingMs === null ? '' : 's'}</b>
      <i class="chipbar" style="width:${pct.toFixed(0)}%"></i>
    </span>`;
}

function countdownOverlay(state: UiState, now: number): string {
  const { config } = state.snapshot;
  if (config.state !== 'countdown' || config.countdown_ends_at === null) return '';
  const left = Math.max(0, config.countdown_ends_at - now);
  const n = Math.ceil(left / 1000);
  return `<div class="countdown"><span>${n > 0 ? n : 'GO'}</span></div>`;
}

// ----------------------------------------------------------- setup panel

function setupPanel(state: UiState): string {
  const { snapshot, draftOrder } = state;
  const inSetup = snapshot.config.state === 'setup';
  const seenAt = new Map(snapshot.setupSeen.map((s) => [s.tag_id, s.first_seen_at]));
  const check = validateTrackOrder(draftOrder);
  const confirmed = snapshot.track;

  const list = draftOrder.length
    ? draftOrder
        .map((tag, i) => {
          const t = seenAt.get(tag);
          return `<li class="gate" data-tag="${tag}">
            <span class="seq">${i}</span>
            <span class="tag">TAG ${tag}</span>
            ${i === 0 ? '<span class="sf">START / FINISH</span>' : ''}
            <span class="seen">${t ? new Date(t).toLocaleTimeString('en-GB') : ''}</span>
            <span class="gbtns">
              <button data-action="gate-up" data-index="${i}" ${i === 0 ? 'disabled' : ''} title="move earlier">▲</button>
              <button data-action="gate-down" data-index="${i}" ${i === draftOrder.length - 1 ? 'disabled' : ''} title="move later">▼</button>
              <button data-action="gate-drop" data-tag="${tag}" title="remove stray">✕</button>
            </span>
          </li>`;
        })
        .join('')
    : `<li class="gate placeholder">${
        inSetup ? 'waiting for gate sightings…' : 'not in setup — hit BEGIN SETUP to re-map the track'
      }</li>`;

  return `
    <section class="panel setup" data-active="${inSetup}">
      ${sectionHead('TRACK SETUP', inSetup ? 'calibration lap — first-seen order' : `confirmed: ${confirmed.length} gates`)}
      <ol class="gates">${list}</ol>
      <div class="setup-foot">
        <span class="valid ${check.ok ? 'ok' : 'bad'}">${
          check.ok ? `${draftOrder.length} gates ready` : `✕ ${esc(check.reason)}`
        }</span>
        ${state.dropped.length ? `<button class="mini" data-action="restore">restore ${state.dropped.length} dropped</button>` : ''}
      </div>
      ${
        confirmed.length
          ? `<div class="confirmed">CONFIRMED ORDER · ${confirmed
              .map((t) => `<b>${t.seq}</b>:${t.tag_id}`)
              .join(' → ')}</div>`
          : ''
      }
    </section>`;
}

// -------------------------------------------------------------- controls

function controls(state: UiState): string {
  const s = state.snapshot.config.state;
  const check = validateTrackOrder(state.draftOrder);
  const b = state.busy ? 'disabled' : '';
  return `
    <section class="panel controls">
      ${sectionHead('RACE CONTROL', 'director reducers')}
      <div class="btns">
        <button class="btn" data-action="begin-setup" ${b}>BEGIN SETUP</button>
        <button class="btn primary" data-action="confirm-track" ${b || (check.ok ? '' : 'disabled')}>
          CONFIRM TRACK
        </button>
        <button class="btn go" data-action="start-race" ${b || (s === 'lobby' ? '' : 'disabled')}>
          START RACE
        </button>
        <button class="btn" data-action="reset-race" ${b}>RESET RACE</button>
      </div>
    </section>`;
}

// ----------------------------------------------------------- drive control

/**
 * The laptop as a pilot station — `set_input` at 25 Hz from the keyboard or a gamepad
 * (`src/drive.ts`). Shown disarmed by default: the panel exists so that a kart can be driven
 * on the bench and demoed without a provisioned phone, not so that the judges' screen is
 * secretly live.
 */
function drivePanel(state: UiState, now: number): string {
  const d = state.drive;
  const karts = state.snapshot.karts.length
    ? state.snapshot.karts.map((k) => ({ id: k.kart_id, name: k.name }))
    : [
        { id: 1, name: 'KART 1' },
        { id: 2, name: 'KART 2' },
      ];
  const thr = Math.round(d.vector.throttle * 100);
  const str = Math.round(d.vector.steer * 100);
  // The pilot frame is a keep-alive: silence for ~300 ms means the car bridge has already
  // zeroed this kart, so the age is worth showing rather than just the count.
  const age = d.sentAt === null ? null : Math.max(0, now - d.sentAt);
  return `
    <section class="panel drive" data-armed="${d.armed}">
      ${sectionHead('DRIVE CONTROL', `set_input · 25 Hz · ${d.armed ? esc(d.source) : 'disarmed'}`)}
      <div class="drive-row">
        <button class="btn ${d.armed ? 'armed' : ''}" data-action="drive-toggle"
                title="Arm the arrow keys / WASD for kart ${d.kartId} — Shift+D">
          ${d.armed ? 'DISARM' : 'ARM DRIVE'}
        </button>
        <div class="drive-karts">
          ${karts
            .map(
              (k) => `<button class="chip" data-action="drive-kart" data-kart="${k.id}"
                      data-on="${k.id === d.kartId}">${esc(k.name)}</button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="drive-telem">
        <div class="dt">
          <span>THROTTLE</span>
          <div class="bar"><i style="width:${Math.max(0, Math.min(100, thr))}%"></i></div>
          <b>${thr}%</b>
        </div>
        <div class="dt">
          <span>STEER</span>
          <div class="bar steerbar">
            <i style="left:${50 + Math.max(-50, Math.min(50, str / 2))}%"></i>
          </div>
          <b>${str > 0 ? '+' : ''}${str}</b>
        </div>
      </div>
      <div class="drive-foot">
        ${
          d.error
            ? `<span class="drive-err">${esc(d.error)}</span>`
            : d.armed
              ? `<span>${d.frames} frames${age === null ? '' : ` · last ${age} ms ago`}${
                  d.padName ? ` · ${esc(d.padName)}` : ''
                }</span>`
              : '<span>↑/W drive · ↓/S brake · ←→/AD steer · no reverse (Plan M)</span>'
        }
      </div>
    </section>`;
}

// ------------------------------------------------------------ event feed

function eventFeed(state: UiState, now: number): string {
  const events = [...state.snapshot.events].slice(-60).reverse();
  return `
    <section class="panel feed">
      ${sectionHead('EVENT LOG', `${state.snapshot.events.length} entries`)}
      <ul class="events">
        ${
          events.length
            ? events
                .map((e, i) => {
                  const age = Math.max(0, now - e.at);
                  const fresh = age < 1500 && i === 0 ? ' fresh' : '';
                  return `<li class="ev${fresh}">
                    <span class="evt">${esc(new Date(e.at).toLocaleTimeString('en-GB'))}</span>
                    <span class="evx">${esc(e.text)}</span>
                  </li>`;
                })
                .join('')
            : '<li class="ev muted">no events yet</li>'
        }
      </ul>
    </section>`;
}

function toastBar(state: UiState): string {
  if (!state.toast) return '';
  return `<div class="toast ${state.toast.kind}">${esc(state.toast.text)}</div>`;
}
