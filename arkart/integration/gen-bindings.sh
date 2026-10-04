#!/usr/bin/env bash
#
# Generate the `arkart` TypeScript client bindings for every consumer.
#
#   ./gen-bindings.sh            # regenerate both targets
#   ./gen-bindings.sh --bridge-only
#                                # regenerate ONLY integration/module_bindings.
#                                # Use this when something else is working in
#                                # arkart/director/ — the director pass starts
#                                # with `rm -rf` on its module_bindings, and a
#                                # concurrent editor there would race it. The
#                                # director copy is pure generated output, so
#                                # skipping it changes nothing but ownership.
#
# Two targets, because the two consumers resolve modules differently:
#
#   arkart/integration/module_bindings   -> the CAR BRIDGE (Node native ESM)
#   arkart/director/src/module_bindings  -> the DIRECTOR SCREEN (Vite/tsc bundler)
#
# Both are GENERATED ARTIFACTS, rebuilt from scratch by this script. Neither is
# hand-maintained source, and nothing here edits any component's own code.
#
# ── the two post-processing passes ────────────────────────────────────────────
#
# 1. EXTENSIONS (bridge copy only).
#    `spacetime generate` emits extensionless relative imports
#    ( import X from "./config_table" ). Bundlers resolve those; Node's native
#    ESM loader does NOT and throws ERR_MODULE_NOT_FOUND. The car bridge runs
#    `node src/index.ts` with no bundler, so its copy gets explicit `.ts`
#    extensions. The director copy is left alone — Vite resolves them.
#
# 2. SDK 1.x COMPAT ALIAS (both copies).
#    SpacetimeDB SDK 1.x spelled the "which database" builder method
#    `withModuleName`. SDK 2.4.1 — the version matching this server and CLI —
#    renamed it to `withDatabaseName` and dropped the old name:
#
#      builder methods: build, getDatabaseName, getUri, onConnect,
#      onConnectError, onDisconnect, withCompression, withConfirmedReads,
#      withDatabaseName, withLightMode, withToken, withUri, withWSFn
#
#    Both the car bridge and the director screen were written against the 1.x
#    name, so both fail at connect time:
#      bridge   -> "Database name or address is required to connect to SpacetimeDB"
#                  (its builder helper silently skips unknown methods)
#      director -> "builder threw: ...withModuleName is not a function"
#    This pass teaches the generated builder BOTH names, so the generated code
#    is bilingual and neither consumer has to change. See integration/README.md
#    for the permanent one-line fix in each consumer.
#
# Also: the bindings import the client runtime as a BARE specifier
# ( from "spacetimedb" ). Node resolves that from the importing file's directory
# upwards, which is why this package carries its own package.json pinning
# spacetimedb@2.4.1 — the same version as the server and the CLI.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARKART="$(cd "$HERE/.." && pwd)"
MODULE="$ARKART/module"

BRIDGE_OUT="$HERE/module_bindings"
DIRECTOR_OUT="$ARKART/director/src/module_bindings"

quiet() { grep -Ev '^(A new version of SpacetimeDB|Run .spacetime version)' || true; }

generate() { # <out-dir>
  rm -rf "$1"
  ( cd "$MODULE" && spacetime generate --lang typescript \
      --out-dir "$1" --module-path ./spacetimedb --yes ) 2>&1 | quiet >/dev/null
}

postprocess() { # <out-dir> <fix-extensions: 1|0>
  python3 - "$1" "$2" <<'PY'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
fix_ext = sys.argv[2] == '1'

# ---- pass 1: ./foo -> ./foo.ts (idempotent) ---------------------------------
if fix_ext:
    pat = re.compile(r'(from\s+|import\s*\()(["\'])(\.{1,2}/[^"\']+?)\2')

    def fix(m):
        spec = m.group(3)
        if spec.endswith(('.ts', '.js', '.json', '.mjs', '.cjs')):
            return m.group(0)
        return f'{m.group(1)}{m.group(2)}{spec}.ts{m.group(2)}'

    n = 0
    for f in root.rglob('*.ts'):
        src = f.read_text()
        out = pat.sub(fix, src)
        if out != src:
            f.write_text(out)
            n += 1
    print(f'  [ext] rewrote relative specifiers in {n} file(s)')

# ---- pass 2: SDK 1.x `withModuleName` alias (idempotent) --------------------
MARKER = 'arkart integration: SDK 1.x compat alias'
COMPAT = f'''
// ─────────────────────────────────────────────────────────────────────────────
// {MARKER}  (added by arkart/integration/gen-bindings.sh)
//
// SDK 1.x called this `withModuleName`; SDK 2.4.1 renamed it to
// `withDatabaseName`. The car bridge and the director screen were both written
// against the 1.x name, so the generated builder answers to both. Delete this
// block once `car-bridge/src/sources/spacetime.ts` and
// `director/src/adapters/sdk.ts` call `withDatabaseName`.
// ─────────────────────────────────────────────────────────────────────────────
{{
  const __proto = DbConnectionBuilder.prototype as unknown as Record<string, unknown>;
  if (typeof __proto.withModuleName !== 'function') {{
    __proto.withModuleName = function (name: string) {{
      return (this as unknown as {{ withDatabaseName: (n: string) => unknown }}).withDatabaseName(name);
    }};
  }}
}}
'''

index = root / 'index.ts'
text = index.read_text()
if MARKER in text:
    print('  [compat] alias already present')
else:
    index.write_text(text.rstrip() + '\n' + COMPAT)
    print('  [compat] withModuleName -> withDatabaseName alias appended to index.ts')
PY
}

BRIDGE_ONLY=0
[ "${1:-}" = "--bridge-only" ] && BRIDGE_ONLY=1

echo "[gen-bindings] bridge copy  -> $BRIDGE_OUT"
generate "$BRIDGE_OUT"
postprocess "$BRIDGE_OUT" 1

if [ "$BRIDGE_ONLY" = "1" ]; then
  echo "[gen-bindings] director copy SKIPPED (--bridge-only)"
else
  echo "[gen-bindings] director copy -> $DIRECTOR_OUT"
  generate "$DIRECTOR_OUT"
  postprocess "$DIRECTOR_OUT" 0
fi

# The bindings import "spacetimedb" as a bare specifier; make sure the runtime
# that satisfies it is installed beside the bridge copy.
if [ ! -d "$HERE/node_modules/spacetimedb" ]; then
  echo "[gen-bindings] installing the spacetimedb client runtime..."
  ( cd "$HERE" && npm install --no-audit --no-fund ) >/dev/null
fi

echo "[gen-bindings] OK"
echo "  bridge   : $BRIDGE_OUT/index.ts"
echo "             BRIDGE_BINDINGS=\"$BRIDGE_OUT/index.ts\""
echo "  director : $DIRECTOR_OUT/index.ts"
echo "             http://localhost:5173/?adapter=sdk&bindings=/src/module_bindings/index.ts"
