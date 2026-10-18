// Python `bytes.decode` / `str.encode` with CPython's error handlers.
// JS strings and Python 3 strs differ in one way that matters here: a
// Python str is code points, a JS string UTF-16 units. A lone surrogate is
// representable in both, which is what lets `surrogateescape` round-trip.

import { UnicodeDecodeError, UnicodeEncodeError, LookupError, NotImplementedError, TypeError_ } from "./errors.ts";
import {
  type CjkCodepage,
  CP874,
  CP932,
  CP936,
  CP949,
  CP950,
  CP1250,
  CP1251,
  CP1252,
  CP1253,
  CP1254,
  CP1255,
  CP1256,
  CP1257,
  CP1258,
  MAC_ROMAN,
} from "./codepages.ts";

export type Errors = "strict" | "surrogateescape" | "ignore" | "replace";

/** `ord(c)`: the code point of a one-character string (one element of `for (const c of s)`). */
export function ord(c: string): number {
  const cp = c.codePointAt(0);
  if (cp === undefined || c.length !== (cp > 0xffff ? 2 : 1)) {
    throw new TypeError_(`ord() expected a character, but string of length ${[...c].length} found`);
  }
  return cp;
}

const NORM = new Map<string, string>();

function norm(encoding: string): string {
  let n = NORM.get(encoding);
  if (n === undefined) {
    n = normUncached(encoding);
    NORM.set(encoding, n);
  }
  return n;
}

function normUncached(encoding: string): string {
  const e = encoding.toLowerCase().replace(/_/g, "-");
  if (e === "utf8" || e === "utf-8") return "utf-8";
  if (e === "ascii" || e === "us-ascii") return "ascii";
  if (e === "latin-1" || e === "latin1" || e === "iso-8859-1") return "latin-1";
  if (e === "utf-16-le" || e === "utf-16le") return "utf-16-le";
  if (e === "utf-16-be" || e === "utf-16be") return "utf-16-be";
  if (e === "utf-16") return "utf-16";
  if (e === "utf-32" || e === "utf32" || e === "u32") return "utf-32";
  if (e === "utf-32-le" || e === "utf-32le") return "utf-32-le";
  if (e === "utf-32-be" || e === "utf-32be") return "utf-32-be";
  if (e === "mac-roman" || e === "macroman" || e === "mac") return "mac-roman";
  const windows = /^(?:windows-)?(125[0-8])$/.exec(e);
  if (windows) return `cp${windows[1]}`;
  if (e === "932" || e === "ms932" || e === "mskanji" || e === "ms-kanji") return "cp932";
  if (e === "gbk" || e === "936" || e === "ms936") return "cp936";
  if (e === "949" || e === "ms949" || e === "uhc") return "cp949";
  if (e === "950" || e === "ms950") return "cp950";
  return e;
}

/** The charmap code pages: CPython's codec tables for the high half. */
const SINGLE_BYTE: ReadonlyMap<string, readonly number[]> = new Map([
  ["mac-roman", MAC_ROMAN],
  ["cp874", CP874],
  ["cp1250", CP1250],
  ["cp1251", CP1251],
  ["cp1252", CP1252],
  ["cp1253", CP1253],
  ["cp1254", CP1254],
  ["cp1255", CP1255],
  ["cp1256", CP1256],
  ["cp1257", CP1257],
  ["cp1258", CP1258],
]);

const CJK: ReadonlyMap<string, CjkCodepage> = new Map([
  ["cp932", CP932],
  ["cp936", CP936],
  ["cp949", CP949],
  ["cp950", CP950],
]);

function badByte(out: string[], byte: number, errors: Errors, enc: string, pos: number, reason = "invalid start byte"): void {
  if (errors === "surrogateescape") {
    out.push(String.fromCharCode(0xdc00 + byte));
  } else if (errors === "replace") {
    out.push("�");
  } else if (errors !== "ignore") {
    throw new UnicodeDecodeError(
      `'${enc}' codec can't decode byte 0x${byte.toString(16).padStart(2, "0")} in position ${pos}: ${reason}`,
    );
  }
}

function isAscii(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i++) if (data[i] >= 0x80) return false;
  return true;
}

/** Bytes below 0x100 as one char each (callers check the range). */
function chars(data: Uint8Array): string {
  if (data.length <= 0x2000) return Reflect.apply(String.fromCharCode, null, data);
  let s = "";
  for (let i = 0; i < data.length; i += 0x2000) {
    s += Reflect.apply(String.fromCharCode, null, data.subarray(i, i + 0x2000));
  }
  return s;
}

// WHATWG's fatal UTF-8 decoder rejects exactly what CPython's strict one does
// (surrogates, overlongs, > U+10FFFF, truncation); on error the byte-wise
// decoder below applies the error handler.
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeUtf8(data: Uint8Array, errors: Errors): string {
  try {
    return UTF8_FATAL.decode(data);
  } catch {
    return decodeUtf8Slow(data, errors);
  }
}

function decodeUtf8Slow(data: Uint8Array, errors: Errors): string {
  const out: string[] = [];
  const n = data.length;
  let i = 0;
  while (i < n) {
    const b0 = data[i];
    if (b0 < 0x80) {
      out.push(String.fromCharCode(b0));
      i += 1;
      continue;
    }
    let need = 0;
    let cp = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      if (b0 === 0xe0) lo = 0xa0;
      if (b0 === 0xed) hi = 0x9f; // no encoded surrogates
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      if (b0 === 0xf0) lo = 0x90;
      if (b0 === 0xf4) hi = 0x8f;
    } else {
      badByte(out, b0, errors, "utf-8", i);
      i += 1;
      continue;
    }
    // Maximal subpart: escape the lead byte alone and resume at the first
    // byte that does not continue it (CPython's behavior).
    let j = 1;
    let ok = true;
    for (; j <= need; j++) {
      if (i + j >= n) {
        ok = false;
        break;
      }
      const b = data[i + j];
      const l = j === 1 ? lo : 0x80;
      const h = j === 1 ? hi : 0xbf;
      if (b < l || b > h) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (b & 0x3f);
    }
    if (!ok) {
      if (errors === "strict") {
        throw new UnicodeDecodeError(
          `'utf-8' codec can't decode byte 0x${b0.toString(16)} in position ${i}: invalid continuation byte`,
        );
      }
      if (errors === "replace") {
        out.push("�");
      } else {
        for (let k = 0; k < j; k++) badByte(out, data[i + k], errors, "utf-8", i + k);
      }
      i += j;
      continue;
    }
    out.push(String.fromCodePoint(cp));
    i += need + 1;
  }
  return out.join("");
}

const UTF8_ENCODER = new TextEncoder();
/** `String.prototype.isWellFormed` (ES2024, newer than the lib this builds against); absent on older hosts. */
const IS_WELL_FORMED: ((this: string) => boolean) | undefined = Reflect.get(String.prototype, "isWellFormed");

function encodeUtf8(text: string, errors: Errors): Uint8Array {
  // TextEncoder would turn a lone surrogate into U+FFFD; those go byte-wise.
  if (typeof IS_WELL_FORMED === "function" && IS_WELL_FORMED.call(text)) return UTF8_ENCODER.encode(text);
  return encodeUtf8Slow(text, errors);
}

function encodeUtf8Slow(text: string, errors: Errors): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      if (errors === "surrogateescape" && c >= 0xdc80 && c <= 0xdcff) {
        out.push(c - 0xdc00);
        continue;
      }
      if (errors === "ignore") continue;
      if (errors === "replace") {
        out.push(0x3f);
        continue;
      }
      throw new UnicodeEncodeError(
        `'utf-8' codec can't encode character '\\u${c.toString(16)}' in position ${i}: surrogates not allowed`,
      );
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

function decodeSingleByte(data: Uint8Array, errors: Errors, limit: number, enc: string, table?: readonly number[]): string {
  if (limit === 0x100) return chars(data);
  if (isAscii(data)) return UTF8_FATAL.decode(data);
  const out: string[] = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b < limit) out.push(String.fromCharCode(b));
    else if (table && table[b - 0x80] >= 0) out.push(String.fromCharCode(table[b - 0x80]));
    else badByte(out, b, errors, enc, i, table ? "character maps to <undefined>" : "ordinal not in range(128)");
  }
  return out.join("");
}

const CJK_DECODERS = new Map<string, TextDecoder | null>();

function cjkDecoder(label: string): TextDecoder | null {
  const cached = CJK_DECODERS.get(label);
  if (cached !== undefined) return cached;
  let decoder: TextDecoder | null = null;
  try {
    // bun-types narrows the label to three encodings; the WHATWG ones are all valid.
    decoder = Reflect.construct(TextDecoder, [label, { fatal: true }]);
  } catch {
    // a host without the legacy encodings (RangeError): no such codec
  }
  CJK_DECODERS.set(label, decoder);
  return decoder;
}

/**
 * CPython's multibyte decode: the code page's validity map splits the input
 * into characters and errors (a bad lead byte is one error and decoding
 * resumes at the next byte); runs of valid characters go through the WHATWG
 * decoder, which decodes them as CPython does except for the listed overrides.
 */
function decodeCjk(data: Uint8Array, errors: Errors, codec: CjkCodepage, encoding: string): string {
  const decoder = cjkDecoder(codec.label);
  if (decoder === null) throw new LookupError(`unknown encoding: ${encoding}`);
  const out: string[] = [];
  let run = 0;
  const flush = (end: number): void => {
    if (end > run) out.push(decoder.decode(data.subarray(run, end)));
  };
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    if (b < 0x80) {
      i += 1;
      continue;
    }
    const lead = codec.leads[b - 0x80];
    if (lead < 0) {
      const cp = codec.singles.get(b);
      if (cp !== undefined) {
        flush(i);
        out.push(String.fromCharCode(cp));
        run = i + 1;
      }
      i += 1;
      continue;
    }
    if (i + 1 < data.length) {
      const t = data[i + 1];
      const trails = codec.trails[lead];
      let valid = false;
      for (let k = 0; k < trails.length && !valid; k += 2) valid = t >= trails[k] && t <= trails[k + 1];
      if (valid) {
        const cp = codec.pairs.get((b << 8) | t);
        if (cp !== undefined) {
          flush(i);
          out.push(String.fromCharCode(cp));
          run = i + 2;
        }
        i += 2;
        continue;
      }
    }
    flush(i);
    badByte(out, b, errors, codec.name, i, `${i + 1 < data.length ? "illegal" : "incomplete"} multibyte sequence`);
    i += 1;
    run = i;
  }
  flush(data.length);
  return out.join("");
}

function encodeSingleByte(text: string, errors: Errors, limit: number, enc: string, table?: readonly number[]): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= limit) return encodeSingleByteSlow(text, errors, limit, enc, table);
    out[i] = c;
  }
  return out;
}

function encodeSingleByteSlow(text: string, errors: Errors, limit: number, enc: string, table?: readonly number[]): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < limit) {
      out.push(c);
      continue;
    }
    const t = table ? table.indexOf(c) : -1;
    if (t >= 0) {
      out.push(0x80 + t);
      continue;
    }
    if (errors === "surrogateescape" && c >= 0xdc80 && c <= 0xdcff) out.push(c - 0xdc00);
    else if (errors === "ignore") continue;
    else if (errors === "replace") out.push(0x3f);
    else
      throw new UnicodeEncodeError(
        `'${enc}' codec can't encode character '\\u${c.toString(16).padStart(4, "0")}' in position ${i}: ${limit === 0x80 && !table ? "ordinal not in range(128)" : "character maps to <undefined>"}`,
      );
  }
  return Uint8Array.from(out);
}

function decodeUtf16(data: Uint8Array, errors: Errors, le: boolean): string {
  if (data.length % 2 && errors === "strict") {
    throw new UnicodeDecodeError(`'utf-16-${le ? "le" : "be"}' codec can't decode byte: truncated data`);
  }
  const units: string[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    units.push(String.fromCharCode(le ? data[i] | (data[i + 1] << 8) : (data[i] << 8) | data[i + 1]));
  }
  return units.join("");
}

function encodeUtf16(text: string, le: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 * i + (le ? 0 : 1)] = c & 0xff;
    out[2 * i + (le ? 1 : 0)] = c >> 8;
  }
  return out;
}

/**
 * UTF-32 decoding, CPython's error reporting included: a unit outside
 * range(0x110000) or in the surrogate range, and a truncated tail, go to the
 * error handler (`surrogateescape` escapes the leading bytes >= 0x80 of the
 * bad span and resumes after them, raising when there are none).
 */
function decodeUtf32(data: Uint8Array, errors: Errors, le: boolean, offset = 0): string {
  const enc = le ? "utf-32-le" : "utf-32-be";
  const out: string[] = [];
  const n = data.length;
  let i = 0;
  const fail = (start: number, end: number, reason: string): number => {
    if (errors === "replace") {
      out.push("\ufffd");
      return end;
    }
    if (errors === "ignore") return end;
    if (errors === "surrogateescape") {
      let k = start;
      while (k < end && k - start < 4 && data[k] >= 0x80) out.push(String.fromCharCode(0xdc00 + data[k++]));
      if (k > start) return k;
    }
    const where =
      end - start === 1
        ? `byte 0x${data[start].toString(16).padStart(2, "0")} in position ${start + offset}`
        : `bytes in position ${start + offset}-${end - 1 + offset}`;
    throw new UnicodeDecodeError(`'${enc}' codec can't decode ${where}: ${reason}`);
  };
  while (i < n) {
    if (n - i < 4) {
      i = fail(i, n, "truncated data");
      continue;
    }
    const cp = le
      ? (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0
      : ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
    if (cp > 0x10ffff) i = fail(i, i + 4, "code point not in range(0x110000)");
    else if (cp >= 0xd800 && cp < 0xe000) i = fail(i, i + 4, "code point in surrogate code point range(0xd800, 0xe000)");
    else {
      out.push(String.fromCodePoint(cp));
      i += 4;
    }
  }
  return out.join("");
}

function encodeUtf32(text: string, errors: Errors, le: boolean, name: string): Uint8Array {
  const cps: number[] = [];
  let pos = 0;
  for (const ch of text) {
    const cp = ord(ch);
    if (cp >= 0xd800 && cp < 0xe000) {
      if (errors === "ignore") {
        pos++;
        continue;
      }
      if (errors === "replace") {
        cps.push(0x3f);
        pos++;
        continue;
      }
      throw new UnicodeEncodeError(
        `'${name}' codec can't encode character '\\u${cp.toString(16)}' in position ${pos}: surrogates not allowed`,
      );
    }
    cps.push(cp);
    pos++;
  }
  const out = new Uint8Array(cps.length * 4);
  const dv = new DataView(out.buffer);
  cps.forEach((cp, k) => dv.setUint32(4 * k, cp, le));
  return out;
}

/** Python `data.decode(encoding, errors)`. */
export function decode(data: Uint8Array, encoding = "utf-8", errors: Errors = "strict"): string {
  switch (encoding === "utf-8" ? encoding : norm(encoding)) {
    case "utf-8":
      return decodeUtf8(data, errors);
    case "ascii":
      return decodeSingleByte(data, errors, 0x80, "ascii");
    case "latin-1":
      return decodeSingleByte(data, errors, 0x100, "latin-1");
    case "utf-16-le":
      return decodeUtf16(data, errors, true);
    case "utf-16-be":
      return decodeUtf16(data, errors, false);
    case "utf-16": {
      if (data[0] === 0xff && data[1] === 0xfe) return decodeUtf16(data.subarray(2), errors, true);
      if (data[0] === 0xfe && data[1] === 0xff) return decodeUtf16(data.subarray(2), errors, false);
      return decodeUtf16(data, errors, true);
    }
    case "utf-32-le":
      return decodeUtf32(data, errors, true);
    case "utf-32-be":
      return decodeUtf32(data, errors, false);
    case "utf-32": {
      // A BOM picks the byte order and is dropped; without one, little-endian (the native order).
      if (data[0] === 0xff && data[1] === 0xfe && data[2] === 0 && data[3] === 0) return decodeUtf32(data.subarray(4), errors, true, 4);
      if (data[0] === 0 && data[1] === 0 && data[2] === 0xfe && data[3] === 0xff) return decodeUtf32(data.subarray(4), errors, false, 4);
      return decodeUtf32(data, errors, true);
    }
    default: {
      const n = norm(encoding);
      const table = SINGLE_BYTE.get(n);
      if (table) return decodeSingleByte(data, errors, 0x80, "charmap", table);
      const cjk = CJK.get(n);
      if (cjk) return decodeCjk(data, errors, cjk, encoding);
      throw new LookupError(`unknown encoding: ${encoding}`);
    }
  }
}

/** Python `text.encode(encoding, errors)`. */
export function encode(text: string, encoding = "utf-8", errors: Errors = "strict"): Uint8Array {
  switch (encoding === "utf-8" ? encoding : norm(encoding)) {
    case "utf-8":
      return encodeUtf8(text, errors);
    case "ascii":
      return encodeSingleByte(text, errors, 0x80, "ascii");
    case "latin-1":
      return encodeSingleByte(text, errors, 0x100, "latin-1");
    case "utf-16-le":
      return encodeUtf16(text, true);
    case "utf-16-be":
      return encodeUtf16(text, false);
    case "utf-16": {
      const body = encodeUtf16(text, true);
      const out = new Uint8Array(body.length + 2);
      out.set([0xff, 0xfe]);
      out.set(body, 2);
      return out;
    }
    case "utf-32-le":
      return encodeUtf32(text, errors, true, "utf-32-le");
    case "utf-32-be":
      return encodeUtf32(text, errors, false, "utf-32-be");
    case "utf-32": {
      const body = encodeUtf32(text, errors, true, "utf-32");
      const out = new Uint8Array(body.length + 4);
      out.set([0xff, 0xfe, 0, 0]);
      out.set(body, 4);
      return out;
    }
    default: {
      const n = norm(encoding);
      const table = SINGLE_BYTE.get(n);
      if (table) return encodeSingleByte(text, errors, 0x80, "charmap", table);
      if (CJK.has(n)) throw new NotImplementedError(`encoding to ${encoding} is not supported`);
      throw new LookupError(`unknown encoding: ${encoding}`);
    }
  }
}
