// Python builtins whose JS spelling differs in behavior, not just syntax.

import { AttributeError, IndexError, KeyError, ValueError } from "./errors.ts";
import { floatRepr, PyFloat } from "./num.ts";
import { ord } from "./codecs.ts";
import { INSPECT } from "./inspect.ts";

export { INSPECT };
export { describe, literal } from "./inspect.ts";

/** The protocol methods the builtins below probe for. */
type DunderProbe = {
  toBoolean?: () => boolean;
  has?: (x: unknown) => boolean;
  equals?: (other: unknown) => boolean;
};

/** Objects and functions can carry dunder methods; reading one off a primitive yields nothing. */
function _probeable(x: unknown): x is DunderProbe {
  return x !== null && (typeof x === "object" || typeof x === "function");
}

/**
 * Python truthiness: empty containers (array, string, bytes, Map, Set,
 * custom truthiness via `toBoolean`) are false. JS treats `[]` and an empty
 * Uint8Array as true - never use bare `if (x)` on a container.
 */
export function truthy(x: unknown): boolean {
  if (x == null) return false;
  if (x instanceof PyFloat) return x.value !== 0;
  if (typeof x === "boolean") return x;
  if (typeof x === "number") return x !== 0;
  if (typeof x === "bigint") return x !== 0n;
  if (typeof x === "string") return x.length > 0;
  if (Array.isArray(x)) return x.length > 0;
  if (ArrayBuffer.isView(x)) return "length" in x && typeof x.length === "number" && x.length > 0;
  if (x instanceof Map || x instanceof Set) return x.size > 0;
  if (_probeable(x)) {
    if (typeof x.toBoolean === "function") return x.toBoolean();
    const n = _sizedLength(x);
    if (n !== null) return n > 0;
  }
  return true;
}

/** Types whose every value is falsy in Python. */
export type Falsy = null | undefined | false | 0 | "" | 0n;

/** `a or b` with Python truthiness (returns the operand, not a boolean). */
export function truthyOr<A, B>(a: A, b: B): Exclude<A, Falsy> | B;
export function truthyOr<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** `a and b` with Python truthiness. */
export function pyAnd<A, B>(a: A, b: B): A | B {
  return truthy(a) ? b : a;
}

/** `len(x)` */
export function len(x: unknown): number {
  if (typeof x === "string" || Array.isArray(x)) return x.length;
  if (ArrayBuffer.isView(x) && "length" in x && typeof x.length === "number") return x.length;
  if (x instanceof Map || x instanceof Set) return x.size;
  const n = _probeable(x) ? _sizedLength(x) : null;
  if (n !== null) return n;
  throw new TypeError(`object of type '${x?.constructor?.name}' has no len()`);
}

/** `range(stop)` / `range(start, stop, step)` */
export function* range(a: number, b?: number, step = 1): Generator<number> {
  const [start, stop] = b === undefined ? [0, a] : [a, b];
  if (step > 0) for (let i = start; i < stop; i += step) yield i;
  else for (let i = start; i > stop; i += step) yield i;
}

/** `zip(a, b, ...)` (shortest; `strict` raises on length mismatch). */
export function zip<T extends unknown[][]>(...arrays: T): { [K in keyof T]: T[K][number] }[];
export function zip<T>(...arrays: T[][]): T[][] {
  let n = Infinity;
  for (const a of arrays) n = Math.min(n, a.length);
  if (n === Infinity) n = 0;
  const out: T[][] = [];
  for (let i = 0; i < n; i++) {
    const row: T[] = [];
    for (const a of arrays) row.push(a[i]);
    out.push(row);
  }
  return out;
}

/** `enumerate(xs, start)` */
export function* enumerate<T>(xs: Iterable<T>, start = 0): Generator<[number, T]> {
  let i = start;
  for (const x of xs) yield [i++, x];
}

/** Python ordering of numbers, strings, bools, and tuples/lists (lexicographic). */
export function compare(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compare(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "string" && typeof b === "string") {
    // Python compares code points; JS `<` compares UTF-16 units.
    const ca = Array.from(a, ord);
    const cb = Array.from(b, ord);
    return compare(ca, cb);
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) return compare(Array.from(a), Array.from(b));
  if (a == null || b == null) throw new TypeError("'<' not supported between instances of 'NoneType'");
  return a < b ? -1 : a > b ? 1 : 0;
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

/** `xs[i]` with Python's negative indexes and IndexError. */
export function at<T>(xs: ArrayLike<T>, i: number): T {
  const j = i < 0 ? xs.length + i : i;
  if (j < 0 || j >= xs.length) throw new IndexError("list index out of range");
  return xs[j];
}

/** What `for item in x` yields for each kind `pyIter` accepts. */
type IterItem<X> = X extends string | String
  ? string
  : X extends Uint8Array
    ? number
    : X extends readonly (infer T)[]
      ? T
      : X extends ReadonlyMap<infer K, unknown>
        ? K
        : X extends ReadonlySet<infer T>
          ? T
          : never;

/**
 * Python `list(iter(x))` over dynamic data (parsed YAML/JSON): list items,
 * dict keys, set members (in insertion order; CPython's is hash order), a
 * string's characters (code points), a bytes object's ints; `TypeError` for
 * every other kind.
 */
export function pyIter<X>(x: X): IterItem<X>[];
export function pyIter(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  if (x instanceof Map) return [...x.keys()];
  if (x instanceof Set) return [...x];
  if (typeof x === "string" || x instanceof String) return Array.from(String(x));
  if (x instanceof Uint8Array) return Array.from(x);
  throw new TypeError(`'${typeName(x)}' object is not iterable`);
}

type Sliceable = { slice(s: number, e: number): Sliceable; length: number; readonly [i: number]: unknown };

/** `xs[start:end]` for arrays and strings with Python's clamping. */
export function pySlice<T extends Sliceable>(xs: T, start?: number | null, end?: number | null, step?: number | null): T;
export function pySlice(xs: Sliceable, start?: number | null, end?: number | null, step?: number | null): unknown {
  const n = xs.length;
  if (step != null && step !== 1) {
    const out: unknown[] = [];
    if (step > 0) {
      const s = start == null ? 0 : start < 0 ? Math.max(0, n + start) : Math.min(start, n);
      const e = end == null ? n : end < 0 ? Math.max(0, n + end) : Math.min(end, n);
      for (let i = s; i < e; i += step) out.push(xs[i]);
    } else {
      const s = start == null ? n - 1 : start < 0 ? n + start : Math.min(start, n - 1);
      const e = end == null ? -1 : end < 0 ? Math.max(-1, n + end) : end;
      for (let i = s; i > e; i += step) out.push(xs[i]);
    }
    return typeof xs === "string" ? out.join("") : out;
  }
  const s = start == null ? 0 : start < 0 ? Math.max(0, n + start) : Math.min(start, n);
  const e = end == null ? n : end < 0 ? Math.max(0, n + end) : Math.min(end, n);
  return xs.slice(s, Math.max(s, e));
}

/** `d[k]` on a Map with KeyError. */
export function getOrThrow<K, V>(d: Pick<ReadonlyMap<K, V>, "get">, k: K): V {
  const v = d.get(k);
  if (v === undefined) throw new KeyError(repr(k));
  return v;
}

/** `d.get(k, default)` on a Map (None, not undefined, when absent). */
export function getOr<K, V>(d: Map<K, V>, k: K): V | null;
export function getOr<K, V, D>(d: Map<K, V>, k: K, dflt: D): V | D;
export function getOr<K, V, D>(d: Map<K, V>, k: K, dflt: D | null = null): V | D | null {
  const v = d.get(k);
  return v !== undefined ? v : dflt;
}

/** `d.setdefault(k, v)` */
export function setdefault<K, V>(d: Map<K, V>, k: K, v: V): V {
  const cur = d.get(k);
  if (cur !== undefined) return cur;
  d.set(k, v);
  return v;
}

/** `d.pop(k, default)` */
export function dictPop<K, V>(d: Map<K, V>, k: K, ...dflt: [] | [V]): V {
  const v = d.get(k);
  if (v !== undefined) {
    d.delete(k);
    return v;
  }
  if (dflt.length) return dflt[0];
  throw new KeyError(repr(k));
}

/**
 * Key for a Map/Set keyed by a Python tuple (or any hashable compound
 * value): `tkey(a, b)` stands for `(a, b)`.
 */
export function compositeKey(...parts: unknown[]): string {
  return JSON.stringify(parts, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? Array.from(v) : v));
}

/**
 * `getattr(obj, name, default)`. A `name` declared on `obj`'s type reads as
 * that property's type (or the default's, when one is given); any other name
 * reads as `any`.
 */
export function getattr<O, N extends string & keyof NonNullable<O>>(obj: O, name: N): Required<NonNullable<O>>[N];
export function getattr<O, N extends string & keyof NonNullable<O>, D>(obj: O, name: N, dflt: D): Required<NonNullable<O>>[N] | D;
export function getattr(obj: unknown, name: string, ...dflt: [unknown?]): any;
export function getattr(obj: unknown, name: string, ...dflt: [unknown?]): unknown {
  if (obj != null && name in Object(obj)) return Reflect.get(Object(obj), name, obj);
  if (dflt.length) return dflt[0];
  throw new AttributeError(`'${obj?.constructor?.name}' object has no attribute '${name}'`);
}

/** `setattr(obj, name, value)`; a getter-only accessor raises AttributeError like a Python property without a setter. */
export function setattr(obj: object, name: string, value: unknown): void {
  if (!Reflect.set(obj, name, value)) {
    throw new AttributeError(`property '${name}' of '${obj.constructor?.name}' object has no setter`);
  }
}

/** `hasattr(obj, name)` */
export function hasattr(obj: unknown, name: string): boolean {
  if (obj == null || !(name in Object(obj))) return false;
  try {
    void Reflect.get(Object(obj), name, obj);
    return true;
  } catch (e) {
    if (e instanceof AttributeError) return false;
    throw e;
  }
}

/** `x in container` for arrays, strings (substring), Maps (keys), Sets. */
export function contains(container: unknown, x: unknown): boolean {
  if (typeof container === "string") return container.includes(String(x));
  if (container instanceof Map || container instanceof Set) return container.has(x);
  if (Array.isArray(container)) return container.some((y) => valueEquals(y, x));
  if (_probeable(container) && typeof container.has === "function") return container.has(x);
  throw new TypeError("argument of type is not iterable");
}

/** `a == b` for values (numbers, strings, arrays/tuples, bytes, Maps, objects with `equals`). */
export function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof PyFloat) a = a.value;
  if (b instanceof PyFloat) b = b.value;
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "number" && typeof b === "boolean") return a === (b ? 1 : 0);
  if (typeof a === "boolean" && typeof b === "number") return (a ? 1 : 0) === b;
  if ((typeof a === "bigint" || typeof b === "bigint") && (typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint")) {
    return BigInt(a) === BigInt(b);
  }
  if (a == null || b == null) return false;
  if (a instanceof String || b instanceof String) return String(a) === String(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => valueEquals(x, b[i]));
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !valueEquals(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((x) => b.has(x));
  if (_probeable(a) && typeof a.equals === "function") return a.equals(b);
  return false;
}

// Not `str.isprintable()` (Py_UNICODE_ISPRINTABLE): other / separator categories except the space.
const NON_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** Python `repr(x)` for messages. */
export function repr(x: unknown): string {
  if (x == null) return "None";
  if (typeof x === "boolean") return x ? "True" : "False";
  if (typeof x === "number") return Number.isInteger(x) ? String(x) : floatRepr(x);
  if (x instanceof PyFloat) return floatRepr(x.value);
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "string" || x instanceof String) {
    const s = String(x);
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    let body = "";
    for (const ch of s) {
      const cp = ord(ch);
      if (ch === "\\") body += "\\\\";
      else if (ch === q) body += "\\" + q;
      else if (ch === "\n") body += "\\n";
      else if (ch === "\r") body += "\\r";
      else if (ch === "\t") body += "\\t";
      else if (cp < 0x20 || cp === 0x7f) body += "\\x" + cp.toString(16).padStart(2, "0");
      else if (cp < 0x7f || !NON_PRINTABLE.test(ch)) body += ch;
      else if (cp <= 0xff) body += "\\x" + cp.toString(16).padStart(2, "0");
      else if (cp <= 0xffff) body += "\\u" + cp.toString(16).padStart(4, "0");
      else body += "\\U" + cp.toString(16).padStart(8, "0");
    }
    return q + body + q;
  }
  if (x instanceof Uint8Array) {
    let s = "";
    for (const c of x) {
      if (c === 0x5c) s += "\\\\";
      else if (c === 0x27) s += "\\'";
      else if (c === 0x09) s += "\\t";
      else if (c === 0x0a) s += "\\n";
      else if (c === 0x0d) s += "\\r";
      else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
      else s += "\\x" + c.toString(16).padStart(2, "0");
    }
    return `b'${s}'`;
  }
  if (Array.isArray(x)) return `[${x.map(repr).join(", ")}]`;
  if (x instanceof Map) return `{${[...x].map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(", ")}}`;
  if (x instanceof Set) return x.size ? `{${[...x].map(repr).join(", ")}}` : "set()";
  if (_probeable(x) && INSPECT in x && typeof x[INSPECT] === "function") return String(x[INSPECT]());
  return String(x);
}

/**
 * `type(x).__name__`. JS cannot tell a tuple from a list (both "list") or an
 * int-valued float from an int unless it is a boxed `PyFloat`; class
 * instances report their constructor name, which equals the Python class name.
 */
export function typeName(x: unknown): string {
  if (x == null) return "NoneType";
  if (typeof x === "boolean") return "bool";
  if (x instanceof PyFloat) return "float";
  if (typeof x === "number") return Number.isInteger(x) ? "int" : "float";
  if (typeof x === "bigint") return "int";
  if (typeof x === "string") return "str";
  if (typeof x === "function") return x.prototype && /^class\b/.test(Function.prototype.toString.call(x)) ? "type" : "function";
  if (x instanceof Uint8Array) return "bytes";
  if (Array.isArray(x)) return "list";
  if (x instanceof Map) return "dict";
  if (x instanceof Set) return "set";
  return x.constructor?.name ?? "object";
}

/** `[x, ...] * n` (list repetition; `n <= 0` gives an empty list). */
export function listMul<T>(xs: readonly T[], n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(...xs);
  return out;
}

/** A Python Mapping: a `Map`, an object with `items()`, or one with `keys()` + `get()`. */
export type Mapping<K, V> = Map<K, V> | { items(): Iterable<[K, V]> } | KeyedMapping<K, V>;
type KeyedMapping<K, V> = { keys(): Iterable<K>; get(key: K): V };

function isKeyedMapping<K, V>(x: KeyedMapping<K, V> | Iterable<[K, V]>): x is KeyedMapping<K, V> {
  return typeof Reflect.get(x, "keys") === "function" && typeof Reflect.get(x, "get") === "function";
}

/**
 * `mapping.items()` over the Mapping protocol: a `Map`'s entries, an
 * object's own `items()`, or `keys()` + `get()`.
 */
export function mappingItems<K, V>(m: Mapping<K, V>): [K, V][] {
  if (m instanceof Map) return [...m.entries()];
  if ("items" in m && typeof m.items === "function") return [...m.items()];
  if ("keys" in m && typeof m.keys === "function" && typeof m.get === "function") {
    return [...m.keys()].map((k): [K, V] => [k, m.get(k)]);
  }
  throw new TypeError(`'${typeName(m)}' object is not a mapping`);
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

/** Python `str(x)` for messages. */
export function str(x: unknown): string {
  if (typeof x === "string") return x;
  if (x instanceof String) return String(x);
  if (_hasOwnToString(x)) return x.toString();
  return repr(x);
}

/** `str.isdigit()`, `.isalpha()`, `.isspace()`, `.isupper()`, `.islower()` (Unicode-aware). */
export const isdigit = (s: string): boolean => s.length > 0 && /^\p{Nd}+$/u.test(s);
export const isalpha = (s: string): boolean => s.length > 0 && /^\p{L}+$/u.test(s);
export const isspace = (s: string): boolean => s.length > 0 && /^\s+$/u.test(s);
export const isupper = (s: string): boolean => /\p{Lu}|\p{Lt}/u.test(s) && !/\p{Ll}/u.test(s);
export const islower = (s: string): boolean => /\p{Ll}/u.test(s) && !/\p{Lu}|\p{Lt}/u.test(s);

/** `s.strip(chars)` / `.lstrip` / `.rstrip` (whitespace when chars omitted). */
export function strip(s: string, chars?: string | null): string {
  return rstrip(lstrip(s, chars), chars);
}
export function lstrip(s: string, chars?: string | null): string {
  if (chars == null) return s.replace(/^\s+/u, "");
  let i = 0;
  while (i < s.length && chars.includes(s[i])) i++;
  return s.slice(i);
}
export function rstrip(s: string, chars?: string | null): string {
  if (chars == null) return s.replace(/\s+$/u, "");
  let e = s.length;
  while (e > 0 && chars.includes(s[e - 1])) e--;
  return s.slice(0, e);
}

// One `str.isspace()` character (all are in the BMP).
const PY_WS = /^[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;

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

/** `copy.deepcopy`: clones arrays, Maps, Sets, bytes, plain objects and class instances (prototype kept). */
export function deepcopy<T>(x: T, memo?: Map<object, object>): T;
export function deepcopy(x: unknown, memo = new Map<object, object>()): unknown {
  if (x === null || typeof x !== "object") return x;
  if (memo.has(x)) return memo.get(x);
  if (x instanceof Uint8Array) return x.slice();
  if (Array.isArray(x)) {
    const out: unknown[] = [];
    memo.set(x, out);
    for (const v of x) out.push(deepcopy(v, memo));
    return out;
  }
  if (x instanceof Map) {
    const out = new Map();
    memo.set(x, out);
    for (const [k, v] of x) out.set(deepcopy(k, memo), deepcopy(v, memo));
    return out;
  }
  if (x instanceof Set) {
    const out = new Set();
    memo.set(x, out);
    for (const v of x) out.add(deepcopy(v, memo));
    return out;
  }
  if ("deepCopy" in x && typeof x.deepCopy === "function") return x.deepCopy(memo);
  const out =
    x instanceof String
      ? Reflect.construct(String, [x.valueOf()], x.constructor)
      : Object.create(Object.getPrototypeOf(x));
  memo.set(x, out);
  for (const k of Reflect.ownKeys(x)) {
    if (x instanceof String && (k === "length" || (typeof k === "string" && /^\d+$/.test(k)))) continue;
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (d === undefined) continue;
    if ("value" in d) d.value = deepcopy(d.value, memo);
    Object.defineProperty(out, k, d);
  }
  return out;
}

/** `copy.copy`: shallow clone keeping the prototype. */
export function copy<T>(x: T): T;
export function copy(x: unknown): unknown {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return [...x];
  if (x instanceof Uint8Array) return x.slice();
  if (x instanceof Map) return new Map(x);
  if (x instanceof Set) return new Set(x);
  if (x instanceof String) {
    const out = Reflect.construct(String, [x.valueOf()], x.constructor);
    for (const k of Object.keys(x)) if (!/^\d+$/.test(k)) out[k] = Reflect.get(x, k);
    return out;
  }
  if (x instanceof String) return Object.assign(Object.setPrototypeOf(new String(x.valueOf()), Object.getPrototypeOf(x)), x);
  return Object.assign(Object.create(Object.getPrototypeOf(x)), x);
}

/** `functools.lru_cache(maxsize=None)` for functions of primitive / object-identity arguments. */
export function lruCache<A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) & { cacheClear(): void } {
  /** One argument position of the cache trie; `result` is set once a call ends here. */
  type Node = { next: Map<A[number], Node>; result?: { value: R } };
  const root: Node = { next: new Map() };
  const single = new Map<A[0], { value: R }>();
  const wrapped = (...args: A): R => {
    if (args.length === 1) {
      let r = single.get(args[0]);
      if (r === undefined) single.set(args[0], (r = { value: fn(...args) }));
      return r.value;
    }
    let node = root;
    for (const a of args) {
      let next = node.next.get(a);
      if (!next) node.next.set(a, (next = { next: new Map() }));
      node = next;
    }
    node.result ??= { value: fn(...args) };
    return node.result.value;
  };
  return Object.assign(wrapped, {
    cacheClear: () => {
      root.next.clear();
      root.result = undefined;
      single.clear();
    },
  });
}

/** A class instance whose own `toString` (not Object's, Array's or Error's) is its `str()`. */
function _hasOwnToString(x: unknown): x is { toString(): string } {
  if (x === null || typeof x !== "object" || x instanceof Error || Array.isArray(x) || ArrayBuffer.isView(x)) return false;
  for (let p = Object.getPrototypeOf(x); p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    if (Object.prototype.hasOwnProperty.call(p, "toString")) return true;
  }
  return false;
}

/** A class's container size: a `length` or `size` getter on its prototype chain (Python's `__len__`). */
function _sizedLength(x: object): number | null {
  for (let p = Object.getPrototypeOf(x); p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of ["length", "size"]) {
      const get = Object.getOwnPropertyDescriptor(p, name)?.get;
      if (get) return Number(get.call(x));
    }
  }
  return null;
}
