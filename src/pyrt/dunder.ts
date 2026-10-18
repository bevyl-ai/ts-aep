// Python's attribute protocol in TS: descriptors (`__get__` / `__set__` /
// `__set_name__`) installed with `descriptor()`, a missing-attribute fallback
// (`_missingAttribute(name)`, Python's `__getattr__`) and an assignment hook
// (`_assignAttribute(name, value)`, Python's `__setattr__`), both wired with
// `pyClassHooks(Cls)`.
//
//   class Layer {
//     declare enabled: boolean;
//   }
//   descriptor(Layer, "enabled", new ChunkField(...));
//
// Inside `_assignAttribute`, `object.__setattr__(self, name, value)` is
// `objectSetattr(this, name, value)`.

import { AttributeError } from "./errors.ts";

/**
 * A descriptor on instances of `O` whose reads produce a `V`. `descriptor()`
 * only reads through instances; a Python-style `__get__` that also accepts
 * `null` (a class read) returns the descriptor itself there.
 */
export interface Descriptor<O extends object = object, V = unknown> {
  __set_name__?(owner: Function, name: string): void;
  __get__(obj: O, owner: Function): V | Descriptor<O, V>;
  __set__?(obj: O, value: V): void;
  __delete__?(obj: O): void;
}

/**
 * Python `type(self)`: the class attributes (statics) of `C` without its
 * construct signature, so a subclass whose constructor takes other arguments
 * can still narrow it. Declare it on a class that reads its own statics:
 * `declare ["constructor"]: ClassAttributes<typeof Layer>;`
 */
export type ClassAttributes<C> = Function & Omit<C, "prototype">;

const DESCRIPTORS = new WeakMap<Function, Map<string, Descriptor>>();

/**
 * Install `d` as class attribute `name` of `cls` (runs `__set_name__`).
 * `name` must be declared on the instance type, and `d` must read as the
 * declared type on instances of `cls`, which a generic descriptor such as
 * `new ChunkField(...)` then infers (value and owner type). `P` is read from
 * `prototype` so a generic class infers its erased instance type (a generic
 * construct signature infers nothing).
 */
export function descriptor<P extends object, K extends string & keyof P>(
  cls: (abstract new (...args: never[]) => object) & { prototype: P },
  name: K,
  d: NoInfer<Descriptor<P, P[K]>>,
): Descriptor<P, P[K]>;
export function descriptor<D extends Descriptor>(cls: Function, name: string, d: D): D {
  d.__set_name__?.(cls, name);
  let own = DESCRIPTORS.get(cls);
  if (!own) DESCRIPTORS.set(cls, (own = new Map()));
  own.set(name, d);
  Object.defineProperty(cls.prototype, name, {
    configurable: true,
    enumerable: false,
    get(this: { constructor: Function }) {
      return d.__get__(this, this.constructor);
    },
    set(this: object, value: unknown) {
      if (!d.__set__) throw new AttributeError(`can't set attribute '${name}'`);
      d.__set__(this, value);
    },
  });
  return d;
}

/** `type(obj).__dict__[name]` / `getattr(Cls, name)` for a descriptor (walks the MRO). */
export function getDescriptor(cls: Function, name: string): Descriptor | undefined {
  for (let c: Function | null = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    const d = DESCRIPTORS.get(c)?.get(name);
    if (d) return d;
  }
  return undefined;
}

/** All descriptors visible on `cls`, base-first then overridden by subclasses (like `vars()` over the MRO). */
export function descriptorsOf(cls: Function): Map<string, Descriptor> {
  const chain: Function[] = [];
  for (let c: Function | null = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) chain.unshift(c);
  const out = new Map<string, Descriptor>();
  for (const c of chain) for (const [k, v] of DESCRIPTORS.get(c) ?? []) out.set(k, v);
  return out;
}

// `pyObject` proxy -> the instance it wraps.
const PROXY_TARGETS = new WeakMap<object, object>();

function _hasGetattr(x: object): x is { _missingAttribute(name: string): unknown } {
  return "_missingAttribute" in x && typeof x._missingAttribute === "function";
}

function _hasSetattr(x: object): x is { _assignAttribute(name: string, value: unknown): void } {
  return "_assignAttribute" in x && typeof x._assignAttribute === "function";
}

/**
 * Wrap a freshly constructed instance so `_missingAttribute` runs for missing
 * attributes and `_assignAttribute` for every assignment, as in Python.
 */
export function pyObject<T extends object>(self: T): T {
  const hasGetattr = _hasGetattr(self);
  const hasSetattr = _hasSetattr(self);
  if (!hasGetattr && !hasSetattr) return self;
  const proxy = new Proxy(self, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key in target || !hasGetattr) return Reflect.get(target, key, receiver);
      if (key === "then" || key === "toJSON" || key === "constructor") return undefined;
      // Python looks special methods (`__bool__`, `__eq__`, `__len__`, ...) up on the type,
      // never through `_missingAttribute`; pyrt probes them as property reads, so a miss is undefined.
      if (_isSpecial(key)) return undefined;
      if (_hasGetattr(receiver)) return receiver._missingAttribute(key);
    },
    set(target, key, value, receiver) {
      if (typeof key === "symbol" || !hasSetattr || inSetattr.has(target)) {
        return Reflect.set(target, key, value, receiver);
      }
      if (_hasSetattr(receiver)) receiver._assignAttribute(key, value);
      return true;
    },
  });
  PROXY_TARGETS.set(proxy, self);
  return proxy;
}

/**
 * `_missingAttribute` / `_assignAttribute` for every instance of `cls` and its
 * subclasses, without wrapping each instance in a `pyObject` proxy: one
 * proxy is spliced into the prototype chain between `cls.prototype` and its
 * base's. A read of an own field or of a member of `cls` or a subclass
 * stops before it; base-class members and misses reach it, and a miss goes
 * to `_missingAttribute`. Shaped for speed: a `pyObject` proxy traps every read
 * and write, and most traffic on these objects is own fields and their own
 * class's members.
 *
 * A write to an own field or to an accessor above the proxy skips
 * `_assignAttribute`, so this is exact only for a `_assignAttribute` that lets every
 * existing attribute through (as `object.__setattr__` would) and rules on
 * new names alone. `setattrPassesPrivate`: `_assignAttribute` (on every
 * subclass too) hands `_`-prefixed names straight to `object.__setattr__`,
 * so a constructor's private fields skip it.
 */
export function pyClassHooks(cls: Function, kw: { setattrPassesPrivate?: boolean } = {}): void {
  const privatePass = kw.setattrPassesPrivate ?? false;
  // An empty target over the base prototype: the proxy then reports that prototype as its
  // own, so `instanceof Base` still finds it in the chain.
  const base: object = Object.create(Object.getPrototypeOf(cls.prototype));
  const hooks = new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key in target) return Reflect.get(target, key, receiver);
      if (key === "then" || key === "toJSON" || key === "constructor") return undefined;
      // Special methods are looked up on the type, never through `_missingAttribute` (see `pyObject`).
      if (_isSpecial(key)) return undefined;
      if (_hasGetattr(receiver)) return receiver._missingAttribute(key);
      return undefined;
    },
    set(target, key, value, receiver) {
      if (typeof key === "symbol" || (privatePass && key.startsWith("_")) || receiver === setattrTarget || !_hasSetattr(receiver)) {
        return Reflect.set(target, key, value, receiver);
      }
      // `_assignAttribute` passes an existing name on to `object.__setattr__`, which reports no
      // failure (a getter-only accessor ignores the write).
      if (key in target) Reflect.set(target, key, value, receiver);
      else receiver._assignAttribute(key, value);
      return true;
    },
  });
  Object.setPrototypeOf(cls.prototype, hooks);
}

const inSetattr = new WeakSet<object>();
// The object `objectSetattr` is writing to (a `pyClassHooks` instance), if any.
let setattrTarget: object | null = null;

/** The object a `pyObject` proxy wraps (`self` itself when it is not one). */
function targetOf(self: object): object {
  return PROXY_TARGETS.get(self) ?? self;
}

/** `object.__setattr__(self, name, value)` - bypasses `_assignAttribute`, still runs descriptors. */
export function objectSetattr(self: object, name: string, value: unknown): void {
  const target = targetOf(self);
  if (target === self) {
    // Not a `pyObject` proxy: only a `pyClassHooks` proxy can see this write.
    const outer = setattrTarget;
    setattrTarget = self;
    try {
      Reflect.set(self, name, value);
    } finally {
      setattrTarget = outer;
    }
    return;
  }
  inSetattr.add(target);
  try {
    Reflect.set(target, name, value, self);
  } finally {
    inSetattr.delete(target);
  }
}

/** `object.__getattribute__(self, name)` - no `_missingAttribute` fallback. */
export function objectGetattr(self: object, name: string): any {
  const target = targetOf(self);
  if (!(name in target)) {
    throw new AttributeError(`'${target.constructor?.name}' object has no attribute '${name}'`);
  }
  return Reflect.get(target, name, self);
}

const INSTANCE_DICT: unique symbol = Symbol("instanceDict");

/**
 * Python's `obj.__dict__`: a per-instance `Map` of attributes that bypass
 * descriptors (parse-time overrides that `ChunkField` / `CosField` read
 * first). Stored under a private symbol, non-enumerable, so `deepcopy` copies
 * it with the instance while `Object.assign` / spreads and property listings
 * skip it.
 */
export function instanceDict(obj: object): Map<string, any> {
  if (!Object.prototype.hasOwnProperty.call(obj, INSTANCE_DICT)) {
    Object.defineProperty(obj, INSTANCE_DICT, {
      value: new Map<string, unknown>(),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return Reflect.get(obj, INSTANCE_DICT);
}

/** Whether `obj` already holds per-instance overrides (a read never creates them). */
export function hasInstanceDict(obj: object): boolean {
  return Object.prototype.hasOwnProperty.call(obj, INSTANCE_DICT);
}

/** The JS protocol methods pyrt's builtins probe for in place of Python's special methods. */
const PROTOCOL = new Set(["equals", "has"]);

/** Python looks special methods up on the type, never through `_missingAttribute`. */
function _isSpecial(key: string): boolean {
  return (key.length > 4 && key.startsWith("__") && key.endsWith("__")) || PROTOCOL.has(key);
}
