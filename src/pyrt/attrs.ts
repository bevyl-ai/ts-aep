// The slice of `attrs` py_aep uses: `@define` classes with ordered,
// inherited fields, defaults / `Factory`, `metadata`, `init=False`, the
// leading-underscore init-name rule, and converters that also run on
// assignment (attrs' default `on_setattr`).
//
//   export class U1Chunk extends Chunk {
//     declare value: number;            // `declare`: no JS initializer
//   }
//   define(U1Chunk, { value: u1_field() });
//   register("efdc")(U1Chunk);          // decorators apply bottom-up
//
// Construction is keyword-only: `new U1Chunk({ chunk_type: "efdc", value: 1 })`.

import { TypeError_ } from "./errors.ts";

export type Factory<T = unknown> = { readonly __factory__: () => T };

export function Factory<T>(fn: () => T): Factory<T> {
  return { __factory__: fn };
}

const NOTHING: unique symbol = Symbol("NOTHING");

/**
 * `attrs` field metadata, read back by key. Each module that stores
 * metadata declares its keys by augmenting this interface (`fmt_field`'s
 * struct format, encoding, item class, ...).
 */
export interface Metadata {}

/** `attrs.field(...)` for a field holding a `V`: the default and converter produce a `V`. */
export type FieldSpec<V = unknown> = {
  default?: V | Factory<V>;
  /** Runs on every assignment, so it takes whatever was assigned. */
  converter?: ((value: unknown) => V) | null;
  metadata?: Metadata;
  init?: boolean;
  eq?: boolean;
  repr?: boolean;
};

/** The fields `define` records for instances `I`, each typed by the field it declares. */
export type FieldSpecs<I> = { [K in keyof I as Exclude<K, "constructor">]?: FieldSpec<I[K]> };

/** `attrs.Attribute` as `attrs.fields(cls)` returns it. */
export type Attribute = {
  readonly name: string;
  readonly default: unknown;
  readonly converter: ((value: unknown) => unknown) | null;
  readonly metadata: Metadata;
  readonly init: boolean;
  readonly eq: boolean;
  readonly repr: boolean;
  readonly alias: string;
};

/** `attrs.field(...)` */
export function field<V>(spec: FieldSpec<V> = {}): FieldSpec<V> {
  return spec;
}

const FIELDS = new WeakMap<Function, readonly Attribute[]>();

/** attrs strips one leading underscore for the `__init__` parameter: `_trailing` -> `trailing`. */
export function init_name(name: string): string {
  return name.startsWith("_") ? name.replace(/^_+/, "") : name;
}

/**
 * `@define`: record `cls`'s own fields after its base's. A field redefined
 * here replaces the inherited one and moves to its new position, as attrs
 * orders them.
 */
export function define<C extends abstract new (...args: never) => object>(
  cls: C,
  own: FieldSpecs<InstanceType<C>> & Record<string, FieldSpec> = {},
): C {
  const base: Function | null = Object.getPrototypeOf(cls);
  const inherited = (base && FIELDS.get(base)) || [];
  const own_attrs: Attribute[] = Object.entries(own).map(([name, spec]) => ({
    name,
    default: "default" in spec ? spec.default : NOTHING,
    converter: spec.converter ?? null,
    metadata: Object.freeze({ ...(spec.metadata ?? {}) }),
    init: spec.init ?? true,
    eq: spec.eq ?? true,
    repr: spec.repr ?? true,
    alias: init_name(name),
  }));
  const own_names = new Set(own_attrs.map((a) => a.name));
  const all = [...inherited.filter((a) => !own_names.has(a.name)), ...own_attrs];
  FIELDS.set(cls, Object.freeze(all));
  for (const a of own_attrs) {
    if (!a.converter) continue;
    const slot = `__attrs_${a.name}`;
    const convert = a.converter;
    Object.defineProperty(cls.prototype, a.name, {
      configurable: true,
      enumerable: true,
      get(this: Record<string, unknown>) {
        return this[slot];
      },
      set(this: Record<string, unknown>, value: unknown) {
        this[slot] = convert(value);
      },
    });
  }
  return cls;
}

/** `attrs.fields(cls)` */
export function fields(cls: Function): readonly Attribute[] {
  // An undecorated subclass inherits its base's `__attrs_attrs__`.
  for (let c: Function | null = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    const f = FIELDS.get(c);
    if (f) return f;
  }
  throw new TypeError_(`${cls.name} is not an attrs-decorated class.`);
}

/** `attrs.has(cls)` */
export function has(cls: Function): boolean {
  try {
    fields(cls);
    return true;
  } catch {
    return false;
  }
}

/** Pass as the constructor argument to skip attrs' `__init__` (a hand-written `__init__` sets fields itself). */
export const NO_INIT: unique symbol = Symbol("NO_INIT");

function is_factory(d: Attribute["default"]): d is Factory {
  return !!d && typeof d === "object" && "__factory__" in d;
}

function default_of(a: Attribute): unknown {
  return is_factory(a.default) ? a.default.__factory__() : a.default;
}

/** A generated `__init__`: sets every field and returns how many keys of `kw` it consumed. */
type Kw = Record<string, unknown>;
type Init = (self: object, kw: Kw) => number;
const INITS = new WeakMap<Function, Init | null>();

/**
 * Generate the class's `__init__`, as attrs does: literal names keep each
 * class's stores monomorphic. Null where `new Function` is refused (Workers,
 * strict CSP).
 */
function compile_init(cls: Function): Init | null {
  const defs: Attribute["default"][] = [];
  const body = ["let m = 0, v;"];
  for (const a of fields(cls)) {
    const name = JSON.stringify(a.name);
    const alias = JSON.stringify(a.alias);
    const i = defs.push(is_factory(a.default) ? a.default.__factory__ : a.default) - 1;
    const dflt = is_factory(a.default) ? `defs[${i}]()` : `defs[${i}]`;
    const required = a.default === NOTHING;
    if (!a.init) {
      if (!required) body.push(`self[${name}] = ${dflt};`);
      continue;
    }
    body.push(`v = undefined; if (${alias} in kw) { m++; v = kw[${alias}]; }`);
    body.push(`if (v === undefined) ${required ? `throw missing(${alias})` : `v = ${dflt}`};`);
    body.push(`self[${name}] = v;`);
  }
  body.push("return m;");
  const missing = (alias: string) => new TypeError_(`${cls.name}.__init__() missing 1 required argument: '${alias}'`);
  try {
    return new Function("defs", "missing", `return (self, kw) => {\n${body.join("\n")}\n};`)(defs, missing);
  } catch {
    return null;
  }
}

/**
 * The generated `__init__`. Keyword names are only counted here; when the
 * count shows an unexpected one (or codegen is blocked), `attrs_init_slow`
 * runs to raise attrs' error.
 */
export function attrs_init(self: object, cls: Function, kw: Kw): void {
  let init = INITS.get(cls);
  if (init === undefined) INITS.set(cls, (init = compile_init(cls)));
  let n = 0;
  for (const _ in kw) n++;
  if (init === null || init(self, kw) !== n) attrs_init_slow(self, cls, kw);
}

/** `self[name] = value` as module (strict) code runs it: a refused assignment throws. */
function assign(self: object, name: string, value: unknown): void {
  if (!Reflect.set(self, name, value)) throw new TypeError(`Cannot assign to read only property '${name}' of object`);
}

function attrs_init_slow(self: object, cls: Function, kw: Kw): void {
  const attrs = fields(cls);
  const seen = new Set<string>();
  for (const a of attrs) {
    if (!a.init) {
      const d = default_of(a);
      if (d !== NOTHING) assign(self, a.name, d);
      continue;
    }
    let v: unknown;
    if (Object.prototype.hasOwnProperty.call(kw, a.alias) && kw[a.alias] !== undefined) {
      v = kw[a.alias];
      seen.add(a.alias);
    } else {
      v = default_of(a);
      if (Object.prototype.hasOwnProperty.call(kw, a.alias)) seen.add(a.alias);
      if (v === NOTHING) {
        throw new TypeError_(`${cls.name}.__init__() missing 1 required argument: '${a.alias}'`);
      }
    }
    assign(self, a.name, v);
  }
  for (const k of Object.keys(kw)) {
    if (!seen.has(k)) throw new TypeError_(`${cls.name}.__init__() got an unexpected keyword argument '${k}'`);
  }
}

/** Base for attrs classes; subclasses must declare fields with `declare` and register them via `define`. */
export class AttrsBase {
  constructor(kw: Record<string, unknown> | typeof NO_INIT = {}) {
    if (kw !== NO_INIT) attrs_init(this, new.target, kw);
  }
}

/** The generated `__eq__` (`equals`): same class and equal `eq=True` fields. */
export function attrs_eq(a: object, b: unknown, eq: (x: unknown, y: unknown) => boolean): boolean {
  if (a === b) return true;
  if (!b || a.constructor !== Object(b).constructor) return false;
  for (const f of fields(a.constructor)) {
    if (f.eq && !eq(Reflect.get(a, f.name), Reflect.get(Object(b), f.name, b))) return false;
  }
  return true;
}
