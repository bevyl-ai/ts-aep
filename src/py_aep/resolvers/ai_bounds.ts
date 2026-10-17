/**
 * Measure the per-layer artwork bounds of an Illustrator/PDF file.
 *
 * After Effects offers "Layer Size" footage dimensions for a `.ai`/`.pdf` layer
 * import (`ImportOptions.layer_dimensions`), sizing the footage to the layer's
 * artwork instead of the document. It records the artwork box in the footage
 * `opti` and derives the pixel dimensions from it, and it does not recompute
 * either on open, so py_aep has to reproduce the box.
 *
 * The box is **not** the true visual extent of the art. It is a deliberately
 * conservative estimate that After Effects computes from the page content
 * stream, reverse-engineered against AE 2026 and reproduced here exactly for
 * 123 probe layers:
 *
 * - the box is the union of one contribution per painting operator, with the
 *   expansion applied **per contribution**, never to the union;
 * - paths are measured by their **control-point hull**, not their true curve
 *   bounds, so a curve whose control points sit far outside it measures large;
 * - a fill expands by `0.25`, a stroke by the stroke half-width times a
 *   shape-dependent factor, and text, images and form XObjects not at all;
 * - text is measured from the PDF's own font metrics (`/Widths` and the
 *   descriptor's `/FontBBox`), so no font file or glyph outline is needed, and
 *   from `data.std14_metrics` where the file supplies neither;
 * - clipping needs no work: Illustrator resolves clipping masks when it writes
 *   the page, emitting pre-trimmed geometry and omitting fully-clipped art, and
 *   AE measures straight through any residual `W n`.
 *
 * Only the **first page** is measured. AE has a defect here: on a multi-artboard
 * document it measures the second page instead, reporting every layer whose art
 * is on the first artboard as empty. py_aep measures the first page and warns,
 * rather than reproducing behaviour that drops artwork.
 */

import * as zlib from "../../pyrt/zlib.ts";
import { IndirectObject, IndirectReference, Stream } from "../cos/index.ts";
import type { CosDict, CosNode } from "../cos/cos.ts";
import { cos_float, cos_get_or, cos_int, cos_num } from "../cos/kinds.ts";
import { STD14_EXTENT, STD14_FIRST_CODE, STD14_STANDARD_QUOTES, STD14_WIDTHS } from "../data/std14_metrics.ts";
import { UnsupportedAiLayersError, _find_ai_icc, _object_offsets, _parse_object_at, read_ai_layer_ocgs } from "./ai_layers.ts";
import {
  Path,
  type PathLike,
  ValueError,
  b,
  bytes_,
  bytes_eq,
  decode,
  dict_get,
  float,
  getitem,
  int,
  num_str,
  py_or,
  py_eq,
  setdefault,
  split,
  str,
  warn,
  round,
  is_real,
  hypot,
} from "../../pyrt/index.ts";

export type Box = [number, number, number, number];
export type Matrix = number[];
export type Pt = [number, number];
export type Segment = [string, ...Pt[]];
/** `(widths, default width, y-min, y-max, two-byte)` in glyph space. */
export type Metrics = [Map<number, number>, number, number, number, boolean];

/** Uniform expansion applied to a filled path or a shading, in points. */
export const FILL_PAD = 0.25;

/** Largest value the `opti` artwork box can store (signed big-endian 16.16). */
export const FIXED_MAX = (2 ** 31 - 1) / 65536.0;

/**
 * The box After Effects stores for a layer with no artwork: a `1/65536`
 * square at the page origin, which yields 1x1 footage.
 */
export const EMPTY_BOX: Box = [0.0, 0.0, 1 / 65536.0, 1 / 65536.0];

export const _IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/** Advance assumed for a glyph with no width from any source. */
export const _DEFAULT_WIDTH = 500.0;

/** `_font_metrics` for text shown with no `Tf`, i.e. with no font at all. */
export const _NO_FONT_METRICS: Metrics = [new Map(), _DEFAULT_WIDTH, -250.0, 750.0, false];

/**
 * Filters the stream decoder understands. Anything else is a hard stop rather
 * than a silently wrong measurement.
 */
export const _SUPPORTED_FILTERS: ReadonlySet<string> = new Set(["FlateDecode", "Fl"]);

export const _PAINT_OPS: ReadonlySet<string> = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
export const _STROKE_OPS: ReadonlySet<string> = new Set(["S", "s", "B", "B*", "b", "b*"]);

/**
 * Render modes that stroke the glyphs. Modes 3 and 7 are invisible but are
 * still measured - After Effects does not skip them.
 */
export const _STROKING_TEXT_MODES: ReadonlySet<number> = new Set([1, 2, 5, 6]);

/**
 * Encodings that put `quotesingle` at 39 and `grave` at 96, where the
 * fonts' built-in StandardEncoding puts `quoteright` and `quoteleft`.
 */
export const _ASCII_QUOTE_ENCODINGS: ReadonlySet<string> = new Set(["WinAnsiEncoding", "MacRomanEncoding"]);

export const _DELIMITERS = b("()<>[]{}/%");
export const _WHITESPACE = b(" \t\r\n\f\x00");
export const _NUMBER_START = b("+-.0123456789");
export const NUMBER_CHARS = b("+-.0123456789eE");
export const CLOSERS = b("]>}{");
export const SLASH = b("/");
export const PERCENT = b("%");
export const LPAREN = b("(");
export const RPAREN = b(")");
export const LT = b("<");
export const GT = b(">");
export const LBRACKET = b("[");
export const RBRACKET = b("]");
export const BACKSLASH = b("\\");
export const NEWLINE = b("\n");
export const CARRIAGE_RETURN = b("\r");
export const CRLF = b("\r\n");
export const DICT_END = b(">>");

/** Escape bytes after a backslash, keyed by the escape byte (`n`, `r`, `t`, `b`, `f`). */
export const SIMPLE_ESCAPES = new Map<number, Uint8Array>([
  [0x6e, b("\n")],
  [0x72, b("\r")],
  [0x74, b("\t")],
  [0x62, b("\b")],
  [0x66, b("\f")],
]);

/** An image's own space, which its CTM maps onto the page. */
export const _UNIT_SQUARE: Pt[] = [
  [0.0, 0.0],
  [1.0, 0.0],
  [1.0, 1.0],
  [0.0, 1.0],
];
export const _ROOT_RE = /\/Root[ \t\r\n]+(\d+)[ \t\r\n]+\d+[ \t\r\n]+R/g;
// `\s` here is bytes-`\s` ([ \t\n\r\f\v]), not JS `\s`, so a 0xA0 byte is not whitespace.
export const _INLINE_IMAGE_END = /[ \t\n\r\f\v\x00]EI[ \t\n\r\f\v\x00]|[ \t\n\r\f\v\x00]EI$/g;

// --------------------------------------------------------------------------
// geometry

/** `str(x)` for a content-stream operand: every number there is a Python float (`1.0`). */
export function _operand_str(x: CosNode): string {
  return is_real(x) ? num_str(x, true) : str(x);
}

/**
 * Two-argument `min`/`max` as Python spells them: keep the first operand unless
 * the second is strictly smaller/larger. Math.min/Math.max would propagate NaN
 * instead, which Python never does here.
 */
// NOTE(port): local two-operand form of Python's min(a, b)/max(a, b); same first-wins tie and NaN behavior as CPython's comparison loop.
export function _min2(a: number, b_: number): number {
  return b_ < a ? b_ : a;
}

export function _max2(a: number, b_: number): number {
  return b_ > a ? b_ : a;
}

/** `sep.join(parts)` for bytes. */
export function join_bytes(sep: Uint8Array, parts: Uint8Array[]): Uint8Array {
  const out: Uint8Array[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push(sep);
    out.push(part);
  });
  return bytes_.join(out);
}

/** `bytes.isdigit()`: non-empty and every byte an ASCII digit. */
export function _isdigit_bytes(data: Uint8Array): boolean {
  return data.length > 0 && Array.from(data).every((c) => c >= 0x30 && c <= 0x39);
}

/** Concatenate two PDF matrices: the result applies `a` then `b`. */
export function _mat_mul(a: Matrix, b_: Matrix): Matrix {
  return [
    a[0] * b_[0] + a[1] * b_[2],
    a[0] * b_[1] + a[1] * b_[3],
    a[2] * b_[0] + a[3] * b_[2],
    a[2] * b_[1] + a[3] * b_[3],
    a[4] * b_[0] + a[5] * b_[2] + b_[4],
    a[4] * b_[1] + a[5] * b_[3] + b_[5],
  ];
}

export function _apply(m: Matrix, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** A growing axis-aligned bounding box. */
export class _Acc {
  x0: number;
  y0: number;
  x1: number;
  y1: number;

  constructor() {
    this.x0 = this.y0 = Infinity;
    this.x1 = this.y1 = -Infinity;
  }

  get empty(): boolean {
    return this.x0 > this.x1;
  }

  add(x: number, y: number): void {
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
  }

  add_box(box: Box | null): void {
    if (box == null) return;
    this.add(box[0], box[1]);
    this.add(box[2], box[3]);
  }

  box(): Box | null {
    if (this.empty) return null;
    return [this.x0, this.y0, this.x1, this.y1];
  }
}

/** The dictionary of a plain dict or of a `Stream` object. */
export function _as_dict(value: CosNode): CosDict | null {
  if (value instanceof Map) return value;
  // `getattr(value, "dictionary", None)`: of the COS kinds only a `Stream` has one.
  const dictionary = value instanceof Stream ? value.dictionary : null;
  return dictionary instanceof Map ? dictionary : null;
}

/** Clamp a box to the range the `opti` fixed-point field can store. */
export function _clamp(box: Box): Box {
  return [
    _max2(-FIXED_MAX, _min2(FIXED_MAX, box[0])),
    _max2(-FIXED_MAX, _min2(FIXED_MAX, box[1])),
    _max2(-FIXED_MAX, _min2(FIXED_MAX, box[2])),
    _max2(-FIXED_MAX, _min2(FIXED_MAX, box[3])),
  ];
}

export function _grow(box: Box, dx: number, dy: number): Box {
  return [box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy];
}

/**
 * Narrow a clip region by another clip path, as `W n` does.
 *
 * `null` means "no clip established", so it is the identity here. `null`
 * also comes back for two boxes that miss entirely: an empty clip region
 * paints nothing, which is what a missing clip yields at the one place the
 * clip is read (`sh`).
 */
export function _intersect(current: Box | null, added: Box | null): Box | null {
  if (current == null) return added;
  if (added == null) return current;
  const box: Box = [
    _max2(current[0], added[0]),
    _max2(current[1], added[1]),
    _min2(current[2], added[2]),
    _min2(current[3], added[3]),
  ];
  return box[0] <= box[2] && box[1] <= box[3] ? box : null;
}

// --------------------------------------------------------------------------
// document access

/** Indirect-object and stream access for a PDF-compatible file. */
export class _Document {
  _data: Uint8Array;
  _name: string;
  _offsets: Map<number, number>;
  _cache: Map<number, CosNode>;
  _catalog: CosDict | null;

  constructor(data: Uint8Array, name: string) {
    this._data = data;
    this._name = name;
    this._offsets = _object_offsets(data);
    this._cache = new Map();
    this._catalog = null;
    this._check_supported();
  }

  _reject(why: string): UnsupportedAiLayersError {
    return new UnsupportedAiLayersError(`${this._name}: ${why}`);
  }

  /**
   * Reject structures the plain object scanner cannot see through.
   *
   * Illustrator writes classic cross-reference tables and uncompressed
   * objects, so these paths are unreachable from Illustrator output - but a
   * PDF from another producer would otherwise be measured from whatever
   * objects the scanner happened to find.
   */
  _check_supported(): void {
    if (bytes_.contains(this._data, b("/ObjStm"))) {
      throw this._reject(
        "the file uses compressed object streams (/ObjStm), which " +
          "py_aep cannot read; re-save it with PDF 1.4 compatibility",
      );
    }
    if (bytes_.contains(this._data, b("/Encrypt"))) {
      throw this._reject("the file is encrypted");
    }
  }

  /** Follow an indirect reference to its object; pass values through. */
  resolve(value: CosNode): CosNode {
    while (value instanceof IndirectReference) {
      const number = value.object_number;
      if (this._cache.has(number)) {
        value = getitem(this._cache, number);
        break;
      }
      const offset = this._offsets.get(number) ?? null;
      if (offset == null) return null;
      const resolved = _parse_object_at(this._data, offset);
      this._cache.set(number, resolved);
      value = resolved;
    }
    return value;
  }

  number(value: CosNode, default_: number = 0.0): number {
    const resolved = this.resolve(value);
    if (!is_real(resolved)) return default_;
    return float(resolved);
  }

  get(mapping: CosNode, key: string, default_: CosNode = null): CosNode {
    const table = _as_dict(this.resolve(mapping));
    if (table == null || !table.has(key)) return default_;
    return this.resolve(getitem(table, key));
  }

  /** The decoded body of a stream object. */
  stream(value: CosNode): Uint8Array {
    const reference = value;
    value = this.resolve(value);
    let body: Uint8Array | null = null;
    let info: CosDict = new Map();
    // `Stream` instances carry (dict, raw); a plain dict needs the raw
    // bytes located from the object's own offset.
    // `getattr(value, "data", None)`: of the COS kinds a `Stream` and an `IndirectObject` have one.
    const raw = value instanceof Stream || value instanceof IndirectObject ? value.data : null;
    if (raw instanceof Uint8Array) {
      info = py_or(value instanceof Stream ? value.dictionary : null, new Map());
      body = raw;
    } else if (value instanceof Map && reference instanceof IndirectReference) {
      info = value;
      body = this._raw_stream(reference.object_number, value);
    }
    if (body == null) throw this._reject("unreadable content stream");
    const filters = this.get(info, "Filter");
    const names: CosNode[] = !Array.isArray(filters) ? [filters] : filters;
    if (this.get(info, "DecodeParms") != null) {
      throw this._reject(
        "the content stream uses a decode-parameter filter " +
          "(predictors), which py_aep cannot decode",
      );
    }
    for (const entry of names) {
      if (entry == null) continue;
      const filter_name = str(this.resolve(entry));
      if (!_SUPPORTED_FILTERS.has(filter_name)) {
        throw this._reject(
          `the content stream uses the ${filter_name} filter, which ` +
            "py_aep cannot decode",
        );
      }
      try {
        body = zlib.decompress(body);
      } catch (exc) {
        if (!(exc instanceof zlib.error)) throw exc;
        throw Object.assign(this._reject(`corrupt content stream (${exc})`), { cause: exc });
      }
    }
    return body;
  }

  _raw_stream(number: number, info: CosDict): Uint8Array | null {
    const offset = this._offsets.get(number) ?? null;
    if (offset == null) return null;
    let start = bytes_.find(this._data, b("stream"), offset);
    if (start < 0) return null;
    start += "stream".length;
    if (bytes_eq(bytes_.slice(this._data, start, start + 2), CRLF)) {
      start += 2;
    } else if (
      bytes_eq(bytes_.slice(this._data, start, start + 1), NEWLINE) ||
      bytes_eq(bytes_.slice(this._data, start, start + 1), CARRIAGE_RETURN)
    ) {
      start += 1;
    }
    const length = this.get(info, "Length");
    if (is_real(length)) {
      return bytes_.slice(this._data, start, start + int(length));
    }
    const end = bytes_.find(this._data, b("endstream"), start);
    return end > 0 ? bytes_.slice(this._data, start, end) : null;
  }

  reject(why: string): UnsupportedAiLayersError {
    return this._reject(why);
  }

  /**
   * The document catalog, named by the trailer's `/Root`.
   *
   * A file whose trailer is unreadable falls back to scanning the objects
   * for the first `/Type /Catalog`, which is what the object scanner can
   * see without a cross-reference table.
   */
  catalog(): CosDict {
    if (this._catalog !== null) return this._catalog;
    const numbers = [...decode(this._data, "latin-1").matchAll(_ROOT_RE)].map((m) => int(m[1]));
    // The last trailer wins: an incrementally updated file supersedes the
    // /Root of every earlier revision.
    numbers.reverse();
    for (const number of this._offsets.keys()) numbers.push(number);
    for (const number of numbers) {
      const candidate = this.resolve(new IndirectReference(number, 0));
      if (candidate instanceof Map && str(dict_get(candidate, "Type", "")) === "Catalog") {
        this._catalog = candidate;
        return candidate;
      }
    }
    throw this._reject("no document catalog");
  }

  /** The page dictionaries, in `/Kids` order (at least one). */
  pages(): CosDict[] {
    const pages = [...this._walk_pages(this.get(this.catalog(), "Pages"), 0)];
    if (pages.length === 0) throw this._reject("the document has no pages");
    return pages;
  }

  *_walk_pages(node: CosNode, depth: number): Generator<CosDict> {
    const table = _as_dict(this.resolve(node));
    if (table == null || depth > 32) return;
    if (str(dict_get(table, "Type", "")) === "Page") {
      yield table;
      return;
    }
    const kids = this.get(table, "Kids");
    for (const kid of Array.isArray(kids) ? kids : []) {
      yield* this._walk_pages(kid, depth + 1);
    }
  }

  /** The page's content stream(s), concatenated and decoded. */
  page_content(page: CosDict): Uint8Array {
    const contents = this.resolve(cos_get_or(this.resolve(page), "Contents", null));
    const parts: CosNode[] = Array.isArray(contents) ? contents : [contents];
    return join_bytes(
      NEWLINE,
      parts.filter((part) => part != null).map((part) => this.stream(part)),
    );
  }
}

// --------------------------------------------------------------------------
// content-stream tokenizer

/**
 * Yield `(kind, value)` content-stream tokens.
 *
 * `kind` is one of `num`, `name`, `str`, `array`, `dict` or `op`. The COS
 * parser in `py_aep.cos` cannot be reused here: its keyword lexer rejects
 * unknown barewords and only accepts alphabetic ones, so content-stream
 * operators (`re`, `f*`, `W*`, `'`) would all raise.
 */
export function* _tokenize(
  data: Uint8Array,
): Generator<
  ["num", number] | ["name", string] | ["str", Uint8Array] | ["array", CosNode[]] | ["dict", CosDict] | ["op", string]
> {
  let pos = 0;
  const size = data.length;
  while (pos < size) {
    const char = data.subarray(pos, pos + 1);
    if (bytes_.contains(_WHITESPACE, char)) {
      pos += 1;
      continue;
    }
    if (bytes_eq(char, PERCENT)) {
      let end = pos;
      while (end < size && !bytes_.contains(CRLF, data.subarray(end, end + 1))) end += 1;
      pos = end;
      continue;
    }
    if (bytes_eq(char, SLASH)) {
      let end = pos + 1;
      while (end < size) {
        const nxt = data.subarray(end, end + 1);
        if (bytes_.contains(_WHITESPACE, nxt) || bytes_.contains(_DELIMITERS, nxt)) break;
        end += 1;
      }
      yield ["name", decode(data.subarray(pos + 1, end), "latin-1")];
      pos = end;
      continue;
    }
    if (bytes_eq(char, LPAREN)) {
      const [literal, next] = _read_literal_string(data, pos);
      pos = next;
      yield ["str", literal];
      continue;
    }
    if (bytes_eq(char, LT)) {
      if (bytes_eq(data.subarray(pos + 1, pos + 2), LT)) {
        const [mapping, next] = _read_dict(data, pos);
        pos = next;
        yield ["dict", mapping];
        continue;
      }
      const hexed = _read_hex_string(data, pos);
      if (hexed == null) return;
      const [literal, next] = hexed;
      pos = next;
      yield ["str", literal];
      continue;
    }
    if (bytes_eq(char, LBRACKET)) {
      const [array, next] = _read_array(data, pos);
      pos = next;
      yield ["array", array];
      continue;
    }
    if (bytes_.contains(CLOSERS, char)) {
      pos += 1;
      continue;
    }
    if (bytes_.contains(_NUMBER_START, char)) {
      let end = pos;
      while (end < size && bytes_.contains(NUMBER_CHARS, data.subarray(end, end + 1))) end += 1;
      let value: number;
      try {
        value = float(decode(data.subarray(pos, end), "latin-1"));
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        value = 0.0;
      }
      yield ["num", value];
      pos = end;
      continue;
    }
    let end = pos;
    while (end < size) {
      const nxt = data.subarray(end, end + 1);
      if (bytes_.contains(_WHITESPACE, nxt) || bytes_.contains(_DELIMITERS, nxt)) break;
      end += 1;
    }
    if (end === pos) end += 1;
    const operator = decode(data.subarray(pos, end), "latin-1");
    pos = end;
    if (operator === "BI") {
      // An inline image's binary body is not tokenizable: skip to `EI`
      // and report the whole thing as one operator, so the measurer can
      // still take its box.
      _INLINE_IMAGE_END.lastIndex = pos;
      const match = _INLINE_IMAGE_END.exec(decode(data, "latin-1"));
      pos = match ? match.index + match[0].length : size;
      yield ["op", "BI"];
      continue;
    }
    yield ["op", operator];
  }
}

export function _read_literal_string(data: Uint8Array, pos: number): [Uint8Array, number] {
  pos += 1;
  let depth = 1;
  const out: number[] = [];
  const size = data.length;
  while (pos < size) {
    const char = data.subarray(pos, pos + 1);
    if (bytes_eq(char, BACKSLASH)) {
      const nxt = data.subarray(pos + 1, pos + 2);
      const simple = nxt.length === 1 ? SIMPLE_ESCAPES.get(nxt[0]) : undefined;
      if (simple !== undefined) {
        out.push(...simple);
        pos += 2;
      } else if (_isdigit_bytes(nxt)) {
        pos += 1;
        let digits = "";
        while (digits.length < 3 && _isdigit_bytes(data.subarray(pos, pos + 1))) {
          digits += String.fromCharCode(data[pos]);
          pos += 1;
        }
        // CPython's int(b"89", 8) raises with the bytes repr (b'89'); pyrt int() takes the str.
        if (/[89]/.test(digits)) {
          throw new ValueError(`invalid literal for int() with base 8: b'${digits}'`);
        }
        out.push(int(digits, 8) & 0xff);
      } else if (bytes_eq(nxt, NEWLINE) || bytes_eq(nxt, CARRIAGE_RETURN)) {
        // PDF 7.3.4.2: a reverse solidus before an end-of-line marker
        // is a line continuation - both bytes are dropped. Keeping the
        // newline would measure it as one more glyph.
        pos += 2;
        if (bytes_eq(nxt, CARRIAGE_RETURN) && bytes_eq(data.subarray(pos, pos + 1), NEWLINE)) {
          pos += 1;
        }
      } else {
        out.push(...nxt);
        pos += 2;
      }
      continue;
    }
    if (bytes_eq(char, LPAREN)) {
      depth += 1;
    } else if (bytes_eq(char, RPAREN)) {
      depth -= 1;
      if (depth === 0) return [Uint8Array.from(out), pos + 1];
    }
    out.push(...char);
    pos += 1;
  }
  return [Uint8Array.from(out), pos];
}

/**
 * Decode a `<...>` hex string; `null` when it is never terminated.
 *
 * Shared by the operator tokenizer and the array/dictionary reader: a hex
 * string inside a `TJ` array has to decode to the same bytes a bare `Tj`
 * operand does, or its glyph codes come out as their own hex digits.
 */
export function _read_hex_string(data: Uint8Array, pos: number): [Uint8Array, number] | null {
  const end = bytes_.find(data, GT, pos);
  if (end < 0) return null;
  let digits = decode(data.subarray(pos + 1, end), "latin-1").replace(/[^0-9A-Fa-f]/g, "");
  if (digits.length % 2) digits += "0";
  return [bytes_.fromhex(digits), end + 1];
}

export function _read_array(data: Uint8Array, pos: number): [CosNode[], number] {
  pos += 1;
  const out: CosNode[] = [];
  const size = data.length;
  while (pos < size) {
    if (bytes_eq(data.subarray(pos, pos + 1), RBRACKET)) return [out, pos + 1];
    if (bytes_.contains(_WHITESPACE, data.subarray(pos, pos + 1))) {
      pos += 1;
      continue;
    }
    const sub = _next_simple(data, pos);
    if (sub == null) return [out, pos + 1];
    const [value, next] = sub;
    pos = next;
    out.push(value);
  }
  return [out, pos];
}

export function _read_dict(data: Uint8Array, pos: number): [CosDict, number] {
  pos += 2;
  const out: CosDict = new Map();
  const size = data.length;
  let key: string | null = null;
  while (pos < size) {
    if (bytes_eq(data.subarray(pos, pos + 2), DICT_END)) return [out, pos + 2];
    if (bytes_.contains(_WHITESPACE, data.subarray(pos, pos + 1))) {
      pos += 1;
      continue;
    }
    const sub = _next_simple(data, pos);
    if (sub == null) return [out, pos + 1];
    const [value, next] = sub;
    pos = next;
    if (key == null) {
      key = _operand_str(value);
    } else {
      out.set(key, value);
      key = null;
    }
  }
  return [out, pos];
}

/** Read one array/dictionary element starting at `pos`. */
export function _next_simple(data: Uint8Array, pos: number): [CosNode, number] | null {
  const char = data.subarray(pos, pos + 1);
  const size = data.length;
  if (bytes_eq(char, SLASH)) {
    let end = pos + 1;
    while (end < size) {
      const nxt = data.subarray(end, end + 1);
      if (bytes_.contains(_WHITESPACE, nxt) || bytes_.contains(_DELIMITERS, nxt)) break;
      end += 1;
    }
    return [decode(data.subarray(pos + 1, end), "latin-1"), end];
  }
  if (bytes_eq(char, LPAREN)) return _read_literal_string(data, pos);
  if (bytes_eq(char, LBRACKET)) return _read_array(data, pos);
  if (bytes_eq(char, LT)) {
    if (bytes_eq(data.subarray(pos + 1, pos + 2), LT)) return _read_dict(data, pos);
    return _read_hex_string(data, pos);
  }
  if (bytes_.contains(_NUMBER_START, char)) {
    let end = pos;
    while (end < size && bytes_.contains(NUMBER_CHARS, data.subarray(end, end + 1))) end += 1;
    try {
      return [float(decode(data.subarray(pos, end), "latin-1")), end];
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return [0.0, end];
    }
  }
  let end = pos;
  while (end < size) {
    const nxt = data.subarray(end, end + 1);
    if (bytes_.contains(_WHITESPACE, nxt) || bytes_.contains(_DELIMITERS, nxt)) break;
    end += 1;
  }
  if (end === pos) end += 1;
  const word = decode(data.subarray(pos, end), "latin-1");
  if (word === "true") return [true, end];
  if (word === "false") return [false, end];
  return [null, end];
}

// --------------------------------------------------------------------------
// graphics state

/** The subset of the PDF graphics and text state the box depends on. */
export class _GState {
  ctm: Matrix = _IDENTITY;
  clip: Box | null = null;
  line_width = 1.0;
  miter = 10.0;
  font: CosDict | null = null;
  metrics: Metrics = _NO_FONT_METRICS;
  size = 0.0;
  char_spacing = 0.0;
  word_spacing = 0.0;
  h_scale = 100.0;
  leading = 0.0;
  rise = 0.0;
  render_mode = 0;

  copy(): _GState {
    return Object.assign(new _GState(), this);
  }

  /**
   * The stroke half-width in device space, per axis.
   *
   * After Effects expands a stroked path by the line width scaled through
   * each of the CTM's column norms independently, so a `4 0 0 1 cm` with a
   * 10pt line expands x by 20 and y by 5. A single geometric-mean scale
   * would give 10 for both.
   */
  stroke_half_width(): [number, number] {
    const half = this.line_width / 2.0;
    return [
      half * hypot(this.ctm[0], this.ctm[1]),
      half * hypot(this.ctm[2], this.ctm[3]),
    ];
  }
}

/** The font's base encoding name, empty when it uses its built-in one. */
export function _base_encoding(doc: _Document, font: CosDict): string {
  const encoding = doc.get(font, "Encoding");
  const table = _as_dict(doc.resolve(encoding));
  if (table != null) return str(doc.get(table, "BaseEncoding", ""));
  return encoding == null ? "" : str(encoding);
}

/** The advances After Effects supplies for a font with no `/Widths`. */
export function _builtin_widths(doc: _Document, font: CosDict, base: string): Map<number, number> {
  const table = STD14_WIDTHS.get(base);
  if (table == null) return new Map();
  const widths = new Map<number, number>();
  for (const [i, w] of table.entries()) widths.set(STD14_FIRST_CODE + i, w);
  const quotes = STD14_STANDARD_QUOTES.get(base);
  if (quotes != null && !_ASCII_QUOTE_ENCODINGS.has(_base_encoding(doc, font))) {
    widths.set(39, quotes[0]);
    widths.set(96, quotes[1]);
  }
  return widths;
}

/**
 * `(widths, default width, y-min, y-max, two-byte)` in glyph space.
 *
 * The vertical extent comes from the descriptor's `/FontBBox`, **not** its
 * `/Ascent`/`/Descent`: every font Illustrator embeds happens to give both
 * the same values, but a font where they disagree measures by the
 * `/FontBBox`.
 */
export function _font_metrics(doc: _Document, font: CosDict | null): Metrics {
  if (!(font instanceof Map)) return _NO_FONT_METRICS;
  const subtype = str(doc.get(font, "Subtype", ""));
  if (subtype === "Type0") return _type0_metrics(doc, font);
  const first = int(doc.number(font.get("FirstChar") ?? null, 0.0));
  const raw_widths = doc.get(font, "Widths");
  let widths = new Map<number, number>();
  if (Array.isArray(raw_widths)) {
    for (const [index, entry] of raw_widths.entries()) {
      widths.set(first + index, doc.number(entry));
    }
  }
  const descriptor = doc.get(font, "FontDescriptor");
  const base = _base_font(str(doc.get(font, "BaseFont", "")));
  const default_ = doc.number(doc.get(descriptor, "MissingWidth"), 0.0);
  if (widths.size === 0) widths = _builtin_widths(doc, font, base);
  const [y_min, y_max] = _vertical_extent(doc, descriptor, STD14_EXTENT.get(base) ?? null);
  return [widths, default_ !== 0 ? default_ : _DEFAULT_WIDTH, y_min, y_max, false];
}

export function _type0_metrics(doc: _Document, font: CosDict): Metrics {
  const descendants = doc.get(font, "DescendantFonts");
  const child: CosNode =
    Array.isArray(descendants) && descendants.length > 0
      ? doc.resolve(descendants[0])
      : new Map<string, CosNode>();
  const dw = doc.number(doc.get(child, "DW"), 1000.0);
  const default_ = dw !== 0 ? dw : 1000.0;
  const widths = new Map<number, number>();
  const table = doc.get(child, "W");
  const entries: CosNode[] = Array.isArray(table) ? table : [];
  let index = 0;
  while (index < entries.length) {
    const start = doc.number(entries[index]);
    const following = index + 1 < entries.length ? doc.resolve(entries[index + 1]) : null;
    if (Array.isArray(following)) {
      for (const [offset, value] of following.entries()) {
        widths.set(int(start) + offset, doc.number(value));
      }
      index += 2;
    } else if (index + 2 < entries.length) {
      const end = int(doc.number(entries[index + 1]));
      const value = doc.number(entries[index + 2]);
      for (let code = int(start); code < end + 1; code++) widths.set(code, value);
      index += 3;
    } else {
      break;
    }
  }
  const descriptor = doc.get(child, "FontDescriptor");
  const [y_min, y_max] = _vertical_extent(doc, descriptor, null);
  return [widths, default_, y_min, y_max, true];
}

export function _vertical_extent(
  doc: _Document,
  descriptor: CosNode,
  std: [number, number] | null,
): [number, number] {
  const bbox = doc.get(descriptor, "FontBBox");
  if (Array.isArray(bbox) && bbox.length === 4) {
    return [doc.number(bbox[1]), doc.number(bbox[3])];
  }
  if (doc.resolve(descriptor) instanceof Map) {
    return [
      doc.number(doc.get(descriptor, "Descent"), -250.0),
      doc.number(doc.get(descriptor, "Ascent"), 750.0),
    ];
  }
  if (std != null) return std;
  return [-250.0, 750.0];
}

/** Strip a subset tag and a style suffix from a `/BaseFont` name. */
export function _base_font(name: string): string {
  const parts = split(name, "+");
  return split(parts[parts.length - 1], ",")[0];
}

// --------------------------------------------------------------------------
// the measuring pass

/** Accumulates each optional content group's artwork box. */
export class _Measurer {
  _doc: _Document;
  boxes: Map<number, _Acc>;
  _stack: number[];

  constructor(doc: _Document) {
    this._doc = doc;
    this.boxes = new Map();
    this._stack = [];
  }

  /** The box of the innermost open optional content group. */
  _target(): _Acc | null {
    for (let i = this._stack.length - 1; i >= 0; i--) {
      const number = this._stack[i];
      if (number >= 0) return setdefault(this.boxes, number, new _Acc());
    }
    return null;
  }

  _resource(resources: CosNode, category: string, name: CosNode): CosNode {
    return this._doc.get(this._doc.get(resources, category), _operand_str(name));
  }

  _resource_ref(resources: CosNode, category: string, name: CosNode): CosNode {
    const table = _as_dict(this._doc.resolve(this._doc.get(resources, category)));
    if (table == null) return null;
    return table.get(_operand_str(name)) ?? null;
  }

  run(content: Uint8Array, resources: CosNode): void {
    let gs = new _GState();
    const saved: _GState[] = [];
    let operands: CosNode[] = [];
    let segments: Segment[] = [];
    let current: Pt | null = null;
    let start: Pt | null = null;
    let from_rect = false;
    let pending_clip = false;
    let text_matrix: Matrix = _IDENTITY;
    let line_matrix: Matrix = _IDENTITY;

    for (const [kind, value] of _tokenize(content)) {
      if (kind !== "op") {
        operands.push(value);
        continue;
      }
      const op: string = value;
      if (op === "q") {
        saved.push(gs.copy());
      } else if (op === "Q") {
        const restored = saved.pop();
        if (restored !== undefined) gs = restored;
      } else if (op === "cm" && operands.length >= 6) {
        // Python multiplies the raw operands: a non-number raises TypeError.
        gs.ctm = _mat_mul(operands.slice(-6).map(cos_num), gs.ctm);
      } else if (op === "w" && operands.length > 0) {
        gs.line_width = cos_float(operands[operands.length - 1]);
      } else if (op === "M" && operands.length > 0) {
        gs.miter = cos_float(operands[operands.length - 1]);
      } else if (op === "gs" && operands.length > 0) {
        const ext = this._resource(resources, "ExtGState", operands[operands.length - 1]);
        if (ext instanceof Map && ext.has("LW")) {
          gs.line_width = this._doc.number(getitem(ext, "LW"), gs.line_width);
        }
      }
      // ---- path construction
      else if (op === "m" && operands.length >= 2) {
        const point: Pt = [cos_float(operands[operands.length - 2]), cos_float(operands[operands.length - 1])];
        current = start = point;
      } else if (op === "l" && operands.length >= 2 && current != null) {
        const point: Pt = [cos_float(operands[operands.length - 2]), cos_float(operands[operands.length - 1])];
        segments.push(["l", current, point]);
        current = point;
      } else if (op === "c" && operands.length >= 6 && current != null) {
        const a = operands.slice(-6).map(cos_float);
        segments.push(["c", current, [a[0], a[1]], [a[2], a[3]], [a[4], a[5]]]);
        current = [a[4], a[5]];
      } else if (op === "v" && operands.length >= 4 && current != null) {
        const a = operands.slice(-4).map(cos_float);
        segments.push(["c", current, current, [a[0], a[1]], [a[2], a[3]]]);
        current = [a[2], a[3]];
      } else if (op === "y" && operands.length >= 4 && current != null) {
        const a = operands.slice(-4).map(cos_float);
        const end: Pt = [a[2], a[3]];
        segments.push(["c", current, [a[0], a[1]], end, end]);
        current = end;
      } else if (op === "h") {
        if (current != null && start != null && !py_eq(current, start)) {
          segments.push(["l", current, start]);
        }
        current = start;
      } else if (op === "re" && operands.length >= 4) {
        const [x, y, width, height] = operands.slice(-4).map(cos_float);
        const corners: Pt[] = [
          [x, y],
          [x + width, y],
          [x + width, y + height],
          [x, y + height],
        ];
        for (let index = 0; index < 4; index++) {
          segments.push(["l", corners[index], corners[(index + 1) % 4]]);
        }
        const origin: Pt = [x, y];
        current = start = origin;
        from_rect = true;
      } else if (op === "W" || op === "W*") {
        pending_clip = true;
      } else if (_PAINT_OPS.has(op)) {
        if (segments.length > 0) {
          if (op !== "n") this._commit_path(gs, segments, _STROKE_OPS.has(op), from_rect);
          if (pending_clip) gs.clip = _intersect(gs.clip, this._hull(gs, segments));
        }
        pending_clip = false;
        segments = [];
        from_rect = false;
        current = start = null;
      } else if (op === "sh") {
        // A shading paints the whole clip region.
        const target = this._target();
        if (target != null && gs.clip != null) {
          target.add_box(_clamp(_grow(gs.clip, FILL_PAD, FILL_PAD)));
        }
      } else if (op === "Do" && operands.length > 0) {
        this._draw_xobject(gs, resources, operands[operands.length - 1]);
      } else if (op === "BI") {
        // Inferred from the `q_image` probe layer rather than measured
        // on its own: an inline image is the same painting operator as
        // an image XObject, spelled inline. Illustrator never emits one.
        this._add_image(gs.ctm);
      }
      // ---- optional content
      else if (op === "BDC" || op === "BMC") {
        let number = -1;
        if (op === "BDC" && operands.length >= 2 && str(operands[operands.length - 2]) === "OC") {
          const reference = this._resource_ref(resources, "Properties", operands[operands.length - 1]);
          if (reference instanceof IndirectReference) number = reference.object_number;
        }
        this._stack.push(number);
      } else if (op === "EMC") {
        if (this._stack.length > 0) this._stack.pop();
      }
      // ---- text
      else if (op === "BT") {
        text_matrix = line_matrix = _IDENTITY;
      } else if (op === "Tf" && operands.length >= 2) {
        const font = this._resource(resources, "Font", operands[operands.length - 2]);
        gs.font = font instanceof Map ? font : null;
        // The metrics are a property of the font, so they are resolved
        // here rather than rebuilt for every text-showing operator.
        gs.metrics = _font_metrics(this._doc, gs.font);
        gs.size = cos_float(operands[operands.length - 1]);
      } else if (op === "Tm" && operands.length >= 6) {
        const tm = operands.slice(-6).map(cos_float);
        text_matrix = line_matrix = tm;
      } else if ((op === "Td" || op === "TD") && operands.length >= 2) {
        if (op === "TD") gs.leading = -cos_float(operands[operands.length - 1]);
        line_matrix = _mat_mul(
          [1.0, 0.0, 0.0, 1.0, cos_float(operands[operands.length - 2]), cos_float(operands[operands.length - 1])],
          line_matrix,
        );
        text_matrix = line_matrix;
      } else if (op === "T*") {
        line_matrix = _mat_mul([1.0, 0.0, 0.0, 1.0, 0.0, -gs.leading], line_matrix);
        text_matrix = line_matrix;
      } else if (op === "TL" && operands.length > 0) {
        gs.leading = cos_float(operands[operands.length - 1]);
      } else if (op === "Tc" && operands.length > 0) {
        gs.char_spacing = cos_float(operands[operands.length - 1]);
      } else if (op === "Tw" && operands.length > 0) {
        gs.word_spacing = cos_float(operands[operands.length - 1]);
      } else if (op === "Tz" && operands.length > 0) {
        gs.h_scale = cos_float(operands[operands.length - 1]);
      } else if (op === "Ts" && operands.length > 0) {
        gs.rise = cos_float(operands[operands.length - 1]);
      } else if (op === "Tr" && operands.length > 0) {
        gs.render_mode = cos_int(operands[operands.length - 1]);
      } else if ((op === "Tj" || op === "TJ" || op === "'" || op === '"') && operands.length > 0) {
        if (op === "'" || op === '"') {
          line_matrix = _mat_mul([1.0, 0.0, 0.0, 1.0, 0.0, -gs.leading], line_matrix);
          text_matrix = line_matrix;
        }
        const shown = operands[operands.length - 1];
        const items: CosNode[] = Array.isArray(shown) ? shown : [shown];
        text_matrix = this._show_text(gs, text_matrix, items);
      }
      operands = [];
    }
  }

  // -- contributions ----------------------------------------------------

  /**
   * The control-point hull of a path, in device space.
   *
   * After Effects measures the hull, not the true curve bounds, so a
   * control point far outside the drawn curve still counts.
   */
  _hull(gs: _GState, segments: Segment[]): Box | null {
    const acc = new _Acc();
    for (const segment of segments) {
      const [, ...points] = segment;
      for (const point of points) {
        acc.add(..._apply(gs.ctm, point[0], point[1]));
      }
    }
    return acc.box();
  }

  _commit_path(gs: _GState, segments: Segment[], stroked: boolean, from_rect: boolean): void {
    const target = this._target();
    if (target == null) return;
    let hull = this._hull(gs, segments);
    if (hull == null) return;
    hull = _clamp(hull);
    if (!stroked) {
      target.add_box(_clamp(_grow(hull, FILL_PAD, FILL_PAD)));
      return;
    }
    // A stroke's expansion depends only on the shape class, never on the
    // join or cap style: a `re` gets the exact 90-degree miter, a lone
    // straight segment gets no join term at all, and everything else gets
    // a worst-case half the miter limit. A path that is both filled and
    // stroked uses this alone - the fill pad is not also applied.
    let factor: number;
    if (from_rect) {
      factor = Math.sqrt(2.0);
    } else if (segments.length === 1 && segments[0][0] === "l") {
      factor = 1.0;
    } else {
      factor = gs.miter / 2.0;
    }
    const [half_x, half_y] = gs.stroke_half_width();
    target.add_box(_clamp(_grow(hull, half_x * factor, half_y * factor)));
  }

  /** A form or image XObject contributes its box with no expansion. */
  _draw_xobject(gs: _GState, resources: CosNode, name: CosNode): void {
    const xobject = _as_dict(this._resource(resources, "XObject", name));
    if (xobject == null) return;
    const target = this._target();
    if (target == null) return;
    const doc = this._doc;
    let ctm = gs.ctm;
    const subtype = str(doc.get(xobject, "Subtype", ""));
    if (subtype === "Form") {
      const matrix = doc.get(xobject, "Matrix");
      if (Array.isArray(matrix) && matrix.length === 6) {
        ctm = _mat_mul(matrix.map((v) => doc.number(v)), ctm);
      }
    }
    const bbox = doc.get(xobject, "BBox");
    if (Array.isArray(bbox) && bbox.length === 4) {
      const [x0, y0, x1, y1] = bbox.map((v) => doc.number(v));
      const acc = new _Acc();
      const points: Pt[] = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      for (const point of points) acc.add(..._apply(ctm, point[0], point[1]));
      const box = acc.box();
      if (box != null) target.add_box(_clamp(box));
    } else if (subtype === "Image") {
      this._add_image(ctm);
    }
  }

  /** An image contributes its unit square through the CTM, unexpanded. */
  _add_image(ctm: Matrix): void {
    const target = this._target();
    if (target == null) return;
    const acc = new _Acc();
    for (const point of _UNIT_SQUARE) acc.add(..._apply(ctm, point[0], point[1]));
    const box = acc.box();
    if (box != null) target.add_box(_clamp(box));
  }

  /** Measure a text-showing operator and advance the text matrix. */
  _show_text(gs: _GState, text_matrix: Matrix, items: CosNode[]): Matrix {
    const [widths, default_, y_min, y_max, two_byte] = gs.metrics;
    const target = this._target();
    const scale = gs.h_scale / 100.0;
    for (const item of items) {
      if (is_real(item)) {
        const shift = -float(item) / 1000.0 * gs.size * scale;
        text_matrix = _mat_mul([1.0, 0.0, 0.0, 1.0, shift, 0.0], text_matrix);
        continue;
      }
      if (!(item instanceof Uint8Array)) continue;
      let codes: number[];
      if (two_byte) {
        codes = [];
        for (let index = 0; index < item.length - 1; index += 2) {
          codes.push(bytes_.int_from_bytes(bytes_.slice(item, index, index + 2), "big"));
        }
      } else {
        codes = Array.from(item);
      }
      for (const code of codes) {
        const width = (widths.get(code) ?? default_) / 1000.0;
        let spacing = gs.char_spacing;
        if (code === 32 && !two_byte) spacing += gs.word_spacing;
        const advance = (width * gs.size + spacing) * scale;
        if (target != null) {
          this._add_glyph_cell(gs, target, text_matrix, advance, y_min, y_max, width);
        }
        text_matrix = _mat_mul([1.0, 0.0, 0.0, 1.0, advance, 0.0], text_matrix);
      }
    }
    return text_matrix;
  }

  /**
   * Add one glyph's cell: pen to pen-plus-advance by the font's box.
   *
   * The horizontal extent is the full advance, so character and word
   * spacing widen the cell. Invisible render modes are measured too; the
   * stroking modes grow the cell by the stroke half-width.
   */
  _add_glyph_cell(
    gs: _GState,
    target: _Acc,
    text_matrix: Matrix,
    advance: number,
    y_min: number,
    y_max: number,
    width: number,
  ): void {
    const scale = gs.h_scale / 100.0;
    let render = _mat_mul([gs.size * scale, 0.0, 0.0, gs.size, 0.0, gs.rise], text_matrix);
    render = _mat_mul(render, gs.ctm);
    const horizontal = gs.size !== 0 && scale !== 0 ? advance / (gs.size * scale) : width;
    const acc = new _Acc();
    const corners: Pt[] = [
      [0.0, y_min / 1000.0],
      [horizontal, y_min / 1000.0],
      [horizontal, y_max / 1000.0],
      [0.0, y_max / 1000.0],
    ];
    for (const [x, y] of corners) acc.add(..._apply(render, x, y));
    let box = acc.box();
    if (box == null) return;
    if (_STROKING_TEXT_MODES.has(gs.render_mode)) {
      const [half_x, half_y] = gs.stroke_half_width();
      box = _grow(box, half_x, half_y);
    }
    target.add_box(_clamp(box));
  }
}

// --------------------------------------------------------------------------
// public entry point

/**
 * Return each Illustrator/PDF layer's artwork bounds in document order.
 *
 * The bounds are the box After Effects stores for a "Layer Size" import,
 * in page points with the origin at the page's bottom-left corner, as
 * `(x0, y0, x1, y1)`. They are a conservative estimate of the artwork
 * extent, not its true visual bounds - see the module docstring.
 *
 * @param file - Path to a `.ai` or `.pdf` file.
 * @param data - The file's bytes, if the caller already read them.
 *
 * @returns One entry per layer in `resolvers.ai_layers.read_ai_layers` order
 * (bottom layer first), `null` for a layer with no artwork on the page.
 *
 * Warns when the document has more than one artboard, where After Effects
 * measures the second page and py_aep measures the first.
 *
 * Throws `UnsupportedAiLayersError` if the file is not a PDF-compatible
 * document, has no layers, or uses PDF structures py_aep cannot read
 * (compressed object streams, encryption, or a content-stream filter other
 * than Flate).
 */
export function read_ai_layer_bounds(file: PathLike, data: Uint8Array | null = null): (Box | null)[] {
  const path = new Path(file);
  if (data == null) data = path.read_bytes();
  const layers = read_ai_layer_ocgs(path, data);
  const doc = new _Document(data, path.name);
  const pages = doc.pages();
  if (pages.length > 1) {
    // NOTE(port): pyrt warn records the message, the only part observable to pytest.warns(match=); UserWarning category and stacklevel are not modeled.
    warn(
      `${path.name}: the document has ${pages.length} artboards. ` +
        "py_aep measures the first one; After Effects measures the " +
        "second and reports first-artboard layers as empty, so the " +
        "stored artwork box will differ from AE's.",
    );
  }
  const page = pages[0];
  const measurer = new _Measurer(doc);
  measurer.run(doc.page_content(page), doc.get(page, "Resources"));
  return layers.map((layer) =>
    measurer.boxes.has(layer.object_number) ? getitem(measurer.boxes, layer.object_number).box() : null,
  );
}

/**
 * A content-stream colour-space operator: `/CS0 cs` (fill) or `/CS0 CS`
 * (stroke).
 */
export const _COLOR_SPACE_OP_RE = /\/([^ \t\n\r\f\v\/\[\]()<>{}%]+)[ \t\n\r\f\v]+(?:cs|CS)\b/g;

/**
 * Return the ICC profile After Effects records for an Illustrator/PDF
 * file, or `null`.
 *
 * It is the profile of the first ICC-based colour space the first page's
 * content draws with (`/Name cs` or `/Name CS`, `/Name` being an
 * `[/ICCBased ...]` page resource). A profile the page never draws with is
 * not recorded: an Illustrator file saved without PDF compatibility keeps
 * one among its placeholder page's unused resources, and AE 2026 assigns
 * sRGB to it instead (ai_no_pdf.ai). When the page cannot be read
 * (compressed object streams, encryption, an unsupported filter), the first
 * embedded profile is returned.
 *
 * @param file - Path to a `.ai` or `.pdf` file.
 * @param data - The file's bytes, if the caller already read them.
 */
export function read_ai_icc_profile(file: PathLike, data: Uint8Array | null = null): Uint8Array | null {
  if (data == null) data = new Path(file).read_bytes();
  if (!bytes_.startswith(data, b("%PDF"))) return null;
  try {
    const doc = new _Document(data, new Path(file).name);
    const page = doc.pages()[0];
    const content = doc.page_content(page);
    const spaces = doc.get(doc.get(page, "Resources"), "ColorSpace");
    for (const match of decode(content, "latin-1").matchAll(_COLOR_SPACE_OP_RE)) {
      const space = doc.get(spaces, match[1]);
      if (Array.isArray(space) && space.length === 2 && str(space[0]) === "ICCBased") {
        const profile = doc.stream(space[1]);
        if (profile.length >= 132 && bytes_eq(bytes_.slice(profile, 36, 40), b("acsp"))) {
          return profile;
        }
      }
    }
  } catch (e) {
    if (!(e instanceof UnsupportedAiLayersError)) throw e;
    return _find_ai_icc(file, data);
  }
  return null;
}

/**
 * The footage pixel size After Effects derives from an artwork box.
 *
 * The box reaches AE through the `opti`'s signed 16.16 field, and AE sizes
 * the footage from what it reads back, so the extent is quantized before it
 * is ceilinged - an extent that lands a float hair above an integer must not
 * gain a pixel. A layer with no artwork floors at 1x1.
 *
 * @param box - An entry of `read_ai_layer_bounds`, or `null` for an empty layer.
 */
export function footage_size(box: Box | null): [number, number] {
  const [x0, y0, x1, y1] = (box == null ? EMPTY_BOX : box).map((v) => round(v * 65536));
  return [
    Math.max(1, Math.ceil((x1 - x0) / 65536.0)),
    Math.max(1, Math.ceil((y1 - y0) / 65536.0)),
  ];
}

export const __all__ = ["EMPTY_BOX", "footage_size", "read_ai_icc_profile", "read_ai_layer_bounds"] as const;
