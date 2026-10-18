// Python numeric semantics that differ from JS operators.

import { INSPECT } from "./inspect.ts";
import { OverflowError, ValueError, ZeroDivisionError } from "./errors.ts";
import { ord } from "./codecs.ts";

/**
 * A Python `float` whose float-ness must survive in data that is later
 * serialized by type (COS text-document blobs write `1.0` for a float and
 * `1` for an int). JS has one number type, so an integral float would be
 * indistinguishable from an int; boxing carries the distinction with the
 * value through copies and container moves. Arithmetic and relational
 * operators unwrap it through `valueOf`; `===`, `typeof` and the
 * `Number.is*` predicates do not, so compare through `valueEquals` / `unbox`.
 */
export class PyFloat {
  declare readonly value: number;
  constructor(value: number) {
    this.value = +value;
  }
  valueOf(): number {
    return this.value;
  }
  toString(): string {
    return floatRepr(this.value);
  }
  toJSON(): number {
    return this.value;
  }
  [INSPECT](): string {
    return floatRepr(this.value);
  }
  toBoolean(): boolean {
    return this.value !== 0;
  }
  equals(other: unknown): boolean {
    return unbox(other) === this.value;
  }
  deepCopy(): PyFloat {
    return this;
  }
}

/** Python `float(x)` kept as a float: a boxed `PyFloat` (see `PyFloat`). */
export function pyfloat(x: number | PyFloat): PyFloat {
  return x instanceof PyFloat ? x : new PyFloat(x);
}

/** `isinstance(x, (int, float))` without the bool case: a JS number or a boxed `PyFloat`. */
export function isReal(x: unknown): x is number | PyFloat {
  return typeof x === "number" || x instanceof PyFloat;
}

/** The plain JS number behind a possibly boxed `PyFloat`; other values pass through. */
export function unbox(x: number | PyFloat): number;
export function unbox<T>(x: T): T extends PyFloat ? number : T;
export function unbox<T>(x: T): T | number {
  return (x instanceof PyFloat ? x.value : x);
}

/**
 * `a / b` (true division) raising `ZeroDivisionError` like CPython 3.12:
 * "float division by zero" when an operand is a float, "division by zero"
 * for int / int. JS cannot see int-ness of an integral number, so the caller
 * states it: `operands` is `"float"` (default) or `"int"`; a boxed `PyFloat`
 * operand always counts as float.
 */
export function truediv(a: number | PyFloat, b: number | PyFloat, operands: "float" | "int" = "float"): number {
  const isFloat = operands === "float" || a instanceof PyFloat || b instanceof PyFloat;
  const x = unbox(a);
  const y = unbox(b);
  if (y === 0) throw new ZeroDivisionError(isFloat ? "float division by zero" : "division by zero");
  return x / y;
}

/** `a // b` (floor division; ZeroDivisionError on 0). */
export function floordiv(a: number, b: number): number {
  if (b === 0) throw new ZeroDivisionError("division by zero");
  if (Number.isInteger(a) && Number.isInteger(b) && Math.abs(a) < 2 ** 53 && Math.abs(b) < 2 ** 53) {
    return Math.floor(a / b);
  }
  // CPython float floordiv: (a - a % b) / b, then fixed up.
  const mod = a % b;
  let div = (a - mod) / b;
  if (mod && b < 0 !== mod < 0) div -= 1;
  if (div) {
    const floordiv = Math.floor(div);
    if (div - floordiv > 0.5) return floordiv + 1;
    return floordiv;
  }
  return Math.sign(a / b) * 0;
}

/** `a % b` (result takes the sign of `b`). */
export function mod(a: number, b: number): number {
  if (b === 0) throw new ZeroDivisionError("modulo by zero");
  const r = a % b;
  if (r && r < 0 !== b < 0) return r + b;
  if (!r) return b < 0 ? -0 : 0;
  return r;
}

/** `divmod(a, b)` */
export function divmod(a: number, b: number): [number, number] {
  return [floordiv(a, b), mod(a, b)];
}

// `str.isspace()` characters (CPython's Py_UNICODE_ISSPACE).
const PY_SPACE = /[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const ND = /\p{Nd}/u;

/** Digit value of a Unicode decimal digit (Nd digits come in runs of ten from zero). */
function ndValue(cp: number): number {
  let start = cp;
  while (ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/**
 * `_PyUnicode_TransformDecimalAndSpaceToASCII`: Unicode whitespace becomes a
 * space and Unicode decimal digits their ASCII digit; any other non-ASCII
 * character becomes `?` (always invalid downstream).
 */
function toAsciiNumber(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ord(ch);
    if (cp < 128) out += PY_SPACE.test(ch) ? " " : ch;
    else if (PY_SPACE.test(ch)) out += " ";
    else if (ND.test(ch)) out += String(ndValue(cp));
    else out += "?";
  }
  return out;
}

/** Python's `%.200R`: the repr cut to 200 characters. */
function repr200(x: string): string {
  // Local repr of a str (num.ts cannot import builtins.ts: cycle).
  const q = x.includes("'") && !x.includes('"') ? '"' : "'";
  const body = x
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(q === "'" ? /'/g : /"/g, `\\${q}`)
    .replace(/[\x00-\x1f\x7f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  return Array.from(q + body + q).slice(0, 200).join("");
}

const ASCII_WS = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const SHORT_DECIMAL_INT = /^[+-]?[0-9]{1,15}$/;
const SIMPLE_DECIMAL_FLOAT = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$/;

/**
 * `int(x)` / `int(text, base)`: floats truncate toward zero (raising like
 * Python on nan/inf); text follows `PyLong_FromString` - surrounding
 * whitespace, a sign, base prefixes (base 0, 2, 8, 16), single underscores
 * between digits, and Unicode decimal digits (`int("\u0663")` is 3).
 */
export function int(x: number | string | boolean | bigint | PyFloat | String, base = 10): number {
  if (x instanceof PyFloat) x = x.value;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "string" || x instanceof String) {
    const orig = String(x);
    // Fast path for plain ASCII decimal text short enough to be exact as a double; the
    // general parse below walks a BigInt per digit. `+ 0` turns "-0" into 0.
    if (base === 10 && SHORT_DECIMAL_INT.test(orig)) return Number(orig) + 0;
    if (base !== 0 && (base < 2 || base > 36)) throw new ValueError("int() base must be >= 2 and <= 36, or 0");
    const bad = (): never => {
      throw new ValueError(`invalid literal for int() with base ${base}: ${repr200(orig)}`);
    };
    let t = toAsciiNumber(orig).replace(ASCII_WS, "");
    let neg = false;
    if (t[0] === "+" || t[0] === "-") {
      neg = t[0] === "-";
      t = t.slice(1);
    }
    let b = base;
    const p = t.slice(0, 2).toLowerCase();
    const prefixed = (p === "0x" && (b === 16 || b === 0)) || (p === "0o" && (b === 8 || b === 0)) || (p === "0b" && (b === 2 || b === 0));
    if (b === 0) {
      if (prefixed) b = p === "0x" ? 16 : p === "0o" ? 8 : 2;
      else {
        b = 10;
        // Base 0: a leading zero is only allowed for zero itself.
        if (/^0/.test(t) && !/^0+(_0+)*$/.test(t)) bad();
      }
    }
    if (prefixed) {
      t = t.slice(2);
      if (t[0] === "_") t = t.slice(1); // `0x_1f`
    }
    const valid = DIGITS.slice(0, b);
    if (t === "" || t[0] === "_" || t.at(-1) === "_" || t.includes("__")) bad();
    let v = 0n;
    for (const ch of t.toLowerCase()) {
      if (ch === "_") continue;
      const d = valid.indexOf(ch);
      if (d < 0) bad();
      v = v * BigInt(b) + BigInt(d);
    }
    const n = Number(v);
    return neg ? (n === 0 ? 0 : -n) : n;
  }
  if (Number.isNaN(x)) throw new ValueError("cannot convert float NaN to integer");
  if (!Number.isFinite(x)) throw new OverflowError("cannot convert float infinity to integer");
  return Math.trunc(x) || 0;
}

/**
 * `float(text)`: `PyFloat_FromString` - surrounding whitespace, Unicode
 * decimal digits, underscores between digits, inf / infinity / nan.
 */
export function float(x: string | number | boolean | PyFloat | String): number {
  if (x instanceof PyFloat) return x.value;
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  const orig = String(x);
  // Plain ASCII decimal text needs none of the normalization below.
  if (SIMPLE_DECIMAL_FLOAT.test(orig)) return Number(orig);
  const bad = (): never => {
    throw new ValueError(`could not convert string to float: ${repr200(orig)}`);
  };
  let s = toAsciiNumber(orig).replace(ASCII_WS, "");
  if (s.includes("_")) {
    // Each underscore must sit between two digits.
    if (!/^[^_]*$|^(?:[^_]|(?<=[0-9])_(?=[0-9]))*$/.test(s)) bad();
    s = s.replace(/_/g, "");
  }
  const l = s.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(l)) return l.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(l)) return NaN;
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) bad();
  return Number(s);
}

/** The exact rational value of a finite double as `num / 2**exp2` (exp2 >= 0) or `num * 2**-exp2`. */
export function floatAsRatio(x: number): [bigint, bigint] {
  if (!Number.isFinite(x)) throw new OverflowError("cannot convert Infinity to integer ratio");
  if (x === 0) return [0n, 1n];
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  while (mant && !(mant & 1n)) {
    mant >>= 1n;
    e += 1;
  }
  if (e >= 0) return [sign * (mant << BigInt(e)), 1n];
  return [sign * mant, 1n << BigInt(-e)];
}

/**
 * Python `round(x)` (ties to even, returns an int) and `round(x, n)`
 * (correctly rounded on the exact binary value, ties to even).
 */
export function round(x: number | PyFloat, ndigits?: number | null): number {
  if (x instanceof PyFloat) x = x.value;
  if (ndigits == null) {
    if (Number.isNaN(x)) throw new ValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(x)) throw new OverflowError("cannot convert float infinity to integer");
    const f = Math.floor(x);
    const diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f || 0;
    return (f % 2 === 0 ? f : f + 1) || 0;
  }
  if (!Number.isFinite(x) || x === 0) return x;
  if (Number.isInteger(x) && ndigits >= 0) return x;
  const [num, den] = floatAsRatio(x);
  // value * 10**n = num * 10**n / den, rounded half-even to an integer q.
  let scaledNum = num;
  let scaledDen = den;
  if (ndigits >= 0) scaledNum *= 10n ** BigInt(ndigits);
  else scaledDen *= 10n ** BigInt(-ndigits);
  const neg = scaledNum < 0n;
  const a = neg ? -scaledNum : scaledNum;
  let q = a / scaledDen;
  const r2 = 2n * (a - q * scaledDen);
  if (r2 > scaledDen || (r2 === scaledDen && q & 1n)) q += 1n;
  const text = `${neg ? "-" : ""}${q}e${-ndigits}`;
  const result = Number(text);
  if (!Number.isFinite(result)) throw new OverflowError("rounded value too large to represent");
  return result === 0 && neg ? -0 : result;
}

/**
 * Builtin `sum()` over numbers as CPython 3.12+ computes it: exact for
 * ints, Neumaier-compensated for floats.
 */
export function sum(values: Iterable<number>, start = 0): number {
  let f = start;
  let c = 0;
  let anyFloat = !Number.isInteger(start);
  for (const x of values) {
    if (!anyFloat && Number.isInteger(x) && Number.isInteger(f) && Math.abs(f + x) < 2 ** 53) {
      f += x;
      continue;
    }
    anyFloat = true;
    const t = f + x;
    if (Number.isFinite(t)) {
      if (Math.abs(f) >= Math.abs(x)) c += f - t + x;
      else c += x - t + f;
    }
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/** `math.fsum` - exactly rounded sum (Shewchuk). */
export function fsum(values: Iterable<number>): number {
  const partials: number[] = [];
  for (let x of values) {
    let i = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo) partials[i++] = lo;
      x = hi;
    }
    partials.length = i;
    partials.push(x);
  }
  let n = partials.length;
  let hi = 0;
  if (n > 0) {
    hi = partials[--n];
    let lo = 0;
    while (n > 0) {
      const x = hi;
      const y = partials[--n];
      hi = x + y;
      const yr = hi - x;
      lo = y - yr;
      if (lo) break;
    }
    if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
      const y = lo * 2;
      const x = hi + y;
      const yr = x - hi;
      if (y === yr) hi = x;
    }
  }
  return hi;
}

/** `math.isclose(a, b, rel_tol=1e-9, abs_tol=0)` */
export function isclose(a: number | PyFloat, b: number | PyFloat, relTol = 1e-9, absTol = 0): boolean {
  a = unbox(a);
  b = unbox(b);
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(b - a);
  return diff <= Math.abs(relTol * b) || diff <= Math.abs(relTol * a) || diff <= absTol;
}

/** `math.copysign` */
export function copysign(x: number | PyFloat, y: number | PyFloat): number {
  x = unbox(x);
  y = unbox(y);
  const neg = y < 0 || Object.is(y, -0);
  return neg ? -Math.abs(x) : Math.abs(x);
}

/** `math.radians` / `math.degrees` (CPython multiplies by pi/180 and 180/pi). */
export const radians = (x: number): number => x * (Math.PI / 180);
export const degrees = (x: number): number => x * (180 / Math.PI);

/** Python `repr(float)` / `str(float)`: shortest round-trip, Python spelling. */
export function floatRepr(x: number | PyFloat): string {
  if (x instanceof PyFloat) x = x.value;
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(x);
  if (abs >= 1e16 || abs < 1e-4) {
    let [m, e] = x.toExponential().split("e");
    const exp = Number(e);
    return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const s = String(x);
  return s.includes(".") ? s : `${s}.0`;
}

/** Python `str(x)` for a number that may be an int or a float. */
export function numStr(x: number | PyFloat, isFloat = x instanceof PyFloat || !Number.isInteger(x)): string {
  if (x instanceof PyFloat) x = x.value;
  return isFloat ? floatRepr(x) : String(x);
}

/**
 * Python `format(x, spec)` for the numeric specs py_aep uses:
 * `[sign][0][width][.prec](f|e|g|%|d|x|X)`, plus `,` grouping.
 */
export function format(x: number | PyFloat, spec: string): string {
  const isFloat = x instanceof PyFloat;
  x = unbox(x);
  const m = /^([<>=^]?)([+\- ]?)(0?)(\d*)(,?)(?:\.(\d+))?([fFeEgGdxX%n]?)$/.exec(spec);
  if (!m) throw new ValueError(`Unsupported format spec ${spec}`);
  const [, align, sign, zero, widthS, comma, precS, type] = m;
  const prec = precS === undefined ? undefined : Number(precS);
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  let body: string;
  switch (type) {
    case "f":
    case "F":
      body = fixed(a, prec ?? 6);
      break;
    case "%":
      body = fixed(a * 100, prec ?? 6) + "%";
      break;
    case "e":
    case "E":
      body = expo(a, prec ?? 6);
      break;
    case "g":
    case "G":
      body = general(a, prec ?? 6, false);
      break;
    case "d":
    case "n":
      body = String(Math.trunc(a));
      break;
    case "x":
      body = Math.trunc(a).toString(16);
      break;
    case "X":
      body = Math.trunc(a).toString(16).toUpperCase();
      break;
    default:
      body = prec === undefined ? (!isFloat && Number.isInteger(x) ? String(a) : floatRepr(a)) : general(a, prec, true);
  }
  if (type === "E" || type === "G" || type === "F") body = body.toUpperCase();
  if (comma) {
    const [i, f] = body.split(".");
    body = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f === undefined ? "" : "." + f);
  }
  const signS = neg && !(a === 0 && type === "d") ? "-" : sign === "+" ? "+" : sign === " " ? " " : "";
  const width = widthS ? Number(widthS) : 0;
  if (zero && !align) return signS + body.padStart(width - signS.length, "0");
  const s = signS + body;
  if (align === "<") return s.padEnd(width);
  if (align === "^") {
    const pad = Math.max(0, width - s.length);
    return " ".repeat(Math.floor(pad / 2)) + s + " ".repeat(pad - Math.floor(pad / 2));
  }
  return s.padStart(width);
}

/**
 * The shortest round-trip digits of a non-negative finite double and its decimal
 * exponent: `0.00125` is `["125", -3]`.
 */
function shortestDigits(a: number): [string, number] {
  const s = a.toExponential();
  const e = s.indexOf("e");
  return [s.slice(0, e).replace(".", ""), Number(s.slice(e + 1))];
}

// The fast paths below skip the exact BigInt rounding when the shortest round-trip
// digits already fit the requested precision and the result has at most 15 significant
// digits: for a normal double the exact value is then within half an ulp (< 1.2e-16
// relative) of those digits, far inside half a unit of the last requested digit, so
// rounding the exact value gives them back. Subnormals have coarser ulps.
const MIN_NORMAL = 2.2250738585072014e-308;

/** Correctly rounded fixed-point text of a non-negative double (ties to even on the exact value). */
function fixed(a: number, prec: number): string {
  if (!Number.isFinite(a)) return Number.isNaN(a) ? "nan" : "inf";
  const [d, e] = shortestDigits(a);
  const pad = prec - (d.length - 1 - e);
  if (pad >= 0 && e + 1 + prec <= 15 && (a === 0 || a >= MIN_NORMAL)) {
    const digits = (d + "0".repeat(pad)).padStart(prec + 1, "0");
    return prec ? `${digits.slice(0, -prec)}.${digits.slice(-prec)}` : digits;
  }
  const [num, den] = floatAsRatio(a);
  const scaled = num * 10n ** BigInt(prec);
  let q = scaled / den;
  const r2 = 2n * (scaled - q * den);
  if (r2 > den || (r2 === den && q & 1n)) q += 1n;
  const digits = q.toString().padStart(prec + 1, "0");
  return prec ? `${digits.slice(0, -prec)}.${digits.slice(-prec)}` : digits;
}

/** Correctly rounded `%.{prec}e` digits: [mantissa digits, exponent]. */
function sciDigits(a: number, prec: number): [string, number] {
  if (a === 0) return ["0".repeat(prec + 1), 0];
  if (prec < 15 && a >= MIN_NORMAL) {
    const [d, e] = shortestDigits(a);
    if (d.length <= prec + 1) return [d.padEnd(prec + 1, "0"), e];
  }
  const [num, den] = floatAsRatio(a);
  let exp = Math.floor(Math.log10(a));
  for (;;) {
    const shift = prec - exp;
    let n = num;
    let d = den;
    if (shift >= 0) n *= 10n ** BigInt(shift);
    else d *= 10n ** BigInt(-shift);
    let q = n / d;
    const r2 = 2n * (n - q * d);
    if (r2 > d || (r2 === d && q & 1n)) q += 1n;
    const s = q.toString();
    if (s.length === prec + 1) return [s, exp];
    exp += s.length > prec + 1 ? 1 : -1;
  }
}

function expo(a: number, prec: number): string {
  if (!Number.isFinite(a)) return Number.isNaN(a) ? "nan" : "inf";
  const [d, e] = sciDigits(a, prec);
  const m = prec ? `${d[0]}.${d.slice(1)}` : d;
  return `${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

/** `%g` (and the bare `.Ng` spec when `keep_point_free` is false). */
function general(a: number, prec: number, reprStyle: boolean): string {
  if (!Number.isFinite(a)) return Number.isNaN(a) ? "nan" : "inf";
  const p = prec === 0 ? 1 : prec;
  if (a === 0) return reprStyle ? "0.0" : "0";
  const [d, e] = sciDigits(a, p - 1);
  let out: string;
  if (e < -4 || e >= p) {
    let m = p > 1 ? `${d[0]}.${d.slice(1)}` : d;
    if (m.includes(".")) m = m.replace(/0+$/, "").replace(/\.$/, "");
    out = `${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  } else {
    out = fixed(a, Math.max(0, p - 1 - e));
    if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
    if (reprStyle && !out.includes(".") && !out.includes("e")) out += ".0";
  }
  return out;
}

/** Shift helpers: JS `<<`/`>>`/`&`/`|` are int32; these keep Python's unbounded-int results exact up to 2**53. */
export function lshift(x: number, n: number): number {
  return x * 2 ** n;
}
export function rshift(x: number, n: number): number {
  return Math.floor(x / 2 ** n);
}
/** `x & mask` for non-negative operands up to 2**53. */
export function and(x: number, mask: number): number {
  if (x <= 0xffffffff && mask <= 0xffffffff && x >= 0 && mask >= 0) return (x & mask) >>> 0;
  return Number(BigInt(x) & BigInt(mask));
}
/** `x | y` for non-negative operands up to 2**53. */
export function or(x: number, y: number): number {
  if (x <= 0xffffffff && y <= 0xffffffff && x >= 0 && y >= 0) return (x | y) >>> 0;
  return Number(BigInt(x) | BigInt(y));
}
/** `x & ~mask` for non-negative operands up to 2**53. */
export function andNot(x: number, mask: number): number {
  if (x <= 0xffffffff && mask <= 0xffffffff && x >= 0 && mask >= 0) return (x & ~mask) >>> 0;
  return Number(BigInt(x) & ~BigInt(mask));
}
