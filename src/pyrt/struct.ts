// Python's `struct` module for the standard-size formats ("<", ">", "!",
// "="). Integers unpack to `number`, except `q`/`Q` which unpack to
// `bigint` (Python ints are unbounded; a u64 does not fit a double).

import { OverflowError, StructError } from "./errors.ts";

/** What `pack` accepts: ints, floats and bools (numeric codes), bytes (`c`, `s`, `p`). */
export type PackValue = number | bigint | boolean | Uint8Array;

type Code = { ch: string; count: number; size: number };

// Type of the tuple `unpack(F, ...)` yields, for a literal format F (`any[]` otherwise).
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type DigitTuple = {
  "0": []; "1": [0]; "2": [0, 0]; "3": [0, 0, 0]; "4": [0, 0, 0, 0]; "5": [0, 0, 0, 0, 0];
  "6": [0, 0, 0, 0, 0, 0]; "7": [0, 0, 0, 0, 0, 0, 0]; "8": [0, 0, 0, 0, 0, 0, 0, 0]; "9": [0, 0, 0, 0, 0, 0, 0, 0, 0];
};
type Times10<T extends 0[]> = [...T, ...T, ...T, ...T, ...T, ...T, ...T, ...T, ...T, ...T];
type CountOf<S extends string, Acc extends 0[] = []> = S extends `${infer D extends Digit}${infer R}`
  ? CountOf<R, [...Times10<Acc>, ...DigitTuple[D]]>
  : Acc;
type SplitCount<S extends string, D extends string = ""> = S extends `${infer C extends Digit}${infer R}`
  ? SplitCount<R, `${D}${C}`>
  : [D, S];
type CodeValue = {
  c: Uint8Array; b: number; B: number; "?": boolean; h: number; H: number; i: number; I: number;
  l: number; L: number; q: bigint; Q: bigint; e: number; f: number; d: number;
};
type Fill<T extends 0[], V> = { [K in keyof T]: V };
type ParseCodes<S extends string> = S extends ""
  ? []
  : S extends ` ${infer R}`
    ? ParseCodes<R>
    : SplitCount<S> extends [infer D extends string, `${infer C}${infer R}`]
      ? C extends "x"
        ? ParseCodes<R>
        : C extends "s" | "p"
          ? [Uint8Array, ...ParseCodes<R>]
          : C extends keyof CodeValue
            ? D extends ""
              ? [CodeValue[C], ...ParseCodes<R>]
              : [...Fill<CountOf<D>, CodeValue[C]>, ...ParseCodes<R>]
            : ParseRun<S>
      : ParseRun<S>;
/** A code whose count is a `number` placeholder (`>${n}d`): that many values of its type. */
type ParseRun<S extends string> = S extends `${number}${infer C}${infer R}`
  ? C extends "x"
    ? ParseCodes<R>
    : C extends "s" | "p"
      ? [Uint8Array, ...ParseCodes<R>]
      : C extends keyof CodeValue
        ? [...CodeValue[C][], ...ParseCodes<R>]
        : PackValue[]
  : PackValue[];
/** The values `struct.unpack(F, data)` yields: a tuple for a literal format, `any[]` otherwise. */
export type Unpacked<F extends string> = string extends F
  ? any[]
  : F extends `${"<" | ">" | "!" | "=" | "@"}${infer R}`
    ? ParseCodes<R>
    : ParseCodes<F>;

const SIZES: Record<string, number> = {
  x: 1, c: 1, b: 1, B: 1, "?": 1, h: 2, H: 2, i: 4, I: 4, l: 4, L: 4,
  q: 8, Q: 8, e: 2, f: 4, d: 8, s: 1, p: 1,
};

const INT_RANGE: Record<string, [number, number]> = {
  b: [-0x80, 0x7f], B: [0, 0xff], h: [-0x8000, 0x7fff], H: [0, 0xffff],
  i: [-0x80000000, 0x7fffffff], I: [0, 0xffffffff], l: [-0x80000000, 0x7fffffff], L: [0, 0xffffffff],
};

const FLOAT32_MAX = 3.4028234663852886e38;

export class Struct<F extends string = string> {
  readonly format: F;
  readonly size: number;
  private readonly le: boolean;
  private readonly codes: Code[];

  constructor(format: F) {
    this.format = format;
    let f: string = format;
    this.le = false;
    const first = f[0];
    if (first === "<" || first === ">" || first === "!" || first === "=" || first === "@") {
      this.le = first === "<" || first === "=" || first === "@";
      f = f.slice(1);
    }
    this.codes = [];
    let size = 0;
    const re = /\s*(\d*)([xcbB?hHiIlLqQefdsp])/y;
    let m: RegExpExecArray | null;
    let pos = 0;
    while (pos < f.length) {
      re.lastIndex = pos;
      m = re.exec(f);
      if (!m) {
        if (/^\s*$/.test(f.slice(pos))) break;
        throw new StructError("bad char in struct format");
      }
      pos = re.lastIndex;
      const count = m[1] === "" ? 1 : Number(m[1]);
      const ch = m[2];
      this.codes.push({ ch, count, size: SIZES[ch] });
      size += SIZES[ch] * count;
    }
    this.size = size;
    let n = 0;
    for (const c of this.codes) {
      if (c.ch === "x") continue;
      n += c.ch === "s" || c.ch === "p" ? 1 : c.count;
    }
    this.nValues = n;
  }

  /** Number of values `unpack` yields. */
  readonly nValues: number;

  /** Compiled `unpackFrom` body; null where code generation is blocked (CSP, Workers). */
  private unpacker: Unpacker | null | undefined;

  /** Compiled `packTo` body (after the arity check); null where code generation is blocked. */
  private packer: Packer | null | undefined;

  unpack(data: Uint8Array): Unpacked<F>;
  unpack(data: Uint8Array): PackValue[] {
    if (data.length !== this.size) {
      throw new StructError(`unpack requires a buffer of ${this.size} bytes`);
    }
    return this.unpackFrom(data, 0);
  }

  unpackFrom(data: Uint8Array, offset?: number): Unpacked<F>;
  unpackFrom(data: Uint8Array, offset = 0): PackValue[] {
    if (data.length - offset < this.size) {
      throw new StructError(`unpack_from requires a buffer of at least ${this.size + offset} bytes`);
    }
    if (this.unpacker === undefined) this.unpacker = compileUnpack(this.codes, this.le);
    if (this.unpacker !== null) return this.unpacker(data, offset);
    // Integers are assembled from bytes and floats go through a scratch view:
    // `data.buffer` would make JSC materialize a backing store per call.
    const d = data;
    const le = this.le;
    const out: PackValue[] = [];
    let p = offset;
    for (const { ch, count } of this.codes) {
      if (ch === "x") {
        p += count;
        continue;
      }
      if (ch === "s" || ch === "p") {
        out.push(d.slice(p, p + count));
        p += count;
        continue;
      }
      for (let k = 0; k < count; k++) {
        switch (ch) {
          case "c": out.push(d.slice(p, p + 1)); break;
          case "b": out.push((d[p] << 24) >> 24); break;
          case "B": out.push(d[p]); break;
          case "?": out.push(d[p] !== 0); break;
          case "h": out.push((u16(d, p, le) << 16) >> 16); break;
          case "H": out.push(u16(d, p, le)); break;
          case "i": case "l": out.push(u32(d, p, le) | 0); break;
          case "I": case "L": out.push(u32(d, p, le)); break;
          case "q": out.push(scratch(d, p, 8).getBigInt64(0, le)); break;
          case "Q": out.push(scratch(d, p, 8).getBigUint64(0, le)); break;
          case "e": out.push(halfToFloat(u16(d, p, le))); break;
          case "f": out.push(scratch(d, p, 4).getFloat32(0, le)); break;
          case "d": out.push(scratch(d, p, 8).getFloat64(0, le)); break;
        }
        p += SIZES[ch];
      }
    }
    return out;
  }

  pack(...values: PackValue[]): Uint8Array {
    const out = new Uint8Array(this.size);
    this.packTo(out, 0, values);
    return out;
  }

  /**
   * `pack(*values)` written into `out` at `offset`, which must have room for
   * `size` bytes. Pad bytes are zeroed, so `out` need not be zero-filled; on a
   * bad value, bytes before the failing field are already written.
   */
  packTo(out: Uint8Array, offset: number, values: PackValue[]): void {
    if (values.length !== this.nValues) {
      throw new StructError(`pack expected ${this.nValues} items for packing (got ${values.length})`);
    }
    if (this.packer === undefined) this.packer = compilePack(this.codes, this.le);
    if (this.packer !== null) return this.packer(out, offset, values);
    const le = this.le;
    let p = offset;
    let vi = 0;
    for (const { ch, count } of this.codes) {
      if (ch === "x") {
        out.fill(0, p, p + count);
        p += count;
        continue;
      }
      if (ch === "s" || ch === "p") {
        packS(out, p, values[vi++], count);
        p += count;
        continue;
      }
      for (let k = 0; k < count; k++) {
        packOne(out, p, ch, values[vi++], le);
        p += SIZES[ch];
      }
    }
  }
}

/** Pack an `s`/`p` field: `v` truncated or zero-padded to `count` bytes. */
function packS(out: Uint8Array, p: number, v: PackValue, count: number): void {
  if (!(v instanceof Uint8Array)) throw new StructError("argument for 's' must be a bytes object");
  const n = Math.min(v.length, count);
  for (let i = 0; i < n; i++) out[p + i] = v[i];
  if (n < count) out.fill(0, p + n, p + count);
}

function rangeError(ch: string): StructError {
  const range = INT_RANGE[ch];
  return new StructError(`'${ch}' format requires ${range[0]} <= number <= ${range[1]}`);
}

/** Pack one value of a single-item code (anything but `x`, `s`, `p`) at `p`. */
function packOne(out: Uint8Array, p: number, ch: string, v: PackValue, le: boolean): void {
  switch (ch) {
    case "c":
      if (!(v instanceof Uint8Array) || v.length !== 1) {
        throw new StructError("char format requires a bytes object of length 1");
      }
      out[p] = v[0];
      break;
    case "?":
      out[p] = v ? 1 : 0;
      break;
    case "q":
    case "Q": {
      const big = toBigint(v);
      if (ch === "Q") {
        if (big < 0n || big > 0xffffffffffffffffn) throw new StructError("argument out of range");
        SCRATCH_DV.setBigUint64(0, big, le);
      } else {
        if (big < -0x8000000000000000n || big > 0x7fffffffffffffffn) throw new StructError("argument out of range");
        SCRATCH_DV.setBigInt64(0, big, le);
      }
      out.set(SCRATCH_U8, p);
      break;
    }
    case "e":
      put16(out, p, floatToHalf(toFloat(v)), le);
      break;
    case "f": {
      const x = toFloat(v);
      if (Number.isFinite(x) && Math.abs(x) > FLOAT32_MAX && !Number.isFinite(Math.fround(x))) {
        throw new OverflowError("float too large to pack with f format");
      }
      SCRATCH_DV.setFloat32(0, x, le);
      out[p] = SCRATCH_U8[0];
      out[p + 1] = SCRATCH_U8[1];
      out[p + 2] = SCRATCH_U8[2];
      out[p + 3] = SCRATCH_U8[3];
      break;
    }
    case "d":
      SCRATCH_DV.setFloat64(0, toFloat(v), le);
      out.set(SCRATCH_U8, p);
      break;
    default: {
      const n = toInt(v);
      const range = INT_RANGE[ch];
      if (n < range[0] || n > range[1]) throw rangeError(ch);
      // Uint8Array stores take the low 8 bits, which covers negative values.
      switch (ch) {
        case "b": case "B": out[p] = n; break;
        case "h": case "H": put16(out, p, n, le); break;
        default: put32(out, p, n, le); break;
      }
    }
  }
}

type Packer = (out: Uint8Array, p: number, v: PackValue[]) => void;

/** Straight-line `packTo` for `codes`: integers inline, other codes through `packOne` in order. */
function compilePack(codes: Code[], le: boolean): Packer | null {
  const body = ["let n;"];
  let k = 0;
  let vi = 0;
  for (const { ch, count } of codes) {
    if (ch === "x") {
      body.push(`out.fill(0,p+${k},p+${k + count});`);
      k += count;
      continue;
    }
    if (ch === "s" || ch === "p") {
      body.push(`pack_s(out,p+${k},v[${vi++}],${count});`);
      k += count;
      continue;
    }
    if (vi + count > 256) return null;
    for (let i = 0; i < count; i++) {
      const range = INT_RANGE[ch];
      if (range === undefined) {
        body.push(`pack_one(out,p+${k},${JSON.stringify(ch)},v[${vi++}],${le});`);
      } else {
        body.push(`n=to_int(v[${vi++}]);if(n<${range[0]}||n>${range[1]})throw range_error(${JSON.stringify(ch)});`);
        const size = SIZES[ch];
        const order = le ? [...Array(size).keys()] : [...Array(size).keys()].reverse();
        for (let b = 0; b < size; b++) body.push(`out[p+${k + order[b]}]=n${b ? `>>>${8 * b}` : ""};`);
      }
      k += SIZES[ch];
    }
  }
  try {
    return new Function("to_int", "pack_one", "pack_s", "range_error", `return (out, p, v) => {${body.join("")}};`)(
      toInt,
      packOne,
      packS,
      rangeError,
    );
  } catch {
    return null;
  }
}

type Unpacker = (d: Uint8Array, p: number) => PackValue[];

/** Straight-line `unpackFrom` for `codes`: one expression per value at a fixed offset. */
function compileUnpack(codes: Code[], le: boolean): Unpacker | null {
  const u16 = (k: number) => (le ? `(d[p+${k}]|d[p+${k + 1}]<<8)` : `(d[p+${k}]<<8|d[p+${k + 1}])`);
  const u32 = (k: number) =>
    le
      ? `(d[p+${k}]|d[p+${k + 1}]<<8|d[p+${k + 2}]<<16|d[p+${k + 3}]<<24)`
      : `(d[p+${k}]<<24|d[p+${k + 1}]<<16|d[p+${k + 2}]<<8|d[p+${k + 3}])`;
  const exprs: string[] = [];
  let k = 0;
  for (const { ch, count } of codes) {
    if (ch === "x") {
      k += count;
      continue;
    }
    if (ch === "s" || ch === "p") {
      exprs.push(`d.slice(p+${k},p+${k + count})`);
      k += count;
      continue;
    }
    if (exprs.length + count > 256) return null;
    for (let i = 0; i < count; i++) {
      switch (ch) {
        case "c": exprs.push(`d.slice(p+${k},p+${k + 1})`); break;
        case "b": exprs.push(`d[p+${k}]<<24>>24`); break;
        case "B": exprs.push(`d[p+${k}]`); break;
        case "?": exprs.push(`d[p+${k}]!==0`); break;
        case "h": exprs.push(`${u16(k)}<<16>>16`); break;
        case "H": exprs.push(u16(k)); break;
        case "i": case "l": exprs.push(`${u32(k)}|0`); break;
        case "I": case "L": exprs.push(`${u32(k)}>>>0`); break;
        case "q": exprs.push(`scratch(d,p+${k},8).getBigInt64(0,${le})`); break;
        case "Q": exprs.push(`scratch(d,p+${k},8).getBigUint64(0,${le})`); break;
        case "e": exprs.push(`half_to_float(${u16(k)})`); break;
        case "f": exprs.push(`scratch(d,p+${k},4).getFloat32(0,${le})`); break;
        case "d": exprs.push(`scratch(d,p+${k},8).getFloat64(0,${le})`); break;
      }
      k += SIZES[ch];
    }
  }
  try {
    return new Function("scratch", "half_to_float", `return (d, p) => [${exprs.join(",")}];`)(scratch, halfToFloat);
  } catch {
    return null;
  }
}

function put16(out: Uint8Array, p: number, n: number, le: boolean): void {
  if (le) {
    out[p] = n;
    out[p + 1] = n >> 8;
  } else {
    out[p] = n >> 8;
    out[p + 1] = n;
  }
}

function put32(out: Uint8Array, p: number, n: number, le: boolean): void {
  if (le) {
    out[p] = n;
    out[p + 1] = n >>> 8;
    out[p + 2] = n >>> 16;
    out[p + 3] = n >>> 24;
  } else {
    out[p] = n >>> 24;
    out[p + 1] = n >>> 16;
    out[p + 2] = n >>> 8;
    out[p + 3] = n;
  }
}

function u16(d: Uint8Array, p: number, le: boolean): number {
  return le ? d[p] | (d[p + 1] << 8) : (d[p] << 8) | d[p + 1];
}

function u32(d: Uint8Array, p: number, le: boolean): number {
  return (le
    ? d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)
    : (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
}

const SCRATCH = new ArrayBuffer(8);
const SCRATCH_U8 = new Uint8Array(SCRATCH);
const SCRATCH_DV = new DataView(SCRATCH);

/** Copy `n` bytes at `p` into the scratch buffer and return its view (read at offset 0). */
function scratch(d: Uint8Array, p: number, n: number): DataView {
  for (let i = 0; i < n; i++) SCRATCH_U8[i] = d[p + i];
  return SCRATCH_DV;
}

function toInt(v: PackValue): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new StructError("required argument is not an integer");
  }
  return v;
}

function toBigint(v: PackValue): bigint {
  if (typeof v === "bigint") return v;
  return BigInt(toInt(v));
}

function toFloat(v: PackValue): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v !== "number") throw new StructError("required argument is not a float");
  return v;
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

function floatToHalf(x: number): number {
  const f32 = new Float32Array([x]);
  const u = new Uint32Array(f32.buffer)[0];
  const sign = (u >> 16) & 0x8000;
  const exp = ((u >> 23) & 0xff) - 127 + 15;
  const mant = u & 0x7fffff;
  if (Number.isNaN(x)) return sign | 0x7e00;
  if (exp >= 31) {
    if (Number.isFinite(x)) throw new OverflowError("float too large to pack with e format");
    return sign | 0x7c00;
  }
  if (exp <= 0) return sign | Math.round((mant | 0x800000) / 2 ** (14 - exp));
  return sign | (exp << 10) | Math.round(mant / 0x2000);
}

const CACHE = new Map<string, Struct>();

function get(format: string): Struct {
  let s = CACHE.get(format);
  if (s === undefined) {
    s = new Struct(format);
    CACHE.set(format, s);
  }
  return s;
}

/** `struct.pack(fmt, *values)` */
export function pack(format: string, ...values: PackValue[]): Uint8Array {
  return get(format).pack(...values);
}

/** `struct.unpack(fmt, data)` */
export function unpack<F extends string>(format: F, data: Uint8Array): Unpacked<F>;
export function unpack(format: string, data: Uint8Array): PackValue[] {
  return get(format).unpack(data);
}

/** `struct.unpack_from(fmt, data, offset)` */
export function unpackFrom<F extends string>(format: F, data: Uint8Array, offset?: number): Unpacked<F>;
export function unpackFrom(format: string, data: Uint8Array, offset = 0): PackValue[] {
  return get(format).unpackFrom(data, offset);
}

/** `struct.pack_into(fmt, buffer, offset, *values)` (negative offsets count from the end). */
export function packInto(format: string, buffer: Uint8Array, offset: number, ...values: PackValue[]): void {
  const s = get(format);
  if (offset < 0) {
    if (offset + s.size > 0) throw new StructError(`no space to pack ${s.size} bytes at offset ${offset}`);
    if (offset + buffer.length < 0) throw new StructError(`offset ${offset} out of range for ${buffer.length}-byte buffer`);
    offset += buffer.length;
  }
  if (buffer.length - offset < s.size) {
    throw new StructError(
      `pack_into requires a buffer of at least ${s.size + offset} bytes for packing ${s.size} bytes at offset ${offset} (actual buffer size is ${buffer.length})`,
    );
  }
  buffer.set(s.pack(...values), offset);
}

/** `struct.calcsize(fmt)` */
export function calcsize(format: string): number {
  return get(format).size;
}
