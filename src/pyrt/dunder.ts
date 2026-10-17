// Python attribute protocol: descriptors (`__get__`/`__set__`/
// `__set_name__`), `__getattr__` fallbacks and `__setattr__` hooks.
//
// Descriptor in a class body:
//   class Layer:                         class Layer {
//       enabled = ChunkField(...)            declare enabled: boolean;
//                                        }
//                                        descriptor(Layer, "enabled", new ChunkField(...));
//
// `__getattr__` / `__setattr__`: end the constructor with
//   `return py_object(this);`
// and define `__getattr__(name)` / `__setattr__(name, value)` methods. Inside
// `__setattr__`, `object.__setattr__(self, name, value)` is
// `object_setattr(this, name, value)`.

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
export function get_descriptor(cls: Function, name: string): Descriptor | undefined {
  for (let c: Function | null = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    const d = DESCRIPTORS.get(c)?.get(name);
    if (d) return d;
  }
  return undefined;
}

/** All descriptors visible on `cls`, base-first then overridden by subclasses (like `vars()` over the MRO). */
export function descriptors_of(cls: Function): Map<string, Descriptor> {
  const chain: Function[] = [];
  for (let c: Function | null = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) chain.unshift(c);
  const out = new Map<string, Descriptor>();
  for (const c of chain) for (const [k, v] of DESCRIPTORS.get(c) ?? []) out.set(k, v);
  return out;
}

// `py_object` proxy -> the instance it wraps.
const PROXY_TARGETS = new WeakMap<object, object>();

function _has_getattr(x: object): x is { __getattr__(name: string): unknown } {
  return "__getattr__" in x && typeof x.__getattr__ === "function";
}

function _has_setattr(x: object): x is { __setattr__(name: string, value: unknown): void } {
  return "__setattr__" in x && typeof x.__setattr__ === "function";
}

/**
 * Wrap a freshly constructed instance so `__getattr__` runs for missing
 * attributes and `__setattr__` for every assignment, as in Python.
 */
export function py_object<T extends object>(self: T): T {
  const has_getattr = _has_getattr(self);
  const has_setattr = _has_setattr(self);
  if (!has_getattr && !has_setattr) return self;
  const proxy = new Proxy(self, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key in target || !has_getattr) return Reflect.get(target, key, receiver);
      if (key === "then" || key === "toJSON" || key === "constructor") return undefined;
      // Python looks special methods (`__bool__`, `__eq__`, `__len__`, ...) up on the type,
      // never through `__getattr__`; pyrt probes them as property reads, so a miss is undefined.
      if (key.length > 4 && key.startsWith("__") && key.endsWith("__")) return undefined;
      if (_has_getattr(receiver)) return receiver.__getattr__(key);
    },
    set(target, key, value, receiver) {
      if (typeof key === "symbol" || !has_setattr || in_setattr.has(target)) {
        return Reflect.set(target, key, value, receiver);
      }
      if (_has_setattr(receiver)) receiver.__setattr__(key, value);
      return true;
    },
  });
  PROXY_TARGETS.set(proxy, self);
  return proxy;
}

/**
 * `__getattr__` / `__setattr__` for every instance of `cls` and its
 * subclasses, without wrapping each instance in a `py_object` proxy: one
 * proxy is spliced into the prototype chain between `cls.prototype` and its
 * base's. A read of an own field or of a member of `cls` or a subclass
 * stops before it; base-class members and misses reach it, and a miss goes
 * to `__getattr__`. Shaped for speed: a `py_object` proxy traps every read
 * and write, and most traffic on these objects is own fields and their own
 * class's members.
 *
 * A write to an own field or to an accessor above the proxy skips
 * `__setattr__`, so this is exact only for a `__setattr__` that lets every
 * existing attribute through (as `object.__setattr__` would) and rules on
 * new names alone. `setattr_passes_private`: `__setattr__` (on every
 * subclass too) hands `_`-prefixed names straight to `object.__setattr__`,
 * so a constructor's private fields skip it.
 */
export function py_class_hooks(cls: Function, kw: { setattr_passes_private?: boolean } = {}): void {
  const private_pass = kw.setattr_passes_private ?? false;
  // An empty target over the base prototype: the proxy then reports that prototype as its
  // own, so `instanceof Base` still finds it in the chain.
  const base: object = Object.create(Object.getPrototypeOf(cls.prototype));
  const hooks = new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key in target) return Reflect.get(target, key, receiver);
      if (key === "then" || key === "toJSON" || key === "constructor") return undefined;
      // Special methods are looked up on the type, never through `__getattr__` (see `py_object`).
      if (key.length > 4 && key.startsWith("__") && key.endsWith("__")) return undefined;
      if (_has_getattr(receiver)) return receiver.__getattr__(key);
      return undefined;
    },
    set(target, key, value, receiver) {
      if (typeof key === "symbol" || (private_pass && key.startsWith("_")) || receiver === setattr_target || !_has_setattr(receiver)) {
        return Reflect.set(target, key, value, receiver);
      }
      // `__setattr__` passes an existing name on to `object.__setattr__`, which reports no
      // failure (a getter-only accessor ignores the write).
      if (key in target) Reflect.set(target, key, value, receiver);
      else receiver.__setattr__(key, value);
      return true;
    },
  });
  Object.setPrototypeOf(cls.prototype, hooks);
}

const in_setattr = new WeakSet<object>();
// The object `object_setattr` is writing to (a `py_class_hooks` instance), if any.
let setattr_target: object | null = null;

/** The object a `py_object` proxy wraps (`self` itself when it is not one). */
function target_of(self: object): object {
  return PROXY_TARGETS.get(self) ?? self;
}

/** `object.__setattr__(self, name, value)` - bypasses `__setattr__`, still runs descriptors. */
export function object_setattr(self: object, name: string, value: unknown): void {
  const target = target_of(self);
  if (target === self) {
    // Not a `py_object` proxy: only a `py_class_hooks` proxy can see this write.
    const outer = setattr_target;
    setattr_target = self;
    try {
      Reflect.set(self, name, value);
    } finally {
      setattr_target = outer;
    }
    return;
  }
  in_setattr.add(target);
  try {
    Reflect.set(target, name, value, self);
  } finally {
    in_setattr.delete(target);
  }
}

/** `object.__getattribute__(self, name)` - no `__getattr__` fallback. */
export function object_getattr(self: object, name: string): any {
  const target = target_of(self);
  if (!(name in target)) {
    throw new AttributeError(`'${target.constructor?.name}' object has no attribute '${name}'`);
  }
  return Reflect.get(target, name, self);
}

/**
 * `obj.__dict__`: a per-instance `Map` of instance attributes that bypass
 * descriptors (parse-time overrides that `ChunkField` / `CosField.__get__`
 * read first). Stored as an own, non-enumerable `__dict__` property, so
 * `deepcopy` copies it with the instance and `Object.assign` / spreads skip
 * it; writable and configurable so a class field named `__dict__` may alias it.
 */
export function instance_dict(obj: object): Map<string, any> {
  if (!Object.prototype.hasOwnProperty.call(obj, "__dict__")) {
    Object.defineProperty(obj, "__dict__", {
      value: new Map<string, unknown>(),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return Reflect.get(obj, "__dict__");
}
