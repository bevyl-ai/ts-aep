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
  typeName,
  KeyError,
  Path,
  attrsHas,
  decode,
  descriptorsOf,
  fields,
  getOrThrow,
  isclose,
  truthy,
  valueEquals,
  literal,
  getOrInsert,
  zip,
  isReal,
  parseJson,
  PureWindowsPath,
  type BoxedFloat,
  compare,
} from "../../pyrt/index.ts";
import { parseCommandLine, runMain, usageError, type Command } from "./args.ts";

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
  "containingComp",
  "parentFolder",
  "parentProperty",
  "parent",
  "comp",
  "postRenderTargetComp",
  // Internal marker property (Property with keyframes); compared
  // separately via _compare_markers.
  "markerProperty",
  // Cross-reference: LightLayer.lightSource > Layer
  "lightSource",
]);

// @property attributes that return complex/duplicate data and should not be
// included in to_dict() serialization.
export const SKIP_PROPERTIES: ReadonlySet<string> = new Set([
  "activeCamera",
  "compositionLayers",
  "footageLayers",
  "selected_layers",
  // Circular: AVLayer.source > Item > layers > AVLayer...
  "source",
  // Circular: AVLayer.trackMatteLayer > AVLayer
  "trackMatteLayer",
  // Circular: AVItem.usedIn > list[CompItem] > layers > source > AVItem...
  "usedIn",
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
  // Duplicate: Property.separationLeader > Property
  "separationLeader",
  // Layer.marker @property: duplicates ADBE Marker in properties tree.
  "marker",
]);

export const _fieldNamesCache = new Map<Function, readonly string[] | null>();

/**
 * Accessor (getter/setter) names on `cls` and its bases: the class-level
 * `property` objects that `isinstance(attr, property)` finds in Python.
 */
export function _propertyAccessors(cls: Function): string[] {
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
 * children and populate caches, and `_toDict` memoizes the first
 * result it reaches a shared object by. Iterating a set therefore let
 * `PYTHONHASHSEED` decide what the report said - two runs over the same
 * project disagreed on whether an effect had all of its parameters.
 *
 * Results are cached per type since field names are class-level metadata.
 */
export function _getFieldNames(obj: object): readonly string[] | null {
  const cls = obj.constructor;
  const cached = _fieldNamesCache.get(cls);
  if (cached !== undefined) return cached;

  const names = new Set<string>();
  // `is_dataclass(obj) and not isinstance(obj, type)`: attrs classes stand in for dataclasses.
  if (attrsHas(cls)) {
    for (const f of fields(cls)) names.add(f.name);
  }
  // TODO(port): Python also collects `__annotations__` from the full MRO here. TS erases
  // type annotations at runtime, so a field that is only annotated (neither an attrs field
  // nor a chunkAttr/dictAttr descriptor) on a plain class is not enumerated.
  // Collect annotations and chunk-backed descriptors from the full MRO.
  // This covers plain-class models and also dataclass subclasses that
  // add chunk descriptors in non-dataclass bases (e.g. Layer extends
  // PropertyGroup with ChunkField descriptors).
  for (const [name, attr] of descriptorsOf(cls)) {
    // ChunkField (binary-backed) and CosField (COS-dict-backed)
    // descriptors both expose a backing-store attribute name.
    const isDescriptor = "chunkAttr" in attr || "dictAttr" in attr;
    if (isDescriptor && typeof attr.get === "function") names.add(name);
  }
  if (names.size > 0) {
    const result = [...names].sort(compare);
    _fieldNamesCache.set(cls, result);
    return result;
  }
  // Check for public @property definitions (descriptor-backed classes
  // that replaced all class-level annotations with properties).
  const descriptors = descriptorsOf(cls);
  for (const name of _propertyAccessors(cls)) {
    if (!name.startsWith("_") && !descriptors.has(name)) names.add(name);
  }
  const result2: readonly string[] | null = names.size > 0 ? [...names].sort(compare) : null;
  _fieldNamesCache.set(cls, result2);
  return result2;
}

export const _propertyNamesCache = new Map<Function, readonly string[]>();

/**
 * Get public \@property names for a class, cached per type.
 *
 * Sorted for the same reason as `_getFieldNames`.
 */
export function _getPropertyNames(cls: Function): readonly string[] {
  const cached = _propertyNamesCache.get(cls);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  // `dir(cls)` + `isinstance(attr, property)`: descriptor-backed fields are not
  // Python `property` objects, so registered descriptors are excluded.
  const descriptors = descriptorsOf(cls);
  for (const name of _propertyAccessors(cls)) {
    if (name.startsWith("_") || SKIP_FIELDS.has(name) || SKIP_PROPERTIES.has(name)) continue;
    if (descriptors.has(name)) continue;
    names.add(name);
  }
  const result = [...names].sort(compare);
  _propertyNamesCache.set(cls, result);
  return result;
}

export const _PRIMITIVE_TYPES: readonly string[] = ["number", "bigint", "string", "boolean"];

/**
 * A value `toDict` walks or returns, or the ExtendScript JSON value it is
 * compared with: a primitive, a list or Map of such values (a model object
 * becomes a `Dict` of its fields), or another object, which `toDict`
 * returns unchanged (bytes, sets, callables, `BoxedFloat`, `String` objects).
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
 * What `toDict` makes of a `T`: primitives, bytes, sets, callables, `BoxedFloat`
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
  | BoxedFloat
  | ArrayBufferView
  | ReadonlySet<ToDictValue>
  | Function
  ? T
  : T extends readonly (infer U)[]
    ? ToDict<U>[]
    : Dict;

/** Convert dataclass/enum to dict recursively, skipping circular reference fields. */
export function toDict<T extends ToDictValue>(obj: T): ToDict<T>;
export function toDict(obj: ToDictValue): ToDictValue {
  return _toDict(obj, new Map());
}

/**
 * Recursive worker for `toDict`, memoized on object identity.
 *
 * The model is a DAG, not a tree: the same layer is reachable through
 * `CompItem.layers`, `avLayers`, `layersById`, `fileLayers`, ... and the
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
export function _toDict(obj: ToDictValue, memo: Map<object, [object, ToDictValue]>): ToDictValue {
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
    typeof obj !== "object"
  ) {
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((item) => _toDict(item, memo));
  if (obj instanceof Map) {
    const out: Dict = new Map();
    for (const [k, v] of obj) out.set(k, _toDict(v, memo));
    return out;
  }
  const fieldNames = _getFieldNames(obj);
  if (fieldNames !== null) {
    const cached = memo.get(obj);
    if (cached !== undefined) return cached[1];
    const result: Dict = new Map();
    memo.set(obj, [obj, result]);
    for (const name of fieldNames) {
      if (SKIP_FIELDS.has(name)) continue;
      let value: ToDictValue;
      try {
        value = Reflect.get(obj, name);
      } catch (e) {
        // missing chunk or field
        if (!(e instanceof AttributeError || e instanceof KeyError)) throw e;
        continue;
      }
      // A missing attribute (Python AttributeError) reads as undefined here; None is null.
      if (value === undefined) continue;
      result.set(name, _toDict(value, memo));
    }
    // Include @property attributes (non-private, non-skipped)
    for (const name of _getPropertyNames(obj.constructor)) {
      if (result.has(name)) continue;
      let value: ToDictValue;
      try {
        value = Reflect.get(obj, name);
      } catch (e) {
        // missing chunk or field
        if (!(e instanceof AttributeError || e instanceof KeyError)) throw e;
        continue;
      }
      if (value === undefined) continue;
      result.set(name, _toDict(value, memo));
    }
    return result;
  }
  return obj;
}

/** Get enum value as int if it's an IntEnum, else return as-is. */
export function getEnumValue<T>(val: T): T {
  // Enum members are their own values in the TS port (pyrt enum.ts): `val.value` is `val`.
  return val;
}

export const _CAMEL_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

/** Convert camelCase dict keys to snake_case recursively. */
export function _normalizeKeys(d: Dict): Dict {
  const result: Dict = new Map();
  for (const [key, value0] of d) {
    const snakeKey = key.replace(_CAMEL_RE, "_").toLowerCase();
    const value = value0 instanceof Map ? _normalizeKeys(value0) : value0;
    result.set(snakeKey, value);
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
export function compareValues(expected: ToDictValue, parsed: ToDictValue, tolerance = 0.001): boolean {
  if (expected == null && parsed == null) return true;
  if (expected == null || parsed == null) return false;
  if (typeof expected === "boolean" && typeof parsed === "boolean") return expected === parsed;
  // `isinstance(x, (int, float))` also holds for bool (and a bigint int).
  const isNum = (x: ToDictValue): boolean => isReal(x) || typeof x === "boolean" || typeof x === "bigint";
  if (isNum(expected) && isNum(parsed)) {
    return isclose(Number(expected), Number(parsed), tolerance, tolerance);
  }
  if (typeof expected === "string" && typeof parsed === "string") return expected === parsed;
  if (Array.isArray(expected) && Array.isArray(parsed)) {
    if (expected.length !== parsed.length) return false;
    return expected.every((e, i) => compareValues(e, parsed[i], tolerance));
  }
  return valueEquals(expected, parsed);
}

export class ValidationResult {
  /** Stores validation results. */
  declare differences: string[];
  declare warnings: string[];
  declare categories: Map<string, number>;
  declare definedFields: Set<string>;
  declare comparedFields: Set<string>;

  constructor() {
    this.differences = [];
    this.warnings = [];
    this.categories = new Map();
    this.definedFields = new Set();
    this.comparedFields = new Set();
  }

  get length(): number {
    return this.differences.length;
  }

  /** Add a difference. */
  addDiff(path: string, expected: ToDictValue, parsed: ToDictValue, category = "other"): void {
    this.differences.push(`${path}: expected ${literal(expected)}, got ${literal(parsed)}`);
    this.categories.set(category, (this.categories.get(category) ?? 0) + 1);
  }

  /** Add a warning. */
  addWarning(message: string): void {
    this.warnings.push(message);
  }

  /** Register a field for coverage tracking. */
  trackField(className: string, attr: string, wasCompared: boolean): void {
    const key = `${className}.${attr}`;
    this.definedFields.add(key);
    if (wasCompared) this.comparedFields.add(key);
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
export function _compareFields(
  expected: Dict,
  parsed: Dict,
  mappings: Record<string, string>,
  path: string,
  category: string,
  result: ValidationResult,
  className = "",
): void {
  for (const [expKey, parsedKey] of Object.entries(mappings)) {
    if (className) result.definedFields.add(`${className}.${parsedKey}`);
    if (expected.has(expKey)) {
      const expVal = expected.get(expKey);
      if (expVal instanceof Map && truthy(expVal.get("_undefined"))) continue;
      if (className) result.comparedFields.add(`${className}.${parsedKey}`);
      const parsedVal = getEnumValue(parsed.get(parsedKey) ?? null);
      if (!compareValues(expVal, parsedVal)) {
        result.addDiff(`${path}.${expKey}`, expVal, parsedVal, category);
      }
    }
  }
}

/** Compare a list of markers (used by both layers and compositions). */
export function _compareMarkers(
  expectedMarkers: Dict[],
  parsedMarkers: Dict[],
  path: string,
  frameRate: number,
  result: ValidationResult,
): void {
  if (expectedMarkers.length !== parsedMarkers.length) {
    result.addDiff(`${path}.numMarkers`, expectedMarkers.length, parsedMarkers.length, "markers");
  }
  for (const [i, [expMarker, parsedMarker]] of zip(expectedMarkers, parsedMarkers).entries()) {
    compareMarker(expMarker, parsedMarker, `${path}.markers[${i}]`, frameRate, result);
  }
}

/** Compare a list of guides. */
export function _compareGuides(
  expectedGuides: Dict[],
  parsedGuides: Dict[],
  path: string,
  result: ValidationResult,
): void {
  if (expectedGuides.length !== parsedGuides.length) {
    result.addDiff(`${path}.numGuides`, expectedGuides.length, parsedGuides.length, "composition");
  }
  const guideMappings = {
    orientationType: "orientationType",
    position: "position",
    positionType: "positionType",
  };
  for (const [i, [expGuide, parsedGuide]] of zip(expectedGuides, parsedGuides).entries()) {
    _compareFields(expGuide, parsedGuide, guideMappings, `${path}.guides[${i}]`, "composition", result, "Guide");
  }
}

/** Compare proxySource on an AVItem (comp or footage). */
export function _compareProxySource(
  expectedItem: Dict,
  parsedItem: Dict,
  path: string,
  result: ValidationResult,
): void {
  const expProxy = expectedItem.get("proxySource") ?? null;
  const parsedProxy = parsedItem.get("proxySource") ?? null;
  if (truthy(expProxy) && truthy(parsedProxy)) {
    const proxyPath = `${path}.proxySource`;
    const sourceMappings = {
      alphaMode: "alphaMode",
      displayFrameRate: "displayFrameRate",
      fieldSeparationType: "fieldSeparationType",
      hasAlpha: "hasAlpha",
      highQualityFieldSeparation: "highQualityFieldSeparation",
      invertAlpha: "invertAlpha",
      isStill: "isStill",
      loop: "loop",
      nativeFrameRate: "nativeFrameRate",
      premulColor: "premulColor",
      removePulldown: "removePulldown",
      color: "color",
    };
    _compareFields(expProxy, parsedProxy, sourceMappings, proxyPath, "footage", result, "FootageSource");
  } else if (truthy(expProxy) && !truthy(parsedProxy)) {
    result.addDiff(`${path}.proxySource`, "present", "None", "footage");
  } else if (!truthy(expProxy) && truthy(parsedProxy)) {
    result.addDiff(`${path}.proxySource`, "None", "present", "footage");
  }
}

/** Match expected/parsed property children by matchName, then recurse. */
export function _compareChildrenByMatchName(
  expectedProps: Dict[],
  parsedProps: Dict[],
  path: string,
  result: ValidationResult,
): void {
  if (expectedProps.length !== parsedProps.length) {
    result.addDiff(`${path}.numProperties`, expectedProps.length, parsedProps.length, "properties");
  }

  // Build match-name lookup.  When multiple children share the same
  // match_name (e.g. masks, duplicate effects), store them in order so we
  // can fall back to positional matching within each match_name group.
  const parsedByMatchName = new Map<string, Dict[]>();
  for (const p of parsedProps) {
    const mn = p.has("matchName") ? p.get("matchName") : "";
    if (truthy(mn)) getOrInsert(parsedByMatchName, mn, []).push(p);
  }

  // Track how many of each match_name we have consumed.
  const matchNameIdx = new Map<string, number>();

  for (const [i, expProp] of expectedProps.entries()) {
    const expMatchName = expProp.has("matchName") ? expProp.get("matchName") : "";
    const expName = expProp.has("name") ? expProp.get("name") : `[${i}]`;
    const childPath = `${path}.${expName}`;

    const candidates = parsedByMatchName.get(expMatchName);
    if (!candidates?.length) {
      result.addDiff(childPath, "exists", "missing", "properties");
      continue;
    }

    const idx = matchNameIdx.get(expMatchName) ?? 0;
    let parsedProp: Dict;
    if (idx < candidates.length) {
      parsedProp = candidates[idx];
      matchNameIdx.set(expMatchName, idx + 1);
    } else {
      parsedProp = candidates[candidates.length - 1];
    }

    const hasChildProperties = expProp.has("properties");
    const expPropertyType = expProp.get("propertyType") ?? null;
    if (hasChildProperties || expPropertyType === "IndexedGroup") {
      comparePropertyGroup(expProp, parsedProp, childPath, result);
    } else {
      compareProperty(expProp, parsedProp, childPath, result);
    }
  }
}

/** Compare project-level properties. */
export function compareProjectLevel(expected: Dict, parsed: Dict, result: ValidationResult): void {
  const mappings = {
    bitsPerChannel: "bitsPerChannel",
    transparencyGridThumbnails: "transparencyGridThumbnails",
    displayStartFrame: "displayStartFrame",
    framesCountType: "framesCountType",
    feetFramesFilmType: "feetFramesFilmType",
    framesUseFeetFrames: "framesUseFeetFrames",
    timeDisplayType: "timeDisplayType",
    footageTimecodeDisplayStartType: "footageTimecodeDisplayStartType",
    expressionEngine: "expressionEngine",
    linearBlending: "linearBlending",
    workingSpace: "workingSpace",
    linearizeWorkingSpace: "linearizeWorkingSpace",
    workingGamma: "workingGamma",
    gpuAccelType: "gpuAccelType",
  };

  _compareFields(expected, parsed, mappings, "Project", "project", result, "Project");
}

/** Compare marker properties. */
export function compareMarker(
  expectedMarker: Dict,
  parsedMarker: Dict,
  path: string,
  frameRate: number,
  result: ValidationResult,
): void {
  // Calculate time from frame_time if available
  let parsedTime: number | null = null;
  if (parsedMarker.get("frameTime") != null) {
    parsedTime = Number(getOrThrow(parsedMarker, "frameTime")) / frameRate;
  }

  // Compare time
  result.trackField("Marker", "time", expectedMarker.has("time"));
  if (expectedMarker.has("time")) {
    const expVal = getOrThrow(expectedMarker, "time");
    if (!(expVal instanceof Map) || !truthy(expVal.get("_undefined"))) {
      if (!compareValues(expVal, parsedTime)) {
        result.addDiff(`${path}.time`, expVal, parsedTime, "markers");
      }
    }
  }

  const markerMappings = {
    comment: "comment",
    chapter: "chapter",
    url: "url",
    duration: "duration",
    label: "label",
    cuePointName: "cuePointName",
    frameTarget: "frameTarget",
    protectedRegion: "protectedRegion",
    eventCuePoint: "eventCuePoint",
  };

  _compareFields(expectedMarker, parsedMarker, markerMappings, path, "markers", result, "Marker");
}

/** Compare layer properties. */
export function compareLayer(
  expectedLayer: Dict,
  parsedLayer: Dict,
  path: string,
  compDuration: number,
  frameRate: number,
  result: ValidationResult,
): void {
  const layerMappings = {
    name: "name",
    id: "id",
    time: "time",
    comment: "comment",
    enabled: "enabled",
    canSetEnabled: "canSetEnabled",
    hasVideo: "hasVideo",
    hasAudio: "hasAudio",
    canSetCollapseTransformation: "canSetCollapseTransformation",
    canSetTimeRemapEnabled: "canSetTimeRemapEnabled",
    inPoint: "inPoint",
    outPoint: "outPoint",
    startTime: "startTime",
    stretch: "stretch",
    label: "label",
    locked: "locked",
    nullLayer: "nullLayer",
    shy: "shy",
    solo: "solo",
    isNameSet: "isNameSet",
    autoOrient: "autoOrient",
    matchName: "matchName",
    layerType: "layerType",
    hasTrackMatte: "hasTrackMatte",
    isTrackMatte: "isTrackMatte",
    isNameFromSource: "isNameFromSource",
    // AVLayer specific
    adjustmentLayer: "adjustmentLayer",
    audioActive: "audioActive",
    audioEnabled: "audioEnabled",
    blendingMode: "blendingMode",
    collapseTransformation: "collapseTransformation",
    effectsActive: "effectsActive",
    environmentLayer: "environmentLayer",
    frameBlending: "frameBlending",
    frameBlendingType: "frameBlendingType",
    guideLayer: "guideLayer",
    height: "height",
    width: "width",
    motionBlur: "motionBlur",
    preserveTransparency: "preserveTransparency",
    quality: "quality",
    samplingQuality: "samplingQuality",
    threeDLayer: "threeDLayer",
    timeRemapEnabled: "timeRemapEnabled",
    trackMatteType: "trackMatteType",
    sourceId: "_sourceId",
    lightType: "lightType",
    threeDPerChar: "threeDPerChar",
  };

  _compareFields(expectedLayer, parsedLayer, layerMappings, path, "layers", result, "Layer");

  // Compare index (ExtendScript is 1-based, parsed is 0-based)
  result.trackField("Layer", "index", expectedLayer.has("index"));
  result.trackField("Layer", "light_source_id", expectedLayer.has("lightSource"));
  if (expectedLayer.has("index")) {
    const expIndex = getOrThrow(expectedLayer, "index");
    const parsedIndex = parsedLayer.get("index") ?? null;
    if (parsedIndex != null && expIndex !== parsedIndex + 1) {
      result.addDiff(`${path}.index`, expIndex, parsedIndex + 1, "layers");
    }
  }

  // Compare lightSource (Layer reference -> compare by layer index)
  if (expectedLayer.has("lightSource")) {
    const expLs = getOrThrow(expectedLayer, "lightSource");
    const parsedLsId = parsedLayer.has("_lightSourceId") ? parsedLayer.get("_lightSourceId") : 0;
    if (expLs == null) {
      if (parsedLsId !== 0) {
        result.addDiff(`${path}.lightSource`, null, parsedLsId, "layers");
      }
    } else if (expLs instanceof Map) {
      const expLsIndex = expLs.get("index") ?? null;
      if (expLsIndex != null && parsedLsId === 0) {
        result.addDiff(`${path}.lightSource`, expLsIndex, null, "layers");
      }
    }
  }

  // Compare all property groups via the properties list.
  _compareChildrenByMatchName(
    expectedLayer.has("properties") ? expectedLayer.get("properties") : [],
    parsedLayer.has("properties") ? parsedLayer.get("properties") : [],
    path,
    result,
  );
}

/**
 * Compare a single property (leaf node).
 *
 * @param expectedProp - Expected property from ExtendScript JSON.
 * @param parsedProp - Parsed property from py_aep.
 * @param path - Dotted path for error messages.
 * @param result - ValidationResult to accumulate differences.
 */
export function compareProperty(expectedProp: Dict, parsedProp: Dict, path: string, result: ValidationResult): void {
  const propertyMappings = {
    name: "name",
    matchName: "matchName",
    enabled: "enabled",
    canSetEnabled: "canSetEnabled",
    canSetExpression: "canSetExpression",
    canVaryOverTime: "canVaryOverTime",
    expression: "expression",
    expressionEnabled: "expressionEnabled",
    propertyValueType: "propertyValueType",
    propertyDepth: "propertyDepth",
    dimensionsSeparated: "dimensionsSeparated",
    isSpatial: "isSpatial",
    elided: "elided",
    isEffect: "isEffect",
    isMask: "isMask",
    isModified: "isModified",
    isSeparationLeader: "isSeparationLeader",
    isSeparationFollower: "isSeparationFollower",
    unitsText: "unitsText",
    separationDimension: "separationDimension",
    canSetAlternateSource: "canSetAlternateSource",
  };

  _compareFields(expectedProp, parsedProp, propertyMappings, path, "properties", result, "Property");

  // Track manually-compared fields
  result.trackField("Property", "propertyIndex", expectedProp.has("propertyIndex"));
  result.trackField("Property", "value", expectedProp.has("value"));
  result.trackField("Property", "keyframes", expectedProp.has("numKeys"));
  result.trackField("Property", "minValue", expectedProp.has("hasMin") && truthy(expectedProp.get("hasMin")));
  result.trackField("Property", "maxValue", expectedProp.has("hasMax") && truthy(expectedProp.get("hasMax")));

  // Compare propertyIndex (ExtendScript is 1-based, parsed is 0-based)
  if (expectedProp.has("propertyIndex")) {
    const expPi = getOrThrow(expectedProp, "propertyIndex");
    const parsedPi = parsedProp.get("propertyIndex") ?? null;
    if (parsedPi != null && expPi !== parsedPi + 1) {
      result.addDiff(`${path}.propertyIndex`, expPi, parsedPi + 1, "properties");
    }
  }

  // Compare value
  if (expectedProp.has("value")) {
    const expVal = getOrThrow(expectedProp, "value");
    const parsedVal = parsedProp.get("value") ?? null;
    if (!(expVal instanceof Map) || !truthy(expVal.get("_undefined"))) {
      if (parsedVal == null) {
        result.addDiff(`${path}.value`, expVal, parsedVal, "properties");
      } else if (!compareValues(expVal, parsedVal)) {
        result.addDiff(`${path}.value`, expVal, parsedVal, "properties");
      }
    }
  }

  // Compare numKeys vs len(keyframes)
  if (expectedProp.has("numKeys")) {
    const expNumKeys = getOrThrow(expectedProp, "numKeys");
    const parsedKeyframes = parsedProp.has("keyframes") ? parsedProp.get("keyframes") : [];
    const parsedNumKeys = parsedKeyframes?.length ?? 0;
    if (expNumKeys !== parsedNumKeys) {
      result.addDiff(`${path}.numKeys`, expNumKeys, parsedNumKeys, "properties");
    }
  }

  // Compare individual keyframes
  const expKeyframes = expectedProp.has("keyframes") ? expectedProp.get("keyframes") : [];
  const parsedKeyframes = parsedProp.has("keyframes") ? parsedProp.get("keyframes") : [];
  for (const [ki, [expKf, parsedKf]] of zip(expKeyframes, parsedKeyframes).entries()) {
    compareKeyframe(expKf, parsedKf, `${path}.keyframes[${ki}]`, result);
  }

  // Compare has_min/has_max PRESENCE first - this catches both over-reporting
  // (py reports a bound ExtendScript says is absent) and under-reporting,
  // which the value comparisons below cannot (they only run when ES reports
  // the bound present).
  if (expectedProp.has("hasMin")) {
    const expHasMin = truthy(getOrThrow(expectedProp, "hasMin"));
    const parsedHasMin = truthy(parsedProp.get("hasMin"));
    if (expHasMin !== parsedHasMin) {
      result.addDiff(`${path}.hasMin`, expHasMin, parsedHasMin, "properties");
    }
  }
  if (expectedProp.has("hasMax")) {
    const expHasMax = truthy(getOrThrow(expectedProp, "hasMax"));
    const parsedHasMax = truthy(parsedProp.get("hasMax"));
    if (expHasMax !== parsedHasMax) {
      result.addDiff(`${path}.hasMax`, expHasMax, parsedHasMax, "properties");
    }
  }

  // Compare min/max values only when BOTH sides report the bound present.
  // The presence check above already flags an under-reported bound; gating
  // the value comparison on the parsed side too avoids a redundant second
  // diff (.minValue: 0 vs None) for the same root cause.
  if (truthy(expectedProp.get("hasMin")) && truthy(parsedProp.get("hasMin"))) {
    if (expectedProp.has("minValue")) {
      const expMin = getOrThrow(expectedProp, "minValue");
      const parsedMin = parsedProp.get("minValue") ?? null;
      if (!compareValues(expMin, parsedMin)) {
        result.addDiff(`${path}.minValue`, expMin, parsedMin, "properties");
      }
    }
  }

  if (truthy(expectedProp.get("hasMax")) && truthy(parsedProp.get("hasMax"))) {
    if (expectedProp.has("maxValue")) {
      const expMax = getOrThrow(expectedProp, "maxValue");
      const parsedMax = parsedProp.get("maxValue") ?? null;
      if (!compareValues(expMax, parsedMax)) {
        result.addDiff(`${path}.maxValue`, expMax, parsedMax, "properties");
      }
    }
  }

  // Compare TextDocument value
  if (expectedProp.has("textDocument")) {
    const parsedValue = parsedProp.get("value") ?? null;
    if (parsedValue instanceof Map) {
      compareTextDocument(getOrThrow(expectedProp, "textDocument"), parsedValue, `${path}.textDocument`, result);
    }
  }

  // Compare Shape value
  if (expectedProp.has("shapeValue")) {
    const parsedValue = parsedProp.get("value") ?? null;
    if (parsedValue instanceof Map) {
      compareShapeValue(getOrThrow(expectedProp, "shapeValue"), parsedValue, `${path}.shapeValue`, result);
    }
  }

  // Compare alternateSource (Media Replacement wrapper reference). to_dict
  // serializes the AVItem fully, so id/name are available; compare on id (the
  // binary blsi item id, the strongest invariant) then name.
  result.trackField("Property", "alternateSource", expectedProp.has("alternateSource"));
  if (expectedProp.has("alternateSource")) {
    const expAlt = getOrThrow(expectedProp, "alternateSource");
    const parsedAlt = parsedProp.get("alternateSource") ?? null;
    if (expAlt == null) {
      if (parsedAlt != null) {
        const pid = parsedAlt instanceof Map ? (parsedAlt.get("id") ?? null) : parsedAlt;
        result.addDiff(`${path}.alternateSource`, null, pid, "properties");
      }
    } else if (expAlt instanceof Map) {
      if (!(parsedAlt instanceof Map)) {
        result.addDiff(`${path}.alternateSource`, expAlt, null, "properties");
      } else {
        for (const key of ["id", "name"]) {
          if (!valueEquals(expAlt.get(key) ?? null, parsedAlt.get(key) ?? null)) {
            result.addDiff(
              `${path}.alternateSource.${key}`,
              expAlt.get(key) ?? null,
              parsedAlt.get(key) ?? null,
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
  result.trackField("Property", "essentialPropertySource", expectedProp.has("essentialPropertySource"));
  if (expectedProp.has("essentialPropertySource")) {
    const expEps = getOrThrow(expectedProp, "essentialPropertySource");
    const parsedEps = parsedProp.get("essentialPropertySource") ?? null;
    if (expEps == null) {
      if (parsedEps != null) {
        const pname = parsedEps instanceof Map ? (parsedEps.get("name") ?? null) : parsedEps;
        result.addDiff(`${path}.essentialPropertySource`, null, pname, "properties");
      }
    } else if (!(parsedEps instanceof Map)) {
      result.addDiff(`${path}.essentialPropertySource`, expEps, null, "properties");
    } else if (expEps.get("sourceType") === "AVLayer") {
      if (!valueEquals(expEps.get("name") ?? null, parsedEps.get("name") ?? null)) {
        result.addDiff(
          `${path}.essentialPropertySource.name`,
          expEps.get("name") ?? null,
          parsedEps.get("name") ?? null,
          "properties",
        );
      }
      const expIdx = expEps.get("index") ?? null;
      const parsedIdx = parsedEps.get("index") ?? null;
      if (expIdx != null && parsedIdx != null && expIdx !== parsedIdx + 1) {
        result.addDiff(`${path}.essentialPropertySource.index`, expIdx, parsedIdx + 1, "properties");
      }
    } else if (expEps.get("sourceType") === "Property") {
      if (!valueEquals(expEps.get("matchName") ?? null, parsedEps.get("matchName") ?? null)) {
        result.addDiff(
          `${path}.essentialPropertySource.matchName`,
          expEps.get("matchName") ?? null,
          parsedEps.get("matchName") ?? null,
          "properties",
        );
      }
    }
  }
}

/**
 * Compare a Shape value (mask path or shape layer path).
 *
 * @param expectedShape - Expected shape from ExtendScript JSON.
 * @param parsedShape - Parsed shape dict from py_aep.
 * @param path - Dotted path for error messages.
 * @param result - ValidationResult to accumulate differences.
 */
export function compareShapeValue(
  expectedShape: Dict,
  parsedShape: Dict,
  path: string,
  result: ValidationResult,
): void {
  const shapeMappings: Record<string, string> = {
    closed: "closed",
    vertices: "vertices",
    inTangents: "inTangents",
    outTangents: "outTangents",
  };
  _compareFields(expectedShape, parsedShape, shapeMappings, path, "shape", result, "Shape");

  // Compare feather data: ExtendScript exposes parallel arrays,
  // py_aep stores a list of FeatherPoint objects.
  const featherFieldMap: Record<string, string> = {
    featherSegLocs: "segLoc",
    featherRelSegLocs: "relSegLoc",
    featherRadii: "radius",
    featherTypes: "type",
    featherInterps: "interp",
    featherTensions: "tension",
    featherRelCornerAngles: "relCornerAngle",
  };
  const parsedFps: Dict[] = parsedShape.has("featherPoints") ? parsedShape.get("featherPoints") : [];
  for (const [expKey, fpAttr] of Object.entries(featherFieldMap)) {
    result.definedFields.add(`Shape.${fpAttr}`);
    if (expectedShape.has(expKey)) {
      const expVal = expectedShape.get(expKey);
      if (expVal instanceof Map && truthy(expVal.get("_undefined"))) continue;
      result.comparedFields.add(`Shape.${fpAttr}`);
      const parsedVal = parsedFps.map((fp) => fp.get(fpAttr) ?? null);
      if (!compareValues(expVal, parsedVal)) {
        result.addDiff(`${path}.${expKey}`, expVal, parsedVal, "shape");
      }
    }
  }
}

/**
 * Compare a single keyframe's attributes.
 *
 * @param expectedKf - Expected keyframe from ExtendScript JSON.
 * @param parsedKf - Parsed keyframe from py_aep.
 * @param path - Dotted path for error messages.
 * @param result - ValidationResult to accumulate differences.
 */
export function compareKeyframe(expectedKf: Dict, parsedKf: Dict, path: string, result: ValidationResult): void {
  // Track manually-compared fields
  result.trackField("Keyframe", "value", expectedKf.has("value"));
  result.trackField("Keyframe", "inTemporalEase", expectedKf.has("inTemporalEase"));
  result.trackField("Keyframe", "outTemporalEase", expectedKf.has("outTemporalEase"));

  // Compare value. The exporter writes None for a key value ExtendScript
  // cannot read (a Curves key's, which aborts the script).
  if (expectedKf.get("value") != null && parsedKf.get("value") != null) {
    const expVal = getOrThrow(expectedKf, "value");
    const parsedVal = getOrThrow(parsedKf, "value");
    if (expVal instanceof Map && expVal.has("vertices")) {
      // Shape keyframe value - compare as shape
      if (parsedVal instanceof Map) {
        compareShapeValue(expVal, parsedVal, `${path}.value`, result);
      }
    } else if (expVal instanceof Map && parsedVal instanceof Map) {
      // Dict value (e.g. marker) - normalize keys and compare matching
      const normalized = _normalizeKeys(expVal);
      for (const [key, nval] of normalized) {
        const pval = parsedVal.get(key) ?? null;
        if (pval != null && !compareValues(nval, pval)) {
          result.addDiff(`${path}.value.${key}`, nval, pval, "keyframes");
        }
      }
    } else if (!(expVal instanceof Map) || !truthy(expVal.get("_undefined"))) {
      if (!compareValues(expVal, parsedVal)) {
        result.addDiff(`${path}.value`, expVal, parsedVal, "keyframes");
      }
    }
  }

  // Compare interpolation types and boolean flags
  const kfMappings = {
    time: "time",
    inInterpolationType: "inInterpolationType",
    outInterpolationType: "outInterpolationType",
    temporalAutoBezier: "temporalAutoBezier",
    temporalContinuous: "temporalContinuous",
    spatialAutoBezier: "spatialAutoBezier",
    spatialContinuous: "spatialContinuous",
    roving: "roving",
    label: "label",
    inSpatialTangent: "inSpatialTangent",
    outSpatialTangent: "outSpatialTangent",
  };

  _compareFields(expectedKf, parsedKf, kfMappings, path, "keyframes", result, "Keyframe");

  // Compare temporal ease
  for (const [easeKey, parsedKey] of [
    ["inTemporalEase", "inTemporalEase"],
    ["outTemporalEase", "outTemporalEase"],
  ]) {
    if (expectedKf.has(easeKey)) {
      const expEase = expectedKf.get(easeKey);
      const parsedEase = parsedKf.has(parsedKey) ? parsedKf.get(parsedKey) : [];
      if (expEase.length !== parsedEase.length) {
        result.addDiff(`${path}.${easeKey}.length`, expEase.length, parsedEase.length, "keyframes");
      }
      for (const [ei, [expE, parsedE]] of zip(expEase, parsedEase).entries()) {
        const expSpeed = expE instanceof Map ? (expE.get("speed") ?? null) : null;
        const expInfluence = expE instanceof Map ? (expE.get("influence") ?? null) : null;
        const parsedSpeed = parsedE instanceof Map ? (parsedE.get("speed") ?? null) : null;
        const parsedInfluence = parsedE instanceof Map ? (parsedE.get("influence") ?? null) : null;
        if (!compareValues(expSpeed, parsedSpeed)) {
          result.addDiff(`${path}.${easeKey}[${ei}].speed`, expSpeed, parsedSpeed, "keyframes");
        }
        if (!compareValues(expInfluence, parsedInfluence)) {
          result.addDiff(`${path}.${easeKey}[${ei}].influence`, expInfluence, parsedInfluence, "keyframes");
        }
      }
    }
  }
}

/**
 * Compare TextDocument properties.
 *
 * @param expectedDoc - Expected TextDocument from ExtendScript JSON.
 * @param parsedDoc - Parsed TextDocument from py_aep.
 * @param path - Dotted path for error messages.
 * @param result - ValidationResult to accumulate differences.
 */
export function compareTextDocument(expectedDoc: Dict, parsedDoc: Dict, path: string, result: ValidationResult): void {
  // fontFamily/fontStyle/fontLocation are intentionally omitted: AE does not
  // store them in the .aep. It resolves them at runtime by feeding the stored
  // PostScript name to CoolType against the host's installed font database, so
  // the ExtendScript ground truth is host-dependent (e.g. a live Windows font
  // path) and there is nothing in the binary to decode. `font` (the stored
  // PostScript name) is compared instead.
  const textValue = expectedDoc.get("text");
  if (typeof textValue === "string" && textValue.includes("\r")) {
    // ExtendScript reports AE's CR line breaks; TextDocument.text
    // normalizes them to LF by design.
    expectedDoc = new Map(expectedDoc);
    expectedDoc.set("text", textValue.replaceAll("\r", "\n"));
  }
  const textMappings = {
    text: "text",
    font: "font",
    fontSize: "fontSize",
    fauxBold: "fauxBold",
    fauxItalic: "fauxItalic",
    autoKernType: "autoKernType",
    kerning: "kerning",
    tracking: "tracking",
    leading: "leading",
    leadingType: "leadingType",
    autoLeading: "autoLeading",
    baselineShift: "baselineShift",
    horizontalScale: "horizontalScale",
    verticalScale: "verticalScale",
    tsume: "tsume",
    allCaps: "allCaps",
    smallCaps: "smallCaps",
    superscript: "superscript",
    subscript: "subscript",
    fontBaselineOption: "fontBaselineOption",
    fontCapsOption: "fontCapsOption",
    baselineDirection: "baselineDirection",
    ligature: "ligature",
    noBreak: "noBreak",
    digitSet: "digitSet",
    lineJoinType: "lineJoinType",
    fillColor: "fillColor",
    applyFill: "applyFill",
    strokeColor: "strokeColor",
    applyStroke: "applyStroke",
    strokeWidth: "strokeWidth",
    strokeOverFill: "strokeOverFill",
    justification: "justification",
    direction: "direction",
    firstLineIndent: "firstLineIndent",
    startIndent: "startIndent",
    endIndent: "endIndent",
    spaceBefore: "spaceBefore",
    spaceAfter: "spaceAfter",
    everyLineComposer: "everyLineComposer",
    hangingRoman: "hangingRoman",
    autoHyphenate: "autoHyphenate",
    composerEngine: "composerEngine",
    paragraphCount: "paragraphCount",
    boxText: "boxText",
    pointText: "pointText",
    boxTextSize: "boxTextSize",
    boxTextPos: "boxTextPos",
    boxVerticalAlignment: "boxVerticalAlignment",
    boxAutoFitPolicy: "boxAutoFitPolicy",
    boxFirstBaselineAlignment: "boxFirstBaselineAlignment",
    boxFirstBaselineAlignmentMinimum: "boxFirstBaselineAlignmentMinimum",
    boxInsetSpacing: "boxInsetSpacing",
    boxOverflow: "boxOverflow",
    lineOrientation: "lineOrientation",
    composedLineCount: "composedLineCount",
    paragraphRanges: "paragraphRanges",
    composedLineRanges: "composedLineRanges",
  };

  _compareFields(expectedDoc, parsedDoc, textMappings, path, "textdocument", result, "TextDocument");
}

/**
 * Compare a property group (effects group, transform group, etc.).
 *
 * Recursively compares nested properties and property groups.
 *
 * @param expectedGroup - Expected property group from ExtendScript JSON.
 * @param parsedGroup - Parsed property group from py_aep.
 * @param path - Dotted path for error messages.
 * @param result - ValidationResult to accumulate differences.
 */
export function comparePropertyGroup(
  expectedGroup: Dict,
  parsedGroup: Dict,
  path: string,
  result: ValidationResult,
): void {
  const groupMappings = {
    name: "name",
    matchName: "matchName",
    enabled: "enabled",
    canSetEnabled: "canSetEnabled",
    elided: "elided",
    isEffect: "isEffect",
    isMask: "isMask",
    isModified: "isModified",
    propertyDepth: "propertyDepth",
    color: "color",
    maskFeatherFalloff: "maskFeatherFalloff",
    maskMode: "maskMode",
    maskMotionBlur: "maskMotionBlur",
    inverted: "inverted",
    locked: "locked",
    rotoBezier: "rotoBezier",
  };

  _compareFields(expectedGroup, parsedGroup, groupMappings, path, "properties", result, "PropertyGroup");

  // Compare propertyIndex (ExtendScript is 1-based, parsed is 0-based)
  result.trackField("PropertyGroup", "propertyIndex", expectedGroup.has("propertyIndex"));
  if (expectedGroup.has("propertyIndex")) {
    const expPi = getOrThrow(expectedGroup, "propertyIndex");
    const parsedPi = parsedGroup.get("propertyIndex") ?? null;
    if (parsedPi != null && expPi !== parsedPi + 1) {
      result.addDiff(`${path}.propertyIndex`, expPi, parsedPi + 1, "properties");
    }
  }

  // Compare child properties
  _compareChildrenByMatchName(
    expectedGroup.has("properties") ? expectedGroup.get("properties") : [],
    parsedGroup.has("properties") ? parsedGroup.get("properties") : [],
    path,
    result,
  );
}

/** Compare composition item properties. */
export function compareCompItem(expectedItem: Dict, parsedComp: Dict, path: string, result: ValidationResult): void {
  const compMappings = {
    name: "name",
    id: "id",
    comment: "comment",
    label: "label",
    time: "time",
    duration: "duration",
    frameRate: "frameRate",
    width: "width",
    height: "height",
    displayStartTime: "displayStartTime",
    displayStartFrame: "displayStartFrame",
    dropFrame: "dropFrame",
    bgColor: "bgColor",
    pixelAspect: "pixelAspect",
    shutterPhase: "shutterPhase",
    shutterAngle: "shutterAngle",
    motionBlur: "motionBlur",
    motionBlurAdaptiveSampleLimit: "motionBlurAdaptiveSampleLimit",
    motionBlurSamplesPerFrame: "motionBlurSamplesPerFrame",
    workAreaStart: "workAreaStart",
    workAreaDuration: "workAreaDuration",
    preserveNestedResolution: "preserveNestedResolution",
    preserveNestedFrameRate: "preserveNestedFrameRate",
    frameBlending: "frameBlending",
    hideShyLayers: "hideShyLayers",
    resolutionFactor: "resolutionFactor",
    draft3d: "draft3d",
    hasVideo: "hasVideo",
    isMediaReplacementCompatible: "isMediaReplacementCompatible",
    renderer: "renderer",
    motionGraphicsTemplateName: "motionGraphicsTemplateName",
    motionGraphicsTemplateControllerCount: "motionGraphicsTemplateControllerCount",
    motionGraphicsTemplateControllerNames: "motionGraphicsTemplateControllerNames",
  };

  _compareFields(expectedItem, parsedComp, compMappings, path, "composition", result, "CompItem");

  // Compare layer counts
  const expLayers = expectedItem.has("layers") ? expectedItem.get("layers") : [];
  const parsedLayers = parsedComp.has("layers") ? parsedComp.get("layers") : [];
  if (expLayers.length !== parsedLayers.length) {
    result.addDiff(`${path}.numLayers`, expLayers.length, parsedLayers.length, "composition");
  }

  // Compare each layer
  const compDuration = expectedItem.has("duration") ? expectedItem.get("duration") : 60.0;
  const frameRate = expectedItem.has("frameRate") ? expectedItem.get("frameRate") : 24.0;
  for (const [i, [expLayer, parsedLayer]] of zip(expLayers, parsedLayers).entries()) {
    compareLayer(expLayer, parsedLayer, `${path}.layers[${i}]`, compDuration, frameRate, result);
  }

  // Compare markers
  _compareMarkers(
    expectedItem.has("markers") ? expectedItem.get("markers") : [],
    parsedComp.has("markers") ? parsedComp.get("markers") : [],
    path,
    expectedItem.has("frameRate") ? expectedItem.get("frameRate") : 24.0,
    result,
  );

  // Compare guides
  _compareGuides(
    expectedItem.has("guides") ? expectedItem.get("guides") : [],
    parsedComp.has("guides") ? parsedComp.get("guides") : [],
    path,
    result,
  );

  // Compare proxySource
  _compareProxySource(expectedItem, parsedComp, path, result);
}

/** Compare folder hierarchy. */
export function compareFolderHierarchy(
  expectedItems: Dict[],
  parsedItems: Map<number, Dict>,
  result: ValidationResult,
): void {
  const expectedFolders = new Map<number, Dict>();
  for (const item of expectedItems) {
    if (item.get("itemType") === "FolderItem") {
      expectedFolders.set(getOrThrow(item, "id"), item);
    }
  }

  const parsedFolders = new Map<number, Dict>();
  for (const [itemId, item] of parsedItems) {
    if (item.get("typeName") === "Folder") {
      parsedFolders.set(itemId, item);
    }
  }

  for (const [folderId, expFolder] of expectedFolders) {
    const parsedFolder = parsedFolders.get(folderId);
    if (parsedFolder === undefined) {
      result.addDiff(`Folder[${getOrThrow(expFolder, "name")}]`, "exists", "missing", "folders");
    } else {
      if (!valueEquals(getOrThrow(expFolder, "name"), parsedFolder.get("name") ?? null)) {
        result.addDiff(
          `Folder[id=${folderId}].name`,
          getOrThrow(expFolder, "name"),
          parsedFolder.get("name") ?? null,
          "folders",
        );
      }
    }
  }
}

/**
 * Compare footage item properties and its main source.
 *
 * @param expectedItem - Expected FootageItem from ExtendScript JSON.
 * @param parsedItem - Parsed FootageItem from py_aep.
 * @param path - Dotted path for error messages.
 * @param result - ValidationResult to accumulate differences.
 */
export function compareFootageItem(expectedItem: Dict, parsedItem: Dict, path: string, result: ValidationResult): void {
  const footageMappings = {
    name: "name",
    id: "id",
    comment: "comment",
    label: "label",
    time: "time",
    duration: "duration",
    frameRate: "frameRate",
    width: "width",
    height: "height",
    pixelAspect: "pixelAspect",
    footageMissing: "footageMissing",
    hasVideo: "hasVideo",
    isMediaReplacementCompatible: "isMediaReplacementCompatible",
  };

  _compareFields(expectedItem, parsedItem, footageMappings, path, "footage", result, "FootageItem");

  // Compare mainSource (FootageSource fields)
  const expSource = expectedItem.get("mainSource") ?? null;
  const parsedSource = parsedItem.get("mainSource") ?? null;
  if (truthy(expSource) && truthy(parsedSource)) {
    const sourcePath = `${path}.mainSource`;

    const sourceMappings = {
      alphaMode: "alphaMode",
      displayFrameRate: "displayFrameRate",
      fieldSeparationType: "fieldSeparationType",
      hasAlpha: "hasAlpha",
      highQualityFieldSeparation: "highQualityFieldSeparation",
      invertAlpha: "invertAlpha",
      isStill: "isStill",
      loop: "loop",
      nativeFrameRate: "nativeFrameRate",
      premulColor: "premulColor",
      removePulldown: "removePulldown",
      color: "color",
    };

    _compareFields(expSource, parsedSource, sourceMappings, sourcePath, "footage", result, "FootageSource");

    // AE returns native_frame_rate when conformFrameRate is 0
    result.trackField("FootageSource", "conformFrameRate", expSource.has("conformFrameRate"));
    const expCfr = expSource.get("conformFrameRate") ?? null;
    const parsedCfr = parsedSource.has("conformFrameRate") ? parsedSource.get("conformFrameRate") : 0;
    if (expCfr != null) {
      if (!compareValues(expCfr, parsedCfr)) {
        // When parsed conform is 0, AE may report native_frame_rate
        const native = parsedSource.has("nativeFrameRate") ? parsedSource.get("nativeFrameRate") : 0;
        if (parsedCfr === 0 && compareValues(expCfr, native)) {
          // AE reported native rate as conform rate
        } else {
          result.addDiff(`${sourcePath}.conformFrameRate`, expCfr, parsedCfr, "footage");
        }
      }
    }

    // Track manually-compared fields
    result.trackField("FootageSource", "file", expSource.has("filePath"));
    result.trackField("FootageSource", "missingFootagePath", expSource.has("missingFootagePath"));
    // FileSource-specific fields
    if (expSource.has("filePath")) {
      const expFile = getOrThrow<string, string | null>(expSource, "filePath");
      const parsedFile = parsedSource.has("file") ? parsedSource.get("file") : "";
      // Compare only the filename portion. PureWindowsPath splits on
      // both / and \ on every host OS (AE stores Windows-style paths,
      // and a parsed sequence frame path mixes the two); plain Path
      // fails to split backslashes when the validator runs on POSIX.
      if (expFile && parsedFile) {
        const expName = new PureWindowsPath(expFile).name;
        const parsedName = new PureWindowsPath(parsedFile).name;
        if (expName !== parsedName) {
          result.addDiff(`${sourcePath}.fileName`, expName, parsedName, "footage");
        }
      }
    }

    if (expSource.has("missingFootagePath")) {
      const expMissing = getOrThrow<string, ToDictValue>(expSource, "missingFootagePath");
      const parsedMissing = parsedSource.has("missingFootagePath") ? parsedSource.get("missingFootagePath") : "";
      if (truthy(expMissing) && !valueEquals(expMissing, parsedMissing)) {
        result.addDiff(`${sourcePath}.missingFootagePath`, expMissing, parsedMissing, "footage");
      }
    }
  }

  // Compare proxySource
  _compareProxySource(expectedItem, parsedItem, path, result);
}

/**
 * Compare render settings.
 *
 * Render settings are now stored as raw integer values with ExtendScript keys.
 */
export function compareSettings(
  expectedSettings: Dict,
  parsedSettings: Dict | null,
  path: string,
  result: ValidationResult,
): void {
  if (parsedSettings == null) {
    result.addDiff(`${path}`, "exists", "missing", "renderqueue");
    return;
  }

  // Map expected JSON keys to parsed keys (both use AE getSettings keys)
  const settingsMappings: Record<string, string> = {};
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
    settingsMappings[key] = key;
  }

  _compareFields(expectedSettings, parsedSettings, settingsMappings, path, "renderqueue", result, "RenderSettings");
}

/**
 * Compare output module settings.
 *
 * Output module settings are stored as a dict with ExtendScript keys.
 */
export function compareOutputModuleSettings(
  expectedSettings: Dict | null,
  parsedSettings: Dict | null,
  path: string,
  result: ValidationResult,
): void {
  if (expectedSettings == null) return;
  if (parsedSettings == null) {
    result.addDiff(`${path}`, "exists", "missing", "renderqueue");
    return;
  }

  // Compare output module settings with identical keys
  const omSettingsMappings: Record<string, string> = {};
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
    omSettingsMappings[key] = key;
  }

  _compareFields(expectedSettings, parsedSettings, omSettingsMappings, path, "renderqueue", result, "OMSettings");
}

/** Compare render queue items. */
export function compareRenderQueue(expectedRq: Dict, parsedRq: Dict, result: ValidationResult, verbose = false): void {
  const expectedItems: Dict[] = expectedRq.has("items") ? expectedRq.get("items") : [];
  const parsedItems: Dict[] = parsedRq.has("items") ? parsedRq.get("items") : [];

  if (expectedItems.length !== parsedItems.length) {
    result.addDiff("RenderQueue.numItems", expectedItems.length, parsedItems.length, "renderqueue");
    if (verbose) {
      console.log(`  Item count mismatch: expected ${expectedItems.length}, got ${parsedItems.length}`);
    }
  }

  // Compare each render queue item
  for (const [i, expItem] of expectedItems.entries()) {
    if (i >= parsedItems.length) {
      result.addDiff(`RenderQueueItem[${i}]`, "exists", "missing", "renderqueue");
      continue;
    }

    const parsedItem = parsedItems[i];
    const path = `RenderQueueItem[${i}]`;

    // Compare RQ item-level fields
    const rqiMappings = {
      status: "status",
      render: "render",
      skipFrames: "skipFrames",
      logType: "logType",
      elapsedSeconds: "elapsedSeconds",
      comment: "comment",
      compName: "compName",
      queueItemNotify: "queueItemNotify",
      timeSpanStart: "timeSpanStart",
      timeSpanDuration: "timeSpanDuration",
    };
    _compareFields(expItem, parsedItem, rqiMappings, path, "renderqueue", result, "RenderQueueItem");

    // Compare render settings
    if (expItem.has("settings")) {
      compareSettings(getOrThrow(expItem, "settings"), parsedItem.get("settings") ?? null, `${path}.settings`, result);
    }

    // Compare output modules
    const expOms: Dict[] = expItem.has("outputModules") ? expItem.get("outputModules") : [];
    const parsedOms: Dict[] = parsedItem.has("outputModules") ? parsedItem.get("outputModules") : [];

    if (expOms.length !== parsedOms.length) {
      result.addDiff(`${path}.numOutputModules`, expOms.length, parsedOms.length, "renderqueue");
    }

    for (const [j, expOm] of expOms.entries()) {
      if (j >= parsedOms.length) {
        result.addDiff(`${path}.outputModule[${j}]`, "exists", "missing", "renderqueue");
        continue;
      }

      const parsedOm = parsedOms[j];
      const omPath = `${path}.outputModule[${j}]`;

      // Compare output module-level fields
      const omMappings = {
        name: "name",
        includeSourceXMP: "includeSourceXmp",
        postRenderAction: "postRenderAction",
      };
      _compareFields(expOm, parsedOm, omMappings, omPath, "renderqueue", result, "OutputModule");

      // Compare output module file (path comparison)
      result.trackField("OutputModule", "file", expOm.has("file"));
      if (expOm.has("file")) {
        const expFile = getOrThrow(expOm, "file");
        const parsedFile = parsedOm.has("file") ? parsedOm.get("file") : "";
        if (expFile && truthy(parsedFile)) {
          // See the footage-source note: PureWindowsPath keeps
          // basename extraction host-OS-independent.
          const expName = new PureWindowsPath(expFile).name;
          const parsedName = new PureWindowsPath(String(parsedFile)).name;
          if (expName !== parsedName) {
            result.addDiff(`${omPath}.fileName`, expName, parsedName, "renderqueue");
          }
        }
      }

      // Compare output module settings
      if (expOm.has("settings")) {
        compareOutputModuleSettings(
          getOrThrow(expOm, "settings"),
          getOrThrow(parsedOm, "settings"),
          `${omPath}.settings`,
          result,
        );
      }
    }
  }
}

/**
 * Compare active viewer properties.
 *
 * @param expectedViewer - Expected activeViewer from ExtendScript JSON.
 * @param parsedViewer - Parsed active_viewer dict from py_aep.
 * @param result - ValidationResult to accumulate differences.
 */
export function compareViewer(expectedViewer: Dict, parsedViewer: Dict, result: ValidationResult): void {
  const viewerMappings: Record<string, string> = {
    type: "type",
  };
  _compareFields(expectedViewer, parsedViewer, viewerMappings, "Viewer", "viewer", result, "Viewer");

  const expViews: Dict[] = expectedViewer.has("views") ? expectedViewer.get("views") : [];
  const parsedViews: Dict[] = parsedViewer.has("views") ? parsedViewer.get("views") : [];
  if (expViews.length !== parsedViews.length) {
    result.addDiff("Viewer.views.length", expViews.length, parsedViews.length, "viewer");
  }

  for (const [i, [expView, parsedView]] of zip(expViews, parsedViews).entries()) {
    const path = `Viewer.views[${i}]`;

    const expOpts = expView.has("options") ? expView.get("options") : new Map();
    const parsedOpts = parsedView.has("options") ? parsedView.get("options") : new Map();
    const optsPath = `${path}.options`;
    const optsMappings: Record<string, string> = {
      channels: "channels",
      checkerboards: "checkerboards",
      exposure: "exposure",
      fastPreview: "fastPreview",
      zoom: "zoom",
      guidesVisibility: "guidesVisibility",
      guidesSnap: "guidesSnap",
      guidesLocked: "guidesLocked",
      rulers: "rulers",
    };
    _compareFields(expOpts, parsedOpts, optsMappings, optsPath, "viewer", result, "ViewOptions");
  }
}

/**
 * Validate parsed AEP against expected JSON.
 *
 * @param aepPath - Path to .aep file.
 * @param jsonPath - Path to expected JSON (from ExtendScript export).
 * @param verbose - Whether to print detailed progress.
 * @param _categoryFilter - Only show differences from this category.
 * @returns ValidationResult containing all differences.
 */
export function validateAep(
  aepPath: Path,
  jsonPath: Path,
  verbose = false,
  _categoryFilter: string | null = null,
): ValidationResult {
  const result = new ValidationResult();

  // Parse AEP
  if (verbose) console.log(`Parsing: ${aepPath.name}`);
  const app = parse(aepPath);
  const project = app.project;
  const parsed = toDict(project);

  // Load expected JSON
  // Python `open(encoding="utf-8")`: bytes are decoded without dropping a BOM.
  const loaded = parseJson(decode(jsonPath.readBytes(), "utf-8"));
  if (!(loaded instanceof Map)) throw new AttributeError(`'${typeName(loaded)}' object has no attribute 'get'`);
  const expected: Dict = loaded;

  // Compare project-level properties
  if (verbose) console.log("\n=== Comparing Project Properties ===");
  compareProjectLevel(expected, parsed, result);

  // Get expected items
  const expectedItems: Dict[] = expected.has("items") ? expected.get("items") : [];
  const comps = expectedItems.filter((i: Dict) => i.get("itemType") === "CompItem");

  // Compare compositions
  if (verbose) console.log("\n=== Comparing Compositions ===");
  const parsedById = new Map<number, Dict>(project.compositions.map((comp) => [comp.id, toDict(comp)]));

  for (const expItem of comps) {
    const itemId = getOrThrow(expItem, "id");
    const itemName = getOrThrow(expItem, "name");

    if (!parsedById.has(itemId)) {
      result.addDiff(`Comp[${itemName}]`, "exists", "missing", "composition");
      if (verbose) console.log(`  ${itemName} (id=${itemId}): MISSING!`);
      continue;
    }

    const parsedComp = getOrThrow(parsedById, itemId);
    const beforeCount = result.length;
    compareCompItem(expItem, parsedComp, `Comp[${itemName}]`, result);

    if (verbose) {
      const diffCount = result.length - beforeCount;
      if (diffCount > 0) {
        console.log(`  ${itemName} (id=${itemId}): ${diffCount} differences`);
      } else {
        console.log(`  ${itemName} (id=${itemId}): OK`);
      }
    }
  }

  // Compare folder hierarchy
  if (verbose) console.log("\n=== Comparing Folder Hierarchy ===");
  compareFolderHierarchy(expectedItems, parsed.has("items") ? parsed.get("items") : new Map(), result);

  // Compare footage items
  if (verbose) console.log("\n=== Comparing Footage Items ===");
  const expectedFootage = expectedItems.filter((i: Dict) => i.get("itemType") === "FootageItem");
  const parsedItemsDict: Map<number, Dict> = parsed.has("items") ? parsed.get("items") : new Map();
  const parsedFootageById = new Map<number, Dict>();
  for (const [itemId, item] of parsedItemsDict) {
    if (item.get("typeName") === "Footage") parsedFootageById.set(itemId, item);
  }

  for (const expFi of expectedFootage) {
    const fiId = getOrThrow(expFi, "id");
    const fiName = getOrThrow(expFi, "name");

    const parsedFi = parsedFootageById.get(fiId) ?? null;
    if (parsedFi == null) {
      result.addDiff(`Footage[${fiName}]`, "exists", "missing", "footage");
      if (verbose) console.log(`  ${fiName} (id=${fiId}): MISSING!`);
      continue;
    }

    const beforeCount = result.length;
    compareFootageItem(expFi, parsedFi, `Footage[${fiName}]`, result);

    if (verbose) {
      const diffCount = result.length - beforeCount;
      if (diffCount > 0) {
        console.log(`  ${fiName} (id=${fiId}): ${diffCount} differences`);
      } else {
        console.log(`  ${fiName} (id=${fiId}): OK`);
      }
    }
  }

  // Compare render queue
  if (verbose) console.log("\n=== Comparing Render Queue ===");
  const expectedRq = expected.has("renderQueue") ? expected.get("renderQueue") : new Map();
  compareRenderQueue(expectedRq, parsed.has("renderQueue") ? parsed.get("renderQueue") : new Map(), result, verbose);

  // Compare active viewer
  const expectedViewer = expected.get("activeViewer") ?? null;
  if (expectedViewer != null && app.activeViewer != null) {
    if (verbose) console.log("\n=== Comparing Viewer ===");
    const parsedViewer = toDict(app.activeViewer);
    compareViewer(expectedViewer, parsedViewer, result);
    if (verbose) console.log("  Done");
  } else if (expectedViewer != null && verbose) {
    console.log("\n=== Comparing Viewer ===");
    console.log("  Skipped (no viewer data in binary)");
  }

  return result;
}

/** Print validation results. */
export function printResults(result: ValidationResult, verbose = false, categoryFilter: string | null = null): void {
  console.log("\n" + "=".repeat(60));

  if (!result.differences?.length) {
    console.log("SUCCESS: All parsed values match expected values!");
    return;
  }

  let filteredDiffs = result.differences;
  if (categoryFilter) {
    // Filter by category prefix
    const needle = categoryFilter.toLowerCase();
    filteredDiffs = result.differences.filter((d) => d.toLowerCase().includes(needle));
  }

  console.log(`TOTAL DIFFERENCES FOUND: ${result.differences.length}`);

  if (categoryFilter) {
    console.log(`(Showing ${filteredDiffs.length} matching filter '${categoryFilter}')`);
  }

  console.log("\nDifferences by category:");
  for (const [cat, count] of [...result.categories.entries()].sort(compare)) {
    console.log(`  ${cat}: ${count}`);
  }

  if (verbose && filteredDiffs?.length > 0) {
    console.log("\nAll differences:");
    for (const d of filteredDiffs.slice(0, 200)) {
      // Limit output
      console.log(`  ${d}`);
    }
    if (filteredDiffs.length > 200) {
      console.log(`  ... and ${filteredDiffs.length - 200} more`);
    }
  }
}

/** Print field coverage report. */
export function printCoverage(result: ValidationResult): void {
  const compared = [...result.comparedFields].sort(compare);
  const notCompared = [...result.definedFields].filter((x) => !result.comparedFields.has(x)).sort(compare);

  console.log(`\n${"=".repeat(60)}`);
  console.log("FIELD COVERAGE REPORT");
  console.log(`${"=".repeat(60)}`);
  console.log(`\nCompared (${compared.length}):\n  ` + compared.join("\n  "));
  console.log(`\nNot compared (${notCompared.length}):`);
  if (notCompared?.length > 0) {
    console.log("  " + notCompared.join("\n  "));
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
  "usage: aep-validate [-h] [-v]\n" +
  `                   [-c {${_CATEGORY_CHOICES.join(",")}}]\n` +
  "                   [--coverage]\n" +
  "                   aep_file json_file";

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
  --coverage            Print field coverage report (compared vs not-compared
                        fields)`;

const VALIDATE: Command = {
  prog: "aep-validate",
  usage: _USAGE,
  help: _HELP,
  options: {
    verbose: { type: "boolean", short: "v" },
    category: { type: "string", short: "c" },
    coverage: { type: "boolean" },
  },
};

/** The command line this tool declares. */
export function _parseArgs(argv: string[]): {
  aepFile: Path;
  jsonFile: Path;
  verbose: boolean;
  category: string | null;
  coverage: boolean;
} {
  const { values, positionals } = parseCommandLine(VALIDATE, argv);
  if (positionals.length < 2)
    usageError(
      VALIDATE,
      `the following arguments are required: ${["aep_file", "json_file"].slice(positionals.length).join(", ")}`,
    );
  if (positionals.length > 2) usageError(VALIDATE, `unrecognized arguments: ${positionals.slice(2).join(" ")}`);
  const category = typeof values.category === "string" ? values.category : null;
  if (category != null && !_CATEGORY_CHOICES.includes(category)) {
    usageError(
      VALIDATE,
      `argument -c/--category: invalid choice: '${category}' (choose from ${_CATEGORY_CHOICES.join(", ")})`,
    );
  }
  return {
    aepFile: new Path(positionals[0]),
    jsonFile: new Path(positionals[1]),
    verbose: values.verbose === true,
    category,
    coverage: values.coverage === true,
  };
}

/** Main entry point. */
export function main(args: string[] | null = null): number {
  const parsedArgs = _parseArgs(args ?? process.argv.slice(2));

  if (!parsedArgs.aepFile.exists()) {
    console.log(`Error: AEP file not found: ${parsedArgs.aepFile}`);
    return 1;
  }

  if (!parsedArgs.jsonFile.exists()) {
    console.log(`Error: JSON file not found: ${parsedArgs.jsonFile}`);
    return 1;
  }

  console.log(`Validating: ${parsedArgs.aepFile.name}`);
  console.log(`Expected:   ${parsedArgs.jsonFile.name}`);

  const result = validateAep(parsedArgs.aepFile, parsedArgs.jsonFile, parsedArgs.verbose, parsedArgs.category);

  printResults(result, parsedArgs.verbose, parsedArgs.category);

  if (parsedArgs.coverage) printCoverage(result);

  return !result.differences?.length ? 0 : 1;
}

// `if __name__ == "__main__": sys.exit(main())`
if (import.meta.main) runMain(main);
