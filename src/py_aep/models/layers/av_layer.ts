import { deferred, descriptor } from "../../../pyrt/index.ts";
// Port of py_aep/models/layers/av_layer.py

import { BlendingMode, FrameBlendingType, LayerQuality, LayerSamplingQuality, LayerType, TrackMatteType } from "../../enums/index.ts";
import {
  AttributeError,
  type_name,
  NotImplementedError,
  ValueError,
  float_repr,
  getattr,
  hasattr,
  max,
  min,
  py_assert,
  py_bool,
  py_or,
  repr,
} from "../../../pyrt/index.ts";
import { requires_version } from "../../ae_version.ts";
import { LdtaChunk } from "../../binary/layer_chunks.ts";
import type { EssentialGraphicsController } from "../essential_graphics.ts";
import { resolve_essential_property_controllers } from "../../resolvers/essential_properties.ts";
import { can_add_layer } from "../../resolvers/motion_graphics.ts";
import { shape_layer_rect } from "../../resolvers/shape_bounds.ts";
import { text_ink_rect } from "../../resolvers/text_ink.ts";
import { type Mat4, build_world_matrix, camera_ray, intersect_layer_plane, project_to_comp, transform_from_points } from "../../resolvers/transform.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import type { Chunk } from "../../binary/chunk.ts";
import type { CompItem } from "../items/composition.ts";
import { Property } from "../properties/property.ts";
import { validate_bool, validate_enum, validate_name, validate_number, validate_vector2, validate_vector3 } from "../validators.ts";
import { Layer } from "./layer.ts";
import { AVItem } from "../items/av_item.ts";
import { FootageItem } from "../items/footage.ts";
import { SolidSource } from "../sources/solid.ts";
const _composition = deferred<typeof import("../items/composition.ts")>("py_aep/models/items/composition");
const _core = deferred<typeof import("../../synthesis/core.ts")>("py_aep/synthesis/core");

export function _finite(point: number[]): number[] {
  /**
   * `point`, or `ValueError` when a coordinate overflowed to inf / nan
   * (an input near the float limit).
   */
  if (!point.every((v) => Number.isFinite(v))) {
    throw new ValueError(`the converted point overflows: [${point.map((v) => float_repr(v)).join(", ")}]`);
  }
  return point;
}

export function _would_create_cycle(target_comp: CompItem, new_source: AVItem): boolean {
  /**
   * Check if using `new_source` as a layer source would create a cycle.
   *
   * Walks UP from `target_comp` via `_used_in` back-references and returns
   * `true` if `new_source` is found among the ancestors, meaning the
   * replacement would create a circular reference chain.
   */
  if (!hasattr(new_source, "layers")) return false;
  // Python tracks visited comps by id(); object identity in a Set is the same check.
  const visited = new Set<CompItem>();
  const stack: CompItem[] = [target_comp];
  for (let comp = stack.pop(); comp !== undefined; comp = stack.pop()) {
    if (comp === new_source) return true;
    if (visited.has(comp)) continue;
    visited.add(comp);
    for (const ancestor of comp.used_in) {
      stack.push(ancestor);
    }
  }
  return false;
}

export function _unregister_source_usage(
  source: AVItem,
  comp: CompItem,
  kw: { exclude?: Layer | null } = {},
): void {
  /**
   * Remove `comp` from `source._used_in` if no other layer still references it.
   *
   * @param source - The source item to potentially unregister.
   * @param comp - The composition to remove from `source._used_in`.
   * @param exclude - A layer to skip when scanning for other users (the caller itself, which is
   *   being removed or swapped out).
   */
  const { exclude = null } = kw;
  for (const layer of comp.av_layers) {
    if (layer !== exclude && layer._source_id === source.id) return;
  }
  source._used_in.delete(comp);
}

export function _validate_collapse_transformation(value: boolean, obj: AVLayer): void {
  validate_bool(value);
  if (!obj.can_set_collapse_transformation) {
    throw new AttributeError(
      "'collapse_transformation' is read-only when 'can_set_collapse_transformation' is False.",
    );
  }
}

/** Keyword arguments of `AVLayer._new`. */
type AVLayerNewKw = {
  name: string;
  layer_id: number;
  duration: number;
  containing_comp: CompItem;
  source_id?: number;
  null_layer?: boolean;
  three_d_layer?: boolean;
  label?: number;
  root_tdgp_extra?: Chunk[] | null;
  effect_param_defs?: EffectParamDefs | null;
};

/**
 * The `AVLayer` object provides an interface to those layers that contain
 * {@link AVItem} objects (composition layers, footage layers, solid layers, text
 * layers and sound layers).
 *
 *
 * Info:
 *     `AVLayer` is a subclass of {@link Layer} object. All methods and attributes
 *     of {@link Layer} are available when working with `AVLayer`.
 *
 * Info:
 *     `AVLayer` is a base class for {@link TextLayer} object, so `AVLayer`
 *     attributes and methods are available when working with {@link TextLayer}
 *     objects.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const layer = comp.file_layers[0];
 * console.log(layer.source);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/avlayer/
 */
export class AVLayer extends Layer {
  // NOTE(port): accessor stubs typed for TS only; descriptor(AVLayer, ...) below redefines both on the prototype, so these bodies never run.
  /** When `true`, the layer is an adjustment layer. Read / Write. */
  get adjustment_layer(): boolean {
    return false;
  }

  set adjustment_layer(_value: boolean) {}

  /**
   * `true` if this is an environment layer in a Ray-traced 3D
   * composition. Setting this to `true` automatically sets
   * {@link three_d_layer} to `true`. Read / Write.
   */
  get environment_layer(): boolean {
    return false;
  }

  set environment_layer(_value: boolean) {}

  /**
   * When `true`, the layer's audio is enabled. This value corresponds
   * to the audio toggle switch in the Timeline panel. Read / Write.
   */
  declare audio_enabled: boolean;

  /**
   * `true` if collapse transformation is on for this layer.
   * Read / Write.
   */
  declare collapse_transformation: boolean;

  /**
   * `true` if the layer's effects are active, as indicated by the
   * \<f\> icon next to it in the user interface. Read / Write.
   */
  declare effects_active: boolean;

  /** The type of frame blending for the layer. Read / Write. */
  declare frame_blending_type: FrameBlendingType;

  /** `true` if the layer is a guide layer. Read / Write. */
  declare guide_layer: boolean;

  /** `true` if motion blur is enabled for the layer. Read / Write. */
  declare motion_blur: boolean;

  /**
   * `true` if preserve transparency is enabled for the layer.
   * Read / Write.
   */
  declare preserve_transparency: boolean;

  /** The layer's draft quality setting. Read / Write. */
  declare quality: LayerQuality;

  /** The layer's sampling method. Read / Write. */
  declare sampling_quality: LayerSamplingQuality;

  /**
   * `true` if this layer is a 3D layer. Setting this to `true`
   * automatically sets {@link environment_layer} to `false`.
   * Read / Write.
   */
  declare three_d_layer: boolean;

  /** Whether the layer transforms in three dimensions - its 3D switch.
   * Read-only. */
  get is_3d(): boolean {
    return this.three_d_layer;
  }

  /** The layer's pixel dimensions, or `null` when either is zero. */
  get _pixel_size(): [number, number] | null {
    const width = this.width;
    const height = this.height;
    if (width && height) {
      return [width, height];
    }
    return null;
  }

  /**
   * The size mask paths are stored normalized to: the source's pixel
   * size, or 1 x 1 for a source-less (text / shape) layer, whose mask
   * paths AE stores in layer pixels (measured on AE 2026).
   */
  get _mask_scale(): [number, number] {
    const source = this.source;
    if (source == null) {
      return [1.0, 1.0];
    }
    return [source.width, source.height];
  }

  /**
   * `true` if this layer has the Enable Per-character 3D switch set,
   * allowing its characters to be animated off the plane of the text
   * layer. Applies only to text layers. Read / Write.
   */
  declare three_d_per_char: boolean;

  /** The ID of the source item for this layer. 0 for a text layer. Read-only. */
  declare _source_id: number;

  /** The resolved source item; unset until first read (see `source`). */
  declare _source?: AVItem | null;

  static _new<T extends AVLayer>(this: new (kw: ConstructorParameters<typeof Layer>[0]) => T, kw: AVLayerNewKw): T;
  static _new(...args: never[]): never;
  static _new<T extends AVLayer>(this: new (kw: ConstructorParameters<typeof Layer>[0]) => T, kw: AVLayerNewKw): T {
    const {
      name,
      layer_id,
      duration,
      containing_comp,
      source_id = 0,
      null_layer = false,
      three_d_layer = false,
      label = 1,
      root_tdgp_extra = null,
      effect_param_defs = null,
    } = kw;
    // Python slices code points, not UTF-16 units.
    const name_chars = Array.from(name);
    const ldta = new LdtaChunk({
      layer_id,
      quality: 2,
      source_id,
      label,
      blending_mode: 2,
      layer_type: LayerType.AV,
      layer_name: name_chars.length > 31 ? name_chars.slice(0, 31).join("") : name,
    });
    ldta.out_point = duration;
    ldta.null_layer = null_layer;
    ldta.three_d_layer = three_d_layer;
    // AE writes _reserved_3b=1 (and _reserved_3c=0) for every AV layer
    // (verified across 237/238 AE-native AV layers); cameras/lights use 0/0.
    ldta._reserved_3b = 1;
    return super._new<T>({
      ldta,
      name,
      containing_comp,
      root_tdgp_extra,
      effect_param_defs,
    });
  }

  /** The blending mode of the layer. Read / Write. */
  get blending_mode(): BlendingMode {
    const mode = BlendingMode.from_binary(this._ldta.blending_mode);
    if (mode === BlendingMode.DISSOLVE && this._ldta.dancing_dissolve) {
      return BlendingMode.DANCING_DISSOLVE;
    }
    return mode;
  }

  set blending_mode(value: BlendingMode) {
    validate_enum(BlendingMode)(value);
    value = BlendingMode.of(value);
    // Dancing Dissolve has no transfer-mode value of its own: AE stores it
    // as Dissolve plus the dancing-dissolve flag in the ldta transfer byte.
    if (value === BlendingMode.DANCING_DISSOLVE) {
      this._ldta.blending_mode = BlendingMode.to_binary(BlendingMode.DISSOLVE);
      this._ldta.dancing_dissolve = true;
    } else {
      this._ldta.blending_mode = BlendingMode.to_binary(value);
      this._ldta.dancing_dissolve = false;
    }
  }

  /**
   * Specifies the way the track matte is applied.
   *
   * Setting `TrackMatteType.NO_TRACK_MATTE` removes the track matte
   * for this layer and resets the matte layer reference.
   *
   * **Note:** This functionality was updated in After Effects 23.0.
   *
   * **Warning:** This is a legacy API. Consider using {@link set_track_matte} and
   * {@link remove_track_matte} instead.
   *
   * Read / Write.
   */
  get track_matte_type(): TrackMatteType {
    return TrackMatteType.from_binary(this._ldta.track_matte_type);
  }

  set track_matte_type(value: TrackMatteType | number) {
    validate_enum(TrackMatteType)(value);
    value = TrackMatteType.of(value);
    const old_matte = this.track_matte_layer;
    this._ldta.track_matte_type = TrackMatteType.to_binary(value);
    if (value === TrackMatteType.NO_TRACK_MATTE && this._ldta.matte_layer_id != null) {
      this._ldta.matte_layer_id = 0;
      if (old_matte != null) {
        this._re_enable_matte(old_matte);
      }
    }
  }

  _on_environment_layer_set(): void {
    if (this._ldta.environment_layer) {
      this._ldta.three_d_layer = true;
    }
  }

  _on_three_d_layer_set(): void {
    // Circular: synthesis.core imports the layer classes it synthesizes for.
    // AE renames "Rotation" <-> "Z Rotation" the moment the 3-D switch is
    // toggled, and normalizes a 2-D layer's dead Scale Z to 100 in the
    // chunk on either side of it - so the setter always writes through.
    if (this._ldta.three_d_layer) {
      this._ldta.environment_layer = false;
    }
    _core().apply_dimensionality_naming(this, { reset_scale_z: true });
  }

  /**
   * The ID of the layer used as a track matte for this layer.
   *
   * `0` when no track matte is applied.
   * Conditional in the binary (AE \>= 23 only).
   */
  get _matte_layer_id(): number {
    // matte_layer_id is conditional (only in AE >= 23)
    return py_or("matte_layer_id" in this._ldta ? this._ldta.matte_layer_id : 0, 0);
  }

  /**
   * Whether layer timing should be clamped to source duration.
   *
   * After Effects clamps in/outPoint when queried via ExtendScript
   * for non-still footage layers without time remapping enabled.
   */
  _should_clamp_times(): boolean {
    const source = this.source;
    if (source == null) {
      return false;
    }
    if (source instanceof FootageItem && source.main_source.is_still) {
      return false;
    }
    if (this.time_remap_enabled) {
      return false;
    }
    if (source.duration <= 0) {
      return false;
    }
    if (this.stretch < 0) {
      return false;
    }
    return true;
  }

  /**
   * The "in" point of the layer, expressed in composition time
   * (seconds). Clamped to `start_time` for non-still footage layers.
   * Read / Write.
   *
   * On a time-reversed layer the in point is the later end, and sits
   * `|stretch| / 100 / 3000` s before the start time (1.2995 s for a
   * -150 % layer starting at 1.3 s), as After Effects reports it.
   */
  get in_point(): number {
    const raw = super.in_point;
    if (!this._should_clamp_times()) {
      return raw;
    }
    return max([raw, this.start_time]);
  }

  set in_point(value: number) {
    validate_number(value);
    this._set_raw_in_point(value);
  }

  /**
   * The "out" point of the layer, expressed in composition time
   * (seconds). Clamped to `start_time + source.duration * stretch` for
   * non-still footage layers without time remapping. Read / Write.
   *
   * On a time-reversed layer the out point is the earlier end (see
   * {@link in_point}).
   */
  get out_point(): number {
    const raw = super.out_point;
    if (!this._should_clamp_times()) {
      return raw;
    }
    py_assert(this.source != null); // _should_clamp_times guards
    const source_duration = this.source.duration;
    const max_out = this.start_time + source_duration * this._stretch_factor;
    return min([raw, max_out]);
  }

  set out_point(value: number) {
    validate_number(value);
    this._set_raw_out_point(value);
  }

  /** `true` if frame blending is enabled for this layer. Read-only. */
  get frame_blending(): boolean {
    return this.frame_blending_type !== FrameBlendingType.NO_FRAME_BLEND;
  }

  /**
   * The source item for this layer. `null` for a text layer. Read-only.
   */
  get source(): AVItem | null {
    // An unset `_source` is Python's AttributeError: resolve it on first read.
    if (hasattr(this, "_source") && this._source !== undefined) {
      return this._source;
    }
    if (this._source_id === 0) {
      this._source = null;
      return null;
    } else {
      const result = this.containing_comp._project.items.get(this._source_id) ?? null;
      if (result != null) {
        this._source = result as AVItem;
        return this._source;
      }
      return null;
    }
  }

  /**
   * The source composition's Essential Graphics controllers that this
   * precomp layer's Essential Properties overrides reference.
   *
   * Each entry corresponds to a UUID in `essential_property_uuids` (same
   * order), resolved against the source comp's
   * `motion_graphics_controllers` by shared UUID. Empty for a non-precomp
   * layer, a source comp with no controllers, or a layer with no
   * overrides. Read-only.
   */
  get essential_property_controllers(): EssentialGraphicsController[] {
    return resolve_essential_property_controllers(this);
  }

  /**
   * Test whether this layer can be added to `comp`'s Essential Graphics
   * panel as a Media Replacement.
   *
   * The layer must be a Media Replacement layer (has video, not an
   * adjustment or null layer, and its source is a footage or comp item
   * that is not a solid), must be in `comp`, and must not already be
   * exposed.
   *
   * @param comp - The composition whose Essential Graphics panel to test.
   */
  can_add_to_motion_graphics_template(comp: CompItem): boolean {
    return can_add_layer(this, comp);
  }

  /**
   * Add this layer to `comp`'s Essential Graphics panel as a Media
   * Replacement controller, named after the layer.
   *
   * Returns `true` on success, or `false` when the layer cannot be
   * added (see `can_add_to_motion_graphics_template`).
   *
   * @param comp - The composition to add the layer to.
   */
  add_to_motion_graphics_template(comp: CompItem): boolean {
    return comp._add_layer_controller(this, null);
  }

  /**
   * Add this layer to `comp`'s Essential Graphics panel as a Media
   * Replacement controller with an explicit `name`.
   *
   * Returns `true` on success, or `false` when the layer cannot be
   * added (see `can_add_to_motion_graphics_template`).
   *
   * @param comp - The composition to add the layer to.
   * @param name - The controller name to show in the Essential Graphics panel.
   */
  add_to_motion_graphics_template_as(comp: CompItem, name: string): boolean {
    validate_name(name);
    return comp._add_layer_controller(this, name);
  }

  /**
   * `true` if the layer has a video component. An `AVLayer` has video
   * when its {@link source} has video, or when the layer has no external source
   * (text and shape layers always render video). Read-only.
   */
  get has_video(): boolean {
    const source = this.source;
    if (source == null) {
      return true;
    }
    return !!source.has_video;
  }

  /** `true` if the layer has an audio component. Read-only. */
  get has_audio(): boolean {
    const source = this.source;
    if (source == null) {
      return false;
    }
    return !!source.has_audio;
  }

  /**
   * `true` if the layer's audio is active at the current time.
   *
   * For this to be `true`, {@link audio_enabled} must be `true`,
   * {@link has_audio} must be `true`, no other layer with audio may be
   * soloing unless this layer is also soloed, and the current
   * {@link time} must be between {@link in_point} and {@link out_point}.
   * Read-only.
   */
  get audio_active(): boolean {
    return this.audio_active_at_time(this.time);
  }

  /**
   * Return whether the layer's audio is active at the given time.
   *
   * For this method to return `true`, four conditions must be met:
   *
   * 1. {@link has_audio} must be `true`.
   * 2. {@link audio_enabled} must be `true`.
   * 3. No other layer with audio in the
   *    {@link Layer.containing_comp | containing_comp} may be soloed unless
   *    this layer is also {@link Layer.solo | soloed}.
   * 4. *time* must fall between {@link in_point} (inclusive) and
   *    {@link out_point} (exclusive).
   *
   * @param time - The time in seconds.
   */
  audio_active_at_time(time: number): boolean {
    validate_number(time);

    if (!this.has_audio) {
      return false;
    }

    if (!this.audio_enabled) {
      return false;
    }

    const any_solo = this.containing_comp.solo_layers.some((layer) =>
      py_bool(getattr(layer, "has_audio", false)),
    );
    if (any_solo && !this.solo) {
      return false;
    }

    if (time < this.in_point || time >= this.out_point) {
      return false;
    }

    return true;
  }

  // ------------------------------------------------------------------
  // Geometry evaluation (sourceRectAtTime, point conversions)
  // ------------------------------------------------------------------

  /**
   * Resolve the evaluation time for a geometry method: an explicit
   * `time` (py_aep extension), else the comp's current time - what AE
   * uses, i.e. the playhead position saved in the file.
   */
  _geometry_time(time: number | null): number {
    if (time != null) {
      validate_number(time);
      return time;
    }
    return this.time;
  }

  /**
   * Converts layer coordinates, such as `boxTextPos`, to composition
   * coordinates.
   *
   * The layer's transform chain (parenting included) is evaluated at
   * the composition's current {@link Layer.time | time} - like After Effects,
   * which uses the playhead position stored in the file; pass `time`
   * to evaluate at another time (py_aep extension). 3D layers project
   * through AE's DEFAULT comp camera: `sourcePointToComp()` is
   * camera-independent (verified against AE 2026 across one-node,
   * two-node and keyframed-zoom rigs). A 2D layer ignores the
   * out-of-plane part of 3D ancestors, as After Effects does.
   *
   * Transform values are read before expressions: a layer whose
   * transform chain is driven by expressions converts with the values
   * the expressions replace, where After Effects uses their results.
   *
   * @param point - A position array of `[x, y]` layer coordinates.
   * @param time - Composition time in seconds (py_aep extension; defaults to the comp's current
   *   time).
   * @returns A position array of `[x, y]` composition coordinates.
   * @throws {@link NotImplementedError} If a layer in the parent chain uses an auto-orientation the
   *   transform math does not model (see `resolvers.transform.build_world_matrix`).
   * @throws {@link ValueError} If the result overflows a float.
   */
  source_point_to_comp(point: number[], time: number | null = null): number[] {
    validate_vector2(point);
    const eval_time = this._geometry_time(time);
    const comp = this.containing_comp;
    const world = this._world_matrix(eval_time);
    const world_point = world.transform_point([point[0], point[1], 0.0]);
    return _finite(project_to_comp(world_point, comp.width, comp.height, comp.pixel_aspect));
  }

  /**
   * World matrix for the point conversions at comp `time`: a 2D
   * layer is placed as AE places it, its 3D ancestors flattened.
   */
  _world_matrix(time: number): Mat4 {
    return build_world_matrix(this, time, !this.three_d_layer, { auto_orient: true });
  }

  /**
   * Converts composition coordinates, such as `sourcePointToComp`,
   * to layer coordinates.
   *
   * The layer's transform chain (parenting included) is evaluated at
   * the composition's current {@link Layer.time | time} - like After Effects,
   * which uses the playhead position stored in the file; pass `time`
   * to evaluate at another time (py_aep extension). For a 3D layer the
   * comp point is cast as a ray from the ACTIVE camera (the front-most
   * enabled camera layer active at that time, else AE's default comp
   * camera) and intersected with the layer's plane - unlike
   * `sourcePointToComp()`, this direction IS camera-dependent
   * (verified against AE 2026). The camera is placed by its own parent
   * chain. Transform values are read before expressions, as in
   * {@link source_point_to_comp}.
   *
   * @param point - A position array of `[x, y]` composition coordinates.
   * @param time - Composition time in seconds (py_aep extension; defaults to the comp's current
   *   time).
   * @returns A position array of `[x, y]` layer coordinates.
   * @throws {@link NotImplementedError} If a layer in the parent chain uses an auto-orientation the
   *   transform math does not model (see `resolvers.transform.build_world_matrix`).
   * @throws {@link ValueError} If the camera ray does not reach the layer plane going forward - it
   *   is parallel to the plane, or the layer is at or behind the camera. After Effects returns a
   *   literal `[0, 0]` for these; py_aep raises instead, because that sentinel cannot be told apart
   *   from a real result. Also when the layer plane is degenerate (an X or Y scale of 0) or the
   *   result overflows a float.
   */
  comp_point_to_source(point: number[], time: number | null = null): number[] {
    validate_vector2(point);
    const eval_time = this._geometry_time(time);
    const comp = this.containing_comp;
    const world = this._world_matrix(eval_time);
    const camera = this.three_d_layer ? this._active_camera_at(eval_time) : null;
    const [origin, direction] = camera_ray(
      camera,
      [point[0], point[1]],
      comp.width,
      comp.height,
      comp.pixel_aspect,
      eval_time,
    );
    return _finite(intersect_layer_plane(world, origin, direction));
  }

  /** The front-most enabled camera layer active at `time`, or `null`. */
  _active_camera_at(time: number): Layer | null {
    for (const camera of this.containing_comp.camera_layers) {
      if (camera.enabled && camera.in_point <= time && time < camera.out_point) {
        return camera;
      }
    }
    return null;
  }

  /**
   * Calculates a transformation from a set of points in this layer.
   *
   * A pure function of the three points and the layer's source
   * dimensions - the current transform is ignored (verified against
   * AE 2026). Shear between the axes is absorbed into
   * `scale[2] = 100 * sin(angle)`, and mirrored point sets come out as
   * 180-degree rotation combinations rather than negative scale.
   *
   * **Note:** The AE Scripting Guide names the third parameter
   * `pointBottomRight`, but After Effects treats it as the
   * BOTTOM-LEFT corner (the guide's own example passes `bl`);
   * py_aep names it accordingly.
   *
   * @param point_top_left - `[x, y, z]` comp-space position of the source's top-left corner.
   * @param point_top_right - `[x, y, z]` position of the top-right corner.
   * @param point_bottom_left - `[x, y, z]` position of the bottom-left corner.
   * @returns An object of transform property values (`anchor_point`, `position`, `x_rotation`,
   *   `y_rotation`, `z_rotation`, `scale`), assignable to the matching transform properties.
   * @throws {@link ValueError} If the points are coincident or collinear.
   */
  calculate_transform_from_points(
    point_top_left: number[],
    point_top_right: number[],
    point_bottom_left: number[],
  ): Record<string, number | number[]> {
    for (const pt of [point_top_left, point_top_right, point_bottom_left]) {
      validate_vector3(pt);
    }
    return transform_from_points(
      point_top_left,
      point_top_right,
      point_bottom_left,
      this.width,
      this.height,
    );
  }

  /**
   * Retrieves the rectangle bounds of the layer at the specified
   * time index, corrected for text or shape layer content.
   *
   * For footage, solid, precomposition and adjustment layers this is
   * `(0, 0, width, height)` of the layer source at every time
   * (verified against AE 2026 - the layer transform never affects it).
   * For a shape layer it is the box of its painted paths, grown by the
   * strokes with `extents` (rules in `resolvers.shape_bounds`); for a
   * text layer the tight box of its glyph outlines, from the fonts
   * installed on this machine (rules in `resolvers.text_ink`). Values
   * are read before expressions.
   *
   * `time` is in the layer's own time, not composition time: After
   * Effects neither offsets it by the layer's start time nor applies
   * its stretch (measured on AE 2026 - a layer starting at 0.5 s and
   * stretched to 200 % reports its layer-second-1 content at `time=1`).
   *
   * @param time - The time index, in seconds of layer time.
   * @param extents - `true` to include the extents. Only relevant for shape layers.
   * @returns A dict with `top`, `left`, `width` and `height` keys.
   * @throws {@link NotImplementedError} For a shape layer using a path operation other than Trim
   *   Paths and Repeater, a text layer using a feature outside the measured envelope (text
   *   animators, text on a path, faux styles, a font that is not installed, ...), or a 3D model
   *   layer (whose box is the model's bounds).
   */
  source_rect_at_time(
    time: number,
    extents: boolean,
  ): { top: number; left: number; width: number; height: number } {
    validate_number(time);
    validate_bool(extents);
    const layer_type = this._ldta.layer_type;
    if (layer_type === LayerType.THREE_D_MODEL) {
      throw new NotImplementedError(
        "source_rect_at_time does not model 3D model layers: After Effects reports the bounds of the model geometry",
      );
    }
    // Property values are evaluated at composition time.
    const comp_time = this.start_time + (time * this.stretch) / 100.0;
    if (layer_type === LayerType.TEXT) {
      return this._text_ink_rect(comp_time);
    }
    if (layer_type === LayerType.SHAPE) {
      const contents = this.property("ADBE Root Vectors Group");
      return shape_layer_rect(contents, comp_time, extents);
    }
    return {
      top: 0.0,
      left: 0.0,
      width: this.width,
      height: this.height,
    };
  }

  _text_ink_rect(time: number): { top: number; left: number; width: number; height: number } {
    const text = this.property("ADBE Text Properties");
    const animators = text.property("ADBE Text Animators");
    if (animators.properties?.length > 0) {
      throw new NotImplementedError("source_rect_at_time does not model text animators");
    }
    const path_options = text.property("ADBE Text Path Options");
    const text_path = path_options.property("ADBE Text Path");
    if (!(text_path instanceof Property)) {
      throw new AttributeError(`'${type_name(text_path)}' object has no attribute 'value'`);
    }
    if (py_bool(text_path.value)) {
      throw new NotImplementedError("source_rect_at_time does not model text on a path");
    }
    if (this._ldta.three_d_per_char) {
      throw new NotImplementedError("source_rect_at_time does not model per-character 3D text");
    }
    const document = text.property("ADBE Text Document").value_at_time(time);
    return text_ink_rect(document);
  }

  /**
   * `true` if it is possible to set the
   * {@link AVLayer.collapse_transformation | collapse_transformation} value.
   *
   * Returns `true` for pre-composition layers and solid layers.
   * Read-only.
   */
  get can_set_collapse_transformation(): boolean {
    const source = this.source;
    if (source == null) {
      return false;
    }
    if (source instanceof _composition().CompItem) {
      return true;
    }
    if (source instanceof FootageItem) {
      const ms = source.main_source;
      if (ms instanceof SolidSource) {
        return true;
      }
    }
    return false;
  }

  /**
   * `true` if it is possible to enable time remapping on this layer.
   *
   * Time remapping can be enabled when the layer's source has a
   * non-zero duration (i.e. it is not a still image or text layer).
   * Read-only.
   */
  get can_set_time_remap_enabled(): boolean {
    if (this.source == null) {
      return false;
    }
    return this.source.duration > 0;
  }

  /** `true` if time remapping is enabled for this layer. Read / Write. */
  get time_remap_enabled(): boolean {
    const prop = this._child_or_null("ADBE Time Remapping");
    if (prop === null) return false;
    if (!(prop instanceof Property)) {
      return false;
    }
    return !!prop._animated;
  }

  set time_remap_enabled(value: boolean) {
    validate_bool(value);
    if (!this.can_set_time_remap_enabled) {
      throw new AttributeError(
        "'time_remap_enabled' is read-only when 'can_set_time_remap_enabled' is False.",
      );
    }
    const prop = this.property("ADBE Time Remapping");
    if (!(prop instanceof Property)) {
      return;
    }
    const currently_enabled = !!prop._animated;
    if (value && !currently_enabled) {
      // Enabling time remapping converts the static Time Remap property
      // into an animated one (cdat -> LIST:list swap + animated tdb4
      // state). Flipping only the tdb4.animated bit leaves a
      // contradictory static-and-animated property with no keyframe
      // list, which AE reports as "file is damaged".
      //
      // AE seeds an identity ramp of exactly two LINEAR keyframes,
      // spanning the source from the layer's start rather than from its
      // in point: (start_time, 0) and (start_time + duration, duration).
      // Measured on AE 2026 for comp and footage sources, including a
      // layer offset in time; a single keyframe leaves the remap frozen.
      const source = this.source;
      py_assert(source != null); // can_set_time_remap_enabled guarantees it
      const duration = source.duration;
      prop._add_key(this.start_time, 0.0);
      prop._add_key(this.start_time + duration, duration);
    } else if (!value && currently_enabled) {
      while (prop.keyframes?.length > 0) {
        prop.remove_key(0);
      }
    }
  }

  /**
   * The width of the layer in pixels.
   *
   * Returns the source item's width if available, otherwise falls back
   * to the containing composition's width (matches ExtendScript behavior
   * for source-less layers like text and shape layers). Read-only.
   */
  get width(): number {
    if (this.source != null) {
      return this.source.width;
    }
    return this.containing_comp.width;
  }

  /**
   * The height of the layer in pixels.
   *
   * Returns the source item's height if available, otherwise falls back
   * to the containing composition's height (matches ExtendScript behavior
   * for source-less layers like text and shape layers). Read-only.
   */
  get height(): number {
    if (this.source != null) {
      return this.source.height;
    }
    return this.containing_comp.height;
  }

  /**
   * `true` if this layer has track matte. When true, this layer's `track_matte_type`
   * value controls how the matte is applied. Read-only.
   */
  get has_track_matte(): boolean {
    return this.track_matte_type !== TrackMatteType.NO_TRACK_MATTE;
  }

  /** `true` if this layer is being used as a track matte. Read-only. */
  get is_track_matte(): boolean {
    // AE 23+: explicit ID-based references
    if (this.containing_comp.av_layers.some((layer) => layer._matte_layer_id === this.id)) {
      return true;
    }
    // Pre-2023 positional fallback: layer below has has_track_matte
    const layers = this.containing_comp.layers;
    const idx = this.index;
    if (idx + 1 < layers.length) {
      const below = layers[idx + 1];
      if (
        below instanceof AVLayer &&
        below._matte_layer_id === 0 &&
        below.has_track_matte
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * The track matte layer for this layer. Returns `null` if this layer has no
   * track matte layer. Read-only.
   */
  get track_matte_layer(): AVLayer | null {
    // AE 23+: explicit ID-based lookup
    if (this._matte_layer_id !== 0) {
      const layer = this.containing_comp.layers_by_id.get(this._matte_layer_id) ?? null;
      if (layer instanceof AVLayer) {
        return layer;
      }
      return null;
    }
    // Pre-2023 positional fallback: matte is the layer directly above
    if (this.has_track_matte) {
      const idx = this.index;
      if (idx > 0) {
        const layers = this.containing_comp.layers;
        const above = layers[idx - 1];
        if (above instanceof AVLayer) {
          return above;
        }
      }
    }
    return null;
  }

  /** Fall back to source name, then empty string. */
  get auto_name(): string {
    if (this.source != null) {
      return this.source.name;
    }
    return this._auto_name || "";
  }

  /**
   * True if the layer has no expressly set name, but contains a named source.
   *
   * In this case, layer.name has the same value as layer.source.name.
   * False if the layer has an expressly set name, or if the layer does not
   * have a source. Read-only.
   */
  get is_name_from_source(): boolean {
    return this.source != null && !this.is_name_set;
  }

  // ------------------------------------------------------------------
  // Mutation methods
  // ------------------------------------------------------------------

  /** Re-enable `matte` if no other layer in the comp uses it. */
  _re_enable_matte(matte: AVLayer): void {
    for (const layer of this.containing_comp.av_layers) {
      if (layer !== this && layer._matte_layer_id === matte.id) {
        return;
      }
    }
    matte.enabled = true;
  }

  /**
   * Sets the track matte layer and type for this layer.
   * Passing in `null` to `track_matte_layer` parameter removes
   * the track matte. See [remove_track_matte] for another way
   * of removing track matte.
   *
   * **Note:** Requires AE 23.0+ file format.
   *
   * @param track_matte_layer - The layer to use as a track matte, or `null` to remove the track
   *   matte.
   * @param track_matte_type - The {@link TrackMatteType} to apply. Passing `NO_TRACK_MATTE` with a
   *   non-`null` layer is a no-op.
   * @throws {@link AttributeError} If the file predates AE 23.0.
   * @throws {@link ValueError} If `track_matte_layer` belongs to a different composition.
   */
  set_track_matte(
    track_matte_layer: AVLayer | null,
    track_matte_type: TrackMatteType | number,
  ): void {
    validate_enum(TrackMatteType)(track_matte_type);
    track_matte_type = TrackMatteType.of(track_matte_type);
    if (track_matte_layer != null && !(track_matte_layer instanceof AVLayer)) {
      throw new ValueError("track_matte_layer must be an AVLayer or None.");
    }
    if (track_matte_layer != null && track_matte_type === TrackMatteType.NO_TRACK_MATTE) {
      return;
    }

    if (track_matte_layer != null && track_matte_layer.containing_comp !== this.containing_comp) {
      throw new ValueError("track_matte_layer must belong to the same composition.");
    }

    // Re-enable old matte if it is being replaced
    const old_matte = this.track_matte_layer;
    if (old_matte != null && old_matte !== track_matte_layer) {
      this._re_enable_matte(old_matte);
    }

    this._ldta.track_matte_type = TrackMatteType.to_binary(track_matte_type);

    if (track_matte_layer != null) {
      this._ldta.matte_layer_id = track_matte_layer.id;
      track_matte_layer.enabled = false;
    } else {
      this._ldta.matte_layer_id = 0;
    }
  }

  /**
   * Remove the track matte layer reference.
   *
   * The {@link track_matte_type} value is preserved. To also reset
   * it, assign `TrackMatteType.NO_TRACK_MATTE` separately.
   *
   * **Note:** Requires AE 23.0+ file format.
   *
   * @throws {@link AttributeError} If the file predates AE 23.0.
   */
  remove_track_matte(): void {
    const old_matte = this.track_matte_layer;
    this._ldta.matte_layer_id = 0;

    if (old_matte != null) {
      this._re_enable_matte(old_matte);
    }
  }

  /**
   * Re-derive the transform defaults a null layer had.
   *
   * Synthesis gives a null the origin as its Anchor Point and forces its
   * Opacity to 0; with a real source both come from the source instead.
   * Only touches a property AE never wrote - once the user has set one,
   * the value is theirs and a source swap must not move it.
   */
  _refresh_former_null_defaults(): void {
    const transform = this.transform;
    if (transform == null) {
      return;
    }
    const size = this._pixel_size;

    const synthesized = (match_name: string): Property | null => {
      const prop = transform.property(match_name);
      if (!(prop instanceof Property) || prop.keyframes?.length > 0) {
        return null;
      }
      if (prop._tdbs == null || !prop._tdbs.synthetic) {
        return null;
      }
      return prop;
    };

    const anchor = synthesized("ADBE Anchor Point");
    if (anchor != null && size != null) {
      const default_ = [size[0] / 2.0, size[1] / 2.0, 0.0];
      anchor.default_value = default_;
      anchor._cache_value(default_);
    }

    const opacity = synthesized("ADBE Opacity");
    if (opacity != null && opacity.value === 0.0) {
      opacity.default_value = 100.0;
      opacity._cache_value(100.0);
    }
  }

  /**
   * Replace the source item for this layer.
   *
   * **Warning:** Contrary to ExtendScript, if this method is performed
   * on a null layer, the layer's `null_layer` attribute
   * changes to `false`, making the layer visible
   * in comp viewer and renders.
   *
   * @param new_source - The new source {@link AVItem}.
   * @param fix_expressions - Update expressions that reference the old source name. Not yet
   *   implemented.
   * @throws {@link NotImplementedError} If `fix_expressions` is `true`.
   * @throws {@link ValueError} If the layer has no source (e.g. shape or text layers), if
   *   `new_source` is not in the project, if `new_source` would create a composition cycle, or if
   *   the layer is a 3D model layer.
   */
  replace_source(new_source: AVItem, fix_expressions = false): void {
    if (fix_expressions) {
      throw new NotImplementedError("fix_expressions is not yet supported.");
    }

    if (this.source == null) {
      throw new ValueError("layer does not have a source");
    }

    // 3D model layers cannot have their source
    // replaced - AE silently ignores the call but we raise.
    if (this._ldta.layer_type === 5) {
      throw new ValueError("replace_source is not supported on 3D model layers");
    }

    if (!(new_source instanceof AVItem)) {
      throw new ValueError("new_source must be an AVItem.");
    }

    const comp = this.containing_comp;
    const project = comp._project;
    if (!project.items.has(new_source.id)) {
      throw new ValueError(`Item ${repr(new_source.name)} (id=${new_source.id}) is not in the project.`);
    }

    if (_would_create_cycle(comp, new_source)) {
      throw new ValueError(
        `Item ${repr(new_source.name)} (id=${new_source.id}) can't be used as a source because it would create a composition cycle.`,
      );
    }

    const old_source = this.source;
    if (old_source != null && "_used_in" in old_source) {
      _unregister_source_usage(old_source, comp, { exclude: this });
    }

    this._source_id = new_source.id;
    this._source = new_source;

    new_source._used_in.add(comp);

    if (this.null_layer) {
      this._ldta.null_layer = false;
      // A null's Anchor Point default is the origin; with a source it is
      // the source's centre. Refresh the cached default so the model
      // reports what a re-parse of this file will.
      this._refresh_former_null_defaults();
    }
  }
}

// Class-body `ChunkField` assignments in Python, installed as descriptors.
descriptor(AVLayer, "adjustment_layer", ChunkField.bool("_ldta", "adjustment_layer"));
descriptor(AVLayer, "audio_enabled", ChunkField.bool("_ldta", "audio_enabled"));
descriptor(
  AVLayer,
  "collapse_transformation",
  ChunkField.bool("_ldta", "collapse_transformation", { validate: _validate_collapse_transformation }),
);
descriptor(AVLayer, "effects_active", ChunkField.bool("_ldta", "effects_active"));
descriptor(
  AVLayer,
  "environment_layer",
  ChunkField.bool("_ldta", "environment_layer", { post_set: "_on_environment_layer_set" }),
);
descriptor(AVLayer, "frame_blending_type", ChunkField.enum(FrameBlendingType, "_ldta", "frame_blending_type"));
descriptor(AVLayer, "guide_layer", ChunkField.bool("_ldta", "guide_layer"));
descriptor(AVLayer, "motion_blur", ChunkField.bool("_ldta", "motion_blur_flag"));
descriptor(AVLayer, "preserve_transparency", ChunkField.bool("_ldta", "preserve_transparency"));
descriptor(AVLayer, "quality", ChunkField.enum(LayerQuality, "_ldta", "quality"));
descriptor(
  AVLayer,
  "sampling_quality",
  ChunkField.enum(LayerSamplingQuality, "_ldta", "sampling_quality", { min_version: 12 }),
);
descriptor(
  AVLayer,
  "three_d_layer",
  ChunkField.bool("_ldta", "three_d_layer", { post_set: "_on_three_d_layer_set" }),
);
descriptor(AVLayer, "three_d_per_char", ChunkField.bool("_ldta", "three_d_per_char"));
descriptor(AVLayer, "_source_id", new ChunkField("_ldta", "source_id"));

// `@requires_version(23)` on the two track-matte methods, applied bottom-up after the class.
AVLayer.prototype.set_track_matte = requires_version(23)(AVLayer.prototype.set_track_matte);
AVLayer.prototype.remove_track_matte = requires_version(23)(AVLayer.prototype.remove_track_matte);
