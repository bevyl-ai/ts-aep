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
export class BoxedFloat {
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
  deepCopy(): BoxedFloat {
    return this;
  }
}

/** Python `float(x)` kept as a float: a boxed `BoxedFloat` (see `BoxedFloat`). */
export function boxFloat(x: number | BoxedFloat): BoxedFloat {
  return x instanceof BoxedFloat ? x : new BoxedFloat(x);
}

/** `isinstance(x, (int, float))` without the bool case: a JS number or a boxed `BoxedFloat`. */
export function isReal(x: unknown): x is number | BoxedFloat {
  return typeof x === "number" || x instanceof BoxedFloat;
}

/** The plain JS number behind a possibly boxed `BoxedFloat`; other values pass through. */
export function unbox(x: number | BoxedFloat): number;
export function unbox<T>(x: T): T extends BoxedFloat ? number : T;
export function unbox<T>(x: T): T | number {
  return (x instanceof BoxedFloat ? x.value : x);
}

/**
 * `a / b` (true division) raising `ZeroDivisionError` like CPython 3.12:
 * "float division by zero" when an operand is a float, "division by zero"
 * for int / int. JS cannot see int-ness of an integral number, so the caller
 * states it: `operands` is `"float"` (default) or `"int"`; a boxed `BoxedFloat`
 * operand always counts as float.
 */
export function truediv(a: number | BoxedFloat, b: number | BoxedFloat, operands: "float" | "int" = "float"): number {
  const isFloat = operands === "float" || a instanceof BoxedFloat || b instanceof BoxedFloat;
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
export function int(x: number | string | boolean | bigint | BoxedFloat | String, base = 10): number {
  if (x instanceof BoxedFloat) x = x.value;
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
export function float(x: string | number | boolean | BoxedFloat | String): number {
  if (x instanceof BoxedFloat) return x.value;
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

/** `math.isclose(a, b, rel_tol=1e-9, abs_tol=0)` */
export function isclose(a: number | BoxedFloat, b: number | BoxedFloat, relTol = 1e-9, absTol = 0): boolean {
  a = unbox(a);
  b = unbox(b);
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(b - a);
  return diff <= Math.abs(relTol * b) || diff <= Math.abs(relTol * a) || diff <= absTol;
}

/** `math.copysign` */
export function copysign(x: number | BoxedFloat, y: number | BoxedFloat): number {
  x = unbox(x);
  y = unbox(y);
  const neg = y < 0 || Object.is(y, -0);
  return neg ? -Math.abs(x) : Math.abs(x);
}

/** `math.radians` / `math.degrees` (CPython multiplies by pi/180 and 180/pi). */
export const radians = (x: number): number => x * (Math.PI / 180);
export const degrees = (x: number): number => x * (180 / Math.PI);

/** Python `repr(float)` / `str(float)`: shortest round-trip, Python spelling. */
export function floatRepr(x: number | BoxedFloat): string {
  if (x instanceof BoxedFloat) x = x.value;
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
export function numStr(x: number | BoxedFloat, isFloat = x instanceof BoxedFloat || !Number.isInteger(x)): string {
  if (x instanceof BoxedFloat) x = x.value;
  return isFloat ? floatRepr(x) : String(x);
}

/**
 * The shortest round-trip digits of a non-negative finite double and its decimal
 * exponent: `0.00125` is `["125", -3]`.
 */
export function shortestDigits(a: number): [string, number] {
  const s = a.toExponential();
  const e = s.indexOf("e");
  return [s.slice(0, e).replace(".", ""), Number(s.slice(e + 1))];
}

// The fast paths below skip the exact BigInt rounding when the shortest round-trip
// digits already fit the requested precision and the result has at most 15 significant
// digits: for a normal double the exact value is then within half an ulp (< 1.2e-16
// relative) of those digits, far inside half a unit of the last requested digit, so
// rounding the exact value gives them back. Subnormals have coarser ulps.
export const MIN_NORMAL = 2.2250738585072014e-308;
