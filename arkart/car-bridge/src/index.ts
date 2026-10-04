/**
 * AR Kart car bridge — entry point.
 *
 *   SpacetimeDB (kart/input/effect/config)  ->  rule engine  ->  8-byte UDP @ 50 Hz  ->  karts
 *
 * See README.md for the env vars. Ctrl-C parks both karts before exiting.
 */

import { loadConfig, type BridgeConfig } from './config.ts';
import { Bridge } from './bridge.ts';
import { computeCommand } from './logic.ts';
import type { WorldSource } from './source.ts';
import { ParkableSource } from './sources/park.ts';
import { SimSource } from './sources/sim.ts';
import { SpacetimeSource } from './sources/spacetime.ts';
import { SqlSource } from './sources/sql.ts';
import { NullSink, UdpSink, type PacketSink } from './udp.ts';

function buildSource(cfg: BridgeConfig): WorldSource {
  switch (cfg.source) {
    case 'stdb':
      return new SpacetimeSource({
        uri: cfg.spacetimeUri,
        moduleName: cfg.moduleName,
        bindingsPath: cfg.bindingsPath,
      });
    case 'sql':
      return new SqlSource({ httpOrigin: cfg.httpOrigin, moduleName: cfg.moduleName });
    case 'sim':
      return new SimSource({ kartIds: [...cfg.addresses.keys()] });
  }
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const sink: PacketSink = cfg.dryRun ? new NullSink() : new UdpSink();
  const source = new ParkableSource(buildSource(cfg));

  console.log(
    `[bridge] source=${cfg.source} uri=${cfg.spacetimeUri} module=${cfg.moduleName} ` +
      `tick=${cfg.tickHz}Hz karts=${[...cfg.addresses.values()]
        .map((a) => `${a.kartId}@${a.ip}:${a.port}${a.configured ? '' : '(PLACEHOLDER)'}`)
        .join(' ')}${cfg.dryRun ? ' DRY-RUN' : ''}`,
  );

  await source.start();
  const bridge = new Bridge({ addresses: cfg.addresses, source, sink, tickHz: cfg.tickHz });
  bridge.start();

  let status: NodeJS.Timeout | null = null;
  if (cfg.verbose) {
    status = setInterval(() => {
      // Read-only: recompute for display. Never call bridge.tick() here — that
      // would send an extra packet and skip a sequence number.
      const snap = source.snapshot();
      const now = Date.now();
      const state = snap.config?.state ?? 'no-config';
      const per = [...cfg.addresses.keys()]
        .map((id) => {
          const { command, trace } = computeCommand(id, snap, now);
          const tags = [
            trace.stunned ? 'STUN' : '',
            trace.dizzy ? 'DIZZY' : '',
            trace.shield ? 'SHIELD' : '',
            trace.ink ? 'INK' : '',
            trace.stale ? 'STALE' : '',
          ]
            .filter(Boolean)
            .join(',');
          return (
            `${id}: thr=${command.throttle} str=${command.steer} cap=${trace.cap.toFixed(2)} ` +
            `flags=0x${command.flags.toString(16)}${tags ? ` [${tags}]` : ''}`
          );
        })
        .join('  |  ');
      console.log(
        `[bridge] state=${state} conn=${source.isConnected()} ticks=${bridge.ticks}  ${per}`,
      );
    }, 1000);
    status.unref();
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[bridge] ${signal} — parking karts`);
    if (status !== null) clearInterval(status);
    // Stop the loop but KEEP the sink and the sequence counters, then force the
    // world to "not running" and tick three more times: three zero-throttle
    // packets per kart, continuing the sequence, in case one is dropped. Parks
    // the karts now instead of waiting out the 300 ms firmware watchdog.
    bridge.pause();
    source.park();
    for (let i = 0; i < 3; i++) bridge.tick(Date.now());
    await new Promise((r) => setTimeout(r, 50));
    await bridge.stop().catch(() => {});
    await source.stop().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main().catch((err: Error) => {
    console.error(`[bridge] fatal: ${err.message}`);
    process.exit(1);
  });
}
