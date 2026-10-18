/**
 * Low-level binary I/O primitives for AEP chunk parsing.
 *
 * All functions default to big-endian because AEP files are always RIFX.
 * The `endian` parameter on `readFmt` / `writeFmt` exists for typed chunks
 * that have little-endian fields.
 */

import {
  Fraction,
  OSError,
  ValueError,
  decode,
  divmod,
  encode,
  floatRepr,
  struct,
  type ByteStream,
} from "../../pyrt/index.ts";

export const _HEADER_STRUCT = new struct.Struct(">4sI");
export const _STRUCT_CACHE = new Map<string, struct.Struct>();

export const _INT32_MIN = -(2 ** 31);
export const _INT32_MAX = 2 ** 31 - 1;

/**
 * Seconds between the Mac epoch (1904-01-01) AE stamps file and item times
 * with and the Unix epoch.
 */
export const MAC_EPOCH_OFFSET = 2082844800;

/**
 * Split `value` into the `(dividend, divisor)` integers AE stores for its
 * time / ratio fields.
 *
 * AEP encodes many quantities - layer and comp times, durations, pixel
 * aspect, render time spans - as a signed-32-bit dividend over an
 * unsigned-32-bit divisor. The denominator is capped from the value's
 * magnitude so the dividend always fits int32: precision degrades gracefully
 * for very large values rather than overflowing `struct.pack` and silently
 * truncating the saved file.
 *
 * @throws {@link ValueError} If the value's whole part alone cannot fit int32 (about 68 years for a
 *   time field) - which also rejects `nan` / `inf`.
 */
export function toDividendDivisor(value: number): [number, number] {
  if (!(_INT32_MIN <= value && value <= _INT32_MAX)) {
    throw new ValueError(
      `ratio value ${floatRepr(value)} is out of range (must be within +/-${_INT32_MAX})`,
    );
  }
  // |dividend| ~= |value| * denominator, so capping the denominator at
  // INT32_MAX // (|value| + 2) keeps the dividend strictly inside int32.
  const maxDenominator = Math.max(1, Math.floor(_INT32_MAX / (Math.trunc(Math.abs(value)) + 2)));
  const frac = new Fraction(value).limitDenominator(Math.min(1_000_000, maxDenominator));
  return [frac.numerator, frac.denominator];
}

/**
 * Split `value` into the `(dividend, divisor)` AE stores for a comp's
 * display start time or a layer's stretch: the value rounded to float32,
 * as an exact ratio, with the divisor held to the signed 32-bit range.
 *
 * Measured on AE 2026: 0.51 -\> 2139095/4194304, 0.5 -\> 1/2, and
 * 8.33e-7 (whose exact float32 ratio needs a 2^44 divisor) -\>
 * 330/396000001.
 */
export function toFloat32Ratio(value: number): [number, number] {
  const frac = new Fraction(toF4(value)).limitDenominator(_INT32_MAX);
  return [frac.numerator, frac.denominator];
}

/**
 * Split `value` into the `(integer, fractional)` parts of a 16.16 fixed
 * point number (fraction in 1/65536 units), as AE stores frame rates.
 *
 * The whole value is rounded before the split: rounding the fraction alone
 * turns 23.99999999 into 23 + 65536/65536, which overflows a u2 fraction.
 */
export function toFixed1616(value: number): [number, number] {
  return divmod(Math.round(value * 65536) + 0, 65536);
}

/** Return a cached `struct.Struct` for `fullFmt`. */
export function _getStruct(fullFmt: string): struct.Struct {
  let s = _STRUCT_CACHE.get(fullFmt);
  if (s == null) {
    s = new struct.Struct(fullFmt);
    _STRUCT_CACHE.set(fullFmt, s);
  }
  return s;
}

const _BIG_ENDIAN_STRUCTS = new Map<string, struct.Struct>();
const _STRUCTS_BY_ENDIAN = new Map<string, Map<string, struct.Struct>>([[">", _BIG_ENDIAN_STRUCTS]]);

/** `_get_struct(endian + fmt)` without building the key string on a hit. */
export function _structFor(fmt: string, endian = ">"): struct.Struct {
  let byFmt = endian === ">" ? _BIG_ENDIAN_STRUCTS : _STRUCTS_BY_ENDIAN.get(endian);
  if (byFmt === undefined) _STRUCTS_BY_ENDIAN.set(endian, (byFmt = new Map()));
  let s = byFmt.get(fmt);
  if (s === undefined) {
    s = _getStruct(endian + fmt);
    byFmt.set(fmt, s);
  }
  return s;
}

/**
 * Read and unpack binary data from `fp`.
 *
 * Prepends `endian` to `fmt`, reads the required number of bytes, and
 * unpacks them.
 *
 * @throws {@link IOError} If fewer bytes are available than the format requires.
 */
export function readFmt<F extends string>(fmt: F, fp: ByteStream, endian?: string): struct.Unpacked<F>;
export function readFmt(fmt: string, fp: ByteStream, endian = ">"): struct.Unpacked<string> {
  const s = _structFor(fmt, endian);
  const values = fp.unpack(s);
  if (values === null) {
    // Consume the short tail, as `fp.read(s.size)` does in Python.
    const got = fp.read(s.size).length;
    throw new OSError(`Short read: expected ${s.size} bytes, got ${got}`);
  }
  return values;
}

/**
 * Pack and write binary data to `fp`.
 *
 * Returns bytes written.
 */
// Python's keyword-only `endian` follows `*args`; in TS it is a trailing plain
// `{ endian }` options object (struct values are never plain objects).
export type WriteFmtOptions = { endian?: string };
function _isWriteFmtOptions(v: struct.PackValue | WriteFmtOptions | undefined): v is WriteFmtOptions {
  return v != null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}
export function writeFmt(fp: ByteStream, fmt: string, ...args: struct.PackValue[] | [...struct.PackValue[], WriteFmtOptions]): number {
  const items: (struct.PackValue | WriteFmtOptions)[] = args;
  const last = items[items.length - 1];
  const opts = _isWriteFmtOptions(last) ? last : {};
  const values = items.filter((v): v is struct.PackValue => !_isWriteFmtOptions(v));
  return fp.pack(_structFor(fmt, opts.endian), values);
}

/** The largest finite IEEE-754 single (float32). */
export const FLOAT32_MAX = 3.4028234663852886e38;

/** Round a Python float (f8) to float32 (f4) precision. */
export function toF4(value: number): number {
  return struct.unpack("<f", struct.pack("<f", value))[0];
}

/**
 * Read exactly `size` bytes from `fp`.
 *
 * @throws {@link IOError} If fewer bytes are available than requested.
 */
export function readBytes(fp: ByteStream, size: number): Uint8Array {
  const data = fp.read(size);
  if (data.length < size) {
    throw new OSError(`Short read: expected ${size} bytes, got ${data.length}`);
  }
  return data;
}

/** Write raw bytes to `fp`. Returns bytes written. */
export function writeBytes(fp: ByteStream, data: Uint8Array): number {
  fp.write(data);
  return data.length;
}

/**
 * Encode `value` to UTF-8, truncated to at most `maxBytes` bytes.
 *
 * Slicing UTF-8 bytes can split a multibyte character; decoding the slice
 * with `errors="ignore"` drops any trailing partial sequence, so the result
 * is always valid UTF-8 and never exceeds `maxBytes`. Used for fixed-width
 * AEP name fields.
 */
export function truncateUtf8(value: string, maxBytes: number): Uint8Array {
  return encode(decode(encode(value, "utf-8").slice(0, maxBytes), "utf-8", "ignore"), "utf-8");
}

/** Check if `size` bytes can be read without consuming them. */
export function isReadable(fp: ByteStream, size = 1): boolean {
  const pos = fp.tell();
  const data = fp.read(size);
  fp.seek(pos);
  return data.length >= size;
}

/** The pad byte; `write` copies it out. */
const _PAD = new Uint8Array(1);

/** Write a pad byte if `size` is odd. Returns bytes written (0 or 1). */
export function writePad(fp: ByteStream, size: number): number {
  if (size % 2 !== 0) {
    fp.write(_PAD);
    return 1;
  }
  return 0;
}

/** Consume a pad byte if `size` is odd. */
export function readPad(fp: ByteStream, size: number): void {
  if (size % 2 !== 0) {
    fp.readByte();
  }
}
