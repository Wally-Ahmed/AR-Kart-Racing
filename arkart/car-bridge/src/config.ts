/** Environment + `karts.json` loading. No game logic here. */

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_KART_PORT = 7777;
export const DEFAULT_TICK_HZ = 50;
export const DEFAULT_SPACETIME_URI = 'ws://localhost:3000';
export const DEFAULT_MODULE_NAME = 'arkart';

/** Repo path of this package, so `karts.json` resolves regardless of cwd. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface KartAddress {
  kartId: number;
  name: string;
  ip: string;
  port: number;
  /**
   * `false` = `ip` is a *placeholder*, not an address — e.g. the `REAL_CAR_IP`
   * marker shipped in `karts.json` for a board whose DHCP lease nobody has
   * looked up yet. The kart stays in the loop (the rule engine still runs for
   * it and its sequence counter still advances, so nothing downstream shifts
   * when the address is filled in) but {@link UdpSink} does not transmit to it.
   * Without this the 50 Hz loop would fire a failing DNS lookup for
   * `REAL_CAR_IP` fifty times a second, forever.
   */
  configured: boolean;
}

/**
 * Is this string something we can actually send a datagram to?
 *
 * An IP literal, yes. A dotted name, yes — the resolver gets to try (`.local`
 * mDNS names and real hostnames both land here). A bare dotless token is NOT:
 * that is the shape of a fill-this-in-at-the-venue placeholder, and treating it
 * as a hostname just produces an endless stream of ENOTFOUND.
 */
export function isRoutableTarget(ip: string): boolean {
  return isIP(ip) !== 0 || ip.includes('.');
}

export interface KartsFile {
  port?: number;
  karts: Array<{ kart_id: number; name?: string; ip: string; port?: number }>;
}

/** Which world-state adapter the daemon runs against. */
export type SourceKind = 'stdb' | 'sql' | 'sim';

export interface BridgeConfig {
  spacetimeUri: string;
  moduleName: string;
  /** http(s) origin derived from the ws(s) URI, for the SQL fallback adapter */
  httpOrigin: string;
  source: SourceKind;
  /** dynamic-import specifier for the module's generated bindings (see README) */
  bindingsPath: string;
  tickHz: number;
  kartsFile: string;
  addresses: Map<number, KartAddress>;
  /** print one line per second of per-kart state */
  verbose: boolean;
  /** encode + compute but do not actually open a UDP socket */
  dryRun: boolean;
}

export function parseKartsFile(json: unknown, fallbackPort = DEFAULT_KART_PORT): Map<number, KartAddress> {
  const file = json as KartsFile;
  if (!file || !Array.isArray(file.karts)) {
    throw new Error('karts.json: expected an object with a "karts" array');
  }
  const filePort = typeof file.port === 'number' ? file.port : fallbackPort;
  const out = new Map<number, KartAddress>();
  for (const k of file.karts) {
    if (typeof k?.kart_id !== 'number' || !Number.isInteger(k.kart_id)) {
      throw new Error(`karts.json: kart_id must be an integer, got ${JSON.stringify(k?.kart_id)}`);
    }
    if (k.kart_id < 0 || k.kart_id > 255) {
      throw new Error(`karts.json: kart_id ${k.kart_id} does not fit in a u8`);
    }
    if (typeof k.ip !== 'string' || k.ip.length === 0) {
      throw new Error(`karts.json: kart ${k.kart_id} has no ip`);
    }
    if (out.has(k.kart_id)) throw new Error(`karts.json: duplicate kart_id ${k.kart_id}`);
    out.set(k.kart_id, {
      kartId: k.kart_id,
      name: k.name ?? `kart-${k.kart_id}`,
      ip: k.ip,
      port: typeof k.port === 'number' ? k.port : filePort,
      configured: isRoutableTarget(k.ip),
    });
  }
  if (out.size === 0) throw new Error('karts.json: no karts configured');
  return out;
}

export function loadKartsFile(path: string): Map<number, KartAddress> {
  const raw = readFileSync(path, 'utf8');
  return parseKartsFile(JSON.parse(raw));
}

/** ws://host:port -> http://host:port (the STDB HTTP API lives on the same origin). */
export function wsUriToHttpOrigin(uri: string): string {
  try {
    const u = new URL(uri);
    u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    u.pathname = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return uri.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
  }
}

function envSource(raw: string | undefined): SourceKind {
  const v = (raw ?? 'stdb').toLowerCase();
  if (v === 'stdb' || v === 'spacetime' || v === 'sdk') return 'stdb';
  if (v === 'sql' || v === 'http') return 'sql';
  if (v === 'sim' || v === 'fake') return 'sim';
  throw new Error(`BRIDGE_SOURCE must be one of stdb|sql|sim, got "${raw}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const spacetimeUri = env.SPACETIME_URI ?? DEFAULT_SPACETIME_URI;
  const kartsFile = env.KARTS_FILE ?? resolve(PACKAGE_ROOT, 'karts.json');
  const tickHz = Number(env.TICK_HZ ?? DEFAULT_TICK_HZ);
  if (!Number.isFinite(tickHz) || tickHz <= 0) throw new Error(`bad TICK_HZ: ${env.TICK_HZ}`);

  return {
    spacetimeUri,
    moduleName: env.SPACETIME_MODULE ?? DEFAULT_MODULE_NAME,
    httpOrigin: env.SPACETIME_HTTP ?? wsUriToHttpOrigin(spacetimeUri),
    source: envSource(env.BRIDGE_SOURCE),
    bindingsPath: env.BRIDGE_BINDINGS ?? '../../module/src/module_bindings/index.ts',
    tickHz,
    kartsFile,
    addresses: loadKartsFile(kartsFile),
    verbose: env.BRIDGE_VERBOSE !== '0',
    dryRun: env.BRIDGE_DRY_RUN === '1',
  };
}
