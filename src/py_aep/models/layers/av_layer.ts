import { deferred, descriptor } from "../../../pyrt/index.ts";
// Port of py_aep/models/layers/av_layer.py

import { BlendingMode, FrameBlendingType, LayerQuality, LayerSamplingQuality, LayerType, TrackMatteType } from "../../enums/index.ts";
import {
  AttributeError,
  typeName,
  NotImplementedError,
  ValueError,
  floatRepr,
  hasattr,
  max,
  min,
  pyAssert,
  pyBool,
  pyOr,
  repr,
} from "../../../pyrt/index.ts";
import { requiresVersion } from "../../ae_version.ts";
import { LdtaChunk } from "../../binary/layer_chunks.ts";
import { findByListType, findByType } from "../../binary/utils.ts";
import { getChunksByMatchName } from "../../parsers/utils.ts";
import type { EssentialGraphicsController } from "../essential_graphics.ts";
import { resolveEssentialPropertyControllers } from "../../resolvers/essential_properties.ts";
import { canAddLayer } from "../../resolvers/motion_graphics.ts";
import { shapeLayerRect } from "../../resolvers/shape_bounds.ts";
import { textInkRect } from "../../resolvers/text_ink.ts";
import { type Mat4, buildWorldMatrix, cameraRay, intersectLayerPlane, projectToComp, transformFromPoints } from "../../resolvers/transform.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import type { Chunk } from "../../binary/chunk.ts";
import type { CompItem } from "../items/composition.ts";
import { Property } from "../properties/property.ts";
import { validateBool, validateEnum, validateName, validateNumber, validateVector2, validateVector3 } from "../validators.ts";
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
    throw new ValueError(`the converted point overflows: [${point.map((v) => floatRepr(v)).join(", ")}]`);
  }
  return point;
}

export function _wouldCreateCycle(targetComp: CompItem, newSource: AVItem): boolean {
  /**
   * Check if using `newSource` as a layer source would create a cycle.
   *
   * Walks UP from `targetComp` via `_usedIn` back-references and returns
   * `true` if `newSource` is found among the ancestors, meaning the
   * replacement would create a circular reference chain.
   */
  if (!hasattr(newSource, "layers")) return false;
  // Python tracks visited comps by id(); object identity in a Set is the same check.
  const visited = new Set<CompItem>();
  const stack: CompItem[] = [targetComp];
  for (let comp = stack.pop(); comp !== undefined; comp = stack.pop()) {
    if (comp === newSource) return true;
    if (visited.has(comp)) continue;
    visited.add(comp);
    for (const ancestor of comp.usedIn) {
      stack.push(ancestor);
    }
  }
  return false;
}

export function _unregisterSourceUsage(
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
  for (const layer of comp.avLayers) {
    if (layer !== exclude && layer._sourceId === source.id) return;
  }
  source._usedIn.delete(comp);
}

export function _validateCollapseTransformation(value: boolean, obj: AVLayer): void {
  validateBool(value);
  if (!obj.canSetCollapseTransformation) {
    throw new AttributeError(
      "'collapseTransformation' is read-only when 'canSetCollapseTransformation' is false.",
    );
  }
}

/** Keyword arguments of `AVLayer._new`. */
type AVLayerNewKw = {
  name: string;
  layerId: number;
  duration: number;
  containingComp: CompItem;
  sourceId?: number;
  nullLayer?: boolean;
  threeDLayer?: boolean;
  label?: number;
  rootTdgpExtra?: Chunk[] | null;
  effectParamDefs?: EffectParamDefs | null;
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
 * const layer = comp.fileLayers[0];
 * console.log(layer.source);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/avlayer/
 */
export class AVLayer extends Layer {
  // NOTE(port): accessor stubs typed for TS only; descriptor(AVLayer, ...) below redefines both on the prototype, so these bodies never run.
  /** When `true`, the layer is an adjustment layer. Read / Write. */
  get adjustmentLayer(): boolean {
    return false;
  }

  set adjustmentLayer(_value: boolean) {}

  /**
   * `true` if this is an environment layer in a Ray-traced 3D
   * composition. Read / Write.
   *
   * Setting this to `true` turns {@link threeDLayer} off, as After Effects
   * 2026 does: contrary to the Scripting Guide, it does not make the layer
   * 3D. A 2D layer stays as it is.
   */
  get environmentLayer(): boolean {
    return false;
  }

  set environmentLayer(_value: boolean) {}

  /**
   * When `true`, the layer's audio is enabled. This value corresponds
   * to the audio toggle switch in the Timeline panel. Read / Write.
   */
  declare audioEnabled: boolean;

  /**
   * `true` if collapse transformation is on for this layer.
   * Read / Write.
   */
  declare collapseTransformation: boolean;

  /**
   * `true` if the layer's effects are active, as indicated by the
   * \<f\> icon next to it in the user interface. Read / Write.
   */
  declare effectsActive: boolean;

  /** The type of frame blending for the layer. Read / Write. */
  declare frameBlendingType: FrameBlendingType;

  /** `true` if the layer is a guide layer. Read / Write. */
  declare guideLayer: boolean;

  /** `true` if motion blur is enabled for the layer. Read / Write. */
  declare motionBlur: boolean;

  /**
   * `true` if preserve transparency is enabled for the layer.
   * Read / Write.
   */
  declare preserveTransparency: boolean;

  /** The layer's draft quality setting. Read / Write. */
  declare quality: LayerQuality;

  /** The layer's sampling method. Read / Write. */
  declare samplingQuality: LayerSamplingQuality;

  /**
   * `true` if this layer is a 3D layer. Read / Write.
   *
   * Setting it leaves {@link environmentLayer} as it is (After Effects 2026).
   */
  declare threeDLayer: boolean;

  /** Whether the layer transforms in three dimensions - its 3D switch.
   * Read-only. */
  get is3d(): boolean {
    return this.threeDLayer;
  }

  /** The layer's pixel dimensions, or `null` when either is zero. */
  get _pixelSize(): [number, number] | null {
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
  get _maskScale(): [number, number] {
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
  declare threeDPerChar: boolean;

  /** The ID of the source item for this layer. 0 for a text layer. Read-only. */
  declare _sourceId: number;

  /** The resolved source item; unset until first read (see `source`). */
  declare _source?: AVItem | null;

  static _new<T extends AVLayer>(this: new (kw: ConstructorParameters<typeof Layer>[0]) => T, kw: AVLayerNewKw): T;
  static _new(...args: never[]): never;
  static _new<T extends AVLayer>(this: new (kw: ConstructorParameters<typeof Layer>[0]) => T, kw: AVLayerNewKw): T {
    const {
      name,
      layerId,
      duration,
      containingComp,
      sourceId = 0,
      nullLayer = false,
      threeDLayer = false,
      label = 1,
      rootTdgpExtra = null,
      effectParamDefs = null,
    } = kw;
    // Python slices code points, not UTF-16 units.
    const nameChars = Array.from(name);
    const ldta = new LdtaChunk({
      layerId,
      quality: 2,
      sourceId,
      label,
      blendingMode: 2,
      layerType: LayerType.AV,
      layerName: nameChars.length > 31 ? nameChars.slice(0, 31).join("") : name,
    });
    ldta.outPoint = duration;
    ldta.nullLayer = nullLayer;
    ldta.threeDLayer = threeDLayer;
    // AE writes _reserved_3b=1 (and _reserved_3c=0) for every AV layer
    // (verified across 237/238 AE-native AV layers); cameras/lights use 0/0.
    ldta._reserved3b = 1;
    return super._new<T>({
      ldta,
      name,
      containingComp,
      rootTdgpExtra,
      effectParamDefs,
    });
  }

  /** The blending mode of the layer. Read / Write. */
  get blendingMode(): BlendingMode {
    const mode = BlendingMode.fromBinary(this._ldta.blendingMode);
    if (mode === BlendingMode.DISSOLVE && this._ldta.dancingDissolve) {
      return BlendingMode.DANCING_DISSOLVE;
    }
    return mode;
  }

  set blendingMode(value: BlendingMode) {
    validateEnum(BlendingMode)(value);
    value = BlendingMode.of(value);
    // Dancing Dissolve has no transfer-mode value of its own: AE stores it
    // as Dissolve plus the dancing-dissolve flag in the ldta transfer byte.
    if (value === BlendingMode.DANCING_DISSOLVE) {
      this._ldta.blendingMode = BlendingMode.toBinary(BlendingMode.DISSOLVE);
      this._ldta.dancingDissolve = true;
    } else {
      this._ldta.blendingMode = BlendingMode.toBinary(value);
      this._ldta.dancingDissolve = false;
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
   * **Warning:** This is a legacy API. Consider using {@link setTrackMatte} and
   * {@link removeTrackMatte} instead.
   *
   * Read / Write.
   */
  get trackMatteType(): TrackMatteType {
    return TrackMatteType.fromBinary(this._ldta.trackMatteType);
  }

  set trackMatteType(value: TrackMatteType | number) {
    validateEnum(TrackMatteType)(value);
    value = TrackMatteType.of(value);
    const oldMatte = this.trackMatteLayer;
    this._ldta.trackMatteType = TrackMatteType.toBinary(value);
    if (value === TrackMatteType.NO_TRACK_MATTE && this._ldta.matteLayerId != null) {
      this._ldta.matteLayerId = 0;
      if (oldMatte != null) {
        this._reEnableMatte(oldMatte);
      }
    }
  }

  _onEnvironmentLayerSet(): void {
    if (this._ldta.environmentLayer && this._ldta.threeDLayer) {
      // Through the 3-D switch, which AE turns off here, with all a
      // toggle does.
      this.threeDLayer = false;
    }
  }

  _onThreeDLayerSet(): void {
    // Circular: synthesis.core imports the layer classes it synthesizes for.
    // AE renames "Rotation" <-> "Z Rotation" the moment the 3-D switch is
    // toggled, and normalizes a 2-D layer's dead Scale Z to 100 in the
    // chunk on either side of it - so the setter always writes through.
    _core().applyDimensionalityNaming(this, { resetScaleZ: true });
  }

  /**
   * The ID of the layer used as a track matte for this layer.
   *
   * `0` when no track matte is applied.
   * Conditional in the binary (AE \>= 23 only).
   */
  get _matteLayerId(): number {
    // matte_layer_id is conditional (only in AE >= 23)
    return pyOr("matteLayerId" in this._ldta ? this._ldta.matteLayerId : 0, 0);
  }

  /**
   * Whether layer timing should be clamped to source duration.
   *
   * After Effects clamps in/outPoint when queried via ExtendScript
   * for non-still footage layers without time remapping enabled.
   */
  _shouldClampTimes(): boolean {
    const source = this.source;
    if (source == null) {
      return false;
    }
    if (source instanceof FootageItem && source.mainSource.isStill) {
      return false;
    }
    if (this.timeRemapEnabled) {
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
   * (seconds). Clamped to `startTime` for non-still footage layers.
   * Read / Write.
   *
   * On a time-reversed layer the in point is the later end, and sits
   * `|stretch| / 100 / 3000` s before the start time (1.2995 s for a
   * -150 % layer starting at 1.3 s), as After Effects reports it.
   */
  get inPoint(): number {
    const raw = super.inPoint;
    if (!this._shouldClampTimes()) {
      return raw;
    }
    return max([raw, this.startTime]);
  }

  set inPoint(value: number) {
    validateNumber(value);
    this._setRawInPoint(value);
  }

  /**
   * The "out" point of the layer, expressed in composition time
   * (seconds). Clamped to `start_time + source.duration * stretch` for
   * non-still footage layers without time remapping. Read / Write.
   *
   * On a time-reversed layer the out point is the earlier end (see
   * {@link inPoint}).
   */
  get outPoint(): number {
    const raw = super.outPoint;
    if (!this._shouldClampTimes()) {
      return raw;
    }
    pyAssert(this.source != null); // _should_clamp_times guards
    const sourceDuration = this.source.duration;
    const maxOut = this.startTime + sourceDuration * this._stretchFactor;
    return min([raw, maxOut]);
  }

  set outPoint(value: number) {
    validateNumber(value);
    this._setRawOutPoint(value);
  }

  /** `true` if frame blending is enabled for this layer. Read-only. */
  get frameBlending(): boolean {
    return this.frameBlendingType !== FrameBlendingType.NO_FRAME_BLEND;
  }

  /**
   * The source item for this layer. `null` for a text layer. Read-only.
   */
  get source(): AVItem | null {
    // An unset `_source` is Python's AttributeError: resolve it on first read.
    if (hasattr(this, "_source") && this._source !== undefined) {
      return this._source;
    }
    if (this._sourceId === 0) {
      this._source = null;
      return null;
    } else {
      const result = this.containingComp._project.items.get(this._sourceId) ?? null;
      if (result != null) {
        this._source = result as AVItem;
        return this._source;
      }
      return null;
    }
  }

  get _sourceItem(): AVItem | null {
    return this.source;
  }

  /**
   * The source composition's Essential Graphics controllers that this
   * precomp layer's Essential Properties overrides reference.
   *
   * Each entry corresponds to a UUID in `essentialPropertyUuids` (same
   * order), resolved against the source comp's
   * `motionGraphicsControllers` by shared UUID. Empty for a non-precomp
   * layer, a source comp with no controllers, or a layer with no
   * overrides. Read-only.
   */
  get essentialPropertyControllers(): EssentialGraphicsController[] {
    return resolveEssentialPropertyControllers(this);
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
  canAddToMotionGraphicsTemplate(comp: CompItem): boolean {
    return canAddLayer(this, comp);
  }

  /**
   * Add this layer to `comp`'s Essential Graphics panel as a Media
   * Replacement controller, named after the layer.
   *
   * Returns `true` on success, or `false` when the layer cannot be
   * added (see `canAddToMotionGraphicsTemplate`).
   *
   * @param comp - The composition to add the layer to.
   */
  addToMotionGraphicsTemplate(comp: CompItem): boolean {
    return comp._addLayerController(this, null);
  }

  /**
   * Add this layer to `comp`'s Essential Graphics panel as a Media
   * Replacement controller with an explicit `name`.
   *
   * Returns `true` on success, or `false` when the layer cannot be
   * added (see `canAddToMotionGraphicsTemplate`).
   *
   * @param comp - The composition to add the layer to.
   * @param name - The controller name to show in the Essential Graphics panel.
   */
  addToMotionGraphicsTemplateAs(comp: CompItem, name: string): boolean {
    validateName(name);
    return comp._addLayerController(this, name);
  }

  /**
   * `true` if the layer has a video component. An `AVLayer` has video
   * when its {@link source} has video, or when the layer has no external source
   * (text and shape layers always render video). Read-only.
   */
  get hasVideo(): boolean {
    const source = this.source;
    if (source == null) {
      return true;
    }
    return !!source.hasVideo;
  }

  /** `true` if the layer has an audio component. Read-only. */
  get hasAudio(): boolean {
    const source = this.source;
    if (source == null) {
      return false;
    }
    return !!source.hasAudio;
  }

  /**
   * `true` if the layer's audio is active at the current time.
   *
   * For this to be `true`, {@link audioEnabled} must be `true`,
   * {@link hasAudio} must be `true`, no other layer with audio may be
   * soloing unless this layer is also soloed, and the current
   * {@link time} must be between {@link inPoint} and {@link outPoint}.
   * Read-only.
   */
  get audioActive(): boolean {
    return this.audioActiveAtTime(this.time);
  }

  /**
   * Return whether the layer's audio is active at the given time.
   *
   * For this method to return `true`, four conditions must be met:
   *
   * 1. {@link hasAudio} must be `true`.
   * 2. {@link audioEnabled} must be `true`.
   * 3. No other layer with audio in the
   *    {@link Layer.containingComp | containing_comp} may be soloed unless
   *    this layer is also {@link Layer.solo | soloed}.
   * 4. *time* must fall between {@link inPoint} (inclusive) and
   *    {@link outPoint} (exclusive).
   *
   * @param time - The time in seconds.
   */
  audioActiveAtTime(time: number): boolean {
    validateNumber(time);

    if (!this.hasAudio) {
      return false;
    }

    if (!this.audioEnabled) {
      return false;
    }

    const anySolo = this.containingComp.soloLayers.some(
      (layer) => layer instanceof AVLayer && layer.hasAudio,
    );
    if (anySolo && !this.solo) {
      return false;
    }

    if (time < this.inPoint || time >= this.outPoint) {
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
  _geometryTime(time: number | null): number {
    if (time != null) {
      validateNumber(time);
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
  sourcePointToComp(point: number[], time: number | null = null): number[] {
    validateVector2(point);
    const evalTime = this._geometryTime(time);
    const comp = this.containingComp;
    const world = this._worldMatrix(evalTime);
    const worldPoint = world.transformPoint([point[0], point[1], 0.0]);
    return _finite(projectToComp(worldPoint, comp.width, comp.height, comp.pixelAspect));
  }

  /**
   * World matrix for the point conversions at comp `time`: a 2D
   * layer is placed as AE places it, its 3D ancestors flattened.
   */
  _worldMatrix(time: number): Mat4 {
    return buildWorldMatrix(this, time, !this.threeDLayer, { autoOrient: true });
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
   * {@link sourcePointToComp}.
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
  compPointToSource(point: number[], time: number | null = null): number[] {
    validateVector2(point);
    const evalTime = this._geometryTime(time);
    const comp = this.containingComp;
    const world = this._worldMatrix(evalTime);
    const camera = this.threeDLayer ? this._activeCameraAt(evalTime) : null;
    const [origin, direction] = cameraRay(
      camera,
      [point[0], point[1]],
      comp.width,
      comp.height,
      comp.pixelAspect,
      evalTime,
    );
    return _finite(intersectLayerPlane(world, origin, direction));
  }

  /** The front-most enabled camera layer active at `time`, or `null`. */
  _activeCameraAt(time: number): Layer | null {
    for (const camera of this.containingComp.cameraLayers) {
      if (camera.enabled && camera.inPoint <= time && time < camera.outPoint) {
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
   * @param pointTopLeft - `[x, y, z]` comp-space position of the source's top-left corner.
   * @param pointTopRight - `[x, y, z]` position of the top-right corner.
   * @param pointBottomLeft - `[x, y, z]` position of the bottom-left corner.
   * @returns An object of transform property values (`anchorPoint`, `position`, `x_rotation`,
   *   `y_rotation`, `z_rotation`, `scale`), assignable to the matching transform properties.
   * @throws {@link ValueError} If the points are coincident or collinear.
   */
  calculateTransformFromPoints(
    pointTopLeft: number[],
    pointTopRight: number[],
    pointBottomLeft: number[],
  ): Record<string, number | number[]> {
    for (const pt of [pointTopLeft, pointTopRight, pointBottomLeft]) {
      validateVector3(pt);
    }
    return transformFromPoints(
      pointTopLeft,
      pointTopRight,
      pointBottomLeft,
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
  sourceRectAtTime(
    time: number,
    extents: boolean,
  ): { top: number; left: number; width: number; height: number } {
    validateNumber(time);
    validateBool(extents);
    const layerType = this._ldta.layerType;
    if (layerType === LayerType.THREE_D_MODEL) {
      throw new NotImplementedError(
        "sourceRectAtTime does not model 3D model layers: After Effects reports the bounds of the model geometry",
      );
    }
    // Property values are evaluated at composition time.
    const compTime = this.startTime + (time * this.stretch) / 100.0;
    if (layerType === LayerType.TEXT) {
      return this._textInkRect(compTime);
    }
    if (layerType === LayerType.SHAPE) {
      const contents = this.property("ADBE Root Vectors Group");
      return shapeLayerRect(contents, compTime, extents);
    }
    return {
      top: 0.0,
      left: 0.0,
      width: this.width,
      height: this.height,
    };
  }

  _textInkRect(time: number): { top: number; left: number; width: number; height: number } {
    const text = this.property("ADBE Text Properties");
    const animators = text.property("ADBE Text Animators");
    if (animators.properties?.length > 0) {
      throw new NotImplementedError("sourceRectAtTime does not model text animators");
    }
    const pathOptions = text.property("ADBE Text Path Options");
    const textPath = pathOptions.property("ADBE Text Path");
    if (!(textPath instanceof Property)) {
      throw new AttributeError(`'${typeName(textPath)}' object has no attribute 'value'`);
    }
    if (pyBool(textPath.value)) {
      throw new NotImplementedError("sourceRectAtTime does not model text on a path");
    }
    if (this._ldta.threeDPerChar) {
      throw new NotImplementedError("sourceRectAtTime does not model per-character 3D text");
    }
    const document = text.property("ADBE Text Document").valueAtTime(time);
    return textInkRect(document);
  }

  /**
   * `true` if it is possible to set the
   * {@link AVLayer.collapseTransformation | collapse_transformation} value.
   *
   * Returns `true` for pre-composition layers and solid layers.
   * Read-only.
   */
  get canSetCollapseTransformation(): boolean {
    const source = this.source;
    if (source == null) {
      return false;
    }
    if (source instanceof _composition().CompItem) {
      return true;
    }
    if (source instanceof FootageItem) {
      const ms = source.mainSource;
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
  get canSetTimeRemapEnabled(): boolean {
    if (this.source == null) {
      return false;
    }
    return this.source.duration > 0;
  }

  /** `true` if time remapping is enabled for this layer. Read / Write. */
  get timeRemapEnabled(): boolean {
    // From the chunks, not the property: reading a layer's times
    // (`inPoint`, `outPoint`) then leaves its property tree unbuilt.
    pyAssert(this._tdgp != null);
    const chunks = getChunksByMatchName(this._tdgp).get("ADBE Time Remapping");
    if (chunks == null || chunks.length === 0) return false;
    const tdbs = findByListType(chunks, "tdbs");
    const tdb4 = findByType(tdbs.chunks, "tdb4");
    return tdb4.animated;
  }

  set timeRemapEnabled(value: boolean) {
    validateBool(value);
    if (!this.canSetTimeRemapEnabled) {
      throw new AttributeError(
        "'timeRemapEnabled' is read-only when 'canSetTimeRemapEnabled' is false.",
      );
    }
    const prop = this.property("ADBE Time Remapping");
    if (!(prop instanceof Property)) {
      return;
    }
    const currentlyEnabled = !!prop._animated;
    if (value && !currentlyEnabled) {
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
      pyAssert(source != null); // can_set_time_remap_enabled guarantees it
      const duration = source.duration;
      prop._addKey(this.startTime, 0.0);
      prop._addKey(this.startTime + duration, duration);
    } else if (!value && currentlyEnabled) {
      while (prop.keyframes?.length > 0) {
        prop.removeKey(0);
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
    return this.containingComp.width;
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
    return this.containingComp.height;
  }

  /**
   * `true` if this layer has track matte. When true, this layer's `trackMatteType`
   * value controls how the matte is applied. Read-only.
   */
  get hasTrackMatte(): boolean {
    return this.trackMatteType !== TrackMatteType.NO_TRACK_MATTE;
  }

  /** `true` if this layer is being used as a track matte. Read-only. */
  get isTrackMatte(): boolean {
    // AE 23+: explicit ID-based references
    if (this.containingComp.avLayers.some((layer) => layer._matteLayerId === this.id)) {
      return true;
    }
    // Pre-2023 positional fallback: layer below has has_track_matte
    const layers = this.containingComp.layers;
    const idx = this.index;
    if (idx + 1 < layers.length) {
      const below = layers[idx + 1];
      if (
        below instanceof AVLayer &&
        below._matteLayerId === 0 &&
        below.hasTrackMatte
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
  get trackMatteLayer(): AVLayer | null {
    // AE 23+: explicit ID-based lookup
    if (this._matteLayerId !== 0) {
      const layer = this.containingComp.layersById.get(this._matteLayerId) ?? null;
      if (layer instanceof AVLayer) {
        return layer;
      }
      return null;
    }
    // Pre-2023 positional fallback: matte is the layer directly above
    if (this.hasTrackMatte) {
      const idx = this.index;
      if (idx > 0) {
        const layers = this.containingComp.layers;
        const above = layers[idx - 1];
        if (above instanceof AVLayer) {
          return above;
        }
      }
    }
    return null;
  }

  /** Fall back to source name, then empty string. */
  get autoName(): string {
    if (this.source != null) {
      return this.source.name;
    }
    return this._autoName || "";
  }

  /**
   * True if the layer has no expressly set name, but contains a named source.
   *
   * In this case, layer.name has the same value as layer.source.name.
   * False if the layer has an expressly set name, or if the layer does not
   * have a source. Read-only.
   */
  get isNameFromSource(): boolean {
    return this.source != null && !this.isNameSet;
  }

  // ------------------------------------------------------------------
  // Mutation methods
  // ------------------------------------------------------------------

  /** Re-enable `matte` if no other layer in the comp uses it. */
  _reEnableMatte(matte: AVLayer): void {
    for (const layer of this.containingComp.avLayers) {
      if (layer !== this && layer._matteLayerId === matte.id) {
        return;
      }
    }
    matte.enabled = true;
  }

  /**
   * Sets the track matte layer and type for this layer.
   * Passing in `null` to `trackMatteLayer` parameter removes
   * the track matte. See [remove_track_matte] for another way
   * of removing track matte.
   *
   * **Note:** Requires AE 23.0+ file format.
   *
   * @param trackMatteLayer - The layer to use as a track matte, or `null` to remove the track
   *   matte.
   * @param trackMatteType - The {@link TrackMatteType} to apply. Passing `NO_TRACK_MATTE` with a
   *   non-`null` layer is a no-op.
   * @throws {@link AttributeError} If the file predates AE 23.0.
   * @throws {@link ValueError} If `trackMatteLayer` belongs to a different composition.
   */
  setTrackMatte(
    trackMatteLayer: AVLayer | null,
    trackMatteType: TrackMatteType | number,
  ): void {
    validateEnum(TrackMatteType)(trackMatteType);
    trackMatteType = TrackMatteType.of(trackMatteType);
    if (trackMatteLayer != null && !(trackMatteLayer instanceof AVLayer)) {
      throw new ValueError("trackMatteLayer must be an AVLayer or null.");
    }
    if (trackMatteLayer != null && trackMatteType === TrackMatteType.NO_TRACK_MATTE) {
      return;
    }

    if (trackMatteLayer != null && trackMatteLayer.containingComp !== this.containingComp) {
      throw new ValueError("trackMatteLayer must belong to the same composition.");
    }

    // Re-enable old matte if it is being replaced
    const oldMatte = this.trackMatteLayer;
    if (oldMatte != null && oldMatte !== trackMatteLayer) {
      this._reEnableMatte(oldMatte);
    }

    this._ldta.trackMatteType = TrackMatteType.toBinary(trackMatteType);

    if (trackMatteLayer != null) {
      this._ldta.matteLayerId = trackMatteLayer.id;
      trackMatteLayer.enabled = false;
    } else {
      this._ldta.matteLayerId = 0;
    }
  }

  /**
   * Remove the track matte layer reference.
   *
   * The {@link trackMatteType} value is preserved. To also reset
   * it, assign `TrackMatteType.NO_TRACK_MATTE` separately.
   *
   * **Note:** Requires AE 23.0+ file format.
   *
   * @throws {@link AttributeError} If the file predates AE 23.0.
   */
  removeTrackMatte(): void {
    const oldMatte = this.trackMatteLayer;
    this._ldta.matteLayerId = 0;

    if (oldMatte != null) {
      this._reEnableMatte(oldMatte);
    }
  }

  /**
   * Re-derive the transform defaults a null layer had.
   *
   * Synthesis gives a null the origin as its Anchor Point and 0 as its
   * default Opacity; with a real source the anchor is the source's centre
   * and the Opacity defaults to 100. Only a left-out Opacity moves - once
   * the user has set one, the value is theirs and a source swap must not
   * move it.
   */
  _refreshFormerNullDefaults(): void {
    // Circular: synthesis.core imports the layer classes it synthesizes for.
    const transform = this.transform;
    if (transform == null) {
      return;
    }
    _core().followSourceAnchor(transform.property("ADBE Anchor Point"));

    const opacity = transform.property("ADBE Opacity");
    opacity.defaultValue = 100.0;
    if (!opacity._isLive()) {
      opacity._cacheValue(100.0);
    }
  }

  /**
   * Replace the source item for this layer.
   *
   * **Warning:** Contrary to ExtendScript, if this method is performed
   * on a null layer, the layer's `nullLayer` attribute
   * changes to `false`, making the layer visible
   * in comp viewer and renders.
   *
   * @param newSource - The new source {@link AVItem}.
   * @param fixExpressions - Update expressions that reference the old source name. Not yet
   *   implemented.
   * @throws {@link NotImplementedError} If `fixExpressions` is `true`.
   * @throws {@link ValueError} If the layer has no source (e.g. shape or text layers), if
   *   `newSource` is not in the project, if `newSource` would create a composition cycle, or if
   *   the layer is a 3D model layer.
   */
  replaceSource(newSource: AVItem, fixExpressions = false): void {
    if (fixExpressions) {
      throw new NotImplementedError("fixExpressions is not yet supported.");
    }

    if (this.source == null) {
      throw new ValueError("layer does not have a source");
    }

    // 3D model layers cannot have their source
    // replaced - AE silently ignores the call but we raise.
    if (this._ldta.layerType === 5) {
      throw new ValueError("replaceSource is not supported on 3D model layers");
    }

    if (!(newSource instanceof AVItem)) {
      throw new ValueError("newSource must be an AVItem.");
    }

    const comp = this.containingComp;
    const project = comp._project;
    if (!project.items.has(newSource.id)) {
      throw new ValueError(`Item ${repr(newSource.name)} (id=${newSource.id}) is not in the project.`);
    }

    if (_wouldCreateCycle(comp, newSource)) {
      throw new ValueError(
        `Item ${repr(newSource.name)} (id=${newSource.id}) can't be used as a source because it would create a composition cycle.`,
      );
    }

    const oldSource = this.source;
    if (oldSource != null && "_usedIn" in oldSource) {
      _unregisterSourceUsage(oldSource, comp, { exclude: this });
    }

    this._sourceId = newSource.id;
    this._source = newSource;

    newSource._usedIn.add(comp);

    if (this.nullLayer) {
      this._ldta.nullLayer = false;
      // A null's Anchor Point default is the origin; with a source it is
      // the source's centre. Refresh the cached default so the model
      // reports what a re-parse of this file will.
      this._refreshFormerNullDefaults();
    }
  }
}

// Class-body `ChunkField` assignments in Python, installed as descriptors.
descriptor(AVLayer, "adjustmentLayer", ChunkField.bool("_ldta", "adjustmentLayer"));
descriptor(AVLayer, "audioEnabled", ChunkField.bool("_ldta", "audioEnabled"));
descriptor(
  AVLayer,
  "collapseTransformation",
  ChunkField.bool("_ldta", "collapseTransformation", { validate: _validateCollapseTransformation }),
);
descriptor(AVLayer, "effectsActive", ChunkField.bool("_ldta", "effectsActive"));
descriptor(
  AVLayer,
  "environmentLayer",
  ChunkField.bool("_ldta", "environmentLayer", { postSet: "_onEnvironmentLayerSet" }),
);
descriptor(AVLayer, "frameBlendingType", ChunkField.enum(FrameBlendingType, "_ldta", "frameBlendingType"));
descriptor(AVLayer, "guideLayer", ChunkField.bool("_ldta", "guideLayer"));
descriptor(AVLayer, "motionBlur", ChunkField.bool("_ldta", "motionBlurFlag"));
descriptor(AVLayer, "preserveTransparency", ChunkField.bool("_ldta", "preserveTransparency"));
descriptor(AVLayer, "quality", ChunkField.enum(LayerQuality, "_ldta", "quality"));
descriptor(
  AVLayer,
  "samplingQuality",
  ChunkField.enum(LayerSamplingQuality, "_ldta", "samplingQuality", { minVersion: 12 }),
);
descriptor(
  AVLayer,
  "threeDLayer",
  ChunkField.bool("_ldta", "threeDLayer", {
    // Built at the dimensionality the file has, so the toggle sees the
    // dead 2-D Scale Z it normalizes.
    preSet: "_loadPropertyTree",
    postSet: "_onThreeDLayerSet",
  }),
);
descriptor(AVLayer, "threeDPerChar", ChunkField.bool("_ldta", "threeDPerChar"));
descriptor(AVLayer, "_sourceId", new ChunkField("_ldta", "sourceId"));

// `@requires_version(23)` on the two track-matte methods, applied bottom-up after the class.
AVLayer.prototype.setTrackMatte = requiresVersion(23)(AVLayer.prototype.setTrackMatte);
AVLayer.prototype.removeTrackMatte = requiresVersion(23)(AVLayer.prototype.removeTrackMatte);
