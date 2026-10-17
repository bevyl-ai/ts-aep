/**
 * py_aep Validation Tool.
 *
 * Compares parsed AEP values against expected JSON values (from ExtendScript export)
 * to validate parsing correctness.
 *
 * Usage:
 *     aep-validate project.aep expected.json
 *     aep-validate project.aep expected.json --verbose
 *     aep-validate project.aep expected.json --category layers
 */

import { parse } from "../index.ts";
import {
  AttributeError,
  type_name,
  KeyError,
  Path,
  attrs_has,
  decode,
  descriptors_of,
  dict_get,
  fields,
  getitem,
  isclose,
  len,
  py_bool,
  py_eq,
  repr,
  setdefault,
  sorted,
  str,
  zip,
  is_real,
  json_loads,
  truediv,
  PureWindowsPath,
  type PyFloat,
} from "../../pyrt/index.ts";

/** A Python `dict`. Both the JSON side and the to_dict side are Maps (rulebook §3).
 * Keys are field names (strings) — maps keyed by item ids (numbers) are typed
 * `Map<number, …>` at their declarations. Values are genuinely dynamic
 * (parsed JSON/model trees: pass 4, `any` only behind a named alias). */
export type Dict = Map<string, any>;

// Fields to skip to avoid circular references.
// Back-references: containing_comp, parent_folder, parent (OutputModule),
//   _parent (Layer).
// Cross-references that re-enter the object graph: _source (AVLayer > Item),
//   comp (RenderQueueItem > CompItem),
//   post_render_target_comp (OutputModule > CompItem).
// The non-circular ID fields (source_id, parent_id) are still serialized.
export const SKIP_FIELDS: ReadonlySet<string> = new Set([
  "containing_comp",
  "parent_folder",
  "parent_property",
  "parent",
  "comp",
  "post_render_target_comp",
  // Internal marker property (Property with keyframes); compared
  // separately via _compare_markers.
  "marker_property",
  // Cross-reference: LightLayer.light_source > Layer
  "light_source",
]);

// @property attributes that return complex/duplicate data and should not be
// included in to_dict() serialization.
export const SKIP_PROPERTIES: ReadonlySet<string> = new Set([
  "active_camera",
  "composition_layers",
  "footage_layers",
  "selected_layers",
  // Circular: AVLayer.source > Item > layers > AVLayer...
  "source",
  // Circular: AVLayer.track_matte_layer > AVLayer
  "track_matte_layer",
  // Circular: AVItem.used_in > list[CompItem] > layers > source > AVItem...
  "used_in",
  // Duplicate/circular: Project re-serializes items already in `items` field
  "compositions",
  "folders",
  "footages",
  // Layer @property accessors derived from Layer.properties - serializing
  // them would duplicate data already present in the properties list.
  "transform",
  "effects",
  "masks",
  "text",
  // Duplicate: Property.separation_leader > Property
  "separation_leader",
  // Layer.marker @property: duplicates ADBE Marker in properties tree.
  "marker",
]);

export const _field_names_cache = new Map<Function, readonly string[] | null>();

/**
 * Accessor (getter/setter) names on `cls` and its bases: the class-level
 * `property` objects that `isinstance(attr, property)` finds in Python.
 */
export function _property_accessors(cls: Function): string[] {
  const out: string[] = [];
  for (let p = cls.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) {
      if (d.get || d.set) out.push(k);
    }
  }
  return out;
}

/**
 * Get serializable field names for model objects.
 *
 * Supports both `@dataclass` models and plain-class models that use
 * type annotations and/or chunk-backed descriptors (e.g. the Item
 * hierarchy after the descriptor conversion).
 *
 * Sorted, not a set: reading a model attribute can synthesize property
 * children and populate caches, and `_to_dict` memoizes the first
 * result it reaches a shared object by. Iterating a set therefore let
 * `PYTHONHASHSEED` decide what the report said - two runs over the same
 * project disagreed on whether an effect had all of its parameters.
 *
 * Results are cached per type since field names are class-level metadata.
 */
export function _get_field_names(obj: object): readonly string[] | null {
  const cls = obj.constructor;
  const cached = _field_names_cache.get(cls);
  if (cached !== undefined) return cached;

  const names = new Set<string>();
  // `is_dataclass(obj) and not isinstance(obj, type)`: attrs classes stand in for dataclasses.
  if (attrs_has(cls)) {
    for (const f of fields(cls)) names.add(f.name);
  }
  // TODO(port): Python also collects `__annotations__` from the full MRO here. TS erases
  // type annotations at runtime, so a field that is only annotated (neither an attrs field
  // nor a chunk_attr/dict_attr descriptor) on a plain class is not enumerated.
  // Collect annotations and chunk-backed descriptors from the full MRO.
  // This covers plain-class models and also dataclass subclasses that
  // add chunk descriptors in non-dataclass bases (e.g. Layer extends
  // PropertyGroup with ChunkField descriptors).
  for (const [name, attr] of descriptors_of(cls)) {
    // ChunkField (binary-backed) and CosField (COS-dict-backed)
    // descriptors both expose a backing-store attribute name.
    const is_descriptor = "chunk_attr" in attr || "dict_attr" in attr;
    if (is_descriptor && typeof attr.__get__ === "function") names.add(name);
  }
  if (names.size > 0) {
    const result = sorted(names);
    _field_names_cache.set(cls, result);
    return result;
  }
  // Check for public @property definitions (descriptor-backed classes
  // that replaced all class-level annotations with properties).
  const descriptors = descriptors_of(cls);
  for (const name of _property_accessors(cls)) {
    if (!name.startsWith("_") && !descriptors.has(name)) names.add(name);
  }
  const result2: readonly string[] | null = names.size > 0 ? sorted(names) : null;
  _field_names_cache.set(cls, result2);
  return result2;
}

export const _property_names_cache = new Map<Function, readonly string[]>();

/**
 * Get public \@property names for a class, cached per type.
 *
 * Sorted for the same reason as `_get_field_names`.
 */
export function _get_property_names(cls: Function): readonly string[] {
  const cached = _property_names_cache.get(cls);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  // `dir(cls)` + `isinstance(attr, property)`: descriptor-backed fields are not
  // Python `property` objects, so registered descriptors are excluded.
  const descriptors = descriptors_of(cls);
  for (const name of _property_accessors(cls)) {
    if (name.startsWith("_") || SKIP_FIELDS.has(name) || SKIP_PROPERTIES.has(name)) continue;
    if (descriptors.has(name)) continue;
    names.add(name);
  }
  const result = sorted(names);
  _property_names_cache.set(cls, result);
  return result;
}

export const _PRIMITIVE_TYPES: readonly string[] = ["number", "bigint", "string", "boolean"];

/**
 * A value `to_dict` walks or returns, or the ExtendScript JSON value it is
 * compared with: a primitive, a list or Map of such values (a model object
 * becomes a `Dict` of its fields), or another object, which `to_dict`
 * returns unchanged (bytes, sets, callables, `PyFloat`, `String` objects).
 */
export type ToDictValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | symbol
  | ToDictValue[]
  | Dict
  | object;

/**
 * What `to_dict` makes of a `T`: primitives, bytes, sets, callables, `PyFloat`
 * and `String` objects unchanged, a list element-wise, and any other object (a
 * model object, a Map) a `Dict`. Which objects have fields is only known at
 * runtime; one without any comes back unchanged.
 */
export type ToDict<T> = T extends
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | symbol
  | String
  | PyFloat
  | ArrayBufferView
  | ReadonlySet<ToDictValue>
  | Function
  ? T
  : T extends readonly (infer U)[]
    ? ToDict<U>[]
    : Dict;

/** Convert dataclass/enum to dict recursively, skipping circular reference fields. */
export function to_dict<T extends ToDictValue>(obj: T): ToDict<T>;
export function to_dict(obj: ToDictValue): ToDictValue {
  return _to_dict(obj, new Map());
}

/**
 * Recursive worker for `to_dict`, memoized on object identity.
 *
 * The model is a DAG, not a tree: the same layer is reachable through
 * `CompItem.layers`, `av_layers`, `layers_by_id`, `file_layers`, ... and the
 * same property through several group accessors. Without `memo` every such
 * edge re-serializes the whole subtree below it, and those factors multiply
 * down the property nesting - on a production-sized project that is the
 * difference between seconds and hours (and gigabytes of duplicate dicts).
 *
 * `memo` maps the object (identity, the Python `id(obj)` key) to `[obj, result]`;
 * it keeps the object alive so CPython cannot reuse its id mid-walk, and holding
 * `result` before recursing also means a reference cycle yields the shared dict
 * instead of recursing forever.
 */
export function _to_dict(obj: any, memo: Map<object, [object, ToDictValue]>): ToDictValue {
  // Fast path for primitive types (majority of recursive calls).
  // Enum members are plain values in the TS port (pyrt enum.ts), so the
  // `isinstance(obj, Enum)` branch returns `obj.value` through this path.
  if (obj == null || _PRIMITIVE_TYPES.includes(typeof obj)) return obj;
  // A `str` subclass (`_NulTailStr`) passes the Python `isinstance(obj, str)` fast path.
  // bytes, sets and callables have no fields or @property names in Python, so they come back
  // unchanged; the JS accessors on their prototypes (`size`, `length`, `buffer`) are not model properties.
  if (
    obj instanceof String ||
    obj instanceof Uint8Array ||
    ArrayBuffer.isView(obj) ||
    obj instanceof Set ||
    typeof obj === "function" ||
    typeof obj === "symbol"
  ) {
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((item) => _to_dict(item, memo));
  if (obj instanceof Map) {
    const out: Dict = new Map();
    for (const [k, v] of obj) out.set(k, _to_dict(v, memo));
    return out;
  }
  const field_names = _get_field_names(obj);
  if (field_names !== null) {
    const cached = memo.get(obj);
    if (cached !== undefined) return cached[1];
    const result: Dict = new Map();
    memo.set(obj, [obj, result]);
    for (const name of field_names) {
      if (SKIP_FIELDS.has(name)) continue;
      let value: ToDictValue;
      try {
        value = obj[name];
      } catch (e) {
        // missing chunk or field
        if (!(e instanceof AttributeError || e instanceof KeyError)) throw e;
        continue;
      }
      // A missing attribute (Python AttributeError) reads as undefined here; None is null.
      if (value === undefined) continue;
      result.set(name, _to_dict(value, memo));
    }
    // Include @property attributes (non-private, non-skipped)
    for (const name of _get_property_names(obj.constructor)) {
      if (result.has(name)) continue;
      let value: ToDictValue;
      try {
        value = obj[name];
      } catch (e) {
        // missing chunk or field
        if (!(e instanceof AttributeError || e instanceof KeyError)) throw e;
        continue;
      }
      if (value === undefined) continue;
      result.set(name, _to_dict(value, memo));
    }
    return result;
  }
  return obj;
}

/** Get enum value as int if it's an IntEnum, else return as-is. */
export function get_enum_value<T>(val: T): T {
  // Enum members are their own values in the TS port (pyrt enum.ts): `val.value` is `val`.
  return val;
}

export const _CAMEL_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

export function _normalize_keys(d: Dict): Dict {
  /** Convert camelCase dict keys to snake_case recursively. */
  const result: Dict = new Map();
  for (const [key, value0] of d) {
    const snake_key = key.replace(_CAMEL_RE, "_").toLowerCase();
    const value = value0 instanceof Map ? _normalize_keys(value0) : value0;
    result.set(snake_key, value);
  }
  return result;
}

/**
 * Compare two values with tolerance for floats.
 *
 * @param expected - Expected value from ExtendScript JSON.
 * @param parsed - Parsed value from py_aep.
 * @param tolerance - Float comparison tolerance.
 * @returns True if values match.
 */
export function compare_values(expected: ToDictValue, parsed: ToDictValue, tolerance = 0.001): boolean {
  if (expected == null && parsed == null) return true;
  if (expected == null || parsed == null) return false;
  if (typeof expected === "boolean" && typeof parsed === "boolean") return expected === parsed;
  // `isinstance(x, (int, float))` also holds for bool (and a bigint int).
  const is_num = (x: ToDictValue): boolean => is_real(x) || typeof x === "boolean" || typeof x === "bigint";
  if (is_num(expected) && is_num(parsed)) {
    return isclose(Number(expected), Number(parsed), tolerance, tolerance);
  }
  if (typeof expected === "string" && typeof parsed === "string") return expected === parsed;
  if (Array.isArray(expected) && Array.isArray(parsed)) {
    if (expected.length !== parsed.length) return false;
    return expected.every((e, i) => compare_values(e, parsed[i], tolerance));
  }
  return py_eq(expected, parsed);
}

export class ValidationResult {
  /** Stores validation results. */
  declare differences: string[];
  declare warnings: string[];
  declare categories: Map<string, number>;
  declare defined_fields: Set<string>;
  declare compared_fields: Set<string>;

  constructor() {
    this.differences = [];
    this.warnings = [];
    this.categories = new Map();
    this.defined_fields = new Set();
    this.compared_fields = new Set();
  }

  __len__(): number {
    return this.differences.length;
  }

  /** Add a difference. */
  add_diff(path: string, expected: ToDictValue, parsed: ToDictValue, category = "other"): void {
    this.differences.push(`${path}: expected ${repr(expected)}, got ${repr(parsed)}`);
    this.categories.set(category, (this.categories.get(category) ?? 0) + 1);
  }

  /** Add a warning. */
  add_warning(message: string): void {
    this.warnings.push(message);
  }

  /** Register a field for coverage tracking. */
  track_field(class_name: string, attr: string, was_compared: boolean): void {
    const key = `${class_name}.${attr}`;
    this.defined_fields.add(key);
    if (was_compared) this.compared_fields.add(key);
  }
}

/**
 * Compare mapped fields between expected and parsed dicts.
 *
 * For each mapping entry, looks up the expected JSON key in `expected`
 * and the corresponding parsed key in `parsed`, skipping undefined values,
 * and records a diff when they don't match.
 *
 * `mappings` is a fixed literal table of non-integer keys, so a plain object
 * keeps the Python insertion order.
 */
export function _compare_fields(
  expected: Dict,
  parsed: Dict,
  mappings: Record<string, string>,
  path: string,
  category: string,
  result: ValidationResult,
  class_name = "",
): void {
  for (const [exp_key, parsed_key] of Object.entries(mappings)) {
    if (class_name) result.defined_fields.add(`${class_name}.${parsed_key}`);
    if (expected.has(exp_key)) {
      const exp_val = expected.get(exp_key);
      if (exp_val instanceof Map && py_bool(exp_val.get("_undefined"))) continue;
      if (class_name) result.compared_fields.add(`${class_name}.${parsed_key}`);
      const parsed_val = get_enum_value(parsed.get(parsed_key) ?? null);
      if (!compare_values(exp_val, parsed_val)) {
        result.add_diff(`${path}.${exp_key}`, exp_val, parsed_val, category);
      }
    }
  }
}

export function _compare_markers(
  expected_markers: Dict[],
  parsed_markers: Dict[],
  path: string,
  frame_rate: number,
  result: ValidationResult,
): void {
  /** Compare a list of markers (used by both layers and compositions). */
  if (expected_markers.length !== parsed_markers.length) {
    result.add_diff(`${path}.numMarkers`, expected_markers.length, parsed_markers.length, "markers");
  }
  for (const [i, [exp_marker, parsed_marker]] of zip(expected_markers, parsed_markers).entries()) {
    compare_marker(exp_marker, parsed_marker, `${path}.markers[${i}]`, frame_rate, result);
  }
}

export function _compare_guides(expected_guides: Dict[], parsed_guides: Dict[], path: string, result: ValidationResult): void {
  /** Compare a list of guides. */
  if (expected_guides.length !== parsed_guides.length) {
    result.add_diff(`${path}.numGuides`, expected_guides.length, parsed_guides.length, "composition");
  }
  const guide_mappings = {
    orientationType: "orientation_type",
    position: "position",
    positionType: "position_type",
  };
  for (const [i, [exp_guide, parsed_guide]] of zip(expected_guides, parsed_guides).entries()) {
    _compare_fields(exp_guide, parsed_guide, guide_mappings, `${path}.guides[${i}]`, "composition", result, "Guide");
  }
}

export function _compare_proxy_source(expected_item: Dict, parsed_item: Dict, path: string, result: ValidationResult): void {
  /** Compare proxySource on an AVItem (comp or footage). */
  const exp_proxy = expected_item.get("proxySource") ?? null;
  const parsed_proxy = parsed_item.get("proxy_source") ?? null;
  if (py_bool(exp_proxy) && py_bool(parsed_proxy)) {
    const proxy_path = `${path}.proxySource`;
    const source_mappings = {
      alphaMode: "alpha_mode",
      displayFrameRate: "display_frame_rate",
      fieldSeparationType: "field_separation_type",
      hasAlpha: "has_alpha",
      highQualityFieldSeparation: "high_quality_field_separation",
      invertAlpha: "invert_alpha",
      isStill: "is_still",
      loop: "loop",
      nativeFrameRate: "native_frame_rate",
      premulColor: "premul_color",
      removePulldown: "remove_pulldown",
      color: "color",
    };
    _compare_fields(exp_proxy, parsed_proxy, source_mappings, proxy_path, "footage", result, "FootageSource");
  } else if (py_bool(exp_proxy) && !py_bool(parsed_proxy)) {
    result.add_diff(`${path}.proxySource`, "present", "None", "footage");
  } else if (!py_bool(exp_proxy) && py_bool(parsed_proxy)) {
    result.add_diff(`${path}.proxySource`, "None", "present", "footage");
  }
}

export function _compare_children_by_match_name(
  expected_props: Dict[],
  parsed_props: Dict[],
  path: string,
  result: ValidationResult,
): void {
  /** Match expected/parsed property children by matchName, then recurse. */
  if (expected_props.length !== parsed_props.length) {
    result.add_diff(`${path}.numProperties`, expected_props.length, parsed_props.length, "properties");
  }

  // Build match-name lookup.  When multiple children share the same
  // match_name (e.g. masks, duplicate effects), store them in order so we
  // can fall back to positional matching within each match_name group.
  const parsed_by_match_name = new Map<string, Dict[]>();
  for (const p of parsed_props) {
    const mn = dict_get(p, "match_name", "");
    if (py_bool(mn)) setdefault(parsed_by_match_name, mn, []).push(p);
  }

  // Track how many of each match_name we have consumed.
  const match_name_idx = new Map<string, number>();

  for (const [i, exp_prop] of expected_props.entries()) {
    const exp_match_name = dict_get(exp_prop, "matchName", "");
    const exp_name = dict_get(exp_prop, "name", `[${i}]`);
    const child_path = `${path}.${exp_name}`;

    const candidates = parsed_by_match_name.get(exp_match_name);
    if (!candidates?.length) {
      result.add_diff(child_path, "exists", "missing", "properties");
      continue;
    }

    const idx = (match_name_idx.get(exp_match_name) ?? 0);
    let parsed_prop: Dict;
    if (idx < candidates.length) {
      parsed_prop = candidates[idx];
      match_name_idx.set(exp_match_name, idx + 1);
    } else {
      parsed_prop = candidates[candidates.length - 1];
    }

    const has_child_properties = exp_prop.has("properties");
    const exp_property_type = exp_prop.get("propertyType") ?? null;
    if (has_child_properties || exp_property_type === "IndexedGroup") {
      compare_property_group(exp_prop, parsed_prop, child_path, result);
    } else {
      compare_property(exp_prop, parsed_prop, child_path, result);
    }
  }
}

/** Compare project-level properties. */
export function compare_project_level(expected: Dict, parsed: Dict, result: ValidationResult): void {
  const mappings = {
    bitsPerChannel: "bits_per_channel",
    transparencyGridThumbnails: "transparency_grid_thumbnails",
    displayStartFrame: "display_start_frame",
    framesCountType: "frames_count_type",
    feetFramesFilmType: "feet_frames_film_type",
    framesUseFeetFrames: "frames_use_feet_frames",
    timeDisplayType: "time_display_type",
    footageTimecodeDisplayStartType: "footage_timecode_display_start_type",
    expressionEngine: "expression_engine",
    linearBlending: "linear_blending",
    workingSpace: "working_space",
    linearizeWorkingSpace: "linearize_working_space",
    workingGamma: "working_gamma",
    gpuAccelType: "gpu_accel_type",
  };

  _compare_fields(expected, parsed, mappings, "Project", "project", result, "Project");
}

export function compare_marker(
  expected_marker: Dict,
  parsed_marker: Dict,
  path: string,
  frame_rate: number,
  result: ValidationResult,
): void {
  /** Compare marker properties. */
  // Calculate time from frame_time if available
  let parsed_time: number | null = null;
  if (parsed_marker.get("frame_time") != null) {
    parsed_time = truediv(getitem(parsed_marker, "frame_time"), frame_rate);
  }

  // Compare time
  result.track_field("Marker", "time", expected_marker.has("time"));
  if (expected_marker.has("time")) {
    const exp_val = getitem(expected_marker, "time");
    if (!(exp_val instanceof Map) || !py_bool(exp_val.get("_undefined"))) {
      if (!compare_values(exp_val, parsed_time)) {
        result.add_diff(`${path}.time`, exp_val, parsed_time, "markers");
      }
    }
  }

  const marker_mappings = {
    comment: "comment",
    chapter: "chapter",
    url: "url",
    duration: "duration",
    label: "label",
    cuePointName: "cue_point_name",
    frameTarget: "frame_target",
    protectedRegion: "protected_region",
    eventCuePoint: "event_cue_point",
  };

  _compare_fields(expected_marker, parsed_marker, marker_mappings, path, "markers", result, "Marker");
}

export function compare_layer(
  expected_layer: Dict,
  parsed_layer: Dict,
  path: string,
  comp_duration: number,
  frame_rate: number,
  result: ValidationResult,
): void {
  /** Compare layer properties. */
  const layer_mappings = {
    name: "name",
    id: "id",
    time: "time",
    comment: "comment",
    enabled: "enabled",
    canSetEnabled: "can_set_enabled",
    hasVideo: "has_video",
    hasAudio: "has_audio",
    canSetCollapseTransformation: "can_set_collapse_transformation",
    canSetTimeRemapEnabled: "can_set_time_remap_enabled",
    inPoint: "in_point",
    outPoint: "out_point",
    startTime: "start_time",
    stretch: "stretch",
    label: "label",
    locked: "locked",
    nullLayer: "null_layer",
    shy: "shy",
    solo: "solo",
    isNameSet: "is_name_set",
    autoOrient: "auto_orient",
    matchName: "match_name",
    layerType: "layer_type",
    hasTrackMatte: "has_track_matte",
    isTrackMatte: "is_track_matte",
    isNameFromSource: "is_name_from_source",
    // AVLayer specific
    adjustmentLayer: "adjustment_layer",
    audioActive: "audio_active",
    audioEnabled: "audio_enabled",
    blendingMode: "blending_mode",
    collapseTransformation: "collapse_transformation",
    effectsActive: "effects_active",
    environmentLayer: "environment_layer",
    frameBlending: "frame_blending",
    frameBlendingType: "frame_blending_type",
    guideLayer: "guide_layer",
    height: "height",
    width: "width",
    motionBlur: "motion_blur",
    preserveTransparency: "preserve_transparency",
    quality: "quality",
    samplingQuality: "sampling_quality",
    threeDLayer: "three_d_layer",
    timeRemapEnabled: "time_remap_enabled",
    trackMatteType: "track_matte_type",
    sourceId: "_source_id",
    lightType: "light_type",
    threeDPerChar: "three_d_per_char",
  };

  _compare_fields(expected_layer, parsed_layer, layer_mappings, path, "layers", result, "Layer");

  // Compare index (ExtendScript is 1-based, parsed is 0-based)
  result.track_field("Layer", "index", expected_layer.has("index"));
  result.track_field("Layer", "light_source_id", expected_layer.has("lightSource"));
  if (expected_layer.has("index")) {
    const exp_index = getitem(expected_layer, "index");
    const parsed_index = parsed_layer.get("index") ?? null;
    if (parsed_index != null && exp_index !== parsed_index + 1) {
      result.add_diff(`${path}.index`, exp_index, parsed_index + 1, "layers");
    }
  }

  // Compare lightSource (Layer reference -> compare by layer index)
  if (expected_layer.has("lightSource")) {
    const exp_ls = getitem(expected_layer, "lightSource");
    const parsed_ls_id = dict_get(parsed_layer, "_light_source_id", 0);
    if (exp_ls == null) {
      if (parsed_ls_id !== 0) {
        result.add_diff(`${path}.lightSource`, null, parsed_ls_id, "layers");
      }
    } else if (exp_ls instanceof Map) {
      const exp_ls_index = exp_ls.get("index") ?? null;
      if (exp_ls_index != null && parsed_ls_id === 0) {
        result.add_diff(`${path}.lightSource`, exp_ls_index, null, "layers");
      }
    }
  }

  // Compare all property groups via the properties list.
  _compare_children_by_match_name(
    dict_get(expected_layer, "properties", []),
    dict_get(parsed_layer, "properties", []),
    path,
    result,
  );
}

export function compare_property(
  expected_prop: Dict,
  parsed_prop: Dict,
  path: string,
  result: ValidationResult,
): void {
  /**
   * Compare a single property (leaf node).
   *
   * @param expected_prop - Expected property from ExtendScript JSON.
   * @param parsed_prop - Parsed property from py_aep.
   * @param path - Dotted path for error messages.
   * @param result - ValidationResult to accumulate differences.
   */
  const property_mappings = {
    name: "name",
    matchName: "match_name",
    enabled: "enabled",
    canSetEnabled: "can_set_enabled",
    canSetExpression: "can_set_expression",
    canVaryOverTime: "can_vary_over_time",
    expression: "expression",
    expressionEnabled: "expression_enabled",
    propertyValueType: "property_value_type",
    propertyDepth: "property_depth",
    dimensionsSeparated: "dimensions_separated",
    isSpatial: "is_spatial",
    elided: "elided",
    isEffect: "is_effect",
    isMask: "is_mask",
    isModified: "is_modified",
    isSeparationLeader: "is_separation_leader",
    isSeparationFollower: "is_separation_follower",
    unitsText: "units_text",
    separationDimension: "separation_dimension",
    canSetAlternateSource: "can_set_alternate_source",
  };

  _compare_fields(expected_prop, parsed_prop, property_mappings, path, "properties", result, "Property");

  // Track manually-compared fields
  result.track_field("Property", "property_index", expected_prop.has("propertyIndex"));
  result.track_field("Property", "value", expected_prop.has("value"));
  result.track_field("Property", "keyframes", expected_prop.has("numKeys"));
  result.track_field(
    "Property",
    "min_value",
    expected_prop.has("hasMin") && py_bool(expected_prop.get("hasMin")),
  );
  result.track_field(
    "Property",
    "max_value",
    expected_prop.has("hasMax") && py_bool(expected_prop.get("hasMax")),
  );

  // Compare propertyIndex (ExtendScript is 1-based, parsed is 0-based)
  if (expected_prop.has("propertyIndex")) {
    const exp_pi = getitem(expected_prop, "propertyIndex");
    const parsed_pi = parsed_prop.get("property_index") ?? null;
    if (parsed_pi != null && exp_pi !== parsed_pi + 1) {
      result.add_diff(`${path}.propertyIndex`, exp_pi, parsed_pi + 1, "properties");
    }
  }

  // Compare value
  if (expected_prop.has("value")) {
    const exp_val = getitem(expected_prop, "value");
    const parsed_val = parsed_prop.get("value") ?? null;
    if (!(exp_val instanceof Map) || !py_bool(exp_val.get("_undefined"))) {
      if (parsed_val == null) {
        result.add_diff(`${path}.value`, exp_val, parsed_val, "properties");
      } else if (!compare_values(exp_val, parsed_val)) {
        result.add_diff(`${path}.value`, exp_val, parsed_val, "properties");
      }
    }
  }

  // Compare numKeys vs len(keyframes)
  if (expected_prop.has("numKeys")) {
    const exp_num_keys = getitem(expected_prop, "numKeys");
    const parsed_keyframes = dict_get(parsed_prop, "keyframes", []);
    const parsed_num_keys = py_bool(parsed_keyframes) ? len(parsed_keyframes) : 0;
    if (exp_num_keys !== parsed_num_keys) {
      result.add_diff(`${path}.numKeys`, exp_num_keys, parsed_num_keys, "properties");
    }
  }

  // Compare individual keyframes
  const exp_keyframes = dict_get(expected_prop, "keyframes", []);
  const parsed_keyframes = dict_get(parsed_prop, "keyframes", []);
  for (const [ki, [exp_kf, parsed_kf]] of zip(exp_keyframes, parsed_keyframes).entries()) {
    compare_keyframe(exp_kf, parsed_kf, `${path}.keyframes[${ki}]`, result);
  }

  // Compare has_min/has_max PRESENCE first - this catches both over-reporting
  // (py reports a bound ExtendScript says is absent) and under-reporting,
  // which the value comparisons below cannot (they only run when ES reports
  // the bound present).
  if (expected_prop.has("hasMin")) {
    const exp_has_min = py_bool(getitem(expected_prop, "hasMin"));
    const parsed_has_min = py_bool(parsed_prop.get("has_min"));
    if (exp_has_min !== parsed_has_min) {
      result.add_diff(`${path}.hasMin`, exp_has_min, parsed_has_min, "properties");
    }
  }
  if (expected_prop.has("hasMax")) {
    const exp_has_max = py_bool(getitem(expected_prop, "hasMax"));
    const parsed_has_max = py_bool(parsed_prop.get("has_max"));
    if (exp_has_max !== parsed_has_max) {
      result.add_diff(`${path}.hasMax`, exp_has_max, parsed_has_max, "properties");
    }
  }

  // Compare min/max values only when BOTH sides report the bound present.
  // The presence check above already flags an under-reported bound; gating
  // the value comparison on the parsed side too avoids a redundant second
  // diff (.minValue: 0 vs None) for the same root cause.
  if (py_bool(expected_prop.get("hasMin")) && py_bool(parsed_prop.get("has_min"))) {
    if (expected_prop.has("minValue")) {
      const exp_min = getitem(expected_prop, "minValue");
      const parsed_min = parsed_prop.get("min_value") ?? null;
      if (!compare_values(exp_min, parsed_min)) {
        result.add_diff(`${path}.minValue`, exp_min, parsed_min, "properties");
      }
    }
  }

  if (py_bool(expected_prop.get("hasMax")) && py_bool(parsed_prop.get("has_max"))) {
    if (expected_prop.has("maxValue")) {
      const exp_max = getitem(expected_prop, "maxValue");
      const parsed_max = parsed_prop.get("max_value") ?? null;
      if (!compare_values(exp_max, parsed_max)) {
        result.add_diff(`${path}.maxValue`, exp_max, parsed_max, "properties");
      }
    }
  }

  // Compare TextDocument value
  if (expected_prop.has("textDocument")) {
    const parsed_value = parsed_prop.get("value") ?? null;
    if (parsed_value instanceof Map) {
      compare_text_document(getitem(expected_prop, "textDocument"), parsed_value, `${path}.textDocument`, result);
    }
  }

  // Compare Shape value
  if (expected_prop.has("shapeValue")) {
    const parsed_value = parsed_prop.get("value") ?? null;
    if (parsed_value instanceof Map) {
      compare_shape_value(getitem(expected_prop, "shapeValue"), parsed_value, `${path}.shapeValue`, result);
    }
  }

  // Compare alternateSource (Media Replacement wrapper reference). to_dict
  // serializes the AVItem fully, so id/name are available; compare on id (the
  // binary blsi item id, the strongest invariant) then name.
  result.track_field("Property", "alternate_source", expected_prop.has("alternateSource"));
  if (expected_prop.has("alternateSource")) {
    const exp_alt = getitem(expected_prop, "alternateSource");
    const parsed_alt = parsed_prop.get("alternate_source") ?? null;
    if (exp_alt == null) {
      if (parsed_alt != null) {
        const pid = parsed_alt instanceof Map ? parsed_alt.get("id") ?? null : parsed_alt;
        result.add_diff(`${path}.alternateSource`, null, pid, "properties");
      }
    } else if (exp_alt instanceof Map) {
      if (!(parsed_alt instanceof Map)) {
        result.add_diff(`${path}.alternateSource`, exp_alt, null, "properties");
      } else {
        for (const key of ["id", "name"]) {
          if (!py_eq(exp_alt.get(key) ?? null, parsed_alt.get(key) ?? null)) {
            result.add_diff(
              `${path}.alternateSource.${key}`,
              exp_alt.get(key) ?? null,
              parsed_alt.get(key) ?? null,
              "properties",
            );
          }
        }
      }
    }
  }

  // Compare essentialPropertySource (originating source of an Essential
  // Property). ExtendScript emits a {sourceType, ...} descriptor: an AVLayer
  // source (Media Replacement Footage) is compared on name + index (index is
  // 1-based, parsed is 0-based; the containing-comp name is not serialized by
  // to_dict - circular-ref guard - so comp is not compared). A Property source
  // is compared on matchName.
  result.track_field("Property", "essential_property_source", expected_prop.has("essentialPropertySource"));
  if (expected_prop.has("essentialPropertySource")) {
    const exp_eps = getitem(expected_prop, "essentialPropertySource");
    const parsed_eps = parsed_prop.get("essential_property_source") ?? null;
    if (exp_eps == null) {
      if (parsed_eps != null) {
        const pname = parsed_eps instanceof Map ? parsed_eps.get("name") ?? null : parsed_eps;
        result.add_diff(`${path}.essentialPropertySource`, null, pname, "properties");
      }
    } else if (!(parsed_eps instanceof Map)) {
      result.add_diff(`${path}.essentialPropertySource`, exp_eps, null, "properties");
    } else if (dict_get(exp_eps, "sourceType") === "AVLayer") {
      if (!py_eq(dict_get(exp_eps, "name"), parsed_eps.get("name") ?? null)) {
        result.add_diff(
          `${path}.essentialPropertySource.name`,
          dict_get(exp_eps, "name"),
          parsed_eps.get("name") ?? null,
          "properties",
        );
      }
      const exp_idx = dict_get<string, ToDictValue>(exp_eps, "index");
      const parsed_idx = parsed_eps.get("index") ?? null;
      if (exp_idx != null && parsed_idx != null && exp_idx !== parsed_idx + 1) {
        result.add_diff(`${path}.essentialPropertySource.index`, exp_idx, parsed_idx + 1, "properties");
      }
    } else if (dict_get(exp_eps, "sourceType") === "Property") {
      if (!py_eq(dict_get(exp_eps, "matchName"), parsed_eps.get("match_name") ?? null)) {
        result.add_diff(
          `${path}.essentialPropertySource.matchName`,
          dict_get(exp_eps, "matchName"),
          parsed_eps.get("match_name") ?? null,
          "properties",
        );
      }
    }
  }
}

export function compare_shape_value(
  expected_shape: Dict,
  parsed_shape: Dict,
  path: string,
  result: ValidationResult,
): void {
  /**
   * Compare a Shape value (mask path or shape layer path).
   *
   * @param expected_shape - Expected shape from ExtendScript JSON.
   * @param parsed_shape - Parsed shape dict from py_aep.
   * @param path - Dotted path for error messages.
   * @param result - ValidationResult to accumulate differences.
   */
  const shape_mappings: Record<string, string> = {
    closed: "closed",
    vertices: "vertices",
    inTangents: "in_tangents",
    outTangents: "out_tangents",
  };
  _compare_fields(expected_shape, parsed_shape, shape_mappings, path, "shape", result, "Shape");

  // Compare feather data: ExtendScript exposes parallel arrays,
  // py_aep stores a list of FeatherPoint objects.
  const feather_field_map: Record<string, string> = {
    featherSegLocs: "seg_loc",
    featherRelSegLocs: "rel_seg_loc",
    featherRadii: "radius",
    featherTypes: "type",
    featherInterps: "interp",
    featherTensions: "tension",
    featherRelCornerAngles: "rel_corner_angle",
  };
  const parsed_fps: Dict[] = dict_get(parsed_shape, "feather_points", []);
  for (const [exp_key, fp_attr] of Object.entries(feather_field_map)) {
    result.defined_fields.add(`Shape.${fp_attr}`);
    if (expected_shape.has(exp_key)) {
      const exp_val = expected_shape.get(exp_key);
      if (exp_val instanceof Map && py_bool(exp_val.get("_undefined"))) continue;
      result.compared_fields.add(`Shape.${fp_attr}`);
      const parsed_val = parsed_fps.map((fp) => fp.get(fp_attr) ?? null);
      if (!compare_values(exp_val, parsed_val)) {
        result.add_diff(`${path}.${exp_key}`, exp_val, parsed_val, "shape");
      }
    }
  }
}

export function compare_keyframe(
  expected_kf: Dict,
  parsed_kf: Dict,
  path: string,
  result: ValidationResult,
): void {
  /**
   * Compare a single keyframe's attributes.
   *
   * @param expected_kf - Expected keyframe from ExtendScript JSON.
   * @param parsed_kf - Parsed keyframe from py_aep.
   * @param path - Dotted path for error messages.
   * @param result - ValidationResult to accumulate differences.
   */
  // Track manually-compared fields
  result.track_field("Keyframe", "value", expected_kf.has("value"));
  result.track_field("Keyframe", "in_temporal_ease", expected_kf.has("inTemporalEase"));
  result.track_field("Keyframe", "out_temporal_ease", expected_kf.has("outTemporalEase"));

  // Compare value. The exporter writes None for a key value ExtendScript
  // cannot read (a Curves key's, which aborts the script).
  if (expected_kf.get("value") != null && parsed_kf.get("value") != null) {
    const exp_val = getitem(expected_kf, "value");
    const parsed_val = getitem(parsed_kf, "value");
    if (exp_val instanceof Map && exp_val.has("vertices")) {
      // Shape keyframe value - compare as shape
      if (parsed_val instanceof Map) {
        compare_shape_value(exp_val, parsed_val, `${path}.value`, result);
      }
    } else if (exp_val instanceof Map && parsed_val instanceof Map) {
      // Dict value (e.g. marker) - normalize keys and compare matching
      const normalized = _normalize_keys(exp_val);
      for (const [key, nval] of normalized) {
        const pval = parsed_val.get(key) ?? null;
        if (pval != null && !compare_values(nval, pval)) {
          result.add_diff(`${path}.value.${key}`, nval, pval, "keyframes");
        }
      }
    } else if (!(exp_val instanceof Map) || !py_bool(exp_val.get("_undefined"))) {
      if (!compare_values(exp_val, parsed_val)) {
        result.add_diff(`${path}.value`, exp_val, parsed_val, "keyframes");
      }
    }
  }

  // Compare interpolation types and boolean flags
  const kf_mappings = {
    time: "time",
    inInterpolationType: "in_interpolation_type",
    outInterpolationType: "out_interpolation_type",
    temporalAutoBezier: "temporal_auto_bezier",
    temporalContinuous: "temporal_continuous",
    spatialAutoBezier: "spatial_auto_bezier",
    spatialContinuous: "spatial_continuous",
    roving: "roving",
    label: "label",
    inSpatialTangent: "in_spatial_tangent",
    outSpatialTangent: "out_spatial_tangent",
  };

  _compare_fields(expected_kf, parsed_kf, kf_mappings, path, "keyframes", result, "Keyframe");

  // Compare temporal ease
  for (const [ease_key, parsed_key] of [
    ["inTemporalEase", "in_temporal_ease"],
    ["outTemporalEase", "out_temporal_ease"],
  ]) {
    if (expected_kf.has(ease_key)) {
      const exp_ease = expected_kf.get(ease_key);
      const parsed_ease = dict_get(parsed_kf, parsed_key, []);
      if (len(exp_ease) !== len(parsed_ease)) {
        result.add_diff(`${path}.${ease_key}.length`, len(exp_ease), len(parsed_ease), "keyframes");
      }
      for (const [ei, [exp_e, parsed_e]] of zip(exp_ease, parsed_ease).entries()) {
        const exp_speed = exp_e instanceof Map ? exp_e.get("speed") ?? null : null;
        const exp_influence = exp_e instanceof Map ? exp_e.get("influence") ?? null : null;
        const parsed_speed = parsed_e instanceof Map ? parsed_e.get("speed") ?? null : null;
        const parsed_influence = parsed_e instanceof Map ? parsed_e.get("influence") ?? null : null;
        if (!compare_values(exp_speed, parsed_speed)) {
          result.add_diff(`${path}.${ease_key}[${ei}].speed`, exp_speed, parsed_speed, "keyframes");
        }
        if (!compare_values(exp_influence, parsed_influence)) {
          result.add_diff(`${path}.${ease_key}[${ei}].influence`, exp_influence, parsed_influence, "keyframes");
        }
      }
    }
  }
}

export function compare_text_document(
  expected_doc: Dict,
  parsed_doc: Dict,
  path: string,
  result: ValidationResult,
): void {
  /**
   * Compare TextDocument properties.
   *
   * @param expected_doc - Expected TextDocument from ExtendScript JSON.
   * @param parsed_doc - Parsed TextDocument from py_aep.
   * @param path - Dotted path for error messages.
   * @param result - ValidationResult to accumulate differences.
   */
  // fontFamily/fontStyle/fontLocation are intentionally omitted: AE does not
  // store them in the .aep. It resolves them at runtime by feeding the stored
  // PostScript name to CoolType against the host's installed font database, so
  // the ExtendScript ground truth is host-dependent (e.g. a live Windows font
  // path) and there is nothing in the binary to decode. `font` (the stored
  // PostScript name) is compared instead.
  const text_value = expected_doc.get("text");
  if (typeof text_value === "string" && text_value.includes("\r")) {
    // ExtendScript reports AE's CR line breaks; TextDocument.text
    // normalizes them to LF by design.
    expected_doc = new Map(expected_doc);
    expected_doc.set("text", text_value.replaceAll("\r", "\n"));
  }
  const text_mappings = {
    text: "text",
    font: "font",
    fontSize: "font_size",
    fauxBold: "faux_bold",
    fauxItalic: "faux_italic",
    autoKernType: "auto_kern_type",
    kerning: "kerning",
    tracking: "tracking",
    leading: "leading",
    leadingType: "leading_type",
    autoLeading: "auto_leading",
    baselineShift: "baseline_shift",
    horizontalScale: "horizontal_scale",
    verticalScale: "vertical_scale",
    tsume: "tsume",
    allCaps: "all_caps",
    smallCaps: "small_caps",
    superscript: "superscript",
    subscript: "subscript",
    fontBaselineOption: "font_baseline_option",
    fontCapsOption: "font_caps_option",
    baselineDirection: "baseline_direction",
    ligature: "ligature",
    noBreak: "no_break",
    digitSet: "digit_set",
    lineJoinType: "line_join_type",
    fillColor: "fill_color",
    applyFill: "apply_fill",
    strokeColor: "stroke_color",
    applyStroke: "apply_stroke",
    strokeWidth: "stroke_width",
    strokeOverFill: "stroke_over_fill",
    justification: "justification",
    direction: "direction",
    firstLineIndent: "first_line_indent",
    startIndent: "start_indent",
    endIndent: "end_indent",
    spaceBefore: "space_before",
    spaceAfter: "space_after",
    everyLineComposer: "every_line_composer",
    hangingRoman: "hanging_roman",
    autoHyphenate: "auto_hyphenate",
    composerEngine: "composer_engine",
    paragraphCount: "paragraph_count",
    boxText: "box_text",
    pointText: "point_text",
    boxTextSize: "box_text_size",
    boxTextPos: "box_text_pos",
    boxVerticalAlignment: "box_vertical_alignment",
    boxAutoFitPolicy: "box_auto_fit_policy",
    boxFirstBaselineAlignment: "box_first_baseline_alignment",
    boxFirstBaselineAlignmentMinimum: "box_first_baseline_alignment_minimum",
    boxInsetSpacing: "box_inset_spacing",
    boxOverflow: "box_overflow",
    lineOrientation: "line_orientation",
    composedLineCount: "composed_line_count",
    paragraphRanges: "paragraph_ranges",
    composedLineRanges: "composed_line_ranges",
  };

  _compare_fields(expected_doc, parsed_doc, text_mappings, path, "textdocument", result, "TextDocument");
}

export function compare_property_group(
  expected_group: Dict,
  parsed_group: Dict,
  path: string,
  result: ValidationResult,
): void {
  /**
   * Compare a property group (effects group, transform group, etc.).
   *
   * Recursively compares nested properties and property groups.
   *
   * @param expected_group - Expected property group from ExtendScript JSON.
   * @param parsed_group - Parsed property group from py_aep.
   * @param path - Dotted path for error messages.
   * @param result - ValidationResult to accumulate differences.
   */
  const group_mappings = {
    name: "name",
    matchName: "match_name",
    enabled: "enabled",
    canSetEnabled: "can_set_enabled",
    elided: "elided",
    isEffect: "is_effect",
    isMask: "is_mask",
    isModified: "is_modified",
    propertyDepth: "property_depth",
    color: "color",
    maskFeatherFalloff: "mask_feather_falloff",
    maskMode: "mask_mode",
    maskMotionBlur: "mask_motion_blur",
    inverted: "inverted",
    locked: "locked",
    rotoBezier: "roto_bezier",
  };

  _compare_fields(expected_group, parsed_group, group_mappings, path, "properties", result, "PropertyGroup");

  // Compare propertyIndex (ExtendScript is 1-based, parsed is 0-based)
  result.track_field("PropertyGroup", "property_index", expected_group.has("propertyIndex"));
  if (expected_group.has("propertyIndex")) {
    const exp_pi = getitem(expected_group, "propertyIndex");
    const parsed_pi = parsed_group.get("property_index") ?? null;
    if (parsed_pi != null && exp_pi !== parsed_pi + 1) {
      result.add_diff(`${path}.propertyIndex`, exp_pi, parsed_pi + 1, "properties");
    }
  }

  // Compare child properties
  _compare_children_by_match_name(
    dict_get(expected_group, "properties", []),
    dict_get(parsed_group, "properties", []),
    path,
    result,
  );
}

export function compare_comp_item(
  expected_item: Dict,
  parsed_comp: Dict,
  path: string,
  result: ValidationResult,
): void {
  /** Compare composition item properties. */
  const comp_mappings = {
    name: "name",
    id: "id",
    comment: "comment",
    label: "label",
    time: "time",
    duration: "duration",
    frameRate: "frame_rate",
    width: "width",
    height: "height",
    displayStartTime: "display_start_time",
    displayStartFrame: "display_start_frame",
    dropFrame: "drop_frame",
    bgColor: "bg_color",
    pixelAspect: "pixel_aspect",
    shutterPhase: "shutter_phase",
    shutterAngle: "shutter_angle",
    motionBlur: "motion_blur",
    motionBlurAdaptiveSampleLimit: "motion_blur_adaptive_sample_limit",
    motionBlurSamplesPerFrame: "motion_blur_samples_per_frame",
    workAreaStart: "work_area_start",
    workAreaDuration: "work_area_duration",
    preserveNestedResolution: "preserve_nested_resolution",
    preserveNestedFrameRate: "preserve_nested_frame_rate",
    frameBlending: "frame_blending",
    hideShyLayers: "hide_shy_layers",
    resolutionFactor: "resolution_factor",
    draft3d: "draft3d",
    hasVideo: "has_video",
    isMediaReplacementCompatible: "is_media_replacement_compatible",
    renderer: "renderer",
    motionGraphicsTemplateName: "motion_graphics_template_name",
    motionGraphicsTemplateControllerCount: "motion_graphics_template_controller_count",
    motionGraphicsTemplateControllerNames: "motion_graphics_template_controller_names",
  };

  _compare_fields(expected_item, parsed_comp, comp_mappings, path, "composition", result, "CompItem");

  // Compare layer counts
  const exp_layers = dict_get(expected_item, "layers", []);
  const parsed_layers = dict_get(parsed_comp, "layers", []);
  if (exp_layers.length !== parsed_layers.length) {
    result.add_diff(`${path}.numLayers`, exp_layers.length, parsed_layers.length, "composition");
  }

  // Compare each layer
  const comp_duration = dict_get(expected_item, "duration", 60.0);
  const frame_rate = dict_get(expected_item, "frameRate", 24.0);
  for (const [i, [exp_layer, parsed_layer]] of zip(exp_layers, parsed_layers).entries()) {
    compare_layer(exp_layer, parsed_layer, `${path}.layers[${i}]`, comp_duration, frame_rate, result);
  }

  // Compare markers
  _compare_markers(
    dict_get(expected_item, "markers", []),
    dict_get(parsed_comp, "markers", []),
    path,
    dict_get(expected_item, "frameRate", 24.0),
    result,
  );

  // Compare guides
  _compare_guides(dict_get(expected_item, "guides", []), dict_get(parsed_comp, "guides", []), path, result);

  // Compare proxySource
  _compare_proxy_source(expected_item, parsed_comp, path, result);
}

export function compare_folder_hierarchy(
  expected_items: Dict[],
  parsed_items: Map<number, Dict>,
  result: ValidationResult,
): void {
  /** Compare folder hierarchy. */
  const expected_folders = new Map<number, Dict>();
  for (const item of expected_items) {
    if ((item.get("itemType") ?? null) === "FolderItem") {
      expected_folders.set(getitem(item, "id"), item);
    }
  }

  const parsed_folders = new Map<number, Dict>();
  for (const [item_id, item] of parsed_items) {
    if (dict_get(item, "type_name") === "Folder") {
      parsed_folders.set(item_id, item);
    }
  }

  for (const [folder_id, exp_folder] of expected_folders) {
    const parsed_folder = parsed_folders.get(folder_id);
    if (parsed_folder === undefined) {
      result.add_diff(`Folder[${getitem(exp_folder, "name")}]`, "exists", "missing", "folders");
    } else {
      if (!py_eq(getitem(exp_folder, "name"), parsed_folder.get("name") ?? null)) {
        result.add_diff(
          `Folder[id=${folder_id}].name`,
          getitem(exp_folder, "name"),
          parsed_folder.get("name") ?? null,
          "folders",
        );
      }
    }
  }
}

export function compare_footage_item(
  expected_item: Dict,
  parsed_item: Dict,
  path: string,
  result: ValidationResult,
): void {
  /**
   * Compare footage item properties and its main source.
   *
   * @param expected_item - Expected FootageItem from ExtendScript JSON.
   * @param parsed_item - Parsed FootageItem from py_aep.
   * @param path - Dotted path for error messages.
   * @param result - ValidationResult to accumulate differences.
   */
  const footage_mappings = {
    name: "name",
    id: "id",
    comment: "comment",
    label: "label",
    time: "time",
    duration: "duration",
    frameRate: "frame_rate",
    width: "width",
    height: "height",
    pixelAspect: "pixel_aspect",
    footageMissing: "footage_missing",
    hasVideo: "has_video",
    isMediaReplacementCompatible: "is_media_replacement_compatible",
  };

  _compare_fields(expected_item, parsed_item, footage_mappings, path, "footage", result, "FootageItem");

  // Compare mainSource (FootageSource fields)
  const exp_source = expected_item.get("mainSource") ?? null;
  const parsed_source = parsed_item.get("main_source") ?? null;
  if (py_bool(exp_source) && py_bool(parsed_source)) {
    const source_path = `${path}.mainSource`;

    const source_mappings = {
      alphaMode: "alpha_mode",
      displayFrameRate: "display_frame_rate",
      fieldSeparationType: "field_separation_type",
      hasAlpha: "has_alpha",
      highQualityFieldSeparation: "high_quality_field_separation",
      invertAlpha: "invert_alpha",
      isStill: "is_still",
      loop: "loop",
      nativeFrameRate: "native_frame_rate",
      premulColor: "premul_color",
      removePulldown: "remove_pulldown",
      color: "color",
    };

    _compare_fields(exp_source, parsed_source, source_mappings, source_path, "footage", result, "FootageSource");

    // AE returns native_frame_rate when conformFrameRate is 0
    result.track_field("FootageSource", "conform_frame_rate", exp_source.has("conformFrameRate"));
    const exp_cfr = dict_get<string, ToDictValue>(exp_source, "conformFrameRate");
    const parsed_cfr = dict_get<string, ToDictValue, number>(parsed_source, "conform_frame_rate", 0);
    if (exp_cfr != null) {
      if (!compare_values(exp_cfr, parsed_cfr)) {
        // When parsed conform is 0, AE may report native_frame_rate
        const native = dict_get<string, ToDictValue, number>(parsed_source, "native_frame_rate", 0);
        if (parsed_cfr === 0 && compare_values(exp_cfr, native)) {
          // AE reported native rate as conform rate
        } else {
          result.add_diff(`${source_path}.conformFrameRate`, exp_cfr, parsed_cfr, "footage");
        }
      }
    }

    // Track manually-compared fields
    result.track_field("FootageSource", "file", exp_source.has("filePath"));
    result.track_field("FootageSource", "missing_footage_path", exp_source.has("missingFootagePath"));
    // FileSource-specific fields
    if (exp_source.has("filePath")) {
      const exp_file = getitem<string, string | null>(exp_source, "filePath");
      const parsed_file = dict_get<string, string | null, string>(parsed_source, "file", "");
      // Compare only the filename portion. PureWindowsPath splits on
      // both / and \ on every host OS (AE stores Windows-style paths,
      // and a parsed sequence frame path mixes the two); plain Path
      // fails to split backslashes when the validator runs on POSIX.
      if (exp_file && parsed_file) {
        const exp_name = new PureWindowsPath(exp_file).name;
        const parsed_name = new PureWindowsPath(parsed_file).name;
        if (exp_name !== parsed_name) {
          result.add_diff(`${source_path}.fileName`, exp_name, parsed_name, "footage");
        }
      }
    }

    if (exp_source.has("missingFootagePath")) {
      const exp_missing = getitem<string, ToDictValue>(exp_source, "missingFootagePath");
      const parsed_missing = dict_get<string, ToDictValue, string>(parsed_source, "missing_footage_path", "");
      if (py_bool(exp_missing) && !py_eq(exp_missing, parsed_missing)) {
        result.add_diff(`${source_path}.missingFootagePath`, exp_missing, parsed_missing, "footage");
      }
    }
  }

  // Compare proxySource
  _compare_proxy_source(expected_item, parsed_item, path, result);
}

export function compare_settings(
  expected_settings: Dict,
  parsed_settings: Dict | null,
  path: string,
  result: ValidationResult,
): void {
  /**
   * Compare render settings.
   *
   * Render settings are now stored as raw integer values with ExtendScript keys.
   */
  if (parsed_settings == null) {
    result.add_diff(`${path}`, "exists", "missing", "renderqueue");
    return;
  }

  // Map expected JSON keys to parsed keys (both use AE getSettings keys)
  const settings_mappings: Record<string, string> = {};
  for (const key of [
    "Quality",
    "Effects",
    "Proxy Use",
    "Motion Blur",
    "Frame Blending",
    "Field Render",
    "Guide Layers",
    "Solo Switches",
    "Color Depth",
    "Time Span",
    "Time Span Start",
    "Time Span Duration",
    "Time Span End",
    "Use comp's frame rate",
    "Use this frame rate",
    "Frame Rate",
    "Skip Existing Files",
    "Disk Cache",
    "3:2 Pulldown",
  ]) {
    settings_mappings[key] = key;
  }

  _compare_fields(expected_settings, parsed_settings, settings_mappings, path, "renderqueue", result, "RenderSettings");
}

export function compare_output_module_settings(
  expected_settings: Dict | null,
  parsed_settings: Dict | null,
  path: string,
  result: ValidationResult,
): void {
  /**
   * Compare output module settings.
   *
   * Output module settings are stored as a dict with ExtendScript keys.
   */
  if (expected_settings == null) return;
  if (parsed_settings == null) {
    result.add_diff(`${path}`, "exists", "missing", "renderqueue");
    return;
  }

  // Compare output module settings with identical keys
  const om_settings_mappings: Record<string, string> = {};
  for (const key of [
    "Video Output",
    "Output Audio",
    "Format",
    "Channels",
    "Depth",
    "Color",
    "Lock Aspect Ratio",
    "Resize",
    "Resize Quality",
    "Audio Bit Depth",
    "Audio Channels",
    "Audio Sample Rate",
    "Include Source XMP Metadata",
    "Include Project Link",
    "Post-Render Action",
    "Use Region of Interest",
    "Use Comp Frame Number",
    "Starting #",
    "Crop",
  ]) {
    om_settings_mappings[key] = key;
  }

  _compare_fields(expected_settings, parsed_settings, om_settings_mappings, path, "renderqueue", result, "OMSettings");
}

export function compare_render_queue(
  expected_rq: Dict,
  parsed_rq: Dict,
  result: ValidationResult,
  verbose = false,
): void {
  /** Compare render queue items. */
  const expected_items: Dict[] = dict_get(expected_rq, "items", []);
  const parsed_items: Dict[] = dict_get(parsed_rq, "items", []);

  if (expected_items.length !== parsed_items.length) {
    result.add_diff("RenderQueue.numItems", expected_items.length, parsed_items.length, "renderqueue");
    if (verbose) {
      console.log(
        `  Item count mismatch: expected ${expected_items.length}, got ${parsed_items.length}`,
      );
    }
  }

  // Compare each render queue item
  for (const [i, exp_item] of expected_items.entries()) {
    if (i >= parsed_items.length) {
      result.add_diff(`RenderQueueItem[${i}]`, "exists", "missing", "renderqueue");
      continue;
    }

    const parsed_item = parsed_items[i];
    const path = `RenderQueueItem[${i}]`;

    // Compare RQ item-level fields
    const rqi_mappings = {
      status: "status",
      render: "render",
      skipFrames: "skip_frames",
      logType: "log_type",
      elapsedSeconds: "elapsed_seconds",
      comment: "comment",
      compName: "comp_name",
      queueItemNotify: "queue_item_notify",
      timeSpanStart: "time_span_start",
      timeSpanDuration: "time_span_duration",
    };
    _compare_fields(exp_item, parsed_item, rqi_mappings, path, "renderqueue", result, "RenderQueueItem");

    // Compare render settings
    if (exp_item.has("settings")) {
      compare_settings(getitem(exp_item, "settings"), parsed_item.get("settings") ?? null, `${path}.settings`, result);
    }

    // Compare output modules
    const exp_oms: Dict[] = dict_get(exp_item, "outputModules", []);
    const parsed_oms: Dict[] = dict_get(parsed_item, "output_modules", []);

    if (exp_oms.length !== parsed_oms.length) {
      result.add_diff(`${path}.numOutputModules`, exp_oms.length, parsed_oms.length, "renderqueue");
    }

    for (const [j, exp_om] of exp_oms.entries()) {
      if (j >= parsed_oms.length) {
        result.add_diff(`${path}.outputModule[${j}]`, "exists", "missing", "renderqueue");
        continue;
      }

      const parsed_om = parsed_oms[j];
      const om_path = `${path}.outputModule[${j}]`;

      // Compare output module-level fields
      const om_mappings = {
        name: "name",
        includeSourceXMP: "include_source_xmp",
        postRenderAction: "post_render_action",
      };
      _compare_fields(exp_om, parsed_om, om_mappings, om_path, "renderqueue", result, "OutputModule");

      // Compare output module file (path comparison)
      result.track_field("OutputModule", "file", exp_om.has("file"));
      if (exp_om.has("file")) {
        const exp_file = getitem(exp_om, "file");
        const parsed_file = dict_get(parsed_om, "file", "");
        if (exp_file && py_bool(parsed_file)) {
          // See the footage-source note: PureWindowsPath keeps
          // basename extraction host-OS-independent.
          const exp_name = new PureWindowsPath(exp_file).name;
          const parsed_name = new PureWindowsPath(str(parsed_file)).name;
          if (exp_name !== parsed_name) {
            result.add_diff(`${om_path}.fileName`, exp_name, parsed_name, "renderqueue");
          }
        }
      }

      // Compare output module settings
      if (exp_om.has("settings")) {
        compare_output_module_settings(
          getitem(exp_om, "settings"),
          getitem(parsed_om, "settings"),
          `${om_path}.settings`,
          result,
        );
      }
    }
  }
}

export function compare_viewer(
  expected_viewer: Dict,
  parsed_viewer: Dict,
  result: ValidationResult,
): void {
  /**
   * Compare active viewer properties.
   *
   * @param expected_viewer - Expected activeViewer from ExtendScript JSON.
   * @param parsed_viewer - Parsed active_viewer dict from py_aep.
   * @param result - ValidationResult to accumulate differences.
   */
  const viewer_mappings: Record<string, string> = {
    type: "type",
  };
  _compare_fields(expected_viewer, parsed_viewer, viewer_mappings, "Viewer", "viewer", result, "Viewer");

  const exp_views: Dict[] = dict_get(expected_viewer, "views", []);
  const parsed_views: Dict[] = dict_get(parsed_viewer, "views", []);
  if (exp_views.length !== parsed_views.length) {
    result.add_diff("Viewer.views.length", exp_views.length, parsed_views.length, "viewer");
  }

  for (const [i, [exp_view, parsed_view]] of zip(exp_views, parsed_views).entries()) {
    const path = `Viewer.views[${i}]`;

    const exp_opts = dict_get(exp_view, "options", new Map());
    const parsed_opts = dict_get(parsed_view, "options", new Map());
    const opts_path = `${path}.options`;
    const opts_mappings: Record<string, string> = {
      channels: "channels",
      checkerboards: "checkerboards",
      exposure: "exposure",
      fastPreview: "fast_preview",
      zoom: "zoom",
      guidesVisibility: "guides_visibility",
      guidesSnap: "guides_snap",
      guidesLocked: "guides_locked",
      rulers: "rulers",
    };
    _compare_fields(exp_opts, parsed_opts, opts_mappings, opts_path, "viewer", result, "ViewOptions");
  }
}

export function validate_aep(
  aep_path: Path,
  json_path: Path,
  verbose = false,
  category_filter: string | null = null,
): ValidationResult {
  /**
   * Validate parsed AEP against expected JSON.
   *
   * @param aep_path - Path to .aep file.
   * @param json_path - Path to expected JSON (from ExtendScript export).
   * @param verbose - Whether to print detailed progress.
   * @param category_filter - Only show differences from this category.
   * @returns ValidationResult containing all differences.
   */
  const result = new ValidationResult();

  // Parse AEP
  if (verbose) console.log(`Parsing: ${aep_path.name}`);
  const app = parse(aep_path);
  const project = app.project;
  const parsed = to_dict(project);

  // Load expected JSON
  // Python `open(encoding="utf-8")`: bytes are decoded without dropping a BOM.
  const loaded = json_loads(decode(json_path.read_bytes(), "utf-8"));
  if (!(loaded instanceof Map)) throw new AttributeError(`'${type_name(loaded)}' object has no attribute 'get'`);
  const expected: Dict = loaded;

  // Compare project-level properties
  if (verbose) console.log("\n=== Comparing Project Properties ===");
  compare_project_level(expected, parsed, result);

  // Get expected items
  const expected_items: Dict[] = dict_get(expected, "items", []);
  const comps = expected_items.filter((i: Dict) => (i.get("itemType") ?? null) === "CompItem");

  // Compare compositions
  if (verbose) console.log("\n=== Comparing Compositions ===");
  const parsed_by_id = new Map<number, Dict>(project.compositions.map((comp) => [comp.id, to_dict(comp)]));

  for (const exp_item of comps) {
    const item_id = getitem(exp_item, "id");
    const item_name = getitem(exp_item, "name");

    if (!parsed_by_id.has(item_id)) {
      result.add_diff(`Comp[${item_name}]`, "exists", "missing", "composition");
      if (verbose) console.log(`  ${item_name} (id=${item_id}): MISSING!`);
      continue;
    }

    const parsed_comp = getitem(parsed_by_id, item_id);
    const before_count = len(result);
    compare_comp_item(exp_item, parsed_comp, `Comp[${item_name}]`, result);

    if (verbose) {
      const diff_count = len(result) - before_count;
      if (diff_count > 0) {
        console.log(`  ${item_name} (id=${item_id}): ${diff_count} differences`);
      } else {
        console.log(`  ${item_name} (id=${item_id}): OK`);
      }
    }
  }

  // Compare folder hierarchy
  if (verbose) console.log("\n=== Comparing Folder Hierarchy ===");
  compare_folder_hierarchy(expected_items, dict_get(parsed, "items", new Map()), result);

  // Compare footage items
  if (verbose) console.log("\n=== Comparing Footage Items ===");
  const expected_footage = expected_items.filter((i: Dict) => (i.get("itemType") ?? null) === "FootageItem");
  const parsed_items_dict: Map<number, Dict> = dict_get(parsed, "items", new Map());
  const parsed_footage_by_id = new Map<number, Dict>();
  for (const [item_id, item] of parsed_items_dict) {
    if (dict_get(item, "type_name") === "Footage") parsed_footage_by_id.set(item_id, item);
  }

  for (const exp_fi of expected_footage) {
    const fi_id = getitem(exp_fi, "id");
    const fi_name = getitem(exp_fi, "name");

    const parsed_fi = parsed_footage_by_id.get(fi_id) ?? null;
    if (parsed_fi == null) {
      result.add_diff(`Footage[${fi_name}]`, "exists", "missing", "footage");
      if (verbose) console.log(`  ${fi_name} (id=${fi_id}): MISSING!`);
      continue;
    }

    const before_count = len(result);
    compare_footage_item(exp_fi, parsed_fi, `Footage[${fi_name}]`, result);

    if (verbose) {
      const diff_count = len(result) - before_count;
      if (diff_count > 0) {
        console.log(`  ${fi_name} (id=${fi_id}): ${diff_count} differences`);
      } else {
        console.log(`  ${fi_name} (id=${fi_id}): OK`);
      }
    }
  }

  // Compare render queue
  if (verbose) console.log("\n=== Comparing Render Queue ===");
  const expected_rq = dict_get(expected, "renderQueue", new Map());
  compare_render_queue(expected_rq, dict_get(parsed, "render_queue", new Map()), result, verbose);

  // Compare active viewer
  const expected_viewer = expected.get("activeViewer") ?? null;
  if (expected_viewer != null && app.active_viewer != null) {
    if (verbose) console.log("\n=== Comparing Viewer ===");
    const parsed_viewer = to_dict(app.active_viewer);
    compare_viewer(expected_viewer, parsed_viewer, result);
    if (verbose) console.log("  Done");
  } else if (expected_viewer != null && verbose) {
    console.log("\n=== Comparing Viewer ===");
    console.log("  Skipped (no viewer data in binary)");
  }

  return result;
}

export function print_results(
  result: ValidationResult,
  verbose = false,
  category_filter: string | null = null,
): void {
  /** Print validation results. */
  console.log("\n" + "=".repeat(60));

  if (!result.differences?.length) {
    console.log("SUCCESS: All parsed values match expected values!");
    return;
  }

  let filtered_diffs = result.differences;
  if (category_filter) {
    // Filter by category prefix
    const needle = category_filter.toLowerCase();
    filtered_diffs = result.differences.filter((d) => d.toLowerCase().includes(needle));
  }

  console.log(`TOTAL DIFFERENCES FOUND: ${result.differences.length}`);

  if (category_filter) {
    console.log(`(Showing ${filtered_diffs.length} matching filter '${category_filter}')`);
  }

  console.log("\nDifferences by category:");
  for (const [cat, count] of sorted(result.categories.entries())) {
    console.log(`  ${cat}: ${count}`);
  }

  if (verbose && filtered_diffs?.length > 0) {
    console.log("\nAll differences:");
    for (const d of filtered_diffs.slice(0, 200)) {
      // Limit output
      console.log(`  ${d}`);
    }
    if (filtered_diffs.length > 200) {
      console.log(`  ... and ${filtered_diffs.length - 200} more`);
    }
  }
}

export function print_coverage(result: ValidationResult): void {
  /** Print field coverage report. */
  const compared = sorted(result.compared_fields);
  const not_compared = sorted([...result.defined_fields].filter((x) => !result.compared_fields.has(x)));

  console.log(`\n${"=".repeat(60)}`);
  console.log("FIELD COVERAGE REPORT");
  console.log(`${"=".repeat(60)}`);
  console.log(`\nCompared (${compared.length}):\n  ` + compared.join("\n  "));
  console.log(`\nNot compared (${not_compared.length}):`);
  if (not_compared?.length > 0) {
    console.log("  " + not_compared.join("\n  "));
  } else {
    console.log("  (none)");
  }
}

export const _CATEGORY_CHOICES: readonly string[] = [
  "project",
  "composition",
  "layers",
  "properties",
  "markers",
  "folders",
  "footage",
  "keyframes",
  "textdocument",
  "renderqueue",
  "viewer",
];

export const _USAGE =
  "usage: validate.py [-h] [-v] [-c {project,composition,layers,properties,markers,folders,footage,keyframes,textdocument,renderqueue,viewer}] [--coverage] aep_file json_file";

// TODO(port): no argparse in TS. _HELP is a hand-written copy of argparse's help layout
// (differs from argparse only if the terminal COLUMNS wraps it), and combined short flags
// (`-vc layers`) are rejected as unrecognized; long-option prefixes (`--verb`) are handled.
export const _HELP = `${_USAGE}

Validate parsed AEP values against expected JSON from ExtendScript export.

positional arguments:
  aep_file              Path to .aep file
  json_file             Path to expected JSON file

options:
  -h, --help            show this help message and exit
  -v, --verbose         Print detailed progress
  -c {${_CATEGORY_CHOICES.join(",")}}, --category {${_CATEGORY_CHOICES.join(",")}}
                        Filter differences by category
  --coverage            Print field coverage report (compared vs not-compared fields)`;

/** `parser.error(message)`: usage and message to stderr, then exit status 2. */
export function _parser_error(message: string): never {
  console.error(_USAGE);
  console.error(`validate.py: error: ${message}`);
  process.exit(2);
}

/** `parser.parse_args(args)` for the flags this tool declares. */
export function _parse_args(argv: string[]): {
  aep_file: Path;
  json_file: Path;
  verbose: boolean;
  category: string | null;
  coverage: boolean;
} {
  const positionals: string[] = [];
  let verbose = false;
  let category: string | null = null;
  let coverage = false;
  const long_options = ["--help", "--verbose", "--category", "--coverage"];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith("--") && a.length > 2) {
      // argparse accepts any unambiguous prefix of a long option.
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!long_options.includes(name)) {
        const hits = long_options.filter((o) => o.startsWith(name));
        if (hits.length === 1) a = hits[0] + (eq === -1 ? "" : a.slice(eq));
        else if (hits.length > 1) {
          _parser_error(`ambiguous option: ${name} could match ${hits.join(", ")}`);
        }
      }
    }
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") {
      console.log(_HELP);
      process.exit(0);
    }
    if (a === "-v" || a === "--verbose") {
      verbose = true;
    } else if (a === "--coverage") {
      coverage = true;
    } else if (a === "-c" || a === "--category" || a.startsWith("--category=") || (a.startsWith("-c") && !a.startsWith("--") && a.length > 2)) {
      let value: string;
      if (a.startsWith("--category=")) {
        value = a.slice("--category=".length);
      } else if (a.startsWith("-c") && !a.startsWith("--") && a.length > 2) {
        value = a.slice(2);
      } else {
        if (i + 1 >= argv.length) _parser_error("argument -c/--category: expected one argument");
        value = argv[++i];
      }
      if (!_CATEGORY_CHOICES.includes(value)) {
        _parser_error(
          `argument -c/--category: invalid choice: '${value}' (choose from ${_CATEGORY_CHOICES.map((c) => `'${c}'`).join(", ")})`,
        );
      }
      category = value;
    } else if (a.startsWith("-") && a !== "-") {
      _parser_error(`unrecognized arguments: ${a}`);
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length < 2) {
    _parser_error(`the following arguments are required: ${["aep_file", "json_file"].slice(positionals.length).join(", ")}`);
  }
  if (positionals.length > 2) {
    _parser_error(`unrecognized arguments: ${positionals.slice(2).join(" ")}`);
  }
  return {
    aep_file: new Path(positionals[0]),
    json_file: new Path(positionals[1]),
    verbose,
    category,
    coverage,
  };
}

/** Main entry point. */
export function main(args: string[] | null = null): number {
  const parsed_args = _parse_args(args ?? process.argv.slice(2));

  if (!parsed_args.aep_file.exists()) {
    console.log(`Error: AEP file not found: ${parsed_args.aep_file}`);
    return 1;
  }

  if (!parsed_args.json_file.exists()) {
    console.log(`Error: JSON file not found: ${parsed_args.json_file}`);
    return 1;
  }

  console.log(`Validating: ${parsed_args.aep_file.name}`);
  console.log(`Expected:   ${parsed_args.json_file.name}`);

  const result = validate_aep(parsed_args.aep_file, parsed_args.json_file, parsed_args.verbose, parsed_args.category);

  print_results(result, parsed_args.verbose, parsed_args.category);

  if (parsed_args.coverage) print_coverage(result);

  return !result.differences?.length ? 0 : 1;
}

// `if __name__ == "__main__": sys.exit(main())`
if (import.meta.main) process.exit(main());
