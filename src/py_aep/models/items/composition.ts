import { uuid4 } from "../../../pyrt/uuid.ts";

import { ae_writes, get_ae_version_major, requires_version } from "../../ae_version.ts";
import { DeferredListChunk, ListChunk, type Chunk } from "../../binary/chunk.ts";
import { _duration_units, _frame_units, build_cps2, build_item_view_chunks, build_layer_view_block, build_new_comp_item } from "../../binary/comp_skeleton.ts";
import { WORK_AREA_TO_END, type CdtaChunk, frame_grid, layer_timebase, rescale_ticks } from "../../binary/composition_chunks.ts";
import type { CmtaChunk, IdtaChunk } from "../../binary/item_chunks.ts";
import { _LDTA_SOURCE_ID_END, _LDTA_SOURCE_ID_OFFSET } from "../../binary/layer_chunks.ts";
import { _PRDA_VARIANTS, PguiChunk, type PrdaChunk, type PrinChunk } from "../../binary/misc_chunks.ts";
import { build_checkbox_cctl, build_color_cctl, build_media_cctl, build_ovg2, build_slider_cctl, build_source_alternate_extras, build_text_cctl, clone_chunk_tree, collect_layer_ref_tdpi_ids, remap_layer_ref_tdpi, rewrite_owner_tdpi, strip_synthetic } from "../../binary/mutations.ts";
import { TDSN_SENTINEL, CdatChunk, Tdb4Chunk, TdmnChunk, TdsbChunk, TdsnChunk } from "../../binary/property_chunks.ts";
import { F8Chunk, S4Chunk, type U1Chunk, type U4Chunk, type U4LeChunk, type Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { block_slice, filter_by_list_type, filter_by_type, find_by_list_type, find_by_list_type_or_null, find_by_type, find_by_type_or_null, index_by_identity, list_type_of, recursive_find } from "../../binary/utils.ts";
import { Label, LayerType, LineOrientation, ParametricMeshType, PREFType } from "../../enums/index.ts";
import { parse_essential_graphics } from "../../parsers/essential_graphics.ts";
import { CONTROLLER_CHECKBOX, CONTROLLER_COLOR, CONTROLLER_SLIDER, can_add_layer, font_caps_json, media_controller_path, property_controller_plan, type PathNode, type PropertyControllerPlan } from "../../resolvers/motion_graphics.ts";
import { _CAMERA_LIGHT_TRANSFORM_SKIP, _OMITTED_EMPTY_GROUPS } from "../../synthesis/property.ts";
import {
  at,
  Fraction,
  b,
  bytes_,
  bytes_eq,
  deferred,
  descriptor,
  float,
  getattr,
  getitem,
  int,
  py_assert,
  py_bool,
  repr,
  round,
  sorted,
  TypeError_,
  ValueError,
  type ClassAttributes,
  AttributeError,
  type_name,
} from "../../../pyrt/index.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import { EssentialGraphicsController, SourcePropertyRef } from "../essential_graphics.ts";
import { AVLayer, _unregister_source_usage } from "../layers/av_layer.ts";
import { CameraLayer } from "../layers/camera_layer.ts";
import type { Layer } from "../layers/layer.ts";
import { LightLayer } from "../layers/light_layer.ts";
import { ParametricMeshLayer } from "../layers/parametric_mesh_layer.ts";
import { ShapeLayer } from "../layers/shape_layer.ts";
import { TextLayer } from "../layers/text_layer.ts";
import { ThreeDModelLayer } from "../layers/three_d_model_layer.ts";
import { auto_name } from "../naming.ts";
import { apply_text_style_prefs, default_still_out_point, default_synthetic_out_point, label_index } from "../preferences.ts";
import { Property } from "../properties/property.ts";
import { PropertyGroup } from "../properties/property_group.ts";
import { FileSource } from "../sources/file.ts";
import { PlaceholderSource } from "../sources/placeholder.ts";
import { SolidSource } from "../sources/solid.ts";
import { TextDocument } from "../text/text_document.ts";
import { _validate_number, validate_box_size, validate_comp_duration, validate_comp_frame_rate, validate_duration, validate_footage_dimension, validate_name, validate_one_of, validate_pixel_aspect, validate_rgb_color, validate_sequence, validate_string, validate_text, validate_vector2 } from "../validators.ts";
import { AVItem } from "./av_item.ts";
import { FootageItem } from "./footage.ts";
import type { FolderItem } from "./folder.ts";
import type { RendererOptions } from "./renderer_options/index.ts";
import type { Project } from "../project.ts";
import type { MarkerValue } from "../properties/marker.ts";

const _item = deferred<typeof import("../../parsers/item.ts")>("py_aep/parsers/item");
import { parse_layer } from "../../parsers/layer.ts";
import { renderer_options_for } from "./renderer_options/index.ts";
import { SettingsView } from "../renderqueue/settings.ts";
const _composition = deferred<typeof import("../../parsers/composition.ts")>("py_aep/parsers/composition");

// The binary prin chunk stores internal plugin match_names (e.g. ADBE Escher)
// but ExtendScript exposes different module names (e.g. ADBE Advanced 3d).
export const _RENDERER_BINARY_TO_EXTENDSCRIPT: Map<string, string> = new Map([
  ["ADBE Escher", "ADBE Advanced 3d"],
  ["ADBE Calder", "ADBE Calder"],
  ["ADBE Ernst", "ADBE Ernst"],
  ["ADBE Picasso", "ADBE Picasso"],
]);

export const _RENDERER_EXTENDSCRIPT_TO_BINARY: Map<string, string> = new Map(
  [..._RENDERER_BINARY_TO_EXTENDSCRIPT].map(([k, v]) => [v, k] as const),
);

export const _RENDERER_DISPLAY_NAMES: Map<string, string> = new Map([
  ["ADBE Escher", "Classic 3D"],
  ["ADBE Calder", "Advanced 3D"],
  ["ADBE Ernst", "Cinema 4D"],
  ["ADBE Picasso", "Ray-traced 3D"],
]);

export const _LAYER_BOUNDARY_TYPES: ReadonlySet<string> = new Set([
  "Layr",
  "DLay",
  "SLay",
  "CLay",
  "SecL",
  "CIFO",
]);

export const _validate_renderer = validate_one_of([..._RENDERER_EXTENDSCRIPT_TO_BINARY.keys()]);

// The NTSC internal timebase (23.976, 29.97, 59.94 fps and their multiples).
export const _NTSC_TIMEBASE = 23976;

// On the NTSC timebase AE keeps a display start stored as a float32 time
// (`displayStartTime = 52 / 29.97`) on the frame it is a hair past: 1/10000
// of a frame is the best fit to 490 such starts per rate measured on AE 2026
// (472 match; AE's own rounding of the rest is not reproduced). On every other
// timebase the same measurement is exact with no tolerance.
export const _NTSC_FRAME_TOLERANCE = new Fraction(1, 10000);

export function _grid(cdta: CdtaChunk): [number, number] {
  /**
   * The composition's frame grid: `(timebase, units per frame)` from its
   * frame rate (`frame_grid`), as AE derives it on open. The stored 16.16
   * rate only approximates the grid's rate (29.970001220703125 for 23976 /
   * 800), so comp times snap to the grid, never to the 16.16 value.
   */
  return frame_grid(cdta.frame_rate);
}

export function _grid_rate(cdta: CdtaChunk): number {
  /** Frames per second of the composition's frame grid. */
  const [timebase, units_per_frame] = _grid(cdta);
  return timebase / units_per_frame;
}

// NOTE(port): exact bigint arithmetic, identical to Python's Fraction. These two helpers are the
// exact rational `math.ceil` / `math.floor` over `num / den` (den > 0) that the
// Python code takes of `Fraction` expressions.
export function _ceil_ratio(num: bigint, den: bigint): number {
  const q = num / den;
  return Number(num % den !== 0n && num > 0n ? q + 1n : q);
}

export function _floor_ratio(num: bigint, den: bigint): number {
  const q = num / den;
  return Number(num % den !== 0n && num < 0n ? q - 1n : q);
}

/** `math.ceil(k * Fraction(*_grid(cdta)))` */
export function _ceil_k_grid(k: number, cdta: CdtaChunk): number {
  const [timebase, units_per_frame] = _grid(cdta);
  return _ceil_ratio(BigInt(k) * BigInt(timebase), BigInt(units_per_frame));
}

/** `math.floor(k * Fraction(*_grid(cdta)))` */
export function _floor_k_grid(k: number, cdta: CdtaChunk): number {
  const [timebase, units_per_frame] = _grid(cdta);
  return _floor_ratio(BigInt(k) * BigInt(timebase), BigInt(units_per_frame));
}

// NOTE(port): exact bigint arithmetic, identical to Python's Fraction; exact `Fraction(n, d) * k >= rhs` for d > 0.
export function _ratio_scaled_ge(n: number, d: number, k: number, rhs: number): boolean {
  return BigInt(n) * BigInt(k) >= BigInt(rhs) * BigInt(d);
}

export function _frame_number(cdta: CdtaChunk, dividend: number, divisor: number): number {
  /**
   * The frame a stored comp time falls on, as After Effects reports
   * `displayStartFrame` / `frameTime`.
   *
   * AE counts the time in exact timebase units and rounds the frame count
   * away from zero (measured on AE 2026 over 2900 display starts at 24, 25,
   * 30, 12.5 and 7.3 fps: 1/24 s stored as float32 0.0416666679 is frame 2,
   * -0.51 s at 24 fps frame -13), with `_NTSC_FRAME_TOLERANCE` on the NTSC
   * timebase. Counting in whole units keeps 246 frames at 29.97 fps on 246,
   * where the 16.16 rate reads 246.00001.
   */
  const [timebase, units_per_frame] = _grid(cdta);
  // NOTE(port): Python's `Fraction(dividend, divisor) * timebase / units_per_frame`,
  // kept exact as a bigint numerator / denominator.
  let n = BigInt(dividend) * BigInt(timebase);
  let d = BigInt(divisor) * BigInt(units_per_frame);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const frames_nonneg = n >= 0n;
  let mag_n = n < 0n ? -n : n;
  if (timebase === _NTSC_TIMEBASE) {
    // magnitude -= _NTSC_FRAME_TOLERANCE
    mag_n = mag_n * _NTSC_FRAME_TOLERANCE.d - _NTSC_FRAME_TOLERANCE.n * d;
    d = d * _NTSC_FRAME_TOLERANCE.d;
  }
  const whole = Math.max(_ceil_ratio(mag_n, d), 0);
  // `0 - whole`, not `-whole`: frame 0 stays +0.
  return frames_nonneg ? whole : 0 - whole;
}

// Top-level layer groups not every release writes: (match name, part).
export const _VERSION_GATED_GROUPS = [
  ["ADBE Layer Sets", "layer sets"],
  ["ADBE Source Options Group", "source options"],
] as const;

/**
 * Materialize properties for a newly created layer.
 *
 * Walks the full property tree and:
 * 1. Materializes all PropertyGroup shells (not children), except the
 *    empty groups AE itself omits (trackers / masks / effects / shape
 *    contents).
 * 2. Materializes only Property items whose tdb4 has a non-zero
 *    time-base field, matching the property set AE writes for a new
 *    layer. Camera and light layers use a fixed two-node transform
 *    set instead. Other properties stay synthetic.
 * 3. Inserts the loose skeleton chunks AE writes around specific
 *    groups (`OvG2` for Layer Overrides, `blsv`/`blsi` for the
 *    Source Alternate entry).
 *
 * Group end markers are already present in each tdgp (added during
 * synthesis) and get flipped to non-synthetic by _ensure_materialized().
 */
export function _materialize_layer(layer: Layer): void {
  const cam_light = ["ADBE Camera Layer", "ADBE Light Layer"].includes(layer.match_name);

  function _materialize_prop(prop: Property, in_transform: boolean): void {
    if (cam_light && in_transform) {
      if (!_CAMERA_LIGHT_TRANSFORM_SKIP.has(prop.match_name)) {
        prop._ensure_materialized();
      }
    } else if (prop._tdb4.has_time_base) {
      prop._ensure_materialized();
    }
  }

  function _materialize_tree(group: PropertyGroup): void {
    group._ensure_materialized();
    const in_transform = group.match_name === "ADBE Transform Group";
    // Deliberately the raw list, NOT `group.properties`: the public
    // accessor would run the group's deferred child synthesis, and this
    // walk would then materialize children AE leaves out. Measured on a
    // five-layer new project: 60 extra tdb4 chunks, +23 KB.
    for (const child of group._properties) {
      if (child instanceof PropertyGroup) {
        if (_OMITTED_EMPTY_GROUPS.has(child.match_name) && !child.properties?.length) {
          continue;
        }
        _materialize_tree(child);
      } else if (child instanceof Property) {
        _materialize_prop(child, in_transform);
      }
    }
  }

  const ae_major = get_ae_version_major(layer);
  // Groups the project's release does not write for a new layer (they
  // stay synthesized, as when reading that release's own files).
  const unwritten = new Set<string>(
    _VERSION_GATED_GROUPS.filter(([, part]) => !ae_writes(part, ae_major)).map(
      ([match_name]) => match_name,
    ),
  );

  for (const top of layer.properties) {
    if (top instanceof PropertyGroup) {
      if (unwritten.has(top.match_name)) {
        continue;
      }
      if (_OMITTED_EMPTY_GROUPS.has(top.match_name) && !top.properties?.length) {
        continue;
      }
      _materialize_tree(top);
    } else if (top instanceof Property) {
      _materialize_prop(top, false);
    }
  }

  // AE writes the `ADBE Layer Source Alternate` leaf (with its blsv/blsi
  // skeleton) inside Source Options for every new layer. `_materialize_tree`
  // iterates raw `_properties` and so never triggers that group's deferred
  // child synthesis, so materialize the leaf explicitly here.
  for (const top of layer.properties) {
    if (
      top instanceof PropertyGroup &&
      top.match_name === "ADBE Source Options Group" &&
      !unwritten.has(top.match_name)
    ) {
      for (const child of top.properties) {
        if (child.match_name === "ADBE Layer Source Alternate" && child instanceof Property) {
          if (ae_writes("source alternate value", ae_major)) {
            child._ensure_materialized();
          } else if (child._tdmn != null) {
            // AE 22 writes the match name (then blsv/blsi) but
            // no value.
            child._tdmn.synthetic = false;
          }
        }
      }
      break;
    }
  }

  _insert_layer_skeleton_extras(layer);
}

/**
 * Empty the layer's Essential Graphics overrides.
 *
 * Each override names a property inside the layer's source composition,
 * so swapping that source leaves every one of them pointing at nothing.
 * AE 2026 drops the overrides outright in that situation (a layer with
 * three overrides precomposed with `moveAllAttributes=false` comes back
 * with zero), which is what this reproduces: the `LIST:OvG2` is replaced
 * by the empty one AE writes for a layer that has never had an override.
 */
export function _drop_essential_overrides(layer: Layer): void {
  const root = layer._tdgp;
  if (root == null) {
    return;
  }
  const chunks = root.chunks;
  for (const [i, ch] of chunks.entries()) {
    if (
      ch instanceof TdmnChunk &&
      ch.value === "ADBE Layer Overrides" &&
      i + 1 < chunks.length &&
      list_type_of(chunks[i + 1]) === "OvG2"
    ) {
      // The group is two chunks: the OvG2 holds one CPrp per override
      // (CprC counts them), the tdgp that follows holds their values.
      chunks[i + 1] = build_ovg2();
      const values = i + 2 < chunks.length ? chunks[i + 2] : null;
      if (values instanceof ListChunk && values.list_type === "tdgp") {
        const inner = values.chunks;
        const keep = inner.filter((c) => ["tdsb", "tdsn"].includes(c.chunk_type));
        inner.splice(0, inner.length, ...keep, new TdmnChunk({ value: "ADBE Group End" }));
      }
      break;
    }
  }
  layer.essential_property_uuids.length = 0;
  for (const child of layer.properties) {
    if (child.match_name === "ADBE Layer Overrides") {
      if (!(child instanceof PropertyGroup)) throw new AttributeError(`'${type_name(child)}' object has no attribute 'properties'`);
      child._properties.length = 0;
      break;
    }
  }
}

/**
 * Insert the loose chunks AE writes inside a new layer's tdgp:
 * `LIST:OvG2(CprC)` after the Layer Overrides tdmn and `blsv`/`blsi`
 * after the Layer Source Alternate tdmn.
 */
export function _insert_layer_skeleton_extras(layer: Layer): void {
  const root = layer._tdgp;
  if (root == null) {
    return;
  }

  function has_following(chunks: Chunk[], i: number, kind: string): boolean {
    const nxt = i + 1 < chunks.length ? chunks[i + 1] : null;
    return (nxt instanceof ListChunk ? nxt.list_type : nxt?.chunk_type ?? null) === kind;
  }

  const chunks = root.chunks;
  for (const [i, ch] of chunks.entries()) {
    if (
      ch instanceof TdmnChunk &&
      ch.value === "ADBE Layer Overrides" &&
      !has_following(chunks, i, "OvG2")
    ) {
      chunks.splice(i + 1, 0, build_ovg2());
      break;
    }
  }
  for (const [i, ch] of chunks.entries()) {
    const next = i + 1 < chunks.length ? chunks[i + 1] : null;
    if (
      ch instanceof TdmnChunk &&
      ch.value === "ADBE Source Options Group" &&
      next instanceof ListChunk &&
      next.list_type === "tdgp"
    ) {
      const inner = next.chunks;
      for (const [j, c] of inner.entries()) {
        if (
          c instanceof TdmnChunk &&
          c.value === "ADBE Layer Source Alternate" &&
          !has_following(inner, j, "blsv")
        ) {
          inner.splice(j + 1, 0, ...build_source_alternate_extras());
          break;
        }
      }
      break;
    }
  }
}

/**
 * Give a duplicated comp's Essential Graphics controllers a new identity.
 *
 * AE's duplicate mints a fresh uuid per controller - kept identical
 * across the CIFO/CIF2/CIF3 containers, matched here by the OLD uuid
 * since the legacy containers can be stale - and retargets `CCId` /
 * `CLId` at the duplicate. Layer-side OvG2 override uuids are NOT
 * touched: they reference controllers of other (source) comps.
 */
export function _rewrite_eg_identity(
  cloned_item: ListChunk,
  old_comp_id: number,
  new_comp_id: number,
  id_map: Map<number, number>,
): void {
  const uuid_map: Map<string, string> = new Map();
  for (const cif of cloned_item.chunks) {
    if (
      !(cif instanceof ListChunk) ||
      !["CIFO", "CIF2", "CIF3"].includes(cif.list_type)
    ) {
      continue;
    }
    for (const cctl of filter_by_list_type(cif.chunks, "CCtl")) {
      const utf8s = filter_by_type(cctl.chunks, "Utf8");
      if (utf8s?.length > 0) {
        const uuid_utf8 = utf8s[0];
        if (!uuid_map.has(uuid_utf8.value)) {
          uuid_map.set(uuid_utf8.value, uuid4());
        }
        uuid_utf8.value = getitem(uuid_map, uuid_utf8.value);
      }
      for (const chunk of cctl.chunks) {
        // AE zeroes the controller's cached value/default in the
        // duplicate and re-derives them from the source property
        // (probed in AE 2026 on a slider controller).
        if (["CVal", "CDef"].includes(chunk.chunk_type) && chunk.data?.length > 0) {
          chunk.data = bytes_.repeat(b("\x00"), chunk.data.length);
        }
      }
      const cprp = find_by_list_type_or_null(cctl.chunks, "CPrp");
      if (cprp === null) continue;
      for (const ccid of filter_by_type(cprp.chunks, "CCId")) {
        if (ccid.value === old_comp_id) {
          ccid.value = new_comp_id;
        }
      }
      for (const clid of filter_by_type(cprp.chunks, "CLId")) {
        if (id_map.has(clid.value)) {
          clid.value = getitem(id_map, clid.value);
        }
      }
    }
  }
}

export interface LayerTypeCache {
  av: AVLayer[];
  text: TextLayer[];
  shape: ShapeLayer[];
  camera: CameraLayer[];
  light: LightLayer[];
  three_d_model: ThreeDModelLayer[];
  parametric_mesh: ParametricMeshLayer[];
}

/**
 * The `CompItem` object represents a composition, and allows you to
 * manipulate and get information about it.
 *
 *
 * Info:
 *     {@link Item} is the base class for {@link AVItem} object and for {@link FolderItem}
 *     object, which are in turn the base classes for various other item
 *     types, so {@link Item} attributes and methods are available when working with
 *     all of these item types.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * console.log(comp.frame_rate);
 * for (const layer of comp) {
 *   // ...
 * }
 * ```
 * @see https://ae-scripting.docsforadobe.dev/item/compitem/
 */
export class CompItem extends AVItem {
  declare ["constructor"]: ClassAttributes<typeof CompItem>;
  static _auto_name: string = "Comp";

  /** The background color of the composition. The three array values specify
   * the red, green, and blue components of the color. Read / Write. */
  declare bg_color: number[];

  /**
   * When `true`, Draft 3D mode is enabled for the composition.
   * Read / Write.
   *
   * **Warning:** Deprecated in After Effects 2024 in favor of the new Draft 3D mode.
   */
  declare draft3d: boolean;

  /** When `true`, frame blending is enabled for this Composition. Corresponds
   * to the value of the Frame Blending button in the Composition panel.
   * Read / Write. */
  declare frame_blending: boolean;

  /** When `true`, only layers with `shy` set to `false` are shown in the
   * Timeline panel. When `false`, all layers are visible, including those
   * whose `shy` value is `true`. Corresponds to the value of the Hide All
   * Shy Layers button in the Composition panel. Read / Write. */
  declare hide_shy_layers: boolean;

  /** When `true`, motion blur is enabled for the composition. Corresponds
   * to the value of the Motion Blur button in the Composition panel.
   * Read / Write. */
  declare motion_blur: boolean;

  /** When `true`, the frame rate of nested compositions is preserved in
   * the current composition. Corresponds to the value of the "Preserve frame
   * rate when nested or in render queue" option in the Advanced tab of the
   * Composition Settings dialog box. Read / Write. */
  declare preserve_nested_frame_rate: boolean;

  /** When `true`, the resolution of nested compositions is preserved in
   * the current composition. Corresponds to the value of the "Preserve
   * Resolution When Nested" option in the Advanced tab of the Composition
   * Settings dialog box. Read / Write. */
  declare preserve_nested_resolution: boolean;

  // Left-out camera and light properties follow the comp's size and pixel
  // aspect. Loading the layers before a change builds them at the size the
  // file has, so `save` writes the ones the change moves where they were,
  // as AE does.

  /** The width of the item in pixels. Read / Write. */
  declare width: number;

  /** The height of the item in pixels. Read / Write. */
  declare height: number;

  /** The shutter angle setting for the composition. This corresponds to the
   * Shutter Angle setting in the Advanced tab of the Composition Settings
   * dialog box. Read / Write. */
  declare shutter_angle: number;

  /** The shutter phase setting for the composition. This corresponds to the
   * Shutter Phase setting in the Advanced tab of the Composition Settings
   * dialog box. Read / Write. */
  declare shutter_phase: number;

  /** The x and y downsample resolution factors for rendering the
   * composition. The two values in the array specify how many pixels to skip
   * when sampling; the first number controls horizontal sampling, the second
   * controls vertical sampling. Full resolution is [1, 1], half resolution
   * is [2, 2], and quarter resolution is [4, 4]. The default is [1, 1].
   * Read / Write. */
  declare resolution_factor: number[];

  /**
   * The maximum number of motion blur samples of 2D layer motion. This
   * corresponds to the Adaptive Sample Limit setting in the Advanced tab of
   * the Composition Settings dialog box. Must be \>= `samples_per_frame`.
   * Read / Write. 
   */
  declare motion_blur_adaptive_sample_limit: number;

  /** The minimum number of motion blur samples per frame for Classic 3D
   * layers, shape layers, and certain effects. This corresponds to the
   * Samples Per Frame setting in the Advanced tab of the Composition
   * Settings dialog box. Read / Write. */
  declare motion_blur_samples_per_frame: number;

  /** The frame rate of the item in frames-per-second. Read / Write.
   *
   * Writing also rewrites the composition's internal timebase, and with
   * it every keyframe time in the composition. After Effects keeps
   * keyframe times fixed in *seconds* across a frame-rate change and
   * stores them as an integer count of `internal_timebase` units, so the
   * stored counts are rescaled to match. Composition duration, work area
   * and current time are requantized onto the new frame grid; layer
   * timing and nested compositions are left untouched.
   */
  get frame_rate(): number {
    return this._cdta.frame_rate;
  }

  set frame_rate(value: number) {
    validate_comp_frame_rate(value);
    const cdta = this._cdta;
    if (cdta.frame_rate === value) {
      // A no-op write must stay a no-op: retiming an already-consistent
      // comp would requantize timings that are legitimately off-grid.
      return;
    }
    const old_timebase = cdta.internal_timebase;
    // Writing frame_rate also rewrites internal_timebase and time_scale
    // (CdtaChunk._update_timebase), so capture the old base first.
    cdta.frame_rate = value;
    this._retime_to_timebase(old_timebase, cdta.internal_timebase);
    this._requantize_comp_timing();
  }

  *_walk_properties(): Generator<Property> {
    /**
     * Every `Property` under this comp's layers, plus its markers.
     *
     * Deliberately does not descend into a precomp layer's source item:
     * changing this composition's frame rate leaves nested compositions
     * alone (measured on AE 2026).
     */
    for (const layer of this.layers) {
      yield* layer._leaf_properties();
    }
    // Through the property: the comp's markers are parsed on first access.
    if (this.marker_property != null) {
      yield this.marker_property;
    }
  }

  _retime_to_timebase(old: number, new_: number): void {
    /**
     * Rescale keyframe times and restamp per-property timebases.
     *
     * `seconds = time_units / internal_timebase`, so holding a keyframe at
     * the same time in seconds means scaling its stored unit count by
     * `new / old`. That ratio is 1 whenever only `time_scale` moved - the
     * whole NTSC family, and 30 \<-\> 60 - but the frame rate cached on each
     * `Keyframe` still has to be refreshed, because `frame_time` is derived
     * from it.
     *
     * Every property's `tdb4` also carries the comp's timebase, and AE
     * rejects a file whose copy is wrong ("zero denominator converting
     * ratio denominators").
     *
     * A stretched layer's ticks count against its own timebase
     * (`layer_timebase`), so they scale by that ratio instead: 1 for a
     * layer at the 115200 cap. A tie rounds up. Both measured on AE 2026
     * going from 24 to 25 fps: ticks 12 and -84 became 13 and -87, and a
     * 500 % layer's ticks did not move.
     */
    const rescale = new_ !== old && old > 0;
    const frame_rate = this._cdta.frame_rate;
    for (const prop of this._walk_properties()) {
      if (prop._is_live()) {
        prop._ensure_time_base();
      }
      let prop_old = 0;
      let prop_new = 0;
      if (rescale) {
        const stretch = prop._time_stretch;
        prop_old = layer_timebase(old, stretch);
        prop_new = layer_timebase(new_, stretch);
      }
      for (const keyframe of prop.keyframes) {
        if (prop_old !== prop_new) {
          const item = keyframe._ldat_item;
          item.time_units = rescale_ticks(item.time_units, prop_old, prop_new);
        }
        keyframe._frame_rate = frame_rate;
      }
    }
  }

  _requantize_comp_timing(): void {
    /**
     * Snap comp duration, work area and current time onto the new
     * frame grid.
     *
     * AE rounds to the nearest frame, half a frame up: a 253-frame 24 fps
     * comp becomes 264 frames at 25 fps, a 12-frame one 13 frames. Each
     * time is stored in whole units of the new timebase. The work area's
     * start and end snap independently and its duration follows from them
     * (61 frames from frame 12 at 24 fps become 63 at 25 fps, not the 64
     * its duration alone would round to), then everything is kept inside
     * the comp (`_keep_times_inside`). Measured on AE 2026. Display start
     * and layer in / out / start times are not requantized.
     */
    const cdta = this._cdta;
    const [timebase, units_per_frame] = _grid(cdta);
    // The work area's end reads through its start and the duration, so
    // take it in seconds before either is rewritten. 0xFFFFFFFF means
    // "the work area runs to the end of the comp": that end already
    // follows `duration`, and writing one would pin it.
    const runs_to_end = cdta.work_area_end_dividend === WORK_AREA_TO_END;
    const work_area_end = cdta.work_area_start + cdta.work_area_duration;

    cdta.duration_dividend = _duration_units(cdta.duration, timebase, units_per_frame);
    cdta.duration_divisor = timebase;
    this._restore_times_in_timebase();
    if (!runs_to_end) {
      cdta.work_area_end_dividend = _frame_units(work_area_end, timebase, units_per_frame);
      cdta.work_area_end_divisor = timebase;
    }
    this._keep_times_inside();
  }

  _keep_times_inside(): void {
    /**
     * Pull the current time and the work area back inside the comp.
     *
     * Measured on AE 2026 after a duration or frame-rate change: a current
     * time or a work-area start at or past the end moves to the last frame
     * (a 5 s start in a comp cut to 4 s becomes 3.9583 s, one frame long),
     * and a work-area end at or past the end becomes "runs to the end"
     * (0xFFFFFFFF). Expects the duration, the time and the work-area start
     * stored in units of the timebase.
     */
    const cdta = this._cdta;
    const [timebase, units_per_frame] = _grid(cdta);
    const end_of_comp = round(cdta.duration * timebase);
    const last_frame = end_of_comp - units_per_frame;
    if (cdta.time_dividend > last_frame) {
      cdta.time_dividend = last_frame;
    }
    if (cdta.work_area_start_dividend > last_frame) {
      cdta.work_area_start_dividend = last_frame;
      cdta.work_area_end_dividend = WORK_AREA_TO_END;
    } else if (
      cdta.work_area_end_dividend !== WORK_AREA_TO_END &&
      _ratio_scaled_ge(
        cdta.work_area_end_dividend,
        cdta.work_area_end_divisor,
        timebase,
        end_of_comp,
      )
    ) {
      cdta.work_area_end_dividend = WORK_AREA_TO_END;
      cdta.work_area_end_divisor = timebase;
    }
  }

  /**
   * The duration of the item in seconds. Read / Write.
   *
   * Writing snaps the value to the nearest frame, half a frame rounding
   * up, as After Effects does. A value under half a frame becomes one
   * frame, where After Effects would store a zero-length composition.
   * A current time or work area that the new duration leaves outside the
   * composition moves inside it, as in After Effects.
   */
  get duration(): number {
    return this._cdta.duration;
  }

  set duration(value: number) {
    validate_comp_duration(value);
    const cdta = this._cdta;
    const [timebase, units_per_frame] = _grid(cdta);
    cdta.duration_dividend = _duration_units(value, timebase, units_per_frame);
    cdta.duration_divisor = timebase;
    // AE also re-stores the time and work-area start over the timebase
    // on a duration write (a 0/600 time becomes 0/24576 at 24 fps).
    this._restore_times_in_timebase();
    this._keep_times_inside();
  }

  /** The duration of the item in frames. Read / Write. */
  get frame_duration(): number {
    return this._cdta.frame_duration;
  }

  set frame_duration(value: number) {
    _validate_number({ min: 1, integer: true })(value);
    this.duration = value / _grid_rate(this._cdta);
  }

  /** The pixel aspect ratio of the item (1.0 is square). Read / Write. */
  declare pixel_aspect: number;

  /** The time scale, used as a divisor for keyframe time values. Read-only. */
  declare time_scale: number;

  /** The time set as the beginning of the composition, in seconds. This
   * is the equivalent of the Start Timecode or Start Frame setting in the
   * Composition Settings dialog box. Read / Write. */
  declare display_start_time: number;

  /** The frame value of the beginning of the composition. Read / Write. */
  get display_start_frame(): number {
    const cdta = this._cdta;
    return _frame_number(
      cdta,
      cdta.display_start_time_dividend,
      cdta.display_start_time_divisor,
    );
  }

  set display_start_frame(value: number) {
    // AE 2026 accepts the frames from -10800 s to 86340 s (at 24 fps
    // -259200 to 2072160, at 29.97 -323676 to 2587609), although its
    // `displayStartTime` goes on to 86400 s.
    _validate_number({
      min: (self: CompItem) => _ceil_k_grid(-10800, self._cdta),
      max: (self: CompItem) => _floor_k_grid(86340, self._cdta),
      integer: true,
    })(value, this);
    const cdta = this._cdta;
    const [timebase, units_per_frame] = _grid(cdta);
    // AE stores a start frame as whole timebase units (13 frames at 24 fps
    // is 13312/24576); past the signed 32-bit range, as a plain ratio.
    const units = value * units_per_frame;
    if (-(2 ** 31) <= units && units < 2 ** 31) {
      cdta.display_start_time_dividend = units;
      cdta.display_start_time_divisor = timebase;
    } else {
      cdta.display_start_time = units / timebase;
    }
    this._restore_times_in_timebase();
  }

  _restore_times_in_timebase(): void {
    /**
     * AE re-stores the work area start and the current time in whole
     * timebase units whenever the display start changes (AE 2026: a new
     * comp's `0/600` start becomes `0/24576` at 24 fps).
     */
    const cdta = this._cdta;
    const [timebase, units_per_frame] = _grid(cdta);
    cdta.work_area_start_dividend = _frame_units(cdta.work_area_start, timebase, units_per_frame);
    cdta.work_area_start_divisor = timebase;
    cdta.time_dividend = _frame_units(cdta.time_seconds, timebase, units_per_frame);
    cdta.time_divisor = timebase;
  }

  /**
   * The work area start time relative to composition start.
   * Read / Write.
   *
   * Writing snaps the value to the nearest frame, half a frame rounding
   * up, and keeps the work area's duration, as After Effects does. When
   * that would carry the work area past the end of the composition, it
   * ends there instead; After Effects moves the start back.
   */
  get work_area_start(): number {
    return this._cdta.work_area_start;
  }

  set work_area_start(value: number) {
    _validate_number({
      min: 0.0,
      max: (self: CompItem) => self.duration - 1 / self.frame_rate,
    })(value, this);
    const runs_to_end = this._cdta.work_area_end_dividend === WORK_AREA_TO_END;
    this._set_work_area(value, runs_to_end ? null : value + this.work_area_duration);
  }

  /** The work area start frame relative to composition start.
   * Read / Write. */
  get work_area_start_frame(): number {
    const cdta = this._cdta;
    return _frame_number(cdta, cdta.work_area_start_dividend, cdta.work_area_start_divisor);
  }

  set work_area_start_frame(value: number) {
    _validate_number({
      min: 0,
      max: (self: CompItem) => self.frame_duration - 1,
      integer: true,
    })(value, this);
    this.work_area_start = value / _grid_rate(this._cdta);
  }

  /**
   * The work area duration in seconds. Read / Write.
   *
   * Writing snaps the end of the work area to the nearest frame, half a
   * frame rounding up, as After Effects does.
   */
  get work_area_duration(): number {
    return this._cdta.work_area_duration;
  }

  set work_area_duration(value: number) {
    _validate_number({
      min: (self: CompItem) => 1 / self.frame_rate,
      max: (self: CompItem) => self.duration - self.work_area_start,
    })(value, this);
    const start = this.work_area_start;
    this._set_work_area(start, start + value);
  }

  /** The work area duration in frames. Read / Write. */
  get work_area_duration_frame(): number {
    return this._cdta.work_area_duration_frame;
  }

  set work_area_duration_frame(value: number) {
    _validate_number({
      min: 1,
      max: (self: CompItem) => self.frame_duration - self.work_area_start_frame,
      integer: true,
    })(value, this);
    this.work_area_duration = value / _grid_rate(this._cdta);
  }

  _set_work_area(start: number, end: number | null): void {
    /**
     * Store the work area the way AE's setters do: in whole timebase
     * units, snapped to frames, and with an end at or past the end of the
     * composition (or `null`) stored as "runs to the end".
     */
    const cdta = this._cdta;
    const [timebase, units_per_frame] = _grid(cdta);
    cdta.work_area_start_dividend = _frame_units(start, timebase, units_per_frame);
    cdta.work_area_start_divisor = timebase;
    let end_units: number | null =
      end == null ? null : _frame_units(end, timebase, units_per_frame);
    if (end_units == null || end_units >= round(cdta.duration * timebase)) {
      end_units = WORK_AREA_TO_END;
    }
    cdta.work_area_end_dividend = end_units;
    cdta.work_area_end_divisor = timebase;
  }

  /**
   * The current time of the item when it is being previewed directly
   * from the Project panel. This value is a number of seconds. It is an
   * error to set this value for a {@link FootageItem} whose `main_source` is
   * still. Read / Write.
   *
   * Writing snaps the value to the nearest frame, half a frame rounding
   * up, as After Effects does, which accepts 0 to 10800 seconds whatever
   * the display start time.
   */
  get time(): number {
    return this._cdta.time_seconds;
  }

  set time(value: number) {
    _validate_number({ min: 0.0, max: 10800.0 })(value);
    const cdta = this._cdta;
    const [timebase, units_per_frame] = _grid(cdta);
    cdta.time_dividend = _frame_units(value, timebase, units_per_frame);
    cdta.time_divisor = timebase;
  }

  /**
   * The current time of the item when it is being previewed directly
   * from the Project panel. This value is a number of frames.
   * Read / Write.
   */
  get frame_time(): number {
    const cdta = this._cdta;
    return _frame_number(cdta, cdta.time_dividend, cdta.time_divisor);
  }

  set frame_time(value: number) {
    // The frames `time`'s 0 to 10800 s range holds.
    _validate_number({
      min: 0,
      max: (self: CompItem) => Math.floor(10800 * _grid_rate(self._cdta)),
      integer: true,
    })(value, this);
    this.time = value / _grid_rate(this._cdta);
  }

  /**
   * When `true`, timecode is displayed in drop-frame format. Only
   * applicable when `frameRate` is 29.97 or 59.94. Read / Write.
   */
  declare drop_frame: boolean;

  static _new(
    name: string,
    width: number,
    height: number,
    pixel_aspect: number,
    duration: number,
    frame_rate: number,
    kw: { project: Project; parent_folder: FolderItem; min_dimension?: number },
  ): CompItem {
    /**
     * Create a new empty composition.
     *
     * @param name - The name of the new composition.
     * @param width - The width in pixels.
     * @param height - The height in pixels.
     * @param pixel_aspect - The pixel aspect ratio (1.0 for square pixels).
     * @param duration - The duration in seconds.
     * @param frame_rate - The frame rate in frames per second.
     * @param project - The project that owns this composition.
     * @param parent_folder - The folder that will contain this composition.
     * @param min_dimension - The smallest width / height accepted: 4, as `addComp`, except for an
     *   import that AE builds smaller (an SVG canvas can be 1 px a side).
     */
    const { project, parent_folder, min_dimension = 4 } = kw;
    validate_string(name);
    const validate_size = _validate_number({ min: min_dimension, max: 30000, integer: true });
    validate_size(width);
    validate_size(height);
    validate_pixel_aspect(pixel_aspect);
    validate_comp_duration(duration);
    validate_comp_frame_rate(frame_rate);

    const new_id = project._allocate_id();
    const ae_major = project._head.ae_version_major;

    // AE hard-crashes opening a comp item without the full view-state
    // skeleton (~180 chunks of viewer pseudo-layers and panel state),
    // so the whole item is built by the typed skeleton builder.
    const [item_list, idta, name_utf8, gide] = build_new_comp_item({
      item_id: new_id,
      name,
      width,
      height,
      pixel_aspect,
      duration,
      frame_rate,
      allocate_layer_id: project._allocate_id.bind(project),
      ae_major,
      label: label_index(project._preferences, "Comp Label Index 2", 15),
    });

    // View data chunks that AE expects after every comp's LIST:Item
    const fee = new ListChunk({
      list_type: "FEE ",
      chunks: ae_writes("ppSn", ae_major) ? [new F8Chunk({ chunk_type: "ppSn" })] : [],
    });
    const view_data: Chunk[] = [fee, ...build_item_view_chunks()];

    const comp = new this({
      _child_chunks: item_list.chunks,
      _cmta: null,
      _idta: idta,
      _item_list: item_list,
      _gide: gide,
      _pin_chunks: [],
      _name_utf8: name_utf8,
      project,
      parent_folder,
      effect_param_defs: project._effect_param_defs,
      proxy_source: null,
    });
    comp._view_data = view_data;
    return comp;
  }

  declare _layers: Layer[];
  declare _layers_by_id: Map<number, Layer> | null;
  declare __type_cache: LayerTypeCache | null;
  declare __layer_id_to_index: Map<number, number> | null;
  declare _cdta: CdtaChunk;
  declare _cdrp: U1Chunk | null;
  declare prin_list: ListChunk;
  declare _prin: PrinChunk;
  declare _prda: PrdaChunk;
  declare _deferred_layers: [ListChunk[], EffectParamDefs] | null;
  declare _layers_loaded: boolean;
  declare _deferred_child_chunks: Chunk[] | null;
  declare _marker_property: Property<MarkerValue | null> | null;
  declare _eg_template_name_utf8: Utf8Chunk | null;
  declare _eg_controllers: EssentialGraphicsController[];
  declare _view_data: Chunk[];

  constructor(kw: {
    _child_chunks: Chunk[];
    _cmta: CmtaChunk | null;
    _idta: IdtaChunk;
    _item_list: ListChunk;
    _gide: ListChunk | null;
    _pin_chunks: ListChunk[];
    _name_utf8: Utf8Chunk;
    project: Project;
    parent_folder: FolderItem;
    effect_param_defs: EffectParamDefs;
    proxy_source: FileSource | SolidSource | PlaceholderSource | null;
  }) {
    // Skip AVItem's extra params - they're all descriptor-backed on
    // CompItem and read directly from the cdta chunk body.
    super({
      _idta: kw._idta,
      _name_utf8: kw._name_utf8,
      _cmta: kw._cmta,
      _item_list: kw._item_list,
      _gide: kw._gide,
      _pin_chunks: kw._pin_chunks,
      project: kw.project,
      parent_folder: kw.parent_folder,
      type_name: "Composition",
      proxy_source: kw.proxy_source,
    });

    this._layers = [];
    this._layers_by_id = null;
    this.__type_cache = null;
    this.__layer_id_to_index = null;

    this._cdta = find_by_type(kw._child_chunks, "cdta");
    this._cdrp = find_by_type_or_null(kw._child_chunks, "cdrp");
    this.prin_list = find_by_list_type(kw._child_chunks, "PRin");
    this._prin = find_by_type(this.prin_list.chunks, "prin");
    this._prda = find_by_type(this.prin_list.chunks, "prda");

    // Layer deferral: collect layer chunks and source IDs now, parse
    // the actual Layer objects on first access via _ensure_layers_loaded.
    const layer_chunks = filter_by_list_type(kw._child_chunks, "Layr");
    if (layer_chunks?.length > 0) {
      this._deferred_layers = [layer_chunks, kw.effect_param_defs];
      this._layers_loaded = false;
    } else {
      this._deferred_layers = null;
      this._layers_loaded = true;
    }

    // Deferred markers + Essential Graphics parsing.
    this._deferred_child_chunks = kw._child_chunks;
    this._marker_property = null;
    this._eg_template_name_utf8 = null;
    this._eg_controllers = [];
    this._view_data = [];
  }

  [Symbol.iterator](): Iterator<Layer> {
    /**
     * Return an iterator over the composition's layers.
     *
     * Iterates a snapshot so layers can be removed while looping.
     */
    return [...this.layers][Symbol.iterator]();
  }

  remove(): void {
    /** Remove this composition, including any render-queue items targeting it. */
    const rq = this._project.render_queue;
    py_assert(rq != null);
    const comp_id = this.id;
    for (const rqi of [...rq.items]) {
      if (rqi.comp === this) {
        // Full chunk-level removal keeps rs_ldat/Rout/LItm bookkeeping
        // in sync; a model-list drop alone would orphan its chunks.
        rqi.remove();
        continue;
      }
      for (const om of rqi.output_modules) {
        if (om._om_ldat.post_render_target_comp_id === comp_id) {
          om._om_ldat.post_render_target_comp_id = 0;
        }
      }
    }
    super.remove();
  }

  duplicate(): CompItem {
    /**
     * Creates and returns a duplicate of this composition, which
     * contains the same layers as the original.
     *
     * The duplicate is placed directly after the original in its folder and named with
     * the next numeric suffix (`Comp` \> `Comp 2`). Every layer id - including the
     * viewer pseudo-layers - is freshly allocated, with parent, track
     * matte and effect layer-references remapped to the new siblings.
     * Essential Graphics controllers get fresh uuids with their comp and
     * layer references retargeted at the duplicate. Layer sources
     * (footage, precomps) and layer-side Essential Property override
     * uuids stay shared with the original.
     *
     * @returns The newly created {@link CompItem}.
     */
    const project = this._project;
    const parent = this._parent_folder;
    py_assert(parent != null);
    const container = parent._children_container;

    // Clone the comp's whole block: LIST:Item + trailing view chunks.
    const [start, end] = block_slice(
      container,
      this._item_list,
      this.constructor._ITEM_BOUNDARY_LIST_TYPES,
    );
    // The block starts at this comp's own LIST:Item.
    const cloned_item = clone_chunk_tree(this._item_list);
    const cloned_block = [cloned_item, ...container.slice(start + 1, end).map((c) => clone_chunk_tree(c))];

    const old_comp_id = this.id;
    const new_comp_id = project._allocate_id();
    // Pre-2020 files have no iide; the id then lives only in idta.
    const iide = find_by_type_or_null(cloned_item.chunks, "iide");
    if (iide !== null) iide.value = new_comp_id;
    find_by_type(cloned_item.chunks, "idta").item_id = new_comp_id;

    // Fresh ids for every ldta - real layers AND viewer pseudo-layers,
    // AE reallocates them all - then remap every intra-comp layer
    // reference. Ids not in the map (0 / stale) stay untouched, and
    // source_id is deliberately kept: footage and precomp sources are
    // shared with the original.
    const ldta_chunks = recursive_find(cloned_item.chunks, "ldta");
    const id_map: Map<number, number> = new Map();
    for (const ldta of ldta_chunks) {
      id_map.set(ldta.layer_id, project._allocate_id());
    }
    for (const ldta of ldta_chunks) {
      ldta.layer_id = getitem(id_map, ldta.layer_id);
      if (id_map.has(ldta.parent_id)) {
        ldta.parent_id = getitem(id_map, ldta.parent_id);
      }
      // matte_layer_id is absent (None) in pre-AE23 files.
      const matte = ldta.matte_layer_id;
      const new_matte = matte == null ? undefined : id_map.get(matte);
      if (new_matte !== undefined) {
        ldta.matte_layer_id = new_matte;
      }
    }
    // tdpi layer references: the effect owner (hidden -0000 param) and
    // effect layer parameters (e.g. Set Matte's source layer) - both
    // can only point at layers of this comp.
    for (const tdpi of recursive_find(cloned_item.chunks, "tdpi")) {
      const new_value = id_map.get(tdpi.value);
      if (new_value !== undefined) {
        tdpi.value = new_value;
      }
    }

    _rewrite_eg_identity(cloned_item, old_comp_id, new_comp_id, id_map);

    // Name (the item block's first direct Utf8), numbered like AE.
    const existing = new Set([...project.items.values()].map((item) => item.name));
    find_by_type(cloned_item.chunks, "Utf8").value = auto_name(this.name, existing);

    // AE parks the duplicate's current time at 0 (AE 2026: a copy of a
    // comp whose time is 2.5 s reads time 0).
    const cdta = find_by_type(cloned_item.chunks, "cdta");
    cdta.time_dividend = 0;
    cdta.time_divisor = 600;

    // Insert right after the original's block, then build the model
    // through the normal parse path (registers it in project.items).
    container.splice(end, 0, ...cloned_block);
    const new_comp = _item().parse_item(cloned_item, project, parent);
    // The clone keeps this comp's idta item type.
    py_assert(new_comp instanceof CompItem);
    parent.items.splice(parent.items.indexOf(this) + 1, 0, new_comp);

    // Register the duplicate on its layer sources' used_in if linking
    // already ran (the lazy pass covers it otherwise).
    if (project._used_in_linked) {
      for (const source_id of new_comp._source_ids_for_linking()) {
        const source = project.items.get(source_id) ?? null;
        if (source instanceof AVItem) {
          source._used_in.add(new_comp);
        }
      }
    }

    return new_comp;
  }

  _source_ids_for_linking(): Set<number> {
    /** Return source IDs for `_used_in` linking without forcing layer parse. */
    const deferred = this._deferred_layers;
    if (deferred != null) {
      const source_ids: Set<number> = new Set();
      for (const lc of deferred[0]) {
        if (lc instanceof DeferredListChunk && lc._parsed_chunks == null) {
          const raw = lc._raw_body;
          if (
            raw.length >= _LDTA_SOURCE_ID_END &&
            bytes_eq(bytes_.slice(raw, 0, 4), b("ldta"))
          ) {
            const sid = bytes_.int_from_bytes(
              bytes_.slice(raw, _LDTA_SOURCE_ID_OFFSET, _LDTA_SOURCE_ID_END),
              "big",
            );
            if (sid !== 0) {
              source_ids.add(sid);
            }
          }
        } else {
          const ldta = find_by_type_or_null(lc.chunks, "ldta");
          if (ldta === null) continue;
          if (ldta.source_id !== 0) {
            source_ids.add(ldta.source_id);
          }
        }
      }
      return source_ids;
    }

    const out: Set<number> = new Set();
    for (const layer of this._layers) {
      if (layer instanceof AVLayer && layer._source_id !== 0) {
        out.add(layer._source_id);
      }
    }
    return out;
  }

  _ensure_layers_loaded(): void {
    /** Parse deferred `LIST:Layr` chunks on first layer access. */
    if (this._layers_loaded) {
      return;
    }

    const deferred = this._deferred_layers;
    py_assert(deferred != null);

    // Clear deferred state first to avoid duplicate work if any nested
    // access re-enters this method.
    const [layer_chunks, deferred_effect_param_defs] = deferred;
    this._deferred_layers = null;

    let effect_param_defs: EffectParamDefs;
    if (deferred_effect_param_defs?.size > 0) {
      effect_param_defs = deferred_effect_param_defs;
    } else if (this._project != null) {
      effect_param_defs = this._project._effect_param_defs;
    } else {
      effect_param_defs = new Map();
    }

    const parsed_layers: Layer[] = [];
    for (const layer_chunk of layer_chunks) {
      parsed_layers.push(parse_layer(layer_chunk, this, effect_param_defs));
    }

    this._layers = parsed_layers;

    this._layers_loaded = true;
    this._invalidate_layer_cache();
  }

  _ensure_comp_parsed(): void {
    /** Parse markers and Essential Graphics on first access. */
    if (this._deferred_child_chunks == null) {
      return;
    }

    const child_chunks = this._deferred_child_chunks;
    this._deferred_child_chunks = null;

    this._marker_property = _composition()._get_markers(child_chunks, this);
    const eg_result = parse_essential_graphics(child_chunks);
    if (eg_result != null) {
      this._eg_template_name_utf8 = eg_result[0];
      this._eg_controllers = [...eg_result[1]];
    }
  }

  _build_type_cache(): LayerTypeCache {
    const av: AVLayer[] = [];
    const text: TextLayer[] = [];
    const shape: ShapeLayer[] = [];
    const camera: CameraLayer[] = [];
    const light: LightLayer[] = [];
    const three_d_model: ThreeDModelLayer[] = [];
    const parametric_mesh: ParametricMeshLayer[] = [];
    const by_id: Map<number, Layer> = new Map();
    for (const layer of this.layers) {
      by_id.set(layer.id, layer);
      if (layer instanceof AVLayer) {
        av.push(layer);
        if (layer instanceof TextLayer) {
          text.push(layer);
        } else if (layer instanceof ShapeLayer) {
          shape.push(layer);
        } else if (layer instanceof ThreeDModelLayer) {
          three_d_model.push(layer);
        } else if (layer instanceof ParametricMeshLayer) {
          parametric_mesh.push(layer);
        }
      } else if (layer instanceof CameraLayer) {
        camera.push(layer);
      } else if (layer instanceof LightLayer) {
        light.push(layer);
      }
    }
    this._layers_by_id = by_id;
    const cache: LayerTypeCache = {
      av,
      text,
      shape,
      camera,
      light,
      three_d_model,
      parametric_mesh,
    };
    this.__type_cache = cache;
    return cache;
  }

  _invalidate_layer_cache(): void {
    /** Reset layer caches after structural mutations. */
    this.__type_cache = null;
    this._layers_by_id = null;
    this.__layer_id_to_index = null;
  }

  _layer_block_slice(layer: Layer): [number, number] {
    /**
     * Return `(start, end)` indices of a layer's chunk block in
     * `_item_list.chunks`.
     *
     * The block runs from the layer's `LIST:Layr` to the next boundary
     * chunk (another `LIST:Layr`, a view block, or a footer chunk).
     */
    return block_slice(this._item_list.chunks, layer._layer_list, _LAYER_BOUNDARY_TYPES);
  }

  _find_first_layer_position(): number {
    /** Find the insertion point for the first layer in the chunk list. */
    for (const [i, chunk] of this._item_list.chunks.entries()) {
      if (
        chunk instanceof ListChunk &&
        ["DLay", "SLay", "CLay", "SecL", "CIFO"].includes(chunk.list_type)
      ) {
        return i;
      }
    }
    return this._item_list.chunks.length;
  }

  /**
   * A composition has no main-source pin, so its proxy pin is at
   * index 0 (footage items keep the main pin at 0 and the proxy at 1).
   */
  get _proxy_pin_index(): number {
    return 0;
  }

  /**
   * All the {@link Layer} objects for layers in this composition.
   * Read-only. 
   */
  get layers(): Layer[] {
    this._ensure_layers_loaded();
    return this._layers;
  }

  /** Map of layer ID to layer, for O(1) lookup by sibling layers. */
  get layers_by_id(): Map<number, Layer> {
    if (this._layers_by_id == null) {
      this._layers_by_id = new Map(this.layers.map((layer) => [layer.id, layer] as const));
    }
    return this._layers_by_id;
  }

  /** Map of layer ID to 0-based index. */
  get _layer_id_to_index(): Map<number, number> {
    if (this.__layer_id_to_index == null) {
      this.__layer_id_to_index = new Map(
        [...this.layers.entries()].map(([idx, layer]) => [layer.id, idx] as const),
      );
    }
    return this.__layer_id_to_index;
  }

  /** The composition's marker property. Read-only. */
  get marker_property(): Property<MarkerValue | null> | null {
    this._ensure_comp_parsed();
    return this._marker_property;
  }

  /**
   * The name property in the Essential Graphics panel for the
   * composition. The name in the Essential Graphics panel is used
   * for the file name of an exported Motion Graphics template.
   * Read / Write.
   */
  get motion_graphics_template_name(): string | null {
    this._ensure_comp_parsed();
    if (this._eg_template_name_utf8 == null) {
      return null;
    }
    return this._eg_template_name_utf8.value;
  }

  // @requires_version(15) on the setter: wrapped after the class body.
  set motion_graphics_template_name(value: string) {
    validate_name(value);
    this._ensure_comp_parsed();
    if (this._eg_template_name_utf8 != null) {
      this._eg_template_name_utf8.value = value;
    } else {
      const [cps2, utf8_chunk] = build_cps2(value);
      const cif3 = new ListChunk({
        list_type: "CIF3",
        chunks: [cps2, new S4Chunk({ chunk_type: "CcCt" })],
      });
      this._item_list.chunks.push(cif3);
      this._eg_template_name_utf8 = utf8_chunk;
    }
  }

  /**
   * The Essential Graphics controllers for this composition.
   * Read-only.
   */
  get motion_graphics_controllers(): EssentialGraphicsController[] {
    this._ensure_comp_parsed();
    return this._eg_controllers;
  }

  /**
   * The number of controllers in the Essential Graphics panel for the
   * composition. Read-only.
   *
   * **Note:** for each type-10 Group controller, After Effects synthesizes a
   * runtime-only "drop zone" controller it does not store in the file, so
   * this count is one lower per group than ExtendScript's
   * `motionGraphicsTemplateControllerCount`.
   */
  get motion_graphics_template_controller_count(): number {
    return this.motion_graphics_controllers.length;
  }

  /**
   * The names of all controllers in the Essential Graphics panel.
   * Read-only. Excludes the runtime-only Group "drop zone" controller AE
   * synthesizes but does not store (see
   * `motion_graphics_template_controller_count`).
   */
  get motion_graphics_template_controller_names(): string[] {
    return this.motion_graphics_controllers.map((ctrl) => ctrl.name);
  }

  _cif_containers(): ListChunk[] {
    /**
     * The `CIFO`/`CIF2`/`CIF3` Essential Graphics containers of this comp,
     * in file order (every comp AE or py_aep writes has all three, except
     * AE 15's, which have no CIF3).
     */
    return this._item_list.chunks.filter(
      (c): c is ListChunk =>
        c instanceof ListChunk && ["CIFO", "CIF2", "CIF3"].includes(c.list_type),
    );
  }

  _build_property_cctl(
    plan: PropertyControllerPlan,
    prop: Property,
    name: string,
    uuid_str: string,
  ): [ListChunk, Utf8Chunk, U4Chunk] {
    /**
     * Assemble one `LIST:CCtl` for `prop` per the resolved `plan`.
     *
     * Called once per CIF container so each holds its own chunk objects.
     */
    const comp_id = this.id;
    const layer_id = plan.layer._ldta.layer_id;
    if (plan.controller_type === CONTROLLER_SLIDER) {
      // AE seeds the EGP slider range from the pard UI slider range
      // (Slider Control -> 0..100 despite its +/-1e6 valid range,
      // Brightness -> -150..150), falling back to the valid range for
      // pard-less properties (Transform > Opacity -> 0..100).
      const min_v = prop._slider_min != null ? prop._slider_min : prop.min_value;
      const max_v = prop._slider_max != null ? prop._slider_max : prop.max_value;
      // Python's `float()` refuses a list bound (a color or multi-dimensional range).
      const float_bound = (v: number | number[]): number => {
        if (Array.isArray(v)) throw new TypeError_("float() argument must be a string or a real number, not 'list'");
        return float(v);
      };
      return build_slider_cctl(
        name,
        uuid_str,
        prop.value,
        min_v != null ? float_bound(min_v) : 0.0,
        max_v != null ? float_bound(max_v) : 100.0,
        comp_id,
        layer_id,
        plan.path_json,
      );
    }
    if (plan.controller_type === CONTROLLER_CHECKBOX) {
      return build_checkbox_cctl(
        name,
        uuid_str,
        py_bool(prop.value),
        comp_id,
        layer_id,
        plan.path_json,
      );
    }
    if (plan.controller_type === CONTROLLER_COLOR) {
      let rgba: number[] = prop.value;
      rgba = [...rgba, 1.0, 1.0, 1.0, 1.0].slice(0, 4);
      return build_color_cctl(name, uuid_str, rgba, comp_id, layer_id, plan.path_json);
    }
    const text = prop.value instanceof TextDocument ? prop.value.text : "";
    return build_text_cctl(
      name,
      uuid_str,
      text,
      font_caps_json(prop),
      comp_id,
      layer_id,
      plan.path_json,
    );
  }

  _append_controller(
    build: () => [ListChunk, Utf8Chunk, U4Chunk],
  ): [Utf8Chunk, U4Chunk] | null {
    /**
     * Append one freshly built `LIST:CCtl` per CIF container and bump
     * each `CcCt` count (AE keeps the `CIFO`/`CIF2`/`CIF3` copies in sync).
     *
     * Returns the CIF3 copy's editable chunks `(name_utf8, ctyp)` for the
     * controller model - the parser's preferred container - or `null` when
     * the comp has no CIF containers (not produced by AE or py_aep).
     */
    const containers = this._cif_containers();
    if (!containers?.length) {
      return null;
    }
    let model: [Utf8Chunk, U4Chunk] | null = null;
    for (const cif of containers) {
      const [cctl, name_utf8, ctyp] = build();
      cif.chunks.push(cctl);
      const ccct = find_by_type(cif.chunks, "CcCt");
      ccct.value += 1;
      if (cif.list_type === "CIF3" || model == null) {
        model = [name_utf8, ctyp];
      }
    }
    return model;
  }

  _register_controller(
    bound: [Utf8Chunk, U4Chunk],
    uuid_str: string,
    nodes: PathNode[],
    layer: Layer,
  ): void {
    /** Append the model for a controller just written to the containers. */
    const [name_utf8, ctyp] = bound;
    this._eg_controllers.push(
      new EssentialGraphicsController({
        _name_utf8: name_utf8,
        _ctyp: ctyp,
        uuid: uuid_str,
        source_property_path: nodes.map(
          (node) => new SourcePropertyRef(node.match_name, node.prop_index),
        ),
        source_comp_id: this.id,
        source_layer_id: layer._ldta.layer_id,
      }),
    );
  }

  _add_property_controller(prop: Property, name: string | null): boolean {
    /**
     * Add `prop` to this comp's Essential Graphics panel.
     *
     * Returns `false` (adding nothing) when `prop` cannot be exposed - see
     * `resolvers.motion_graphics`.
     */
    this._ensure_comp_parsed();
    const plan = property_controller_plan(prop, this);
    if (plan == null) {
      return false;
    }
    const display = name != null ? name : prop.name;
    validate_name(display);
    const uuid_str = uuid4();
    const bound = this._append_controller(() =>
      this._build_property_cctl(plan, prop, display, uuid_str),
    );
    if (bound == null) {
      return false;
    }
    this._register_controller(bound, uuid_str, plan.nodes, plan.layer);
    return true;
  }

  _add_layer_controller(layer: AVLayer, name: string | null): boolean {
    /**
     * Add `layer` to this comp's Essential Graphics panel as a Media
     * Replacement (type 14) controller.
     *
     * Returns `false` (adding nothing) when the layer is not eligible -
     * see `resolvers.motion_graphics.can_add_layer`.
     */
    this._ensure_comp_parsed();
    if (!can_add_layer(layer, this)) {
      return false;
    }
    const source = layer.source;
    py_assert(source != null); // guaranteed by can_add_layer
    const display = name != null ? name : layer.name;
    validate_name(display);
    const uuid_str = uuid4();
    const timebase = this._cdta.internal_timebase;
    const [nodes, path_json] = media_controller_path();
    // AE names a per-controller thumbnail cache file it regenerates on
    // open; only the uuid-shaped name is stored in the project.
    const thumbnail = `${uuid4()}.png`;
    const bound = this._append_controller(() =>
      build_media_cctl(
        display,
        uuid_str,
        source.width,
        source.height,
        round(layer.in_point * timebase),
        round(layer.out_point * timebase),
        timebase,
        thumbnail,
        this.id,
        layer._ldta.layer_id,
        path_json,
      ),
    );
    if (bound == null) {
      return false;
    }
    this._register_controller(bound, uuid_str, nodes, layer);
    return true;
  }

  /**
   * The available rendering plug-in module names. Read-only.
   */
  get renderers(): string[] {
    return [..._RENDERER_EXTENDSCRIPT_TO_BINARY.keys()];
  }

  /**
   * The current rendering plug-in module to be used to render this
   * composition, as set in the Advanced tab of the Composition Settings
   * dialog box. Allowed values are the members of `renderers`.
   * Read / Write.
   *
   * Changing the renderer replaces the stored options with the new
   * renderer's defaults. Previous options are not preserved.
   * Read `renderer_options` again after changing the renderer.
   */
  get renderer(): string {
    const binary_name = this._prin.match_name;
    return _RENDERER_BINARY_TO_EXTENDSCRIPT.get(binary_name) ?? binary_name;
  }

  set renderer(value: string) {
    _validate_renderer(value);
    const binary_name = getitem(_RENDERER_EXTENDSCRIPT_TO_BINARY, value);
    if (binary_name === this._prin.match_name) {
      // If comp is already set to the requested renderer,
      // preserve renderer options instead of replacing with defaults
      return;
    }
    // Otherwise update match name and display name
    this._prin.match_name = binary_name;
    this._prin.display_name = getitem(_RENDERER_DISPLAY_NAMES, binary_name);
    // Create a fresh prda chunk using requested renderer's default settings
    const new_prda = new (getitem(_PRDA_VARIANTS, binary_name)[0])();
    // Replace the existing prda chunk
    const prin_chunks = this.prin_list.chunks;
    prin_chunks[index_by_identity(prin_chunks, this._prda)] = new_prda;
    this._prda = new_prda;
  }

  /**
   * The active 3D renderer's options, as a mutable mapping.
   *
   * Keys are the labels the Render Options dialog uses, and the same
   * object also exposes each option as a typed attribute.
   *
   *
   * The concrete type follows the composition's 3D renderer. Note
   * that {@link renderer} holds the ExtendScript module name, and the
   * one for Classic 3D is (confusingly) `ADBE Advanced 3d`:
   *
   * - `ADBE Advanced 3d` (Classic 3D) - {@link ClassicRendererOptions}
   * - `ADBE Calder` (Advanced 3D) - {@link AdvancedRendererOptions}
   * - `ADBE Ernst` (Cinema 4D) - {@link Cinema4DRendererOptions}
   * - `ADBE Picasso` (Ray-traced 3D) - {@link RayTracedRendererOptions}
   *
   * Read / Write.
   *
   * @example
   * ```ts
   * import { parse } from "@bevyl-ai/ts-aep";
   *
   * const comp = parse("project.aep").project.compositions[0];
   * comp.renderer_options.__setitem__("Quality", 61);
   * ```
   */
  get renderer_options(): RendererOptions {
    return renderer_options_for(this._prda, this);
  }

  set renderer_options(value: Map<string, unknown> | SettingsView) {
    // A Python Mapping: a dict, or another comp's renderer options view.
    if (!(value instanceof Map || value instanceof SettingsView)) {
      throw new ValueError("renderer_options must be a mapping of key-value pairs");
    }
    const view = this.renderer_options;
    for (const [key, option] of value instanceof Map ? value.entries() : value.items()) {
      view.__setitem__(key, option);
    }
  }

  /**
   * When `true`, the composition has an audio component.
   *
   * A composition has audio when at least one of its layers has a
   * source with audio.
   * Read-only.
   */
  get has_audio(): boolean {
    return this.av_layers.some((layer) => layer.has_audio);
  }

  /**
   * A flat array of {@link MarkerValue} objects for this composition.
   *
   * Shortcut for accessing marker data without navigating the property
   * tree.  Returns an empty array when the composition has no markers.
   *
   * @example
   * ```ts
   * import { parse } from "@bevyl-ai/ts-aep";
   *
   * const comp = parse("project.aep").project.compositions[0];
   * for (const marker of comp.markers) {
   *   console.log(marker.comment);
   * }
   * ```
   */
  get markers(): MarkerValue[] {
    if (this.marker_property == null) {
      return [];
    }
    return this.marker_property.keyframes.map((kf) => kf.value);
  }

  remove_all_markers(): void {
    /**
     * Remove all markers from this composition.
     *
     * A no-op when the composition has no markers.
     */
    if (this.marker_property != null) {
      this.marker_property.remove_all_keys();
    }
  }

  /** The number of layers in the composition. */
  get num_layers(): number {
    return this.layers.length;
  }

  /**
   * The front-most enabled camera layer, or `null`.
   *
   * Returns the first {@link CameraLayer} that is active at the current
   * composition time. The value is `null` when the composition
   * contains no active camera layers.
   */
  get active_camera(): CameraLayer | null {
    for (const layer of this.camera_layers) {
      if (layer.active) {
        return layer;
      }
    }
    return null;
  }

  layer(
    name: string | null = null,
    index: number | null = null,
    other_layer: Layer | null = null,
    rel_index: number | null = null,
  ): Layer {
    /**
     * Get a Layer object by name, index, or relative to another layer.
     *
     * @param name - The name of the layer to return.
     * @param index - The index position of the layer to return.
     * @param other_layer - A Layer object to use as a reference for the relative index position of
     *   the layer to return.
     * @param rel_index - The index position of the layer relative to the other_layer to return.
     */
    if (name) {
      for (const layer of this.layers) {
        if (layer.name === name) {
          return layer;
        }
      }
      throw new ValueError(`Layer with name '${name}' not found`);
    } else if (index != null) {
      return at(this.layers, index);
    } else if (other_layer != null && py_bool(other_layer) && rel_index != null && rel_index !== 0) {
      const other_idx = this.layers.indexOf(other_layer);
      if (other_idx < 0) {
        throw new ValueError(`${repr(other_layer)} is not in list`);
      }
      return at(this.layers, other_idx + rel_index);
    }
    throw new ValueError("Must specify one of name, index, or other_layer and rel_index");
  }

  /** Cached layer type lists for O(1) access. */
  get _type_cache(): LayerTypeCache {
    return this.__type_cache != null ? this.__type_cache : this._build_type_cache();
  }

  /** An array of all {@link AVLayer} objects in this composition. */
  get av_layers(): AVLayer[] {
    return this._type_cache.av;
  }

  /** An array of the composition layers whose source are compositions. */
  get composition_layers(): AVLayer[] {
    return this.av_layers.filter((layer) => layer.source instanceof CompItem);
  }

  /** An array of the composition layers whose source are footages. */
  get footage_layers(): AVLayer[] {
    return this.av_layers.filter((layer) => layer.source instanceof FootageItem);
  }

  /** An array of the layers whose source are file footages. */
  get file_layers(): AVLayer[] {
    return this.footage_layers.filter(
      (layer) =>
        layer.source instanceof FootageItem &&
        layer.source.main_source instanceof FileSource,
    );
  }

  /** An array of the layers whose source are solids. */
  get solid_layers(): AVLayer[] {
    return this.footage_layers.filter(
      (layer) =>
        layer.source instanceof FootageItem &&
        layer.source.main_source instanceof SolidSource,
    );
  }

  /** An array of the layers whose source are placeholders. */
  get placeholder_layers(): AVLayer[] {
    return this.footage_layers.filter(
      (layer) =>
        layer.source instanceof FootageItem &&
        layer.source.main_source instanceof PlaceholderSource,
    );
  }

  /** An array of the text layers in this composition. */
  get text_layers(): TextLayer[] {
    return this._type_cache.text;
  }

  /** An array of the shape layers in this composition. */
  get shape_layers(): ShapeLayer[] {
    return this._type_cache.shape;
  }

  /** An array of the camera layers in this composition. */
  get camera_layers(): CameraLayer[] {
    return this._type_cache.camera;
  }

  /** An array of the light layers in this composition. */
  get light_layers(): LightLayer[] {
    return this._type_cache.light;
  }

  /** An array of the 3D model layers in this composition. */
  get three_d_model_layers(): ThreeDModelLayer[] {
    return this._type_cache.three_d_model;
  }

  /** An array of the parametric mesh layers in this composition. */
  get parametric_mesh_layers(): ParametricMeshLayer[] {
    return this._type_cache.parametric_mesh;
  }

  /** An array of the null layers in this composition. */
  get null_layers(): Layer[] {
    return this.layers.filter((layer) => layer.null_layer);
  }

  /** An array of the adjustment layers in this composition. */
  get adjustment_layers(): AVLayer[] {
    return this.av_layers.filter((layer) => layer.adjustment_layer);
  }

  /** An array of the 3D layers in this composition. */
  get three_d_layers(): AVLayer[] {
    return this.av_layers.filter((layer) => layer.three_d_layer);
  }

  /** An array of the guide layers in this composition. */
  get guide_layers(): AVLayer[] {
    return this.av_layers.filter((layer) => layer.guide_layer);
  }

  /** An array of the soloed layers in this composition. */
  get solo_layers(): Layer[] {
    return this.layers.filter((layer) => layer.solo);
  }

  // -- Layer creation --------------------------------------------------------

  _synthetic_layer_duration(): number {
    /**
     * Default span of a new sourceless layer (solid, null, text,
     * shape, camera, light), from the "Pref_DEFAULT_SYNTHETIC_OUT_POINT"
     * preference; comp duration for the factory `0/0` value.
     */
    const pref = default_synthetic_out_point(this._project._preferences);
    return pref != null ? pref : this.duration;
  }

  _still_layer_duration(): number {
    /**
     * Default span of a new still-footage layer, from the
     * "Pref_DEFAULT_STILL_OUT_POINT" preference; comp duration for the
     * factory `0/0` value.
     */
    const pref = default_still_out_point(this._project._preferences);
    return pref != null ? pref : this.duration;
  }

  _insert_layer(layer: Layer): void {
    /**
     * Insert a fully-constructed layer at the top of the layer stack.
     *
     * Handles view block creation, chunk insertion, materialization,
     * and layer list bookkeeping.
     */
    // AE anchors new layers at the comp's current time when the
    // "Create New Layers At Time Zero" preference is off: start = in
    // = time, out shifted by the same amount (probed in AE 2026 for
    // every scripted layer add). duplicate() bypasses this path and
    // keeps the source timing, matching AE.
    const at_time_zero = this._project._preferences.get_pref_as_bool(
      "General Section",
      "Create New Layers At Time Zero",
      PREFType.PREF_Type_MACHINE_INDEPENDENT,
      { default: true },
    );
    if (!at_time_zero && this.time) {
      layer.start_time = this.time;
    }

    const view_block = build_layer_view_block();

    let chunk_idx: number;
    if (this.layers?.length > 0) {
      try {
        chunk_idx = index_by_identity(this._item_list.chunks, this.layers[0]._layer_list);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        chunk_idx = this._find_first_layer_position();
      }
    } else {
      chunk_idx = this._find_first_layer_position();
    }
    this._item_list.chunks.splice(chunk_idx, 0, layer._layer_list, ...view_block);

    _materialize_layer(layer);
    this._layers.unshift(layer);
    this._invalidate_layer_cache();
  }

  add_null(duration: number | null = null): AVLayer {
    /**
     * Create a new null layer at the top of the layer stack.
     *
     * A null layer has no visual content and is commonly used as a parent
     * for other layers. Its source is a small transparent solid created
     * automatically.
     *
     * @param duration - Layer duration in seconds. Defaults to the synthetic-layer default span
     *   (the "Pref_DEFAULT_SYNTHETIC_OUT_POINT" preference; composition duration by default). AE's
     *   `addNull` ignores this argument (probed in AE 2026); py_aep honors it, since it sets the
     *   layer out-point directly and the result is a valid AE file.
     * @returns The newly created {@link AVLayer}.
     */
    if (duration != null) {
      validate_duration(duration);
    }

    // AE numbers a new null after every project item named "Null N" -
    // solids, comps and folders alike, not the comp's layer names (AE
    // 2026: "Null 21" once a folder "Null 20" exists).
    const existing = new Set([...this._project.items.values()].map((item) => item.name));
    const name = auto_name("Null", existing);

    // AE's addNull source is a white 100x100 solid (probed in AE 2026).
    const solid_source = SolidSource._new(name, [1.0, 1.0, 1.0]);
    const solids_folder = this._project._solids_folder;
    const footage = FootageItem._new(solid_source, {
      project: this._project,
      parent_folder: solids_folder,
    });
    solids_folder._children_container.push(footage._item_list);
    solids_folder._children_container.push(...footage._view_data);
    this._project.items.set(footage.id, footage);
    solids_folder.items.push(footage);

    // AE leaves the layer name empty for source-named layers (the
    // name resolves from the footage item).
    const layer = AVLayer._new({
      name: "",
      layer_id: this._project._allocate_id(),
      source_id: footage.id,
      duration: duration != null ? duration : this._synthetic_layer_duration(),
      containing_comp: this,
      null_layer: true,
      label: label_index(this._project._preferences, "Null Label Index", 1),
      effect_param_defs: this._project._effect_param_defs,
    });
    this._insert_layer(layer);
    return layer;
  }

  add_shape(): ShapeLayer {
    /**
     * Create a new empty shape layer at the top of the layer stack.
     *
     * @returns The newly created {@link ShapeLayer}.
     */
    const existing = new Set(this.layers.map((lyr) => lyr.name));
    const name = auto_name(ShapeLayer._auto_name, existing);

    const layer = ShapeLayer._new({
      name,
      layer_id: this._project._allocate_id(),
      duration: this._synthetic_layer_duration(),
      containing_comp: this,
      effect_param_defs: this._project._effect_param_defs,
    });
    this._insert_layer(layer);
    return layer;
  }

  add_camera(name: string | null = null, center_point: number[] | null = null): CameraLayer {
    /**
     * Create a new camera layer at the top of the layer stack.
     *
     * @param name - Layer name. Auto-generated if `null`.
     * @param center_point - The `[x, y]` center point. Defaults to `[width/2, height/2]`.
     * @returns The newly created {@link CameraLayer}.
     */
    if (name == null) {
      const existing = new Set(this.layers.map((lyr) => lyr.name));
      name = auto_name(CameraLayer._auto_name, existing);
    }

    if (center_point == null) {
      center_point = [this.width / 2, this.height / 2];
    } else {
      validate_vector2(center_point);
    }

    const layer = CameraLayer._new({
      name,
      layer_id: this._project._allocate_id(),
      duration: this._synthetic_layer_duration(),
      containing_comp: this,
      effect_param_defs: this._project._effect_param_defs,
    });
    this._insert_layer(layer);

    // AE rounds the zoom to 8 decimals before storing it.
    const zoom = round((this.width * this.pixel_aspect) / CameraLayer._zoom_dividend, 8);

    const transform = layer.transform;
    const anchor_point = transform.property("ADBE Anchor Point");
    anchor_point.value = [center_point[0], center_point[1], 0.0];
    // ExtendScript reports a new two-node camera's position as
    // [0, 0, -zoom] (the point of interest carries the center).
    const position = transform.property("ADBE Position");
    position.value = [0.0, 0.0, -zoom];

    // AE's new-camera Camera Zoom equals the same computed zoom. Without
    // this the property keeps its 0.0 spec placeholder, which violates its
    // own >= 1 minimum and makes keyframing the zoom raise ValueError.
    const camera_options = layer.property("ADBE Camera Options Group");
    const zoom_prop = camera_options.property("ADBE Camera Zoom");
    zoom_prop.value = zoom;

    return layer;
  }

  add_light(name: string | null = null, center_point: number[] | null = null): LightLayer {
    /**
     * Create a new light layer at the top of the layer stack.
     *
     * @param name - Layer name. Auto-generated if `null`.
     * @param center_point - The `[x, y]` center point. Defaults to `[width/2, height/2]`.
     * @returns The newly created {@link LightLayer}.
     */
    if (name == null) {
      const existing = new Set(this.layers.map((lyr) => lyr.name));
      name = auto_name(LightLayer._auto_name, existing);
    }

    if (center_point == null) {
      center_point = [this.width / 2, this.height / 2];
    } else {
      validate_vector2(center_point);
    }

    const layer = LightLayer._new({
      name,
      layer_id: this._project._allocate_id(),
      duration: this._synthetic_layer_duration(),
      containing_comp: this,
      light_type: 1,
      effect_param_defs: this._project._effect_param_defs,
    });
    this._insert_layer(layer);

    // AE rounds the zoom to 8 decimals before storing it.
    const zoom = round((this.width * this.pixel_aspect) / LightLayer._zoom_dividend, 8);

    const transform = layer.transform;
    const anchor_point = transform.property("ADBE Anchor Point");
    anchor_point.value = [center_point[0], center_point[1], 0.0];
    // Like cameras, lights report position [0, 0, -zoom/2] with the
    // point of interest at the center.
    const position = transform.property("ADBE Position");
    position.value = [0.0, 0.0, -zoom / 2];

    return layer;
  }

  add_parametric_mesh(
    name: string | null = null,
    kw: { mesh_type: ParametricMeshType },
  ): ParametricMeshLayer {
    /**
     * Create a new parametric mesh layer at the top of the layer stack.
     *
     * @param name - Layer name. Auto-generated if `null`.
     * @param mesh_type - The type of parametric mesh (required, keyword-only).
     * @returns The newly created {@link ParametricMeshLayer}.
     */
    const { mesh_type } = kw;
    const explicit_name = name != null;
    if (name == null) {
      const existing = new Set(this.layers.map((lyr) => lyr.name));
      // Python's `str.title()`: each run of letters capitalized, the rest lowered.
      const prefix = ParametricMeshType.name_of(mesh_type)
        .toLowerCase()
        .replace(/(^|[^a-zA-Z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
      name = auto_name(`${prefix} ${ParametricMeshLayer._auto_name}`, existing);
    }

    const layer = ParametricMeshLayer._new({
      name,
      layer_id: this._project._allocate_id(),
      duration: this._synthetic_layer_duration(),
      containing_comp: this,
      mesh_type,
      effect_param_defs: this._project._effect_param_defs,
    });
    // AE sets the ldta name bit when addParametricMesh receives an
    // explicit name (unlike other sourceless layers); UI-created mesh
    // layers with default names leave it clear.
    layer._ldta.name_set = explicit_name;
    this._insert_layer(layer);
    return layer;
  }

  add(item: AVItem, duration: number | null = null): AVLayer {
    /**
     * Add an existing footage or composition item as a new layer.
     *
     * @param item - The {@link AVItem} (footage or composition) to add.
     * @param duration - Layer duration in seconds, for still footage. By default (probed in AE
     *   2026) timed footage and nested comps span their source duration, and stills span the
     *   still-layer default (the "Pref_DEFAULT_STILL_OUT_POINT" preference; composition duration by
     *   default).
     * @returns The newly created {@link AVLayer}.
     */
    if (!(item instanceof AVItem)) {
      throw new ValueError("item must be an AVItem (FootageItem or CompItem).");
    }

    let layer_duration: number;
    if (duration != null) {
      validate_duration(duration);
      layer_duration = duration;
    } else if (item.duration) {
      layer_duration = item.duration;
    } else {
      layer_duration = this._still_layer_duration();
    }

    // AE leaves the layer name empty for source-named layers, and the
    // new layer's label mirrors the item's label at add time (probed
    // in AE 2026, including user-recolored items).
    const layer = AVLayer._new({
      name: "",
      layer_id: this._project._allocate_id(),
      source_id: item.id,
      duration: layer_duration,
      containing_comp: this,
      label: int(item.label),
      effect_param_defs: this._project._effect_param_defs,
    });
    this._insert_layer(layer);

    this._project._ensure_used_in_linked();
    if ("_used_in" in item) {
      item._used_in.add(this);
    }

    return layer;
  }

  precompose(layer_indices: number[], name: string, move_all_attributes = true): CompItem {
    /**
     * Create a new {@link CompItem} and move the specified layers into it.
     *
     * The moved layers are replaced in this composition by a single new
     * layer whose source is the new composition, placed at the topmost
     * moved layer's index. The new composition inherits this composition's
     * settings and is stored at the alphabetical position in this
     * composition's folder.
     *
     * Parent and track-matte links follow AE's rules: links inside the
     * moved set are kept; a stayer referencing a moved layer retargets
     * to the replacement layer; a moved layer whose parent stays is
     * unparented; a moved layer whose track matte stays gets a copy of
     * the matte layer inside the new composition (the original stays
     * untouched).
     *
     * When `move_all_attributes` is `false` (allowed for a single
     * source-backed layer only), the selected layer stays in this
     * composition with all its attributes and its source is swapped to
     * the new composition, which is sized from the layer's source and
     * contains one fresh layer referencing that source.
     *
     * **Warning:** References to moved `Layer` objects become stale (the layers
     * are re-created inside the new composition), mirroring
     * ExtendScript's reference invalidation.
     *
     * @param layer_indices - 0-based indices of the layers to precompose (ExtendScript uses 1-based
     *   indices).
     * @param name - The name of the new composition.
     * @param move_all_attributes - `true` (default) to move all attributes into the new
     *   composition; `false` to leave them on the retained layer ("Leave all attributes" in the
     *   Pre-compose dialog).
     * @returns The newly created {@link CompItem}.
     * @throws {@link ValueError} If `layer_indices` is empty or contains an out-of-range index, or
     *   if `move_all_attributes` is `false` with more than one index or with a layer that has no
     *   source.
     */
    validate_string(name);
    if (!Array.isArray(layer_indices) || !layer_indices?.length) {
      throw new ValueError("layer_indices must be a non-empty list.");
    }
    const check_index = _validate_number({ integer: true, min: 0, max: this.layers.length - 1 });
    for (const idx of layer_indices) {
      check_index(idx);
    }
    const indices = sorted([...new Set(layer_indices)]);
    if (!move_all_attributes) {
      if (indices.length !== 1) {
        throw new ValueError("move_all_attributes=False requires exactly one layer index.");
      }
      const layer = this.layers[indices[0]];
      // 3D model layers cannot swap sources (replace_source raises);
      // check before mutating so a failure leaves the project intact.
      if (
        !(layer instanceof AVLayer) ||
        layer.source == null ||
        layer._ldta.layer_type === LayerType.THREE_D_MODEL
      ) {
        throw new ValueError(
          "move_all_attributes=False requires a layer with a " + "replaceable source.",
        );
      }
      return this._precompose_leave_attributes(layer, name);
    }
    return this._precompose_move(indices, name);
  }

  _create_precomp_item(name: string, width: number, height: number): CompItem {
    /**
     * Create the precompose target composition.
     *
     * Built via `add_comp` for the skeleton, then this composition's
     * settings are inherited by byte-copying its cdta (AE writes the
     * new comp's cdta byte-identical to the parent's, with only
     * width/height overridden in the leave-attributes path), and the
     * item is stored at the alphabetical position AE uses.
     */
    const folder = this.parent_folder;
    py_assert(folder != null);
    const new_comp = folder.add_comp(
      name,
      width,
      height,
      this.pixel_aspect,
      this.duration,
      this.frame_rate,
    );
    const cloned = clone_chunk_tree(this._cdta);
    cloned.width = width;
    cloned.height = height;
    const cdta_idx = index_by_identity(new_comp._item_list.chunks, new_comp._cdta);
    new_comp._item_list.chunks[cdta_idx] = cloned;
    new_comp._cdta = cloned;
    folder._reposition_child_sorted(new_comp);
    return new_comp;
  }

  _precompose_leave_attributes(layer: AVLayer, name: string): CompItem {
    /**
     * The `move_all_attributes=False` path: the retained layer only
     * swaps its source to the new comp (sized from the layer's source),
     * which holds one fresh layer referencing the original source.
     */
    const source = layer.source;
    py_assert(source != null);
    const new_comp = this._create_precomp_item(name, source.width, source.height);
    new_comp.add(source);
    layer.replace_source(new_comp);
    _drop_essential_overrides(layer);
    return new_comp;
  }

  _precompose_move(indices: number[], name: string): CompItem {
    /**
     * The `move_all_attributes=True` path: verbatim chunk-block moves
     * with fresh layer ids.
     */
    const project = this._project;
    const moved = indices.map((i) => this.layers[i]);
    const top_index = indices[0];
    const old_ids = new Set<number | null>(moved.map((ly) => ly.id));
    const repl_enabled = moved[0].enabled;

    const new_comp = this._create_precomp_item(name, this.width, this.height);

    // Detach the moved layers' chunk blocks (top-down keeps their
    // relative stacking order).
    // Each block starts at its layer's own LIST:Layr.
    const blocks: [ListChunk, ...Chunk[]][] = [];
    for (const ly of moved) {
      const [start, end] = this._layer_block_slice(ly);
      blocks.push([ly._layer_list, ...this._item_list.chunks.slice(start + 1, end)]);
      this._item_list.chunks.splice(start, end - start);
      const at_layer = this._layers.indexOf(ly);
      if (at_layer < 0) {
        throw new ValueError("list.remove(x): x not in list");
      }
      this._layers.splice(at_layer, 1);
    }
    this._invalidate_layer_cache();

    // AE reallocates layer ids on precompose; owner tdpi values inside
    // each layer's tdgp reference the owning layer id and must follow.
    const id_map: Map<number, number> = new Map();
    for (const ly of moved) {
      const new_id = project._allocate_id();
      id_map.set(ly.id, new_id);
      ly._ldta.layer_id = new_id;
      rewrite_owner_tdpi(ly._layer_list, new_id);
    }

    // A moved layer whose track matte stays behind gets a verbatim
    // COPY of the matte layer directly below it in the new comp; the
    // original matte layer stays untouched in this comp (AE 2026). A
    // layer REFERENCE held by an effect parameter (Set Matte, Layer
    // Control, CC Sphere's light layer, ...) follows the same rule -
    // AE brings the referenced layer along rather than leaving an id
    // the new comp cannot resolve, which it refuses to open.
    const matte_map: Map<number, number> = new Map();
    const final_blocks: [ListChunk, ...Chunk[]][] = [];
    for (const [i, ly] of moved.entries()) {
      const block = blocks[i];
      final_blocks.push(block);
      const referenced: number[] = [ly._ldta.matte_layer_id || 0];
      referenced.push(...sorted([...collect_layer_ref_tdpi_ids(ly._layer_list)]));
      for (const matte_id of referenced) {
        if (!matte_id || id_map.has(matte_id) || matte_map.has(matte_id)) {
          continue;
        }
        const matte_layer = this.layers_by_id.get(matte_id) ?? null;
        if (matte_layer != null) {
          const [m_start, m_end] = this._layer_block_slice(matte_layer);
          const m_list = clone_chunk_tree(matte_layer._layer_list);
          const m_block: [ListChunk, ...Chunk[]] = [
            m_list,
            ...this._item_list.chunks.slice(m_start + 1, m_end).map((c) => clone_chunk_tree(c)),
          ];
          const m_ldta = find_by_type(m_list.chunks, "ldta");
          const copy_id = project._allocate_id();
          m_ldta.layer_id = copy_id;
          rewrite_owner_tdpi(m_list, copy_id);
          // The clone's own references point at old-comp layer
          // ids: follow a parent/matte that moved, drop one that
          // stayed behind (it does not exist in the new comp).
          if (m_ldta.parent_id) {
            m_ldta.parent_id = id_map.get(m_ldta.parent_id) ?? 0;
          }
          if (m_ldta.matte_layer_id) {
            m_ldta.matte_layer_id = id_map.get(m_ldta.matte_layer_id) ?? 0;
          }
          matte_map.set(matte_id, copy_id);
          final_blocks.push(m_block);
        }
      }
    }

    // Remap references inside the moved set: both ends moved -> new
    // id; parent stayed behind -> unparented; matte stayed behind ->
    // the copy created above.
    for (const ly of moved) {
      const ldta = ly._ldta;
      if (ldta.parent_id) {
        ldta.parent_id = id_map.get(ldta.parent_id) ?? 0;
      }
      const matte_id = ldta.matte_layer_id || 0;
      if (matte_id) {
        ldta.matte_layer_id = id_map.get(matte_id) || (matte_map.get(matte_id) ?? 0);
      }
    }

    // Layer-reference effect params follow the same map, for the copied
    // blocks too: a reference that moved (or was copied in above) is
    // retargeted, one that did not is cleared to "no layer".
    const ref_map = new Map([...id_map, ...matte_map]);
    for (const block of final_blocks) {
      remap_layer_ref_tdpi(block[0], ref_map);
      // The block is MOVED, not serialized, so it still carries the
      // synthetic chunks synthesis added. Re-parsing them on the far
      // side would read a synthesizer's default as a real value; drop
      // them and let synthesis run again, as a re-open does.
      strip_synthetic(block[0]);
    }

    // Insert the blocks and re-parse each layer in the new comp's
    // context (the old Layer models go stale, like ExtendScript).
    new_comp._ensure_layers_loaded();
    let insert_at = new_comp._find_first_layer_position();
    const effect_defs = project._effect_param_defs;
    for (const block of final_blocks) {
      new_comp._item_list.chunks.splice(insert_at, 0, ...block);
      insert_at += block.length;
      const new_layer = parse_layer(block[0], new_comp, effect_defs);
      new_comp._layers.push(new_layer);
    }
    new_comp._invalidate_layer_cache();

    // Source usage bookkeeping for the moved (and copied) layers.
    project._ensure_used_in_linked();
    for (const new_layer of new_comp._layers) {
      const source = getattr(new_layer, "source", null);
      if (source != null && "_used_in" in source) {
        _unregister_source_usage(source, this);
        source._used_in.add(new_comp);
      }
    }

    // Replacement layer at the topmost moved index. AE writes the
    // Sandstone label and inherits the topmost moved layer's video
    // switch (a matte layer moved alone keeps serving as matte, so
    // it stays off).
    const repl = this.add(new_comp);
    if (top_index > 0) {
      repl.move_after(this.layers[top_index]);
    }
    repl.label = Label.SANDSTONE;
    repl.enabled = repl_enabled;

    // Stayers referencing a moved layer retarget to the replacement
    // layer (both parenting and track matte).
    const repl_id = repl.id;
    for (const ly of this.layers) {
      if (ly === repl) {
        continue;
      }
      const ldta = ly._ldta;
      if (old_ids.has(ldta.parent_id)) {
        ldta.parent_id = repl_id;
      }
      if (old_ids.has(ldta.matte_layer_id)) {
        ldta.matte_layer_id = repl_id;
      }
    }

    this._invalidate_layer_cache();
    return new_comp;
  }

  add_solid(
    color: number[],
    name: string | null = null,
    width: number | null = null,
    height: number | null = null,
    pixel_aspect = 1.0,
    duration: number | null = null,
  ): AVLayer {
    /**
     * Create a new solid layer at the top of the layer stack.
     *
     * @param color - Solid color as `[R, G, B]` in 0.0--1.0 range.
     * @param name - The solid and layer name. Pass `null` to auto-generate a name from the color
     *   (e.g. `Red Solid 1`).
     * @param width - Solid width in pixels. Defaults to comp width.
     * @param height - Solid height in pixels. Defaults to comp height.
     * @param pixel_aspect - Pixel aspect ratio (default 1.0).
     * @param duration - Layer duration in seconds. Defaults to the synthetic-layer default span
     *   (the "Pref_DEFAULT_SYNTHETIC_OUT_POINT" preference; composition duration by default). AE's
     *   `addSolid` ignores this argument (probed in AE 2026); py_aep honors it, since it sets the
     *   layer out-point directly and the result is a valid AE file.
     * @returns The newly created {@link AVLayer}.
     */
    // Validate before the auto-name subscripts the color, so malformed
    // input raises ValueError instead of TypeError/IndexError.
    validate_rgb_color(color);

    if (name == null) {
      const existing = new Set([...this._project.items.values()].map((item) => item.name));
      const solid_name = SolidSource._color_name(color[0], color[1], color[2]);
      name = auto_name(solid_name, existing);
    }

    if (width == null) {
      width = this.width;
    }
    if (height == null) {
      height = this.height;
    }

    const solid_source = SolidSource._new(name, color, width, height, pixel_aspect);
    const solids_folder = this._project._solids_folder;
    const footage = FootageItem._new(solid_source, {
      project: this._project,
      parent_folder: solids_folder,
    });
    solids_folder._children_container.push(footage._item_list);
    solids_folder._children_container.push(...footage._view_data);
    this._project.items.set(footage.id, footage);
    solids_folder.items.push(footage);

    // AE leaves the layer name empty for source-named layers (the
    // name resolves from the solid footage item).
    const layer = AVLayer._new({
      name: "",
      layer_id: this._project._allocate_id(),
      source_id: footage.id,
      duration: duration != null ? duration : this._synthetic_layer_duration(),
      containing_comp: this,
      label: label_index(this._project._preferences, "Solid Label Index 2", 1),
      effect_param_defs: this._project._effect_param_defs,
    });
    this._insert_layer(layer);

    this._project._ensure_used_in_linked();
    if ("_used_in" in footage) {
      footage._used_in.add(this);
    }

    return layer;
  }

  _build_text_btds(
    text: string,
    box_size: number[] | null = null,
    line_orientation: LineOrientation | null = null,
  ): [ListChunk, ListChunk, TdmnChunk] {
    /**
     * Build the binary btds/btdk structure for a text layer.
     *
     * @param text - The text content.
     * @param box_size - `[width, height]` for box text; `null` for point text.
     * @param line_orientation - Text {@link LineOrientation}; `null` for the default horizontal
     *   orientation.
     * @returns A `(LIST:btds, btgu, tdmn)` array to inject into the root tdgp.
     */
    const td = new TextDocument(text, box_size, line_orientation);
    // AE applies the character-level "Text Style Sheet" preferences to
    // every new text layer (probed in AE 2026; the paragraph sheet is
    // not applied).
    apply_text_style_prefs(td, this._project._preferences);
    const btdk = td._btdk_body;

    // Text-document tdbs carries an empty cdat with 4 trailing zero
    // bytes (matches what AE writes).
    const cdat = new CdatChunk({ pad: b("\x00\x00\x00\x00") });
    const tdb4 = new Tdb4Chunk({
      dimensions: 1,
      time_base: this._cdta.internal_timebase,
      no_value_flags: 1,
      type_flags: 0x08,
      cvot_flags: 0x04,
      value_hint_type: 1,
    });
    const tdbs = new ListChunk({
      list_type: "tdbs",
      chunks: [new TdsbChunk(), TdsnChunk.new_(TDSN_SENTINEL), tdb4, cdat],
    });
    const btds = new ListChunk({ list_type: "btds", chunks: [tdbs, btdk] });
    const btgu = new ListChunk({
      list_type: "btgu",
      chunks: [PguiChunk.new_(), new PguiChunk()],
    });
    const tdmn = new TdmnChunk({ value: "ADBE Text Document" });
    return [btds, btgu, tdmn];
  }

  _add_text_layer(
    text: string,
    box = false,
    box_size: number[] | null = null,
    line_orientation: LineOrientation | null = null,
  ): TextLayer {
    validate_text(text);
    if (box) {
      if (box_size == null) {
        box_size = [this.width, this.height];
      } else {
        validate_box_size(box_size);
      }
    }

    const existing = new Set(this.layers.map((lyr) => lyr.name));
    text = text || auto_name(TextLayer._auto_name, existing);

    const [btds, btgu, td_mn] = this._build_text_btds(text, box_size, line_orientation);

    const layer = TextLayer._new({
      name: text,
      layer_id: this._project._allocate_id(),
      duration: this._synthetic_layer_duration(),
      containing_comp: this,
      btds,
      btgu,
      tdmn: td_mn,
      effect_param_defs: this._project._effect_param_defs,
    });
    this._insert_layer(layer);
    return layer;
  }

  /**
   * Create a new point text layer at the top of the layer stack.
   *
   * @param text - Initial text content.
   * @returns The newly created {@link TextLayer}.
   */
  add_text(text = ""): TextLayer {
    return this._add_text_layer(text, false);
  }

  /**
   * Create a new box (paragraph) text layer at the top of the layer stack.
   *
   * @param box_size - `[width, height]` of the text box. If `null`, uses the composition
   *   dimensions.
   * @param text - Initial text content.
   * @returns The newly created {@link TextLayer}.
   */
  add_box_text(box_size: number[] | null = null, text = ""): TextLayer {
    return this._add_text_layer(text, true, box_size);
  }

  /**
   * Create a new vertical point text layer at the top of the stack.
   *
   * Vertical text flows top-to-bottom with lines stacking right-to-left,
   * matching the Vertical Type Tool default.
   *
   * @param text - Initial text content.
   * @returns The newly created {@link TextLayer}.
   */
  // @requires_version(24): wrapped after the class body.
  add_vertical_text(text = ""): TextLayer {
    return this._add_text_layer(text, false, null, LineOrientation.VERTICAL_RIGHT_TO_LEFT);
  }

  /**
   * Create a new vertical box (paragraph) text layer at the top of the stack.
   *
   * Vertical text flows top-to-bottom with lines stacking right-to-left,
   * matching the Vertical Type Tool default.
   *
   * @param box_size - `[width, height]` of the text box. If `null`, uses the composition
   *   dimensions.
   * @param text - Initial text content.
   * @returns The newly created {@link TextLayer}.
   */
  // @requires_version(24): wrapped after the class body.
  add_vertical_box_text(box_size: number[] | null = null, text = ""): TextLayer {
    return this._add_text_layer(
      text,
      true,
      box_size,
      LineOrientation.VERTICAL_RIGHT_TO_LEFT,
    );
  }
}

// ChunkField descriptors (`bg_color = ChunkField[...](...)` in the class body).

/** The background color of the composition. The three array values specify
 * the red, green, and blue components of the color. Read / Write. */
descriptor(
  CompItem,
  "bg_color",
  new ChunkField("_cdta", "bg_color", { validate: validate_rgb_color }),
);

/** When `true`, Draft 3D mode is enabled for the composition. Read / Write. */
descriptor(CompItem, "draft3d", ChunkField.bool("_cdta", "draft3d"));

/** When `true`, frame blending is enabled for this Composition. Read / Write. */
descriptor(CompItem, "frame_blending", ChunkField.bool("_cdta", "frame_blending"));

/** When `true`, only layers with `shy` set to `false` are shown in the
 * Timeline panel. Read / Write. */
descriptor(CompItem, "hide_shy_layers", ChunkField.bool("_cdta", "hide_shy_layers"));

/** When `true`, motion blur is enabled for the composition. Read / Write. */
descriptor(CompItem, "motion_blur", ChunkField.bool("_cdta", "motion_blur"));

/** When `true`, the frame rate of nested compositions is preserved in
 * the current composition. Read / Write. */
descriptor(
  CompItem,
  "preserve_nested_frame_rate",
  ChunkField.bool("_cdta", "preserve_nested_frame_rate"),
);

/** When `true`, the resolution of nested compositions is preserved in
 * the current composition. Read / Write. */
descriptor(
  CompItem,
  "preserve_nested_resolution",
  ChunkField.bool("_cdta", "preserve_nested_resolution"),
);

/** The width of the item in pixels. Read / Write. */
descriptor(
  CompItem,
  "width",
  new ChunkField("_cdta", "width", {
    validate: validate_footage_dimension,
    pre_set: "_ensure_layers_loaded",
  }),
);

/** The height of the item in pixels. Read / Write. */
descriptor(
  CompItem,
  "height",
  new ChunkField("_cdta", "height", {
    validate: validate_footage_dimension,
    pre_set: "_ensure_layers_loaded",
  }),
);

/** The shutter angle setting for the composition. Read / Write. */
descriptor(
  CompItem,
  "shutter_angle",
  new ChunkField("_cdta", "shutter_angle", {
    validate: _validate_number({ min: 0, max: 720, integer: true }),
  }),
);

/** The shutter phase setting for the composition. Read / Write. */
descriptor(
  CompItem,
  "shutter_phase",
  new ChunkField("_cdta", "shutter_phase", {
    validate: _validate_number({ min: -360, max: 360, integer: true }),
  }),
);

/** The x and y downsample resolution factors for rendering the
 * composition. The default is [1, 1]. Read / Write. */
descriptor(
  CompItem,
  "resolution_factor",
  new ChunkField("_cdta", "resolution_factor", {
    validate: validate_sequence({ length: 2, min: 1, max: 99, integer: true }),
  }),
);

/**
 * The maximum number of motion blur samples of 2D layer motion. Must be
 * \>= `samples_per_frame`. Read / Write. 
 */
descriptor(
  CompItem,
  "motion_blur_adaptive_sample_limit",
  new ChunkField("_cdta", "motion_blur_adaptive_sample_limit", {
    validate: _validate_number({
      min: (self: CompItem) => self.motion_blur_samples_per_frame,
      max: 256,
      integer: true,
    }),
  }),
);

/** The minimum number of motion blur samples per frame for Classic 3D
 * layers, shape layers, and certain effects. Read / Write. */
descriptor(
  CompItem,
  "motion_blur_samples_per_frame",
  new ChunkField("_cdta", "motion_blur_samples_per_frame", {
    validate: _validate_number({ min: 2, max: 64, integer: true }),
  }),
);

/** The pixel aspect ratio of the item (1.0 is square). Read / Write. */
descriptor(
  CompItem,
  "pixel_aspect",
  new ChunkField("_cdta", "pixel_aspect", {
    validate: validate_pixel_aspect,
    // See `width`.
    pre_set: "_ensure_layers_loaded",
  }),
);

/** The time scale, used as a divisor for keyframe time values. Read-only. */
descriptor(
  CompItem,
  "time_scale",
  new ChunkField("_cdta", "time_scale", { read_only: true }),
);

/** The time set as the beginning of the composition, in seconds. Read / Write. */
descriptor(
  CompItem,
  "display_start_time",
  new ChunkField("_cdta", "display_start_time", {
    // AE 2026's own bounds ("out of range -10800 to 86400").
    validate: _validate_number({ min: -10800.0, max: 86400.0 }),
    post_set: "_restore_times_in_timebase",
  }),
);

/** When `true`, timecode is displayed in drop-frame format. Only
 * applicable when `frameRate` is 29.97 or 59.94. Read / Write. */
descriptor(
  CompItem,
  "drop_frame",
  ChunkField.bool("_cdrp", "value", {
    transform: (v: number) => v !== 0,
    reverse: (v: boolean) => int(v),
    default: false,
  }),
);

// `@requires_version(15)` on the `motion_graphics_template_name` setter, and
// `@requires_version(24)` on the vertical text methods. Python applies these
// decorators while the class body runs; here they wrap the finished class.
{
  const d = Object.getOwnPropertyDescriptor(CompItem.prototype, "motion_graphics_template_name");
  const set = d?.set;
  py_assert(set !== undefined);
  // A setter's own name is "set <prop>"; Python's error names the method.
  Object.defineProperty(set, "name", { value: "motion_graphics_template_name" });
  Object.defineProperty(CompItem.prototype, "motion_graphics_template_name", {
    ...d,
    set: requires_version(15)(set),
  });
}
CompItem.prototype.add_vertical_text = requires_version(24)(CompItem.prototype.add_vertical_text);
CompItem.prototype.add_vertical_box_text = requires_version(24)(
  CompItem.prototype.add_vertical_box_text,
);
