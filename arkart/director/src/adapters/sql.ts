/**
 * Decoder for SpacetimeDB's `POST /v1/database/:name/sql` response.
 *
 * The endpoint returns positional rows plus the product schema that describes them:
 *
 *   [{ "schema": { "elements": [{ "name": {"some":"kart_id"}, "algebraic_type": {"U32":[]} }, …] },
 *      "rows":   [[1, "Red Kart", "192.168.8.111", [1,[]]], …] }]
 *
 * Every non-scalar is encoded structurally, not as a friendly object — verified against the live
 * `arkart` module on 2026-09-20:
 *   Timestamp  `{Product:{elements:[{name:"__timestamp_micros_since_unix_epoch__"}]}}` → `[1789886430951227]`
 *   Option     `{Sum:{variants:[{name:"some"},{name:"none"}]}}`                        → `[1,[]]` / `[0, inner]`
 *   Array      `{Array:{U32:[]}}`                                                      → `[7,3,9]`
 *
 * So the value cannot be read without walking the schema alongside it — which is what this does.
 * Output is plain JS: numbers, strings, `null`, and **timestamps already converted to epoch ms**.
 */

import type { Json } from './coerce.ts';

export interface AlgebraicType {
  [key: string]: unknown;
}

export interface SchemaElement {
  name?: unknown;
  algebraic_type?: AlgebraicType;
}

export interface SqlResult {
  schema?: { elements?: SchemaElement[] };
  rows?: Json[][];
  error?: string;
}

const TS_FIELD = '__timestamp_micros_since_unix_epoch__';
const DURATION_FIELD = '__time_duration_micros__';
const IDENTITY_FIELD = '__identity__';

/** `{some:"kart_id"}` | `"kart_id"` | `null` → `"kart_id"` | `null`. */
export function elementName(name: unknown): string | null {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') {
    const some = (name as Record<string, unknown>).some;
    if (typeof some === 'string') return some;
  }
  return null;
}

/** The single key of a one-key type tag, e.g. `{U32:[]}` → `"U32"`. */
function typeTag(t: AlgebraicType | undefined): string | null {
  if (!t || typeof t !== 'object') return null;
  const keys = Object.keys(t);
  return keys.length >= 1 ? keys[0] : null;
}

/**
 * Decode one value against its algebraic type.
 * Unknown/missing type information falls through to the raw value, so a module change can never
 * blank the screen — worst case a field reads as its raw encoding.
 */
export function decodeValue(value: Json, type: AlgebraicType | undefined): Json {
  const tag = typeTag(type);
  if (tag === null || value === null || value === undefined) return value ?? null;

  switch (tag) {
    case 'Product': {
      const elements = ((type as Record<string, { elements?: SchemaElement[] }>).Product?.elements ??
        []) as SchemaElement[];
      const values = Array.isArray(value) ? value : [value];

      // Special-cased single-field products that are really scalars.
      if (elements.length === 1) {
        const n = elementName(elements[0]?.name);
        if (n === TS_FIELD || n === DURATION_FIELD) {
          const micros = Number(values[0] ?? value);
          return Number.isFinite(micros) ? Math.round(micros / 1000) : null;
        }
        if (n === IDENTITY_FIELD) return String(values[0] ?? value);
      }

      const obj: Record<string, Json> = {};
      elements.forEach((el, i) => {
        obj[elementName(el.name) ?? `col${i}`] = decodeValue(values[i] ?? null, el.algebraic_type);
      });
      return obj;
    }

    case 'Sum': {
      const variants = ((type as Record<string, { variants?: SchemaElement[] }>).Sum?.variants ??
        []) as SchemaElement[];
      if (!Array.isArray(value)) return value; // already-decoded or unexpected shape
      const idx = Number(value[0]);
      const variant = variants[idx];
      const name = elementName(variant?.name);
      if (name === 'none' || name === 'None') return null;
      const inner = decodeValue(value[1] ?? null, variant?.algebraic_type);
      if (name === 'some' || name === 'Some') return inner;
      // A plain enum: unit variants decode to their name, payload variants to {tag, value}.
      if (name === null) return inner;
      const isUnit =
        inner === null || (typeof inner === 'object' && Object.keys(inner as object).length === 0);
      return isUnit ? name : { tag: name, value: inner };
    }

    case 'Array': {
      const inner = (type as Record<string, AlgebraicType>).Array;
      return Array.isArray(value) ? value.map((v) => decodeValue(v, inner)) : value;
    }

    default:
      // U8…U256 / I8…I256 / F32 / F64 / Bool / String — already JSON-native.
      return value;
  }
}

/** Zip + decode a SQL result into plain objects keyed by column name. */
export function resultToObjects(result: SqlResult | undefined): Array<Record<string, Json>> {
  if (!result?.rows) return [];
  const elements = result.schema?.elements ?? [];
  return result.rows.map((row) => {
    if (!Array.isArray(row)) return (row ?? {}) as Record<string, Json>;
    const obj: Record<string, Json> = {};
    elements.forEach((el, i) => {
      obj[elementName(el.name) ?? `col${i}`] = decodeValue(row[i] ?? null, el.algebraic_type);
    });
    return obj;
  });
}
