// `enum.IntEnum` / `enum.Enum`. Members are plain values (numbers for
// IntEnum), so they compare with `===` against values read from a file or
// from ExtendScript JSON. What Python hangs off the member hangs off the
// enum object instead:
//
//   Python                         TypeScript
//   BlendingMode.ADD               BlendingMode.ADD
//   BlendingMode(5220)             BlendingMode.of(5220)      (ValueError if unknown, after `_missing_`)
//   member.name                    BlendingMode.name_of(member)
//   member.value                   member
//   isinstance(x, BlendingMode)    BlendingMode.has(x)
//   list(BlendingMode)             BlendingMode.members()
//   BlendingMode["ADD"]            BlendingMode.by_name("ADD")  (KeyError if unknown)
//   BlendingMode.__name__          BlendingMode.__name__
//
// Class-level methods (`from_binary`, `to_binary`, `_missing_`, ...) go in
// `methods`; they are called with the enum object as `this`.
//
//   export const BlendingMode = int_enum("BlendingMode", { NORMAL: 5212, ADD: 5220 }, {
//     from_binary(value: number): BlendingMode { return BlendingMode.of(value); },
//   });
//   export type BlendingMode = EnumValue<typeof BlendingMode>;

import { KeyError, ValueError } from "./errors.ts";

const AUTO: unique symbol = Symbol("auto");

/** `enum.auto()` - the previous value + 1 (1 for the first member). */
export function auto(): typeof AUTO {
  return AUTO;
}

type Resolved<M> = { readonly [K in keyof M]: M[K] extends typeof AUTO ? number : M[K] };

export type EnumHelpers<V> = {
  readonly __name__: string;
  /** `Enum(value)` */
  of(value: unknown): V;
  /** `Enum(value)`, or `null` where it would raise ValueError. */
  of_or_null(value: unknown): V | null;
  /** `member.name` */
  name_of(value: V): string;
  /** `isinstance(value, Enum)` */
  has(value: unknown): value is V;
  /** `list(Enum)` (aliases excluded, definition order). */
  members(): V[];
  /** `Enum[name]` */
  by_name(name: string): V;
  /** `Enum.__members__` (aliases included). */
  readonly __members__: ReadonlyMap<string, V>;
};

export type EnumValue<E> = E extends EnumHelpers<infer V> ? V : never;

export function pyEnum<const M extends Record<string, unknown>, X extends Record<string, unknown> = {}>(
  name: string,
  members: M,
  methods?: X & ThisType<Resolved<M> & EnumHelpers<Resolved<M>[keyof M]> & X>,
): Resolved<M> & EnumHelpers<Resolved<M>[keyof M]> & X {
  type V = Resolved<M>[keyof M];
  const byName = new Map<string, V>();
  const byValue = new Map<unknown, string>();
  const canonical: V[] = [];
  let last = 0;
  for (const [k, raw] of Object.entries(members)) {
    const v = (raw === AUTO ? last + 1 : raw) as V;
    if (typeof v === "number") last = v;
    byName.set(k, v);
    if (!byValue.has(v)) {
      byValue.set(v, k);
      canonical.push(v);
    }
  }
  const self = Object.fromEntries(byName);
  const helpers: EnumHelpers<V> = {
    __name__: name,
    of(value: unknown): V {
      const found = helpers.of_or_null(value);
      if (found !== null) return found;
      throw new ValueError(`${typeof value === "string" ? `'${value}'` : String(value)} is not a valid ${name}`);
    },
    of_or_null(value: unknown): V | null {
      if (helpers.has(value)) return value;
      if (typeof self._missing_ === "function") return self._missing_(value) ?? null;
      return null;
    },
    name_of(value: V): string {
      const n = byValue.get(value);
      if (n === undefined) throw new ValueError(`${String(value)} is not a valid ${name}`);
      return n;
    },
    has(value: unknown): value is V {
      return byValue.has(value);
    },
    members(): V[] {
      return [...canonical];
    },
    by_name(n: string): V {
      const v = byName.get(n);
      if (v === undefined) throw new KeyError(`'${n}'`);
      return v;
    },
    __members__: byName,
  };
  for (const [k, v] of Object.entries(helpers)) Object.defineProperty(self, k, { value: v, enumerable: false });
  if (methods) {
    for (const [k, v] of Object.entries(Object.getOwnPropertyDescriptors(methods))) {
      Object.defineProperty(self, k, { ...v, enumerable: false });
    }
  }
  return Object.freeze(self) as Resolved<M> & EnumHelpers<Resolved<M>[keyof M]> & X;
}

/** `class X(IntEnum)` */
export const intEnum = pyEnum;
