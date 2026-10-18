import { uuid4 } from "../../../pyrt/uuid.ts";

import { aeWrites, getAeVersionMajor, requiresVersion } from "../../ae_version.ts";
import { DeferredListChunk, ListChunk, type Chunk } from "../../binary/chunk.ts";
import { _durationUnits, _frameUnits, buildCps2, buildItemViewChunks, buildLayerViewBlock, buildNewCompItem } from "../../binary/comp_skeleton.ts";
import { WORK_AREA_TO_END, type CdtaChunk, frameGrid, layerTimebase, rescaleTicks } from "../../binary/composition_chunks.ts";
import type { CmtaChunk, IdtaChunk } from "../../binary/item_chunks.ts";
import { _LDTA_SOURCE_ID_END, _LDTA_SOURCE_ID_OFFSET } from "../../binary/layer_chunks.ts";
import { _PRDA_VARIANTS, PguiChunk, type PrdaChunk, type PrinChunk } from "../../binary/misc_chunks.ts";
import { buildCheckboxCctl, buildColorCctl, buildMediaCctl, buildOvg2, buildSliderCctl, buildSourceAlternateExtras, buildTextCctl, cloneChunkTree, collectLayerRefTdpiIds, remapLayerRefTdpi, rewriteOwnerTdpi, stripSynthetic } from "../../binary/mutations.ts";
import { TDSN_SENTINEL, CdatChunk, Tdb4Chunk, TdmnChunk, TdsbChunk, TdsnChunk } from "../../binary/property_chunks.ts";
import { F8Chunk, S4Chunk, type U1Chunk, type U4Chunk, type Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { blockSlice, filterByListType, filterByType, findByListType, findByListTypeOrNull, findByType, findByTypeOrNull, indexByIdentity, listTypeOf, recursiveFind } from "../../binary/utils.ts";
import { Label, LayerType, LineOrientation, ParametricMeshType, PREFType } from "../../enums/index.ts";
import { parseEssentialGraphics } from "../../parsers/essential_graphics.ts";
import { CONTROLLER_CHECKBOX, CONTROLLER_COLOR, CONTROLLER_SLIDER, canAddLayer, fontCapsJson, mediaControllerPath, propertyControllerPlan, type PathNode, type PropertyControllerPlan } from "../../resolvers/motion_graphics.ts";
import { _CAMERA_LIGHT_TRANSFORM_SKIP, _OMITTED_EMPTY_GROUPS } from "../../synthesis/property.ts";
import {
  at,
  Fraction,
  b,
  bytes_,
  bytesEq,
  deferred,
  descriptor,
  float,
  getitem,
  int,
  pyAssert,
  pyBool,
  repr,
  round,
  sorted,
  TypeError_,
  ValueError,
  type ClassAttributes,
  AttributeError,
  typeName,
} from "../../../pyrt/index.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import { EssentialGraphicsController, SourcePropertyRef } from "../essential_graphics.ts";
import { AVLayer, _unregisterSourceUsage } from "../layers/av_layer.ts";
import { CameraLayer } from "../layers/camera_layer.ts";
import type { Layer } from "../layers/layer.ts";
import { LightLayer } from "../layers/light_layer.ts";
import { ParametricMeshLayer } from "../layers/parametric_mesh_layer.ts";
import { ShapeLayer } from "../layers/shape_layer.ts";
import { TextLayer } from "../layers/text_layer.ts";
import { ThreeDModelLayer } from "../layers/three_d_model_layer.ts";
import { autoName } from "../naming.ts";
import { applyTextStylePrefs, defaultStillOutPoint, defaultSyntheticOutPoint, labelIndex } from "../preferences.ts";
import { Property } from "../properties/property.ts";
import { PropertyGroup } from "../properties/property_group.ts";
import { FileSource } from "../sources/file.ts";
import { PlaceholderSource } from "../sources/placeholder.ts";
import { SolidSource } from "../sources/solid.ts";
import { TextDocument } from "../text/text_document.ts";
import { _validateNumber, validateBoxSize, validateCompDuration, validateCompFrameRate, validateDuration, validateFootageDimension, validateName, validateOneOf, validatePixelAspect, validateRgbColor, validateSequence, validateString, validateText, validateVector2 } from "../validators.ts";
import { AVItem } from "./av_item.ts";
import { FootageItem } from "./footage.ts";
import type { FolderItem } from "./folder.ts";
import type { RendererOptions } from "./renderer_options/index.ts";
import type { Project } from "../project.ts";
import type { MarkerValue } from "../properties/marker.ts";

const _item = deferred<typeof import("../../parsers/item.ts")>("py_aep/parsers/item");
import { parseLayer } from "../../parsers/layer.ts";
import { rendererOptionsFor } from "./renderer_options/index.ts";
import { SettingsView, type SettingValue } from "../renderqueue/settings.ts";
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

export const _validateRenderer = validateOneOf([..._RENDERER_EXTENDSCRIPT_TO_BINARY.keys()]);

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
   * frame rate (`frameGrid`), as AE derives it on open. The stored 16.16
   * rate only approximates the grid's rate (29.970001220703125 for 23976 /
   * 800), so comp times snap to the grid, never to the 16.16 value.
   */
  return frameGrid(cdta.frameRate);
}

export function _gridRate(cdta: CdtaChunk): number {
  /** Frames per second of the composition's frame grid. */
  const [timebase, unitsPerFrame] = _grid(cdta);
  return timebase / unitsPerFrame;
}

// NOTE(port): exact bigint arithmetic, identical to Python's Fraction. These two helpers are the
// exact rational `math.ceil` / `math.floor` over `num / den` (den > 0) that the
// Python code takes of `Fraction` expressions.
export function _ceilRatio(num: bigint, den: bigint): number {
  const q = num / den;
  return Number(num % den !== 0n && num > 0n ? q + 1n : q);
}

export function _floorRatio(num: bigint, den: bigint): number {
  const q = num / den;
  return Number(num % den !== 0n && num < 0n ? q - 1n : q);
}

/** `math.ceil(k * Fraction(*_grid(cdta)))` */
export function _ceilKGrid(k: number, cdta: CdtaChunk): number {
  const [timebase, unitsPerFrame] = _grid(cdta);
  return _ceilRatio(BigInt(k) * BigInt(timebase), BigInt(unitsPerFrame));
}

/** `math.floor(k * Fraction(*_grid(cdta)))` */
export function _floorKGrid(k: number, cdta: CdtaChunk): number {
  const [timebase, unitsPerFrame] = _grid(cdta);
  return _floorRatio(BigInt(k) * BigInt(timebase), BigInt(unitsPerFrame));
}

// NOTE(port): exact bigint arithmetic, identical to Python's Fraction; exact `Fraction(n, d) * k >= rhs` for d > 0.
export function _ratioScaledGe(n: number, d: number, k: number, rhs: number): boolean {
  return BigInt(n) * BigInt(k) >= BigInt(rhs) * BigInt(d);
}

export function _frameNumber(cdta: CdtaChunk, dividend: number, divisor: number): number {
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
  const [timebase, unitsPerFrame] = _grid(cdta);
  // NOTE(port): Python's `Fraction(dividend, divisor) * timebase / units_per_frame`,
  // kept exact as a bigint numerator / denominator.
  let n = BigInt(dividend) * BigInt(timebase);
  let d = BigInt(divisor) * BigInt(unitsPerFrame);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const framesNonneg = n >= 0n;
  let magN = n < 0n ? -n : n;
  if (timebase === _NTSC_TIMEBASE) {
    // magnitude -= _NTSC_FRAME_TOLERANCE
    magN = magN * _NTSC_FRAME_TOLERANCE.d - _NTSC_FRAME_TOLERANCE.n * d;
    d = d * _NTSC_FRAME_TOLERANCE.d;
  }
  const whole = Math.max(_ceilRatio(magN, d), 0);
  // `0 - whole`, not `-whole`: frame 0 stays +0.
  return framesNonneg ? whole : 0 - whole;
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
export function _materializeLayer(layer: Layer): void {
  const camLight = ["ADBE Camera Layer", "ADBE Light Layer"].includes(layer.matchName);

  function _materializeProp(prop: Property, inTransform: boolean): void {
    if (camLight && inTransform) {
      if (!_CAMERA_LIGHT_TRANSFORM_SKIP.has(prop.matchName)) {
        prop._ensureMaterialized();
      }
    } else if (prop._tdb4.hasTimeBase) {
      prop._ensureMaterialized();
    }
  }

  function _materializeTree(group: PropertyGroup): void {
    group._ensureMaterialized();
    const inTransform = group.matchName === "ADBE Transform Group";
    // Deliberately the raw list, NOT `group.properties`: the public
    // accessor would run the group's deferred child synthesis, and this
    // walk would then materialize children AE leaves out. Measured on a
    // five-layer new project: 60 extra tdb4 chunks, +23 KB.
    for (const child of group._properties) {
      if (child instanceof PropertyGroup) {
        if (_OMITTED_EMPTY_GROUPS.has(child.matchName) && !child.properties?.length) {
          continue;
        }
        _materializeTree(child);
      } else if (child instanceof Property) {
        _materializeProp(child, inTransform);
      }
    }
  }

  const aeMajor = getAeVersionMajor(layer);
  // Groups the project's release does not write for a new layer (they
  // stay synthesized, as when reading that release's own files).
  const unwritten = new Set<string>(
    _VERSION_GATED_GROUPS.filter(([, part]) => !aeWrites(part, aeMajor)).map(
      ([matchName]) => matchName,
    ),
  );

  for (const top of layer.properties) {
    if (top instanceof PropertyGroup) {
      if (unwritten.has(top.matchName)) {
        continue;
      }
      if (_OMITTED_EMPTY_GROUPS.has(top.matchName) && !top.properties?.length) {
        continue;
      }
      _materializeTree(top);
    } else if (top instanceof Property) {
      _materializeProp(top, false);
    }
  }

  // AE writes the `ADBE Layer Source Alternate` leaf (with its blsv/blsi
  // skeleton) inside Source Options for every new layer. `_materializeTree`
  // iterates raw `_properties` and so never triggers that group's deferred
  // child synthesis, so materialize the leaf explicitly here.
  for (const top of layer.properties) {
    if (
      top instanceof PropertyGroup &&
      top.matchName === "ADBE Source Options Group" &&
      !unwritten.has(top.matchName)
    ) {
      for (const child of top.properties) {
        if (child.matchName === "ADBE Layer Source Alternate" && child instanceof Property) {
          if (aeWrites("source alternate value", aeMajor)) {
            child._ensureMaterialized();
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

  _insertLayerSkeletonExtras(layer);
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
export function _dropEssentialOverrides(layer: Layer): void {
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
      listTypeOf(chunks[i + 1]) === "OvG2"
    ) {
      // The group is two chunks: the OvG2 holds one CPrp per override
      // (CprC counts them), the tdgp that follows holds their values.
      chunks[i + 1] = buildOvg2();
      const values = i + 2 < chunks.length ? chunks[i + 2] : null;
      if (values instanceof ListChunk && values.listType === "tdgp") {
        const inner = values.chunks;
        const keep = inner.filter((c) => ["tdsb", "tdsn"].includes(c.chunkType));
        inner.splice(0, inner.length, ...keep, new TdmnChunk({ value: "ADBE Group End" }));
      }
      break;
    }
  }
  layer.essentialPropertyUuids.length = 0;
  for (const child of layer.properties) {
    if (child.matchName === "ADBE Layer Overrides") {
      if (!(child instanceof PropertyGroup)) throw new AttributeError(`'${typeName(child)}' object has no attribute 'properties'`);
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
export function _insertLayerSkeletonExtras(layer: Layer): void {
  const root = layer._tdgp;
  if (root == null) {
    return;
  }

  function hasFollowing(chunks: Chunk[], i: number, kind: string): boolean {
    const nxt = i + 1 < chunks.length ? chunks[i + 1] : null;
    return (nxt instanceof ListChunk ? nxt.listType : nxt?.chunkType ?? null) === kind;
  }

  const chunks = root.chunks;
  for (const [i, ch] of chunks.entries()) {
    if (
      ch instanceof TdmnChunk &&
      ch.value === "ADBE Layer Overrides" &&
      !hasFollowing(chunks, i, "OvG2")
    ) {
      chunks.splice(i + 1, 0, buildOvg2());
      break;
    }
  }
  for (const [i, ch] of chunks.entries()) {
    const next = i + 1 < chunks.length ? chunks[i + 1] : null;
    if (
      ch instanceof TdmnChunk &&
      ch.value === "ADBE Source Options Group" &&
      next instanceof ListChunk &&
      next.listType === "tdgp"
    ) {
      const inner = next.chunks;
      for (const [j, c] of inner.entries()) {
        if (
          c instanceof TdmnChunk &&
          c.value === "ADBE Layer Source Alternate" &&
          !hasFollowing(inner, j, "blsv")
        ) {
          inner.splice(j + 1, 0, ...buildSourceAlternateExtras());
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
export function _rewriteEgIdentity(
  clonedItem: ListChunk,
  oldCompId: number,
  newCompId: number,
  idMap: Map<number, number>,
): void {
  const uuidMap: Map<string, string> = new Map();
  for (const cif of clonedItem.chunks) {
    if (
      !(cif instanceof ListChunk) ||
      !["CIFO", "CIF2", "CIF3"].includes(cif.listType)
    ) {
      continue;
    }
    for (const cctl of filterByListType(cif.chunks, "CCtl")) {
      const utf8s = filterByType(cctl.chunks, "Utf8");
      if (utf8s?.length > 0) {
        const uuidUtf8 = utf8s[0];
        if (!uuidMap.has(uuidUtf8.value)) {
          uuidMap.set(uuidUtf8.value, uuid4());
        }
        uuidUtf8.value = getitem(uuidMap, uuidUtf8.value);
      }
      for (const chunk of cctl.chunks) {
        // AE zeroes the controller's cached value/default in the
        // duplicate and re-derives them from the source property
        // (probed in AE 2026 on a slider controller).
        if (["CVal", "CDef"].includes(chunk.chunkType) && chunk.data?.length > 0) {
          chunk.data = bytes_.repeat(b("\x00"), chunk.data.length);
        }
      }
      const cprp = findByListTypeOrNull(cctl.chunks, "CPrp");
      if (cprp === null) continue;
      for (const ccid of filterByType(cprp.chunks, "CCId")) {
        if (ccid.value === oldCompId) {
          ccid.value = newCompId;
        }
      }
      for (const clid of filterByType(cprp.chunks, "CLId")) {
        if (idMap.has(clid.value)) {
          clid.value = getitem(idMap, clid.value);
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
  threeDModel: ThreeDModelLayer[];
  parametricMesh: ParametricMeshLayer[];
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
 * console.log(comp.frameRate);
 * for (const layer of comp) {
 *   // ...
 * }
 * ```
 * @see https://ae-scripting.docsforadobe.dev/item/compitem/
 */
export class CompItem extends AVItem {
  declare ["constructor"]: ClassAttributes<typeof CompItem>;
  static _autoName: string = "Comp";

  /** The background color of the composition. The three array values specify
   * the red, green, and blue components of the color. Read / Write. */
  declare bgColor: number[];

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
  declare frameBlending: boolean;

  /** When `true`, only layers with `shy` set to `false` are shown in the
   * Timeline panel. When `false`, all layers are visible, including those
   * whose `shy` value is `true`. Corresponds to the value of the Hide All
   * Shy Layers button in the Composition panel. Read / Write. */
  declare hideShyLayers: boolean;

  /** When `true`, motion blur is enabled for the composition. Corresponds
   * to the value of the Motion Blur button in the Composition panel.
   * Read / Write. */
  declare motionBlur: boolean;

  /** When `true`, the frame rate of nested compositions is preserved in
   * the current composition. Corresponds to the value of the "Preserve frame
   * rate when nested or in render queue" option in the Advanced tab of the
   * Composition Settings dialog box. Read / Write. */
  declare preserveNestedFrameRate: boolean;

  /** When `true`, the resolution of nested compositions is preserved in
   * the current composition. Corresponds to the value of the "Preserve
   * Resolution When Nested" option in the Advanced tab of the Composition
   * Settings dialog box. Read / Write. */
  declare preserveNestedResolution: boolean;

  // Left-out camera and light properties follow the comp's size and pixel
  // aspect. Building them before a change builds them at the size the file
  // has, so `save` writes the ones the change moves where they were, as AE
  // does.

  /** The width of the item in pixels. Read / Write. */
  declare width: number;

  /** The height of the item in pixels. Read / Write. */
  declare height: number;

  /** The shutter angle setting for the composition. This corresponds to the
   * Shutter Angle setting in the Advanced tab of the Composition Settings
   * dialog box. Read / Write. */
  declare shutterAngle: number;

  /** The shutter phase setting for the composition. This corresponds to the
   * Shutter Phase setting in the Advanced tab of the Composition Settings
   * dialog box. Read / Write. */
  declare shutterPhase: number;

  /** The x and y downsample resolution factors for rendering the
   * composition. The two values in the array specify how many pixels to skip
   * when sampling; the first number controls horizontal sampling, the second
   * controls vertical sampling. Full resolution is [1, 1], half resolution
   * is [2, 2], and quarter resolution is [4, 4]. The default is [1, 1].
   * Read / Write. */
  declare resolutionFactor: number[];

  /**
   * The maximum number of motion blur samples of 2D layer motion. This
   * corresponds to the Adaptive Sample Limit setting in the Advanced tab of
   * the Composition Settings dialog box. Must be \>= `samples_per_frame`.
   * Read / Write. 
   */
  declare motionBlurAdaptiveSampleLimit: number;

  /** The minimum number of motion blur samples per frame for Classic 3D
   * layers, shape layers, and certain effects. This corresponds to the
   * Samples Per Frame setting in the Advanced tab of the Composition
   * Settings dialog box. Read / Write. */
  declare motionBlurSamplesPerFrame: number;

  /** The frame rate of the item in frames-per-second. Read / Write.
   *
   * Writing also rewrites the composition's internal timebase, and with
   * it every keyframe time in the composition. After Effects keeps
   * keyframe times fixed in *seconds* across a frame-rate change and
   * stores them as an integer count of `internalTimebase` units, so the
   * stored counts are rescaled to match. Composition duration, work area
   * and current time are requantized onto the new frame grid; layer
   * timing and nested compositions are left untouched.
   */
  get frameRate(): number {
    return this._cdta.frameRate;
  }

  set frameRate(value: number) {
    validateCompFrameRate(value);
    const cdta = this._cdta;
    if (cdta.frameRate === value) {
      // A no-op write must stay a no-op: retiming an already-consistent
      // comp would requantize timings that are legitimately off-grid.
      return;
    }
    const oldTimebase = cdta.internalTimebase;
    // Writing frame_rate also rewrites internal_timebase and time_scale
    // (CdtaChunk._update_timebase), so capture the old base first.
    cdta.frameRate = value;
    this._retimeToTimebase(oldTimebase, cdta.internalTimebase);
    this._requantizeCompTiming();
  }

  *_walkProperties(): Generator<Property> {
    /**
     * Every `Property` under this comp's layers, plus its markers.
     *
     * Deliberately does not descend into a precomp layer's source item:
     * changing this composition's frame rate leaves nested compositions
     * alone (measured on AE 2026).
     */
    for (const layer of this.layers) {
      yield* layer._leafProperties();
    }
    // Through the property: the comp's markers are parsed on first access.
    if (this.markerProperty != null) {
      yield this.markerProperty;
    }
  }

  _retimeToTimebase(old: number, new_: number): void {
    /**
     * Rescale keyframe times and restamp per-property timebases.
     *
     * `seconds = time_units / internal_timebase`, so holding a keyframe at
     * the same time in seconds means scaling its stored unit count by
     * `new / old`. That ratio is 1 whenever only `timeScale` moved - the
     * whole NTSC family, and 30 \<-\> 60 - but the frame rate cached on each
     * `Keyframe` still has to be refreshed, because `frameTime` is derived
     * from it.
     *
     * Every property's `tdb4` also carries the comp's timebase, and AE
     * rejects a file whose copy is wrong ("zero denominator converting
     * ratio denominators").
     *
     * A stretched layer's ticks count against its own timebase
     * (`layerTimebase`), so they scale by that ratio instead: 1 for a
     * layer at the 115200 cap. A tie rounds up. Both measured on AE 2026
     * going from 24 to 25 fps: ticks 12 and -84 became 13 and -87, and a
     * 500 % layer's ticks did not move.
     */
    const rescale = new_ !== old && old > 0;
    const frameRate = this._cdta.frameRate;
    for (const prop of this._walkProperties()) {
      if (prop._isLive()) {
        prop._ensureTimeBase();
      }
      let propOld = 0;
      let propNew = 0;
      if (rescale) {
        const stretch = prop._timeStretch;
        propOld = layerTimebase(old, stretch);
        propNew = layerTimebase(new_, stretch);
      }
      for (const keyframe of prop.keyframes) {
        if (propOld !== propNew) {
          const item = keyframe._ldatItem;
          item.timeUnits = rescaleTicks(item.timeUnits, propOld, propNew);
        }
        keyframe._frameRate = frameRate;
      }
    }
  }

  _requantizeCompTiming(): void {
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
     * the comp (`_keepTimesInside`). Measured on AE 2026. Display start
     * and layer in / out / start times are not requantized.
     */
    const cdta = this._cdta;
    const [timebase, unitsPerFrame] = _grid(cdta);
    // The work area's end reads through its start and the duration, so
    // take it in seconds before either is rewritten. 0xFFFFFFFF means
    // "the work area runs to the end of the comp": that end already
    // follows `duration`, and writing one would pin it.
    const runsToEnd = cdta.workAreaEndDividend === WORK_AREA_TO_END;
    const workAreaEnd = cdta.workAreaStart + cdta.workAreaDuration;

    cdta.durationDividend = _durationUnits(cdta.duration, timebase, unitsPerFrame);
    cdta.durationDivisor = timebase;
    this._restoreTimesInTimebase();
    if (!runsToEnd) {
      cdta.workAreaEndDividend = _frameUnits(workAreaEnd, timebase, unitsPerFrame);
      cdta.workAreaEndDivisor = timebase;
    }
    this._keepTimesInside();
  }

  _keepTimesInside(): void {
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
    const [timebase, unitsPerFrame] = _grid(cdta);
    const endOfComp = round(cdta.duration * timebase);
    const lastFrame = endOfComp - unitsPerFrame;
    if (cdta.timeDividend > lastFrame) {
      cdta.timeDividend = lastFrame;
    }
    if (cdta.workAreaStartDividend > lastFrame) {
      cdta.workAreaStartDividend = lastFrame;
      cdta.workAreaEndDividend = WORK_AREA_TO_END;
    } else if (
      cdta.workAreaEndDividend !== WORK_AREA_TO_END &&
      _ratioScaledGe(
        cdta.workAreaEndDividend,
        cdta.workAreaEndDivisor,
        timebase,
        endOfComp,
      )
    ) {
      cdta.workAreaEndDividend = WORK_AREA_TO_END;
      cdta.workAreaEndDivisor = timebase;
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
    validateCompDuration(value);
    const cdta = this._cdta;
    const [timebase, unitsPerFrame] = _grid(cdta);
    cdta.durationDividend = _durationUnits(value, timebase, unitsPerFrame);
    cdta.durationDivisor = timebase;
    // AE also re-stores the time and work-area start over the timebase
    // on a duration write (a 0/600 time becomes 0/24576 at 24 fps).
    this._restoreTimesInTimebase();
    this._keepTimesInside();
  }

  /** The duration of the item in frames. Read / Write. */
  get frameDuration(): number {
    return this._cdta.frameDuration;
  }

  set frameDuration(value: number) {
    _validateNumber({ min: 1, integer: true })(value);
    this.duration = value / _gridRate(this._cdta);
  }

  /** The pixel aspect ratio of the item (1.0 is square). Read / Write. */
  declare pixelAspect: number;

  /** The time scale, used as a divisor for keyframe time values. Read-only. */
  declare timeScale: number;

  /** The time set as the beginning of the composition, in seconds. This
   * is the equivalent of the Start Timecode or Start Frame setting in the
   * Composition Settings dialog box. Read / Write. */
  declare displayStartTime: number;

  /** The frame value of the beginning of the composition. Read / Write. */
  get displayStartFrame(): number {
    const cdta = this._cdta;
    return _frameNumber(
      cdta,
      cdta.displayStartTimeDividend,
      cdta.displayStartTimeDivisor,
    );
  }

  set displayStartFrame(value: number) {
    // AE 2026 accepts the frames from -10800 s to 86340 s (at 24 fps
    // -259200 to 2072160, at 29.97 -323676 to 2587609), although its
    // `displayStartTime` goes on to 86400 s.
    _validateNumber({
      min: (self: CompItem) => _ceilKGrid(-10800, self._cdta),
      max: (self: CompItem) => _floorKGrid(86340, self._cdta),
      integer: true,
    })(value, this);
    const cdta = this._cdta;
    const [timebase, unitsPerFrame] = _grid(cdta);
    // AE stores a start frame as whole timebase units (13 frames at 24 fps
    // is 13312/24576); past the signed 32-bit range, as a plain ratio.
    const units = value * unitsPerFrame;
    if (-(2 ** 31) <= units && units < 2 ** 31) {
      cdta.displayStartTimeDividend = units;
      cdta.displayStartTimeDivisor = timebase;
    } else {
      cdta.displayStartTime = units / timebase;
    }
    this._restoreTimesInTimebase();
  }

  _restoreTimesInTimebase(): void {
    /**
     * AE re-stores the work area start and the current time in whole
     * timebase units whenever the display start changes (AE 2026: a new
     * comp's `0/600` start becomes `0/24576` at 24 fps).
     */
    const cdta = this._cdta;
    const [timebase, unitsPerFrame] = _grid(cdta);
    cdta.workAreaStartDividend = _frameUnits(cdta.workAreaStart, timebase, unitsPerFrame);
    cdta.workAreaStartDivisor = timebase;
    cdta.timeDividend = _frameUnits(cdta.timeSeconds, timebase, unitsPerFrame);
    cdta.timeDivisor = timebase;
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
  get workAreaStart(): number {
    return this._cdta.workAreaStart;
  }

  set workAreaStart(value: number) {
    _validateNumber({
      min: 0.0,
      max: (self: CompItem) => self.duration - 1 / self.frameRate,
    })(value, this);
    const runsToEnd = this._cdta.workAreaEndDividend === WORK_AREA_TO_END;
    this._setWorkArea(value, runsToEnd ? null : value + this.workAreaDuration);
  }

  /** The work area start frame relative to composition start.
   * Read / Write. */
  get workAreaStartFrame(): number {
    const cdta = this._cdta;
    return _frameNumber(cdta, cdta.workAreaStartDividend, cdta.workAreaStartDivisor);
  }

  set workAreaStartFrame(value: number) {
    _validateNumber({
      min: 0,
      max: (self: CompItem) => self.frameDuration - 1,
      integer: true,
    })(value, this);
    this.workAreaStart = value / _gridRate(this._cdta);
  }

  /**
   * The work area duration in seconds. Read / Write.
   *
   * Writing snaps the end of the work area to the nearest frame, half a
   * frame rounding up, as After Effects does.
   */
  get workAreaDuration(): number {
    return this._cdta.workAreaDuration;
  }

  set workAreaDuration(value: number) {
    _validateNumber({
      min: (self: CompItem) => 1 / self.frameRate,
      max: (self: CompItem) => self.duration - self.workAreaStart,
    })(value, this);
    const start = this.workAreaStart;
    this._setWorkArea(start, start + value);
  }

  /** The work area duration in frames. Read / Write. */
  get workAreaDurationFrame(): number {
    return this._cdta.workAreaDurationFrame;
  }

  set workAreaDurationFrame(value: number) {
    _validateNumber({
      min: 1,
      max: (self: CompItem) => self.frameDuration - self.workAreaStartFrame,
      integer: true,
    })(value, this);
    this.workAreaDuration = value / _gridRate(this._cdta);
  }

  _setWorkArea(start: number, end: number | null): void {
    /**
     * Store the work area the way AE's setters do: in whole timebase
     * units, snapped to frames, and with an end at or past the end of the
     * composition (or `null`) stored as "runs to the end".
     */
    const cdta = this._cdta;
    const [timebase, unitsPerFrame] = _grid(cdta);
    cdta.workAreaStartDividend = _frameUnits(start, timebase, unitsPerFrame);
    cdta.workAreaStartDivisor = timebase;
    let endUnits: number | null =
      end == null ? null : _frameUnits(end, timebase, unitsPerFrame);
    if (endUnits == null || endUnits >= round(cdta.duration * timebase)) {
      endUnits = WORK_AREA_TO_END;
    }
    cdta.workAreaEndDividend = endUnits;
    cdta.workAreaEndDivisor = timebase;
  }

  /**
   * The current time of the item when it is being previewed directly
   * from the Project panel. This value is a number of seconds. It is an
   * error to set this value for a {@link FootageItem} whose `mainSource` is
   * still. Read / Write.
   *
   * Writing snaps the value to the nearest frame, half a frame rounding
   * up, as After Effects does, which accepts 0 to 10800 seconds whatever
   * the display start time.
   */
  get time(): number {
    return this._cdta.timeSeconds;
  }

  set time(value: number) {
    _validateNumber({ min: 0.0, max: 10800.0 })(value);
    const cdta = this._cdta;
    const [timebase, unitsPerFrame] = _grid(cdta);
    cdta.timeDividend = _frameUnits(value, timebase, unitsPerFrame);
    cdta.timeDivisor = timebase;
  }

  /**
   * The current time of the item when it is being previewed directly
   * from the Project panel. This value is a number of frames.
   * Read / Write.
   */
  get frameTime(): number {
    const cdta = this._cdta;
    return _frameNumber(cdta, cdta.timeDividend, cdta.timeDivisor);
  }

  set frameTime(value: number) {
    // The frames `time`'s 0 to 10800 s range holds.
    _validateNumber({
      min: 0,
      max: (self: CompItem) => Math.floor(10800 * _gridRate(self._cdta)),
      integer: true,
    })(value, this);
    this.time = value / _gridRate(this._cdta);
  }

  /**
   * When `true`, timecode is displayed in drop-frame format. Only
   * applicable when `frameRate` is 29.97 or 59.94. Read / Write.
   */
  declare dropFrame: boolean;

  static _new(
    name: string,
    width: number,
    height: number,
    pixelAspect: number,
    duration: number,
    frameRate: number,
    kw: { project: Project; parentFolder: FolderItem; minDimension?: number },
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
    const { project, parentFolder, minDimension = 4 } = kw;
    validateString(name);
    const validateSize = _validateNumber({ min: minDimension, max: 30000, integer: true });
    validateSize(width);
    validateSize(height);
    validatePixelAspect(pixelAspect);
    validateCompDuration(duration);
    validateCompFrameRate(frameRate);

    const newId = project._allocateId();
    const aeMajor = project._head.aeVersionMajor;

    // AE hard-crashes opening a comp item without the full view-state
    // skeleton (~180 chunks of viewer pseudo-layers and panel state),
    // so the whole item is built by the typed skeleton builder.
    const [itemList, idta, nameUtf8, gide] = buildNewCompItem({
      itemId: newId,
      name,
      width,
      height,
      pixelAspect,
      duration,
      frameRate,
      allocateLayerId: project._allocateId.bind(project),
      aeMajor,
      label: labelIndex(project._preferences, "Comp Label Index 2", 15),
    });

    // View data chunks that AE expects after every comp's LIST:Item
    const fee = new ListChunk({
      listType: "FEE ",
      chunks: aeWrites("ppSn", aeMajor) ? [new F8Chunk({ chunkType: "ppSn" })] : [],
    });
    const viewData: Chunk[] = [fee, ...buildItemViewChunks()];

    const comp = new this({
      _childChunks: itemList.chunks,
      _cmta: null,
      _idta: idta,
      _itemList: itemList,
      _gide: gide,
      _pinChunks: [],
      _nameUtf8: nameUtf8,
      project,
      parentFolder,
      effectParamDefs: project._effectParamDefs,
      proxySource: null,
    });
    comp._viewData = viewData;
    return comp;
  }

  declare _layers: Layer[];
  declare _layersById: Map<number, Layer> | null;
  declare _layerTypes: LayerTypeCache | null;
  declare _layerIndexById: Map<number, number> | null;
  declare _cdta: CdtaChunk;
  declare _cdrp: U1Chunk | null;
  declare prinList: ListChunk;
  declare _prin: PrinChunk;
  declare _prda: PrdaChunk;
  declare _deferredLayers: [ListChunk[], EffectParamDefs] | null;
  declare _layersLoaded: boolean;
  declare _deferredChildChunks: Chunk[] | null;
  declare _markerProperty: Property<MarkerValue | null> | null;
  declare _egTemplateNameUtf8: Utf8Chunk | null;
  declare _egControllers: EssentialGraphicsController[];
  declare _viewData: Chunk[];

  constructor(kw: {
    _childChunks: Chunk[];
    _cmta: CmtaChunk | null;
    _idta: IdtaChunk;
    _itemList: ListChunk;
    _gide: ListChunk | null;
    _pinChunks: ListChunk[];
    _nameUtf8: Utf8Chunk;
    project: Project;
    parentFolder: FolderItem;
    effectParamDefs: EffectParamDefs;
    proxySource: FileSource | SolidSource | PlaceholderSource | null;
  }) {
    // Skip AVItem's extra params - they're all descriptor-backed on
    // CompItem and read directly from the cdta chunk body.
    super({
      _idta: kw._idta,
      _nameUtf8: kw._nameUtf8,
      _cmta: kw._cmta,
      _itemList: kw._itemList,
      _gide: kw._gide,
      _pinChunks: kw._pinChunks,
      project: kw.project,
      parentFolder: kw.parentFolder,
      typeName: "Composition",
      proxySource: kw.proxySource,
    });

    this._layers = [];
    this._layersById = null;
    this._layerTypes = null;
    this._layerIndexById = null;

    this._cdta = findByType(kw._childChunks, "cdta");
    this._cdrp = findByTypeOrNull(kw._childChunks, "cdrp");
    this.prinList = findByListType(kw._childChunks, "PRin");
    this._prin = findByType(this.prinList.chunks, "prin");
    this._prda = findByType(this.prinList.chunks, "prda");

    // Layer deferral: collect layer chunks and source IDs now, parse
    // the actual Layer objects on first access via _ensure_layers_loaded.
    const layerChunks = filterByListType(kw._childChunks, "Layr");
    if (layerChunks?.length > 0) {
      this._deferredLayers = [layerChunks, kw.effectParamDefs];
      this._layersLoaded = false;
    } else {
      this._deferredLayers = null;
      this._layersLoaded = true;
    }

    // Deferred markers + Essential Graphics parsing.
    this._deferredChildChunks = kw._childChunks;
    this._markerProperty = null;
    this._egTemplateNameUtf8 = null;
    this._egControllers = [];
    this._viewData = [];
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
    const rq = this._project.renderQueue;
    pyAssert(rq != null);
    const compId = this.id;
    for (const rqi of [...rq.items]) {
      if (rqi.comp === this) {
        // Full chunk-level removal keeps rs_ldat/Rout/LItm bookkeeping
        // in sync; a model-list drop alone would orphan its chunks.
        rqi.remove();
        continue;
      }
      for (const om of rqi.outputModules) {
        if (om._omLdat.postRenderTargetCompId === compId) {
          om._omLdat.postRenderTargetCompId = 0;
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
    const parent = this._parentFolder;
    pyAssert(parent != null);
    const container = parent._childrenContainer;

    // Clone the comp's whole block: LIST:Item + trailing view chunks.
    const [start, end] = blockSlice(
      container,
      this._itemList,
      this.constructor._ITEM_BOUNDARY_LIST_TYPES,
    );
    // The block starts at this comp's own LIST:Item.
    const clonedItem = cloneChunkTree(this._itemList);
    const clonedBlock = [clonedItem, ...container.slice(start + 1, end).map((c) => cloneChunkTree(c))];

    const oldCompId = this.id;
    const newCompId = project._allocateId();
    // Pre-2020 files have no iide; the id then lives only in idta.
    const iide = findByTypeOrNull(clonedItem.chunks, "iide");
    if (iide !== null) iide.value = newCompId;
    findByType(clonedItem.chunks, "idta").itemId = newCompId;

    // Fresh ids for every ldta - real layers AND viewer pseudo-layers,
    // AE reallocates them all - then remap every intra-comp layer
    // reference. Ids not in the map (0 / stale) stay untouched, and
    // source_id is deliberately kept: footage and precomp sources are
    // shared with the original.
    const ldtaChunks = recursiveFind(clonedItem.chunks, "ldta");
    const idMap: Map<number, number> = new Map();
    for (const ldta of ldtaChunks) {
      idMap.set(ldta.layerId, project._allocateId());
    }
    for (const ldta of ldtaChunks) {
      ldta.layerId = getitem(idMap, ldta.layerId);
      if (idMap.has(ldta.parentId)) {
        ldta.parentId = getitem(idMap, ldta.parentId);
      }
      // matte_layer_id is absent (None) in pre-AE23 files.
      const matte = ldta.matteLayerId;
      const newMatte = matte == null ? undefined : idMap.get(matte);
      if (newMatte !== undefined) {
        ldta.matteLayerId = newMatte;
      }
    }
    // tdpi layer references: the effect owner (hidden -0000 param) and
    // effect layer parameters (e.g. Set Matte's source layer) - both
    // can only point at layers of this comp.
    for (const tdpi of recursiveFind(clonedItem.chunks, "tdpi")) {
      const newValue = idMap.get(tdpi.value);
      if (newValue !== undefined) {
        tdpi.value = newValue;
      }
    }

    _rewriteEgIdentity(clonedItem, oldCompId, newCompId, idMap);

    // Name (the item block's first direct Utf8), numbered like AE.
    const existing = new Set([...project.items.values()].map((item) => item.name));
    findByType(clonedItem.chunks, "Utf8").value = autoName(this.name, existing);

    // AE parks the duplicate's current time at 0 (AE 2026: a copy of a
    // comp whose time is 2.5 s reads time 0).
    const cdta = findByType(clonedItem.chunks, "cdta");
    cdta.timeDividend = 0;
    cdta.timeDivisor = 600;

    // Insert right after the original's block, then build the model
    // through the normal parse path (registers it in project.items).
    container.splice(end, 0, ...clonedBlock);
    const newComp = _item().parseItem(clonedItem, project, parent);
    // The clone keeps this comp's idta item type.
    pyAssert(newComp instanceof CompItem);
    parent.items.splice(parent.items.indexOf(this) + 1, 0, newComp);

    // Register the duplicate on its layer sources' used_in if linking
    // already ran (the lazy pass covers it otherwise).
    if (project._usedInLinked) {
      for (const sourceId of newComp._sourceIdsForLinking()) {
        const source = project.items.get(sourceId) ?? null;
        if (source instanceof AVItem) {
          source._usedIn.add(newComp);
        }
      }
    }

    return newComp;
  }

  _sourceIdsForLinking(): Set<number> {
    /** Return source IDs for `_usedIn` linking without forcing layer parse. */
    const deferred = this._deferredLayers;
    if (deferred != null) {
      const sourceIds: Set<number> = new Set();
      for (const lc of deferred[0]) {
        if (lc instanceof DeferredListChunk && lc._parsedChunks == null) {
          const raw = lc._rawBody;
          if (
            raw.length >= _LDTA_SOURCE_ID_END &&
            bytesEq(bytes_.slice(raw, 0, 4), b("ldta"))
          ) {
            const sid = bytes_.intFromBytes(
              bytes_.slice(raw, _LDTA_SOURCE_ID_OFFSET, _LDTA_SOURCE_ID_END),
              "big",
            );
            if (sid !== 0) {
              sourceIds.add(sid);
            }
          }
        } else {
          const ldta = findByTypeOrNull(lc.chunks, "ldta");
          if (ldta === null) continue;
          if (ldta.sourceId !== 0) {
            sourceIds.add(ldta.sourceId);
          }
        }
      }
      return sourceIds;
    }

    const out: Set<number> = new Set();
    for (const layer of this._layers) {
      if (layer instanceof AVLayer && layer._sourceId !== 0) {
        out.add(layer._sourceId);
      }
    }
    return out;
  }

  _ensureLayersLoaded(): void {
    /** Parse deferred `LIST:Layr` chunks on first layer access. */
    if (this._layersLoaded) {
      return;
    }

    const deferred = this._deferredLayers;
    pyAssert(deferred != null);

    // Clear deferred state first to avoid duplicate work if any nested
    // access re-enters this method.
    const [layerChunks, deferredEffectParamDefs] = deferred;
    this._deferredLayers = null;

    let effectParamDefs: EffectParamDefs;
    if (deferredEffectParamDefs?.size > 0) {
      effectParamDefs = deferredEffectParamDefs;
    } else if (this._project != null) {
      effectParamDefs = this._project._effectParamDefs;
    } else {
      effectParamDefs = new Map();
    }

    const parsedLayers: Layer[] = [];
    for (const layerChunk of layerChunks) {
      parsedLayers.push(parseLayer(layerChunk, this, effectParamDefs));
    }

    this._layers = parsedLayers;

    this._layersLoaded = true;
    this._invalidateLayerCache();
  }

  /**
   * Build the property trees of the layers whose left-out defaults
   * follow this comp (see `width`).
   */
  _buildLiveDefaults(): void {
    this._ensureLayersLoaded();
    for (const layer of this._layers) {
      if (layer._treeParamDefs != null && layer._leavesOutLiveDefaults()) {
        layer._loadPropertyTree();
      }
    }
  }

  _ensureCompParsed(): void {
    /** Parse markers and Essential Graphics on first access. */
    if (this._deferredChildChunks == null) {
      return;
    }

    const childChunks = this._deferredChildChunks;
    this._deferredChildChunks = null;

    this._markerProperty = _composition()._getMarkers(childChunks, this);
    const egResult = parseEssentialGraphics(childChunks);
    if (egResult != null) {
      this._egTemplateNameUtf8 = egResult[0];
      this._egControllers = [...egResult[1]];
    }
  }

  _buildTypeCache(): LayerTypeCache {
    const av: AVLayer[] = [];
    const text: TextLayer[] = [];
    const shape: ShapeLayer[] = [];
    const camera: CameraLayer[] = [];
    const light: LightLayer[] = [];
    const threeDModel: ThreeDModelLayer[] = [];
    const parametricMesh: ParametricMeshLayer[] = [];
    const byId: Map<number, Layer> = new Map();
    for (const layer of this.layers) {
      byId.set(layer.id, layer);
      if (layer instanceof AVLayer) {
        av.push(layer);
        if (layer instanceof TextLayer) {
          text.push(layer);
        } else if (layer instanceof ShapeLayer) {
          shape.push(layer);
        } else if (layer instanceof ThreeDModelLayer) {
          threeDModel.push(layer);
        } else if (layer instanceof ParametricMeshLayer) {
          parametricMesh.push(layer);
        }
      } else if (layer instanceof CameraLayer) {
        camera.push(layer);
      } else if (layer instanceof LightLayer) {
        light.push(layer);
      }
    }
    this._layersById = byId;
    const cache: LayerTypeCache = {
      av,
      text,
      shape,
      camera,
      light,
      threeDModel,
      parametricMesh,
    };
    this._layerTypes = cache;
    return cache;
  }

  _invalidateLayerCache(): void {
    /** Reset layer caches after structural mutations. */
    this._layerTypes = null;
    this._layersById = null;
    this._layerIndexById = null;
  }

  _layerBlockSlice(layer: Layer): [number, number] {
    /**
     * Return `(start, end)` indices of a layer's chunk block in
     * `_item_list.chunks`.
     *
     * The block runs from the layer's `LIST:Layr` to the next boundary
     * chunk (another `LIST:Layr`, a view block, or a footer chunk).
     */
    return blockSlice(this._itemList.chunks, layer._layerList, _LAYER_BOUNDARY_TYPES);
  }

  _findFirstLayerPosition(): number {
    /** Find the insertion point for the first layer in the chunk list. */
    for (const [i, chunk] of this._itemList.chunks.entries()) {
      if (
        chunk instanceof ListChunk &&
        ["DLay", "SLay", "CLay", "SecL", "CIFO"].includes(chunk.listType)
      ) {
        return i;
      }
    }
    return this._itemList.chunks.length;
  }

  /**
   * A composition has no main-source pin, so its proxy pin is at
   * index 0 (footage items keep the main pin at 0 and the proxy at 1).
   */
  get _proxyPinIndex(): number {
    return 0;
  }

  /**
   * All the {@link Layer} objects for layers in this composition.
   * Read-only. 
   */
  get layers(): Layer[] {
    this._ensureLayersLoaded();
    return this._layers;
  }

  /** Map of layer ID to layer, for O(1) lookup by sibling layers. */
  get layersById(): Map<number, Layer> {
    if (this._layersById == null) {
      this._layersById = new Map(this.layers.map((layer) => [layer.id, layer] as const));
    }
    return this._layersById;
  }

  /** Map of layer ID to 0-based index. */
  get _layerIdToIndex(): Map<number, number> {
    if (this._layerIndexById == null) {
      this._layerIndexById = new Map(
        [...this.layers.entries()].map(([idx, layer]) => [layer.id, idx] as const),
      );
    }
    return this._layerIndexById;
  }

  /** The composition's marker property. Read-only. */
  get markerProperty(): Property<MarkerValue | null> | null {
    this._ensureCompParsed();
    return this._markerProperty;
  }

  /**
   * The name property in the Essential Graphics panel for the
   * composition. The name in the Essential Graphics panel is used
   * for the file name of an exported Motion Graphics template.
   * Read / Write.
   */
  get motionGraphicsTemplateName(): string | null {
    this._ensureCompParsed();
    if (this._egTemplateNameUtf8 == null) {
      return null;
    }
    return this._egTemplateNameUtf8.value;
  }

  // @requires_version(15) on the setter: wrapped after the class body.
  set motionGraphicsTemplateName(value: string) {
    validateName(value);
    this._ensureCompParsed();
    if (this._egTemplateNameUtf8 != null) {
      this._egTemplateNameUtf8.value = value;
    } else {
      const [cps2, utf8Chunk] = buildCps2(value);
      const cif3 = new ListChunk({
        listType: "CIF3",
        chunks: [cps2, new S4Chunk({ chunkType: "CcCt" })],
      });
      this._itemList.chunks.push(cif3);
      this._egTemplateNameUtf8 = utf8Chunk;
    }
  }

  /**
   * The Essential Graphics controllers for this composition.
   * Read-only.
   */
  get motionGraphicsControllers(): EssentialGraphicsController[] {
    this._ensureCompParsed();
    return this._egControllers;
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
  get motionGraphicsTemplateControllerCount(): number {
    return this.motionGraphicsControllers.length;
  }

  /**
   * The names of all controllers in the Essential Graphics panel.
   * Read-only. Excludes the runtime-only Group "drop zone" controller AE
   * synthesizes but does not store (see
   * `motionGraphicsTemplateControllerCount`).
   */
  get motionGraphicsTemplateControllerNames(): string[] {
    return this.motionGraphicsControllers.map((ctrl) => ctrl.name);
  }

  _cifContainers(): ListChunk[] {
    /**
     * The `CIFO`/`CIF2`/`CIF3` Essential Graphics containers of this comp,
     * in file order (every comp AE or py_aep writes has all three, except
     * AE 15's, which have no CIF3).
     */
    return this._itemList.chunks.filter(
      (c): c is ListChunk =>
        c instanceof ListChunk && ["CIFO", "CIF2", "CIF3"].includes(c.listType),
    );
  }

  _buildPropertyCctl(
    plan: PropertyControllerPlan,
    prop: Property,
    name: string,
    uuidStr: string,
  ): [ListChunk, Utf8Chunk, U4Chunk] {
    /**
     * Assemble one `LIST:CCtl` for `prop` per the resolved `plan`.
     *
     * Called once per CIF container so each holds its own chunk objects.
     */
    const compId = this.id;
    const layerId = plan.layer._ldta.layerId;
    if (plan.controllerType === CONTROLLER_SLIDER) {
      // AE seeds the EGP slider range from the pard UI slider range
      // (Slider Control -> 0..100 despite its +/-1e6 valid range,
      // Brightness -> -150..150), falling back to the valid range for
      // pard-less properties (Transform > Opacity -> 0..100).
      const minV = prop._sliderMin != null ? prop._sliderMin : prop.minValue;
      const maxV = prop._sliderMax != null ? prop._sliderMax : prop.maxValue;
      // Python's `float()` refuses a list bound (a color or multi-dimensional range).
      const floatBound = (v: number | number[]): number => {
        if (Array.isArray(v)) throw new TypeError_("float() argument must be a string or a real number, not 'list'");
        return float(v);
      };
      return buildSliderCctl(
        name,
        uuidStr,
        prop.value,
        minV != null ? floatBound(minV) : 0.0,
        maxV != null ? floatBound(maxV) : 100.0,
        compId,
        layerId,
        plan.pathJson,
      );
    }
    if (plan.controllerType === CONTROLLER_CHECKBOX) {
      return buildCheckboxCctl(
        name,
        uuidStr,
        pyBool(prop.value),
        compId,
        layerId,
        plan.pathJson,
      );
    }
    if (plan.controllerType === CONTROLLER_COLOR) {
      let rgba: number[] = prop.value;
      rgba = [...rgba, 1.0, 1.0, 1.0, 1.0].slice(0, 4);
      return buildColorCctl(name, uuidStr, rgba, compId, layerId, plan.pathJson);
    }
    const text = prop.value instanceof TextDocument ? prop.value.text : "";
    return buildTextCctl(
      name,
      uuidStr,
      text,
      fontCapsJson(prop),
      compId,
      layerId,
      plan.pathJson,
    );
  }

  _appendController(
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
    const containers = this._cifContainers();
    if (!containers?.length) {
      return null;
    }
    let model: [Utf8Chunk, U4Chunk] | null = null;
    for (const cif of containers) {
      const [cctl, nameUtf8, ctyp] = build();
      cif.chunks.push(cctl);
      const ccct = findByType(cif.chunks, "CcCt");
      ccct.value += 1;
      if (cif.listType === "CIF3" || model == null) {
        model = [nameUtf8, ctyp];
      }
    }
    return model;
  }

  _registerController(
    bound: [Utf8Chunk, U4Chunk],
    uuidStr: string,
    nodes: PathNode[],
    layer: Layer,
  ): void {
    /** Append the model for a controller just written to the containers. */
    const [nameUtf8, ctyp] = bound;
    this._egControllers.push(
      new EssentialGraphicsController({
        _nameUtf8: nameUtf8,
        _ctyp: ctyp,
        uuid: uuidStr,
        sourcePropertyPath: nodes.map(
          (node) => new SourcePropertyRef(node.matchName, node.propIndex),
        ),
        sourceCompId: this.id,
        sourceLayerId: layer._ldta.layerId,
      }),
    );
  }

  _addPropertyController(prop: Property, name: string | null): boolean {
    /**
     * Add `prop` to this comp's Essential Graphics panel.
     *
     * Returns `false` (adding nothing) when `prop` cannot be exposed - see
     * `resolvers.motion_graphics`.
     */
    this._ensureCompParsed();
    const plan = propertyControllerPlan(prop, this);
    if (plan == null) {
      return false;
    }
    const display = name != null ? name : prop.name;
    validateName(display);
    const uuidStr = uuid4();
    const bound = this._appendController(() =>
      this._buildPropertyCctl(plan, prop, display, uuidStr),
    );
    if (bound == null) {
      return false;
    }
    this._registerController(bound, uuidStr, plan.nodes, plan.layer);
    return true;
  }

  _addLayerController(layer: AVLayer, name: string | null): boolean {
    /**
     * Add `layer` to this comp's Essential Graphics panel as a Media
     * Replacement (type 14) controller.
     *
     * Returns `false` (adding nothing) when the layer is not eligible -
     * see `resolvers.motion_graphics.can_add_layer`.
     */
    this._ensureCompParsed();
    if (!canAddLayer(layer, this)) {
      return false;
    }
    const source = layer.source;
    pyAssert(source != null); // guaranteed by can_add_layer
    const display = name != null ? name : layer.name;
    validateName(display);
    const uuidStr = uuid4();
    const timebase = this._cdta.internalTimebase;
    const [nodes, pathJson] = mediaControllerPath();
    // AE names a per-controller thumbnail cache file it regenerates on
    // open; only the uuid-shaped name is stored in the project.
    const thumbnail = `${uuid4()}.png`;
    const bound = this._appendController(() =>
      buildMediaCctl(
        display,
        uuidStr,
        source.width,
        source.height,
        round(layer.inPoint * timebase),
        round(layer.outPoint * timebase),
        timebase,
        thumbnail,
        this.id,
        layer._ldta.layerId,
        pathJson,
      ),
    );
    if (bound == null) {
      return false;
    }
    this._registerController(bound, uuidStr, nodes, layer);
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
   * Read `rendererOptions` again after changing the renderer.
   */
  get renderer(): string {
    const binaryName = this._prin.matchName;
    return _RENDERER_BINARY_TO_EXTENDSCRIPT.get(binaryName) ?? binaryName;
  }

  set renderer(value: string) {
    _validateRenderer(value);
    const binaryName = getitem(_RENDERER_EXTENDSCRIPT_TO_BINARY, value);
    if (binaryName === this._prin.matchName) {
      // If comp is already set to the requested renderer,
      // preserve renderer options instead of replacing with defaults
      return;
    }
    // Otherwise update match name and display name
    this._prin.matchName = binaryName;
    this._prin.displayName = getitem(_RENDERER_DISPLAY_NAMES, binaryName);
    // Create a fresh prda chunk using requested renderer's default settings
    const newPrda = new (getitem(_PRDA_VARIANTS, binaryName)[0])();
    // Replace the existing prda chunk
    const prinChunks = this.prinList.chunks;
    prinChunks[indexByIdentity(prinChunks, this._prda)] = newPrda;
    this._prda = newPrda;
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
   * comp.rendererOptions.set("Quality", 61);
   * ```
   */
  get rendererOptions(): RendererOptions {
    return rendererOptionsFor(this._prda, this);
  }

  set rendererOptions(value: Map<string, SettingValue> | SettingsView) {
    // A Python Mapping: a dict, or another comp's renderer options view.
    if (!(value instanceof Map || value instanceof SettingsView)) {
      throw new ValueError("rendererOptions must be a mapping of key-value pairs");
    }
    const view = this.rendererOptions;
    for (const [key, option] of value instanceof Map ? value.entries() : value.items()) {
      view.set(key, option);
    }
  }

  /**
   * When `true`, the composition has an audio component.
   *
   * A composition has audio when at least one of its layers has a
   * source with audio.
   * Read-only.
   */
  get hasAudio(): boolean {
    return this.avLayers.some((layer) => layer.hasAudio);
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
    if (this.markerProperty == null) {
      return [];
    }
    return this.markerProperty.keyframes.map((kf) => kf.value);
  }

  removeAllMarkers(): void {
    /**
     * Remove all markers from this composition.
     *
     * A no-op when the composition has no markers.
     */
    if (this.markerProperty != null) {
      this.markerProperty.removeAllKeys();
    }
  }

  /** The number of layers in the composition. */
  get numLayers(): number {
    return this.layers.length;
  }

  /**
   * The front-most enabled camera layer, or `null`.
   *
   * Returns the first {@link CameraLayer} that is active at the current
   * composition time. The value is `null` when the composition
   * contains no active camera layers.
   */
  get activeCamera(): CameraLayer | null {
    for (const layer of this.cameraLayers) {
      if (layer.active) {
        return layer;
      }
    }
    return null;
  }

  layer(
    name: string | null = null,
    index: number | null = null,
    otherLayer: Layer | null = null,
    relIndex: number | null = null,
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
    } else if (otherLayer != null && otherLayer.length > 0 && relIndex != null && relIndex !== 0) {
      const otherIdx = this.layers.indexOf(otherLayer);
      if (otherIdx < 0) {
        throw new ValueError(`${repr(otherLayer)} is not in list`);
      }
      return at(this.layers, otherIdx + relIndex);
    }
    throw new ValueError("Must specify one of name, index, or otherLayer and relIndex");
  }

  /** Cached layer type lists for O(1) access. */
  get _typeCache(): LayerTypeCache {
    return this._layerTypes != null ? this._layerTypes : this._buildTypeCache();
  }

  /** An array of all {@link AVLayer} objects in this composition. */
  get avLayers(): AVLayer[] {
    return this._typeCache.av;
  }

  /** An array of the composition layers whose source are compositions. */
  get compositionLayers(): AVLayer[] {
    return this.avLayers.filter((layer) => layer.source instanceof CompItem);
  }

  /** An array of the composition layers whose source are footages. */
  get footageLayers(): AVLayer[] {
    return this.avLayers.filter((layer) => layer.source instanceof FootageItem);
  }

  /** An array of the layers whose source are file footages. */
  get fileLayers(): AVLayer[] {
    return this.footageLayers.filter(
      (layer) =>
        layer.source instanceof FootageItem &&
        layer.source.mainSource instanceof FileSource,
    );
  }

  /** An array of the layers whose source are solids. */
  get solidLayers(): AVLayer[] {
    return this.footageLayers.filter(
      (layer) =>
        layer.source instanceof FootageItem &&
        layer.source.mainSource instanceof SolidSource,
    );
  }

  /** An array of the layers whose source are placeholders. */
  get placeholderLayers(): AVLayer[] {
    return this.footageLayers.filter(
      (layer) =>
        layer.source instanceof FootageItem &&
        layer.source.mainSource instanceof PlaceholderSource,
    );
  }

  /** An array of the text layers in this composition. */
  get textLayers(): TextLayer[] {
    return this._typeCache.text;
  }

  /** An array of the shape layers in this composition. */
  get shapeLayers(): ShapeLayer[] {
    return this._typeCache.shape;
  }

  /** An array of the camera layers in this composition. */
  get cameraLayers(): CameraLayer[] {
    return this._typeCache.camera;
  }

  /** An array of the light layers in this composition. */
  get lightLayers(): LightLayer[] {
    return this._typeCache.light;
  }

  /** An array of the 3D model layers in this composition. */
  get threeDModelLayers(): ThreeDModelLayer[] {
    return this._typeCache.threeDModel;
  }

  /** An array of the parametric mesh layers in this composition. */
  get parametricMeshLayers(): ParametricMeshLayer[] {
    return this._typeCache.parametricMesh;
  }

  /** An array of the null layers in this composition. */
  get nullLayers(): Layer[] {
    return this.layers.filter((layer) => layer.nullLayer);
  }

  /** An array of the adjustment layers in this composition. */
  get adjustmentLayers(): AVLayer[] {
    return this.avLayers.filter((layer) => layer.adjustmentLayer);
  }

  /** An array of the 3D layers in this composition. */
  get threeDLayers(): AVLayer[] {
    return this.avLayers.filter((layer) => layer.threeDLayer);
  }

  /** An array of the guide layers in this composition. */
  get guideLayers(): AVLayer[] {
    return this.avLayers.filter((layer) => layer.guideLayer);
  }

  /** An array of the soloed layers in this composition. */
  get soloLayers(): Layer[] {
    return this.layers.filter((layer) => layer.solo);
  }

  // -- Layer creation --------------------------------------------------------

  _syntheticLayerDuration(): number {
    /**
     * Default span of a new sourceless layer (solid, null, text,
     * shape, camera, light), from the "Pref_DEFAULT_SYNTHETIC_OUT_POINT"
     * preference; comp duration for the factory `0/0` value.
     */
    const pref = defaultSyntheticOutPoint(this._project._preferences);
    return pref != null ? pref : this.duration;
  }

  _stillLayerDuration(): number {
    /**
     * Default span of a new still-footage layer, from the
     * "Pref_DEFAULT_STILL_OUT_POINT" preference; comp duration for the
     * factory `0/0` value.
     */
    const pref = defaultStillOutPoint(this._project._preferences);
    return pref != null ? pref : this.duration;
  }

  _insertLayer(layer: Layer): void {
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
    const atTimeZero = this._project._preferences.getPrefAsBool(
      "General Section",
      "Create New Layers At Time Zero",
      PREFType.PREF_Type_MACHINE_INDEPENDENT,
      { default: true },
    );
    if (!atTimeZero && this.time) {
      layer.startTime = this.time;
    }

    const viewBlock = buildLayerViewBlock();

    let chunkIdx: number;
    if (this.layers?.length > 0) {
      try {
        chunkIdx = indexByIdentity(this._itemList.chunks, this.layers[0]._layerList);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        chunkIdx = this._findFirstLayerPosition();
      }
    } else {
      chunkIdx = this._findFirstLayerPosition();
    }
    this._itemList.chunks.splice(chunkIdx, 0, layer._layerList, ...viewBlock);

    _materializeLayer(layer);
    this._layers.unshift(layer);
    this._invalidateLayerCache();
  }

  addNull(duration: number | null = null): AVLayer {
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
      validateDuration(duration);
    }

    // AE numbers a new null after every project item named "Null N" -
    // solids, comps and folders alike, not the comp's layer names (AE
    // 2026: "Null 21" once a folder "Null 20" exists).
    const existing = new Set([...this._project.items.values()].map((item) => item.name));
    const name = autoName("Null", existing);

    // AE's addNull source is a white 100x100 solid (probed in AE 2026).
    const solidSource = SolidSource._new(name, [1.0, 1.0, 1.0]);
    const solidsFolder = this._project._solidsFolder;
    const footage = FootageItem._new(solidSource, {
      project: this._project,
      parentFolder: solidsFolder,
    });
    solidsFolder._childrenContainer.push(footage._itemList);
    solidsFolder._childrenContainer.push(...footage._viewData);
    this._project.items.set(footage.id, footage);
    solidsFolder.items.push(footage);

    // AE leaves the layer name empty for source-named layers (the
    // name resolves from the footage item).
    const layer = AVLayer._new({
      name: "",
      layerId: this._project._allocateId(),
      sourceId: footage.id,
      duration: duration != null ? duration : this._syntheticLayerDuration(),
      containingComp: this,
      nullLayer: true,
      label: labelIndex(this._project._preferences, "Null Label Index", 1),
      effectParamDefs: this._project._effectParamDefs,
    });
    this._insertLayer(layer);
    return layer;
  }

  addShape(): ShapeLayer {
    /**
     * Create a new empty shape layer at the top of the layer stack.
     *
     * @returns The newly created {@link ShapeLayer}.
     */
    const existing = new Set(this.layers.map((lyr) => lyr.name));
    const name = autoName(ShapeLayer._autoName, existing);

    const layer = ShapeLayer._new({
      name,
      layerId: this._project._allocateId(),
      duration: this._syntheticLayerDuration(),
      containingComp: this,
      effectParamDefs: this._project._effectParamDefs,
    });
    this._insertLayer(layer);
    return layer;
  }

  addCamera(name: string | null = null, centerPoint: number[] | null = null): CameraLayer {
    /**
     * Create a new camera layer at the top of the layer stack.
     *
     * @param name - Layer name. Auto-generated if `null`.
     * @param center_point - The `[x, y]` center point. Defaults to `[width/2, height/2]`.
     * @returns The newly created {@link CameraLayer}.
     */
    if (name == null) {
      const existing = new Set(this.layers.map((lyr) => lyr.name));
      name = autoName(CameraLayer._autoName, existing);
    }

    if (centerPoint == null) {
      centerPoint = [this.width / 2, this.height / 2];
    } else {
      validateVector2(centerPoint);
    }

    const layer = CameraLayer._new({
      name,
      layerId: this._project._allocateId(),
      duration: this._syntheticLayerDuration(),
      containingComp: this,
      effectParamDefs: this._project._effectParamDefs,
    });
    this._insertLayer(layer);

    // AE rounds the zoom to 8 decimals before storing it.
    const zoom = round((this.width * this.pixelAspect) / CameraLayer._zoomDividend, 8);

    const transform = layer.transform;
    const anchorPoint = transform.property("ADBE Anchor Point");
    anchorPoint.value = [centerPoint[0], centerPoint[1], 0.0];
    // ExtendScript reports a new two-node camera's position as
    // [0, 0, -zoom] (the point of interest carries the center).
    const position = transform.property("ADBE Position");
    position.value = [0.0, 0.0, -zoom];

    // AE's new-camera Camera Zoom equals the same computed zoom. Without
    // this the property keeps its 0.0 spec placeholder, which violates its
    // own >= 1 minimum and makes keyframing the zoom raise ValueError.
    const cameraOptions = layer.property("ADBE Camera Options Group");
    const zoomProp = cameraOptions.property("ADBE Camera Zoom");
    zoomProp.value = zoom;

    return layer;
  }

  addLight(name: string | null = null, centerPoint: number[] | null = null): LightLayer {
    /**
     * Create a new light layer at the top of the layer stack.
     *
     * @param name - Layer name. Auto-generated if `null`.
     * @param center_point - The `[x, y]` center point. Defaults to `[width/2, height/2]`.
     * @returns The newly created {@link LightLayer}.
     */
    if (name == null) {
      const existing = new Set(this.layers.map((lyr) => lyr.name));
      name = autoName(LightLayer._autoName, existing);
    }

    if (centerPoint == null) {
      centerPoint = [this.width / 2, this.height / 2];
    } else {
      validateVector2(centerPoint);
    }

    const layer = LightLayer._new({
      name,
      layerId: this._project._allocateId(),
      duration: this._syntheticLayerDuration(),
      containingComp: this,
      lightType: 1,
      effectParamDefs: this._project._effectParamDefs,
    });
    this._insertLayer(layer);

    // AE rounds the zoom to 8 decimals before storing it.
    const zoom = round((this.width * this.pixelAspect) / LightLayer._zoomDividend, 8);

    const transform = layer.transform;
    const anchorPoint = transform.property("ADBE Anchor Point");
    anchorPoint.value = [centerPoint[0], centerPoint[1], 0.0];
    // Like cameras, lights report position [0, 0, -zoom/2] with the
    // point of interest at the center.
    const position = transform.property("ADBE Position");
    position.value = [0.0, 0.0, -zoom / 2];

    return layer;
  }

  addParametricMesh(
    name: string | null = null,
    kw: { meshType: ParametricMeshType },
  ): ParametricMeshLayer {
    /**
     * Create a new parametric mesh layer at the top of the layer stack.
     *
     * @param name - Layer name. Auto-generated if `null`.
     * @param mesh_type - The type of parametric mesh (required, keyword-only).
     * @returns The newly created {@link ParametricMeshLayer}.
     */
    const { meshType } = kw;
    const explicitName = name != null;
    if (name == null) {
      const existing = new Set(this.layers.map((lyr) => lyr.name));
      // Python's `str.title()`: each run of letters capitalized, the rest lowered.
      const prefix = ParametricMeshType.nameOf(meshType)
        .toLowerCase()
        .replace(/(^|[^a-zA-Z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
      name = autoName(`${prefix} ${ParametricMeshLayer._autoName}`, existing);
    }

    const layer = ParametricMeshLayer._new({
      name,
      layerId: this._project._allocateId(),
      duration: this._syntheticLayerDuration(),
      containingComp: this,
      meshType,
      effectParamDefs: this._project._effectParamDefs,
    });
    // AE sets the ldta name bit when addParametricMesh receives an
    // explicit name (unlike other sourceless layers); UI-created mesh
    // layers with default names leave it clear.
    layer._ldta.nameSet = explicitName;
    this._insertLayer(layer);
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

    let layerDuration: number;
    if (duration != null) {
      validateDuration(duration);
      layerDuration = duration;
    } else if (item.duration) {
      layerDuration = item.duration;
    } else {
      layerDuration = this._stillLayerDuration();
    }

    // AE leaves the layer name empty for source-named layers, and the
    // new layer's label mirrors the item's label at add time (probed
    // in AE 2026, including user-recolored items).
    const layer = AVLayer._new({
      name: "",
      layerId: this._project._allocateId(),
      sourceId: item.id,
      duration: layerDuration,
      containingComp: this,
      label: int(item.label),
      effectParamDefs: this._project._effectParamDefs,
    });
    this._insertLayer(layer);

    this._project._ensureUsedInLinked();
    if ("_usedIn" in item) {
      item._usedIn.add(this);
    }

    return layer;
  }

  precompose(layerIndices: number[], name: string, moveAllAttributes = true): CompItem {
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
     * When `moveAllAttributes` is `false` (allowed for a single
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
     * @throws {@link ValueError} If `layerIndices` is empty or contains an out-of-range index, or
     *   if `moveAllAttributes` is `false` with more than one index or with a layer that has no
     *   source.
     */
    validateString(name);
    if (!Array.isArray(layerIndices) || !layerIndices?.length) {
      throw new ValueError("layerIndices must be a non-empty list.");
    }
    const checkIndex = _validateNumber({ integer: true, min: 0, max: this.layers.length - 1 });
    for (const idx of layerIndices) {
      checkIndex(idx);
    }
    const indices = sorted([...new Set(layerIndices)]);
    if (!moveAllAttributes) {
      if (indices.length !== 1) {
        throw new ValueError("moveAllAttributes=false requires exactly one layer index.");
      }
      const layer = this.layers[indices[0]];
      // 3D model layers cannot swap sources (replace_source raises);
      // check before mutating so a failure leaves the project intact.
      if (
        !(layer instanceof AVLayer) ||
        layer.source == null ||
        layer._ldta.layerType === LayerType.THREE_D_MODEL
      ) {
        throw new ValueError(
          "moveAllAttributes=false requires a layer with a " + "replaceable source.",
        );
      }
      return this._precomposeLeaveAttributes(layer, name);
    }
    return this._precomposeMove(indices, name);
  }

  _createPrecompItem(name: string, width: number, height: number): CompItem {
    /**
     * Create the precompose target composition.
     *
     * Built via `addComp` for the skeleton, then this composition's
     * settings are inherited by byte-copying its cdta (AE writes the
     * new comp's cdta byte-identical to the parent's, with only
     * width/height overridden in the leave-attributes path), and the
     * item is stored at the alphabetical position AE uses.
     */
    const folder = this.parentFolder;
    pyAssert(folder != null);
    const newComp = folder.addComp(
      name,
      width,
      height,
      this.pixelAspect,
      this.duration,
      this.frameRate,
    );
    const cloned = cloneChunkTree(this._cdta);
    cloned.width = width;
    cloned.height = height;
    const cdtaIdx = indexByIdentity(newComp._itemList.chunks, newComp._cdta);
    newComp._itemList.chunks[cdtaIdx] = cloned;
    newComp._cdta = cloned;
    folder._repositionChildSorted(newComp);
    return newComp;
  }

  _precomposeLeaveAttributes(layer: AVLayer, name: string): CompItem {
    /**
     * The `move_all_attributes=False` path: the retained layer only
     * swaps its source to the new comp (sized from the layer's source),
     * which holds one fresh layer referencing the original source.
     */
    const source = layer.source;
    pyAssert(source != null);
    const newComp = this._createPrecompItem(name, source.width, source.height);
    newComp.add(source);
    layer.replaceSource(newComp);
    _dropEssentialOverrides(layer);
    return newComp;
  }

  _precomposeMove(indices: number[], name: string): CompItem {
    /**
     * The `move_all_attributes=True` path: verbatim chunk-block moves
     * with fresh layer ids.
     */
    const project = this._project;
    const moved = indices.map((i) => this.layers[i]);
    const topIndex = indices[0];
    const oldIds = new Set<number | null>(moved.map((ly) => ly.id));
    const replEnabled = moved[0].enabled;

    const newComp = this._createPrecompItem(name, this.width, this.height);

    // Detach the moved layers' chunk blocks (top-down keeps their
    // relative stacking order).
    // Each block starts at its layer's own LIST:Layr.
    const blocks: [ListChunk, ...Chunk[]][] = [];
    for (const ly of moved) {
      const [start, end] = this._layerBlockSlice(ly);
      blocks.push([ly._layerList, ...this._itemList.chunks.slice(start + 1, end)]);
      this._itemList.chunks.splice(start, end - start);
      const atLayer = this._layers.indexOf(ly);
      if (atLayer < 0) {
        throw new ValueError("list.remove(x): x not in list");
      }
      this._layers.splice(atLayer, 1);
    }
    this._invalidateLayerCache();

    // AE reallocates layer ids on precompose; owner tdpi values inside
    // each layer's tdgp reference the owning layer id and must follow.
    const idMap: Map<number, number> = new Map();
    for (const ly of moved) {
      const newId = project._allocateId();
      idMap.set(ly.id, newId);
      ly._ldta.layerId = newId;
      rewriteOwnerTdpi(ly._layerList, newId);
    }

    // A moved layer whose track matte stays behind gets a verbatim
    // COPY of the matte layer directly below it in the new comp; the
    // original matte layer stays untouched in this comp (AE 2026). A
    // layer REFERENCE held by an effect parameter (Set Matte, Layer
    // Control, CC Sphere's light layer, ...) follows the same rule -
    // AE brings the referenced layer along rather than leaving an id
    // the new comp cannot resolve, which it refuses to open.
    const matteMap: Map<number, number> = new Map();
    const finalBlocks: [ListChunk, ...Chunk[]][] = [];
    for (const [i, ly] of moved.entries()) {
      const block = blocks[i];
      finalBlocks.push(block);
      const referenced: number[] = [ly._ldta.matteLayerId || 0];
      referenced.push(...sorted([...collectLayerRefTdpiIds(ly._layerList)]));
      for (const matteId of referenced) {
        if (!matteId || idMap.has(matteId) || matteMap.has(matteId)) {
          continue;
        }
        const matteLayer = this.layersById.get(matteId) ?? null;
        if (matteLayer != null) {
          const [mStart, mEnd] = this._layerBlockSlice(matteLayer);
          const mList = cloneChunkTree(matteLayer._layerList);
          const mBlock: [ListChunk, ...Chunk[]] = [
            mList,
            ...this._itemList.chunks.slice(mStart + 1, mEnd).map((c) => cloneChunkTree(c)),
          ];
          const mLdta = findByType(mList.chunks, "ldta");
          const copyId = project._allocateId();
          mLdta.layerId = copyId;
          rewriteOwnerTdpi(mList, copyId);
          // The clone's own references point at old-comp layer
          // ids: follow a parent/matte that moved, drop one that
          // stayed behind (it does not exist in the new comp).
          if (mLdta.parentId) {
            mLdta.parentId = idMap.get(mLdta.parentId) ?? 0;
          }
          if (mLdta.matteLayerId) {
            mLdta.matteLayerId = idMap.get(mLdta.matteLayerId) ?? 0;
          }
          matteMap.set(matteId, copyId);
          finalBlocks.push(mBlock);
        }
      }
    }

    // Remap references inside the moved set: both ends moved -> new
    // id; parent stayed behind -> unparented; matte stayed behind ->
    // the copy created above.
    for (const ly of moved) {
      const ldta = ly._ldta;
      if (ldta.parentId) {
        ldta.parentId = idMap.get(ldta.parentId) ?? 0;
      }
      const matteId = ldta.matteLayerId || 0;
      if (matteId) {
        ldta.matteLayerId = idMap.get(matteId) || (matteMap.get(matteId) ?? 0);
      }
    }

    // Layer-reference effect params follow the same map, for the copied
    // blocks too: a reference that moved (or was copied in above) is
    // retargeted, one that did not is cleared to "no layer".
    const refMap = new Map([...idMap, ...matteMap]);
    for (const block of finalBlocks) {
      remapLayerRefTdpi(block[0], refMap);
      // The block is MOVED, not serialized, so it still carries the
      // synthetic chunks synthesis added. Re-parsing them on the far
      // side would read a synthesizer's default as a real value; drop
      // them and let synthesis run again, as a re-open does.
      stripSynthetic(block[0]);
    }

    // Insert the blocks and re-parse each layer in the new comp's
    // context (the old Layer models go stale, like ExtendScript).
    newComp._ensureLayersLoaded();
    let insertAt = newComp._findFirstLayerPosition();
    const effectDefs = project._effectParamDefs;
    for (const block of finalBlocks) {
      newComp._itemList.chunks.splice(insertAt, 0, ...block);
      insertAt += block.length;
      const newLayer = parseLayer(block[0], newComp, effectDefs);
      newComp._layers.push(newLayer);
    }
    newComp._invalidateLayerCache();

    // Source usage bookkeeping for the moved (and copied) layers.
    project._ensureUsedInLinked();
    for (const newLayer of newComp._layers) {
      const source = newLayer._sourceItem;
      if (source != null && "_usedIn" in source) {
        _unregisterSourceUsage(source, this);
        source._usedIn.add(newComp);
      }
    }

    // Replacement layer at the topmost moved index. AE writes the
    // Sandstone label and inherits the topmost moved layer's video
    // switch (a matte layer moved alone keeps serving as matte, so
    // it stays off).
    const repl = this.add(newComp);
    if (topIndex > 0) {
      repl.moveAfter(this.layers[topIndex]);
    }
    repl.label = Label.SANDSTONE;
    repl.enabled = replEnabled;

    // Stayers referencing a moved layer retarget to the replacement
    // layer (both parenting and track matte).
    const replId = repl.id;
    for (const ly of this.layers) {
      if (ly === repl) {
        continue;
      }
      const ldta = ly._ldta;
      if (oldIds.has(ldta.parentId)) {
        ldta.parentId = replId;
      }
      if (oldIds.has(ldta.matteLayerId)) {
        ldta.matteLayerId = replId;
      }
    }

    this._invalidateLayerCache();
    return newComp;
  }

  addSolid(
    color: number[],
    name: string | null = null,
    width: number | null = null,
    height: number | null = null,
    pixelAspect = 1.0,
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
    validateRgbColor(color);

    if (name == null) {
      const existing = new Set([...this._project.items.values()].map((item) => item.name));
      const solidName = SolidSource._colorName(color[0], color[1], color[2]);
      name = autoName(solidName, existing);
    }

    if (width == null) {
      width = this.width;
    }
    if (height == null) {
      height = this.height;
    }

    const solidSource = SolidSource._new(name, color, width, height, pixelAspect);
    const solidsFolder = this._project._solidsFolder;
    const footage = FootageItem._new(solidSource, {
      project: this._project,
      parentFolder: solidsFolder,
    });
    solidsFolder._childrenContainer.push(footage._itemList);
    solidsFolder._childrenContainer.push(...footage._viewData);
    this._project.items.set(footage.id, footage);
    solidsFolder.items.push(footage);

    // AE leaves the layer name empty for source-named layers (the
    // name resolves from the solid footage item).
    const layer = AVLayer._new({
      name: "",
      layerId: this._project._allocateId(),
      sourceId: footage.id,
      duration: duration != null ? duration : this._syntheticLayerDuration(),
      containingComp: this,
      label: labelIndex(this._project._preferences, "Solid Label Index 2", 1),
      effectParamDefs: this._project._effectParamDefs,
    });
    this._insertLayer(layer);

    this._project._ensureUsedInLinked();
    if ("_usedIn" in footage) {
      footage._usedIn.add(this);
    }

    return layer;
  }

  _buildTextBtds(
    text: string,
    boxSize: number[] | null = null,
    lineOrientation: LineOrientation | null = null,
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
    const td = new TextDocument(text, boxSize, lineOrientation);
    // AE applies the character-level "Text Style Sheet" preferences to
    // every new text layer (probed in AE 2026; the paragraph sheet is
    // not applied).
    applyTextStylePrefs(td, this._project._preferences);
    const btdk = td._btdkBody;

    // Text-document tdbs carries an empty cdat with 4 trailing zero
    // bytes (matches what AE writes).
    const cdat = new CdatChunk({ pad: b("\x00\x00\x00\x00") });
    const tdb4 = new Tdb4Chunk({
      dimensions: 1,
      timeBase: this._cdta.internalTimebase,
      noValueFlags: 1,
      typeFlags: 0x08,
      cvotFlags: 0x04,
      valueHintType: 1,
    });
    const tdbs = new ListChunk({
      listType: "tdbs",
      chunks: [new TdsbChunk(), TdsnChunk.new_(TDSN_SENTINEL), tdb4, cdat],
    });
    const btds = new ListChunk({ listType: "btds", chunks: [tdbs, btdk] });
    const btgu = new ListChunk({
      listType: "btgu",
      chunks: [PguiChunk.new_(), new PguiChunk()],
    });
    const tdmn = new TdmnChunk({ value: "ADBE Text Document" });
    return [btds, btgu, tdmn];
  }

  _addTextLayer(
    text: string,
    box = false,
    boxSize: number[] | null = null,
    lineOrientation: LineOrientation | null = null,
  ): TextLayer {
    validateText(text);
    if (box) {
      if (boxSize == null) {
        boxSize = [this.width, this.height];
      } else {
        validateBoxSize(boxSize);
      }
    }

    const existing = new Set(this.layers.map((lyr) => lyr.name));
    text = text || autoName(TextLayer._autoName, existing);

    const [btds, btgu, tdMn] = this._buildTextBtds(text, boxSize, lineOrientation);

    const layer = TextLayer._new({
      name: text,
      layerId: this._project._allocateId(),
      duration: this._syntheticLayerDuration(),
      containingComp: this,
      btds,
      btgu,
      tdmn: tdMn,
      effectParamDefs: this._project._effectParamDefs,
    });
    this._insertLayer(layer);
    return layer;
  }

  /**
   * Create a new point text layer at the top of the layer stack.
   *
   * @param text - Initial text content.
   * @returns The newly created {@link TextLayer}.
   */
  addText(text = ""): TextLayer {
    return this._addTextLayer(text, false);
  }

  /**
   * Create a new box (paragraph) text layer at the top of the layer stack.
   *
   * @param boxSize - `[width, height]` of the text box. If `null`, uses the composition
   *   dimensions.
   * @param text - Initial text content.
   * @returns The newly created {@link TextLayer}.
   */
  addBoxText(boxSize: number[] | null = null, text = ""): TextLayer {
    return this._addTextLayer(text, true, boxSize);
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
  addVerticalText(text = ""): TextLayer {
    return this._addTextLayer(text, false, null, LineOrientation.VERTICAL_RIGHT_TO_LEFT);
  }

  /**
   * Create a new vertical box (paragraph) text layer at the top of the stack.
   *
   * Vertical text flows top-to-bottom with lines stacking right-to-left,
   * matching the Vertical Type Tool default.
   *
   * @param boxSize - `[width, height]` of the text box. If `null`, uses the composition
   *   dimensions.
   * @param text - Initial text content.
   * @returns The newly created {@link TextLayer}.
   */
  // @requires_version(24): wrapped after the class body.
  addVerticalBoxText(boxSize: number[] | null = null, text = ""): TextLayer {
    return this._addTextLayer(
      text,
      true,
      boxSize,
      LineOrientation.VERTICAL_RIGHT_TO_LEFT,
    );
  }
}

// The ChunkField descriptors of the fields declared above.

descriptor(
  CompItem,
  "bgColor",
  new ChunkField("_cdta", "bgColor", { validate: validateRgbColor }),
);

descriptor(CompItem, "draft3d", ChunkField.bool("_cdta", "draft3d"));

descriptor(CompItem, "frameBlending", ChunkField.bool("_cdta", "frameBlending"));

descriptor(CompItem, "hideShyLayers", ChunkField.bool("_cdta", "hideShyLayers"));

descriptor(CompItem, "motionBlur", ChunkField.bool("_cdta", "motionBlur"));

descriptor(
  CompItem,
  "preserveNestedFrameRate",
  ChunkField.bool("_cdta", "preserveNestedFrameRate"),
);

descriptor(
  CompItem,
  "preserveNestedResolution",
  ChunkField.bool("_cdta", "preserveNestedResolution"),
);

descriptor(
  CompItem,
  "width",
  new ChunkField("_cdta", "width", {
    validate: validateFootageDimension,
    preSet: "_buildLiveDefaults",
  }),
);

descriptor(
  CompItem,
  "height",
  new ChunkField("_cdta", "height", {
    validate: validateFootageDimension,
    preSet: "_buildLiveDefaults",
  }),
);

descriptor(
  CompItem,
  "shutterAngle",
  new ChunkField("_cdta", "shutterAngle", {
    validate: _validateNumber({ min: 0, max: 720, integer: true }),
  }),
);

descriptor(
  CompItem,
  "shutterPhase",
  new ChunkField("_cdta", "shutterPhase", {
    validate: _validateNumber({ min: -360, max: 360, integer: true }),
  }),
);

descriptor(
  CompItem,
  "resolutionFactor",
  new ChunkField("_cdta", "resolutionFactor", {
    validate: validateSequence({ length: 2, min: 1, max: 99, integer: true }),
  }),
);

descriptor(
  CompItem,
  "motionBlurAdaptiveSampleLimit",
  new ChunkField("_cdta", "motionBlurAdaptiveSampleLimit", {
    validate: _validateNumber({
      min: (self: CompItem) => self.motionBlurSamplesPerFrame,
      max: 256,
      integer: true,
    }),
  }),
);

descriptor(
  CompItem,
  "motionBlurSamplesPerFrame",
  new ChunkField("_cdta", "motionBlurSamplesPerFrame", {
    validate: _validateNumber({ min: 2, max: 64, integer: true }),
  }),
);

descriptor(
  CompItem,
  "pixelAspect",
  new ChunkField("_cdta", "pixelAspect", {
    validate: validatePixelAspect,
    // See `width`.
    preSet: "_buildLiveDefaults",
  }),
);

descriptor(
  CompItem,
  "timeScale",
  new ChunkField("_cdta", "timeScale", { readOnly: true }),
);

descriptor(
  CompItem,
  "displayStartTime",
  new ChunkField("_cdta", "displayStartTime", {
    // AE 2026's own bounds ("out of range -10800 to 86400").
    validate: _validateNumber({ min: -10800.0, max: 86400.0 }),
    postSet: "_restoreTimesInTimebase",
  }),
);

descriptor(
  CompItem,
  "dropFrame",
  ChunkField.bool("_cdrp", "value", {
    transform: (v: number) => v !== 0,
    reverse: (v: boolean) => int(v),
    default: false,
  }),
);

// `@requires_version(15)` on the `motionGraphicsTemplateName` setter, and
// `@requires_version(24)` on the vertical text methods. Python applies these
// decorators while the class body runs; here they wrap the finished class.
{
  const d = Object.getOwnPropertyDescriptor(CompItem.prototype, "motionGraphicsTemplateName");
  const set = d?.set;
  pyAssert(set !== undefined);
  // A setter's own name is "set <prop>"; Python's error names the method.
  Object.defineProperty(set, "name", { value: "motionGraphicsTemplateName" });
  Object.defineProperty(CompItem.prototype, "motionGraphicsTemplateName", {
    ...d,
    set: requiresVersion(15)(set),
  });
}
CompItem.prototype.addVerticalText = requiresVersion(24)(CompItem.prototype.addVerticalText);
CompItem.prototype.addVerticalBoxText = requiresVersion(24)(
  CompItem.prototype.addVerticalBoxText,
);
