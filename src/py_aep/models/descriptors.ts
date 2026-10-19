/**
 * Descriptors for chunk-backed model fields.
 *
 * Each descriptor reads from / writes to a binary chunk attribute,
 * so that modifying a model field directly mutates the underlying binary
 * data and `Project.save()` persists the change.
 */

import {
  AttributeError,
  RuntimeError,
  ValueError,
  getMember,
  int,
  literal,
  hasInstanceDict,
  instanceDict,
  typeName,
} from "../../pyrt/index.ts";
import type { EnumHelpers, EnumValue } from "../../pyrt/enum.ts";
import type { FieldValue } from "../binary/fmt_field.ts";
import type { ParamDef } from "../parsers/effect.ts";
import { getAeVersionMajor } from "../ae_version.ts";
import { validateBool, validateEnum } from "./validators.ts";

/** Callable applied to a chunk value on read (`transform`) or write (`reverse`). */
type ChunkTransform<R = FieldValue> = (value: FieldValue) => R;

/**
 * The names of `O`'s methods that take no arguments (`preSet` / `postSet`
 * hooks); any name when the owner is not known (`O` is `object`).
 */
type HookName<O> = object extends O
  ? string
  : { [K in keyof O]-?: O[K] extends () => void ? K : never }[keyof O] & string;

/** The name of an attribute of `O` (a chunk body); any name when the owner is not known. */
export type AttrName<O> = object extends O ? string : string & keyof O;

/** The chunk or item `O[A]` holds, ignoring a missing (`null`) body; any object when the owner is not known. */
type ChunkBody<O, A extends string> = A extends keyof O ? NonNullable<O[A]> : object;

/** Field names of that body. A body with no known keys accepts any name. */
type ChunkFieldKey<O, A extends string> = [keyof ChunkBody<O, A> & string] extends [never]
  ? string
  : keyof ChunkBody<O, A> & string;

/** The type of field `F` on that body. */
type RawField<O, A extends string, F extends string> = F extends keyof ChunkBody<O, A>
  ? ChunkBody<O, A>[F]
  : FieldValue;

/**
 * The model object a `ChunkField` reads through: its chunk body is found by
 * name (`getattr(obj, chunk_attr)`) and a synthetic body is materialized
 * through `obj._ensure_materialized()`, which only owners of synthetic chunks
 * define (Python duck typing).
 */
export interface ChunkOwner {
  _ensureMaterialized?(): void;
  /** Throws when the owner no longer backs the file (a replaced format-options wrapper). */
  _checkAttached?(): void;
}

/** Effect match name → parameter match name → pard field bag. */
export type EffectParamDefs = Map<string, Map<string, ParamDef>>;

/**
 * Keyword arguments of `ChunkField` for a field reading as `T` on an `O`.
 * The owner `O` is never inferred from the callbacks, only from the class
 * the field is installed on.
 */
export type ChunkFieldOptions<T, O> = {
  /**
   * Reads the stored field value as `T`. Each field's transform takes that
   * field's own raw type, which the shared option type cannot name; method
   * syntax compares the parameter bivariantly so a transform typed for its
   * field is accepted.
   */
  transform?: { read(value: FieldValue): T }["read"] | null;
  reverse?: ((value: NoInfer<T>) => FieldValue) | null;
  readOnly?: boolean;
  validate?: ((value: NoInfer<T>, obj: NoInfer<O>) => void) | null;
  default?: NoInfer<T>;
  preSet?: HookName<NoInfer<O>> | null;
  postSet?: ((obj: NoInfer<O>) => void) | HookName<NoInfer<O>> | null;
  minVersion?: number | null;
};

/**
 * `ChunkField` options. `transform` reads the chunk field's real type. It is
 * required when that type is not already what the descriptor returns (`T`),
 * and optional when the owner is not known (`O` is `object`).
 */
type ChunkFieldKw<T, O, Raw> = object extends O
  ? ChunkFieldOptions<T, O>
  : Omit<ChunkFieldOptions<T, O>, "transform"> &
      ([Raw] extends [T] ? { transform?: ((value: Raw) => T) | null } : { transform: (value: Raw) => T });

/** `ChunkField.enum` options: `transform` reads the chunk field's real type and defaults to the enum's `fromBinary`. */
type ChunkFieldEnumKw<T, O, Raw> = Omit<ChunkFieldOptions<T, O>, "transform"> & {
  transform?: ((value: Raw) => T) | null;
};

export const _SENTINEL: unique symbol = Symbol("_SENTINEL");

// While a parser runs this is set to False so that `ChunkField.set`
// rejects writes: parsers must not mutate chunk data through descriptors
// (round-trip idempotency). Parsers cache values via `__dict__` overrides
// or the private `_cacheValue` helpers instead. Outside parsing the
// default (True) lets end-user writes through.
export const materialization = { allowed: true };

/** Run `body` with descriptor writes forbidden; restores the previous state after. */
export function runSuppressed<R>(body: () => R): R {
  const previous = materialization.allowed;
  materialization.allowed = false;
  try {
    return body();
  } finally {
    materialization.allowed = previous;
  }
}

/**
 * `fn` with descriptor writes forbidden while it runs. Parser entry points are
 * wrapped in this, so a descriptor write during parsing raises `RuntimeError`
 * instead of silently mutating chunk data.
 */
export function suppressingMaterialization<T, A extends unknown[], R>(
  fn: (this: T, ...args: A) => R,
): (this: T, ...args: A) => R {
  return function (this: T, ...args: A) {
    return runSuppressed(() => fn.apply(this, args));
  };
}

/**
 * Python `isinstance(x, IntEnum)` for a py_enum object (pyrt/enum.ts).
 */
// NOTE(port): int_enum === py_enum in pyrt, so this also admits non-int enums; the only non-IntEnum enum in py_aep (cos.TokenType) never reaches a descriptor, so the IntEnum check matches Python.
function isEnum(x: unknown): x is EnumHelpers<number> {
  return x != null && typeof x === "object" && "allMembers" in x && "has" in x && typeof x.has === "function";
}

/**
 * Return the IntEnum class behind `transform`, if any.
 *
 * Detects a `fromBinary` method bound by `boundEnumMethod` (via its
 * `enumClass`) or a direct enum class reference.
 */
function _enumClass<R>(transform: ChunkTransform<R> | null | undefined): EnumHelpers<number> | null {
  if (transform == null) return null;
  let enumCls: unknown = "enumClass" in transform ? transform.enumClass : null;
  if (enumCls == null && isEnum(transform)) enumCls = transform;
  if (isEnum(enumCls)) return enumCls;
  return null;
}

/**
 * The enum's `name` method bound to the enum, or `dflt`. The result carries
 * the enum as `enumClass`, which `_enumClass` reads back.
 */
function boundEnumMethod<V, R extends number>(
  enumCls: EnumHelpers<number>,
  name: string,
  dflt: EnumHelpers<R> | ((value: V) => R),
): (value: V) => R {
  const m = getMember(enumCls, name, dflt);
  // Python's default is the enum class itself, which is callable (`E(v)`); a
  // py_enum object is not, so use `E.of` and keep `enumClass` for `_enumClass`.
  if (m === dflt) return isEnum(dflt) ? Object.assign((v: V) => dflt.of(v), { enumClass: dflt }) : dflt;
  if (typeof m !== "function") return m;
  return Object.assign(m.bind(enumCls), { enumClass: enumCls });
}

/**
 * Wrap a get-transform so out-of-enum stored values read back raw.
 *
 * Real `.aep` files can hold values outside our enums (e.g. an output
 * depth AE keeps but has no label for, -16, or a format id from a
 * third-party output plugin); the binary is trusted, so reads must not
 * raise. Mirrors the fallback
 * `_tryEnumOrInt` uses for XML params.
 *
 * For a chunk-backed field prefer
 * `ChunkField.enum(..., allow_out_of_enum_values=True)`, which applies
 * this wrapper and restores write-side strictness for you. This helper
 * is for the read paths that are not `ChunkField`s (e.g. a `@property`
 * over decoded JSON).
 */
export function enumOrRaw<V, R>(convert: (value: V) => R): (value: V) => R | V {
  function _transform(value: V): R | V {
    try {
      return convert(value);
    } catch (e) {
      if (!(e instanceof ValueError || e instanceof TypeError)) throw e;
      // TypeError: a `convert` that coerces first (e.g. `int(v)` over
      // decoded JSON) raises it, not ValueError, for a non-scalar.
      return value;
    }
  }
  return _transform;
}

/**
 * Raise `ValueError` if `value` is not a valid member of `enumCls`.
 *
 * Raw ints must appear in the enum's value map; any other type must
 * already be an instance of the enum.
 */
function _validateEnumMember(enumCls: EnumHelpers<number>, value: unknown, publicName: string): void {
  if (enumCls.has(value)) return;
  // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); an integer-valued float such as 2.0 takes the int branch and gets the "Invalid value" message instead of "is not a valid".
  // A Python bool is an int that hashes like 0/1, so it is checked as its int value.
  if (typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value))) {
    const key = typeof value === "boolean" ? Number(value) : value;
    if (!enumCls.has(key)) {
      const members = enumCls
        .members()
        .map((m) => `${enumCls.nameOf(m)} (${m})`)
        .join(", ");
      throw new ValueError(
        `Invalid value ${literal(value)} for ${literal(publicName)}. ` + `Valid ${enumCls.enumName} values: ${members}`,
      );
    }
  } else {
    throw new ValueError(`${literal(value)} is not a valid ${enumCls.enumName}`);
  }
}

/**
 * Descriptor that proxies a single field on a chunk body.
 *
 * @param chunk_attr - Name of the model attribute holding the chunk body reference (e.g.
 *   `"_cdta"`).
 * @param field - Name of the field on the chunk body (e.g. `"width"`).
 * @param transform - Optional callable applied when *getting* (binary -\> user-facing value).
 * @param reverse - 1-arg callable applied when *setting* (user-facing -\> binary value). Returns a
 *   scalar written to `field`.
 * @param read_only - When `true`, the field cannot be set. Defaults to `false`.
 * @param validate - Optional callable called with the user-facing value before any reverse
 *   transform. Must raise `ValueError` or `TypeError` if the value is invalid.
 * @param default - Optional default value returned when the chunk body is `null`. If not given,
 *   accessing the field when the body is `null` raises `AttributeError`.
 * @param pre_set - Optional method name on the model instance, invoked after validation and before
 *   the value is written.
 * @param post_set - Optional method name on the model instance, or a callable receiving the model
 *   instance, invoked after the value has been written.
 */
export class ChunkField<
  T,
  O extends object = object,
  A extends AttrName<O> = AttrName<O>,
  F extends ChunkFieldKey<O, A> = ChunkFieldKey<O, A>,
> {
  declare chunkAttr: string;
  declare field: string;
  declare transform: ((value: FieldValue) => T) | null;
  declare reverse: ((value: T) => FieldValue) | null;
  declare readOnly: boolean;
  declare validate: ((value: T, obj: O) => void) | null;
  declare default: T | typeof _SENTINEL;
  declare preSet: string | null;
  declare postSet: ((obj: O) => void) | string | null;
  declare minVersion: number | null;
  declare _enumCls: EnumHelpers<number> | null;
  declare publicName: string;

  /**
   * `O` is the model the descriptor is installed on. `A`/`F` are the chunk
   * attribute and field name. `T` is what the descriptor reads as
   * (`descriptor(...)` supplies it): the field's type, or what `transform`
   * returns when the stored type is wider.
   */
  constructor(chunkAttr: A & NoInfer<AttrName<O>>, field: F, kw?: ChunkFieldKw<T, O, RawField<O, A, F>>);
  constructor(chunkAttr: string, field: string, kw: ChunkFieldOptions<T, O> = {}) {
    const {
      transform = null,
      reverse = null,
      readOnly = false,
      validate = null,
      default: default_ = _SENTINEL,
      preSet = null,
      postSet = null,
      minVersion = null,
    } = kw;
    this.chunkAttr = chunkAttr;
    this.field = field;
    this.transform = transform;
    this.reverse = reverse;
    this.readOnly = readOnly;
    this.validate = validate;
    this.default = default_;
    this.preSet = preSet;
    this.postSet = postSet;
    this.minVersion = minVersion;
    // Derived once so set validates membership without
    // re-inspecting the transform on every write.
    this._enumCls = _enumClass(transform);
  }

  attach(owner: Function, name: string): void {
    this.publicName = name;
  }

  get(obj: O | null, _objtype?: Function | null): T | ChunkField<T, O> {
    if (obj == null) return this;
    // Parse-time overrides (e.g. ExtendScript-compatible values that
    // differ from the binary) are stored in the instance dict and take
    // priority over the chunk body. A read never creates the dict (shaped
    // for speed: every model field read lands here).
    if (hasInstanceDict(obj)) {
      const overrides = instanceDict(obj);
      if (overrides.has(this.publicName)) return overrides.get(this.publicName);
    }
    const body = getMember(obj, this.chunkAttr);
    if (body == null) {
      if (this.default !== _SENTINEL) return this.default;
      throw new AttributeError(`chunk body ${literal(this.chunkAttr)} is null`);
    }
    const value = getMember(body, this.field);
    return this.transform ? this.transform(value) : value;
  }

  set(obj: O & ChunkOwner, value: T): void {
    if (this.readOnly) throw new AttributeError(`${literal(this.publicName)} is read-only.`);
    obj._checkAttached?.();
    if (this.minVersion != null) {
      let major: number | null;
      try {
        major = getAeVersionMajor(obj);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        // Version undeterminable (e.g. a ViewOptions whose viewer
        // has no AVItem); skip the gate and allow the write.
        major = null;
      }
      if (major != null && major < this.minVersion) {
        throw new AttributeError(`${literal(this.publicName)} requires AE ${this.minVersion}+ file format.`);
      }
    }
    if (!materialization.allowed) {
      throw new RuntimeError(
        `Cannot write ${literal(this.publicName)} via descriptor during ` +
          `parsing. Use instanceDict(obj).set(${literal(this.publicName)}, value) for ` +
          `parse-time overrides.`,
      );
    }
    // Validate BEFORE touching anything. `_ensureMaterialized` flips
    // synthetic chunks to real, so a rejected write that reached it
    // would mutate the tree and break the byte-identical round-trip
    // (`parse()` -> `save()`). A field with no backing chunk body must
    // validate too, or its `__dict__` fallback below would accept a
    // value the chunk-backed path rejects.
    if (this.validate) this.validate(value, obj);
    if (this._enumCls != null) _validateEnumMember(this._enumCls, value, this.publicName);
    if (this.preSet != null) getMember(obj, this.preSet).call(obj);
    instanceDict(obj).delete(this.publicName);
    let body = getMember(obj, this.chunkAttr);
    if (body == null) {
      instanceDict(obj).set(this.publicName, value);
      return;
    }
    if (body.synthetic) {
      const owner: ChunkOwner = obj;
      if (owner._ensureMaterialized == null) {
        throw new AttributeError(`'${typeName(owner)}' object has no attribute '_ensure_materialized'`);
      }
      owner._ensureMaterialized();
      body = getMember(obj, this.chunkAttr);
    }
    if (this.reverse != null) body[this.field] = this.reverse(value);
    else body[this.field] = value;
    if (this.postSet != null) {
      if (typeof this.postSet === "string") {
        getMember(obj, this.postSet).call(obj);
      } else {
        const post = this.postSet;
        post(obj);
      }
    }
  }

  // NOTE: the Python source shadows the builtin `bool` inside the class
  // body, so annotations there spell it `builtins.bool`; in TS the static
  // method below is simply `boolean`-typed.
  /**
   * Create a ChunkField for a boolean field.
   *
   * Bakes in `validate=validate_bool` so a writable bool field cannot
   * silently accept a non-bool: the binary layer packs the value
   * straight into a 1-byte field, so `= 2` would write a byte AE never
   * writes and `= "no"` would only blow up later, at `save()`.
   *
   * Pass `validate=` to override (compose by calling `validateBool`
   * first). For a bool backed by a generic integer chunk field (e.g.
   * `U1Chunk.value`) add `transform=bool, reverse=int`.
   */
  static bool<
    O extends object = object,
    A extends AttrName<O> = AttrName<O>,
    F extends ChunkFieldKey<O, A> = ChunkFieldKey<O, A>,
  >(
    chunkAttr: A & NoInfer<AttrName<O>>,
    field: F,
    kwargs?: ChunkFieldKw<boolean, O, RawField<O, A, F>>,
  ): ChunkField<boolean, O>;
  static bool(chunkAttr: string, field: string, kwargs: ChunkFieldOptions<boolean, object> = {}): ChunkField<boolean> {
    kwargs = { ...kwargs };
    if (!("validate" in kwargs)) kwargs.validate = validateBool;
    return new this(chunkAttr, field, kwargs);
  }

  /**
   * Create a ChunkField for IntEnum-backed fields.
   *
   * Auto-detects `fromBinary`/`toBinary` on the enum class. If
   * the enum has a `fromBinary` classmethod it is used as
   * `transform`; otherwise the class itself is used. If the enum
   * has a `toBinary` method it is used as `reverse`; otherwise
   * `int` is used.
   *
   * @param kw - Keyword arguments:
   * - `allowOutOfEnumValues`: When `true`, a stored value outside the enum reads back raw
   *     instead of raising - real `.aep` files hold them (an unlabelled output depth, a format id
   *     from a third-party output plugin) and the binary is trusted. Wrapping the transform hides
   *     the enum class from `_enumClass`, so write-side membership strictness is restored via
   *     `validate=validate_enum(enum_cls)` unless the caller passes its own `validate` (which must
   *     then check membership itself).
   *   The field then reads as `EnumValue<E> | Raw`, `Raw` being the rest of the
   *   declared field type (`declare depth: OutputColorDepth | number`).
   */
  static enum<
    E extends EnumHelpers<number>,
    Raw = never,
    O extends object = object,
    A extends AttrName<O> = AttrName<O>,
    F extends ChunkFieldKey<O, A> = ChunkFieldKey<O, A>,
  >(
    enumCls: E,
    chunkAttr: A & NoInfer<AttrName<O>>,
    field: F,
    kw: ChunkFieldEnumKw<EnumValue<E> | Raw, O, RawField<O, A, F>> & { allowOutOfEnumValues: true },
  ): ChunkField<EnumValue<E> | Raw, O>;
  static enum<
    E extends EnumHelpers<number>,
    O extends object = object,
    A extends AttrName<O> = AttrName<O>,
    F extends ChunkFieldKey<O, A> = ChunkFieldKey<O, A>,
  >(
    enumCls: E,
    chunkAttr: A & NoInfer<AttrName<O>>,
    field: string & F,
    kw?: ChunkFieldEnumKw<EnumValue<E>, O, RawField<O, A, F>> & { allowOutOfEnumValues?: false },
  ): ChunkField<EnumValue<E>, O>;
  static enum<V extends number, R extends V>(
    enumCls: EnumHelpers<V>,
    chunkAttr: string,
    field: string,
    kw: { allowOutOfEnumValues?: boolean } & ChunkFieldEnumKw<V, object, R> = {},
  ): ChunkField<V> {
    const { allowOutOfEnumValues = false, ...kwargs } = kw;
    if (!("transform" in kwargs)) kwargs.transform = boundEnumMethod(enumCls, "fromBinary", enumCls);
    if (!("reverse" in kwargs)) kwargs.reverse = boundEnumMethod(enumCls, "toBinary", int);
    if (allowOutOfEnumValues) {
      // A stored value outside the enum reads back raw instead of raising;
      // the overloads require the raw field type to fit the declared one.
      const transform = kwargs.transform;
      if (transform != null) kwargs.transform = enumOrRaw(transform);
      if (!kwargs.readOnly && !("validate" in kwargs)) kwargs.validate = validateEnum(enumCls);
    }
    return new this(chunkAttr, field, kwargs);
  }
}
