/**
 * Reusable validator factories for descriptor fields.
 *
 * Each factory returns a callable `(value, instance) -> None` that raises
 * `ValueError` or `TypeError` when the value is invalid.  Pass the
 * returned callable as the `validate` parameter of a descriptor.
 *
 * The `instance` argument is the model object being modified, allowing
 * cross-field validation (e.g. checking that one field is \>= another).
 */

import type { EnumHelpers } from "../../pyrt/enum.ts";
import { FLOAT32_MAX } from "../binary/bin_utils.ts";
import { AE_VERSION_RE, FORMAT_VERSIONS } from "../binary/item_chunks.ts";
import {
  Path,
  ValueError,
  encode,
  floatRepr,
  literal,
  FileExistsError,
  typeName,
} from "../../pyrt/index.ts";

/**
 * `validator(value, instance=None)`: raises on an invalid `value`. `value` is
 * whatever the caller assigned, so it is checked at runtime; `instance` is not
 * read.
 */
export type Validator = (value: unknown, instance?: unknown) => void;
/** A validator whose bounds are computed from the model `instance` being written. */
export type InstanceValidator<O> = (value: unknown, instance: O) => void;
/** A bound: a number, or computed from the model instance being validated. */
export type NumBound<O> = number | ((instance: O) => number | null) | null;
/** Keyword arguments of `_validateNumber`; a callable bound reads the model instance `O`. */
export type NumberKw<O> = { min?: NumBound<O>; max?: NumBound<O>; integer?: boolean; exclusiveMin?: boolean };
/** Keyword arguments of `validateSequence`. */
export type SequenceKw<O> = NumberKw<O> & { length?: NumBound<O> };
type StaticNumberKw = { min?: number | null; max?: number | null; integer?: boolean; exclusiveMin?: boolean };
type StaticSequenceKw = StaticNumberKw & { length?: number | null };

/**
 * Return a validator that checks a numeric value.
 *
 * @param kw - Keyword arguments:
 * - `min`: Minimum allowed value. May be a static number or a callable `(instance) -> float` for
 *     dynamic bounds. Inclusive unless `exclusiveMin` is set.
 * - `max`: Maximum allowed value (inclusive). May be a static number or a callable
 *     `(instance) -> float` for dynamic bounds.
 * - `integer`: When `true`, reject non-`int` values.
 * - `exclusiveMin`: When `true`, the value must be strictly greater than `min` (e.g. a
 *     positive-but-non-zero size).
 */
// NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); error messages print whole-number bounds without Python's trailing ".0".
export function _validateNumber(kw?: StaticNumberKw): Validator;
export function _validateNumber<O>(kw: NumberKw<O>): InstanceValidator<O>;
export function _validateNumber<O>(kw: NumberKw<O | null> = {}): InstanceValidator<O> {
  const { min: min_ = null, max: max_ = null, integer = false, exclusiveMin = false } = kw;
  const typeLabel = integer ? "an integer" : "a number";

  return function _validator(value: unknown, instance: O | null = null): void {
    if (Array.isArray(value)) {
      throw new TypeError(`expected ${typeLabel}, got ${typeName(value)}`);
    }
    if (integer && (!(typeof value === "number" && Number.isInteger(value)) || typeof value === "boolean")) {
      // `bool` subclasses `int`, so an isinstance check alone lets
      // `skip_frames = True` through as 1. AE rejects it outright
      // ("true is not an unsigned integer"), and so does every other
      // place in this codebase that had to hand-roll the same guard.
      // Not `type(value) is not int`: that would also reject IntEnum
      // members and numpy integers.
      // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); a float such as 2.0 is accepted here where Python rejects it.
      throw new TypeError(`expected ${typeLabel}, got ${typeName(value)}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      // NaN/inf would pass any `value < min or value > max` check (those
      // comparisons are always False for NaN) and serialize as a corrupt
      // IEEE special into a float32 field that AE may reject.
      throw new ValueError(`must be a finite number, got ${floatRepr(value)}`);
    }
    const lo = typeof min_ === "function" ? min_(instance) : min_;
    const hi = typeof max_ === "function" ? max_(instance) : max_;
    if (lo == null && hi == null) {
      // Unbounded fields accept non-numeric values: complex property
      // values (Gradient, Shape, ...) flow through this validator
      // with dynamic bounds that resolve to None.
      return;
    }
    // NOTE(port): Python `isinstance(value, (int, float))` also admits bool; mirrored here.
    if (!(typeof value === "number" || typeof value === "boolean")) {
      throw new TypeError(`expected ${typeLabel}, got ${typeName(value)}`);
    }
    // A bool compares as its int value, as in Python.
    const num = Number(value);
    if (lo != null) {
      if (exclusiveMin && num <= lo) throw new ValueError(`must be > ${String(lo)}, got ${String(value)}`);
      if (!exclusiveMin && num < lo) throw new ValueError(`must be >= ${String(lo)}, got ${String(value)}`);
    }
    if (hi != null && num > hi) throw new ValueError(`must be <= ${String(hi)}, got ${String(value)}`);
  };
}

/**
 * Return a validator that checks a fixed-length numeric sequence.
 *
 * @param kw - Keyword arguments:
 * - `length`: Required number of elements. When `null`, any length is accepted. May be a callable
 *     `(instance) -> int` for dynamic bounds.
 * - `min`: Minimum allowed value per element. May be a static number or a callable
 *     `(instance) -> float` for dynamic bounds. Inclusive unless `exclusiveMin` is set.
 * - `max`: Maximum allowed value per element (inclusive). May be a static number or a callable
 *     `(instance) -> float` for dynamic bounds.
 * - `integer`: When `true`, reject non-`int` elements.
 * - `exclusiveMin`: When `true`, each element must be strictly greater than `min` (e.g. a
 *     non-zero-area box size).
 */
export function validateSequence(kw?: StaticSequenceKw): Validator;
export function validateSequence<O>(kw: SequenceKw<O>): InstanceValidator<O>;
export function validateSequence<O>(kw: SequenceKw<O | null> = {}): InstanceValidator<O> {
  const { length = null, min: min_ = null, max: max_ = null, integer = false, exclusiveMin = false } = kw;
  const typeLabel = integer ? "an integer" : "a number";
  const _elementValidator = _validateNumber({ min: min_, max: max_, integer, exclusiveMin });

  return function _validator(value: unknown, instance: O | null = null): void {
    const n = typeof length === "function" ? length(instance) : length;
    if (!Array.isArray(value)) {
      throw new TypeError(`expected a sequence${n != null ? ` of ${n} elements` : ""}`);
    }
    const items = [...value];
    if (n != null && items.length !== n) {
      throw new ValueError(`expected ${n} elements, got ${items.length}`);
    }
    for (const [i, v] of items.entries()) {
      // Elements are numeric whatever the bounds are. `_validateNumber`
      // skips its own type check once both bounds resolve to None, an
      // exemption for unbounded SCALAR fields carrying complex values
      // (Gradient, Shape, ...) - never for a member of a fixed-length
      // numeric sequence, which would otherwise accept a string here.
      if (!(typeof v === "number" || typeof v === "boolean")) {
        throw new TypeError(`element [${i}] expected ${typeLabel}, got ${typeName(v)}`);
      }
      try {
        _elementValidator(v, instance);
      } catch (exc) {
        if (!(exc instanceof TypeError || exc instanceof ValueError)) throw exc;
        // `raise type(exc)(...) from None`: same exception class, no chained cause.
        throw new (exc.constructor as new (message: string) => Error)(`element [${i}] ${exc.message}`);
      }
    }
  };
}

/** One shared validator per enum class. Enum validators are factory-built
 * closures (unlike the module-level singleton validators), so callers that
 * default their enum validator - e.g. `RangeField.enum` and
 * `DocumentWideCosField.enum` for the same field - would otherwise hold
 * distinct instances; memoizing keeps them identity-equal.
 */
export const _ENUM_VALIDATORS = new Map<EnumHelpers<number>, Validator>();

/**
 * Return a validator that checks value is a member of `enumCls`.
 *
 * Accepts both enum instances and their int equivalents. An int that is
 * not a valid member value raises `ValueError`; any other wrong type
 * raises `TypeError`. The returned validator is memoized per `enumCls`.
 *
 * @param enumCls - The enum class the value must be a member of.
 */
export function validateEnum(enumCls: EnumHelpers<number>): Validator {
  const cached = _ENUM_VALIDATORS.get(enumCls) ?? null;
  if (cached != null) return cached;

  const _validator = function (value: unknown, instance: unknown = null): void {
    // NOTE(port): enum members are plain numbers, so `has` also accepts member ints; Python's int branch accepts those too (enum_cls(value) succeeds), so outcomes match.
    if (enumCls.has(value)) return;
    // Before the int branch: `bool` subclasses `int`, so `om.format =
    // True` would otherwise silently select the member whose value is 1.
    if (typeof value === "boolean") {
      throw new TypeError(`expected a ${enumCls.enumName}, got ${typeName(value)}`);
    }
    if (typeof value === "number" && Number.isInteger(value)) {
      if (enumCls.ofOrNull(value) === null) {
        throw new ValueError(`${literal(value)} is not a valid ${enumCls.enumName} value`);
      }
      return;
    }
    throw new TypeError(`expected a ${enumCls.enumName}, got ${typeName(value)}`);
  };

  _ENUM_VALIDATORS.set(enumCls, _validator);
  return _validator;
}

/**
 * Return a validator that checks value is in the allowed set.
 *
 * @param allowed - Iterable of valid values.
 */
export function validateOneOf<T>(allowed: Iterable<T>): Validator {
  const allowedList = [...allowed];
  const allowedSet = new Set<unknown>(allowedList);
  const formatted = allowedList.map((v) => String(v)).join(", ");

  return function _validator(value: unknown, instance: unknown = null): void {
    if (!allowedSet.has(value instanceof String ? String(value) : value)) {
      throw new ValueError(`must be one of [${formatted}], got ${literal(value)}`);
    }
  };
}

/** The After Effects platforms py_aep writes footage for (see `py_aep.parse`). */
export const validatePlatform = validateOneOf(["windows", "macos"]);

/**
 * Return a validator that checks a string value.
 *
 * @param kw - Keyword arguments:
 * - `allowEmpty`: When `false`, reject empty strings.
 * - `maxLength`: Maximum allowed character count.
 * - `maxBytes`: Maximum allowed UTF-8 byte count, for a value stored in a fixed-width chunk field
 *     (where `struct.pack` would otherwise truncate silently, mid-character for multi-byte text).
 * - `allowNull`: When `false`, reject strings containing a NUL (`\x00`) character, which corrupt
 *     the COS/text blobs AE reads.
 */
export function _validateStr(
  kw: { allowEmpty?: boolean; maxLength?: number | null; maxBytes?: number | null; allowNull?: boolean } = {},
): Validator {
  const { allowEmpty = true, maxLength = null, maxBytes = null, allowNull = true } = kw;

  return function _validator(value: unknown, instance: unknown = null): void {
    // `_NulTailStr` (a `str` subclass) arrives as a String object.
    if (!(typeof value === "string" || value instanceof String)) {
      throw new TypeError(`expected a string, got ${typeName(value)}`);
    }
    const text = String(value);
    if (!allowEmpty && !text) throw new ValueError("must not be empty");
    if (!allowNull && text.includes("\x00")) throw new ValueError("must not contain null bytes");
    // NOTE(port): Python `len` counts code points; Array.from matches that for astral text.
    const nChars = Array.from(text).length;
    if (maxLength != null && nChars > maxLength) {
      throw new ValueError(`must be at most ${maxLength} characters, got ${nChars}`);
    }
    if (maxBytes != null) {
      const encoded = encode(text, "utf-8").length;
      if (encoded > maxBytes) {
        throw new ValueError(`must be at most ${maxBytes} UTF-8 bytes, got ${encoded}`);
      }
    }
  };
}

/**
 * Return a validator that checks a filesystem path.
 *
 * @param kw - Keyword arguments:
 * - `mustExist`: When `true`, reject paths that don't exist (`ValueError`). When `false`, reject
 *     paths that do exist (`FileExistsError`). When `null`, allow both.
 * - `mustBeFile`: When `true`, also reject an existing path that is not a regular file. Without
 *     this a directory passes `mustExist` and only fails later, deep in a reader, as an
 *     OS-specific error (`PermissionError` on Windows, `IsADirectoryError` elsewhere).
 */
export function _validatePath(
  kw: { mustExist?: boolean | null; mustBeFile?: boolean } = {},
): Validator {
  const { mustExist = null, mustBeFile = false } = kw;

  return function _validator(value: unknown, instance: unknown = null): void {
    if (!(typeof value === "string" || value instanceof String || value instanceof Path)) {
      throw new TypeError(`expected a file system path, got ${typeName(value)}`);
    }
    const path = new Path(String(value));
    if (mustExist === true) {
      if (!path.exists()) throw new ValueError(`path does not exist: ${path}`);
      if (mustBeFile && !path.isFile()) throw new ValueError(`path is not a file: ${path}`);
    } else if (mustExist === false) {
      if (path.exists()) throw new FileExistsError(`path already exists: ${path}`);
    }
    // must_exist is None: accept both existing and non-existing paths
  };
}

/** Validate that a value is a `bool` (rejects 0/1 integers). */
export function validateBool(value: unknown, instance: unknown = null): void {
  if (typeof value !== "boolean") {
    throw new TypeError(`expected a bool, got ${typeName(value)}`);
  }
}

// ---- Shared domain validators ----
// Re-use these across models instead of defining per-module duplicates.

export const validateNumber = _validateNumber();

export const validatePositiveNumber = _validateNumber({ min: 0.0 });

export const validateNormalizedFloat = _validateNumber({ min: 0.0, max: 1.0 });

export const validateInt = _validateNumber({ integer: true });

export const validatePositiveInt = _validateNumber({ min: 0, integer: true });

// A u1 field (e.g. the head chunk's 8-bit build number) holds 0..255.
export const validateU1 = _validateNumber({ min: 0, max: 0xff, integer: true });

// A u2 field (e.g. the Cineon highlight expansion) holds 0..65535.
export const validateU2 = _validateNumber({ min: 0, max: 0xffff, integer: true });

// A u4 field (e.g. a marker's frame_duration or the project revision counter)
// holds 0..4294967295.
export const validateU4 = _validateNumber({ min: 0, max: 0xffffffff, integer: true });

// A signed 32-bit metric (e.g. text kerning/tracking). AE 2026 reads values
// up to 2**31 fine but rejects the whole text layer for larger magnitudes
// ("Error reading the text layer", probed 2**31 OK / 10**10 fails); the s4
// range is the conservative bound that stays inside that limit. Not
// `integer=True`: kerning/tracking accept a float and round it on write.
export const validateS4 = _validateNumber({ min: -(2 ** 31), max: 2 ** 31 - 1 });

// Any finite double: a signed f8 field with no domain restriction of its own
// (e.g. a guide position, which may sit outside the composition). Bounding it
// by the field width rather than leaving it unbounded keeps the type check -
// a bare `validateNumber` deliberately lets non-numerics through for complex
// property values.
export const validateF8 = _validateNumber({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE });

// A marker duration in seconds maps to a u4 600ths-of-a-second field
// (round(seconds * 600)); cap at the field capacity and reject NaN/inf/negative.
export const validateMarkerDuration = _validateNumber({ min: 0.0, max: 0xffffffff / 600.0 });

export const validateFootageDimension = _validateNumber({ min: 4, max: 30000, integer: true });

export const validateSolidDimension = _validateNumber({ min: 1, max: 30000, integer: true });

export const validatePixelAspect = _validateNumber({ min: 0.01, max: 100.0 });

// Min is one frame at the maximum 99 fps: a composition / footage duration of
// exactly 0 has no frames and After Effects rejects it (ExtendScript raises).
export const validateDuration = _validateNumber({ min: 1.0 / 99.0, max: 10800.0 });

export const validateFrameRate = _validateNumber({ min: 1.0, max: 99.0 });

// A composition's frame rate: AE 2026's own range ("out of range 1 to 999"),
// for `addComp` and the `frameRate` setter alike.
export const validateCompFrameRate = _validateNumber({ min: 1.0, max: 999.0 });

// A composition's duration: at least one frame at the fastest composition
// rate (999 fps), at most AE's 10800 seconds.
export const validateCompDuration = _validateNumber({ min: 1.0 / 999.0, max: 10800.0 });

// 0 means "use the footage's own rate"; the upper bound is the `sspc` field's
// (a u2 of whole frames per second).
export const validateConformFrameRate = _validateNumber({ min: 0.0, max: 999.0 });

export const validateVector2 = validateSequence({ length: 2 });

export const validateVector3 = validateSequence({ length: 3 });

export const validateRgbColor = validateSequence({ length: 3, min: 0.0, max: 1.0 });

export const validateString = _validateStr();

export const validateName = _validateStr({ allowEmpty: false });

// A solid or placeholder name lives in a 256-byte NUL-padded UTF-8 field of the
// `opti` chunk, leaving 255 usable bytes. AE 2026 silently truncates a longer
// name to those same 255 bytes on assignment.
export const validateOptiName = _validateStr({ allowEmpty: false, maxBytes: 255 });

// Strictly positive (non-zero) size, e.g. font size or stroke width.
export const validatePositiveNonzeroNumber = _validateNumber({ min: 0.0, exclusiveMin: true });

// A font PostScript name must be a non-empty, NUL-free string.
export const validateFontName = _validateStr({ allowEmpty: false, allowNull: false });

// Text content may be empty but must not contain NUL bytes (they corrupt the
// COS text blob AE reads).
export const validateText = _validateStr({ allowNull: false });

// A box-text size needs a strictly positive width and height (a zero-area box
// has nothing to lay text into).
export const validateBoxSize = validateSequence({ length: 2, min: 0.0, exclusiveMin: true });

export const validatePath = _validatePath();

export const validatePathExists = _validatePath({ mustExist: true });

// For media paths: a directory must be refused here, not by the format reader.
export const validateFileExists = _validatePath({ mustExist: true, mustBeFile: true });

export const validatePathDoesNotExist = _validatePath({ mustExist: false });

// 3D renderer options validators
export const validateAdvancedQuality = _validateNumber({ min: 1, max: 125, integer: true });
export const validateShadowSmoothness = _validateNumber({ min: 1, max: 20, integer: true });
export const validateCastingBoxSize = _validateNumber({ min: 0, max: 30000 });
export const validateCastingBoxCenter = validateSequence({ length: 3, min: -30000, max: 30000 });
export const validateCinema4dQuality = _validateNumber({ min: 1, max: 99, integer: true });

// An `[x, y]` point stored as two float32 values (shape vertices / tangents,
// and the bounding box): a larger coordinate cannot be serialized.
// NOTE(port): Python reads FLOAT32_MAX at import too; bin_utils imports neither this module nor anything that does, so no cycle.
export const validateF4Point = validateSequence({ length: 2, min: -FLOAT32_MAX, max: FLOAT32_MAX });

/** Validate an After Effects version string, `"{major}.{minor}x{build}"`.
 *
 * The head chunk holds the major in 8 bits, the minor in 4 and the build
 * in 8.
 */
export function validateAeVersion(value: unknown, instance: unknown = null): void {
  if (!(typeof value === "string" || value instanceof String)) {
    throw new TypeError(`expected a version string, got ${typeName(value)}`);
  }
  const match = AE_VERSION_RE.exec(String(value));
  if (match == null) {
    throw new ValueError(
      "version must match '{major}.{minor}x{build}' " +
        `(e.g. '25.6x101'), got ${literal(value)}`,
    );
  }
  const [major, minor, build] = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (major > 0xff) throw new ValueError(`version major must be <= 255, got ${major}`);
  if (minor > 0x0f) throw new ValueError(`version minor must be <= 15, got ${minor}`);
  if (build > 0xff) throw new ValueError(`version build must be <= 255, got ${build}`);
}

/** Validate a version string (see `validateAeVersion`) whose major is a
 * release py_aep has a file-format stamp for (`FORMAT_VERSIONS`: AE 15-18
 * and 22-26, there was no AE 19-21), or a newer one.
 */
export function validateAeRelease(value: unknown, instance: unknown = null): void {
  validateAeVersion(value);
  const major = Number.parseInt(String(value).split(".")[0], 10);
  if (!FORMAT_VERSIONS.has(major) && major < Math.max(...[...FORMAT_VERSIONS.keys()])) {
    throw new ValueError(
      `After Effects ${major} is not a release py_aep writes; ` +
        `supported majors: ${String([...FORMAT_VERSIONS.keys()].sort((a, b) => a - b))} and later`,
    );
  }
}
