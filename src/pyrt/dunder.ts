// Descriptors (`get` / `set` / `attach`) installed as accessors with `descriptor()`:
//
//   class Layer {
//     declare enabled: boolean;
//     static {
//       descriptor(this, "enabled", new ChunkField(...));
//     }
//   }
//
import { AttributeError } from "./errors.ts";

/**
 * A descriptor on instances of `O` whose reads produce a `V`. `descriptor()`
 * only reads through instances; a Python-style `get` that also accepts
 * `null` (a class read) returns the descriptor itself there.
 */
export interface Descriptor<O extends object = object, V = unknown> {
  attach?(owner: Function, name: string): void;
  get(obj: O, owner: Function): V | Descriptor<O, V>;
  set?(obj: O, value: V): void;
  delete?(obj: O): void;
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
 * Install `d` as class attribute `name` of `cls` (runs `attach`).
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
  d.attach?.(cls, name);
  let own = DESCRIPTORS.get(cls);
  if (!own) DESCRIPTORS.set(cls, (own = new Map()));
  own.set(name, d);
  Object.defineProperty(cls.prototype, name, {
    configurable: true,
    enumerable: false,
    get(this: { constructor: Function }) {
      return d.get(this, this.constructor);
    },
    set(this: object, value: unknown) {
      if (!d.set) throw new AttributeError(`can't set attribute '${name}'`);
      d.set(this, value);
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
