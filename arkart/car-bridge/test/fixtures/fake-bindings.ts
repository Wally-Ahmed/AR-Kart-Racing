/**
 * Stand-in for the arkart module's generated bindings, used to test
 * SpacetimeSource without a live server.
 *
 * Deliberately models SDK **2.4.1**: the builder exposes `withDatabaseName`
 * and NOT `withModuleName`. If the source silently skips the unknown name
 * instead of probing for the new one, `databaseName` below stays undefined —
 * which is exactly the ghost failure this fixture exists to catch.
 */

export const calls: {
  uri?: string;
  databaseName?: string;
  moduleName?: string;
  built: boolean;
  subscriptions: string[];
} = { built: false, subscriptions: [] };

export function reset(): void {
  delete calls.uri;
  delete calls.databaseName;
  delete calls.moduleName;
  calls.built = false;
  calls.subscriptions = [];
}

const rows = {
  config: [{ lap_count: 3, item_roll_pct: 100, state: 'running', countdown_ends_at: [1, []] }],
  kart: [{ kart_id: 1, name: 'Kart 1', ip: '192.168.8.101', pilot_identity: [1, []] }],
  input: [{ kart_id: 1, throttle: 1.0, steer: -1.0, updated_at: [1789894296001911] }],
  effect: [{ id: 1, kart_id: 1, kind: 'shield', multiplier: 1, expires_at: [1, []] }],
};

function table(name: keyof typeof rows) {
  return { iter: () => rows[name] };
}

const fakeConn = {
  db: { config: table('config'), kart: table('kart'), input: table('input'), effect: table('effect') },
  subscriptionBuilder() {
    const sub = {
      onApplied(cb: () => void) {
        queueMicrotask(cb);
        return sub;
      },
      subscribe(queries: string[]) {
        calls.subscriptions = queries;
        return sub;
      },
    };
    return sub;
  },
  disconnect() {},
};

export const DbConnection = {
  builder() {
    const b = {
      withUri(uri: string) {
        calls.uri = uri;
        return b;
      },
      // SDK 2.4.1 name. `withModuleName` intentionally absent.
      withDatabaseName(name: string) {
        calls.databaseName = name;
        return b;
      },
      onConnect(cb: (conn: unknown) => void) {
        queueMicrotask(() => cb(fakeConn));
        return b;
      },
      onDisconnect() {
        return b;
      },
      build() {
        calls.built = true;
        return fakeConn;
      },
    };
    return b;
  },
};
