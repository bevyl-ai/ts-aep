// Port of py_aep/models/layers/layer.py

import { INSPECT, describe } from "../../../pyrt/index.ts";
import type { LdtaChunk } from "../../binary/layer_chunks.ts";
import type { Keyframe } from "../properties/keyframe.ts";
import type { MarkerValue } from "../properties/marker.ts";
import { AutoOrientType, Label, LayerType } from "../../enums/index.ts";
import { aeWrites } from "../../ae_version.ts";
import { Chunk, ListChunk } from "../../binary/chunk.ts";
import { layerTimebase, rescaleTicks } from "../../binary/composition_chunks.ts";
import { CmtaChunk } from "../../binary/item_chunks.ts";
import { buildGideList, buildOvdg, cloneChunkTree, remapLayerRefTdpi, rewriteOwnerTdpi, rewriteTimeBase } from "../../binary/mutations.ts";
import { TdmnChunk, TdsbChunk, TdsnChunk } from "../../binary/property_chunks.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { filterByListType, filterByType, findByType, indexByIdentity, listTypeOf } from "../../binary/utils.ts";
import { _effectInstances, rehomeEffectDefinitions } from "../../parsers/effect.ts";
import { parseProperties } from "../../parsers/property.ts";
import { getChunksByMatchName, getMatchNameRuns } from "../../parsers/utils.ts";
import { Mat4, aspectScale, buildWorldMatrix, composeOrientation, decomposeTransform, layerSourceAspect, positionSpaceAspect, rigAimsAtPoi, rotationPart, squarePixels, stripOrientation } from "../../resolvers/transform.ts";
import { ChunkField, _suppressMaterialization, type EffectParamDefs } from "../descriptors.ts";
import { autoName } from "../naming.ts";
import { Property } from "../properties/property.ts";
import { PropertyBase } from "../properties/property_base.ts";
import { PropertyGroup } from "../properties/property_group.ts";
import { _validateNumber, validateInt, validateNumber, validateString } from "../validators.ts";
import type { AVItem } from "../items/av_item.ts";
import type { CompItem } from "../items/composition.ts";
import type { AVLayer } from "./av_layer.ts";
import {
  KeyError,
  ValueError,
  descriptor,
  getMember,
  setMember,
  objectSetattr,
  assert,
  truthy,
  valueEquals,
  truthyOr,
  literal,
  warn,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import type { MatchNameTypes } from "../properties/match_name_types.ts";
import * as _avLayer from "./av_layer.ts";
import * as _composition from "../items/composition.ts";
import { late } from "../late.ts";


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
export const _validateStretch = _validateNumber({
  min: -2147483520 * 100.0,
  max: 2147483520 * 100.0,
});

// The start time is a signed 32-bit count of the layer's timebase ticks.
export const _validateStartTime = _validateNumber({
  min: (layer: Layer) => -0x80000000 / layer._layerTimebase(),
  max: (layer: Layer) => 0x7fffffff / layer._layerTimebase(),
});

/** Sentinel value indicating an undefined source id in the binary format. */
export const _UNDEFINED_ID = 0xffffffff;

/**
 * The ldta source id of a light without a source: 0 before AE 23, which
 * writes the undefined id.
 */
export function _noSourceId(comp: CompItem): number {
  const major = comp._project._head.aeVersionMajor;
  return aeWrites("light source id", major) ? _UNDEFINED_ID : 0;
}

/**
 * Extract Essential Properties override UUIDs from LIST:OvG2 chunks.
 *
 * @param tdgpChunks - The children of the layer's root `tdgp` group, where `LIST:OvG2` is a direct
 *   child (beside the "ADBE Layer Overrides" marker). NOT the layer LIST's own children - `OvG2`
 *   sits one level deeper than that.
 * @returns A list of controller UUID strings from the OvG2/CPrp/Utf8 entries; each matches an
 *   `EssentialGraphicsController.uuid` on the source comp.
 */
export function _parseOvg2Uuids(tdgpChunks: Chunk[]): string[] {
  const uuids: string[] = [];
  for (const ovg2List of filterByListType(tdgpChunks, "OvG2")) {
    for (const cprp of filterByListType(ovg2List.chunks, "CPrp")) {
      const utf8Chunks = filterByType(cprp.chunks, "Utf8");
      if (utf8Chunks.length > 0) {
        uuids.push(utf8Chunks[0].value);
      }
    }
  }
  return uuids;
}

/** World matrix a child of `parent` is placed in, at comp `time`. */
export function _parentWorld(parent: Layer | null, time: number, childIs3d: boolean): Mat4 {
  if (parent == null) return Mat4.identity();
  return buildWorldMatrix(parent, time, !childIs3d, { asParent: true });
}

/** `list.index(x)` with `==` (identity for layers) and CPython's ValueError. */
export function _listIndex<T>(xs: T[], x: T): number {
  for (let i = 0; i < xs.length; i++) if (xs[i] === x) return i;
  throw new ValueError(`${literal(x)} is not in list`);
}

/** `list.remove(x)` with CPython's ValueError. */
export function _listRemove<T>(xs: T[], x: T): void {
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
export type LiveDefaultProperty = "ADBE Position" | "ADBE Anchor Point" | "ADBE Camera Zoom" | "ADBE Camera Focus Distance";

/** Keyword arguments of `Layer._new`. */
type LayerNewKw = {
  ldta: LdtaChunk;
  name: string;
  containingComp: CompItem;
  rootTdgpExtra?: Chunk[] | null;
  effectParamDefs?: EffectParamDefs | null;
};

/** Keyword arguments of the `Layer` constructor. */
type LayerInitKw = {
  _ldta: LdtaChunk;
  _cmta: CmtaChunk | null;
  _nameUtf8: Utf8Chunk;
  _layerList: ListChunk;
  containingComp: CompItem;
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
  // which `_writeOutMovedDefaults` writes once that state moves it.
  static _LIVE_DEFAULTS: ReadonlyArray<readonly [LiveDefaultGroup, LiveDefaultProperty]> = [
    ["ADBE Transform Group", "ADBE Position"],
  ];

  _compCentre(): number[] {
    const comp = this.containingComp;
    return [comp.width / 2.0, comp.height / 2.0, 0.0];
  }

  /**
   * AE's default Position: the comp centre. A left-out Position stays
   * where it was when the comp is resized, and AE writes it: measured on
   * AE 2026 for a solid, a text, a shape and a null layer.
   */
  _defaultPosition(): number[] {
    return this._compCentre();
  }

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
  declare nullLayer: boolean;

  /** The ID of the layer's parent layer. `0` if the layer has no parent. */
  declare _parentId: number;

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
  declare autoOrient: AutoOrientType;

  declare _essentialPropertyUuids: string[] | null;

  declare _ldta: LdtaChunk;
  declare _cmta: CmtaChunk | null;
  declare _layerList: ListChunk;
  declare _containingComp: CompItem;
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
  get startTime(): number {
    return this._ldta.startTime;
  }

  set startTime(value: number) {
    _validateStartTime(value, this);
    const timebase = this._layerTimebase();
    const ldta = this._ldta;
    ldta.startTimeDividend = Math.floor(value * timebase + 0.5);
    ldta.startTimeDivisor = timebase;
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
    _validateStretch(value, this);
    if (Math.abs(value) < 1.0) {
      value = value < 0 ? -_MIN_STRETCH : _MIN_STRETCH;
    }
    const old = this._layerTimebase();
    this._stretch = value;
    this._retimeToLayerTimebase(old, this._layerTimebase());
  }

  /**
   * Keyframe units per second of this layer's own time, in its
   * composition or one of `internalTimebase`.
   */
  _layerTimebase(internalTimebase: number | null = null): number {
    if (internalTimebase == null) {
      internalTimebase = this.containingComp._cdta.internalTimebase;
    }
    return layerTimebase(internalTimebase, this._stretchFactor);
  }

  /**
   * Hold every keyframe at the same LAYER time across a stretch change
   * (`rescaleTicks`).
   */
  _retimeToLayerTimebase(old: number, new_: number): void {
    if (new_ === old || old <= 0) return;
    for (const prop of this._leafProperties()) {
      if (prop._isLive()) prop._ensureTimeBase();
      for (const keyframe of prop.keyframes) {
        const item = keyframe._ldatItem;
        item.timeUnits = rescaleTicks(item.timeUnits, old, new_);
      }
    }
  }

  // Use identity-based equality to avoid comparing all fields recursively,
  // which could produce unexpected results or hit circular references.
  // `__hash__ = object.__hash__` is not carried over: instances are hashed by
  // identity already, which is what a Map/Set keyed by a Layer uses.
  equals(other: unknown): boolean {
    return this === other;
  }

  _assignAttribute(name: string, value: unknown): void {
    // Layers set public instance attributes of their own, which
    // `PropertyGroup._assignAttribute` would refuse.
    objectSetattr(this, name, value);
  }

  constructor(kw: LayerInitKw) {
    const {
      _ldta,
      _cmta,
      _nameUtf8,
      _layerList,
      containingComp,
    } = kw;
    // NOTE(port): TS cannot touch `this` before super(); the early self._ldta/_cmta/_layer_list/_essential_property_uuids assignments move below it (the base __init__ never reads them) and new.target stands in for self in the match-name lookup.

    const layerTypeRaw = _ldta.layerType;
    const layerType = LayerType.ofOrNull(layerTypeRaw);
    let matchName = layerType === null ? undefined : new.target._LAYER_MATCH_NAMES.get(layerType);
    if (matchName === undefined) {
      logger.warning(
        `Unknown layer type ${layerTypeRaw} for layer '${_nameUtf8.value}' in comp '${containingComp.name}'. Defaulting to 'ADBE AV Layer'.`,
      );
      matchName = "ADBE AV Layer";
    }

    super({
      _tdsb: null,
      _nameUtf8,
      matchName,
      autoName: "",
      propertyDepth: 0,
      properties: [],
    });

    this._ldta = _ldta;
    this._cmta = _cmta;
    this._layerList = _layerList;
    // Read from the root tdgp on first access.
    this._essentialPropertyUuids = null;

    this._containingComp = containingComp;
  }

  /** Build a layer from a fresh ldta chunk (`Layer._new`). */
  // Python marks this override `# type: ignore[override]`; the `never`
  // overload keeps the incompatible base signatures uncallable.
  static _new<T extends Layer>(this: new (kw: LayerInitKw) => T, kw: LayerNewKw): T;
  static _new(...args: never[]): never;
  static _new<T extends Layer>(this: new (kw: LayerInitKw) => T, kw: LayerNewKw): T {
    const { ldta, name, containingComp } = kw;
    const rootTdgpExtra = kw.rootTdgpExtra ?? null;
    const effectParamDefs = kw.effectParamDefs ?? null;

    validateString(name);

    const nameUtf8 = new Utf8Chunk({ value: name });
    const tdgpChunks: Chunk[] = [new TdsbChunk({}), TdsnChunk.new_()];
    if (rootTdgpExtra != null && rootTdgpExtra.length > 0) tdgpChunks.push(...rootTdgpExtra);
    // AE terminates every tdgp match-name stream with ADBE Group End
    // and rejects layers whose root tdgp lacks it ("missing data in
    // file"). Synthesized children are inserted before this marker.
    tdgpChunks.push(new TdmnChunk({ value: "ADBE Group End" }));
    const rootTdgp = new ListChunk({ listType: "tdgp", chunks: tdgpChunks });
    const aeMajor = containingComp._project._head.aeVersionMajor;
    // The ldta matte-layer field (164- instead of 160-byte records).
    ldta.matteLayerId = aeWrites("matte layer id", aeMajor) ? 0 : null;
    const [gide, _lhd3, _inner] = buildGideList();
    const layerList = new ListChunk({
      listType: "Layr",
      chunks: [ldta, nameUtf8, rootTdgp, gide],
    });
    if (aeWrites("layer OvdG", aeMajor)) layerList.chunks.push(buildOvdg());

    const layer = new this({
      _ldta: ldta,
      _cmta: null,
      _nameUtf8: nameUtf8,
      _layerList: layerList,
      containingComp,
    });
    layer._tdgp = rootTdgp;
    layer._buildPropertyTree(truthyOr(effectParamDefs, new Map()));
    return layer;
  }

  // The effect definitions a parsed layer's property tree is built with on
  // first access, or `null` once it is built: opening a composition's
  // layers then only decodes their `ldta`, and a reader of layer
  // attributes alone (times, names, sources) never pays for the
  // properties. Until then `_properties` is absent from the instance, so
  // its first read lands in `_missingAttribute`; after that it is a plain
  // attribute, with nothing to check on each access.
  // NOTE(port): a Python class attribute, installed on the prototype below the class.
  declare _treeParamDefs: EffectParamDefs | null;

  _missingAttribute(name: string): Property | PropertyGroup {
    // A public name may be a child looked up by attribute: build first.
    if (this._treeParamDefs != null && (name === "_properties" || !name.startsWith("_"))) {
      this._loadPropertyTree();
      // NOTE(port): Python returns `getattr(self, name)`, here the `_properties` list too; the base signature only names the child case.
      return getMember(this, name);
    }
    return super._missingAttribute(name);
  }

  /** Build the property tree of a parsed layer, if not built yet. */
  _loadPropertyTree(): void {
    _suppressMaterialization().run(() => {
      const effectParamDefs = this._treeParamDefs;
      if (effectParamDefs == null) return;
      // Cleared first, with an empty tree in place as during an eager
      // parse: parsing and synthesis read the layer's own properties.
      this._treeParamDefs = null;
      this._properties = [];
      try {
        this._buildPropertyTree(effectParamDefs);
      } catch (e) {
        // Unbuilt again, so the next read raises too rather than seeing
        // a partial tree.
        Reflect.deleteProperty(this, "_properties");
        this._treeParamDefs = effectParamDefs;
        throw e;
      }
    });
  }

  /**
   * Parse the root tdgp into this layer's properties and synthesize
   * the ones the file leaves out.
   */
  _buildPropertyTree(effectParamDefs: EffectParamDefs): void {
    assert(this._tdgp != null);
    const props = parseProperties(
      getMatchNameRuns(this._tdgp),
      1,
      effectParamDefs,
      this.containingComp,
      this,
    );
    this._properties = props;
    for (const child of props) child._parentProperty = this;
    late.synthesizeLayerProperties(this);
  }

  /**
   * UUIDs of Essential Properties overrides on this layer.
   *
   * Each UUID corresponds to an {@link EssentialGraphicsController} in
   * the source composition's Essential Graphics panel.
   */
  get essentialPropertyUuids(): string[] {
    if (this._essentialPropertyUuids == null) {
      assert(this._tdgp != null);
      this._essentialPropertyUuids = _parseOvg2Uuids(this._tdgp.chunks);
    }
    return this._essentialPropertyUuids;
  }

  [INSPECT](): string {
    return describe(this.constructor.name, { enabled: this.enabled, matchName: this.matchName, name: this.name });
  }

  get name(): string {
    return super.name;
  }

  set name(value: string) {
    // PropertyBase.name.fset(self, value)
    super.name = value;
    this._ldta.layerName = value;
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
    const sourceId = this._ldta.sourceId;
    if (this._ldta.layerType === LayerType.PARAMETRIC_MESH) {
      this._ldta.nameSet = true;
    } else if (!value || sourceId === 0) {
      this._ldta.nameSet = false;
    } else {
      const sourceItem = this.containingComp._project.items.get(sourceId);
      this._ldta.nameSet = (sourceItem?.name ?? null) !== value;
    }
  }

  /** A descriptive comment for the layer. Read / Write. */
  get comment(): string {
    // AE 2026 shows no comment for a `cmta` whose ldta flag is unset.
    if (this._cmta == null || !this._ldta.hasComment) return "";
    return this._cmta.value;
  }

  set comment(value: string) {
    validateString(value);
    if (!value) {
      // AE drops the chunk and the flag rather than store "".
      if (this._cmta != null) {
        const chunks = this._layerList.chunks;
        chunks.splice(indexByIdentity(chunks, this._cmta), 1);
        this._cmta = null;
      }
      this._ldta.hasComment = false;
      return;
    }
    this._ldta.hasComment = true;
    if (this._cmta != null) {
      this._cmta.value = value;
    } else {
      const chunk = new CmtaChunk({});
      chunk.value = value;
      const chunks = this._layerList.chunks;
      // AE 15 writes the comment before the LIST:OvdG closing a layer.
      const endsWithOvdg = listTypeOf(chunks.at(-1)) === "OvdG";
      chunks.splice(endsWithOvdg ? chunks.length - 1 : chunks.length, 0, chunk);
      this._cmta = chunk;
    }
  }

  /** The composition that contains this layer. Read-only. */
  get containingComp(): CompItem {
    return this._containingComp;
  }

  /**
   * The type of layer. Matches ExtendScript `layerType` values:
   * `"AVLayer"`, `"LightLayer"`, `"CameraLayer"`,
   * `"ParametricMeshLayer"`, or `"Layer"`. Read-only.
   */
  get layerType(): string {
    return this.constructor._LAYER_TYPE_NAMES.get(LayerType.of(this._ldta.layerType)) ?? "AVLayer";
  }

  /**
   * The current time of the layer, expressed in composition time
   * (seconds). Read-only.
   */
  get time(): number {
    return this._containingComp.time;
  }

  /**
   * The current time of the layer, expressed in composition time
   * (frames). Read-only.
   */
  get frameTime(): number {
    return this._containingComp.frameTime;
  }

  /**
   * Whether the layer transforms in three dimensions.
   *
   * `false` on the base {@link Layer}: only an {@link AVLayer} carries the
   * 3D switch, and cameras and lights are always 3D, so both override
   * this. Read-only.
   */
  get is3d(): boolean {
    return false;
  }

  /**
   * The layer's pixel dimensions, for denormalizing effect points.
   *
   * `null` on the base {@link Layer}: `width` / `height` live on
   * {@link AVLayer}, and a camera or light has neither, so nothing
   * normalized against a layer sits on one.
   */
  get _pixelSize(): [number, number] | null {
    return null;
  }

  /**
   * The layer's source item: none for a camera or a light (see
   * `AVLayer.source`). For code handling any kind of layer, where
   * `getattr(layer, "source", null)` would search the layer's properties
   * for a child of that name.
   */
  get _sourceItem(): AVItem | null {
    return null;
  }

  /**
   * The size the layer's effect points are stored normalized against.
   *
   * The layer's pixel size, except on an adjustment layer, whose effects
   * render in its composition: AE 2026 stores a Transform anchor set to
   * [30, 40] on a 200x100 adjustment solid in a 1920x1080 comp as
   * 30 / 1920, 40 / 1080, and defaults it to the comp's centre (as AE
   * 15.1 does).
   */
  get _effectPointSize(): [number, number] | null {
    if (this.adjustmentLayer) {
      const comp = this.containingComp;
      return [comp.width, comp.height];
    }
    return this._pixelSize;
  }

  get _stretchFactor(): number {
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
  get _timeOrigin(): number {
    const factor = this._stretchFactor;
    if (factor >= 0) return this.startTime;
    return this.startTime + factor / 3000.0;
  }

  /**
   * The "in" point of the layer, expressed in composition time
   * (seconds). Read / Write.
   *
   * On a time-reversed layer the in point is the later end, and sits
   * `|stretch| / 100 / 3000` s before the start time (1.2995 s for a
   * -150 % layer starting at 1.3 s), as After Effects reports it.
   */
  get inPoint(): number {
    return this._timeOrigin + this._ldta.inPoint * this._stretchFactor;
  }

  set inPoint(value: number) {
    validateNumber(value);
    this._setRawInPoint(value);
  }

  /**
   * The "out" point of the layer, expressed in composition time
   * (seconds). Read / Write.
   *
   * On a time-reversed layer the out point is the earlier end (see
   * {@link inPoint}).
   */
  get outPoint(): number {
    return this._timeOrigin + this._ldta.outPoint * this._stretchFactor;
  }

  set outPoint(value: number) {
    validateNumber(value);
    this._setRawOutPoint(value);
  }

  /**
   * The "in" point of the layer, expressed in composition time
   * (frames). Read / Write.
   */
  get frameInPoint(): number {
    return Math.round(this.inPoint * this.containingComp.frameRate);
  }

  set frameInPoint(value: number) {
    validateInt(value);
    this.inPoint = value / this.containingComp.frameRate;
  }

  /**
   * The "out" point of the layer, expressed in composition time
   * (frames). Read / Write.
   */
  get frameOutPoint(): number {
    return Math.round(this.outPoint * this.containingComp.frameRate);
  }

  set frameOutPoint(value: number) {
    validateInt(value);
    this.outPoint = value / this.containingComp.frameRate;
  }

  /**
   * The start time of the layer, expressed in composition time
   * (frames). Read / Write.
   */
  get frameStartTime(): number {
    return Math.round(this.startTime * this.containingComp.frameRate);
  }

  set frameStartTime(value: number) {
    validateInt(value);
    this.startTime = value / this.containingComp.frameRate;
  }

  /**
   * The 0-based index position of the layer in its containing comp.
   *
   * **Warning:** Unlike ExtendScript (1-based), this uses Python's 0-based
   * convention so that `comp.layers[layer.index]` works directly.
   */
  get index(): number {
    return _listIndex(this.containingComp.layers, this);
  }

  /**
   * `true` if the layer has a video switch in the Timeline panel.
   *
   * Always `false` for {@link CameraLayer} and {@link LightLayer} objects.
   */
  get hasVideo(): boolean {
    return false;
  }

  /**
   * `true` if the layer is an adjustment layer.
   *
   * Always `false` for {@link CameraLayer} and {@link LightLayer} objects.
   * Overridden in {@link AVLayer} to read from the binary chunk.
   */
  get adjustmentLayer(): boolean {
    return false;
  }

  /**
   * `true` if the layer is an environment layer.
   *
   * Always `false` for {@link CameraLayer} and {@link LightLayer} objects.
   * Overridden in {@link AVLayer} to read from the binary chunk.
   */
  get environmentLayer(): boolean {
    return false;
  }

  /**
   * When `true`, the layer is active at the current time.
   *
   * Overrides {@link PropertyBase.active} to evaluate
   * {@link activeAtTime} at {@link time}.
   */
  get active(): boolean {
    return this.activeAtTime(this.time);
  }

  /**
   * The layer's marker property.
   *
   * A {@link Property | Property} with
   * `match_name="ADBE Marker"` whose keyframes hold marker values.
   * `null` when the layer has no markers.
   */
  get marker(): Property<MarkerValue | null> | null {
    return this._childOrNull("ADBE Marker");
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
  removeAllMarkers(): void {
    if (this.marker != null) this.marker.removeAllKeys();
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
    assert(group instanceof PropertyGroup);
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
   * with `layer.effects.addProperty(...)`. An empty group is falsy,
   * so `if layer.effects:` still means "has effects".
   *
   * `null` on {@link CameraLayer} and {@link LightLayer}, the only layer kinds
   * AE gives no Effects group; every other layer kind always has one.
   */
  get effects(): PropertyGroup | null {
    return this._optionalGroup("ADBE Effect Parade");
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
    return this._optionalGroup("ADBE Mask Parade");
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
    return this._optionalGroup("ADBE Text Properties");
  }

  /**
   * The child `PropertyGroup` for `matchName`, or `null` when this
   * layer kind does not have it.
   *
   * Missing top-level groups are synthesized per layer kind by
   * `synthesizeLayerProperties`, so a `null` here means the kind has
   * no such group at all, not that the `.aep` merely omitted an empty
   * one (AE writes the Effect / Mask Parade only once it has content).
   */
  _optionalGroup<K extends keyof MatchNameTypes>(matchName: K): (MatchNameTypes[K] & PropertyGroup) | null {
    const group = this._childOrNull(matchName);
    return group instanceof PropertyGroup ? group : null;
  }

  /**
   * Whether the file leaves out one of `_LIVE_DEFAULTS`, read from the
   * chunks so that the tree stays unbuilt when none is.
   */
  _leavesOutLiveDefaults(): boolean {
    assert(this._tdgp != null);
    const groups = getChunksByMatchName(this._tdgp);
    for (const [groupName, matchName] of this.constructor._LIVE_DEFAULTS) {
      const group = filterByListType(groups.get(groupName) ?? [], "tdgp");
      if (group.length === 0 || !getChunksByMatchName(group[0]).has(matchName)) {
        return true;
      }
    }
    return false;
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
  _writeOutMovedDefaults(): void {
    if (this._treeParamDefs != null) {
      // Never built, so nothing moved (`CompItem._build_live_defaults`).
      return;
    }
    for (const [groupName, matchName] of this.constructor._LIVE_DEFAULTS) {
      const group = this.property(groupName);
      const prop = group.property(matchName);
      if (prop._tdsb == null || !prop._tdsb.synthetic) continue;
      if (prop.isModified) prop._ensureMaterialized();
    }
  }

  /**
   * Reject parent assignments ExtendScript refuses: a layer from
   * another comp, the layer itself, or any of its own descendants
   * (which would create a parenting cycle).
   */
  _validateParent(newParent: Layer | null): void {
    if (newParent == null) return;
    if (!(newParent instanceof Layer)) {
      throw new ValueError("parent must be a Layer or null");
    }
    if (newParent.containingComp !== this.containingComp) {
      throw new ValueError("parent must be a layer in the same composition");
    }
    // Walk up from the candidate; hitting self means a cycle. The
    // visited set keeps this terminating even on a file that already
    // contains a parenting cycle.
    const seen = new Set<Layer>([this]);
    let current: Layer | null = newParent;
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
    if (this._parentId === 0) return null;
    return this.containingComp.layersById.get(this._parentId) ?? null;
  }

  set parent(value: Layer | null) {
    this._validateParent(value);
    const oldParent = this.parent;
    if (oldParent === value) return;

    // AE compensates once, from the transforms at the comp's current
    // time (measured on AE 2026: with the playhead at 1 s, a child of a
    // parent animated from 0 to 90 degrees gets Rotate Z -45).
    const time = this.containingComp.time;
    // A 2D child cannot store an out-of-plane rotation, and AE does not
    // try: it compensates as though every ancestor were 2D. Building the
    // matrices the same way keeps our answer on AE's.
    const is3d = this.is3d;
    const comp = this.containingComp;
    this._compensateReparent(
      value,
      buildWorldMatrix(this, time, !is3d),
      _parentWorld(oldParent, time, is3d),
      _parentWorld(value, time, is3d),
      time,
      [comp.pixelAspect, positionSpaceAspect(oldParent, comp)],
      [comp.pixelAspect, positionSpaceAspect(value, comp)],
    );
  }

  /**
   * Parent this layer to `newParent` (`null` to unparent), rewriting
   * its transform so `childWorld` (its world matrix under the old
   * parent, at comp `time`) does not move.
   *
   * `oldAspects` / `newAspects` are the `(comp, Position space)` pixel
   * aspects under the old / new parent (see
   * `resolvers.transform.position_space_aspect`): the transform values
   * live in square pixels, so the matrices are squared before they are
   * decomposed.
   */
  _compensateReparent(
    newParent: Layer | null,
    childWorld: Mat4,
    oldParentWorld: Mat4,
    newParentWorld: Mat4,
    time: number,
    oldAspects: [number, number],
    newAspects: [number, number],
  ): void {
    let newParentInverse: Mat4;
    try {
      newParentInverse = newParentWorld.inverse();
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      // A parent scaled to 0 has no inverse; AE 2026 parents to it
      // anyway and leaves the child's values untouched.
      this._parentId = newParent != null ? newParent.id : 0;
      return;
    }
    this._parentId = newParent != null ? newParent.id : 0;
    const is3d = this.is3d;
    const newSpace = newAspects[1];
    const ownAspect = layerSourceAspect(this);
    // The local matrix is `T(pos) . Sp^-1 . R . S . Sl . T(-anchor)`
    // (`buildLocalMatrix`); undo the two aspect scalings to decompose
    // the square-pixel `T(Sp pos) . R . S . T(-Sl anchor)`.
    const newLocal = aspectScale(newSpace)
      .multiply(newParentInverse)
      .multiply(childWorld)
      .multiply(aspectScale(1.0 / ownAspect));
    // Maps a point from the old parent's space into the new one; used by
    // both keyframed-Position branches below.
    const parentRemap = newParentInverse.multiply(oldParentWorld);

    const transform = this.transform;

    const current = (matchName: "ADBE Anchor Point" | "ADBE Orientation" | "ADBE Scale"): number[] => {
      const prop = transform.property(matchName);
      return prop.keyframes?.length > 0 ? prop.valueAtTime(time) : prop.value;
    };

    // Decompose into AE transform components, keeping anchor fixed.
    const anchor = current("ADBE Anchor Point");
    const squareAnchor = [anchor[0] * ownAspect, ...anchor.slice(1)];

    // Position and scale come straight from the local matrix - neither
    // depends on how the rotation is split between Orientation and
    // Rotate X/Y/Z. `newRz` is only used on the 2D path below, where the
    // orientation is divided out of the 3x3 first so it cannot leak into
    // the rotation (a layer switched from 3D to 2D can still carry one).
    const orientation = current("ADBE Orientation");
    let newPos = decomposeTransform(newLocal, squareAnchor)[0];
    newPos = [newPos[0] / newSpace, ...newPos.slice(1)];
    let [, newScale, newRz] = decomposeTransform(
      stripOrientation(newLocal, orientation),
      squareAnchor,
    );
    if (newScale[0] < 0 && is3d) {
      // `decomposeTransform` signals a mirrored basis by negating x
      // alone. AE spreads the flip across all three axes and keeps the
      // rotation proper: a parent scaled [-100, 100, 100] leaves the
      // child at [-100, -100, -100] with Orientation [180, 0, 0]. A 2D
      // layer has no Orientation to absorb that and keeps the x-only
      // flip (AE 2026: a [-100, 100] child under a 150 % parent gets
      // [-66.7, 66.7, 100]).
      newScale = newScale.map((component) => -Math.abs(component));
    }

    const writeCompensation = (matchName: "ADBE Position" | "ADBE Scale" | "ADBE Rotate Z", newValue: number | number[]): void => {
      // Only write values that actually changed to avoid materializing
      // synthetic properties unnecessarily. Keyframed scale / rotation
      // values are left untouched, matching ExtendScript (the layer
      // may visually jump for those).
      const prop = transform.property(matchName);
      if (prop.keyframes?.length > 0) return;
      if (!valueEquals(prop.value, newValue)) prop.value = newValue;
    };

    const remapSeparatedKeyframes = (leader: Property<number[]>, followers: Property<number>[]): void => {
      // Remap an animated separated Position into the new parent's space.
      //
      // A separated leader holds no keyframes of its own, so the generic
      // keyframe branch below never sees this case. Each follower
      // keyframe is remapped through the leader's composed position at
      // its own time, because the transform mixes the axes.
      const remap = parentRemap;
      // Collected first, applied after: every sample has to see the
      // pre-remap followers, and a component write would move them.
      const updates: [Keyframe, number][] = [];
      const remapped = new Map<number, number[]>();
      for (const [dimension, follower] of followers.entries()) {
        for (const keyframe of follower.keyframes) {
          const time = keyframe.time;
          let point: number[] | null = remapped.get(time) ?? null;
          if (point == null) {
            point = remap.transformPoint(leader.valueAtTime(time));
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
    const scaleProp = transform.property("ADBE Scale");
    if (scaleProp.keyframes?.length > 0) {
      const scaleNow = current("ADBE Scale");
      const factors = Array.from({ length: newScale.length }, (_, axis) =>
        axis < scaleNow.length && scaleNow[axis] !== 0
          ? newScale[axis] / scaleNow[axis]
          : 1.0,
      );
      // Skipped when the parent applies no scale, for the reason
      // `writeCompensation` gives: an unchanged value is not written.
      if (factors.some((factor) => factor !== 1.0)) {
        for (const keyframe of scaleProp.keyframes) {
          const components = keyframe.value;
          keyframe.value = components.map((component, axis) =>
            axis < factors.length ? component * factors[axis] : component,
          );
        }
      }
    } else {
      writeCompensation("ADBE Scale", newScale);
    }

    // ExtendScript remaps every POSITION keyframe into the new parent's
    // space (measured in AE 2026).
    const pos = transform.property("ADBE Position");
    const separated = pos._separationFollowers();
    if (separated != null) {
      // AE refuses `setValue` on a separated leader, but compensates
      // the followers itself on a reparent (measured on AE 2026: a
      // separated child at (150, 160) under a parent at (300, 40)
      // becomes X = -150, Y = 120), so go through them directly.
      if (separated.some((follower) => follower.keyframes?.length > 0)) {
        remapSeparatedKeyframes(pos, separated);
      } else {
        pos._setSeparatedValue(newPos, separated);
      }
    } else if (pos.keyframes?.length > 0) {
      const remap = parentRemap;
      for (const kf of pos.keyframes) {
        const kfValue = kf.value;
        const dims = kfValue.length;
        kf.value = remap.transformPoint(kfValue).slice(0, dims);
        for (const tangentAttr of ["inSpatialTangent", "outSpatialTangent"]) {
          const tangent = getMember(kf, tangentAttr);
          if (truthy(tangent)) {
            setMember(kf, tangentAttr, remap.transformVector(tangent).slice(0, tangent.length));
          }
        }
      }
    } else {
      writeCompensation("ADBE Position", newPos);
    }

    if (this._ldta.layerType === LayerType.CAMERA || this._ldta.layerType === LayerType.LIGHT) {
      // A camera or light keeps its point of interest in the Anchor
      // Point slot, in its parent's space: AE 2026 remaps it like
      // Position (a two-node camera's POI [900, 500, 0] under a null at
      // [700, 400, -100] turned 30 degrees about Y became
      // [123.2, 100, 186.6]).
      const poi = transform.property("ADBE Anchor Point");
      if (poi.keyframes?.length > 0) {
        for (const kf of poi.keyframes) {
          const kfValue = kf.value;
          kf.value = parentRemap.transformPoint(kfValue).slice(0, kfValue.length);
        }
      } else {
        const remapped = parentRemap.transformPoint(anchor).slice(0, anchor.length);
        if (!valueEquals(remapped, anchor)) poi.value = remapped;
      }
      if (rigAimsAtPoi(this)) {
        // The look-at toward the remapped POI already turns the rig;
        // AE leaves its Orientation alone.
        return;
      }
    }

    if (this.autoOrient === AutoOrientType.ALONG_PATH) {
      // The path, remapped with Position, carries the parent's turn;
      // AE 2026 leaves the rotations alone (a 2D layer's Rotate Z and
      // a 3D layer's Orientation, animated path or static).
      return;
    }
    const rotationDelta = rotationPart(squarePixels(newParentWorld, ...newAspects))
      .inverse()
      .multiply(rotationPart(squarePixels(oldParentWorld, ...oldAspects)));
    if (!is3d) {
      // A 2D layer has no Orientation to use, so AE puts the rotation
      // into Rotate Z (measured: a 2D child under a 30-degree parent
      // gets rotZ = -30 and orientation stays [0,0,0]).
      const rotation = transform.property("ADBE Rotate Z");
      if (rotation.keyframes?.length > 0) {
        // AE offsets every rotation keyframe rather than giving up on
        // an animated one - keys of 15 and 75 under a 30-degree
        // parent became -15 and 45. Skipping them, as
        // `writeCompensation` does, left the layer 35 px out.
        // As a signed turn, not the 0-360 form `composeOrientation`
        // returns: AE stores -15 and 45, not 345 and 405.
        const offset =
          ((((composeOrientation([0.0, 0.0, 0.0], rotationDelta)[2] + 180.0) % 360.0) + 360.0) % 360.0) - 180.0;
        for (const keyframe of rotation.keyframes) {
          keyframe.value = keyframe.value + offset;
        }
        return;
      }
      writeCompensation("ADBE Rotate Z", newRz);
      return;
    }

    // A 3D layer is compensated entirely through Orientation:
    // `O_new = parent_rotation^-1 . O_old`, with Rotate X/Y/Z left
    // exactly as they were. Verified on AE 2026 over ten cases.
    //
    // This is not just a different way to store the same result. Writing
    // the rotations instead collides with `writeCompensation` skipping
    // keyframed properties: a child with a keyframed Rotate Z would get
    // its position compensated but not its rotation, and jump by 362 px
    // in a case where AE does not move it at all.
    const orientationProp = transform.property("ADBE Orientation");
    if (orientationProp.keyframes?.length > 0) {
      for (const keyframe of orientationProp.keyframes) {
        keyframe.value = composeOrientation(keyframe.value, rotationDelta);
      }
      return;
    }
    const rotated = composeOrientation(orientation, rotationDelta);
    if (!valueEquals(orientationProp.value, rotated)) orientationProp.value = rotated;
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
   * @param newParent - The new parent layer, or `null` to unparent.
   * @throws {@link ValueError} If `newParent` is this layer itself, one of its descendants, or a
   *   layer in another composition.
   */
  setParentWithJump(newParent: Layer | null): void {
    this._validateParent(newParent);
    this._parentId = newParent != null ? newParent.id : 0;
  }

  /**
   * Return whether the layer is active at the given time.
   *
   * For this method to return `true`, three conditions must be met:
   *
   * 1. The layer must be `enabled`.
   * 2. No other layer in the {@link containingComp} may be soloed unless
   *    this layer is also {@link solo}.
   * 3. `time` must fall between {@link inPoint} (inclusive) and
   *    {@link outPoint} (exclusive).
   *
   * @param time - The time in seconds.
   */
  activeAtTime(time: number): boolean {
    validateNumber(time);
    if (!this.enabled) return false;

    const anySolo = this.containingComp.soloLayers?.length > 0;
    if (anySolo && !this.solo) return false;

    if (time < this.inPoint || time >= this.outPoint) return false;

    return true;
  }

  /**
   * Layer time of a composition time written to the in or out point.
   *
   * AE first snaps the time to the layer's tick grid, a tie rounding up
   * (measured on AE 2026: 2.5 / 24576 s becomes 3 / 24576 s on a 24 fps
   * layer, 1 / 36864 s stays put at 150 %).
   */
  _layerRelative(value: number): number {
    const timebase = this._layerTimebase();
    const snapped = Math.floor(value * timebase + 0.5) / timebase;
    return (snapped - this._timeOrigin) / this._stretchFactor;
  }

  /** Write a new in_point (comp time) to the binary chunk. */
  _setRawInPoint(value: number): void {
    this._ldta.inPoint = this._layerRelative(value);
  }

  /** Write a new out_point (comp time) to the binary chunk. */
  _setRawOutPoint(value: number): void {
    this._ldta.outPoint = this._layerRelative(value);
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
    const comp = this.containingComp;
    const removedId = this.id;

    // Unparent children - triggers transform recalculation via the
    // parent setter so the child doesn't visually jump.
    for (const layer of comp.layers) {
      if (layer !== this && layer._parentId === removedId) {
        layer.parent = null;
      }
    }

    // Clean track matte refs on AV layers
    for (const layer of comp.avLayers) {
      if (layer !== this) {
        const ldta = layer._ldta;
        if ("matteLayerId" in ldta && ldta.matteLayerId === removedId) {
          ldta.matteLayerId = 0;
        }
      }
    }

    // Update source _used_in if this layer references a source item
    comp._project._ensureUsedInLinked();
    const source = this._sourceItem;
    if (source != null && "_usedIn" in source) {
      _avLayer._unregisterSourceUsage(source, comp, { exclude: this });
    }

    // Remove chunk block from comp's chunk list
    const [start, end] = comp._layerBlockSlice(this);
    const removed = comp._itemList.chunks.splice(start, end - start);
    rehomeEffectDefinitions(comp._project, _effectInstances(removed));

    // Remove from model list and rebuild caches
    _listRemove(comp._layers, this);
    comp._invalidateLayerCache();
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
    return this._cloneInto(this.containingComp, { duplicate: true });
  }

  /**
   * Copy this layer into a composition, as After Effects' `copyToComp()`
   * does.
   *
   * The copy is placed at the top of the target layer stack. Its parent
   * is cleared and its transform rewritten so it keeps its place (the
   * parent's transform at time 0 is baked in, whatever the playhead),
   * and the layers its effects reference are cleared - also when the
   * target is this layer's own {@link containingComp} (use {@link duplicate}
   * to keep them). Into another composition the track matte and an
   * environment light's source are cleared too, and keyframe and
   * marker times are kept in seconds whatever the target's frame rate
   * (measured on AE 2026).
   *
   * @param intoComp - The target {@link CompItem}.
   * @returns The newly created {@link Layer} in the target composition.
   */
  copyToComp(intoComp: CompItem): Layer {
    // Circular: models.items.composition -> models.layers -> layer
    if (!(intoComp instanceof _composition.CompItem)) {
      throw new ValueError("Target composition must be a CompItem.");
    }
    return this._cloneInto(intoComp, { duplicate: false });
  }

  /**
   * Clone this layer's chunks into `intoComp` and parse the copy:
   * a {@link duplicate} (directly above, references kept) or a
   * {@link copyToComp} (on top, references cleared).
   */
  _cloneInto(intoComp: CompItem, kw: { duplicate: boolean }): Layer {
    const { duplicate } = kw;

    const sameComp = intoComp === this.containingComp;
    // Names before the copy joins the comp: it only clashes with others.
    const existing = new Set<string>(intoComp.layers.map((lyr) => lyr.name));
    const oldTimebase = this._layerTimebase();
    // The copy keeps its place without its parent: AE bakes the parent's
    // transform at time 0 into it, whatever the playhead (measured on
    // AE 2026: a child at [960, 540] under a parent at [100, 100] with
    // anchor [100, 50] lands at [960, 590]; with the playhead at 0.5 s,
    // an animated parent is still taken at 0).
    let unparent: [Mat4, Mat4, [number, number]] | null = null;
    if (!duplicate && this.parent != null) {
      const is3d = this.is3d;
      const srcComp = this.containingComp;
      unparent = [
        buildWorldMatrix(this, 0.0, !is3d),
        _parentWorld(this.parent, 0.0, is3d),
        [srcComp.pixelAspect, positionSpaceAspect(this.parent, srcComp)],
      ];
    }

    // Clone the full layer block (LIST:Layr + trailing view chunks)
    const [srcStart, srcEnd] = this.containingComp._layerBlockSlice(this);
    const srcBlock = this.containingComp._itemList.chunks.slice(srcStart, srcEnd);
    // The block starts at this layer's own LIST:Layr.
    const clonedList = cloneChunkTree(this._layerList);
    const clonedBlock = [clonedList, ...srcBlock.slice(1).map((c) => cloneChunkTree(c))];

    // Patch layer ID
    const clonedLdta = findByType(clonedList.chunks, "ldta");
    // Layer IDs are unique project-wide, not per-comp.
    clonedLdta.layerId = intoComp._project._allocateId();
    // AE points every effect's hidden -0000 param tdpi at the owning
    // layer; retarget the clones at the fresh id (layer-reference
    // tdpi values keep pointing at the originally referenced layer).
    rewriteOwnerTdpi(clonedList, clonedLdta.layerId);

    // Determine chunk insertion point
    let modelIdx: number;
    let chunkIdx: number;
    if (duplicate) {
      modelIdx = _listIndex(intoComp._layers, this);
      chunkIdx = srcStart;
    } else {
      // AE's copyToComp clears the parent and the effect layer
      // references even within the same comp; the matte (a pre-AE 23
      // record has no matte field and must stay that size) and an
      // environment light's source only when they would point into
      // another comp.
      clonedLdta.parentId = 0;
      if (!sameComp) {
        if (clonedLdta.matteLayerId != null) clonedLdta.matteLayerId = 0;
        if (clonedLdta.layerType === LayerType.LIGHT) {
          clonedLdta.sourceId = _noSourceId(intoComp);
        }
      }
      // A LAYER parameter (Set Matte, Layer Control, CC Sphere's light
      // layer, ...) names a layer of the SOURCE comp; left as-is the
      // destination comp cannot resolve it and AE refuses the whole file
      // ("Can't find layer ID=N in composition X"). AE 2026 writes 0 -
      // "no layer" - into the copy's parameter.
      remapLayerRefTdpi(clonedList, new Map());
      // tdb4 carries the comp the property was written in; AE restamps
      // the copy to the destination comp (measured: copyToComp from a
      // 25 fps comp into a 24 fps one writes 24576, not 25600). The
      // layer's own stretch scales it, exactly as `_layerTimebase`
      // derives it - a 200 % layer counts ticks against twice the
      // comp's base.
      rewriteTimeBase(
        clonedList,
        this._layerTimebase(intoComp._cdta.internalTimebase),
      );
      modelIdx = 0;
      if (intoComp.layers.length > 0) {
        chunkIdx = indexByIdentity(
          intoComp._itemList.chunks,
          intoComp.layers[0]._layerList,
        );
      } else {
        chunkIdx = intoComp._findFirstLayerPosition();
      }
    }
    intoComp._itemList.chunks.splice(chunkIdx, 0, ...clonedBlock);

    // Re-parse cloned chunks into a model instance
    const effectDefs = intoComp._project._effectParamDefs;
    const newLayer = late.parseLayer(clonedList, intoComp, effectDefs);

    intoComp._layers.splice(modelIdx, 0, newLayer);

    if (!sameComp) {
      this._carryCompRelativeTransform(newLayer);
      // Keyframe ticks count against the layer's timebase; keep every
      // key (markers included) at the same second, as AE does (a key
      // at 1 s copied from 25 to 24 fps stays at 1 s).
      newLayer._retimeToLayerTimebase(oldTimebase, newLayer._layerTimebase());
    }
    if (unparent != null) {
      // Unparented as in the source comp: the copy carries those values
      // whatever the target's pixel aspect (AE 2026 keeps Scale 100
      // copying into a 2:1 comp).
      const [childWorld, parentWorld, oldAspects] = unparent;
      const sourceAspect = oldAspects[0];
      newLayer._compensateReparent(
        null,
        childWorld,
        parentWorld,
        Mat4.identity(),
        0.0,
        oldAspects,
        [sourceAspect, sourceAspect],
      );
    }

    // Increment user-defined name
    if (newLayer.isNameSet && existing.has(newLayer.name)) {
      newLayer.name = autoName(newLayer.name, existing);
    }

    intoComp._invalidateLayerCache();

    // Register source _used_in for the cloned layer
    intoComp._project._ensureUsedInLinked();
    const newSource = newLayer._sourceItem;
    if (newSource != null && "_usedIn" in newSource) {
      newSource._usedIn.add(intoComp);
    }

    return newLayer;
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
  _carryCompRelativeTransform(copy: Layer): void {
    const srcTransform = this.transform;
    const dstTransform = copy.transform;
    if (srcTransform == null || dstTransform == null) return;
    for (const matchName of this.constructor._COMP_RELATIVE_TRANSFORM) {
      let srcProp: Property | PropertyGroup;
      let dstProp: Property | PropertyGroup;
      try {
        srcProp = srcTransform.property(matchName);
        dstProp = dstTransform.property(matchName);
      } catch (e) {
        if (!(e instanceof KeyError || e instanceof ValueError)) throw e;
        continue;
      }
      if (!(srcProp instanceof Property) || !(dstProp instanceof Property)) continue;
      // An animated property carries real chunks that the clone copied
      // verbatim, so there is nothing to carry over.
      if (srcProp.keyframes?.length > 0 || dstProp.keyframes?.length > 0) continue;
      const value = srcProp.value;
      if (value == null || valueEquals(value, dstProp.value)) continue;
      dstProp.value = value;
    }
  }

  /**
   * Moves this layer to a position immediately after (below)
   * the specified layer.
   *
   * @param layer - The target layer in the same composition.
   */
  moveAfter(layer: Layer): void {
    if (!(layer instanceof Layer)) throw new ValueError("Target must be a Layer.");

    const comp = this.containingComp;
    if (layer.containingComp !== comp) {
      throw new ValueError("Target layer must be in the same composition.");
    }
    const selfIdx = _listIndex(comp._layers, this);
    const targetIdx = _listIndex(comp._layers, layer);
    // After self is removed, target shifts left by 1 if self was before it
    const effective = targetIdx - (selfIdx < targetIdx ? 1 : 0);
    this._moveTo(effective + 1);
  }

  /**
   * Moves this layer to a position immediately before (above)
   * the specified layer.
   *
   * @param layer - The target layer in the same composition.
   */
  moveBefore(layer: Layer): void {
    if (!(layer instanceof Layer)) throw new ValueError("Target must be a Layer.");

    const comp = this.containingComp;
    if (layer.containingComp !== comp) {
      throw new ValueError("Target layer must be in the same composition.");
    }
    const selfIdx = _listIndex(comp._layers, this);
    const targetIdx = _listIndex(comp._layers, layer);
    const effective = targetIdx - (selfIdx < targetIdx ? 1 : 0);
    this._moveTo(effective);
  }

  /** Moves this layer to the topmost position of the composition. */
  moveToBeginning(): void {
    this._moveTo(0);
  }

  /** Moves this layer to the bottommost position of the composition. */
  moveToEnd(): void {
    this._moveTo(this.containingComp.layers.length);
  }

  /**
   * Move this layer to the given model-list index.
   *
   * Uses direct chunk slice extraction and reinsertion, never
   * `remove()`, so parent and track matte connections on other
   * layers are preserved.
   */
  _moveTo(targetIndex: number): void {
    const comp = this.containingComp;

    // Extract and remove chunk block
    const [start, end] = comp._layerBlockSlice(this);
    const block = comp._itemList.chunks.slice(start, end);
    comp._itemList.chunks.splice(start, end - start);

    _listRemove(comp._layers, this);

    // Clamp target index
    targetIndex = Math.min(targetIndex, comp._layers.length);

    // Find chunk insertion point
    let chunkIdx: number;
    if (targetIndex < comp._layers.length) {
      chunkIdx = indexByIdentity(
        comp._itemList.chunks,
        comp._layers[targetIndex]._layerList,
      );
    } else if (comp._layers.length > 0) {
      const [, lastEnd] = comp._layerBlockSlice(comp._layers[comp._layers.length - 1]);
      chunkIdx = lastEnd;
    } else {
      chunkIdx = comp._findFirstLayerPosition();
    }

    // Insert block and model entry
    comp._itemList.chunks.splice(chunkIdx, 0, ...block);
    comp._layers.splice(targetIndex, 0, this);

    comp._invalidateLayerCache();
  }

  _isLayer(): this is Layer {
    return true;
  }

  /** Whether this is an AV layer (`AVLayer` answers true). */
  _isAVLayer(): this is AVLayer {
    return false;
  }

  static {
    // Descriptors for the `declare`d fields above.
    descriptor(this, "enabled", ChunkField.bool("_ldta", "enabled"));
    descriptor(this, "id", new ChunkField("_ldta", "layerId", { readOnly: true }));
    descriptor(this, "label", ChunkField.enum(Label, "_ldta", "label"));
    descriptor(this, "locked", ChunkField.bool("_ldta", "locked"));
    descriptor(this, "nullLayer", new ChunkField("_ldta", "nullLayer", { readOnly: true }));
    descriptor(this, "_parentId", new ChunkField("_ldta", "parentId"));
    descriptor(this, "shy", ChunkField.bool("_ldta", "shy"));
    descriptor(this, "solo", ChunkField.bool("_ldta", "solo"));
    descriptor(this, "_stretch", new ChunkField("_ldta", "stretch"));
    descriptor(this, "autoOrient", ChunkField.enum(AutoOrientType, "_ldta", "autoOrient"));
  }
}

// `_tree_param_defs: ... = None` in the class body: on the prototype, so
// `_missingAttribute` finds it before the instance sets its own.
Layer.prototype._treeParamDefs = null;
