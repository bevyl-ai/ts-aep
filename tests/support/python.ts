// Python builtins the ported tests use and the library does not.
import {
  AttributeError,
  BoxedFloat,
  MIN_NORMAL,
  shortestDigits,
  OverflowError,
  ValueError,
  compare,
  floatAsRatio,
  floatRepr,
  isKeyedMapping,
  truthy,
  unbox,
  type KeyedMapping,
} from "../../src/pyrt/index.ts";

/** `x & mask` for non-negative operands up to 2**53. */
export function and(x: number, mask: number): number {
  if (x <= 0xffffffff && mask <= 0xffffffff && x >= 0 && mask >= 0) return (x & mask) >>> 0;
  return Number(BigInt(x) & BigInt(mask));
}

/** Shift helpers: JS `<<`/`>>`/`&`/`|` are int32; these keep Python's unbounded-int results exact up to 2**53. */
export function lshift(x: number, n: number): number {
  return x * 2 ** n;
}

/**
 * Python `format(x, spec)` for the numeric specs py_aep uses:
 * `[sign][0][width][.prec](f|e|g|%|d|x|X)`, plus `,` grouping.
 */
export function format(x: number | BoxedFloat, spec: string): string {
  const isFloat = x instanceof BoxedFloat;
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

/**
 * Python `round(x)` (ties to even, returns an int) and `round(x, n)`
 * (correctly rounded on the exact binary value, ties to even).
 */
export function round(x: number | BoxedFloat, ndigits?: number | null): number {
  if (x instanceof BoxedFloat) x = x.value;
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

/** `s.split(sep, maxsplit)`; `sep=None` splits on whitespace runs. */
export function split(s: string, sep?: string | null, maxsplit = -1): string[] {
  if (sep == null) {
    // Runs of str.isspace() characters separate fields; a maxsplit remainder keeps its trailing whitespace.
    const out: string[] = [];
    const n = s.length;
    let i = 0;
    while (i < n) {
      while (i < n && PY_WS.test(s[i])) i++;
      if (i === n) break;
      if (maxsplit >= 0 && out.length === maxsplit) {
        out.push(s.slice(i));
        break;
      }
      let j = i;
      while (j < n && !PY_WS.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    }
    return out;
  }
  if (sep === "") throw new ValueError("empty separator");
  const parts = s.split(sep);
  if (maxsplit < 0 || parts.length <= maxsplit + 1) return parts;
  return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)];
}

/** `s.strip(chars)` / `.lstrip` / `.rstrip` (whitespace when chars omitted). */
export function strip(s: string, chars?: string | null): string {
  return rstrip(lstrip(s, chars), chars);
}

/**
 * `dict(arg)`: a new `Map` from a mapping (`Map`, an object with `keys()` /
 * `get()`) or an iterable of key/value pairs, in iteration order.
 */
export function dict<K, V>(arg?: KeyedMapping<K, V> | Map<K, V> | Iterable<[K, V]> | null): Map<K, V> {
  if (arg == null) return new Map();
  if (arg instanceof Map) return new Map(arg);
  // CPython: anything with `keys()` is a mapping, read through `keys()` + `get()`.
  if (isKeyedMapping(arg)) {
    return new Map([...arg.keys()].map((k): [K, V] => [k, arg.get(k)]));
  }
  const out = new Map<K, V>();
  let i = 0;
  for (const pair of arg) {
    if (pair.length !== 2) {
      throw new ValueError(`dictionary update sequence element #${i} has length ${pair.length}; 2 is required`);
    }
    out.set(pair[0], pair[1]);
    i++;
  }
  return out;
}

/** `hasattr(obj, name)` */
export function hasMember(obj: unknown, name: string): boolean {
  if (obj == null || !(name in Object(obj))) return false;
  try {
    void Reflect.get(Object(obj), name, obj);
    return true;
  } catch (e) {
    if (e instanceof AttributeError) return false;
    throw e;
  }
}

/** `max(xs, key=..., default=...)` - first maximal element, like Python. */
export function max<T, K>(xs: Iterable<T>, key?: ((x: T) => K) | null, ...dflt: [] | [T]): T {
  let best: { x: T; k: K | T } | null = null;
  for (const x of xs) {
    const k = key ? key(x) : x;
    if (best === null || compare(k, best.k) > 0) best = { x, k };
  }
  if (best === null) {
    if (dflt.length) return dflt[0];
    throw new ValueError("max() iterable argument is empty");
  }
  return best.x;
}

/** `min(xs, key=..., default=...)` - first minimal element, like Python. */
export function min<T, K>(xs: Iterable<T>, key?: ((x: T) => K) | null, ...dflt: [] | [T]): T {
  let best: { x: T; k: K | T } | null = null;
  for (const x of xs) {
    const k = key ? key(x) : x;
    if (best === null || compare(k, best.k) < 0) best = { x, k };
  }
  if (best === null) {
    if (dflt.length) return dflt[0];
    throw new ValueError("min() iterable argument is empty");
  }
  return best.x;
}

/** `sorted(xs, key=..., reverse=...)` - stable, Python ordering. */
export function sorted<T, K>(xs: Iterable<T>, key?: ((x: T) => K) | null, reverse = false): T[] {
  const arr = [...xs];
  const k: (x: T) => K | T = key ?? ((x: T) => x);
  const decorated = arr.map((x, i) => [k(x), i, x] as const);
  decorated.sort((p, q) => {
    const c = compare(p[0], q[0]);
    return (reverse ? -c : c) || p[1] - q[1];
  });
  return decorated.map((d) => d[2]);
}

/** `enumerate(xs, start)` */
export function* enumerate<T>(xs: Iterable<T>, start = 0): Generator<[number, T]> {
  let i = start;
  for (const x of xs) yield [i++, x];
}

/** `range(stop)` / `range(start, stop, step)` */
export function* range(a: number, b?: number, step = 1): Generator<number> {
  const [start, stop] = b === undefined ? [0, a] : [a, b];
  if (step > 0) for (let i = start; i < stop; i += step) yield i;
  else for (let i = start; i > stop; i += step) yield i;
}

/** `a and b` with Python truthiness. */
export function pyAnd<A, B>(a: A, b: B): A | B {
  return truthy(a) ? b : a;
}

/**
 * `pattern.findall(s)`: every non-overlapping match - the whole match when
 * the pattern has no groups, group 1 when it has one, else an array of all
 * groups (an unmatched group is "").
 */
export function patternFindall(re: RegExp, s: string): (string | string[])[] {
  const out: (string | string[])[] = [];
  for (const m of s.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) {
    if (m.length === 1) out.push(m[0]);
    else if (m.length === 2) out.push(m[1] ?? "");
    else out.push(m.slice(1).map((g) => g ?? ""));
  }
  return out;
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

function expo(a: number, prec: number): string {
  if (!Number.isFinite(a)) return Number.isNaN(a) ? "nan" : "inf";
  const [d, e] = sciDigits(a, prec);
  const m = prec ? `${d[0]}.${d.slice(1)}` : d;
  return `${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

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

// One `str.isspace()` character (all are in the BMP).
const PY_WS = /^[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;

function rstrip(s: string, chars?: string | null): string {
  if (chars == null) return s.replace(/\s+$/u, "");
  let e = s.length;
  while (e > 0 && chars.includes(s[e - 1])) e--;
  return s.slice(0, e);
}

function lstrip(s: string, chars?: string | null): string {
  if (chars == null) return s.replace(/^\s+/u, "");
  let i = 0;
  while (i < s.length && chars.includes(s[i])) i++;
  return s.slice(i);
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

/**
 * `io.StringIO` (newline=None translation is not modelled: text is stored
 * as written). Positions count code points, as in Python.
 */
export class StringIO {
  private chars: string[];
  private pos = 0;

  constructor(initialValue = "") {
    this.chars = Array.from(initialValue);
  }

  /** `write(s)`: overwrite/extend at the position; returns the code points written. */
  write(s: string): number {
    const cs = Array.from(s);
    if (this.pos > this.chars.length)
      this.chars.push(...Array.from({ length: this.pos - this.chars.length }, () => "\0"));
    this.chars.splice(this.pos, cs.length, ...cs);
    this.pos += cs.length;
    return cs.length;
  }

  /** `read(size)`; `size` omitted or negative reads to the end. */
  read(size?: number | null): string {
    const end = size == null || size < 0 ? this.chars.length : Math.min(this.chars.length, this.pos + size);
    const out = this.chars.slice(this.pos, end).join("");
    this.pos = Math.max(this.pos, end);
    return out;
  }

  /** `readline(size)`: through the next `\n`. */
  readline(size?: number | null): string {
    let end = this.chars.length;
    if (size != null && size >= 0) end = Math.min(end, this.pos + size);
    let i = this.pos;
    while (i < end && this.chars[i] !== "\n") i++;
    if (i < end) i++;
    const out = this.chars.slice(this.pos, i).join("");
    this.pos = Math.max(this.pos, i);
    return out;
  }

  getvalue(): string {
    return this.chars.join("");
  }

  tell(): number {
    return this.pos;
  }

  seek(offset: number, whence: 0 | 1 | 2 = 0): number {
    this.pos = whence === 0 ? offset : whence === 1 ? this.pos + offset : this.chars.length + offset;
    return this.pos;
  }

  truncate(size?: number | null): number {
    this.chars.length = Math.min(this.chars.length, size ?? this.pos);
    return this.chars.length;
  }

  close(): void {}
}
