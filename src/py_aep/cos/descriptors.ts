/**
 * Descriptors for COS-dict-backed model fields.
 *
 * Each descriptor reads from / writes to a COS dict stored on the model
 * instance, so that accessing a model attribute lazily extracts the value
 * from the underlying COS data.  After every `__set__`, the model's
 * `_propagate_cos()` hook is called to re-serialize the COS dict back
 * to the btdk chunk's `binary_data`.
 *
 * This module mirrors the role of
 * `models.descriptors.ChunkField` but operates on nested Python dicts
 * (COS parsed data) instead of binary chunk fields.
 */

import {
  AttributeError,
  IndexError,
  KeyError,
  TypeError_,
  ValueError,
  pyBool,
  pyfloat,
  repr,
  round,
  instanceDict,
} from "../../pyrt/index.ts";
import type { EnumHelpers } from "../../pyrt/enum.ts";
import { getAeVersionMajor } from "../ae_version.ts";
import type { InstanceValidator } from "../models/validators.ts";
import type { CosDict, CosNode } from "./cos.ts";
import { cosFloat, cosInt, cosNum } from "./kinds.ts";

/**
 * Read `key` from a COS dict with the descriptors' fault-tolerant
 * fallback: a missing key, or a `transform` that raises, yields
 * `default`. Shared by `CosField.__get__` and the range models'
 * mixed-value resolution.
 */
export function _extract<T, D>(d: CosDict, key: string, transform: (x: CosNode) => T, default_: D): T | D {
  const raw = d.get(key);
  if (raw === undefined) return default_;
  try {
    return transform(raw);
  } catch (e) {
    // Python catches (TypeError, ValueError, KeyError, IndexError); the
    // transforms raise those as pyrt exceptions (`kinds.ts`).
    if (!(e instanceof TypeError_ || e instanceof ValueError || e instanceof KeyError || e instanceof IndexError)) {
      throw e;
    }
    return default_;
  }
}

/** An IntEnum with COS conversions (`fromBinary` / `toBinary`). */
export type CosEnum<V> = EnumHelpers<V> & {
  fromBinary(value: number): number;
  toBinary(self: number): number;
};

/**
 * `E.from_binary(raw)` on a COS value: Python's `raw + offset`
 * (`TypeError` when `raw` is not a number) and the enum lookup.
 */
export function enumFromCos<V>(E: CosEnum<V>, raw: CosNode): V {
  return E.of(E.fromBinary(cosNum(raw)));
}

/** A model whose `A` attribute holds the COS sub-dict a field reads (`null` without COS backing). */
export type CosBacked<A extends string> = { readonly [P in A]: CosDict | null } & { _propagateCos?(): void };

/**
 * Options of {@link CosField}: `transform` reads the COS value as the
 * field's `T` (raising for values Python's transform refuses), `reverse`
 * writes the user's `T` back as a COS value.
 */
export interface CosFieldOptions<T extends InstanceValue, O> {
  transform: (x: CosNode) => T;
  /** Whether an instance override (Python `obj.__dict__[name]`) holds a `T`. */
  accepts: (v: InstanceValue) => v is T;
  reverse?: ((x: NonNullable<T>) => CosNode) | null;
  readOnly?: boolean;
  validate?: InstanceValidator<O> | null;
  default: T;
  minVersion?: number | null;
}

/** A value stored in a model's instance dict (`obj.__dict__`). */
export type InstanceValue = string | number | boolean | object | null;

/**
 * Descriptor that proxies a single key on a COS dict.
 *
 * The dict is retrieved from the model instance via `getattr(obj, dict_attr)`.  When the dict is `null` the descriptor returns
 * `default` (which defaults to `null`).
 *
 * Unlike `ChunkField`, this descriptor is scalar-only: `reverse`
 * always returns a single value written to one dict key.
 *
 * @param dict_attr - Name of the model attribute holding the COS sub-dict (e.g. `"_charStyle"`).
 * @param key - String key into that dict (e.g. `"1"` for font_size).
 * @param transform - Callable applied when *getting* (COS value -\> user-facing value).
 * @param reverse - 1-arg callable applied when *setting* (user-facing -\> COS value). Always returns
 *   a scalar.
 * @param read_only - When `true`, the field cannot be set.
 * @param validate - Optional callable called with the user-facing value before any `reverse`
 *   transform.
 * @param default - Value returned when the dict is `null` or the key is absent. Defaults to `null`.
 * @param min_version - Minimum AE major version required to *set* this field. Writes to an older
 *   file raise `AttributeError`; reads are always allowed. Mirrors `models.descriptors.ChunkField`.
 */
export class CosField<T extends InstanceValue, A extends string = string, O extends CosBacked<A> = CosBacked<A>> {
  declare dictAttr: A;
  declare key: string;
  declare transform: (x: CosNode) => T;
  declare accepts: (v: InstanceValue) => v is T;
  declare reverse: ((x: NonNullable<T>) => CosNode) | null;
  declare readOnly: boolean;
  declare validate: InstanceValidator<O> | null;
  declare default: T;
  declare minVersion: number | null;
  declare publicName: string;

  constructor(dictAttr: A, key: string, kw: CosFieldOptions<T, O>) {
    const { transform, accepts, reverse = null, readOnly: read_only = false, validate = null, default: default_, minVersion: min_version = null } = kw;
    this.dictAttr = dictAttr;
    this.key = key;
    this.transform = transform;
    this.accepts = accepts;
    this.reverse = reverse;
    this.readOnly = read_only;
    this.validate = validate;
    this.default = default_;
    this.minVersion = min_version;
  }

  __set_name__(owner: Function, name: string): void {
    this.publicName = name;
  }

  /**
   * The instance override for this field (Python `obj.__dict__[name]`):
   * `null` when there is none. Overrides are stored by `__set__` (and the
   * parser's fallback kwargs) from values of the field's own type.
   */
  _override(obj: O): { value: T } | null {
    const idict: Map<string, InstanceValue> = instanceDict(obj);
    if (!idict.has(this.publicName)) return null;
    const value = idict.get(this.publicName) ?? null;
    return this.accepts(value) ? { value } : null;
  }

  __get__(obj: O | null, objtype?: Function): T | this {
    if (obj == null) return this;
    // Instance-dict overrides (set by parser or user when no dict)
    const override = this._override(obj);
    if (override != null) return override.value;
    const d = obj[this.dictAttr];
    if (d == null) return this.default;
    return _extract(d, this.key, this.transform, this.default);
  }

  /**
   * Raise if this field cannot be written to `obj` - read-only, or
   * the file predates the field's `minVersion`.
   */
  _checkWritable(obj: O): void {
    if (this.readOnly) {
      throw new AttributeError(`${repr(this.publicName)} is read-only.`);
    }
    if (this.minVersion != null) {
      if (getAeVersionMajor(obj) < this.minVersion) {
        throw new AttributeError(`${repr(this.publicName)} requires AE ${this.minVersion}+ file format.`);
      }
    }
  }

  /**
   * Validate a non-`null` user value and reverse-transform it to
   * the form stored in the COS dict.
   */
  _coerce(obj: O, value: NonNullable<T>): CosNode {
    if (this.validate != null) this.validate(value, obj);
    // Every writable field declares its reverse; only read-only ones omit it.
    if (this.reverse == null) throw new AttributeError(`${repr(this.publicName)} is read-only.`);
    return this.reverse(value);
  }

  __set__(obj: O, value: T | null): void {
    this._checkWritable(obj);
    // Clear any instance-dict override
    instanceDict(obj).delete(this.publicName);
    const d = obj[this.dictAttr];
    if (d == null) {
      // No backing dict - store as instance override
      instanceDict(obj).set(this.publicName, value);
      return;
    }
    // `None` clears the key (an optional field is being unset); there is
    // no value to validate in that case.
    if (value == null) {
      d.delete(this.key);
    } else {
      d.set(this.key, this._coerce(obj, value));
    }
    obj._propagateCos?.();
  }
}

/**
 * The options a `CosField` factory leaves to its caller. `default` is
 * required: it decides whether the field can read `null` (an instance
 * override of `null` is only accepted back when the default is `null`).
 */
export type CosFieldExtras<D extends InstanceValue, O> = Partial<Pick<CosFieldOptions<D, O>, "readOnly" | "validate" | "minVersion">> & {
  default: D;
};

/** Options of a boolean flag field: `transform=bool`, `reverse=bool`. */
export function boolField<D extends boolean | null, O>(kw: CosFieldExtras<D, O>): CosFieldOptions<boolean | D, O> {
  return { transform: pyBool, reverse: pyBool, accepts: (v): v is boolean | D => (v === null ? kw.default === null : typeof v === "boolean"), ...kw };
}

/**
 * Options of a float field, coerced to float in both directions.
 *
 * The write-side coercion matters for byte fidelity: AE stores these keys
 * as floats, and an `int` passed by a caller would serialize without the
 * decimal marker. The stored value is a Python float, so it is boxed to
 * keep `1.0` from serializing as `1`.
 */
export function floatField<D extends number | null, O>(kw: CosFieldExtras<D, O>): CosFieldOptions<number | D, O> {
  return {
    transform: cosFloat,
    reverse: (x: number) => pyfloat(x),
    accepts: (v): v is number | D => (v === null ? kw.default === null : typeof v === "number"),
    ...kw,
  };
}

/**
 * Options of an integer-stored field: `int` on read, rounded to the
 * nearest integer on write. AE stores these keys as integers; a
 * real-typed value is misread at 16.16 scale (stored `50.0` read back as
 * `3276800`, probed AE 2026), so the write-side coercion matters for
 * fidelity.
 */
export function intField<D extends number | null, O>(kw: CosFieldExtras<D, O>): CosFieldOptions<number | D, O> {
  return {
    transform: cosInt,
    reverse: (x: number) => round(x),
    accepts: (v): v is number | D => (v === null ? kw.default === null : typeof v === "number"),
    ...kw,
  };
}

/**
 * Options of an IntEnum-backed field: `fromBinary` on read (Python's
 * `raw + offset`, so a non-number raises `TypeError`), `toBinary` on
 * write.
 */
export function enumField<V extends number, D extends V | null, O>(E: CosEnum<V>, kw: CosFieldExtras<D, O>): CosFieldOptions<V | D, O> {
  return {
    transform: (x: CosNode) => enumFromCos(E, x),
    reverse: (v: V) => E.toBinary(v),
    accepts: (v): v is V | D => (v === null ? kw.default === null : E.has(v)),
    ...kw,
  };
}
