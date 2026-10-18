/**
 * Low-level binary I/O primitives for AEP chunk parsing.
 *
 * All functions default to big-endian because AEP files are always RIFX.
 * The `endian` parameter on `read_fmt` / `write_fmt` exists for typed chunks
 * that have little-endian fields.
 */

import {
  Fraction,
  OSError,
  ValueError,
  bytes_,
  b,
  decode,
  divmod,
  encode,
  float_repr,
  floordiv,
  int,
  round,
  struct,
  type IO,
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
export function to_dividend_divisor(value: number): [number, number] {
  if (!(_INT32_MIN <= value && value <= _INT32_MAX)) {
    throw new ValueError(
      `ratio value ${float_repr(value)} is out of range (must be within +/-${_INT32_MAX})`,
    );
  }
  // |dividend| ~= |value| * denominator, so capping the denominator at
  // INT32_MAX // (|value| + 2) keeps the dividend strictly inside int32.
  const max_denominator = Math.max(1, floordiv(_INT32_MAX, int(Math.abs(value)) + 2));
  const frac = new Fraction(value).limit_denominator(Math.min(1_000_000, max_denominator));
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
export function to_float32_ratio(value: number): [number, number] {
  const frac = new Fraction(to_f4(value)).limit_denominator(_INT32_MAX);
  return [frac.numerator, frac.denominator];
}

/**
 * Split `value` into the `(integer, fractional)` parts of a 16.16 fixed
 * point number (fraction in 1/65536 units), as AE stores frame rates.
 *
 * The whole value is rounded before the split: rounding the fraction alone
 * turns 23.99999999 into 23 + 65536/65536, which overflows a u2 fraction.
 */
export function to_fixed_16_16(value: number): [number, number] {
  return divmod(round(value * 65536), 65536);
}

/** Return a cached `struct.Struct` for `full_fmt`. */
export function _get_struct(full_fmt: string): struct.Struct {
  let s = _STRUCT_CACHE.get(full_fmt);
  if (s == null) {
    s = new struct.Struct(full_fmt);
    _STRUCT_CACHE.set(full_fmt, s);
  }
  return s;
}

const _BIG_ENDIAN_STRUCTS = new Map<string, struct.Struct>();
const _STRUCTS_BY_ENDIAN = new Map<string, Map<string, struct.Struct>>([[">", _BIG_ENDIAN_STRUCTS]]);

/** `_get_struct(endian + fmt)` without building the key string on a hit. */
export function _struct_for(fmt: string, endian = ">"): struct.Struct {
  let by_fmt = endian === ">" ? _BIG_ENDIAN_STRUCTS : _STRUCTS_BY_ENDIAN.get(endian);
  if (by_fmt === undefined) _STRUCTS_BY_ENDIAN.set(endian, (by_fmt = new Map()));
  let s = by_fmt.get(fmt);
  if (s === undefined) {
    s = _get_struct(endian + fmt);
    by_fmt.set(fmt, s);
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
export function read_fmt<F extends string>(fmt: F, fp: IO, endian?: string): struct.Unpacked<F>;
export function read_fmt(fmt: string, fp: IO, endian = ">"): struct.Unpacked<string> {
  const s = _struct_for(fmt, endian);
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
function _is_write_fmt_options(v: struct.PackValue | WriteFmtOptions | undefined): v is WriteFmtOptions {
  return v != null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}
export function write_fmt(fp: IO, fmt: string, ...args: struct.PackValue[] | [...struct.PackValue[], WriteFmtOptions]): number {
  const items: (struct.PackValue | WriteFmtOptions)[] = args;
  const last = items[items.length - 1];
  const opts = _is_write_fmt_options(last) ? last : {};
  const values = items.filter((v): v is struct.PackValue => !_is_write_fmt_options(v));
  return fp.pack(_struct_for(fmt, opts.endian), values);
}

/** The largest finite IEEE-754 single (float32). */
export const FLOAT32_MAX = 3.4028234663852886e38;

/** Round a Python float (f8) to float32 (f4) precision. */
export function to_f4(value: number): number {
  return struct.unpack("<f", struct.pack("<f", value))[0];
}

/**
 * Read exactly `size` bytes from `fp`.
 *
 * @throws {@link IOError} If fewer bytes are available than requested.
 */
export function read_bytes(fp: IO, size: number): Uint8Array {
  const data = fp.read(size);
  if (data.length < size) {
    throw new OSError(`Short read: expected ${size} bytes, got ${data.length}`);
  }
  return data;
}

/** Write raw bytes to `fp`. Returns bytes written. */
export function write_bytes(fp: IO, data: Uint8Array): number {
  fp.write(data);
  return data.length;
}

/**
 * Encode `value` to UTF-8, truncated to at most `max_bytes` bytes.
 *
 * Slicing UTF-8 bytes can split a multibyte character; decoding the slice
 * with `errors="ignore"` drops any trailing partial sequence, so the result
 * is always valid UTF-8 and never exceeds `max_bytes`. Used for fixed-width
 * AEP name fields.
 */
export function truncate_utf8(value: string, max_bytes: number): Uint8Array {
  return encode(decode(bytes_.slice(encode(value, "utf-8"), 0, max_bytes), "utf-8", "ignore"), "utf-8");
}

/** Check if `size` bytes can be read without consuming them. */
export function is_readable(fp: IO, size = 1): boolean {
  const pos = fp.tell();
  const data = fp.read(size);
  fp.seek(pos);
  return data.length >= size;
}

/** Write a pad byte if `size` is odd. Returns bytes written (0 or 1). */
export function write_pad(fp: IO, size: number): number {
  if (size % 2 !== 0) {
    fp.write(b("\x00"));
    return 1;
  }
  return 0;
}

/** Consume a pad byte if `size` is odd. */
export function read_pad(fp: IO, size: number): void {
  if (size % 2 !== 0) {
    fp.read_byte();
  }
}
