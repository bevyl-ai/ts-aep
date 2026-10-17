// Port of py_aep/models/layers/layer.py

import type { LdtaChunk } from "../../binary/layer_chunks.ts";
import type { Keyframe } from "../properties/keyframe.ts";
import type { MarkerValue } from "../properties/marker.ts";
import { AutoOrientType, Label, LayerType } from "../../enums/index.ts";
import { ae_writes } from "../../ae_version.ts";
import { Chunk, ListChunk } from "../../binary/chunk.ts";
import { layer_timebase, rescale_ticks } from "../../binary/composition_chunks.ts";
import { CmtaChunk } from "../../binary/item_chunks.ts";
import { build_gide_list, build_ovdg, clone_chunk_tree, remap_layer_ref_tdpi, rewrite_owner_tdpi, rewrite_time_base } from "../../binary/mutations.ts";
import { TdmnChunk, TdsbChunk, TdsnChunk } from "../../binary/property_chunks.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { find_by_type, index_by_identity, list_type_of } from "../../binary/utils.ts";
import { parse_properties } from "../../parsers/property.ts";
import { get_match_name_runs } from "../../parsers/utils.ts";
import { Mat4, aspect_scale, build_world_matrix, compose_orientation, decompose_transform, layer_source_aspect, position_space_aspect, rig_aims_at_poi, rotation_part, square_pixels, strip_orientation } from "../../resolvers/transform.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import { auto_name } from "../naming.ts";
import { Property } from "../properties/property.ts";
import { PropertyBase } from "../properties/property_base.ts";
import { PropertyGroup } from "../properties/property_group.ts";
import { _validate_number, validate_int, validate_number, validate_string } from "../validators.ts";
import type { CompItem } from "../items/composition.ts";
import type { AVLayer } from "./av_layer.ts";
import {
  KeyError,
  ValueError,
  descriptor,
  getattr,
  setattr,
  mod,
  object_setattr,
  py_assert,
  py_bool,
  py_eq,
  py_or,
  repr,
  round,
  warn,
  deferred,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import type { MatchNameTypes } from "../properties/match_name_types.ts";

const _synthesis_core = deferred<typeof import("../../synthesis/core.ts")>("py_aep/synthesis/core");
const _av_layer = deferred<typeof import("./av_layer.ts")>("py_aep/models/layers/av_layer");
const _composition = deferred<typeof import("../items/composition.ts")>("py_aep/models/items/composition");
const _layer = deferred<typeof import("../../parsers/layer.ts")>("py_aep/parsers/layer");

// logging.getLogger(__name__)
export const logger = {
  debug() {},
  info() {},
  warning: (m: string) => warn(m),
};

// AE turns any stretch under 1 % into 655 / 65536 (1 % in 16.16, rounded
// down), in percent.
export const _MIN_STRETCH = (655 * 100) / 65536;

// The stretch is a float32 stored as a ratio with a signed 32-bit dividend;
// 2147483520 is the largest float32 under 2**31.
export const _validate_stretch = _validate_number({
  min: -2147483520 * 100.0,
  max: 2147483520 * 100.0,
});

// The start time is a signed 32-bit count of the layer's timebase ticks.
export const _validate_start_time = _validate_number({
  min: (layer: Layer) => -0x80000000 / layer._layer_timebase(),
  max: (layer: Layer) => 0x7fffffff / layer._layer_timebase(),
});

/** Sentinel value indicating an undefined source id in the binary format. */
export const _UNDEFINED_ID = 0xffffffff;

/**
 * The ldta source id of a light without a source: 0 before AE 23, which
 * writes the undefined id.
 */
export function _no_source_id(comp: CompItem): number {
  const major = comp._project._head.ae_version_major;
  return ae_writes("light source id", major) ? _UNDEFINED_ID : 0;
}

/** World matrix a child of `parent` is placed in, at comp `time`. */
export function _parent_world(parent: Layer | null, time: number, child_is_3d: boolean): Mat4 {
  if (parent == null) return Mat4.identity();
  return build_world_matrix(parent, time, !child_is_3d, { as_parent: true });
}

/** `list.index(x)` with `==` (identity for layers) and CPython's ValueError. */
export function _list_index<T>(xs: T[], x: T): number {
  for (let i = 0; i < xs.length; i++) if (xs[i] === x) return i;
  throw new ValueError(`${repr(x)} is not in list`);
}

/** `list.remove(x)` with CPython's ValueError. */
export function _list_remove<T>(xs: T[], x: T): void {
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === x) {
      xs.splice(i, 1);
      return;
    }
  }
  throw new ValueError("list.remove(x): x not in list");
}

/** A group holding a property whose left-out default follows other state (see `Layer._LIVE_DEFAULTS`). */
export type LiveDefaultGroup = "ADBE Transform Group" | "ADBE Camera Options Group";
/** A property whose left-out default follows other state (see `Layer._LIVE_DEFAULTS`). */
export type LiveDefaultProperty = "ADBE Position" | "ADBE Camera Zoom" | "ADBE Camera Focus Distance";

/** Keyword arguments of `Layer._new`. */
type LayerNewKw = {
  ldta: LdtaChunk;
  name: string;
  containing_comp: CompItem;
  root_tdgp_extra?: Chunk[] | null;
  effect_param_defs?: EffectParamDefs | null;
};

/** Keyword arguments of the `Layer` constructor. */
type LayerInitKw = {
  _ldta: LdtaChunk;
  _cmta: CmtaChunk | null;
  _name_utf8: Utf8Chunk;
  _layer_list: ListChunk;
  containing_comp: CompItem;
  properties: (Property | PropertyGroup)[];
  essential_property_uuids: string[];
};

/**
 * The `Layer` object provides access to layers within compositions.
 *
 * Info:
 *     `Layer` is a subclass of {@link PropertyGroup}, which is a subclass of
 *     {@link PropertyBase | PropertyBase}. All
 *     methods and attributes of {@link PropertyGroup}, in addition to those listed below,
 *     are available when working with `Layer` objects.
 *
 * Info:
 *     `Layer` is the base class for {@link CameraLayer} object, {@link LightLayer}
 *     object and {@link AVLayer} object, so `Layer` attributes and methods are
 *     available when working with all layer types.
 *
 * @see https://ae-scripting.docsforadobe.dev/layer/layer/
 */
export class Layer extends PropertyGroup {
  declare ["constructor"]: ClassAttributes<typeof Layer>;
  static _LAYER_MATCH_NAMES: Map<LayerType, string> = new Map<LayerType, string>([
    [LayerType.AV, "ADBE AV Layer"],
    [LayerType.LIGHT, "ADBE Light Layer"],
    [LayerType.CAMERA, "ADBE Camera Layer"],
    [LayerType.TEXT, "ADBE Text Layer"],
    [LayerType.SHAPE, "ADBE Vector Layer"],
    [LayerType.THREE_D_MODEL, "ADBE 3D Model Layer"],
    [LayerType.PARAMETRIC_MESH, "ADBE3D ParametricMeshLayer"],
  ]);

  static _LAYER_TYPE_NAMES: Map<LayerType, string> = new Map<LayerType, string>([
    [LayerType.AV, "AVLayer"],
    [LayerType.LIGHT, "LightLayer"],
    [LayerType.CAMERA, "CameraLayer"],
    [LayerType.TEXT, "Layer"],
    [LayerType.SHAPE, "Layer"],
    [LayerType.THREE_D_MODEL, "Layer"],
    [LayerType.PARAMETRIC_MESH, "ParametricMeshLayer"],
  ]);

  // The (group, property) match names whose default follows other state,
  // which `_write_out_moved_defaults` writes once that state moves it.
  static _LIVE_DEFAULTS: ReadonlyArray<readonly [LiveDefaultGroup, LiveDefaultProperty]> = [];

  /**
   * When `true`, the layer is enabled. Overrides `PropertyBase.enabled`
   * to read from the ldta chunk. Read / Write.
   */
  declare enabled: boolean;

  /**
   * Unique and persistent identification number used internally to
   * identify a Layer between sessions. Read-only.
   */
  declare id: number;

  /**
   * The label color. Colors are represented by their number (0 for None,
   * or 1 to 16 for one of the preset colors in the Labels preferences).
   * Read / Write.
   */
  declare label: Label;

  /**
   * When `true`, the layer is locked. This corresponds to the lock toggle
   * in the Layer panel. Read / Write.
   */
  declare locked: boolean;

  /** When `true`, the layer was created as a null object. Read-only. */
  declare null_layer: boolean;

  /** The ID of the layer's parent layer. `0` if the layer has no parent. */
  declare _parent_id: number;

  /**
   * When `true`, the layer is "shy", meaning that it is hidden in the
   * Layer panel if the composition's "Hide all shy layers" option is
   * toggled on. Read / Write.
   */
  declare shy: boolean;

  /** When `true`, the layer is soloed. Read / Write. */
  declare solo: boolean;

  /**
   * The type of automatic orientation to perform for the layer.
   * Read / Write.
   */
  declare auto_orient: AutoOrientType;

  /**
   * UUIDs of Essential Properties overrides on this layer.
   *
   * Each UUID corresponds to an {@link EssentialGraphicsController} in
   * the source composition's Essential Graphics panel.
   */
  declare essential_property_uuids: string[];

  declare _ldta: LdtaChunk;
  declare _cmta: CmtaChunk | null;
  declare _layer_list: ListChunk;
  declare _containing_comp: CompItem;
  declare _stretch: number;

  /**
   * The start time of the layer, expressed in composition time
   * (seconds). Read / Write.
   *
   * Writing snaps the time to the nearest tick of the layer's own
   * timebase (see {@link stretch}), a tie rounding up, as After Effects does:
   * on AE 2026, 1.3 s on a 24 fps layer reads back as 1.3000081 s
   * (31949 / 24576) and on a 150 % one as 1.2999946 s (47923 / 36864).
   * A later stretch change leaves the stored start alone.
   */
  get start_time(): number {
    return this._ldta.start_time;
  }

  set start_time(value: number) {
    _validate_start_time(value, this);
    const timebase = this._layer_timebase();
    const ldta = this._ldta;
    ldta.start_time_dividend = Math.floor(value * timebase + 0.5);
    ldta.start_time_divisor = timebase;
  }

  /**
   * The layer's time stretch, expressed as a percentage. A value of 100
   * means no stretch. Values between 0 and 1 are set to 1, and values
   * between -1 and 0 (not including 0) are set to -1. Read / Write.
   *
   * Writing also rescales every keyframe on the layer. A layer counts its
   * keyframe ticks against its own timebase,
   * `comp internal_timebase * max(1, |stretch| / 100)` (at most 115200
   * ticks a second), so stretching it
   * while leaving the counts alone would halve or double each keyframe's
   * position in LAYER time. After Effects keeps them fixed there and
   * rescales the counts (measured on AE 2026: a key at layer-second 1 on
   * a 24 fps comp holds 24576 ticks, and 49152 after the layer is
   * stretched to 200 %, where its composition time becomes 2 s).
   *
   * The stretch is stored as AE writes it, a float32 of the percentage
   * / 100: 133.33 reads back as 133.32999944686890. A value under 1
   * (0 included) becomes the smallest stretch AE stores, 655 / 65536,
   * which reads back as 0.99945068359375 (with the sign of a negative
   * value), as on AE 2026. AE refuses more than 9900 % from a script
   * but opens a file holding 1000000 %; py_aep accepts any stretch the
   * file's signed 32-bit ratio can hold.
   */
  get stretch(): number {
    return this._ldta.stretch;
  }

  set stretch(value: number) {
    _validate_stretch(value, this);
    if (Math.abs(value) < 1.0) {
      value = value < 0 ? -_MIN_STRETCH : _MIN_STRETCH;
    }
    const old = this._layer_timebase();
    this._stretch = value;
    this._retime_to_layer_timebase(old, this._layer_timebase());
  }

  /**
   * Keyframe units per second of this layer's own time, in its
   * composition or one of `internal_timebase`.
   */
  _layer_timebase(internal_timebase: number | null = null): number {
    if (internal_timebase == null) {
      internal_timebase = this.containing_comp._cdta.internal_timebase;
    }
    return layer_timebase(internal_timebase, this._stretch_factor);
  }

  /**
   * Hold every keyframe at the same LAYER time across a stretch change
   * (`rescale_ticks`).
   */
  _retime_to_layer_timebase(old: number, new_: number): void {
    if (new_ === old || old <= 0) return;
    for (const prop of this._leaf_properties()) {
      if (prop._is_live()) prop._ensure_time_base();
      for (const keyframe of prop.keyframes) {
        const item = keyframe._ldat_item;
        item.time_units = rescale_ticks(item.time_units, old, new_);
      }
    }
  }

  // Use identity-based equality to avoid comparing all fields recursively,
  // which could produce unexpected results or hit circular references.
  // `__hash__ = object.__hash__` is not carried over: instances are hashed by
  // identity already, which is what a Map/Set keyed by a Layer uses.
  __eq__(other: unknown): boolean {
    return this === other;
  }

  __setattr__(name: string, value: unknown): void {
    // Layers set public instance attributes of their own, which
    // `PropertyGroup.__setattr__` would refuse.
    object_setattr(this, name, value);
  }

  constructor(kw: LayerInitKw) {
    const {
      _ldta,
      _cmta,
      _name_utf8,
      _layer_list,
      containing_comp,
      properties,
      essential_property_uuids,
    } = kw;
    // NOTE(port): TS cannot touch `this` before super(); the early self._ldta/_cmta/_layer_list/essential_property_uuids assignments move below it (the base __init__ never reads them) and new.target stands in for self in the match-name lookup.

    const layer_type_raw = _ldta.layer_type;
    const layer_type = LayerType.of_or_null(layer_type_raw);
    let match_name = layer_type === null ? undefined : new.target._LAYER_MATCH_NAMES.get(layer_type);
    if (match_name === undefined) {
      logger.warning(
        `Unknown layer type ${layer_type_raw} for layer '${_name_utf8.value}' in comp '${containing_comp.name}'. Defaulting to 'ADBE AV Layer'.`,
      );
      match_name = "ADBE AV Layer";
    }

    super({
      _tdsb: null,
      _name_utf8,
      match_name,
      auto_name: "",
      property_depth: 0,
      properties,
    });

    this._ldta = _ldta;
    this._cmta = _cmta;
    this._layer_list = _layer_list;
    this.essential_property_uuids = essential_property_uuids;

    this._containing_comp = containing_comp;
    // PropertyGroup's constructor already returns the py_object proxy that
    // dispatches to this class's __setattr__; wrapping again would recurse.
  }

  /** Build a layer from a fresh ldta chunk (`Layer._new`). */
  // Python marks this override `# type: ignore[override]`; the `never`
  // overload keeps the incompatible base signatures uncallable.
  static _new<T extends Layer>(this: new (kw: LayerInitKw) => T, kw: LayerNewKw): T;
  static _new(...args: never[]): never;
  static _new<T extends Layer>(this: new (kw: LayerInitKw) => T, kw: LayerNewKw): T {
    const { ldta, name, containing_comp } = kw;
    const root_tdgp_extra = kw.root_tdgp_extra ?? null;
    const effect_param_defs = kw.effect_param_defs ?? null;

    validate_string(name);

    const name_utf8 = new Utf8Chunk({ value: name });
    const tdgp_chunks: Chunk[] = [new TdsbChunk({}), TdsnChunk.new_()];
    if (root_tdgp_extra != null && root_tdgp_extra.length > 0) tdgp_chunks.push(...root_tdgp_extra);
    // AE terminates every tdgp match-name stream with ADBE Group End
    // and rejects layers whose root tdgp lacks it ("missing data in
    // file"). Synthesized children are inserted before this marker.
    tdgp_chunks.push(new TdmnChunk({ value: "ADBE Group End" }));
    const root_tdgp = new ListChunk({ list_type: "tdgp", chunks: tdgp_chunks });
    const ae_major = containing_comp._project._head.ae_version_major;
    // The ldta matte-layer field (164- instead of 160-byte records).
    ldta.matte_layer_id = ae_writes("matte layer id", ae_major) ? 0 : null;
    const [gide, _lhd3, _inner] = build_gide_list();
    const layer_list = new ListChunk({
      list_type: "Layr",
      chunks: [ldta, name_utf8, root_tdgp, gide],
    });
    if (ae_writes("layer OvdG", ae_major)) layer_list.chunks.push(build_ovdg());

    const layer = new this({
      _ldta: ldta,
      _cmta: null,
      _name_utf8: name_utf8,
      _layer_list: layer_list,
      containing_comp,
      properties: [],
      essential_property_uuids: [],
    });
    layer._tdgp = root_tdgp;

    const props = parse_properties(
      get_match_name_runs(root_tdgp),
      1,
      py_or(effect_param_defs, new Map()),
      containing_comp,
      layer,
    );
    layer._properties = props;
    for (const child of props) child._parent_property = layer;

    _synthesis_core().synthesize_layer_properties(layer);
    return layer;
  }

  __repr__(): string {
    return `${this.constructor.name}(enabled=${repr(this.enabled)}, match_name=${repr(this.match_name)}, name=${repr(this.name)})`;
  }

  get name(): string {
    return super.name;
  }

  set name(value: string) {
    // PropertyBase.name.fset(self, value)
    super.name = value;
    this._ldta.layer_name = value;
    // AE sets _layer_flags_0 bit 0 only for a SOURCE-BACKED layer whose name
    // differs from the source item's name. It stays 0 for sourceless layers
    // (camera/light/text/shape) even when named, for an empty (source-
    // inherited) name, and when the name is set back to the source item's
    // own name (verified against the MyGroup precomp layer in
    // grouped_layers_comp.aep, where name == source comp name -> bit 0).
    // Parametric mesh layers are the exception among sourceless layers:
    // renaming one in AE 2026 sets the bit, and it STAYS set even when
    // renamed back to the original default name (headless rename
    // experiment on parametric_meshes.aep), matching addParametricMesh's
    // explicit-name behavior.
    const source_id = this._ldta.source_id;
    if (this._ldta.layer_type === LayerType.PARAMETRIC_MESH) {
      this._ldta.name_set = true;
    } else if (!value || source_id === 0) {
      this._ldta.name_set = false;
    } else {
      const source_item = this.containing_comp._project.items.get(source_id);
      this._ldta.name_set = (source_item?.name ?? null) !== value;
    }
  }

  /** A descriptive comment for the layer. Read / Write. */
  get comment(): string {
    // AE 2026 shows no comment for a `cmta` whose ldta flag is unset.
    if (this._cmta == null || !this._ldta.has_comment) return "";
    return this._cmta.value;
  }

  set comment(value: string) {
    validate_string(value);
    if (!value) {
      // AE drops the chunk and the flag rather than store "".
      if (this._cmta != null) {
        const chunks = this._layer_list.chunks;
        chunks.splice(index_by_identity(chunks, this._cmta), 1);
        this._cmta = null;
      }
      this._ldta.has_comment = false;
      return;
    }
    this._ldta.has_comment = true;
    if (this._cmta != null) {
      this._cmta.value = value;
    } else {
      const chunk = new CmtaChunk({});
      chunk.value = value;
      const chunks = this._layer_list.chunks;
      // AE 15 writes the comment before the LIST:OvdG closing a layer.
      const ends_with_ovdg = list_type_of(chunks.at(-1)) === "OvdG";
      chunks.splice(ends_with_ovdg ? chunks.length - 1 : chunks.length, 0, chunk);
      this._cmta = chunk;
    }
  }

  /** The composition that contains this layer. Read-only. */
  get containing_comp(): CompItem {
    return this._containing_comp;
  }

  /**
   * The type of layer. Matches ExtendScript `layerType` values:
   * `"AVLayer"`, `"LightLayer"`, `"CameraLayer"`,
   * `"ParametricMeshLayer"`, or `"Layer"`. Read-only.
   */
  get layer_type(): string {
    return this.constructor._LAYER_TYPE_NAMES.get(LayerType.of(this._ldta.layer_type)) ?? "AVLayer";
  }

  /**
   * The current time of the layer, expressed in composition time
   * (seconds). Read-only.
   */
  get time(): number {
    return this._containing_comp.time;
  }

  /**
   * The current time of the layer, expressed in composition time
   * (frames). Read-only.
   */
  get frame_time(): number {
    return this._containing_comp.frame_time;
  }

  /**
   * Whether the layer transforms in three dimensions.
   *
   * `false` on the base {@link Layer}: only an {@link AVLayer} carries the
   * 3D switch, and cameras and lights are always 3D, so both override
   * this. Read-only.
   */
  get is_3d(): boolean {
    return false;
  }

  /**
   * The layer's pixel dimensions, for denormalizing effect points.
   *
   * `null` on the base {@link Layer}: `width` / `height` live on
   * {@link AVLayer}, and a camera or light has neither, so nothing
   * normalized against a layer sits on one.
   */
  get _pixel_size(): [number, number] | null {
    return null;
  }

  get _stretch_factor(): number {
    const stretch = this.stretch;
    return stretch !== 0.0 ? stretch / 100.0 : 1.0;
  }

  /**
   * Composition time of the layer's own time 0.
   *
   * The start time, except on a time-reversed layer, which After
   * Effects places `|stretch| / 100 / 3000` s earlier: its in point,
   * out point and keyframes all move by that much (measured on AE
   * 2026 at -50 / -100 / -150 / -200 % on solid, null, text and
   * precomp layers, starts 1.3 and -0.7 s, and 24 / 25 / 30 fps).
   */
  get _time_origin(): number {
    const factor = this._stretch_factor;
    if (factor >= 0) return this.start_time;
    return this.start_time + factor / 3000.0;
  }

  /**
   * The "in" point of the layer, expressed in composition time
   * (seconds). Read / Write.
   *
   * On a time-reversed layer the in point is the later end, and sits
   * `|stretch| / 100 / 3000` s before the start time (1.2995 s for a
   * -150 % layer starting at 1.3 s), as After Effects reports it.
   */
  get in_point(): number {
    return this._time_origin + this._ldta.in_point * this._stretch_factor;
  }

  set in_point(value: number) {
    validate_number(value);
    this._set_raw_in_point(value);
  }

  /**
   * The "out" point of the layer, expressed in composition time
   * (seconds). Read / Write.
   *
   * On a time-reversed layer the out point is the earlier end (see
   * {@link in_point}).
   */
  get out_point(): number {
    return this._time_origin + this._ldta.out_point * this._stretch_factor;
  }

  set out_point(value: number) {
    validate_number(value);
    this._set_raw_out_point(value);
  }

  /**
   * The "in" point of the layer, expressed in composition time
   * (frames). Read / Write.
   */
  get frame_in_point(): number {
    return round(this.in_point * this.containing_comp.frame_rate);
  }

  set frame_in_point(value: number) {
    validate_int(value);
    this.in_point = value / this.containing_comp.frame_rate;
  }

  /**
   * The "out" point of the layer, expressed in composition time
   * (frames). Read / Write.
   */
  get frame_out_point(): number {
    return round(this.out_point * this.containing_comp.frame_rate);
  }

  set frame_out_point(value: number) {
    validate_int(value);
    this.out_point = value / this.containing_comp.frame_rate;
  }

  /**
   * The start time of the layer, expressed in composition time
   * (frames). Read / Write.
   */
  get frame_start_time(): number {
    return round(this.start_time * this.containing_comp.frame_rate);
  }

  set frame_start_time(value: number) {
    validate_int(value);
    this.start_time = value / this.containing_comp.frame_rate;
  }

  /**
   * The 0-based index position of the layer in its containing comp.
   *
   * **Warning:** Unlike ExtendScript (1-based), this uses Python's 0-based
   * convention so that `comp.layers[layer.index]` works directly.
   */
  get index(): number {
    return _list_index(this.containing_comp.layers, this);
  }

  /**
   * `true` if the layer has a video switch in the Timeline panel.
   *
   * Always `false` for {@link CameraLayer} and {@link LightLayer} objects.
   */
  get has_video(): boolean {
    return false;
  }

  /**
   * `true` if the layer is an adjustment layer.
   *
   * Always `false` for {@link CameraLayer} and {@link LightLayer} objects.
   * Overridden in {@link AVLayer} to read from the binary chunk.
   */
  get adjustment_layer(): boolean {
    return false;
  }

  /**
   * `true` if the layer is an environment layer.
   *
   * Always `false` for {@link CameraLayer} and {@link LightLayer} objects.
   * Overridden in {@link AVLayer} to read from the binary chunk.
   */
  get environment_layer(): boolean {
    return false;
  }

  /**
   * When `true`, the layer is active at the current time.
   *
   * Overrides {@link PropertyBase.active} to evaluate
   * {@link active_at_time} at {@link time}.
   */
  get active(): boolean {
    return this.active_at_time(this.time);
  }

  /**
   * The layer's marker property.
   *
   * A {@link Property | Property} with
   * `match_name="ADBE Marker"` whose keyframes hold marker values.
   * `null` when the layer has no markers.
   */
  get marker(): Property<MarkerValue | null> | null {
    return this._child_or_null("ADBE Marker");
  }

  /**
   * A flat array of {@link MarkerValue} objects for this layer.
   *
   * Shortcut for accessing marker data without navigating the property
   * tree. Returns an empty array when the layer has no markers.
   *
   * @example
   * ```ts
   * import { parse } from "@bevyl-ai/ts-aep";
   *
   * const app = parse("project.aep");
   * const layer = app.project.compositions[0].layers[0];
   * for (const marker of layer.markers) {
   *   console.log(marker.comment);
   * }
   * ```
   */
  get markers(): MarkerValue[] {
    if (this.marker == null) return [];
    return this.marker.keyframes.map((kf) => kf.value);
  }

  /**
   * Remove all markers from this layer.
   *
   * A no-op when the layer has no markers.
   */
  remove_all_markers(): void {
    if (this.marker != null) this.marker.remove_all_keys();
  }

  /**
   * Contains a layer's transform properties.
   *
   * This is the Transform `PropertyGroup` (match name
   * `ADBE Transform Group`). Individual transform properties (Position,
   * Scale, Rotation, etc.) are accessible via
   * {@link PropertyGroup.properties | properties}.
   */
  get transform(): MatchNameTypes["ADBE Transform Group"] {
    const group = this.property("ADBE Transform Group");
    py_assert(group instanceof PropertyGroup);
    return group;
  }

  /**
   * Contains a layer's effects.
   *
   * This is the Effects `PropertyGroup` (match name `ADBE Effect Parade`).
   * Each child in {@link PropertyGroup.properties | properties} is itself a
   * {@link PropertyGroup} representing one effect.
   *
   * Like ExtendScript's `layer.property("Effects")`, the group is
   * returned even when it is empty, so the first effect can be added
   * with `layer.effects.add_property(...)`. An empty group is falsy,
   * so `if layer.effects:` still means "has effects".
   *
   * `null` on {@link CameraLayer} and {@link LightLayer}, the only layer kinds
   * AE gives no Effects group; every other layer kind always has one.
   */
  get effects(): PropertyGroup | null {
    return this._optional_group("ADBE Effect Parade");
  }

  /**
   * Contains a layer's masks.
   *
   * This is the Masks `PropertyGroup` (match name `ADBE Mask Parade`).
   * Each child in {@link PropertyGroup.properties | properties} is itself a
   * {@link PropertyGroup} representing one mask.
   *
   * Like {@link effects}, the group is returned even when it is empty (an
   * empty group is falsy), and is `null` only on {@link CameraLayer} and
   * {@link LightLayer}, which AE gives no Masks group.
   */
  get masks(): PropertyGroup | null {
    return this._optional_group("ADBE Mask Parade");
  }

  /**
   * Contains a layer's text properties.
   *
   * This is the Text `PropertyGroup` (match name `ADBE Text Properties`),
   * holding Source Text, Path Options, More Options and the Animators.
   *
   * `null` on every layer that is not a {@link TextLayer}: unlike
   * {@link effects} and {@link masks}, this group is never synthesized for
   * other layer kinds because AE does not expose it on them.
   */
  get text(): MatchNameTypes["ADBE Text Properties"] | null {
    return this._optional_group("ADBE Text Properties");
  }

  /**
   * The child `PropertyGroup` for `match_name`, or `null` when this
   * layer kind does not have it.
   *
   * Missing top-level groups are synthesized per layer kind by
   * `synthesize_layer_properties`, so a `null` here means the kind has
   * no such group at all, not that the `.aep` merely omitted an empty
   * one (AE writes the Effect / Mask Parade only once it has content).
   */
  _optional_group<K extends keyof MatchNameTypes>(match_name: K): (MatchNameTypes[K] & PropertyGroup) | null {
    const group = this._child_or_null(match_name);
    return group instanceof PropertyGroup ? group : null;
  }

  /**
   * Write the left-out properties whose default has moved.
   *
   * AE leaves a property at its default out of the file, and some
   * defaults follow other state (a camera's Position its Zoom, a camera
   * or light's its comp's size). When that state changes AE writes the
   * property, keeping it where it was, so it reads modified; left out,
   * it would reopen at the new default instead (measured on AE 2026).
   * Run on save, so every way of changing the state is covered.
   */
  _write_out_moved_defaults(): void {
    for (const [group_name, match_name] of this.constructor._LIVE_DEFAULTS) {
      const group = this.property(group_name);
      const prop = group.property(match_name);
      if (prop._tdsb == null || !prop._tdsb.synthetic) continue;
      if (prop.is_modified) prop._ensure_materialized();
    }
  }

  /**
   * Reject parent assignments ExtendScript refuses: a layer from
   * another comp, the layer itself, or any of its own descendants
   * (which would create a parenting cycle).
   */
  _validate_parent(new_parent: Layer | null): void {
    if (new_parent == null) return;
    if (!(new_parent instanceof Layer)) {
      throw new ValueError("parent must be a Layer or None");
    }
    if (new_parent.containing_comp !== this.containing_comp) {
      throw new ValueError("parent must be a layer in the same composition");
    }
    // Walk up from the candidate; hitting self means a cycle. The
    // visited set keeps this terminating even on a file that already
    // contains a parenting cycle.
    const seen = new Set<unknown>([this]);
    let current: Layer | null = new_parent;
    while (current != null) {
      if (seen.has(current)) {
        throw new ValueError(
          "cannot parent a layer to itself or to one of its descendants",
        );
      }
      seen.add(current);
      current = current.parent;
    }
  }

  /**
   * The parent of this layer; can be `null`.
   *
   * Offset values are calculated to counterbalance any transforms above this layer
   * in the hierarchy, so that when you set the parent there is no apparent jump in
   * the layer's transform.
   *
   * For example, if the new parent has a rotation of 30 degrees, the child layer is
   * assigned a rotation of -30 degrees.
   *
   * Like After Effects, the offsets are computed from the transforms at the
   * composition's current {@link Layer.time | time}, and a parent scaled to 0 is
   * set without any offset.
   *
   * To set the parent without changing the child layer's transform values, use the
   * set_parent_with_jump method.
   *
   * Read / Write.
   */
  get parent(): Layer | null {
    if (this._parent_id === 0) return null;
    return this.containing_comp.layers_by_id.get(this._parent_id) ?? null;
  }

  set parent(value: Layer | null) {
    this._validate_parent(value);
    const old_parent = this.parent;
    if (old_parent === value) return;

    // AE compensates once, from the transforms at the comp's current
    // time (measured on AE 2026: with the playhead at 1 s, a child of a
    // parent animated from 0 to 90 degrees gets Rotate Z -45).
    const time = this.containing_comp.time;
    // A 2D child cannot store an out-of-plane rotation, and AE does not
    // try: it compensates as though every ancestor were 2D. Building the
    // matrices the same way keeps our answer on AE's.
    const is_3d = this.is_3d;
    const comp = this.containing_comp;
    this._compensate_reparent(
      value,
      build_world_matrix(this, time, !is_3d),
      _parent_world(old_parent, time, is_3d),
      _parent_world(value, time, is_3d),
      time,
      [comp.pixel_aspect, position_space_aspect(old_parent, comp)],
      [comp.pixel_aspect, position_space_aspect(value, comp)],
    );
  }

  /**
   * Parent this layer to `new_parent` (`null` to unparent), rewriting
   * its transform so `child_world` (its world matrix under the old
   * parent, at comp `time`) does not move.
   *
   * `old_aspects` / `new_aspects` are the `(comp, Position space)` pixel
   * aspects under the old / new parent (see
   * `resolvers.transform.position_space_aspect`): the transform values
   * live in square pixels, so the matrices are squared before they are
   * decomposed.
   */
  _compensate_reparent(
    new_parent: Layer | null,
    child_world: Mat4,
    old_parent_world: Mat4,
    new_parent_world: Mat4,
    time: number,
    old_aspects: [number, number],
    new_aspects: [number, number],
  ): void {
    let new_parent_inverse: Mat4;
    try {
      new_parent_inverse = new_parent_world.inverse();
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      // A parent scaled to 0 has no inverse; AE 2026 parents to it
      // anyway and leaves the child's values untouched.
      this._parent_id = new_parent != null ? new_parent.id : 0;
      return;
    }
    this._parent_id = new_parent != null ? new_parent.id : 0;
    const is_3d = this.is_3d;
    const new_space = new_aspects[1];
    const own_aspect = layer_source_aspect(this);
    // The local matrix is `T(pos) . Sp^-1 . R . S . Sl . T(-anchor)`
    // (`build_local_matrix`); undo the two aspect scalings to decompose
    // the square-pixel `T(Sp pos) . R . S . T(-Sl anchor)`.
    const new_local = aspect_scale(new_space)
      .__matmul__(new_parent_inverse)
      .__matmul__(child_world)
      .__matmul__(aspect_scale(1.0 / own_aspect));
    // Maps a point from the old parent's space into the new one; used by
    // both keyframed-Position branches below.
    const parent_remap = new_parent_inverse.__matmul__(old_parent_world);

    const transform = this.transform;

    const current = (match_name: "ADBE Anchor Point" | "ADBE Orientation" | "ADBE Scale"): number[] => {
      const prop = transform.property(match_name);
      return prop.keyframes?.length > 0 ? prop.value_at_time(time) : prop.value;
    };

    // Decompose into AE transform components, keeping anchor fixed.
    const anchor = current("ADBE Anchor Point");
    const square_anchor = [anchor[0] * own_aspect, ...anchor.slice(1)];

    // Position and scale come straight from the local matrix - neither
    // depends on how the rotation is split between Orientation and
    // Rotate X/Y/Z. `new_rz` is only used on the 2D path below, where the
    // orientation is divided out of the 3x3 first so it cannot leak into
    // the rotation (a layer switched from 3D to 2D can still carry one).
    const orientation = current("ADBE Orientation");
    let new_pos = decompose_transform(new_local, square_anchor)[0];
    new_pos = [new_pos[0] / new_space, ...new_pos.slice(1)];
    let [, new_scale, new_rz] = decompose_transform(
      strip_orientation(new_local, orientation),
      square_anchor,
    );
    if (new_scale[0] < 0 && is_3d) {
      // `decompose_transform` signals a mirrored basis by negating x
      // alone. AE spreads the flip across all three axes and keeps the
      // rotation proper: a parent scaled [-100, 100, 100] leaves the
      // child at [-100, -100, -100] with Orientation [180, 0, 0]. A 2D
      // layer has no Orientation to absorb that and keeps the x-only
      // flip (AE 2026: a [-100, 100] child under a 150 % parent gets
      // [-66.7, 66.7, 100]).
      new_scale = new_scale.map((component) => -Math.abs(component));
    }

    const write_compensation = (match_name: "ADBE Position" | "ADBE Scale" | "ADBE Rotate Z", new_value: number | number[]): void => {
      // Only write values that actually changed to avoid materializing
      // synthetic properties unnecessarily. Keyframed scale / rotation
      // values are left untouched, matching ExtendScript (the layer
      // may visually jump for those).
      const prop = transform.property(match_name);
      if (prop.keyframes?.length > 0) return;
      if (!py_eq(prop.value, new_value)) prop.value = new_value;
    };

    const remap_separated_keyframes = (leader: Property<number[]>, followers: Property<number>[]): void => {
      // Remap an animated separated Position into the new parent's space.
      //
      // A separated leader holds no keyframes of its own, so the generic
      // keyframe branch below never sees this case. Each follower
      // keyframe is remapped through the leader's composed position at
      // its own time, because the transform mixes the axes.
      const remap = parent_remap;
      // Collected first, applied after: every sample has to see the
      // pre-remap followers, and a component write would move them.
      const updates: [Keyframe, number][] = [];
      const remapped = new Map<number, number[]>();
      for (const [dimension, follower] of followers.entries()) {
        for (const keyframe of follower.keyframes) {
          const time = keyframe.time;
          let point: number[] | null = remapped.get(time) ?? null;
          if (point == null) {
            point = remap.transform_point(leader.value_at_time(time));
            remapped.set(time, point);
          }
          updates.push([keyframe, point[dimension]]);
        }
      }
      for (const [keyframe, component] of updates) {
        keyframe.value = component;
      }
    };

    // AE remaps a keyframed Scale rather than leaving it: under a parent
    // scaled to 50% each key doubles, and under one scaled
    // [200, 50, 100] each key is divided per axis. Skipping them left
    // the layer 25 px out at one time and 62 px at another.
    const scale_prop = transform.property("ADBE Scale");
    if (scale_prop.keyframes?.length > 0) {
      const scale_now = current("ADBE Scale");
      const factors = Array.from({ length: new_scale.length }, (_, axis) =>
        axis < scale_now.length && scale_now[axis] !== 0
          ? new_scale[axis] / scale_now[axis]
          : 1.0,
      );
      // Skipped when the parent applies no scale, for the reason
      // `write_compensation` gives: an unchanged value is not written.
      if (factors.some((factor) => factor !== 1.0)) {
        for (const keyframe of scale_prop.keyframes) {
          const components = keyframe.value;
          keyframe.value = components.map((component, axis) =>
            axis < factors.length ? component * factors[axis] : component,
          );
        }
      }
    } else {
      write_compensation("ADBE Scale", new_scale);
    }

    // ExtendScript remaps every POSITION keyframe into the new parent's
    // space (measured in AE 2026).
    const pos = transform.property("ADBE Position");
    const separated = pos._separation_followers();
    if (separated != null) {
      // AE refuses `setValue` on a separated leader, but compensates
      // the followers itself on a reparent (measured on AE 2026: a
      // separated child at (150, 160) under a parent at (300, 40)
      // becomes X = -150, Y = 120), so go through them directly.
      if (separated.some((follower) => follower.keyframes?.length > 0)) {
        remap_separated_keyframes(pos, separated);
      } else {
        pos._set_separated_value(new_pos, separated);
      }
    } else if (pos.keyframes?.length > 0) {
      const remap = parent_remap;
      for (const kf of pos.keyframes) {
        const kf_value = kf.value;
        const dims = kf_value.length;
        kf.value = remap.transform_point(kf_value).slice(0, dims);
        for (const tangent_attr of ["in_spatial_tangent", "out_spatial_tangent"]) {
          const tangent = getattr(kf, tangent_attr);
          if (py_bool(tangent)) {
            setattr(kf, tangent_attr, remap.transform_vector(tangent).slice(0, tangent.length));
          }
        }
      }
    } else {
      write_compensation("ADBE Position", new_pos);
    }

    if (this._ldta.layer_type === LayerType.CAMERA || this._ldta.layer_type === LayerType.LIGHT) {
      // A camera or light keeps its point of interest in the Anchor
      // Point slot, in its parent's space: AE 2026 remaps it like
      // Position (a two-node camera's POI [900, 500, 0] under a null at
      // [700, 400, -100] turned 30 degrees about Y became
      // [123.2, 100, 186.6]).
      const poi = transform.property("ADBE Anchor Point");
      if (poi.keyframes?.length > 0) {
        for (const kf of poi.keyframes) {
          const kf_value = kf.value;
          kf.value = parent_remap.transform_point(kf_value).slice(0, kf_value.length);
        }
      } else {
        const remapped = parent_remap.transform_point(anchor).slice(0, anchor.length);
        if (!py_eq(remapped, anchor)) poi.value = remapped;
      }
      if (rig_aims_at_poi(this)) {
        // The look-at toward the remapped POI already turns the rig;
        // AE leaves its Orientation alone.
        return;
      }
    }

    if (this.auto_orient === AutoOrientType.ALONG_PATH) {
      // The path, remapped with Position, carries the parent's turn;
      // AE 2026 leaves the rotations alone (a 2D layer's Rotate Z and
      // a 3D layer's Orientation, animated path or static).
      return;
    }
    const rotation_delta = rotation_part(square_pixels(new_parent_world, ...new_aspects))
      .inverse()
      .__matmul__(rotation_part(square_pixels(old_parent_world, ...old_aspects)));
    if (!is_3d) {
      // A 2D layer has no Orientation to use, so AE puts the rotation
      // into Rotate Z (measured: a 2D child under a 30-degree parent
      // gets rotZ = -30 and orientation stays [0,0,0]).
      const rotation = transform.property("ADBE Rotate Z");
      if (rotation.keyframes?.length > 0) {
        // AE offsets every rotation keyframe rather than giving up on
        // an animated one - keys of 15 and 75 under a 30-degree
        // parent became -15 and 45. Skipping them, as
        // `write_compensation` does, left the layer 35 px out.
        // As a signed turn, not the 0-360 form `compose_orientation`
        // returns: AE stores -15 and 45, not 345 and 405.
        const offset =
          mod(compose_orientation([0.0, 0.0, 0.0], rotation_delta)[2] + 180.0, 360.0) - 180.0;
        for (const keyframe of rotation.keyframes) {
          keyframe.value = keyframe.value + offset;
        }
        return;
      }
      write_compensation("ADBE Rotate Z", new_rz);
      return;
    }

    // A 3D layer is compensated entirely through Orientation:
    // `O_new = parent_rotation^-1 . O_old`, with Rotate X/Y/Z left
    // exactly as they were. Verified on AE 2026 over ten cases.
    //
    // This is not just a different way to store the same result. Writing
    // the rotations instead collides with `write_compensation` skipping
    // keyframed properties: a child with a keyframed Rotate Z would get
    // its position compensated but not its rotation, and jump by 362 px
    // in a case where AE does not move it at all.
    const orientation_prop = transform.property("ADBE Orientation");
    if (orientation_prop.keyframes?.length > 0) {
      for (const keyframe of orientation_prop.keyframes) {
        keyframe.value = compose_orientation(keyframe.value, rotation_delta);
      }
      return;
    }
    const rotated = compose_orientation(orientation, rotation_delta);
    if (!py_eq(orientation_prop.value, rotated)) orientation_prop.value = rotated;
  }

  /**
   * Sets the parent of this layer to the specified layer, without changing the
   * transform values of the child layer.
   *
   * There may be an apparent jump in the rotation, translation, or scale of the
   * child layer, as this layer's transform values are combined with those of its
   * ancestors.
   *
   * If you do not want the child layer to jump, set the parent attribute directly.
   * In this case, an offset is calculated and set in the child layer's transform
   * fields, to prevent the jump from occurring.
   *
   * @param new_parent - The new parent layer, or `null` to unparent.
   * @throws {@link ValueError} If `new_parent` is this layer itself, one of its descendants, or a
   *   layer in another composition.
   */
  set_parent_with_jump(new_parent: Layer | null): void {
    this._validate_parent(new_parent);
    this._parent_id = new_parent != null ? new_parent.id : 0;
  }

  /**
   * Return whether the layer is active at the given time.
   *
   * For this method to return `true`, three conditions must be met:
   *
   * 1. The layer must be `enabled`.
   * 2. No other layer in the {@link containing_comp} may be soloed unless
   *    this layer is also {@link solo}.
   * 3. `time` must fall between {@link in_point} (inclusive) and
   *    {@link out_point} (exclusive).
   *
   * @param time - The time in seconds.
   */
  active_at_time(time: number): boolean {
    validate_number(time);
    if (!this.enabled) return false;

    const any_solo = this.containing_comp.solo_layers?.length > 0;
    if (any_solo && !this.solo) return false;

    if (time < this.in_point || time >= this.out_point) return false;

    return true;
  }

  /**
   * Layer time of a composition time written to the in or out point.
   *
   * AE first snaps the time to the layer's tick grid, a tie rounding up
   * (measured on AE 2026: 2.5 / 24576 s becomes 3 / 24576 s on a 24 fps
   * layer, 1 / 36864 s stays put at 150 %).
   */
  _layer_relative(value: number): number {
    const timebase = this._layer_timebase();
    const snapped = Math.floor(value * timebase + 0.5) / timebase;
    return (snapped - this._time_origin) / this._stretch_factor;
  }

  /** Write a new in_point (comp time) to the binary chunk. */
  _set_raw_in_point(value: number): void {
    this._ldta.in_point = this._layer_relative(value);
  }

  /** Write a new out_point (comp time) to the binary chunk. */
  _set_raw_out_point(value: number): void {
    this._ldta.out_point = this._layer_relative(value);
  }

  // ------------------------------------------------------------------
  // Structural mutations
  // ------------------------------------------------------------------

  /**
   * Deletes this layer from the composition.
   *
   * Layers that reference this layer as a parent become unparented
   * (their transforms are recalculated to preserve world-space
   * appearance).  AVLayers that use this layer as a track matte
   * lose their matte reference.
   */
  remove(this: Layer): void {
    const comp = this.containing_comp;
    const removed_id = this.id;

    // Unparent children - triggers transform recalculation via the
    // parent setter so the child doesn't visually jump.
    for (const layer of comp.layers) {
      if (layer !== this && layer._parent_id === removed_id) {
        layer.parent = null;
      }
    }

    // Clean track matte refs on AV layers
    for (const layer of comp.av_layers) {
      if (layer !== this) {
        const ldta = layer._ldta;
        if ("matte_layer_id" in ldta && ldta.matte_layer_id === removed_id) {
          ldta.matte_layer_id = 0;
        }
      }
    }

    // Update source _used_in if this layer references a source item
    comp._project._ensure_used_in_linked();
    const source = getattr(this, "source", null);
    if (source != null && "_used_in" in source) {
      _av_layer()._unregister_source_usage(source, comp, { exclude: this });
    }

    // Remove chunk block from comp's chunk list
    const [start, end] = comp._layer_block_slice(this);
    comp._item_list.chunks.splice(start, end - start);

    // Remove from model list and rebuild caches
    _list_remove(comp._layers, this);
    comp._invalidate_layer_cache();
  }

  /**
   * Create a duplicate of this layer in the same composition.
   *
   * The duplicate is placed directly above (before) the original
   * layer.
   *
   * @returns The newly created {@link Layer}.
   */
  duplicate(): Layer {
    return this._clone_into(this.containing_comp, { duplicate: true });
  }

  /**
   * Copy this layer into a composition, as After Effects' `copyToComp()`
   * does.
   *
   * The copy is placed at the top of the target layer stack. Its parent
   * is cleared and its transform rewritten so it keeps its place (the
   * parent's transform at time 0 is baked in, whatever the playhead),
   * and the layers its effects reference are cleared - also when the
   * target is this layer's own {@link containing_comp} (use {@link duplicate}
   * to keep them). Into another composition the track matte and an
   * environment light's source are cleared too, and keyframe and
   * marker times are kept in seconds whatever the target's frame rate
   * (measured on AE 2026).
   *
   * @param into_comp - The target {@link CompItem}.
   * @returns The newly created {@link Layer} in the target composition.
   */
  copy_to_comp(into_comp: CompItem): Layer {
    // Circular: models.items.composition -> models.layers -> layer
    if (!(into_comp instanceof _composition().CompItem)) {
      throw new ValueError("Target composition must be a CompItem.");
    }
    return this._clone_into(into_comp, { duplicate: false });
  }

  /**
   * Clone this layer's chunks into `into_comp` and parse the copy:
   * a {@link duplicate} (directly above, references kept) or a
   * {@link copy_to_comp} (on top, references cleared).
   */
  _clone_into(into_comp: CompItem, kw: { duplicate: boolean }): Layer {
    const { duplicate } = kw;

    const same_comp = into_comp === this.containing_comp;
    // Names before the copy joins the comp: it only clashes with others.
    const existing = new Set<string>(into_comp.layers.map((lyr) => lyr.name));
    const old_timebase = this._layer_timebase();
    // The copy keeps its place without its parent: AE bakes the parent's
    // transform at time 0 into it, whatever the playhead (measured on
    // AE 2026: a child at [960, 540] under a parent at [100, 100] with
    // anchor [100, 50] lands at [960, 590]; with the playhead at 0.5 s,
    // an animated parent is still taken at 0).
    let unparent: [Mat4, Mat4, [number, number]] | null = null;
    if (!duplicate && this.parent != null) {
      const is_3d = this.is_3d;
      const src_comp = this.containing_comp;
      unparent = [
        build_world_matrix(this, 0.0, !is_3d),
        _parent_world(this.parent, 0.0, is_3d),
        [src_comp.pixel_aspect, position_space_aspect(this.parent, src_comp)],
      ];
    }

    // Clone the full layer block (LIST:Layr + trailing view chunks)
    const [src_start, src_end] = this.containing_comp._layer_block_slice(this);
    const src_block = this.containing_comp._item_list.chunks.slice(src_start, src_end);
    // The block starts at this layer's own LIST:Layr.
    const cloned_list = clone_chunk_tree(this._layer_list);
    const cloned_block = [cloned_list, ...src_block.slice(1).map((c) => clone_chunk_tree(c))];

    // Patch layer ID
    const cloned_ldta = find_by_type(cloned_list.chunks, "ldta");
    // Layer IDs are unique project-wide, not per-comp.
    cloned_ldta.layer_id = into_comp._project._allocate_id();
    // AE points every effect's hidden -0000 param tdpi at the owning
    // layer; retarget the clones at the fresh id (layer-reference
    // tdpi values keep pointing at the originally referenced layer).
    rewrite_owner_tdpi(cloned_list, cloned_ldta.layer_id);

    // Determine chunk insertion point
    let model_idx: number;
    let chunk_idx: number;
    if (duplicate) {
      model_idx = _list_index(into_comp._layers, this);
      chunk_idx = src_start;
    } else {
      // AE's copyToComp clears the parent and the effect layer
      // references even within the same comp; the matte (a pre-AE 23
      // record has no matte field and must stay that size) and an
      // environment light's source only when they would point into
      // another comp.
      cloned_ldta.parent_id = 0;
      if (!same_comp) {
        if (cloned_ldta.matte_layer_id != null) cloned_ldta.matte_layer_id = 0;
        if (cloned_ldta.layer_type === LayerType.LIGHT) {
          cloned_ldta.source_id = _no_source_id(into_comp);
        }
      }
      // A LAYER parameter (Set Matte, Layer Control, CC Sphere's light
      // layer, ...) names a layer of the SOURCE comp; left as-is the
      // destination comp cannot resolve it and AE refuses the whole file
      // ("Can't find layer ID=N in composition X"). AE 2026 writes 0 -
      // "no layer" - into the copy's parameter.
      remap_layer_ref_tdpi(cloned_list, new Map());
      // tdb4 carries the comp the property was written in; AE restamps
      // the copy to the destination comp (measured: copyToComp from a
      // 25 fps comp into a 24 fps one writes 24576, not 25600). The
      // layer's own stretch scales it, exactly as `_layer_timebase`
      // derives it - a 200 % layer counts ticks against twice the
      // comp's base.
      rewrite_time_base(
        cloned_list,
        this._layer_timebase(into_comp._cdta.internal_timebase),
      );
      model_idx = 0;
      if (into_comp.layers.length > 0) {
        chunk_idx = index_by_identity(
          into_comp._item_list.chunks,
          into_comp.layers[0]._layer_list,
        );
      } else {
        chunk_idx = into_comp._find_first_layer_position();
      }
    }
    into_comp._item_list.chunks.splice(chunk_idx, 0, ...cloned_block);

    // Re-parse cloned chunks into a model instance
    const effect_defs = into_comp._project._effect_param_defs;
    const new_layer = _layer().parse_layer(cloned_list, into_comp, effect_defs);

    into_comp._layers.splice(model_idx, 0, new_layer);

    if (!same_comp) {
      this._carry_comp_relative_transform(new_layer);
      // Keyframe ticks count against the layer's timebase; keep every
      // key (markers included) at the same second, as AE does (a key
      // at 1 s copied from 25 to 24 fps stays at 1 s).
      new_layer._retime_to_layer_timebase(old_timebase, new_layer._layer_timebase());
    }
    if (unparent != null) {
      // Unparented as in the source comp: the copy carries those values
      // whatever the target's pixel aspect (AE 2026 keeps Scale 100
      // copying into a 2:1 comp).
      const [child_world, parent_world, old_aspects] = unparent;
      const source_aspect = old_aspects[0];
      new_layer._compensate_reparent(
        null,
        child_world,
        parent_world,
        Mat4.identity(),
        0.0,
        old_aspects,
        [source_aspect, source_aspect],
      );
    }

    // Increment user-defined name
    if (new_layer.is_name_set && existing.has(new_layer.name)) {
      new_layer.name = auto_name(new_layer.name, existing);
    }

    into_comp._invalidate_layer_cache();

    // Register source _used_in for the cloned layer
    into_comp._project._ensure_used_in_linked();
    const new_source = getattr(new_layer, "source", null);
    if (new_source != null && "_used_in" in new_source) {
      new_source._used_in.add(into_comp);
    }

    return new_layer;
  }

  /**
   * Transform properties whose synthesized default is derived from the
   * containing composition, so a copy into a different-sized comp would
   * silently re-centre unless the value is carried over.
   */
  static _COMP_RELATIVE_TRANSFORM: readonly string[] = [
    "ADBE Anchor Point",
    "ADBE Position",
    "ADBE Position_0",
    "ADBE Position_1",
  ];

  /**
   * Keep `copy`'s comp-relative transform equal to this layer's.
   *
   * A transform property AE never wrote is synthesized from the comp's
   * size, so a copy into a different-sized composition would land on the
   * new comp's centre instead of where the original sits. AE 2026 keeps
   * the absolute value and materializes the chunk to hold it (measured: a
   * 400x300 solid at position 400,300 copied into a 200x100 comp still
   * reads 400,300, with `ADBE Position` now a real cdat).
   */
  _carry_comp_relative_transform(copy: Layer): void {
    const src_transform = this.transform;
    const dst_transform = copy.transform;
    if (src_transform == null || dst_transform == null) return;
    for (const match_name of this.constructor._COMP_RELATIVE_TRANSFORM) {
      let src_prop: Property | PropertyGroup;
      let dst_prop: Property | PropertyGroup;
      try {
        src_prop = src_transform.property(match_name);
        dst_prop = dst_transform.property(match_name);
      } catch (e) {
        if (!(e instanceof KeyError || e instanceof ValueError)) throw e;
        continue;
      }
      if (!(src_prop instanceof Property) || !(dst_prop instanceof Property)) continue;
      // An animated property carries real chunks that the clone copied
      // verbatim, so there is nothing to carry over.
      if (src_prop.keyframes?.length > 0 || dst_prop.keyframes?.length > 0) continue;
      const value = src_prop.value;
      if (value == null || py_eq(value, dst_prop.value)) continue;
      dst_prop.value = value;
    }
  }

  /**
   * Moves this layer to a position immediately after (below)
   * the specified layer.
   *
   * @param layer - The target layer in the same composition.
   */
  move_after(layer: Layer): void {
    if (!(layer instanceof Layer)) throw new ValueError("Target must be a Layer.");

    const comp = this.containing_comp;
    if (layer.containing_comp !== comp) {
      throw new ValueError("Target layer must be in the same composition.");
    }
    const self_idx = _list_index(comp._layers, this);
    const target_idx = _list_index(comp._layers, layer);
    // After self is removed, target shifts left by 1 if self was before it
    const effective = target_idx - (self_idx < target_idx ? 1 : 0);
    this._move_to(effective + 1);
  }

  /**
   * Moves this layer to a position immediately before (above)
   * the specified layer.
   *
   * @param layer - The target layer in the same composition.
   */
  move_before(layer: Layer): void {
    if (!(layer instanceof Layer)) throw new ValueError("Target must be a Layer.");

    const comp = this.containing_comp;
    if (layer.containing_comp !== comp) {
      throw new ValueError("Target layer must be in the same composition.");
    }
    const self_idx = _list_index(comp._layers, this);
    const target_idx = _list_index(comp._layers, layer);
    const effective = target_idx - (self_idx < target_idx ? 1 : 0);
    this._move_to(effective);
  }

  /** Moves this layer to the topmost position of the composition. */
  move_to_beginning(): void {
    this._move_to(0);
  }

  /** Moves this layer to the bottommost position of the composition. */
  move_to_end(): void {
    this._move_to(this.containing_comp.layers.length);
  }

  /**
   * Move this layer to the given model-list index.
   *
   * Uses direct chunk slice extraction and reinsertion, never
   * `remove()`, so parent and track matte connections on other
   * layers are preserved.
   */
  _move_to(target_index: number): void {
    const comp = this.containing_comp;

    // Extract and remove chunk block
    const [start, end] = comp._layer_block_slice(this);
    const block = comp._item_list.chunks.slice(start, end);
    comp._item_list.chunks.splice(start, end - start);

    _list_remove(comp._layers, this);

    // Clamp target index
    target_index = Math.min(target_index, comp._layers.length);

    // Find chunk insertion point
    let chunk_idx: number;
    if (target_index < comp._layers.length) {
      chunk_idx = index_by_identity(
        comp._item_list.chunks,
        comp._layers[target_index]._layer_list,
      );
    } else if (comp._layers.length > 0) {
      const [, last_end] = comp._layer_block_slice(comp._layers[comp._layers.length - 1]);
      chunk_idx = last_end;
    } else {
      chunk_idx = comp._find_first_layer_position();
    }

    // Insert block and model entry
    comp._item_list.chunks.splice(chunk_idx, 0, ...block);
    comp._layers.splice(target_index, 0, this);

    comp._invalidate_layer_cache();
  }
}

// Descriptors assigned in the class body (`enabled = ChunkField.bool(...)`)
// are installed on the prototype after the class is defined.
descriptor(Layer, "enabled", ChunkField.bool("_ldta", "enabled"));
descriptor(Layer, "id", new ChunkField("_ldta", "layer_id", { read_only: true }));
descriptor(Layer, "label", ChunkField.enum(Label, "_ldta", "label"));
descriptor(Layer, "locked", ChunkField.bool("_ldta", "locked"));
descriptor(Layer, "null_layer", new ChunkField("_ldta", "null_layer", { read_only: true }));
descriptor(Layer, "_parent_id", new ChunkField("_ldta", "parent_id"));
descriptor(Layer, "shy", ChunkField.bool("_ldta", "shy"));
descriptor(Layer, "solo", ChunkField.bool("_ldta", "solo"));
descriptor(Layer, "_stretch", new ChunkField("_ldta", "stretch"));
descriptor(Layer, "auto_orient", ChunkField.enum(AutoOrientType, "_ldta", "auto_orient"));
