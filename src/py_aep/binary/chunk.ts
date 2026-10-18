/**
 * AEP chunk hierarchy, recursive I/O, context resolvers, and file I/O.
 *
 * Everything lives in one file to avoid import cycles between ListChunk and
 * the recursive reader/writer.
 */

import { INSPECT } from "../../pyrt/index.ts";
import {
  AttrsBase,
  BytesIO,
  ContextVar,
  Factory,
  NO_INIT,
  OSError,
  StopIteration,
  ValueError,
  attrsEq,
  b,
  bytes_,
  decode,
  define,
  encode,
  field,
  fields,
  floordiv,
  getattr,
  hasattr,
  pyEq,
  pyOr,
  repr,
  struct,
  type ClassAttributes,
  type IO,
} from "../../pyrt/index.ts";
import { _structFor, readBytes, readFmt, readPad, writeBytes, writePad } from "./bin_utils.ts";
import { _decodeFields, _encodeValue, _fieldEncoder, _structInfo, type Coerce, type FieldKwargs, type FieldValue, type FmtAttribute, type FmtItem, type InitKwargs } from "./fmt_field.ts";
import { CHUNK_TYPES, register, registered } from "./registry.ts";
import type { HeadChunk } from "./item_chunks.ts";
import type { LdatItemType } from "./ldat_chunks.ts";

const _PREFIX_STRUCTS = new WeakMap<readonly FmtAttribute[], struct.Struct[]>();

/** Big-endian struct for the first `n` of `data_fields`. */
function _prefixStruct(dataFields: readonly FmtAttribute[], n: number): struct.Struct {
  let byN = _PREFIX_STRUCTS.get(dataFields);
  if (byN === undefined) _PREFIX_STRUCTS.set(dataFields, (byN = []));
  return (byN[n] ??= _structFor(dataFields.slice(0, n).map((f) => f.metadata["fmt"]).join("")));
}

/** The required-field format and each optional field's format and size. */
type OptionalLayout = { req_fmt: string | null; req_size: number; optional: [fmt: string, size: number][] };
const _OPTIONAL_LAYOUTS = new WeakMap<readonly FmtAttribute[], OptionalLayout>();

function _optionalLayout(dataFields: readonly FmtAttribute[], optionalStart: number): OptionalLayout {
  let layout = _OPTIONAL_LAYOUTS.get(dataFields);
  if (layout === undefined) {
    const reqParts = dataFields.slice(0, optionalStart).map((f) => f.metadata["fmt"]);
    const reqFmt = reqParts.length ? reqParts.join("") : null;
    layout = {
      req_fmt: reqFmt,
      req_size: reqFmt !== null ? struct.calcsize(">" + reqFmt) : 0,
      optional: dataFields.slice(optionalStart).map((f) => [f.metadata["fmt"], struct.calcsize(">" + f.metadata["fmt"])]),
    };
    _OPTIONAL_LAYOUTS.set(dataFields, layout);
  }
  return layout;
}

type SimpleKw = (values: readonly FieldValue[], chunkType: string) => FieldKwargs;
const _SIMPLE_KW = new WeakMap<Function, SimpleKw | null>();

/**
 * The simple-path `cls(**kw)` keywords as one object literal, so each class's
 * kwargs keep a single shape. Null where `new Function` is refused (Workers,
 * strict CSP) or the names don't map one-to-one onto keys.
 */
function _compileSimpleKw(initNames: readonly string[], coerces: ReadonlyMap<number, Coerce>): SimpleKw | null {
  if (new Set(initNames).size !== initNames.length || initNames.includes("chunk_type")) return null;
  const fns: Coerce[] = [];
  const props = initNames.map((name, i) => {
    const crc = coerces.get(i);
    const key = JSON.stringify(name);
    if (crc === undefined) return `${key}: v[${i}]`;
    return `${key}: f[${fns.push(crc) - 1}](v[${i}])`;
  });
  try {
    return new Function("f", `return (v, t) => ({ ${props.join(", ")}, chunk_type: t });`)(fns);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chunk base (also serves as fallback for unregistered types)
// ---------------------------------------------------------------------------

/**
 * Concrete base for all AEP chunks.
 *
 * Stores unparsed body bytes in `data`. Typed subclasses override
 * `read()` / `write()` to interpret the body.
 */
export class Chunk extends AttrsBase {
  declare chunk_type: string;
  declare data: Uint8Array;
  declare synthetic: boolean;
  declare _trailing: Uint8Array;

  /** Whether `read` takes the nesting context `read_chunks` passes. */
  static _nests = false;

  static read(fp: IO, size: number, kwargs: ChunkReadKwargs = {}): Chunk {
    const { chunk_type = "" } = kwargs;
    const cls = this;
    // Get fields
    const info = _structInfo(cls);
    if (info == null) {
      const data = readBytes(fp, size);
      return new cls({ chunk_type, data });
    }
    const [
      fmt,
      dataFields,
      encodings,
      optionalStart,
      endians,
      itemsInfo,
      coerces,
      initNames,
      simple,
      expected,
    ] = info;
    const mixedEndian = endians?.size > 0;

    if (simple && size >= expected) {
      // Fast path: no string encodings, endian overrides, optional
      // fields, or items. dict(zip()) replaces the _decode_fields
      // Python loop. Coerces (e.g. bool_field) are handled inline.
      const values = readFmt(fmt, fp);
      let make = _SIMPLE_KW.get(cls);
      if (make === undefined) {
        make = values.length === initNames.length ? _compileSimpleKw(initNames, coerces) : null;
        _SIMPLE_KW.set(cls, make);
      }
      let kw: FieldKwargs;
      if (make !== null) {
        kw = make(values, chunk_type);
      } else {
        kw = {};
        const n = Math.min(initNames.length, values.length);
        for (let i = 0; i < n; i++) kw[initNames[i]] = values[i];
        kw.chunk_type = chunk_type;
        for (const [i, crc] of coerces) {
          const name = initNames[i];
          kw[name] = crc(kw[name]);
        }
      }
      const trailingSize = size - expected;
      if (trailingSize > 0) {
        const extra = readBytes(fp, trailingSize);
        const instance = new cls(kw);
        instance._trailing = extra;
        return instance;
      }
      return new cls(kw);
    }

    let values: (struct.PackValue | null)[];
    let itemsStart: number;
    if (mixedEndian) {
      // Per-field read: each field may have its own endian prefix
      values = [];
      let remainingMe = size;
      for (const [i, f] of dataFields.entries()) {
        const fe = endians.get(i) ?? ">";
        const ff = f.metadata["fmt"];
        const s = _structFor(ff, fe);
        const fSize = s.size;
        if (remainingMe >= fSize) {
          const [v] = s.unpack(fp.read(fSize));
          values.push(v);
          remainingMe -= fSize;
        } else if (i < optionalStart) {
          throw new OSError(
            `${chunk_type} body too short: expected >= ` +
              `${size - remainingMe + fSize} bytes, got ${size}`,
          );
        } else {
          break;
        }
      }
      while (values.length < dataFields.length) values.push(null);
      itemsStart = size - remainingMe;
    } else if (size >= expected) {
      // Fast path: all bytes present (common case)
      values = fmt ? [...readFmt(fmt, fp)] : [];
      itemsStart = expected;
    } else {
      const { req_fmt, req_size, optional } = _optionalLayout(dataFields, optionalStart);
      if (size < req_size) {
        throw new OSError(
          `${chunk_type} body too short: expected >= ${req_size} ` +
            `bytes, got ${size}`,
        );
      }
      values = req_fmt !== null ? [...readFmt(req_fmt, fp)] : [];
      let remaining = size - req_size;
      for (const [fFmt, fSize] of optional) {
        if (remaining >= fSize) {
          values.push(...readFmt(fFmt, fp));
          remaining -= fSize;
        } else {
          break;
        }
      }
      // Remaining optional fields get None (absent)
      while (values.length < dataFields.length) values.push(null);
      itemsStart = size - remaining;
    }

    const kw2: InitKwargs = _decodeFields(dataFields, values, encodings, coerces, initNames);
    kw2.chunk_type = chunk_type;
    let extraTrailing: Uint8Array | null = null;
    if (itemsInfo != null) {
      const [itemsName, itemCls, itemSize] = itemsInfo;
      const itemsBytes = size - itemsStart;
      const count = floordiv(itemsBytes, itemSize);
      const fmtCls = itemCls;
      const items: FmtItem[] = [];
      for (let n = 0; n < count; n++) {
        items.push(fmtCls.frombytes(fp.read(itemSize)));
      }
      kw2[itemsName] = items;
      const rest = itemsBytes - count * itemSize;
      if (rest > 0) extraTrailing = readBytes(fp, rest);
    } else if (size > itemsStart) {
      extraTrailing = readBytes(fp, size - itemsStart);
    }
    const instance = new cls(kw2);
    if (extraTrailing != null) instance._trailing = extraTrailing;
    return instance;
  }

  write(fp: IO): number {
    const info = _structInfo(this.constructor);
    if (info == null) return writeBytes(fp, this.data);
    const [
      fmt,
      dataFields,
      encodings,
      optionalStart,
      endians,
      itemsInfo,
      coerces,
      _initNames,
      _simple,
      _expected,
    ] = info;
    const mixedEndian = endians?.size > 0;

    // Find last non-None optional field to determine write boundary
    let lastIdx = dataFields.length;
    if (optionalStart < dataFields.length) {
      lastIdx = optionalStart;
      for (let i = dataFields.length - 1; i >= optionalStart; i--) {
        if (getattr(this, dataFields[i].name) != null) {
          lastIdx = i + 1;
          break;
        }
      }
    }

    let written: number;
    if (mixedEndian) {
      // Per-field write: each field may have its own endian prefix
      written = 0;
      for (let i = 0; i < lastIdx; i++) {
        const f = dataFields[i];
        const fe = endians.get(i) ?? ">";
        let value = getattr(this, f.name);
        value = _encodeValue(value, i, encodings, coerces, fe, f.metadata["fmt"]);
        written += fp.pack(_structFor(f.metadata["fmt"], fe), [value]);
      }
    } else {
      const encodeFields = lastIdx === dataFields.length ? _fieldEncoder(info) : null;
      const values: struct.PackValue[] = encodeFields !== null ? encodeFields(this) : [];
      for (let i = values.length; i < lastIdx; i++) {
        const f = dataFields[i];
        let value = getattr(this, f.name);
        value = _encodeValue(value, i, encodings, coerces, ">", f.metadata["fmt"]);
        values.push(value);
      }
      written = lastIdx ? fp.pack(_prefixStruct(dataFields, lastIdx), values) : 0;
    }

    if (itemsInfo != null) {
      const itemsName = itemsInfo[0];
      for (const item of getattr(this, itemsName)) {
        written += writeBytes(fp, item.tobytes());
      }
    }
    if (this._trailing?.length > 0) written += writeBytes(fp, this._trailing);
    return written;
  }

  static frombytes(data: Uint8Array, kwargs: ChunkReadKwargs = {}): Chunk {
    /** Parse a chunk body from raw bytes. */
    const f = new BytesIO(data);
    return this.read(f, data.length, kwargs);
  }

  tobytes(): Uint8Array {
    /** Serialize the chunk body to bytes. */
    const f = new BytesIO();
    this.write(f);
    return f.getvalue();
  }

  equals(other: unknown): boolean {
    // attrs-generated `__eq__`: eq=True fields, compared with Python equality.
    return attrsEq(this, other, pyEq);
  }

  [INSPECT](): string {
    // attrs-generated `__repr__`: repr=True fields in declaration order.
    const parts = fields(this.constructor).filter((f) => f.repr).map((f) => `${f.name}=${repr(Reflect.get(this, f.name))}`);
    return `${this.constructor.name}(${parts.join(", ")})`;
  }
}

define(Chunk, {
  chunk_type: field({ default: "" }),
  data: field({ default: b("") }),
  synthetic: field({ default: false, repr: false }),
  _trailing: field({ default: b(""), repr: false, eq: false, init: false }),
});

/** LIST or RIFX container chunk.
 *
 * Children are stored in `chunks`. The `list_type` is the 4-byte subtype
 * (e.g. "Fold", "Layr", "Egg!"). For btdk lists, raw binary data is stored
 * in inherited `data` instead of parsed children.
 *
 * RIFX is structurally identical to LIST - same binary format (4-byte
 * list_type + child chunks). The only difference is chunk_type="RIFX".
 */
export class ListChunk extends Chunk {
  declare list_type: string;
  declare chunks: Chunk[];
  declare chunk_type: string;

  static _nests = true;

  static read(
    fp: IO,
    size: number,
    kwargs: ChunkReadKwargs = {},
  ): ListChunk {
    const { chunk_type = "LIST", defer_list_types = null } = kwargs;
    if (size < 4) throw new OSError(`${chunk_type} body too small: ${size}`);
    const ctx = kwargs.ctx ?? EMPTY_CTX;
    const listType = _typeName(readFmt("I", fp)[0]);
    if (listType === "btdk") {
      const data = readBytes(fp, size - 4);
      return new this({ list_type: listType, data, chunk_type });
    }
    const parentResult = kwargs.parent_result ?? null;
    const childCtx = new ReadContext(listType, ctx.parent_list_type, parentResult);
    if (defer_list_types != null && defer_list_types.size > 0 && defer_list_types.has(listType)) {
      const rawBody = fp.read(size - 4);
      return new DeferredListChunk({
        chunk_type,
        list_type: listType,
        raw_body: rawBody,
        raw_ctx: childCtx,
      });
    }
    const chunks = readChunks(fp, size - 4, {
      ctx: childCtx,
      defer_list_types,
    });
    return new this({
      list_type: listType,
      chunks,
      chunk_type,
    });
  }

  [Symbol.iterator](): Iterator<Chunk> {
    return this.chunks[Symbol.iterator]();
  }

  get length(): number {
    return this.chunks.length;
  }

  write(fp: IO): number {
    let written = writeBytes(fp, encode(this.list_type, "ASCII"));
    if (this.list_type === "btdk") {
      written += writeBytes(fp, this.data);
    } else {
      for (const chunk of this.chunks) {
        if (chunk.synthetic) continue;
        written += writeChunk(fp, chunk);
      }
    }
    return written;
  }
}

define(ListChunk, {
  list_type: field({ default: "" }),
  chunks: field({ default: Factory(() => []) }),
  chunk_type: field({ default: "LIST" }),
});
register("LIST", "RIFX")(ListChunk);

export const _TDGP: ReadonlySet<string> = new Set(["tdgp"]);

/**
 * The children a deferred LIST keeps deferred in turn once decoded.
 *
 * A layer's property tree (its root `tdgp`) waits until its properties
 * are read, and decoding that root leaves each top-level group (Transform,
 * Effects, Masks, ...) to its own first access: the root's direct
 * properties, such as Time Remapping, are then readable on their own.
 */
export function _deferredChildren(listType: string, parentListType: string): ReadonlySet<string> | null {
  if (listType === "Layr" || (listType === "tdgp" && parentListType === "Layr")) {
    return _TDGP;
  }
  return null;
}

/**
 * A LIST chunk whose children are parsed lazily from stored raw bytes.
 *
 * Inherits from `ListChunk` so all isinstance checks pass. The `chunks`
 * property triggers parsing on first access. If the chunks are never
 * accessed, `write()` writes the raw bytes directly (no parse needed).
 */
export class DeferredListChunk extends ListChunk {
  // Python `__slots__` is dropped: these are plain instance fields.
  declare _raw_body: Uint8Array;
  declare _raw_ctx: ReadContext | null;
  declare _parsed_chunks: Chunk[] | null;

  constructor(
    kwargs: {
      chunk_type?: string;
      list_type?: string;
      raw_body?: Uint8Array;
      raw_ctx?: ReadContext | null;
    } = {},
  ) {
    super(NO_INIT);
    const {
      chunk_type = "LIST",
      list_type = "",
      raw_body = b(""),
      raw_ctx = null,
    } = kwargs;
    this.chunk_type = chunk_type;
    this.list_type = list_type;
    this.data = b("");
    this.synthetic = false;
    this._raw_body = raw_body;
    this._raw_ctx = raw_ctx;
    this._parsed_chunks = null;
  }

  /** Whether `chunks` was accessed or assigned (the raw body is gone). */
  get is_parsed(): boolean {
    return this._parsed_chunks != null;
  }

  write(fp: IO): number {
    let written = writeBytes(fp, encode(this.list_type, "ASCII"));
    if (this._parsed_chunks == null) {
      // Never accessed - write raw bytes directly (fast path).
      written += writeBytes(fp, this._raw_body);
    } else {
      for (const chunk of this._parsed_chunks) {
        if (chunk.synthetic) continue;
        written += writeChunk(fp, chunk);
      }
    }
    return written;
  }
}

// `chunks` is a property on ListChunk; TS forbids overriding it with an accessor
// in the class body, so the Python `@property` pair is installed on the prototype.
Object.defineProperty(DeferredListChunk.prototype, "chunks", {
  configurable: true,
  get(this: DeferredListChunk): Chunk[] {
    let parsed = this._parsed_chunks;
    if (parsed == null) {
      const body = this._raw_body;
      const ctx = this._raw_ctx || EMPTY_CTX;
      parsed = readChunks(new BytesIO(body), body.length, {
        ctx,
        defer_list_types: _deferredChildren(this.list_type, ctx.grandparent_list_type),
      });
      this._parsed_chunks = parsed;
      this._raw_body = b("");
      this._raw_ctx = null;
    }
    return parsed;
  },
  set(this: DeferredListChunk, value: Chunk[]) {
    this._parsed_chunks = value;
    this._raw_body = b("");
  },
});

/**
 * Non-LIST chunk whose body contains child chunks without a list_type.
 *
 * Used for fnam, pdnm, RCom (and tdsn via the `TdsnChunk` subclass) -
 * wrapper chunks that hold a single Utf8 child (or similar). Unlike
 * ListChunk, there is no 4-byte list_type prefix in the binary data.
 *
 * Older projects (AE CC 12.0) write the string itself as the body,
 * NUL-terminated, instead of a Utf8 child: such a body keeps its bytes
 * in `data` and stands its string in as a synthetic Utf8 child (see
 * `_read_legacy`).
 */
export class ContainerChunk extends Chunk {
  declare ["constructor"]: ClassAttributes<typeof ContainerChunk>;
  declare chunks: Chunk[];

  static _nests = true;

  static read(
    fp: IO,
    size: number,
    kwargs: ChunkReadKwargs = {},
  ): ContainerChunk {
    const { chunk_type = "" } = kwargs;
    const ctx = kwargs.ctx ?? EMPTY_CTX;
    if (!_tilesAsChunks(fp, size)) {
      return this._read_legacy(fp, size, { chunk_type });
    }
    const defer = kwargs.defer_list_types ?? null;
    // Pass-through context (no list_type level change)
    const chunks = readChunks(fp, size, { ctx, defer_list_types: defer });
    return new this({ chunk_type, chunks });
  }

  static _read_legacy(fp: IO, size: number, kwargs: { chunk_type: string }): ContainerChunk {
    /**
     * A body holding the string itself, as older projects write it: NUL
     * terminated, in a buffer sized to it (a `tdsn` of a lone zero byte, a
     * `pdnm`) or of a fixed size (a 48-byte `fnam`), where newer ones wrap
     * it in a `Utf8` child. The bytes are kept to be written back as they
     * were; the string is a synthetic `Utf8` child, for the readers.
     */
    const { chunk_type } = kwargs;
    const data = readBytes(fp, size);
    // Registry lookup instead of a deferred import: scalar_chunks imports Chunk
    // from this module, which imports the chunk modules only once Chunk is defined.
    const Utf8Chunk = registered("Utf8");
    const utf8 = new Utf8Chunk({
      value: this._legacy_value(_legacyText(data)),
      synthetic: true,
    });
    return new this({ chunk_type, data, chunks: [utf8] });
  }

  /** The `Utf8` value standing for a legacy body's string. */
  static _legacy_value(text: string): string {
    return text;
  }

  /**
   * The legacy body's string standing for a `Utf8` value (the inverse
   * of `_legacy_value`).
   */
  static _legacy_string(value: string): string {
    return value;
  }

  [Symbol.iterator](): Iterator<Chunk> {
    return this.chunks[Symbol.iterator]();
  }

  get length(): number {
    return this.chunks.length;
  }

  write(fp: IO): number {
    if (this.data?.length > 0 || (_legacyNames.get() && _LEGACY_NAME_TYPES.has(this.chunk_type))) {
      return writeBytes(fp, this._legacy_body());
    }
    let written = 0;
    for (const chunk of this.chunks) {
      if (chunk.synthetic) continue;
      written += writeChunk(fp, chunk);
    }
    return written;
  }

  /**
   * The legacy body (see `_read_legacy`) of the `Utf8` child's value: a
   * parsed body as it was read unless the value changed, a new one when
   * a container py_aep built is written into an older project.
   *
   * A buffer sized to its string is resized to the new one and its NUL.
   * A fixed `fnam` keeps its size (48 bytes when new); a string that
   * does not fit raises rather than being cut.
   *
   * @throws {@link ValueError} If the new string does not fit a fixed buffer.
   */
  _legacy_body(): Uint8Array {
    const cls = this.constructor;
    const utf8 = this.chunks.find((c) => c.chunk_type === "Utf8") ?? null;
    const value: string = pyOr(getattr(utf8, "value", null), "");
    if (this.data?.length > 0 && value === cls._legacy_value(_legacyText(this.data))) {
      return this.data;
    }
    const encoded = encode(cls._legacy_string(value), "UTF-8", "surrogateescape");
    const size = this.data.length || (_LEGACY_FIXED_BUFFERS.get(this.chunk_type) ?? null);
    if (!_LEGACY_FIXED_BUFFERS.has(this.chunk_type) || size == null) {
      return bytes_.concat(encoded, b("\x00"));
    }
    if (encoded.length + 1 > size) {
      throw new ValueError(
        `${repr(value)} does not fit this project's ${size}-byte ` +
          `${this.chunk_type} (at most ${size - 1} UTF-8 bytes)`,
      );
    }
    return bytes_.ljust(encoded, size, 0);
  }
}

define(ContainerChunk, {
  chunks: field({ default: Factory(() => []) }),
});
register("fnam", "pdnm", "RCom")(ContainerChunk);

export const _LEGACY_FIXED_BUFFERS: Map<string, number> = new Map([["fnam", 48]]);
/**
 * Legacy string bodies of a fixed size, whatever their string (a 48-byte
 * `fnam`); the others are sized to their string.
 */

export const _LEGACY_NAME_TYPES: ReadonlySet<string> = new Set(["tdsn", "fnam", "pdnm", "RCom"]);
/** The name containers older projects hold as bare strings. */

export const LEGACY_NAME_FORMAT = 92;
/**
 * The file format version (`HeadChunk.file_format_version`) from which
 * After Effects reads a name container's `Utf8` child. Measured on AE 2026: in
 * a file of format 91.2 or older, a `Utf8` child reads as the name "Utf8" and
 * a bare string as the name; from format 92.0 on, the reverse (AE 15 writes
 * 92.14).
 */

export const _legacyNames = new ContextVar<boolean>("_legacy_names", { default: false });
/**
 * Set by `write_aep` while writing a project older than `LEGACY_NAME_FORMAT`,
 * so name containers py_aep built are written as bare strings too.
 */

/** The NUL-terminated string at the start of a legacy body. */
export function _legacyText(data: Uint8Array): string {
  const nul = bytes_.find(data, b("\x00"));
  return decode(nul >= 0 ? data.slice(0, nul) : data, "UTF-8", "surrogateescape");
}

/**
 * Whether a body of `size` bytes at `fp` is a run of child chunks.
 *
 * Every header must have a printable type, and the children (each padded
 * to an even size) must end exactly at the body's end. Checking only the
 * first header is not enough: a legacy 48-byte `fnam` holding a 4-letter
 * name (`Fill`, `Glow`) reads as a `Fill` chunk of length 0 followed by
 * NUL padding. The body is walked by seeking; `fp` is left where it was.
 */
export function _tilesAsChunks(fp: IO, size: number): boolean {
  const start = fp.tell();
  let pos = 0;
  try {
    while (pos < size) {
      if (size - pos < 8) return false;
      const header = fp.read(8);
      if (header.length < 8 || !Array.from(header.slice(0, 4)).every((c) => 0x20 <= c && c < 0x7f)) {
        return false;
      }
      const length: number = struct.unpack(">I", header.slice(4, 8))[0];
      pos += 8 + length + (length & 1);
      if (pos > size) return false;
      fp.seek(start + pos);
    }
    return pos === size;
  } finally {
    fp.seek(start);
  }
}

// ---------------------------------------------------------------------------
// Read context
// ---------------------------------------------------------------------------

/** Ancestor context passed through recursive chunk reading. */
export class ReadContext {
  parent_list_type: string;
  grandparent_list_type: string;
  parent_siblings: Chunk[] | null;

  constructor(
    parentListType = "",
    grandparentListType = "",
    parentSiblings: Chunk[] | null = null,
  ) {
    this.parent_list_type = parentListType;
    this.grandparent_list_type = grandparentListType;
    this.parent_siblings = parentSiblings;
  }
}

export const EMPTY_CTX = new ReadContext();

/** The keywords a context resolver adds for its chunk type's `read`. */
export type ResolvedContext = {
  is_le?: boolean;
  item_type?: LdatItemType;
  item_size?: number;
  count?: number;
  is_spatial?: boolean;
  is_color?: boolean;
  is_integer?: boolean;
  renderer_match_name?: string;
};

/** The keywords `read_chunks` passes to every `cls.read`. */
export type ChunkReadKwargs = {
  chunk_type?: string;
  ctx?: ReadContext | null;
  defer_list_types?: ReadonlySet<string> | null;
  parent_result?: Chunk[] | null;
} & ResolvedContext;

// ---------------------------------------------------------------------------
// Context resolvers
// ---------------------------------------------------------------------------

export function _resolveCdatContext(siblings: Chunk[], ctx: ReadContext): ResolvedContext {
  return { is_le: ctx.grandparent_list_type === "otst" };
}

export function _resolveLdatContext(siblings: Chunk[], ctx: ReadContext): ResolvedContext {
  // Registry lookup instead of a deferred import: ldat_chunks subclasses Chunk,
  // so a top-level import would be circular.
  const Lhd3Chunk = registered("lhd3");
  if (!siblings?.length) return {};
  const lhd3Sibling: Chunk = siblings[0];
  if (!(lhd3Sibling instanceof Lhd3Chunk)) return {};
  const lhd3 = lhd3Sibling;
  const result: ResolvedContext = {
    item_type: lhd3.item_type,
    item_size: lhd3.item_size,
    count: lhd3.count,
  };
  // Check spatial flag for potential three_d -> three_d_spatial promotion
  if (
    ctx.grandparent_list_type === "tdbs" &&
    ctx.parent_siblings != null &&
    ctx.parent_siblings.length > 2
  ) {
    // `hasattr(tdb4_sibling, "is_spatial")`: only Tdb4Chunk declares it.
    const tdb4Sibling = ctx.parent_siblings[2];
    if (tdb4Sibling instanceof registered("tdb4")) {
      result.is_spatial = tdb4Sibling.is_spatial;
    }
  }
  return result;
}

export function _resolveTdumContext(siblings: Chunk[], ctx: ReadContext): ResolvedContext {
  if (siblings.length > 2) {
    // `hasattr(tdb4, "color") and hasattr(tdb4, "integer")`: only Tdb4Chunk declares `integer`.
    const tdb4 = siblings[2];
    if (tdb4 instanceof registered("tdb4")) {
      return { is_color: tdb4.color, is_integer: tdb4.integer };
    }
  }
  return {};
}

export function _resolvePrdaContext(siblings: Chunk[], ctx: ReadContext): ResolvedContext {
  // Registry lookup instead of a deferred import: misc_chunks subclasses Chunk,
  // so a top-level import would be circular.
  const PrinChunk = registered("prin");
  for (const sibling of siblings) {
    if (sibling instanceof PrinChunk) {
      return { renderer_match_name: sibling.match_name };
    }
  }
  return {};
}

export const _CONTEXT_RESOLVERS: Map<string, (siblings: Chunk[], ctx: ReadContext) => ResolvedContext> =
  new Map([
    ["cdat", _resolveCdatContext],
    ["ldat", _resolveLdatContext],
    ["prda", _resolvePrdaContext],
    ["tdum", _resolveTdumContext],
    ["tduM", _resolveTdumContext],
  ]);

/** Compute kwargs for parameterized chunk types. */
export function _resolveContext(chunkType: string, siblings: Chunk[], ctx: ReadContext): ResolvedContext {
  const resolver = _CONTEXT_RESOLVERS.get(chunkType);
  if (resolver == null) return {};
  return resolver(siblings, ctx);
}

// ---------------------------------------------------------------------------
// Chunk header I/O
// ---------------------------------------------------------------------------

/** The chunk header with the type as its big-endian u32 code. */
const _HEADER_CODES = new struct.Struct(">II");
/** Decoded chunk types by code; only codes that decode as ASCII get in. */
const _TYPE_NAMES = new Map<number, string>();

/** Encoded chunk types; `write_bytes` copies them out, never in. */
const _TYPE_BYTES = new Map<string, Uint8Array>();
const _LEN_BODY = new struct.Struct(">I");
/** `write_chunk`'s backpatch value; `pack` reads it before returning. */
const _LEN_VALUE: struct.PackValue[] = [0];

/** Read the 8-byte chunk header: (chunk_type, len_body). */
export function readHeader(fp: IO): [string, number] {
  const header = fp.unpack(_HEADER_CODES);
  if (header === null) {
    const got = fp.read(8).length;
    throw new OSError(`Short read on chunk header: expected 8 bytes, got ${got}`);
  }
  const [code, lenBody] = header;
  return [_typeName(code), lenBody];
}

/** A four-character type read as its big-endian u32 code. */
function _typeName(code: number): string {
  let name = _TYPE_NAMES.get(code);
  if (name === undefined) {
    name = decode(struct.pack(">I", code), "ASCII");
    // Reuse the registered literal: Map lookups and `===` against literals
    // compare atomized strings by identity, decoded ones by content.
    for (const registered of CHUNK_TYPES.keys()) {
      if (registered === name) {
        name = registered;
        break;
      }
    }
    _TYPE_NAMES.set(code, name);
  }
  return name;
}

/**
 * Write a complete chunk: header + body + pad byte.
 *
 * Backpatches len_body after the body is written.
 */
export function writeChunk(fp: IO, chunk: Chunk): number {
  let typeBytes = _TYPE_BYTES.get(chunk.chunk_type);
  if (typeBytes === undefined) _TYPE_BYTES.set(chunk.chunk_type, (typeBytes = encode(chunk.chunk_type, "ASCII")));
  let written = writeBytes(fp, typeBytes);
  const lenPos = fp.tell();
  fp.seek(4, 1); // skip 4 bytes for len_body placeholder
  written += 4;

  const bodySize = chunk.write(fp);
  written += bodySize;

  // Backpatch len_body
  const current = fp.tell();
  fp.seek(lenPos);
  _LEN_VALUE[0] = bodySize;
  fp.pack(_LEN_BODY, _LEN_VALUE);
  fp.seek(current);

  // Pad to even boundary
  written += writePad(fp, bodySize);

  return written;
}

// ---------------------------------------------------------------------------
// Recursive reader
// ---------------------------------------------------------------------------

/** Read child chunks until `size` bytes are consumed. */
export function readChunks(
  fp: IO,
  size: number,
  kwargs: { ctx?: ReadContext; defer_list_types?: ReadonlySet<string> | null } = {},
): Chunk[] {
  const { ctx = EMPTY_CTX, defer_list_types = null } = kwargs;
  const end = fp.tell() + size;
  const result: Chunk[] = [];
  let pos = end - size;
  while (pos < end) {
    const [chunkType, lenBody] = readHeader(fp);
    const cls = CHUNK_TYPES.get(chunkType) ?? Chunk;

    const resolver = _CONTEXT_RESOLVERS.get(chunkType);
    const chunk: Chunk = cls._nests
      ? // No resolver targets a nesting chunk (tests/unit/test_binary_io.test.ts).
        cls.read(fp, lenBody, { chunk_type: chunkType, ctx, parent_result: result, defer_list_types })
      : resolver != null
        ? cls.read(fp, lenBody, { chunk_type: chunkType, ...resolver(result, ctx) })
        : // Leaf chunks take no reading context.
          cls.read(fp, lenBody, { chunk_type: chunkType });
    result.push(chunk);

    // Consume pad byte if len_body is odd
    readPad(fp, lenBody);
    pos += 8 + lenBody + (lenBody & 1);
  }

  if (pos !== end) {
    throw new OSError(`Chunk reader drifted: expected offset ${end}, got ${pos}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// AEP file I/O
// ---------------------------------------------------------------------------

/** Read an AEP file: RIFX root chunk + trailing XMP packet. */
export function readAep(
  fp: IO,
  kwargs: { defer_list_types?: ReadonlySet<string> | null } = {},
): [ListChunk, string] {
  const { defer_list_types = null } = kwargs;
  const rawType = readBytes(fp, 4);
  const chunkType = decode(rawType, "ASCII");
  if (chunkType !== "RIFX") {
    throw new ValueError(`Expected RIFX, got ${repr(chunkType)}`);
  }
  const [lenBody] = readFmt("I", fp);
  const rifx = ListChunk.read(fp, lenBody, {
    chunk_type: "RIFX",
    defer_list_types,
  });
  const xmp = decode(fp.read(), "UTF-8");
  return [rifx, xmp];
}

/** Write an AEP file: RIFX root chunk + trailing XMP packet. */
export function writeAep(fp: IO, rifx: ListChunk, xmp: string): number {
  const head = rifx.chunks.find((c): c is HeadChunk => c.chunk_type === "head");
  if (head == null) throw new StopIteration();
  const token = _legacyNames.set(head.file_format_version < LEGACY_NAME_FORMAT);
  let written: number;
  try {
    written = writeChunk(fp, rifx);
  } finally {
    _legacyNames.reset(token);
  }
  const xmpBytes = encode(xmp, "UTF-8");
  written += writeBytes(fp, xmpBytes);
  return written;
}
