/**
 * Declarative field-format binding for chunk I/O.
 *
 * Each field declares its struct format via `fmt_field("B")`.
 * `_structInfo()` introspects attrs metadata to derive the combined
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
  pyBool,
  struct,
  TypeError_,
  ValueError,
  type Attribute,
  type FieldSpec,
} from "../../pyrt/index.ts";
import { _structFor } from "./bin_utils.ts";

const _chunk = deferred<typeof import("./chunk.ts")>("py_aep/binary/chunk");

/**
 * The value of one `fmtField`: what `struct` unpacks for its format (a
 * number, a bigint for `q`/`Q`, a `Uint8Array` for `s`), the text an
 * `encoding` decodes it to, a `coerce` result (`bool`), or null for an
 * absent optional field. Which one depends on the format, known per field
 * only at runtime.
 */
export type FieldValue = struct.PackValue | string | _NulTailStr | null;

/** `coerce=` callable of a `fmtField` (e.g. `bool`, applied after unpack). */
export type Coerce = (value: FieldValue) => FieldValue;

declare module "../../pyrt/attrs.ts" {
  /** The keys `fmtField` and `itemsField` store. */
  interface Metadata {
    readonly fmt?: string;
    readonly encoding?: string;
    readonly optional?: boolean;
    readonly endian?: string;
    readonly coerce?: Coerce;
    readonly items?: boolean;
    readonly itemCls?: typeof FmtItem;
    readonly itemSize?: number;
  }
}

/** A `fmtField`: its metadata carries the struct format. */
export type FmtAttribute = Attribute & { readonly metadata: { readonly fmt: string } };

/** An `itemsField`, which always stores the item class and size. */
type ItemsAttribute = Attribute & { readonly metadata: { readonly itemCls: typeof FmtItem; readonly itemSize: number } };

function _isFmtField(f: Attribute): f is FmtAttribute {
  return f.metadata["fmt"] != null;
}

function _isItemsField(f: Attribute): f is ItemsAttribute {
  return !!f.metadata["items"];
}

/** Decoded field values (and `chunkType`) keyed by init-parameter name. */
export type FieldKwargs = Record<string, FieldValue>;

/** Keyword arguments for a chunk/item constructor: its field values plus an `itemsField` list. */
export type InitKwargs = Record<string, FieldValue | FmtItem[]>;

export type _StructInfo = [
  string,
  readonly FmtAttribute[],
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
export function _decodeFixedStr(value: Uint8Array, encoding: string): string | _NulTailStr {
  const nul = value.indexOf(0);
  // surrogateescape keeps byte-exact round-trips even for legacy
  // non-UTF-8 bytes in old files.
  if (nul < 0) return decode(value, encoding, "surrogateescape");
  const text = decode(value.subarray(0, nul), encoding, "surrogateescape");
  let tail = nul + 1;
  while (tail < value.length && value[tail] === 0) tail++;
  if (tail === value.length) return text;
  const tailed = new _NulTailStr(text);
  tailed.raw = value;
  return tailed;
}

/** Runs on every assignment to a fixed-size string field: anything else assigned passes through. */
export type FixedStrConverter = <T>(value: T) => T | string | _NulTailStr;

/** attrs converter for a fixed-size string field: a value holding a NUL
 * is stored as those field bytes, so it reads back as a re-parse of the
 * written file would (the text up to the NUL). */
export function _fixedStrConverter(encoding: string, size: number): FixedStrConverter {
  function convert<T>(value: T): T | string | _NulTailStr {
    if (typeof value === "string" && value.includes("\x00")) {
      const raw = encode(value, encoding, "surrogateescape").slice(0, size);
      return _decodeFixedStr(bytes_.ljust(raw, size, 0), encoding);
    }
    return value;
  }

  return convert;
}

/** `fmtField` options for a field holding a `V`. */
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
export function fmtField<V extends FieldValue>(fmt: string, kw?: FmtFieldOptions<V>): FieldSpec<V>;
export function fmtField(fmt: string, kw: FmtFieldOptions = {}) {
  const {
    default: defaultGiven = _UNSET,
    repr = true,
    encoding = null,
    optional = false,
    endian = null,
    coerce = null,
  } = kw;
  let default_ = defaultGiven;
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
    converter = _fixedStrConverter(encoding, struct.calcsize(">" + fmt));
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
 * Item classes must use `fmtField()` for their fields (with `endian`
 * and `encoding` as needed) so that `_structInfo()` can auto-serialize
 * them.
 *
 * @param itemCls - Class used to deserialize each item.
 * @param itemSize - Fixed byte size of each serialized item.
 */
export function itemsField<T extends FmtItem>(itemCls: (new (kw: InitKwargs) => T) & typeof FmtItem, itemSize: number): FieldSpec<T[]> {
  const md = {
    items: true,
    itemCls: itemCls,
    itemSize: itemSize,
  };
  return field({ default: Factory(() => []), metadata: md });
}

// ---------------------------------------------------------------------------
// Semantic aliases for common struct formats
// ---------------------------------------------------------------------------

/** Unsigned 1-byte integer field (`struct.unpack("B")`). */
export function u1Field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField("B", kw);
}

/** Unsigned 2-byte integer field (`struct.unpack("H")`). */
export function u2Field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField("H", kw);
}

/** Unsigned 4-byte integer field (`struct.unpack("I")`). */
export function u4Field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField("I", kw);
}

/** Unsigned 8-byte integer field (`struct.unpack("Q")`). */
export function u8Field<V extends number | bigint | null = number | bigint>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField("Q", kw);
}

/** Signed 2-byte integer field (`struct.unpack("h")`). */
export function s2Field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField("h", kw);
}

/** Signed 4-byte integer field (`struct.unpack("i")`). */
export function s4Field<V extends number | boolean | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField("i", kw);
}

/** 4-byte IEEE 754 float field (`struct.unpack("f")`). */
export function f4Field<V extends number | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField("f", kw);
}

/** 8-byte IEEE 754 double field (`struct.unpack("d")`). */
export function f8Field<V extends number | null = number>(kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField("d", kw);
}

/** Fixed-size raw bytes field (`struct.unpack("Ns")`). */
export function bytesField<V extends Uint8Array | null = Uint8Array>(n: number, kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField(`${n}s`, kw);
}

/** Fixed-size string field, decoded via `encoding`. */
export function strField<V extends string | null = string>(
  n: number,
  kw: FmtFieldOptions<V> & { encoding?: string } = {},
): FieldSpec<NoInfer<V>> {
  const { encoding = "utf-8", ...rest } = kw;
  return fmtField(`${n}s`, { ...rest, encoding });
}

/** Fixed-size ASCII string field. */
export function asciiField<V extends string | null = string>(n: number, kw: FmtFieldOptions<V> = {}): FieldSpec<NoInfer<V>> {
  return fmtField(`${n}s`, { ...kw, encoding: "ascii" });
}

/** 1-byte boolean field (`struct.unpack("B")`, coerced to `bool`). */
export function boolField(kw: FmtFieldOptions<boolean> = {}): FieldSpec<boolean> {
  return fmtField("B", { ...kw, coerce: pyBool });
}

export function _structInfoUncached(cls: Function): _StructInfo | null {
  /**
   * Derive struct layout metadata for a chunk class.
   *
   * Returns a 10-element array `[fmt, data_fields, encodings, optional_start, endians, items_info, coerces, init_names, simple, expected_size]` or `null` for raw-bytes chunks that have neither
   * `fmtField` nor `itemsField` fields.
   *
   * - `encodings`: field-index -\> encoding name.
   * - `optionalStart`: index of first optional field.
   * - `endians`: field-index -\> endian override (`"<"` or `">"`);
   *   non-empty triggers per-field I/O in `Chunk.read()` / `Chunk.write()`.
   * - `itemsInfo`: `(init_param_name, item_cls, item_size)` or `null`.
   * - `coerces`: field-index -\> type callable (e.g. `bool`).
   * - `simple`: `true` when the chunk has no string encodings, endian
   *   overrides, optional fields, or items, so `_decodeFields` can be
   *   replaced with `dict(zip(init_names, values))` plus inline coerce
   *   and trailing-bytes handling.
   * - `expectedSize`: pre-computed `struct.calcsize('>' + fmt)`.
   */
  const baseNames: ReadonlySet<string> =
    cls === _chunk().Chunk || _chunk().Chunk.isPrototypeOf(cls)
      ? new Set(fields(_chunk().Chunk).map((f) => f.name))
      : new Set();
  const fmtParts: string[] = [];
  const dataFields: FmtAttribute[] = [];
  const encodings = new Map<number, string>();
  const endians = new Map<number, string>();
  const coerces = new Map<number, Coerce>();
  let optionalStart: number | null = null;
  let itemsInfo: [string, typeof FmtItem, number] | null = null;

  for (const f of fields(cls)) {
    if (baseNames.has(f.name)) continue;
    if (_isItemsField(f)) {
      itemsInfo = [_initName(f.name), f.metadata["itemCls"], f.metadata["itemSize"]];
      continue;
    }
    if (_isFmtField(f)) {
      const fmtChar = f.metadata["fmt"];
      const isOpt = f.metadata["optional"] ?? false;
      if (isOpt) {
        if (optionalStart == null) optionalStart = dataFields.length;
      } else if (optionalStart != null) {
        throw new ValueError(`${cls.name}.${f.name}: required field after optional`);
      }
      const enc = f.metadata["encoding"];
      if (enc != null) encodings.set(dataFields.length, enc);
      const end = f.metadata["endian"];
      if (end != null) endians.set(dataFields.length, end);
      const crc = f.metadata["coerce"];
      if (crc != null) coerces.set(dataFields.length, crc);
      fmtParts.push(fmtChar);
      dataFields.push(f);
    }
  }

  if (fmtParts.length === 0 && itemsInfo == null) return null;

  if (optionalStart == null) optionalStart = dataFields.length;

  let combined = "";
  if (fmtParts.length > 0) {
    // Validate format/field count match at cache time
    combined = fmtParts.join("");
    const nValues = struct
      .unpack(">" + combined, new Uint8Array(struct.calcsize(">" + combined)))
      .length;
    if (nValues !== dataFields.length) {
      throw new ValueError(
        `${cls.name}: struct format yields ${nValues} values ` +
          `but has ${dataFields.length} fmtField fields`,
      );
    }
  }

  const initNames = dataFields.map((f) => _initName(f.name));
  // Simple chunks have no string encodings, endian overrides, optional
  // fields, or items. Coerces are handled inline in the fast path.
  const simple =
    encodings.size === 0 &&
    endians.size === 0 &&
    itemsInfo == null &&
    optionalStart === dataFields.length;
  const expectedSize = combined ? struct.calcsize(">" + combined) : 0;

  return [
    combined,
    [...dataFields],
    encodings,
    optionalStart,
    endians,
    itemsInfo,
    coerces,
    initNames,
    simple,
    expectedSize,
  ];
}

const _STRUCT_INFO = new Map<Function, _StructInfo | null>();

/** `_structInfoUncached`, cached per class (Python: `functools.lru_cache`). */
export function _structInfo(cls: Function): _StructInfo | null {
  let info = _STRUCT_INFO.get(cls);
  if (info === undefined) {
    info = _structInfoUncached(cls);
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
export function _initName(name: string): string {
  return name.startsWith("_") ? lstrip(name, "_") : name;
}

type DecodeKw = (values: readonly FieldValue[]) => FieldKwargs;
/** Keyed by a `_structInfo` entry's `initNames`, which fixes its encodings and coerces. */
const _DECODERS = new WeakMap<readonly string[], DecodeKw | null>();

/**
 * `_decodeFields` for one class as straight-line code returning an object
 * literal, so each class's kwargs keep a single shape. Null where
 * `new Function` is refused (Workers, strict CSP) or names repeat.
 */
function _compileDecoder(
  initNames: readonly string[],
  encodings: ReadonlyMap<number, string>,
  coerces: ReadonlyMap<number, Coerce>,
): DecodeKw | null {
  if (new Set(initNames).size !== initNames.length) return null;
  const encs: string[] = [];
  const fns: Coerce[] = [];
  const body = ["let x;"];
  const props: string[] = [];
  initNames.forEach((name, i) => {
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
    return new Function("D", "E", "C", `return (v) => {\n${body.join("\n")}\n};`)(_decodeFixedStr, encs, fns);
  } catch {
    return null;
  }
}

type EncodeFields = (self: object) => struct.PackValue[];
const _ENCODERS = new Map<_StructInfo, EncodeFields | null>();

/**
 * Every data field of `self` through `getattr` and `_encodeValue`, as
 * straight-line code per class (big-endian fields only). Null where
 * `new Function` is refused (Workers, strict CSP).
 */
export function _fieldEncoder(info: _StructInfo): EncodeFields | null {
  let encodeFields = _ENCODERS.get(info);
  if (encodeFields === undefined) {
    const [, dataFields, encodings, , , , coerces] = info;
    const fmts: string[] = [];
    const exprs = dataFields.map((f, i) => {
      const name = JSON.stringify(f.name);
      const value = `(${name} in self ? self[${name}] : G(self, ${name}))`;
      if (!encodings.has(i) && !coerces.has(i)) return value;
      return `X(${value}, ${i}, E, C, ">", F[${fmts.push(f.metadata["fmt"]) - 1}])`;
    });
    let compiled: EncodeFields | null;
    try {
      compiled = new Function("G", "X", "E", "C", "F", `return (self) => [${exprs.join(", ")}];`)(
        getattr,
        _encodeValue,
        encodings,
        coerces,
        fmts,
      );
    } catch {
      compiled = null;
    }
    _ENCODERS.set(info, (encodeFields = compiled));
  }
  return encodeFields;
}

/**
 * Decode raw struct values into init options.
 *
 * Applies encoding (bytes \> str) and coerce (e.g. int \> bool) transforms
 * declared via `fmtField()`. Shared by `Chunk.read()` and
 * `FmtItem.frombytes()`.
 *
 * `values` is `struct`'s untyped result for the runtime format: an encoded
 * field's value is bytes only because its format is `Ns`.
 */
export function _decodeFields(
  dataFields: readonly FmtAttribute[],
  values: struct.Unpacked<string>,
  encodings: Map<number, string>,
  coerces: Map<number, Coerce>,
  initNames: readonly string[] | null = null,
): FieldKwargs {
  if (initNames != null && values.length === initNames.length && initNames.length === dataFields.length) {
    let decodeKw = _DECODERS.get(initNames);
    if (decodeKw === undefined) {
      decodeKw = _compileDecoder(initNames, encodings, coerces);
      _DECODERS.set(initNames, decodeKw);
    }
    if (decodeKw !== null) return decodeKw(values);
  }
  const kw: FieldKwargs = {};
  const n = Math.min(dataFields.length, values.length);
  for (let i = 0; i < n; i++) {
    let value = values[i];
    const enc = encodings.get(i) ?? null;
    if (enc != null && value != null) value = _decodeFixedStr(value, enc);
    const crc = coerces.get(i);
    if (crc != null && value != null) value = crc(value);
    kw[initNames != null ? initNames[i] : _initName(dataFields[i].name)] = value;
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
export function _encodeValue(
  value: any,
  idx: number,
  encodings: Map<number, string>,
  coerces: Map<number, Coerce>,
  endian: string,
  fmtStr: string,
): struct.PackValue {
  const enc = encodings.get(idx) ?? null;
  if (enc != null) {
    const fieldSize = _structFor(fmtStr, endian).size;
    if (value instanceof _NulTailStr && value.raw.length === fieldSize) return value.raw;
    // `String(value)` unwraps a `_NulTailStr` (a String object) to its text.
    const encoded = encode(String(value), enc, "surrogateescape");
    const out = new Uint8Array(fieldSize);
    out.set(encoded.length > fieldSize ? encoded.subarray(0, fieldSize) : encoded);
    return out;
  }
  if (coerces.has(idx)) return int(value);
  return value;
}

/** Base for item types whose fields are declared with `fmtField`. */
export class FmtItem extends AttrsBase {
  /** Construct an item from bytes using its `_structInfo` metadata. */
  static frombytes<T extends FmtItem>(this: (new (kw: InitKwargs) => T) & typeof FmtItem, data: Uint8Array): T {
    const info = _structInfo(this);
    if (info == null) throw new TypeError_(`${this.name} has no fmtField metadata`);
    const [
      fmt,
      dataFields,
      encodings,
      _optionalStart,
      endians,
      _itemsInfo,
      coerces,
      initNames,
      simple,
      expected,
    ] = info;
    let values: struct.PackValue[];
    if (endians?.size > 0) {
      values = [];
      let pos = 0;
      for (const [i, f] of dataFields.entries()) {
        const fe = endians.get(i) ?? ">";
        const ff = f.metadata["fmt"];
        const s = _structFor(ff, fe);
        const fSize = s.size;
        const [v] = s.unpack(data.subarray(pos, pos + fSize));
        values.push(v);
        pos += fSize;
      }
    } else {
      values = _structFor(fmt).unpack(data.subarray(0, expected));
    }
    let kw: FieldKwargs;
    if (simple) {
      kw = {};
      for (let i = 0; i < Math.min(initNames.length, values.length); i++) kw[initNames[i]] = values[i];
      for (const [i, crc] of coerces) {
        const name = initNames[i];
        kw[name] = crc(kw[name]);
      }
    } else {
      kw = _decodeFields(dataFields, values, encodings, coerces, initNames);
    }
    return new this(kw);
  }

  /** Serialize an item to bytes using its `_structInfo` metadata. */
  tobytes(): Uint8Array {
    const info = _structInfo(this.constructor);
    if (info == null) {
      throw new TypeError_(`${this.constructor.name} has no fmtField metadata`);
    }
    const [
      fmt,
      dataFields,
      encodings,
      _optionalStart,
      endians,
      _itemsInfo,
      coerces,
      _initNames,
      _simple,
      _expected,
    ] = info;
    if (endians?.size > 0) {
      const parts: Uint8Array[] = [];
      for (const [i, f] of dataFields.entries()) {
        const fe = endians.get(i) ?? ">";
        let value = getattr(this, f.name);
        value = _encodeValue(value, i, encodings, coerces, fe, f.metadata["fmt"]);
        parts.push(_structFor(f.metadata["fmt"], fe).pack(value));
      }
      return bytes_.join(parts);
    }
    const encodeFields = _fieldEncoder(info);
    if (encodeFields !== null) return _structFor(fmt).pack(...encodeFields(this));
    const values: struct.PackValue[] = [];
    for (const [i, f] of dataFields.entries()) {
      let value = getattr(this, f.name);
      value = _encodeValue(value, i, encodings, coerces, ">", f.metadata["fmt"]);
      values.push(value);
    }
    return _structFor(fmt).pack(...values);
  }
}
