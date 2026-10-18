/**
 * Settings-view infrastructure for render queue settings.
 *
 * `SettingsView` provides a thin `MutableMapping` wrapper that proxies
 * attribute access on the owner class: each ExtendScript key maps to a
 * model attribute (either a ChunkField descriptor or a `@property`).
 */

import { INSPECT, describe } from "../../../pyrt/index.ts";
import {
  AttributeError,
  KeyError,
  ValueError,
  getattr,
  int,
  valueEquals,
  literal,
  setattr,
  sorted,
  str,
  tkey,
  mappingItems,
  typeName,
} from "../../../pyrt/index.ts";
import type { EnumHelpers } from "../../../pyrt/enum.ts";
import type { CompPreset } from "../../parsers/comp_presets.ts";
import type { Preferences } from "../preferences.ts";


// NOTE(port): py_enum members are plain numbers with no owning class, so
// `isinstance(value, IntEnum)` is unanswerable. NUMBER output is unaffected
// (`int(member)` is the member itself); STRING output gets the label from the
// spec's enum class in `settingsToString` instead.
export const IntEnum = {
  has(_value: SettingValue): _value is number {
    return false;
  },
};

// Python `member.label` property; the enum objects expose it as `E.label(member)`.
/** An `intEnum` class that also defines a `label(member)` method. */
export type LabeledEnum = EnumHelpers<number> & { label(member: number): string };

export function enumLabel(enumClass: LabeledEnum, member: number): string {
  return enumClass.label(member);
}

/** Type alias for a settings spec: (attribute_name, optional_enum_class). */
export type SettingsSpec = Map<string, [string, LabeledEnum | null]>;

/**
 * A settings value: what a settings attribute reads as (an enum member or
 * other number, a boolean, a time in seconds, a `[width, height]`-style
 * list, the "Output File Info" map), or its STRING-format rendering.
 */
export type SettingValue = number | boolean | string | number[] | Map<string, string>;

/**
 * The value type of each key of a settings view. A view's own value map
 * intersects this with its per-key types: a key it declares reads as
 * that type, every other key as a {@link SettingValue}.
 */
export type SettingValues = Record<string, SettingValue>;

/**
 * Map-like view mapping ExtendScript setting keys to model attributes.
 *
 * Every read delegates to `getattr(owner, attr_name)` and every write
 * delegates to `setattr(owner, attr_name, value)`. Validation is handled by
 * the underlying ChunkField descriptors or `@property` setters.
 *
 * When `enumClass` is provided for a key, `__setitem__` coerces
 * the value (int, string label, or enum member) before passing it
 * to the descriptor.
 */
export class SettingsView<V extends SettingValues = SettingValues> {
  declare _owner: object;
  declare _specs: SettingsSpec;

  constructor(owner: object | null, specs: SettingsSpec) {
    this._owner = owner ?? this;
    this._specs = specs;
  }

  // -- reads -------------------------------------------------------------

  get<K extends string>(key: K): V[K] {
    const spec = this._specs.get(key) ?? null;
    if (spec == null) throw new KeyError(literal(key));
    const [attrName] = spec;
    return getattr(this._owner, attrName);
  }

  // -- writes ------------------------------------------------------------

  set(key: string, value: SettingValue | null): void {
    const spec = this._specs.get(key) ?? null;
    if (spec == null) {
      const valid = sorted(this._specs.keys());
      throw new KeyError(`Unknown setting ${literal(key)}. Valid keys: ${literal(valid)}`);
    }
    const [attrName, enumClass] = spec;
    if (enumClass != null) value = _coerceEnum(enumClass, value);
    try {
      setattr(this._owner, attrName, value);
    } catch (e) {
      // A getter-only JS accessor throws a native TypeError in strict mode;
      // Python's property without a setter raises AttributeError.
      const nativeReadonly =
        e instanceof Error &&
        e.constructor === TypeError &&
        /readonly property|only a getter|read-only/i.test(e.message);
      if (!(e instanceof AttributeError) && !nativeReadonly) throw e;
      throw new AttributeError(`Setting ${literal(key)} is read-only.`);
    }
  }

  delete(key: string): void {
    throw new TypeError("Cannot delete settings keys");
  }

  // -- iteration ---------------------------------------------------------

  [Symbol.iterator](): Iterator<string> {
    return this._specs.keys();
  }

  get size(): number {
    return this._specs.size;
  }

  has(key: unknown): boolean {
    return typeof key === "string" && this._specs.has(key);
  }

  // -- MutableMapping mixin methods (inherited in Python) -----------------

  keys(): string[] {
    return [...this._specs.keys()];
  }

  items(): Array<[string, SettingValue]> {
    return [...this._specs.keys()].map((key): [string, SettingValue] => [key, this.get(key)]);
  }

  values(): SettingValue[] {
    return this.items().map(([, v]) => v);
  }

  getOr(key: string): SettingValue | null;
  getOr<D>(key: string, default_: D): SettingValue | D;
  getOr<D>(key: string, default_: D | null = null): SettingValue | D | null {
    try {
      return this.get(key);
    } catch (e) {
      if (!(e instanceof KeyError)) throw e;
      return default_;
    }
  }

  update(
    other: Map<string, SettingValue> | SettingsView<SettingValues> | Iterable<[string, SettingValue]> = [],
    kwargs: Record<string, SettingValue> = {},
  ): void {
    if (other instanceof Map || other instanceof SettingsView) {
      for (const [k, v] of other instanceof Map ? [...other.entries()] : other.items()) this.set(k, v);
    } else {
      for (const [k, v] of other) this.set(k, v);
    }
    for (const [k, v] of Object.entries(kwargs)) this.set(k, v);
  }

  setdefault(key: string): SettingValue | null;
  setdefault<D extends SettingValue>(key: string, default_: D): SettingValue | D;
  setdefault<D extends SettingValue>(key: string, default_: D | null = null): SettingValue | D | null {
    try {
      return this.get(key);
    } catch (e) {
      if (!(e instanceof KeyError)) throw e;
      this.set(key, default_);
      return default_;
    }
  }

  pop(key: string): SettingValue;
  pop<D>(key: string, default_: D): SettingValue | D;
  pop<D>(key: string, ...default_: [D?]): SettingValue | D | undefined {
    let value: SettingValue;
    try {
      value = this.get(key);
    } catch (e) {
      if (!(e instanceof KeyError)) throw e;
      if (default_.length) return default_[0];
      throw e;
    }
    this.delete(key);
    return value;
  }

  popitem(): [string, SettingValue] {
    const it = this._specs.keys().next();
    if (it.done) throw new KeyError("");
    const key = it.value;
    const value = this.get(key);
    this.delete(key);
    return [key, value];
  }

  clear(): void {
    // NOTE(port): same as MutableMapping.clear(): popitem() until KeyError; popitem raises TypeError here (delete unsupported), as in Python.
    for (;;) {
      try {
        this.popitem();
      } catch (e) {
        if (e instanceof KeyError) return;
        throw e;
      }
    }
  }

  [INSPECT](): string {
    return describe("SettingsView", Object.fromEntries(this.items()));
  }

  equals(other: unknown): boolean {
    if (other instanceof Map || other instanceof SettingsView) {
      return valueEquals(new Map(this.items()), new Map(mappingItems(other)));
    }
    // NOTE(port): Python returns NotImplemented; no builtin reflected __eq__ ever answers True for a non-mapping, so the final `==` is False.
    return false;
  }
}

/**
 * Coerce a value to an enum member.
 *
 * Accepts:
 *     - An enum member of the correct type
 *     - An int matching an enum member's value
 *     - A string matching an enum member's label
 */
export function _coerceEnum(enumClass: LabeledEnum, value: SettingValue | null): number {
  if (enumClass.has(value)) return value;
  if (typeof value === "boolean") {
    // bool is int: settings["Output Audio"] = True would silently
    // coerce to OutputAudio.OFF (== 1). Reject rather than surprise.
    throw new TypeError(`Expected ${enumClass.__name__}, int, or str, got bool`);
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    const member = enumClass.ofOrNull(value);
    if (member === null) {
      const members = enumClass
        .members()
        .map((m) => `${enumClass.nameOf(m)} (${int(m)})`)
        .join(", ");
      throw new ValueError(
        `Invalid int value ${literal(value)} for ${enumClass.__name__}. ` +
          `Valid members: ${members}`,
      );
    }
    return member;
  }
  if (typeof value === "string") {
    const byLabel = new Map<string, number>();
    for (const m of enumClass.members()) byLabel.set(enumLabel(enumClass, m), m);
    const member = byLabel.get(value);
    if (member !== undefined) return member;
    const labels = enumClass
      .members()
      .map((m) => literal(enumLabel(enumClass, m)))
      .join(", ");
    throw new ValueError(
      `Invalid string ${literal(value)} for ${enumClass.__name__}. ` +
        `Valid labels: ${labels}`,
    );
  }
  throw new TypeError(
    `Expected ${enumClass.__name__}, int, or str, got ${typeName(value)}`,
  );
}

export const _RESOLUTION_STRINGS: Map<string, string> = new Map<string, string>([
  // [0, 0] is the "use the comp's own resolution" sentinel (probed AE
  // 2026: getSettings(STRING) reads back "Current Settings").
  [tkey(0, 0), "Current Settings"],
  [tkey(1, 1), "Full"],
  [tkey(2, 2), "Half"],
  [tkey(3, 3), "Third"],
  [tkey(4, 4), "Quarter"],
]);

// AE's "Resize to" dropdown labels a target resolution with a New
// Composition preset name. When several presets share a resolution, AE
// picks the LOWEST frame rate (ties broken by the later preset) - probed
// in AE 2026 by reading OutputModule.getSetting("Resize to") for each
// collision resolution against the live comp presets. These labels are
// derived from the user's presets when a preferences directory is
// provided (see build_resize_to_strings); this table is the factory-
// preset fallback used when it is not, and holds AE's actual strings for
// a default install.
export const _RESIZE_TO_STRINGS: Map<string, string> = new Map<string, string>([
  [tkey(3656, 2664), "Cineon Full  •  3656x2664 • 24 fps"],
  [tkey(1828, 1332), "Cineon Half  •  1828x1332 • 24 fps"],
  [tkey(1280, 1080), "DVCPRO HD  •  1280x1080 (1.5) • 29.97 fps"],
  [tkey(1440, 1080), "DVCPRO HD  •  1440x1080 (1.33) • 25 fps"],
  [tkey(960, 720), "DVCPRO HD  •  960x720 (1.33) • 23.976 fps"],
  [tkey(2048, 1556), "Film (2K)  •  2048x1556 • 24 fps"],
  [tkey(4096, 3112), "Film (4K)  •  4096x3112 • 24 fps"],
  [tkey(1920, 1080), "HD  •  1920x1080 • 24 fps"],
  [tkey(1280, 720), "HDV/HDTV  •  1280x720 • 25 fps"],
  [tkey(720, 1280), "Social Media Portrait  •  720x1280 • 30 fps"],
  [tkey(1080, 1920), "Social Media Portrait HD  •  1080x1920 • 30 fps"],
  [tkey(1080, 1080), "Social Media Square  •  1080x1080 • 30 fps"],
  [tkey(3840, 2160), "UHD (4K)  •  3840x2160 • 23.976 fps"],
  [tkey(7680, 4320), "UHD (8K)  •  7680x4320 • 23.976 fps"],
]);

/**
 * Build the "Resize to" resolution -\> preset-name map from prefs.
 *
 * Mirrors AE's Resize dropdown: one label per resolution, choosing the
 * lowest-frame-rate New Composition preset at that resolution (ties
 * broken by the later preset). Falls back to {@link _RESIZE_TO_STRINGS} (AE's
 * factory-preset labels) when no preferences directory was provided.
 */
export function buildResizeToStrings(preferences: Preferences): Map<string, string> {
  const presets = preferences.compositionPresets();
  if (!presets?.length) return _RESIZE_TO_STRINGS;
  const best = new Map<string, CompPreset>();
  for (const preset of presets) {
    const key = tkey(preset.width, preset.height);
    const current = best.get(key);
    if (current == null || preset.frameRate <= current.frameRate) best.set(key, preset);
  }
  return new Map<string, string>([...best.entries()].map(([key, preset]) => [key, preset.name]));
}

/**
 * Convert a settings value to NUMBER format.
 *
 * IntEnum values are unwrapped to their integer value.
 * All other types pass through unchanged.
 */
export function _toNumberValue(value: SettingValue): SettingValue {
  if (IntEnum.has(value)) return int(value);
  return value;
}

/** `tuple(value)` as a dict key; a scalar raises what Python's `tuple()` raises. */
function _tupleKey(value: SettingValue): string {
  if (typeof value === "number" || typeof value === "boolean") {
    throw new TypeError(`'${typeName(value)}' object is not iterable`);
  }
  return tkey(...value);
}

/**
 * Convert a settings value to STRING format.
 *
 * @param key - The settings key name.
 * @param value - The settings value.
 * @param resizeMap - Resolution -\> label map for the "Resize to" key (the AE-preference-derived
 *   map, or the factory fallback).
 */
export function _toStringValue(
  key: string,
  value: string,
  resizeMap?: Map<string, string>,
  enumClass?: LabeledEnum | null,
): string;
export function _toStringValue(
  key: string,
  value: SettingValue,
  resizeMap?: Map<string, string>,
  enumClass?: LabeledEnum | null,
): string | Map<string, string>;
export function _toStringValue(
  key: string,
  value: SettingValue,
  resizeMap: Map<string, string> = _RESIZE_TO_STRINGS,
  enumClass: LabeledEnum | null = null,
): string | Map<string, string> {
  if (value instanceof Map) {
    // NOTE(port): Python annotates `-> str` and ignores the nested dict this branch returns.
    return new Map([...value.entries()].map(([k, v]): [string, string] => [k, _toStringValue(k, v, resizeMap)]));
  }
  // `isinstance(value, IntEnum)`: the spec's enum class stands in for the member's owning class.
  if (enumClass != null && enumClass.has(value)) return enumLabel(enumClass, value);
  if (key === "Resolution") return _RESOLUTION_STRINGS.get(_tupleKey(value)) ?? "Custom";
  if (key === "Resize to") return resizeMap.get(_tupleKey(value)) ?? "Custom";
  if (typeof value === "boolean") return str(value).toLowerCase();
  // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); a float getter value such as 30.0 (Time Span Duration, Use comp's frame rate) renders "30" here where Python gives "30.0" (returned string only, never saved).
  return str(value);
}

/** `settings.items()` of a dict or a settings view. */
function _settingItems(settings: Map<string, SettingValue> | SettingsView<SettingValues>): Array<[string, SettingValue]> {
  return settings instanceof Map ? [...settings.entries()] : settings.items();
}

/**
 * Convert settings to NUMBER format.
 *
 * IntEnum values are unwrapped to plain integers. Other values
 * (bool, float, int, array) pass through unchanged.
 *
 * @param settings - The typed settings map.
 */
export function settingsToNumber(settings: Map<string, SettingValue> | SettingsView<SettingValues>): Map<string, SettingValue> {
  return new Map<string, SettingValue>(
    _settingItems(settings).map(([k, v]): [string, SettingValue] => [k, _toNumberValue(v)]),
  );
}

/**
 * Convert settings to STRING format.
 *
 * All values are converted to their ExtendScript STRING representation.
 *
 * @param settings - The typed settings map.
 * @param resizeMap - Resolution -\> label map for the "Resize to" key (from
 *   {@link buildResizeToStrings}); defaults to the factory fallback table.
 */
export function settingsToString(
  settings: Map<string, SettingValue> | SettingsView<SettingValues>,
  resizeMap: Map<string, string> = _RESIZE_TO_STRINGS,
): Map<string, string | Map<string, string>> {
  return new Map<string, string | Map<string, string>>(
    _settingItems(settings).map((
      [k, v],
    ): [string, string | Map<string, string>] => [
      k,
      _toStringValue(k, v, resizeMap, settings instanceof SettingsView ? (settings._specs.get(k) ?? null)?.[1] : null),
    ]),
  );
}
