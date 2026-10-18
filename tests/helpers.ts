/**
 * Shared test helpers for py_aep tests.
 *
 * Importable from any test module (including subfolders) thanks to
 * `pythonpath = ["tests"]` in `pyproject.toml`.
 *
 * Caching policy
 * --------------
 * `parse_project` / `parse_app` are `lru_cache`d so the read-only tests
 * under `tests/read_only/` can share a single parsed sample per worker
 * without re-parsing on every test. This is ONLY safe because those tests
 * never mutate the project. Mutation / roundtrip tests live under
 * `tests/roundtrip/` and parse fresh via `parse` from the package so
 * they never touch the shared cached instances.
 */

import { parse as _parse_aep, type Application, type Project } from "../src/py_aep/index.ts";
import "../src/py_aep/binary/_register.ts";
import { write_aep } from "../src/py_aep/binary/chunk.ts";
import type {
  AlphaMode,
  AutoOrientType,
  BitsPerChannel,
  BlendingMode,
  FieldSeparationType,
  FrameBlendingType,
  GpuAccelType,
  GuideOrientationType,
  Label,
  LayerQuality,
  LayerSamplingQuality,
  LightType,
  TrackMatteType,
} from "../src/py_aep/enums/index.ts";
import type { CompItem } from "../src/py_aep/models/items/composition.ts";
import type { FolderItem } from "../src/py_aep/models/items/folder.ts";
import type { FootageItem } from "../src/py_aep/models/items/footage.ts";
import type { Layer } from "../src/py_aep/models/layers/layer.ts";
import type { RenderQueueItem } from "../src/py_aep/models/renderqueue/render_queue_item.ts";
import {
  AssertionError_,
  b,
  BytesIO,
  bytes_,
  bytes_eq,
  decode,
  fspath,
  getattr,
  KeyError,
  len,
  lru_cache,
  Path,
  py_assert,
  py_bool,
  repr,
  struct,
  ValueError,
  type PathLike,
} from "../src/pyrt/index.ts";

// `Path(__file__).parent.parent / "samples"`: `import.meta.dir` is already the
// directory of this file, so one `.parent` reaches the package root.
export const SAMPLES_DIR = new Path(import.meta.dir).parent.div("samples");

/**
 * A value as `JSON.parse` decodes it from an expected-JSON fixture: objects
 * are plain records (the convention the ported read-only tests use).
 */
export type ExpectedValue = null | boolean | number | string | ExpectedValue[] | { [key: string]: ExpectedValue };

/** The empty `dict` a Python lookup helper returns on a miss; reading any key of it raises `KeyError`. */
export type EmptyJson = Record<string, never>;

/** A Shape value (`ADBE Mask Shape`, `ADBE Vector Shape`) in the ExtendScript export. */
export interface ExpectedShape {
  closed: boolean;
  vertices: number[][];
  inTangents: number[][];
  outTangents: number[][];
}

/** A marker in the ExtendScript export: a comp marker, or a layer marker keyframe's value. */
export interface ExpectedMarker {
  time: number;
  label: Label;
  duration: number;
  comment: string;
  chapter: string;
  url: string;
  frameTarget: string;
  cuePointName: string;
  eventCuePoint: boolean;
  protectedRegion: boolean;
}

/** One temporal ease entry of a keyframe. */
export interface ExpectedEase {
  speed: number;
  influence: number;
}

/** A keyframe of an exported property. */
export interface ExpectedKeyframe {
  time: number;
  value: null | number | number[] | number[][] | ExpectedShape | ExpectedMarker;
  inTemporalEase: ExpectedEase[];
  outTemporalEase: ExpectedEase[];
  /** Spatial properties only. */
  inSpatialTangent?: number[];
  outSpatialTangent?: number[];
  spatialAutoBezier?: boolean;
  temporalAutoBezier: boolean;
  temporalContinuous: boolean;
}

/**
 * A property or property group in the ExtendScript export. Groups carry
 * `properties`; leaf properties carry `value` and (when animated) `keyframes`.
 */
export interface ExpectedProperty {
  name: string;
  matchName: string;
  propertyType: string;
  isModified: boolean;
  properties?: ExpectedProperty[];
  value?: ExpectedValue;
  keyframes?: ExpectedKeyframe[];
  numKeys?: number;
  dimensionsSeparated?: boolean;
  canSetExpression?: boolean;
  expression?: string;
  expressionEnabled?: boolean;
}

/** A layer in the ExtendScript export. */
export interface ExpectedLayer {
  name: string;
  comment: string;
  label: Label;
  enabled: boolean;
  locked: boolean;
  shy: boolean;
  solo: boolean;
  nullLayer: boolean;
  autoOrient: AutoOrientType;
  startTime: number;
  inPoint: number;
  outPoint: number;
  stretch: number;
  properties: ExpectedProperty[];
  /** Read by the parenting test; the export writes `parentIndex` / `parentName` instead. */
  parent?: number;
  hasTrackMatte: boolean;
  isTrackMatte: boolean;
  /** Light layers only; the tests read it from light-layer fixtures. */
  lightType: LightType;
  // AVLayer fields. Camera and light layers omit them; the tests read them
  // from AV-layer fixtures only, where Python's `layer["..."]` would succeed.
  threeDLayer: boolean;
  adjustmentLayer: boolean;
  guideLayer: boolean;
  collapseTransformation: boolean;
  preserveTransparency: boolean;
  motionBlur: boolean;
  effectsActive: boolean;
  audioEnabled: boolean;
  timeRemapEnabled: boolean;
  blendingMode: BlendingMode;
  frameBlendingType: FrameBlendingType;
  quality: LayerQuality;
  samplingQuality: LayerSamplingQuality;
  trackMatteType: TrackMatteType;
}

/** Fields every exported project item has. */
interface ExpectedItemBase {
  id: number;
  name: string;
  comment: string;
  label: Label;
}

/** A comp guide in the ExtendScript export. */
export interface ExpectedGuide {
  orientationType: GuideOrientationType;
  positionType: number;
  position: number;
}

/** A composition in the ExtendScript export. */
export interface ExpectedComp extends ExpectedItemBase {
  typeName: "Composition";
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  pixelAspect: number;
  time: number;
  bgColor: number[];
  displayStartFrame: number;
  displayStartTime: number;
  dropFrame: boolean;
  frameBlending: boolean;
  hideShyLayers: boolean;
  motionBlur: boolean;
  motionBlurAdaptiveSampleLimit: number;
  motionBlurSamplesPerFrame: number;
  preserveNestedFrameRate: boolean;
  preserveNestedResolution: boolean;
  resolutionFactor: number[];
  shutterAngle: number;
  shutterPhase: number;
  workAreaStart: number;
  workAreaDuration: number;
  /** Exports from AE versions without comp guides write `{"_undefined": true}`. */
  guides: ExpectedGuide[] | { _undefined: true };
  layers: ExpectedLayer[];
  markers: ExpectedMarker[];
}

/** A footage item in the ExtendScript export. */
export interface ExpectedFootage extends ExpectedItemBase {
  typeName: "Footage";
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  mainSource: ExpectedFootageSource;
}

/** A footage item's `mainSource` in the ExtendScript export. */
export interface ExpectedFootageSource {
  alphaMode: AlphaMode;
  invertAlpha: boolean;
  premulColor: number[];
  isStill: boolean;
  loop: number;
  conformFrameRate: number;
  fieldSeparationType: FieldSeparationType;
  highQualityFieldSeparation: boolean;
  /** File sources only; the tests read it from file-footage fixtures. */
  filePath: string;
}

/** A folder in the ExtendScript export. */
export interface ExpectedFolder extends ExpectedItemBase {
  typeName: "Folder";
  numItems: number;
}

/** A project item in the ExtendScript export, told apart by `typeName`. */
export type ExpectedItem = ExpectedComp | ExpectedFootage | ExpectedFolder;

/** An output module of a render queue item in the ExtendScript export. */
export interface ExpectedOutputModule {
  name: string;
  file: string;
  settings: ExpectedOutputModuleSettings;
}

/** An output module's `getSettings()` record in the ExtendScript export. */
export interface ExpectedOutputModuleSettings {
  "Crop Top": number;
  "Crop Bottom": number;
  Depth: number;
  "Starting #": number;
  "Use Comp Frame Number": boolean;
  [key: string]: ExpectedValue;
}

/** A render queue item in the ExtendScript export. */
export interface ExpectedRenderQueueItem {
  compName: string;
  render: boolean;
  settings: Record<string, ExpectedValue>;
  outputModules: ExpectedOutputModule[];
}

/** An ExtendScript project export: the `<sample>.json` next to each `.aep`. */
export interface ExpectedProject {
  bitsPerChannel: BitsPerChannel;
  displayStartFrame: number;
  expressionEngine: string;
  gpuAccelType: GpuAccelType;
  workingSpace: string;
  items: ExpectedItem[];
  renderQueue: { numItems: number; items: ExpectedRenderQueueItem[] };
}

/** One sampled frame of an exported `_value_at_time` property. */
export interface ExpectedFrame {
  time: number;
  value: number | number[] | ExpectedShape;
}

/** An exported `<sample>_value_at_time.json`: each property sampled frame by frame. */
export interface ExpectedValueAtTime {
  source: string;
  comps: {
    name: string;
    layers: {
      name: string;
      properties: { matchName: string; frames: ExpectedFrame[] }[];
    }[];
  }[];
}

/** JSON record field read with `dict.get(key, default)`. */
function _jget<T extends object, K extends keyof T, D>(d: T, k: K, dflt: D): T[K] | D {
  return k in d ? d[k] : dflt;
}

/**
 * Python `record[key]` for a field the export writes on only some records
 * (a group's `properties`, a leaf's `value`): `KeyError` when it is absent.
 */
export function json_field<T extends object, K extends keyof T & string>(record: T, key: K): T[K] & ({} | null) {
  const value = record[key];
  if (value === undefined) throw new KeyError(repr(key));
  return value;
}

/** Python truthiness for a JSON record (a plain object): true when it has keys. */
function _json_truthy(d: object): boolean {
  return Object.keys(d).length > 0;
}

/**
 * `{layer name: (artwork box, footage width, footage height)}`.
 *
 * Every AI/PDF single-layer footage item in `project`, read straight out of
 * its `TEXT` `opti`: the artwork box is four signed big-endian 16.16 values
 * at offset 0x10 and the layer name a NUL-terminated string at 0x44. Neither
 * is reachable through ExtendScript, hence the raw read.
 */
export function ai_layer_opti_boxes(project: Project): Map<string, [number[], number, number]> {
  const out = new Map<string, [number[], number, number]>();
  for (const item of project.items.values()) {
    const source = getattr(item, "mainSource", null);
    const opti = getattr(source, "_opti", null);
    if (opti == null) continue;
    const body = opti.tobytes();
    if (len(body) < 0x250 || !bytes_eq(bytes_.slice(body, 0, 4), b("TEXT"))) continue;
    const box: number[] = struct.unpack_from(">4i", body, 0x10).map((v: number) => v / 65536);
    const end = bytes_.index(body, new Uint8Array([0]), 0x44);
    const name = decode(bytes_.slice(body, 0x44, end), "utf-8");
    out.set(name, [box, (item as CompItem | FootageItem).width, (item as CompItem | FootageItem).height]);
  }
  return out;
}

const _parse_app_cached = lru_cache((aep_file_path: string): Application => _parse_aep(aep_file_path));

/**
 * Parse an AEP file and return the (cached) Application object.
 *
 * The result is shared across read-only tests; never mutate it.
 */
export function parse_app(aep_file_path: PathLike): Application {
  return _parse_app_cached(fspath(aep_file_path));
}

/**
 * Parse an AEP file and return the (cached) Project object.
 *
 * The result is shared across read-only tests; never mutate it.
 */
export function parse_project(aep_file_path: PathLike): Project {
  return parse_app(aep_file_path).project;
}

/**
 * Parse an AEP file into a fresh (uncached) Application object.
 *
 * Use this in roundtrip/mutation tests so each test gets its own
 * object to mutate without affecting any cached read-only instance.
 */
export function parse_app_fresh(aep_file_path: PathLike): Application {
  return _parse_aep(fspath(aep_file_path));
}

/**
 * Parse an AEP file into a fresh (uncached) Project object.
 *
 * Use this in roundtrip/mutation tests so each test gets its own
 * object to mutate without affecting any cached read-only instance.
 */
export function parse_project_fresh(aep_file_path: PathLike): Project {
  return parse_app_fresh(aep_file_path).project;
}

/** Serialize `project` to `.aep` bytes in memory, as `save()` writes it. */
export function project_bytes(project: Project): Uint8Array {
  const buf = new BytesIO();
  write_aep(buf, project._rifx, project._xmp);
  return buf.getvalue();
}

function _expected_text(samples_dir: string, sample_name: string): string {
  return decode(new Path(samples_dir).div(`${sample_name}.json`).read_bytes(), "utf-8");
}

// Python `Path` hashes by value; `lru_cache` here keys by identity, so key on the path string.
const _load_expected_cached = lru_cache(
  (samples_dir: string, sample_name: string): ExpectedProject => JSON.parse(_expected_text(samples_dir, sample_name)),
);

/** Load the expected JSON for a sample. */
export function load_expected(samples_dir: Path, sample_name: string): ExpectedProject {
  return _load_expected_cached(String(samples_dir), sample_name);
}

const _load_expected_value_at_time_cached = lru_cache(
  (samples_dir: string, sample_name: string): ExpectedValueAtTime =>
    JSON.parse(_expected_text(samples_dir, sample_name)),
);

/**
 * Load an expected `_value_at_time` JSON for a sample.
 *
 * NOTE(port): Python reads these with `load_expected` too; they are a
 * different document (`comps` of sampled frames, not a project export), so
 * the port gives them their own typed loader.
 */
export function load_expected_value_at_time(samples_dir: Path, sample_name: string): ExpectedValueAtTime {
  return _load_expected_value_at_time_cached(String(samples_dir), sample_name);
}

/** Get all .aep stems in a samples directory. */
export function get_sample_files(samples_dir: Path): string[] {
  if (!samples_dir.exists()) return [];
  return samples_dir.glob("*.aep").map((f) => f.stem);
}

/**
 * `value` as an instance of `cls`, failing the test when it is not. Python
 * tests read a subclass attribute straight off a `Layer` or a group child;
 * here the read narrows first, so a wrong kind fails loudly instead of
 * reading `undefined`.
 */
export function as_instance<T>(value: unknown, cls: abstract new (...args: never[]) => T): T {
  if (!(value instanceof cls)) {
    throw new AssertionError_(`expected a ${cls.name}, got ${value === null ? "null" : typeof value === "object" ? value.constructor.name : typeof value}`);
  }
  return value;
}

/** Get the first layer from the first composition that has layers. */
export function get_first_layer(project: Project): Layer {
  py_assert(len(project.compositions) >= 1);
  for (const comp of project.compositions) {
    if (len(comp.layers) >= 1) return comp.layers[0];
  }
  throw new AssertionError_("No composition with layers found");
}

/** Get the first footage item. */
export function get_first_footage(project: Project): FootageItem | null {
  if (py_bool(project.footages)) return project.footages[0];
  return null;
}

// ---- Name-based lookup helpers for consolidated samples ----

/** Get a composition by name from a project. */
export function get_comp(project: Project, name: string): CompItem {
  for (const comp of project.compositions) {
    if (comp.name === name) return comp;
  }
  throw new ValueError(
    `Composition '${name}' not found. ` +
      `Available: ${repr(project.compositions.map((c) => c.name))}`,
  );
}

/** Get the first layer from a named composition. */
export function get_layer(project: Project, comp_name: string): Layer {
  const comp = get_comp(project, comp_name);
  if (!py_bool(comp.layers)) {
    throw new ValueError(`Composition '${comp_name}' has no layers`);
  }
  return comp.layers[0];
}

/** Get a footage item by name. */
export function get_footage(project: Project, name: string): FootageItem {
  for (const item of project.footages) {
    if (item.name === name) return item;
  }
  throw new ValueError(
    `Footage '${name}' not found. Available: ${repr(project.footages.map((f) => f.name))}`,
  );
}

/** Get a folder by name. */
export function get_folder(project: Project, name: string): FolderItem {
  for (const folder of project.folders) {
    if (folder.name === name) return folder;
  }
  throw new ValueError(
    `Folder '${name}' not found. Available: ${repr(project.folders.map((f) => f.name))}`,
  );
}

/** Get a render queue item by its composition name. */
export function get_rqi(project: Project, comp_name: string): RenderQueueItem {
  if (project.renderQueue === null) throw new AssertionError_("project.render_queue is None");
  for (const rqi of project.renderQueue.items) {
    if (rqi.comp.name === comp_name) return rqi;
  }
  throw new ValueError(`RQI for comp '${comp_name}' not found`);
}

// ---- First-item JSON helpers (for non-consolidated single-comp samples) ----

/** Extract first composition from expected JSON. */
export function get_comp_from_json(expected: ExpectedProject): ExpectedComp | EmptyJson {
  for (const item of _jget(expected, "items", [])) {
    if (item.typeName === "Composition") return item;
  }
  return {};
}

/** Extract first layer from expected JSON. */
export function get_layer_from_json(expected: ExpectedProject): ExpectedLayer | EmptyJson {
  for (const item of _jget(expected, "items", [])) {
    if ("layers" in item && len(item.layers) > 0) return item.layers[0];
  }
  return {};
}

// ---- Name-based JSON lookup helpers ----

/** Get a specific composition from JSON by name. */
export function get_comp_from_json_by_name(expected: ExpectedProject, name: string): ExpectedComp | EmptyJson {
  for (const item of _jget(expected, "items", [])) {
    if (item.typeName === "Composition" && item.name === name) return item;
  }
  return {};
}

/** Get first layer from a named composition in JSON. */
export function get_layer_from_json_by_comp(expected: ExpectedProject, comp_name: string): ExpectedLayer | EmptyJson {
  const comp = get_comp_from_json_by_name(expected, comp_name);
  if (_json_truthy(comp) && "layers" in comp && py_bool(comp.layers)) {
    return comp.layers[0];
  }
  return {};
}

/** Get a specific footage item from JSON by name. */
export function get_footage_from_json_by_name(expected: ExpectedProject, name: string): ExpectedFootage | EmptyJson {
  for (const item of _jget(expected, "items", [])) {
    if (item.typeName === "Footage" && item.name === name) return item;
  }
  return {};
}

/** Get a specific folder from JSON by name. */
export function get_folder_from_json_by_name(expected: ExpectedProject, name: string): ExpectedFolder | EmptyJson {
  for (const item of _jget(expected, "items", [])) {
    if (item.typeName === "Folder" && item.name === name) return item;
  }
  return {};
}

/** Get first composition marker from a named composition in JSON. */
export function get_comp_marker_from_json_by_name(expected: ExpectedProject, comp_name: string): ExpectedMarker | EmptyJson {
  const comp = get_comp_from_json_by_name(expected, comp_name);
  const markers = _jget(comp, "markers", []);
  if (Array.isArray(markers) && py_bool(markers)) return markers[0];
  return {};
}

/** Get first layer marker value from a named composition in JSON. */
export function get_layer_marker_from_json_by_comp(expected: ExpectedProject, comp_name: string): ExpectedMarker | EmptyJson {
  const comp = get_comp_from_json_by_name(expected, comp_name);
  if (_json_truthy(comp) && "layers" in comp) {
    for (const layer of comp.layers) {
      for (const prop of _jget(layer, "properties", [])) {
        if (prop.matchName === "ADBE Marker") {
          const kfs = prop.keyframes ?? [];
          // An `ADBE Marker` keyframe's value is always a marker record.
          if (py_bool(kfs)) {
            const value = kfs[0].value;
            if (typeof value === "object" && value !== null && "cuePointName" in value) return value;
          }
        }
      }
    }
  }
  return {};
}
