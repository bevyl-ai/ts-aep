/**
 * Declarative field-format binding for chunk I/O.
 *
 * Each field declares its struct format via `fmt_field("B")`.
 * `_struct_info()` introspects attrs metadata to derive the combined
 * format string and field list.  Generic `Chunk.read()` / `write()`
 * use this to handle all fixed-layout chunks with zero per-class I/O code.
 */

import {
  AttrsBase,
  Factory,
  b,
  bytes_,
  concat,
  deferred,
  decode,
  encode,
  field,
  fields,
  getattr,
  int,
  lstrip,
  py_bool,
  struct,
  TypeError_,
  ValueError,
  type Attribute,
  type FieldSpec,
} from "../../pyrt/index.ts";
import { _struct_for } from "./bin_utils.ts";

const _chunk = deferred<typeof import("./chunk.ts")>("py_aep/binary/chunk");

/**
 * The value of one `fmt_field`: what `struct` unpacks for its format (a
 * number, a bigint for `q`/`Q`, a `Uint8Array` for `s`), the text an
 * `encoding` decodes it to, a `coerce` result (`bool`), or null for an
 * absent optional field. Which one depends on the format, known per field
 * only at runtime.
 */
export type FieldValue = struct.PackValue | string | _NulTailStr | null;

/** `coerce=` callable of a `fmt_field` (e.g. `bool`, applied after unpack). */
export type Coerce = (value: FieldValue) => FieldValue;

/** Decoded field values (and `chunk_type`) keyed by init-parameter name. */
export type FieldKwargs = Record<string, FieldValue>;

/** Keyword arguments for a chunk/item constructor: its field values plus an `items_field` list. */
export type InitKwargs = Record<string, FieldValue | FmtItem[]>;

export type _StructInfo = [
  string,
  readonly Attribute[],
  Map<number, string>,
  number,
  Map<number, string>,
  [string, typeof FmtItem, number] | null,
  Map<number, Coerce>,
  string[],
  boolean,
  number,
];

export const _UNSET = Symbol("_UNSET");

/**
 * The text of a fixed-size string field, read up to its first NUL,
 * that also keeps the field's raw bytes when non-zero bytes follow the
 * terminator.
 *
 * After Effects leaves such bytes behind: a renamed solid keeps the tail
 * of its previous name in its `opti`, and CSV / TXT data footage is coded
 * `"\0vsc"` / `"\0vst"` in `sspc` (AE 2026 imports). Writing the raw
 * bytes back keeps parse -\> save byte-identical; an assigned plain `str`
 * is encoded and NUL-padded as usual.
 */
export class _NulTailStr extends String {
  declare raw: Uint8Array;
}

/** Decode a fixed-size string field up to its first NUL, keeping the
 * raw bytes when a non-zero tail follows it. */
export function _decode_fixed_str(value: Uint8Array, encoding: string): string | _NulTailStr {
  const nul = bytes_.find(value, b("\x00"));
  // surrogateescape keeps byte-exact round-trips even for legacy
  // non-UTF-8 bytes in old files.
  if (nul < 0) return decode(value, encoding, "surrogateescape");
  const text = decode(value.slice(0, nul), encoding, "surrogateescape");
  if (!bytes_.strip(value.slice(nul), b("\x00"))?.length) return text;
  const tailed = new _NulTailStr(text);
  tailed.raw = value;
  return tailed;
}

/** Runs on every assignment to a fixed-size string field: anything else assigned passes through. */
export type FixedStrConverter = <T>(value: T) => T | string | _NulTailStr;

/** attrs converter for a fixed-size string field: a value holding a NUL
 * is stored as those field bytes, so it reads back as a re-parse of the
 * written file would (the text up to the NUL). */
export function _fixed_str_converter(encoding: string, size: number): FixedStrConverter {
  function convert<T>(value: T): T | string | _NulTailStr {
    if (typeof value === "string" && value.includes("\x00")) {
      const raw = encode(value, encoding, "surrogateescape").slice(0, size);
      return _decode_fixed_str(bytes_.ljust(raw, size, 0), encoding);
    }
    return value;
  }

  return convert;
}

/** `fmt_field` options for a field holding a `V`. */
export type FmtFieldOptions<V extends FieldValue = FieldValue> = {
  default?: V;
  repr?: boolean;
  encoding?: string | null;
  optional?: boolean;
  endian?: string | null;
  coerce?: ((value: FieldValue) => V) | null;
};

/**
 * Declare an attrs field with its struct format in metadata.
 *
 * @param fmt - struct format character(s) (e.g. `"B"`, `"48s"`).
 * @param kw - Options:
 * - `default`: Default value for the field. When omitted, bytes formats (`"Ns"`) default to
 *     `b"\\x00" * N` and all other formats default to `0`.
 * - `repr`: Whether to include this field in `repr()`.
 * - `encoding`: When set, the raw `bytes` from `struct.unpack` are decoded to `str` up to the first
 *     NUL, and on write the `str` is encoded back and NUL-padded to fill the fixed size (non-zero
 *     bytes read after the NUL are written back unchanged, see `_NulTailStr`).
 * - `optional`: When `true`, the field may be absent in older binary versions. Use `default=None`
 *     so that `null` means "not present" (preserves round-trip fidelity). Optional fields must come
 *     after all required fields.
 * - `endian`: Per-field byte-order override (e.g. `"<"` for little-endian). When `null` (default),
 *     the chunk-level big-endian default is used. Triggers per-field I/O in `Chunk.read()` /
 *     `Chunk.write()`.
 * - `coerce`: Type callable applied after unpacking (e.g. `bool`). On write, the inverse is applied
 *     (e.g. `int` for `bool`).
 */
export function fmt_field<V extends FieldValue>(fmt: string, kw?: FmtFieldOptions<V>): FieldSpec<V>;
export function fmt_field(fmt: string, kw: FmtFieldOptions = {}) {
  const {
    default: default_given = _UNSET,
    repr = true,
    encoding = null,
    optional = false,
    endian = null,
    coerce = null,
  } = kw;
  let default_ = default_given;
  if (default_ === _UNSET) {
    if (encoding != null) {
      default_ = "";
    } else if (fmt.endsWith("s")) {
      const n = fmt.length > 1 ? int(fmt.slice(0, -1)) : 1;
      default_ = new Uint8Array(n);
    } else {
      // Coerce so constructed chunks hold the read-time type
      // (e.g. bool_field defaults to False, not 0).
      default_ = coerce != null ? coerce(0) : 0;
    }
  }
  const md: Record<string, string | boolean | Coerce> = { fmt };
  let converter: FixedStrConverter | null = null;
  if (encoding != null) {
    md["encoding"] = encoding;
    converter = _fixed_str_converter(encoding, struct.calcsize(">" + fmt));
  }
  if (optional) md["optional"] = true;
  if (endian === "<") md["endian"] = endian;
  if (coerce != null) md["coerce"] = coerce;
  return field({ default: default_, repr, metadata: md, converter });
}

/**
 * Declare a list-of-items field that fills the remaining body bytes.
 *
 * The item count is inferred at read time: `count = remaining // item_size`.
 * Item classes must use `fmt_field()` for their fields (with `endian`
 * and `encoding` as needed) so that `_struct_info()` can auto-serialize
 * them.
 *
 * @param item_cls - Class used to deserialize each item.
 * @param item_size - Fixed byte size of each serialized item.
 */
export function items_field<T extends FmtItem>(item_cls: (new (kw: InitKwargs) => T) & typeof FmtItem, item_size: number): FieldSpec<T[]> {
  const md = {
    items: true,
    item_cls,
    item_size,
  };
  return field({ default: Factory(() => []), metadata: md });
}

// ---------------------------------------------------------------------------
// Semantic aliases for common struct formats
// ---------------------------------------------------------------------------

/** Unsigned 1-byte integer field (`struct.unpack("B")`). */
export function u1_field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field("B", kw);
}

/** Unsigned 2-byte integer field (`struct.unpack("H")`). */
export function u2_field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field("H", kw);
}

/** Unsigned 4-byte integer field (`struct.unpack("I")`). */
export function u4_field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field("I", kw);
}

/** Unsigned 8-byte integer field (`struct.unpack("Q")`). */
export function u8_field<V extends number | bigint | null = number | bigint>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field("Q", kw);
}

/** Signed 2-byte integer field (`struct.unpack("h")`). */
export function s2_field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field("h", kw);
}

/** Signed 4-byte integer field (`struct.unpack("i")`). */
export function s4_field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field("i", kw);
}

/** 4-byte IEEE 754 float field (`struct.unpack("f")`). */
export function f4_field<V extends number | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field("f", kw);
}

/** 8-byte IEEE 754 double field (`struct.unpack("d")`). */
export function f8_field<V extends number | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field("d", kw);
}

/** Fixed-size raw bytes field (`struct.unpack("Ns")`). */
export function bytes_field<V extends Uint8Array | null = Uint8Array>(n: number, kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field(`${n}s`, kw);
}

/** Fixed-size string field, decoded via `encoding`. */
export function str_field<V extends string | null = string>(
  n: number,
  kw: FmtFieldOptions<V> & { encoding?: string } = {},
): FieldSpec<NoInfer<V>> {
  const { encoding = "utf-8", ...rest } = kw;
  return fmt_field(`${n}s`, { ...rest, encoding });
}

/** Fixed-size ASCII string field. */
export function ascii_field<V extends string | null = string>(n: number, kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmt_field(`${n}s`, { ...kw, encoding: "ascii" });
}

/** 1-byte boolean field (`struct.unpack("B")`, coerced to `bool`). */
export function bool_field(kw: FmtFieldOptions<boolean> = {}): FieldSpec<boolean> {
  return fmt_field("B", { ...kw, coerce: py_bool });
}

export function _struct_info_uncached(cls: Function): _StructInfo | null {
  /**
   * Derive struct layout metadata for a chunk class.
   *
   * Returns a 10-element array `[fmt, data_fields, encodings, optional_start, endians, items_info, coerces, init_names, simple, expected_size]` or `null` for raw-bytes chunks that have neither
   * `fmt_field` nor `items_field` fields.
   *
   * - `encodings`: field-index -\> encoding name.
   * - `optional_start`: index of first optional field.
   * - `endians`: field-index -\> endian override (`"<"` or `">"`);
   *   non-empty triggers per-field I/O in `Chunk.read()` / `Chunk.write()`.
   * - `items_info`: `(init_param_name, item_cls, item_size)` or `null`.
   * - `coerces`: field-index -\> type callable (e.g. `bool`).
   * - `simple`: `true` when the chunk has no string encodings, endian
   *   overrides, optional fields, or items, so `_decode_fields` can be
   *   replaced with `dict(zip(init_names, values))` plus inline coerce
   *   and trailing-bytes handling.
   * - `expected_size`: pre-computed `struct.calcsize('>' + fmt)`.
   */
  const base_names: ReadonlySet<string> =
    cls === _chunk().Chunk || _chunk().Chunk.isPrototypeOf(cls)
      ? new Set(fields(_chunk().Chunk).map((f) => f.name))
      : new Set();
  const fmt_parts: string[] = [];
  const data_fields: Attribute[] = [];
  const encodings = new Map<number, string>();
  const endians = new Map<number, string>();
  const coerces = new Map<number, Coerce>();
  let optional_start: number | null = null;
  let items_info: [string, typeof FmtItem, number] | null = null;

  for (const f of fields(cls)) {
    if (base_names.has(f.name)) continue;
    if (f.metadata["items"]) {
      items_info = [_init_name(f.name), f.metadata["item_cls"], f.metadata["item_size"]];
      continue;
    }
    const fmt_char = f.metadata["fmt"];
    if (fmt_char != null) {
      const is_opt = f.metadata["optional"] ?? false;
      if (is_opt) {
        if (optional_start == null) optional_start = data_fields.length;
      } else if (optional_start != null) {
        throw new ValueError(`${cls.name}.${f.name}: required field after optional`);
      }
      const enc = f.metadata["encoding"];
      if (enc != null) encodings.set(data_fields.length, enc);
      const end = f.metadata["endian"];
      if (end != null) endians.set(data_fields.length, end);
      const crc = f.metadata["coerce"];
      if (crc != null) coerces.set(data_fields.length, crc);
      fmt_parts.push(fmt_char);
      data_fields.push(f);
    }
  }

  if (fmt_parts.length === 0 && items_info == null) return null;

  if (optional_start == null) optional_start = data_fields.length;

  let combined = "";
  if (fmt_parts.length > 0) {
    // Validate format/field count match at cache time
    combined = fmt_parts.join("");
    const n_values = struct
      .unpack(">" + combined, new Uint8Array(struct.calcsize(">" + combined)))
      .length;
    if (n_values !== data_fields.length) {
      throw new ValueError(
        `${cls.name}: struct format yields ${n_values} values ` +
          `but has ${data_fields.length} fmt_field fields`,
      );
    }
  }

  const init_names = data_fields.map((f) => _init_name(f.name));
  // Simple chunks have no string encodings, endian overrides, optional
  // fields, or items. Coerces are handled inline in the fast path.
  const simple =
    encodings.size === 0 &&
    endians.size === 0 &&
    items_info == null &&
    optional_start === data_fields.length;
  const expected_size = combined ? struct.calcsize(">" + combined) : 0;

  return [
    combined,
    [...data_fields],
    encodings,
    optional_start,
    endians,
    items_info,
    coerces,
    init_names,
    simple,
    expected_size,
  ];
}

const _STRUCT_INFO = new Map<Function, _StructInfo | null>();

/** `_struct_info_uncached`, cached per class (Python: `functools.lru_cache`). */
export function _struct_info(cls: Function): _StructInfo | null {
  let info = _STRUCT_INFO.get(cls);
  if (info === undefined) {
    info = _struct_info_uncached(cls);
    _STRUCT_INFO.set(cls, info);
  }
  return info;
}

/**
 * Convert attrs field name to init parameter name.
 *
 * attrs strips the leading underscore from private field names for
 * the `__init__` signature: `_trailing` -\> `trailing=`.
 */
export function _init_name(name: string): string {
  return name.startsWith("_") ? lstrip(name, "_") : name;
}

type DecodeKw = (values: readonly FieldValue[]) => FieldKwargs;
/** Keyed by a `_struct_info` entry's `init_names`, which fixes its encodings and coerces. */
const _DECODERS = new WeakMap<readonly string[], DecodeKw | null>();

/**
 * `_decode_fields` for one class as straight-line code returning an object
 * literal, so each class's kwargs keep a single shape. Null where
 * `new Function` is refused (Workers, strict CSP) or names repeat.
 */
function _compile_decoder(
  init_names: readonly string[],
  encodings: ReadonlyMap<number, string>,
  coerces: ReadonlyMap<number, Coerce>,
): DecodeKw | null {
  if (new Set(init_names).size !== init_names.length) return null;
  const encs: string[] = [];
  const fns: Coerce[] = [];
  const body = ["let x;"];
  const props: string[] = [];
  init_names.forEach((name, i) => {
    body.push(`x = v[${i}];`);
    const enc = encodings.get(i);
    if (enc != null) body.push(`if (x != null) x = D(x, E[${encs.push(enc) - 1}]);`);
    const crc = coerces.get(i);
    if (crc != null) body.push(`if (x != null) x = C[${fns.push(crc) - 1}](x);`);
    body.push(`const t${i} = x;`);
    props.push(`${JSON.stringify(name)}: t${i}`);
  });
  body.push(`return { ${props.join(", ")} };`);
  try {
    return new Function("D", "E", "C", `return (v) => {\n${body.join("\n")}\n};`)(_decode_fixed_str, encs, fns);
  } catch {
    return null;
  }
}

type EncodeFields = (self: object) => struct.PackValue[];
const _ENCODERS = new Map<_StructInfo, EncodeFields | null>();

/**
 * Every data field of `self` through `getattr` and `_encode_value`, as
 * straight-line code per class (big-endian fields only). Null where
 * `new Function` is refused (Workers, strict CSP).
 */
export function _field_encoder(info: _StructInfo): EncodeFields | null {
  let encode_fields = _ENCODERS.get(info);
  if (encode_fields === undefined) {
    const [, data_fields, encodings, , , , coerces] = info;
    const fmts: string[] = [];
    const exprs = data_fields.map((f, i) => {
      const name = JSON.stringify(f.name);
      const value = `(${name} in self ? self[${name}] : G(self, ${name}))`;
      if (!encodings.has(i) && !coerces.has(i)) return value;
      return `X(${value}, ${i}, E, C, ">", F[${fmts.push(f.metadata["fmt"]) - 1}])`;
    });
    let compiled: EncodeFields | null;
    try {
      compiled = new Function("G", "X", "E", "C", "F", `return (self) => [${exprs.join(", ")}];`)(
        getattr,
        _encode_value,
        encodings,
        coerces,
        fmts,
      );
    } catch {
      compiled = null;
    }
    _ENCODERS.set(info, (encode_fields = compiled));
  }
  return encode_fields;
}

/**
 * Decode raw struct values into init options.
 *
 * Applies encoding (bytes \> str) and coerce (e.g. int \> bool) transforms
 * declared via `fmt_field()`. Shared by `Chunk.read()` and
 * `FmtItem.frombytes()`.
 *
 * `values` is `struct`'s untyped result for the runtime format: an encoded
 * field's value is bytes only because its format is `Ns`.
 */
export function _decode_fields(
  data_fields: readonly Attribute[],
  values: struct.Unpacked<string>,
  encodings: Map<number, string>,
  coerces: Map<number, Coerce>,
  init_names: readonly string[] | null = null,
): FieldKwargs {
  if (init_names != null && values.length === init_names.length && init_names.length === data_fields.length) {
    let decode_kw = _DECODERS.get(init_names);
    if (decode_kw === undefined) {
      decode_kw = _compile_decoder(init_names, encodings, coerces);
      _DECODERS.set(init_names, decode_kw);
    }
    if (decode_kw !== null) return decode_kw(values);
  }
  const kw: FieldKwargs = {};
  const n = Math.min(data_fields.length, values.length);
  for (let i = 0; i < n; i++) {
    let value = values[i];
    const enc = encodings.get(i) ?? null;
    if (enc != null && value != null) value = _decode_fixed_str(value, enc);
    const crc = coerces.get(i);
    if (crc != null && value != null) value = crc(value);
    kw[init_names != null ? init_names[i] : _init_name(data_fields[i].name)] = value;
  }
  return kw;
}

/**
 * Encode a single field value for struct packing.
 *
 * Applies encoding (str \> null-padded bytes) and coerce reversal
 * (bool \> int) transforms. Shared by `Chunk.write()` and
 * `FmtItem.tobytes()`.
 *
 * `value` is the field read by name, so it is untyped: only the field's
 * format makes it packable as is, or `int()`-able when it is coerced.
 */
export function _encode_value(
  value: any,
  idx: number,
  encodings: Map<number, string>,
  coerces: Map<number, Coerce>,
  endian: string,
  fmt_str: string,
): struct.PackValue {
  const enc = encodings.get(idx) ?? null;
  if (enc != null) {
    const field_size = _struct_for(fmt_str, endian).size;
    if (value instanceof _NulTailStr && value.raw.length === field_size) return value.raw;
    // `String(value)` unwraps a `_NulTailStr` (a String object) to its text.
    const encoded = encode(String(value), enc, "surrogateescape").slice(0, field_size);
    return concat(encoded, new Uint8Array(field_size - encoded.length));
  }
  if (coerces.has(idx)) return int(value);
  return value;
}

/** Base for item types whose fields are declared with `fmt_field`. */
export class FmtItem extends AttrsBase {
  /** Construct an item from bytes using its `_struct_info` metadata. */
  static frombytes<T extends FmtItem>(this: (new (kw: InitKwargs) => T) & typeof FmtItem, data: Uint8Array): T {
    const info = _struct_info(this);
    if (info == null) throw new TypeError_(`${this.name} has no fmt_field metadata`);
    const [
      fmt,
      data_fields,
      encodings,
      _optional_start,
      endians,
      _items_info,
      coerces,
      init_names,
      simple,
      expected,
    ] = info;
    let values: struct.PackValue[];
    if (endians?.size > 0) {
      values = [];
      let pos = 0;
      for (const [i, f] of data_fields.entries()) {
        const fe = endians.get(i) ?? ">";
        const ff = f.metadata["fmt"];
        const f_size = struct.calcsize(fe + ff);
        const [v] = struct.unpack(fe + ff, data.slice(pos, pos + f_size));
        values.push(v);
        pos += f_size;
      }
    } else {
      values = struct.unpack(">" + fmt, data.slice(0, expected));
    }
    let kw: FieldKwargs;
    if (simple) {
      kw = {};
      for (let i = 0; i < Math.min(init_names.length, values.length); i++) kw[init_names[i]] = values[i];
      for (const [i, crc] of coerces) {
        const name = init_names[i];
        kw[name] = crc(kw[name]);
      }
    } else {
      kw = _decode_fields(data_fields, values, encodings, coerces, init_names);
    }
    return new this(kw);
  }

  /** Serialize an item to bytes using its `_struct_info` metadata. */
  tobytes(): Uint8Array {
    const info = _struct_info(this.constructor);
    if (info == null) {
      throw new TypeError_(`${this.constructor.name} has no fmt_field metadata`);
    }
    const [
      fmt,
      data_fields,
      encodings,
      _optional_start,
      endians,
      _items_info,
      coerces,
      _init_names,
      _simple,
      _expected,
    ] = info;
    if (endians?.size > 0) {
      const parts: Uint8Array[] = [];
      for (const [i, f] of data_fields.entries()) {
        const fe = endians.get(i) ?? ">";
        let value = getattr(this, f.name);
        value = _encode_value(value, i, encodings, coerces, fe, f.metadata["fmt"]);
        parts.push(struct.pack(fe + f.metadata["fmt"], value));
      }
      return bytes_.join(parts);
    }
    const encode_fields = _field_encoder(info);
    if (encode_fields !== null) return struct.pack(">" + fmt, ...encode_fields(this));
    const values: struct.PackValue[] = [];
    for (const [i, f] of data_fields.entries()) {
      let value = getattr(this, f.name);
      value = _encode_value(value, i, encodings, coerces, ">", f.metadata["fmt"]);
      values.push(value);
    }
    return struct.pack(">" + fmt, ...values);
  }
}
