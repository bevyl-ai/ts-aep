/**
 * COS value kinds as type guards, and Python's operations over COS values.
 *
 * py_aep reads the text-document COS tree with plain Python: an
 * `isinstance` check where it cares about a value's kind, and otherwise a
 * builtin (`float(x)`, `int(x)`, `x + 1`, `x.get(k)`) that raises when the
 * kind is wrong. The kinds below are those `isinstance` checks, run by
 * {@link is} as type guards; the operations raise what the Python builtin
 * raises on every other kind. A reader therefore only holds a narrower
 * type than {@link CosNode} after one of them has run on the value.
 */

import { AttributeError, KeyError, PyFloat, at, float, int, literal, typeName } from "../../pyrt/index.ts";
import { CosString, type CosDict, type CosNode } from "./cos.ts";

/** A COS value kind: a guard that narrows a value to the kind's type. */
export type Kind<T extends CosNode> = (x: CosNode | undefined) => x is T;

/** `isinstance(x, int)`: a boolean, or an integral JS number other than `-0` (a COS integer). */
export const pyInt: Kind<boolean | number> = (x): x is boolean | number =>
  typeof x === "boolean" || (typeof x === "number" && Number.isInteger(x) && !Object.is(x, -0));

/** `isinstance(x, (int, float))`: a boolean, a JS number, or a boxed `PyFloat` (a COS real). */
export const pyNumber: Kind<boolean | number | PyFloat> = (x): x is boolean | number | PyFloat =>
  typeof x === "boolean" || typeof x === "number" || x instanceof PyFloat;

/** `isinstance(x, str)`: a plain string or a `CosString`. */
export const pyStr: Kind<string | CosString> = (x): x is string | CosString => typeof x === "string" || x instanceof CosString;

/** `isinstance(x, bool)`. */
export const pyBoolKind: Kind<boolean> = (x): x is boolean => typeof x === "boolean";

/** Whether `x` is of `kind`; narrows `x` to the kind's type. */
export function is<T extends CosNode>(kind: Kind<T>, x: CosNode | undefined): x is T {
  return kind(x);
}

/** The ASCII bytes of a COS byte string as text, for `int(b"..")` / `float(b"..")`. */
function bytesText(x: Uint8Array): string {
  return String.fromCharCode(...x);
}

/** Python `float(x)` on a COS value: `TypeError` for every kind `float()` refuses. */
export function cosFloat(x: CosNode): number {
  if (is(pyNumber, x) || is(pyStr, x)) return float(x);
  if (x instanceof Uint8Array) return float(bytesText(x));
  throw new TypeError(`float() argument must be a string or a real number, not '${typeName(x)}'`);
}

/** Python `int(x)` on a COS value: `TypeError` for every kind `int()` refuses. */
export function cosInt(x: CosNode): number {
  if (is(pyNumber, x) || is(pyStr, x)) return int(x);
  if (x instanceof Uint8Array) return int(bytesText(x));
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(x)}'`);
}

/**
 * `x` as an arithmetic operand (`x + 1`, `a - b`, `abs(x)`): the number
 * behind an int, bool or float; `TypeError` for every other kind.
 */
export function cosNum(x: CosNode): number {
  if (is(pyNumber, x)) return float(x);
  throw new TypeError(`unsupported operand type(s) for numeric operation: '${typeName(x)}'`);
}

/**
 * `x` where Python calls a dict method on it (`x.get(..)`,
 * `x.setdefault(..)`): `AttributeError` when `x` is not a dict.
 */
export function cosDict(x: CosNode, method: string): CosDict {
  if (x instanceof Map) return x;
  throw new AttributeError(`'${typeName(x)}' object has no attribute '${method}'`);
}

/**
 * Python `x[key]` on a COS value: the dict's value, `KeyError` when the
 * key is absent, `TypeError` when `x` is not a dict.
 */
export function cosItem(x: CosNode, key: string): CosNode {
  if (!(x instanceof Map)) {
    if (Array.isArray(x)) throw new TypeError("list indices must be integers or slices, not str");
    throw new TypeError(`'${typeName(x)}' object is not subscriptable`);
  }
  const value = x.get(key);
  if (value === undefined) throw new KeyError(literal(key));
  return value;
}

/** Python `d.setdefault(key, value)` on a COS dict. */
export function cosSetdefault(d: CosNode, key: string, value: CosNode): CosNode {
  const dict = cosDict(d, "setdefault");
  const current = dict.get(key);
  if (current !== undefined) return current;
  dict.set(key, value);
  return value;
}

/** Python `x[key] = value` on a COS value: `TypeError` when `x` is not a dict. */
export function cosSetitem(x: CosNode, key: string, value: CosNode): void {
  if (!(x instanceof Map)) throw new TypeError(`'${typeName(x)}' object does not support item assignment`);
  x.set(key, value);
}

/** Python `x.pop(key, None)` on a COS value: `AttributeError` when `x` is not a dict. */
export function cosPop(x: CosNode, key: string): void {
  cosDict(x, "pop").delete(key);
}

/** Python `x.get(key, default)` on a COS value: `AttributeError` when `x` is not a dict. */
export function cosGetOr<D extends CosNode>(x: CosNode, key: string, default_: D): CosNode {
  const value = cosDict(x, "get").get(key);
  return value === undefined ? default_ : value;
}

/** Python `x[i]` with an int index: a list item (`IndexError` past the end), a string's character, `KeyError` on a dict, else `TypeError`. */
export function cosAt(x: CosNode, i: number): CosNode {
  if (Array.isArray(x)) return at(x, i);
  if (typeof x === "string" || x instanceof String) return at(String(x), i);
  if (x instanceof Uint8Array) return at(x, i);
  if (x instanceof Map) throw new KeyError(literal(i));
  throw new TypeError(`'${typeName(x)}' object is not subscriptable`);
}

/** Python `iter(x)` over a COS value: list items, dict keys, string characters or bytes; `TypeError` otherwise. */
export function cosIter(x: CosNode): CosNode[] {
  if (Array.isArray(x)) return x;
  if (x instanceof Map) return [...x.keys()];
  if (typeof x === "string" || x instanceof String) return Array.from(String(x));
  if (x instanceof Uint8Array) return Array.from(x);
  throw new TypeError(`'${typeName(x)}' object is not iterable`);
}

/** Python `x.append(item)` on a COS value: `AttributeError` when `x` is not a list. */
export function cosAppend(x: CosNode, item: CosNode): void {
  if (!Array.isArray(x)) throw new AttributeError(`'${typeName(x)}' object has no attribute 'append'`);
  x.push(item);
}

/** A COS value as Python hands it out: floats are plain numbers, at any depth. */
export type CosUnboxed =
  | Exclude<CosNode, PyFloat | CosNode[] | CosDict>
  | CosUnboxed[]
  | Map<string, CosUnboxed>;

/**
 * `x` as Python hands it out: a `PyFloat` unboxed to its number. A list or
 * dict is a copy with its floats unboxed (Python returns the stored object;
 * only its identity differs).
 */
export function cosUnbox(x: CosNode): CosUnboxed {
  if (x instanceof PyFloat) return x.value;
  if (Array.isArray(x)) return x.map(cosUnbox);
  if (x instanceof Map) return new Map([...x].map(([k, v]): [string, CosUnboxed] => [k, cosUnbox(v)]));
  return x;
}

/** Python `x.insert(i, item)` on a COS value: `AttributeError` when `x` is not a list. */
export function cosInsert(x: CosNode, i: number, item: CosNode): void {
  if (!Array.isArray(x)) throw new AttributeError(`'${typeName(x)}' object has no attribute 'insert'`);
  x.splice(i, 0, item);
}

/**
 * Python `x in ints` for a set of ints: numbers (and booleans) by value,
 * other hashable kinds never; `TypeError` for the unhashable ones
 * (lists, dicts and the dataclass wrappers).
 */
export function cosIn(x: CosNode | undefined, ints: ReadonlySet<number>): boolean {
  if (x === undefined || x == null) return false;
  if (is(pyNumber, x)) return ints.has(float(x));
  if (typeof x === "string" || x instanceof String || x instanceof Uint8Array) return false;
  throw new TypeError(`unhashable type: '${typeName(x)}'`);
}

/** A Python int or float held in COS data: a JS number, or a boxed `PyFloat` for an integral float. */
export type PyNum = number | PyFloat;

/** Whether a Python number is a float (`PyFloat`, or a JS number that is no integer). */
function isFloat(x: PyNum): boolean {
  return x instanceof PyFloat || !Number.isInteger(x) || Object.is(x, -0);
}

/** `x` as a Python numeric operand (`a + b`): bool as int, else `TypeError` for non-numbers. */
export function pyNum(x: CosNode): PyNum {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number" || x instanceof PyFloat) return x;
  throw new TypeError(`unsupported operand type(s) for +: 'int' and '${typeName(x)}'`);
}

/** Python `a + b` / `a - b` on numbers: a float (kept boxed) when either side is one. */
export function pyAdd(a: PyNum, b: PyNum): PyNum {
  const sum = float(a) + float(b);
  return isFloat(a) || isFloat(b) ? new PyFloat(sum) : sum;
}

export function pySub(a: PyNum, b: PyNum): PyNum {
  const diff = float(a) - float(b);
  return isFloat(a) || isFloat(b) ? new PyFloat(diff) : diff;
}

/** Python `len(x)` on a COS value: `TypeError` for kinds without a length. */
export function cosLen(x: CosNode): number {
  if (Array.isArray(x) || x instanceof Uint8Array) return x.length;
  if (typeof x === "string" || x instanceof String) return String(x).length;
  if (x instanceof Map) return x.size;
  throw new TypeError(`object of type '${typeName(x)}' has no len()`);
}

/** Python `x.pop(i)` with an int index: a list item (`IndexError` past the end); a dict has no int keys (`KeyError`); else `AttributeError`. */
export function cosPopAt(x: CosNode, i: number): CosNode {
  if (Array.isArray(x)) {
    const item = at(x, i);
    x.splice(i < 0 ? x.length + i : i, 1);
    return item;
  }
  if (x instanceof Map) throw new KeyError(literal(i));
  throw new AttributeError(`'${typeName(x)}' object has no attribute 'pop'`);
}

/** Python `item in x` for a string `item`: dict keys, list items, substrings; `TypeError` for other kinds. */
export function cosContains(x: CosNode, item: string): boolean {
  if (x instanceof Map) return x.has(item);
  if (Array.isArray(x)) return x.some((v) => v === item || (v instanceof String && String(v) === item));
  if (typeof x === "string" || x instanceof String) return String(x).includes(item);
  if (x instanceof Uint8Array) throw new TypeError("a bytes-like object is required, not 'str'");
  throw new TypeError(`argument of type '${typeName(x)}' is not iterable`);
}
