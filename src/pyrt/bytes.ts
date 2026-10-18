// Python `bytes` operations over Uint8Array. Python bytes are immutable,
// so every slice here copies; nothing hands out a view another caller
// could mutate.

import { ValueError } from "./errors.ts";

/** A bytes literal: `b("\x00vsc")` is Python `b"\x00vsc"` (each char a byte). */
export function ascii(literal: string): Uint8Array {
  const out = new Uint8Array(literal.length);
  for (let i = 0; i < literal.length; i++) {
    const c = literal.charCodeAt(i);
    if (c > 0xff) throw new ValueError("bytes literal char out of range");
    out[i] = c;
  }
  return out;
}

export const EMPTY = new Uint8Array(0);

/** `bytes(n)` - n zero bytes. */
export function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

/** `b"\x00" * n` style repetition. */
export function repeat(data: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(data.length * Math.max(0, n));
  for (let i = 0; i < n; i++) out.set(data, i * data.length);
  return out;
}

/** `a + b + ...` and `b"".join(parts)` */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function join(parts: Iterable<Uint8Array>): Uint8Array {
  return concat(...parts);
}

/** `a == b` */
export function equals(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (a == null || b == null) return a == b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `data[start:end]` with Python's negative-index and clamping rules. */
export function slice(data: Uint8Array, start?: number | null, end?: number | null): Uint8Array {
  const n = data.length;
  let s = start == null ? 0 : start < 0 ? Math.max(0, n + start) : Math.min(start, n);
  let e = end == null ? n : end < 0 ? Math.max(0, n + end) : Math.min(end, n);
  if (e < s) e = s;
  return data.slice(s, e);
}

function asNeedle(sub: Uint8Array | number): Uint8Array {
  return typeof sub === "number" ? Uint8Array.of(sub) : sub;
}

/** `data.find(sub, start)` */
export function indexOf(data: Uint8Array, sub: Uint8Array | number, start = 0, end?: number): number {
  const needle = asNeedle(sub);
  const stop = (end ?? data.length) - needle.length;
  outer: for (let i = Math.max(0, start); i <= stop; i++) {
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** `data.index(sub)` */
export function indexOrThrow(data: Uint8Array, sub: Uint8Array | number, start = 0): number {
  const i = indexOf(data, sub, start);
  if (i < 0) throw new ValueError("subsection not found");
  return i;
}

/** `sub in data` */
export function includes(data: Uint8Array, sub: Uint8Array | number): boolean {
  return indexOf(data, sub) >= 0;
}

/** `data.count(sub)` */
export function count(data: Uint8Array, sub: Uint8Array | number): number {
  const needle = asNeedle(sub);
  let n = 0;
  let i = indexOf(data, needle);
  while (i >= 0) {
    n++;
    i = indexOf(data, needle, i + Math.max(1, needle.length));
  }
  return n;
}

export function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > data.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

export function endsWith(data: Uint8Array, suffix: Uint8Array): boolean {
  const o = data.length - suffix.length;
  if (o < 0) return false;
  for (let i = 0; i < suffix.length; i++) if (data[o + i] !== suffix[i]) return false;
  return true;
}

const WS = ascii(" \t\n\r\x0b\x0c");

/** `data.strip(chars)` (whitespace when `chars` is omitted). */
export function trim(data: Uint8Array, chars: Uint8Array = WS): Uint8Array {
  return trimEnd(trimStart(data, chars), chars);
}

export function trimStart(data: Uint8Array, chars: Uint8Array = WS): Uint8Array {
  let s = 0;
  if (chars.length === 1) {
    const c = chars[0];
    while (s < data.length && data[s] === c) s++;
  } else while (s < data.length && chars.includes(data[s])) s++;
  return data.slice(s);
}

export function trimEnd(data: Uint8Array, chars: Uint8Array = WS): Uint8Array {
  let e = data.length;
  if (chars.length === 1) {
    const c = chars[0];
    while (e > 0 && data[e - 1] === c) e--;
  } else while (e > 0 && chars.includes(data[e - 1])) e--;
  return data.slice(0, e);
}

/** `data.ljust(width, fill)` */
export function padEnd(data: Uint8Array, width: number, fill = 0): Uint8Array {
  if (data.length >= width) return data.slice();
  const out = new Uint8Array(width).fill(fill);
  out.set(data);
  return out;
}

/** `data.split(sep)` */
export function split(data: Uint8Array, sep?: Uint8Array | null, maxsplit = -1): Uint8Array[] {
  if (sep == null) return splitWhitespace(data, maxsplit);
  const out: Uint8Array[] = [];
  let s = 0;
  let i = indexOf(data, sep);
  while (i >= 0 && (maxsplit < 0 || out.length < maxsplit)) {
    out.push(data.slice(s, i));
    s = i + sep.length;
    i = indexOf(data, sep, s);
  }
  out.push(data.slice(s));
  return out;
}

/** `data.replace(old, new)` */
export function replace(data: Uint8Array, old: Uint8Array, new_: Uint8Array): Uint8Array {
  return join(intersperse(split(data, old), new_));
}

function* intersperse(parts: Uint8Array[], sep: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < parts.length; i++) {
    if (i) yield sep;
    yield parts[i];
  }
}

/** `data.hex()` */
export function toHex(data: Uint8Array, sep = ""): string {
  return Array.from(data, (x) => x.toString(16).padStart(2, "0")).join(sep);
}

/** `bytes.fromhex(text)` */
export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (clean.length % 2) throw new ValueError("non-hexadecimal number found in fromhex() arg");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(clean.slice(2 * i, 2 * i + 2), 16);
    if (Number.isNaN(v)) throw new ValueError("non-hexadecimal number found in fromhex() arg");
    out[i] = v;
  }
  return out;
}

/** `int.from_bytes(data, byteorder, signed=...)` - bigint when it may exceed 2^53. */
export function intFromBytes(data: Uint8Array, byteorder: "big" | "little", signed = false): number {
  let v = 0n;
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const byte = byteorder === "big" ? data[i] : data[n - 1 - i];
    v = (v << 8n) | BigInt(byte);
  }
  if (signed && n && v >= 1n << BigInt(8 * n - 1)) v -= 1n << BigInt(8 * n);
  return Number(v);
}

/** `value.to_bytes(length, byteorder, signed=...)` */
export function intToBytes(value: number | bigint, length: number, byteorder: "big" | "little", signed = false): Uint8Array {
  let v = BigInt(value);
  if (signed && v < 0n) v += 1n << BigInt(8 * length);
  if (v < 0n || v >= 1n << BigInt(8 * length)) throw new ValueError("int too big to convert");
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[byteorder === "big" ? length - 1 - i : i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** `bytes.isspace()` bytes: space, \t, \n, \v, \f, \r. */
const isWs = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);

/** `data.split()` / `data.split(None, maxsplit)`: runs of ASCII whitespace separate fields. */
function splitWhitespace(data: Uint8Array, maxsplit: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const n = data.length;
  let i = 0;
  while (i < n) {
    while (i < n && isWs(data[i])) i++;
    if (i === n) break;
    if (maxsplit >= 0 && out.length === maxsplit) {
      // The remainder keeps its trailing whitespace, as in CPython.
      out.push(data.slice(i));
      break;
    }
    let j = i;
    while (j < n && !isWs(data[j])) j++;
    out.push(data.slice(i, j));
    i = j;
  }
  return out;
}
/** Latin-1 view of bytes (one char per byte), e.g. to run a byte regex as a string regex. */
export function latin1Str(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    out += Reflect.apply(String.fromCharCode, null, data.subarray(i, i + 0x8000));
  }
  return out;
}

/** Inverse of `latin1Str`; code units above 0xFF keep their low byte. */
export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
