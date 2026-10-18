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
  TypeError_,
  ValueError,
  encode,
  float_repr,
  int,
  max,
  repr,
  sorted,
  split,
  str,
  FileExistsError,
  type_name,
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
/** Keyword arguments of `_validate_number`; a callable bound reads the model instance `O`. */
export type NumberKw<O> = { min?: NumBound<O>; max?: NumBound<O>; integer?: boolean; exclusive_min?: boolean };
/** Keyword arguments of `validate_sequence`. */
export type SequenceKw<O> = NumberKw<O> & { length?: NumBound<O> };
type StaticNumberKw = { min?: number | null; max?: number | null; integer?: boolean; exclusive_min?: boolean };
type StaticSequenceKw = StaticNumberKw & { length?: number | null };

/**
 * Return a validator that checks a numeric value.
 *
 * @param kw - Keyword arguments:
 * - `min`: Minimum allowed value. May be a static number or a callable `(instance) -> float` for
 *     dynamic bounds. Inclusive unless `exclusive_min` is set.
 * - `max`: Maximum allowed value (inclusive). May be a static number or a callable
 *     `(instance) -> float` for dynamic bounds.
 * - `integer`: When `true`, reject non-`int` values.
 * - `exclusive_min`: When `true`, the value must be strictly greater than `min` (e.g. a
 *     positive-but-non-zero size).
 */
// NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); error messages print whole-number bounds without Python's trailing ".0".
export function _validate_number(kw?: StaticNumberKw): Validator;
export function _validate_number<O>(kw: NumberKw<O>): InstanceValidator<O>;
export function _validate_number<O>(kw: NumberKw<O | null> = {}): InstanceValidator<O> {
  const { min: min_ = null, max: max_ = null, integer = false, exclusive_min = false } = kw;
  const type_label = integer ? "an integer" : "a number";

  return function _validator(value: unknown, instance: O | null = null): void {
    if (Array.isArray(value)) {
      throw new TypeError_(`expected ${type_label}, got ${type_name(value)}`);
    }
    if (integer && (!(typeof value === "number" && Number.isInteger(value)) || typeof value === "boolean")) {
      // `bool` subclasses `int`, so an isinstance check alone lets
      // `skip_frames = True` through as 1. AE rejects it outright
      // ("true is not an unsigned integer"), and so does every other
      // place in this codebase that had to hand-roll the same guard.
      // Not `type(value) is not int`: that would also reject IntEnum
      // members and numpy integers.
      // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); a float such as 2.0 is accepted here where Python rejects it.
      throw new TypeError_(`expected ${type_label}, got ${type_name(value)}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      // NaN/inf would pass any `value < min or value > max` check (those
      // comparisons are always False for NaN) and serialize as a corrupt
      // IEEE special into a float32 field that AE may reject.
      throw new ValueError(`must be a finite number, got ${float_repr(value)}`);
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
      throw new TypeError_(`expected ${type_label}, got ${type_name(value)}`);
    }
    // A bool compares as its int value, as in Python.
    const num = Number(value);
    if (lo != null) {
      if (exclusive_min && num <= lo) throw new ValueError(`must be > ${str(lo)}, got ${str(value)}`);
      if (!exclusive_min && num < lo) throw new ValueError(`must be >= ${str(lo)}, got ${str(value)}`);
    }
    if (hi != null && num > hi) throw new ValueError(`must be <= ${str(hi)}, got ${str(value)}`);
  };
}

/**
 * Return a validator that checks a fixed-length numeric sequence.
 *
 * @param kw - Keyword arguments:
 * - `length`: Required number of elements. When `null`, any length is accepted. May be a callable
 *     `(instance) -> int` for dynamic bounds.
 * - `min`: Minimum allowed value per element. May be a static number or a callable
 *     `(instance) -> float` for dynamic bounds. Inclusive unless `exclusive_min` is set.
 * - `max`: Maximum allowed value per element (inclusive). May be a static number or a callable
 *     `(instance) -> float` for dynamic bounds.
 * - `integer`: When `true`, reject non-`int` elements.
 * - `exclusive_min`: When `true`, each element must be strictly greater than `min` (e.g. a
 *     non-zero-area box size).
 */
export function validate_sequence(kw?: StaticSequenceKw): Validator;
export function validate_sequence<O>(kw: SequenceKw<O>): InstanceValidator<O>;
export function validate_sequence<O>(kw: SequenceKw<O | null> = {}): InstanceValidator<O> {
  const { length = null, min: min_ = null, max: max_ = null, integer = false, exclusive_min = false } = kw;
  const type_label = integer ? "an integer" : "a number";
  const _element_validator = _validate_number({ min: min_, max: max_, integer, exclusive_min });

  return function _validator(value: unknown, instance: O | null = null): void {
    const n = typeof length === "function" ? length(instance) : length;
    if (!Array.isArray(value)) {
      throw new TypeError_(`expected a sequence${n != null ? ` of ${n} elements` : ""}`);
    }
    const items = [...value];
    if (n != null && items.length !== n) {
      throw new ValueError(`expected ${n} elements, got ${items.length}`);
    }
    for (const [i, v] of items.entries()) {
      // Elements are numeric whatever the bounds are. `_validate_number`
      // skips its own type check once both bounds resolve to None, an
      // exemption for unbounded SCALAR fields carrying complex values
      // (Gradient, Shape, ...) - never for a member of a fixed-length
      // numeric sequence, which would otherwise accept a string here.
      if (!(typeof v === "number" || typeof v === "boolean")) {
        throw new TypeError_(`element [${i}] expected ${type_label}, got ${type_name(v)}`);
      }
      try {
        _element_validator(v, instance);
      } catch (exc) {
        if (!(exc instanceof TypeError_ || exc instanceof ValueError)) throw exc;
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
 * Return a validator that checks value is a member of `enum_cls`.
 *
 * Accepts both enum instances and their int equivalents. An int that is
 * not a valid member value raises `ValueError`; any other wrong type
 * raises `TypeError`. The returned validator is memoized per `enum_cls`.
 *
 * @param enum_cls - The enum class the value must be a member of.
 */
export function validate_enum(enum_cls: EnumHelpers<number>): Validator {
  const cached = _ENUM_VALIDATORS.get(enum_cls) ?? null;
  if (cached != null) return cached;

  const _validator = function (value: unknown, instance: unknown = null): void {
    // NOTE(port): enum members are plain numbers, so `has` also accepts member ints; Python's int branch accepts those too (enum_cls(value) succeeds), so outcomes match.
    if (enum_cls.has(value)) return;
    // Before the int branch: `bool` subclasses `int`, so `om.format =
    // True` would otherwise silently select the member whose value is 1.
    if (typeof value === "boolean") {
      throw new TypeError_(`expected a ${enum_cls.__name__}, got ${type_name(value)}`);
    }
    if (typeof value === "number" && Number.isInteger(value)) {
      if (enum_cls.of_or_null(value) === null) {
        throw new ValueError(`${repr(value)} is not a valid ${enum_cls.__name__} value`);
      }
      return;
    }
    throw new TypeError_(`expected a ${enum_cls.__name__}, got ${type_name(value)}`);
  };

  _ENUM_VALIDATORS.set(enum_cls, _validator);
  return _validator;
}

/**
 * Return a validator that checks value is in the allowed set.
 *
 * @param allowed - Iterable of valid values.
 */
export function validate_one_of<T>(allowed: Iterable<T>): Validator {
  const allowed_list = [...allowed];
  const allowed_set = new Set<unknown>(allowed_list);
  const formatted = allowed_list.map((v) => str(v)).join(", ");

  return function _validator(value: unknown, instance: unknown = null): void {
    if (!allowed_set.has(value instanceof String ? String(value) : value)) {
      throw new ValueError(`must be one of [${formatted}], got ${repr(value)}`);
    }
  };
}

/** The After Effects platforms py_aep writes footage for (see `py_aep.parse`). */
export const validate_platform = validate_one_of(["windows", "macos"]);

/**
 * Return a validator that checks a string value.
 *
 * @param kw - Keyword arguments:
 * - `allow_empty`: When `false`, reject empty strings.
 * - `max_length`: Maximum allowed character count.
 * - `max_bytes`: Maximum allowed UTF-8 byte count, for a value stored in a fixed-width chunk field
 *     (where `struct.pack` would otherwise truncate silently, mid-character for multi-byte text).
 * - `allow_null`: When `false`, reject strings containing a NUL (`\x00`) character, which corrupt
 *     the COS/text blobs AE reads.
 */
export function _validate_str(
  kw: { allow_empty?: boolean; max_length?: number | null; max_bytes?: number | null; allow_null?: boolean } = {},
): Validator {
  const { allow_empty = true, max_length = null, max_bytes = null, allow_null = true } = kw;

  return function _validator(value: unknown, instance: unknown = null): void {
    // `_NulTailStr` (a `str` subclass) arrives as a String object.
    if (!(typeof value === "string" || value instanceof String)) {
      throw new TypeError_(`expected a string, got ${type_name(value)}`);
    }
    const text = String(value);
    if (!allow_empty && !text) throw new ValueError("must not be empty");
    if (!allow_null && text.includes("\x00")) throw new ValueError("must not contain null bytes");
    // NOTE(port): Python `len` counts code points; Array.from matches that for astral text.
    const n_chars = Array.from(text).length;
    if (max_length != null && n_chars > max_length) {
      throw new ValueError(`must be at most ${max_length} characters, got ${n_chars}`);
    }
    if (max_bytes != null) {
      const encoded = encode(text, "utf-8").length;
      if (encoded > max_bytes) {
        throw new ValueError(`must be at most ${max_bytes} UTF-8 bytes, got ${encoded}`);
      }
    }
  };
}

/**
 * Return a validator that checks a filesystem path.
 *
 * @param kw - Keyword arguments:
 * - `must_exist`: When `true`, reject paths that don't exist (`ValueError`). When `false`, reject
 *     paths that do exist (`FileExistsError`). When `null`, allow both.
 * - `must_be_file`: When `true`, also reject an existing path that is not a regular file. Without
 *     this a directory passes `must_exist` and only fails later, deep in a reader, as an
 *     OS-specific error (`PermissionError` on Windows, `IsADirectoryError` elsewhere).
 */
export function _validate_path(
  kw: { must_exist?: boolean | null; must_be_file?: boolean } = {},
): Validator {
  const { must_exist = null, must_be_file = false } = kw;

  return function _validator(value: unknown, instance: unknown = null): void {
    if (!(typeof value === "string" || value instanceof String || value instanceof Path)) {
      throw new TypeError_(`expected a file system path, got ${type_name(value)}`);
    }
    const path = new Path(String(value));
    if (must_exist === true) {
      if (!path.exists()) throw new ValueError(`path does not exist: ${path}`);
      if (must_be_file && !path.is_file()) throw new ValueError(`path is not a file: ${path}`);
    } else if (must_exist === false) {
      if (path.exists()) throw new FileExistsError(`path already exists: ${path}`);
    }
    // must_exist is None: accept both existing and non-existing paths
  };
}

/** Validate that a value is a `bool` (rejects 0/1 integers). */
export function validate_bool(value: unknown, instance: unknown = null): void {
  if (typeof value !== "boolean") {
    throw new TypeError_(`expected a bool, got ${type_name(value)}`);
  }
}

// ---- Shared domain validators ----
// Re-use these across models instead of defining per-module duplicates.

export const validate_number = _validate_number();

export const validate_positive_number = _validate_number({ min: 0.0 });

export const validate_normalized_float = _validate_number({ min: 0.0, max: 1.0 });

export const validate_int = _validate_number({ integer: true });

export const validate_positive_int = _validate_number({ min: 0, integer: true });

// A u1 field (e.g. the head chunk's 8-bit build number) holds 0..255.
export const validate_u1 = _validate_number({ min: 0, max: 0xff, integer: true });

// A u2 field (e.g. the Cineon highlight expansion) holds 0..65535.
export const validate_u2 = _validate_number({ min: 0, max: 0xffff, integer: true });

// A u4 field (e.g. a marker's frame_duration or the project revision counter)
// holds 0..4294967295.
export const validate_u4 = _validate_number({ min: 0, max: 0xffffffff, integer: true });

// A signed 32-bit metric (e.g. text kerning/tracking). AE 2026 reads values
// up to 2**31 fine but rejects the whole text layer for larger magnitudes
// ("Error reading the text layer", probed 2**31 OK / 10**10 fails); the s4
// range is the conservative bound that stays inside that limit. Not
// `integer=True`: kerning/tracking accept a float and round it on write.
export const validate_s4 = _validate_number({ min: -(2 ** 31), max: 2 ** 31 - 1 });

// Any finite double: a signed f8 field with no domain restriction of its own
// (e.g. a guide position, which may sit outside the composition). Bounding it
// by the field width rather than leaving it unbounded keeps the type check -
// a bare `validate_number` deliberately lets non-numerics through for complex
// property values.
export const validate_f8 = _validate_number({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE });

// A marker duration in seconds maps to a u4 600ths-of-a-second field
// (round(seconds * 600)); cap at the field capacity and reject NaN/inf/negative.
export const validate_marker_duration = _validate_number({ min: 0.0, max: 0xffffffff / 600.0 });

export const validate_footage_dimension = _validate_number({ min: 4, max: 30000, integer: true });

export const validate_solid_dimension = _validate_number({ min: 1, max: 30000, integer: true });

export const validate_pixel_aspect = _validate_number({ min: 0.01, max: 100.0 });

// Min is one frame at the maximum 99 fps: a composition / footage duration of
// exactly 0 has no frames and After Effects rejects it (ExtendScript raises).
export const validate_duration = _validate_number({ min: 1.0 / 99.0, max: 10800.0 });

export const validate_frame_rate = _validate_number({ min: 1.0, max: 99.0 });

// A composition's frame rate: AE 2026's own range ("out of range 1 to 999"),
// for `addComp` and the `frameRate` setter alike.
export const validate_comp_frame_rate = _validate_number({ min: 1.0, max: 999.0 });

// A composition's duration: at least one frame at the fastest composition
// rate (999 fps), at most AE's 10800 seconds.
export const validate_comp_duration = _validate_number({ min: 1.0 / 999.0, max: 10800.0 });

// 0 means "use the footage's own rate"; the upper bound is the `sspc` field's
// (a u2 of whole frames per second).
export const validate_conform_frame_rate = _validate_number({ min: 0.0, max: 999.0 });

export const validate_vector2 = validate_sequence({ length: 2 });

export const validate_vector3 = validate_sequence({ length: 3 });

export const validate_rgb_color = validate_sequence({ length: 3, min: 0.0, max: 1.0 });

export const validate_string = _validate_str();

export const validate_name = _validate_str({ allow_empty: false });

// A solid or placeholder name lives in a 256-byte NUL-padded UTF-8 field of the
// `opti` chunk, leaving 255 usable bytes. AE 2026 silently truncates a longer
// name to those same 255 bytes on assignment.
export const validate_opti_name = _validate_str({ allow_empty: false, max_bytes: 255 });

// Strictly positive (non-zero) size, e.g. font size or stroke width.
export const validate_positive_nonzero_number = _validate_number({ min: 0.0, exclusive_min: true });

// A font PostScript name must be a non-empty, NUL-free string.
export const validate_font_name = _validate_str({ allow_empty: false, allow_null: false });

// Text content may be empty but must not contain NUL bytes (they corrupt the
// COS text blob AE reads).
export const validate_text = _validate_str({ allow_null: false });

// A box-text size needs a strictly positive width and height (a zero-area box
// has nothing to lay text into).
export const validate_box_size = validate_sequence({ length: 2, min: 0.0, exclusive_min: true });

export const validate_path = _validate_path();

export const validate_path_exists = _validate_path({ must_exist: true });

// For media paths: a directory must be refused here, not by the format reader.
export const validate_file_exists = _validate_path({ must_exist: true, must_be_file: true });

export const validate_path_does_not_exist = _validate_path({ must_exist: false });

// 3D renderer options validators
export const validate_advanced_quality = _validate_number({ min: 1, max: 125, integer: true });
export const validate_shadow_smoothness = _validate_number({ min: 1, max: 20, integer: true });
export const validate_casting_box_size = _validate_number({ min: 0, max: 30000 });
export const validate_casting_box_center = validate_sequence({ length: 3, min: -30000, max: 30000 });
export const validate_cinema_4d_quality = _validate_number({ min: 1, max: 99, integer: true });

// An `[x, y]` point stored as two float32 values (shape vertices / tangents,
// and the bounding box): a larger coordinate cannot be serialized.
// NOTE(port): Python reads FLOAT32_MAX at import too; bin_utils imports neither this module nor anything that does, so no cycle.
export const validate_f4_point = validate_sequence({ length: 2, min: -FLOAT32_MAX, max: FLOAT32_MAX });

/** Validate an After Effects version string, `"{major}.{minor}x{build}"`.
 *
 * The head chunk holds the major in 8 bits, the minor in 4 and the build
 * in 8.
 */
export function validate_ae_version(value: unknown, instance: unknown = null): void {
  if (!(typeof value === "string" || value instanceof String)) {
    throw new TypeError_(`expected a version string, got ${type_name(value)}`);
  }
  const match = AE_VERSION_RE.exec(String(value));
  if (match == null) {
    throw new ValueError(
      "version must match '{major}.{minor}x{build}' " +
        `(e.g. '25.6x101'), got ${repr(value)}`,
    );
  }
  const [major, minor, build] = match.slice(1).map((part) => int(part));
  if (major > 0xff) throw new ValueError(`version major must be <= 255, got ${major}`);
  if (minor > 0x0f) throw new ValueError(`version minor must be <= 15, got ${minor}`);
  if (build > 0xff) throw new ValueError(`version build must be <= 255, got ${build}`);
}

/** Validate a version string (see `validate_ae_version`) whose major is a
 * release py_aep has a file-format stamp for (`FORMAT_VERSIONS`: AE 15-18
 * and 22-26, there was no AE 19-21), or a newer one.
 */
export function validate_ae_release(value: unknown, instance: unknown = null): void {
  validate_ae_version(value);
  const major = int(split(str(value), ".", 1)[0]);
  if (!FORMAT_VERSIONS.has(major) && major < max([...FORMAT_VERSIONS.keys()])) {
    throw new ValueError(
      `After Effects ${major} is not a release py_aep writes; ` +
        `supported majors: ${str(sorted([...FORMAT_VERSIONS.keys()]))} and later`,
    );
  }
}
