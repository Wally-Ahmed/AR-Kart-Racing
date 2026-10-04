/** A builder with NEITHER name. Must fail loudly, not silently connect nameless. */

export const DbConnection = {
  builder() {
    const b = {
      withUri() {
        return b;
      },
      onConnect() {
        return b;
      },
      build() {
        throw new Error('Database name or address is required');
      },
    };
    return b;
  },
};
