/** Models SDK 1.x: only the OLD `withModuleName` exists. The fallback must still work. */

export const calls: { moduleName?: string; built: boolean } = { built: false };

export const DbConnection = {
  builder() {
    const b = {
      withUri() {
        return b;
      },
      withModuleName(name: string) {
        calls.moduleName = name;
        return b;
      },
      onConnect(cb: (conn: unknown) => void) {
        queueMicrotask(() =>
          cb({
            db: {},
            subscriptionBuilder: () => {
              const s = {
                onApplied: (fn: () => void) => {
                  queueMicrotask(fn);
                  return s;
                },
                subscribe: () => s,
              };
              return s;
            },
          }),
        );
        return b;
      },
      build() {
        calls.built = true;
      },
    };
    return b;
  },
};
