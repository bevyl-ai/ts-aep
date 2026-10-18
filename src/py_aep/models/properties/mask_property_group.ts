import { getAeVersionMajor } from "../../ae_version.ts";
import { ListChunk } from "../../binary/chunk.ts";
import { MkifChunk } from "../../binary/misc_chunks.ts";
import { buildDefaultMaskShape } from "../../binary/mutations.ts";
import { TdmnChunk, TdsbChunk, TdsnChunk } from "../../binary/property_chunks.ts";
import { findByListType, findByType } from "../../binary/utils.ts";
import { MaskFeatherFalloff, MaskMode, MaskMotionBlur } from "../../enums/index.ts";
import { keyframeTensions } from "../../resolvers/roto_bezier.ts";
import { ChunkField } from "../descriptors.ts";
import { validateBool, validateRgbColor } from "../validators.ts";
// property_group.ts reaches this module only through `late` (models/late.ts), so
// `extends PropertyGroup` evaluates after it.
import { PropertyGroup, _insertBeforeGroupEnd } from "./property_group.ts";
import { AttributeError, descriptor, mod, assert, instanceDict } from "../../../pyrt/index.ts";
import type { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import type { Property } from "./property.ts";
import type { Shape } from "./shape.ts";
import * as _property from "../../parsers/property.ts";
import * as _propertyModel from "./property.ts";
import * as _avLayer from "../layers/av_layer.ts";
import { late } from "../late.ts";

// Mask outline colors cycled by creation index for new masks. AE picks
// from the label colors via an app-global counter that persists across
// sessions, so its exact choice is not reproducible from file content;
// py_aep cycles the same palette deterministically instead (RGB bytes,
// observed on AE 2026 defaults).
export const _MASK_COLOR_CYCLE: readonly (readonly [number, number, number])[] = [
  [30, 64, 30],
  [181, 56, 56],
  [228, 216, 76],
  [169, 203, 199],
  [229, 188, 201],
  [169, 169, 202],
  [231, 193, 158],
  [179, 199, 179],
];

/**
 * An individual mask applied to a layer.
 *
 * The `MaskPropertyGroup` object encapsulates mask attributes in a layer.
 *
 * Info:
 *     `MaskPropertyGroup` is a subclass of PropertyGroup object. All methods and
 *     attributes of {@link PropertyBase | PropertyBase}
 *     object and {@link PropertyGroup}, in addition to those listed below, are available
 *     when working with `MaskPropertyGroup`.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const layer = comp.layers[0];
 * const mask = layer.masks[0];
 * console.log(mask.inverted);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/property/maskpropertygroup/
 */
export class MaskPropertyGroup extends PropertyGroup {
  /**
   * The color used to draw the mask outline as it appears in the user
   * interface (Composition panel, Layer panel, and Timeline panel).
   * The three array values specify the red, green, and blue components
   * of the color. Read / Write.
   */
  declare color: number[];

  /** When `true`, the mask is inverted. Read / Write. */
  declare inverted: boolean;

  /**
   * When `true`, the mask is locked and cannot be edited in the user
   * interface. Read / Write.
   */
  declare locked: boolean;

  /**
   * The feather falloff mode for the mask. Applies to all feather
   * values for the mask. Read / Write.
   */
  declare maskFeatherFalloff: MaskFeatherFalloff;

  /**
   * The blending mode for the mask. Controls how the mask interacts with
   * other masks and with the layer below. Read / Write.
   */
  declare maskMode: MaskMode;

  /** How motion blur is applied to this mask. Read / Write. */
  declare maskMotionBlur: MaskMotionBlur;

  declare _mkif: MkifChunk;
  declare _maskShapeTdsb: TdsbChunk | null;

  /**
   * When `true`, the mask uses RotoBezier, enabling curved mask segments
   * without direction handles. Read / Write.
   *
   * The flag lives in the Mask Shape's `tdsb`. A freshly added mask has
   * no Mask Shape subtree (AE treats it as the implicit default
   * full-frame rectangle), so enabling RotoBezier materializes that
   * default path - mirroring what After Effects writes.
   *
   * While it is on, the Mask Path's {@link Shape} reports the tangents AE
   * derives from the vertices and their stored tensions
   * (`resolvers.rotoBezier`), not the stored direction handles.
   *
   * As in After Effects, switching it on keeps every vertex without
   * direction handles a corner (tension 1) and smooths the others
   * (tension 1/3), and switching it off keeps the drawn tangents as the
   * handles. A path value assigned while it is on draws straight
   * segments (tension 1 at every vertex) unless it is a value read from
   * a RotoBezier mask, which keeps its own tensions.
   */
  get rotoBezier(): boolean {
    const tdsb = this._maskShapeTdsb;
    return tdsb != null ? !!tdsb.rotoBezier : false;
  }

  set rotoBezier(value: boolean) {
    validateBool(value);
    if (this._maskShapeTdsb == null) {
      if (!value) {
        // Already the default; AE writes no Mask Shape for this state.
        return;
      }
      // The default path carries tension 1 per vertex, as AE writes it.
      this._materializeMaskShape({ rotoBezier: true });
      return;
    }
    if (!!this._maskShapeTdsb.rotoBezier === value) {
      return;
    }
    const path = this.property("ADBE Mask Shape");
    const shapes = (
      path.keyframes?.length > 0 ? path.keyframes.map((kf) => kf.value) : [path.value]
    );
    if (value) {
      // Measured on AE 2026: switching RotoBezier on gives each vertex
      // of every key tension 1 when both its handles are zero (it stays
      // a corner) and 1/3 otherwise, then stores the tangents those
      // tensions draw as the handles.
      const tensions = shapes.map((s) =>
        keyframeTensions([], s._storedTangents(-1), s._storedTangents(1)),
      );
      this._maskShapeTdsb.rotoBezier = true;
      for (const [i, shape] of shapes.entries()) {
        shape._setTensions(tensions[i]);
        shape._writeGeometry(shape.vertices, shape.inTangents, shape.outTangents);
      }
    } else {
      // Switching it off (AE 2026) keeps the drawn tangents as the
      // handles and drops the tensions.
      const drawn = shapes.map((s) => [s.inTangents, s.outTangents] as const);
      this._maskShapeTdsb.rotoBezier = false;
      for (const [i, shape] of shapes.entries()) {
        const [ins, outs] = drawn[i];
        shape._setTensions([]);
        shape._writeGeometry(shape.vertices, ins, outs);
      }
    }
  }

  // NOTE(port): Python `_new` has `# type: ignore[override]`; the `never` overload is
  // the TS equivalent (the keyword-only signature differs from PropertyGroup._new).
  /**
   * Create a new mask atom with backing chunks, as AE writes it.
   *
   * A freshly added mask has no Mask Shape subtree in binary: AE
   * treats the bare atom as the default full-frame rectangle path,
   * and the child properties (Mask Path, Feather, Opacity,
   * Expansion) are synthesized on first access, like a fresh parse.
   *
   * @param parentProperty - The Masks parade group to add the atom to.
   * @param propertyDepth - The depth of the mask atom in the tree.
   * @param kw - Options:
   * - `name`: The display name, stored in the `tdsn` (AE bakes the positional `Mask N` name at
   *     creation).
   * - `maskId`: 1-based creation id, stored in the `mkif` and used to pick the outline color from
   *     the cycle palette.
   */
  static _new(
    parentProperty: PropertyGroup,
    propertyDepth: number,
    kw: { name: string; maskId: number },
  ): MaskPropertyGroup;
  static _new(...args: never[]): never;
  static _new(
    parentProperty: PropertyGroup,
    propertyDepth: number,
    kw: { name: string; maskId: number },
  ): MaskPropertyGroup {
    const { name, maskId } = kw;
    const color = _MASK_COLOR_CYCLE[mod(maskId - 1, _MASK_COLOR_CYCLE.length)];
    const _tdmn = new TdmnChunk({ value: "ADBE Mask Atom" });
    const _mkif = new MkifChunk({
      mode: 1, // binary PF_MaskMode for MaskMode.ADD
      maskId,
      colorR: color[0],
      colorG: color[1],
      colorB: color[2],
    });
    const _tdsb = new TdsbChunk();
    const tdsn = TdsnChunk.new_(name);
    const nameUtf8 = tdsn.utf8;
    const groupEnd = new TdmnChunk({ value: "ADBE Group End" });
    const _tdgp = new ListChunk({ listType: "tdgp", chunks: [_tdsb, tdsn, groupEnd] });

    const parentTdgp = parentProperty._tdgp;
    assert(parentTdgp != null);
    _insertBeforeGroupEnd(parentTdgp, _tdmn);
    _insertBeforeGroupEnd(parentTdgp, _mkif);
    _insertBeforeGroupEnd(parentTdgp, _tdgp);

    const mask = new this({
      _tdmn,
      _tdgp,
      _tdsb,
      _mkif,
      _maskShapeTdsb: null,
      _nameUtf8: nameUtf8,
      matchName: "ADBE Mask Atom",
      propertyDepth,
      autoName: name,
      properties: [],
    });
    mask._parentProperty = parentProperty;
    mask._isMask = true;
    // Children are filled from _MASK_ATOM_SPECS on first access.
    mask._deferredAeMajor = getAeVersionMajor(parentProperty._containingLayer);
    return mask;
  }

  constructor(kw: {
    _tdmn: TdmnChunk;
    _tdgp: ListChunk;
    _tdsb: TdsbChunk | null;
    _mkif: MkifChunk;
    _maskShapeTdsb: TdsbChunk | null;
    _nameUtf8?: Utf8Chunk | null;
    matchName: string;
    propertyDepth: number;
    autoName?: string | null;
    properties: (Property | PropertyGroup)[];
  }) {
    const {
      _tdmn,
      _tdgp,
      _tdsb,
      _mkif,
      _maskShapeTdsb,
      _nameUtf8 = null,
      matchName,
      propertyDepth,
      autoName = null,
      properties,
    } = kw;
    super({
      _tdmn,
      _tdgp,
      _tdsb,
      _nameUtf8,
      matchName,
      autoName,
      propertyDepth,
      properties,
    });
    this._mkif = _mkif;
    this._maskShapeTdsb = _maskShapeTdsb;
  }

  /**
   * Insert the default full-frame Mask Shape AE writes when a
   * path-less mask first needs one, and rebind the Mask Path child
   * to it.
   *
   * Mirrors After Effects: a freshly added mask carries no Mask Shape
   * subtree, and enabling RotoBezier (`roto_bezier=True`) or setting a
   * plain bezier path (`false` - the tdsb roto flag stays clear, like
   * AE's own imports) materializes the implicit default full-frame
   * rectangle as an explicit path.
   */
  _materializeMaskShape(kw: { rotoBezier?: boolean } = {}): void {
    const { rotoBezier = false } = kw;
    this._ensureMaterialized();
    this._ensureChildrenSynthesized();
    assert(this._tdgp != null);
    const layer = this._containingLayer;
    const comp = layer.containingComp;
    if (!(layer instanceof _avLayer.AVLayer)) throw new AttributeError("_maskScale");
    const [width, height] = layer._maskScale;
    const source = layer.source;
    // AE stamps the mask space's display aspect, so a non-square source
    // pixel aspect counts (measured on AE-saved projects). Headless AE
    // 2026 writes 1.0 instead on a layer it loaded from disk, whatever
    // the first write (path, key, expression, RotoBezier), yet the
    // aspect on one created in the same session. RotoBezier tangents are
    // measured in this space, so 1.0 would bend them: keep the aspect.
    const pixelAspect = source != null ? source.pixelAspect : 1.0;
    const [tdmn, oms] = buildDefaultMaskShape(comp._cdta.internalTimebase, {
      // An audio-only layer has a 0x0 mask space (its default path is
      // four points at the origin) and no aspect to stamp.
      aspect: height !== 0 ? (width * pixelAspect) / height : 1.0,
      rotoBezier,
    });

    // Synthesis inserts a bare synthetic `tdmn + tdbs` placeholder for
    // every child; replace the Mask Shape placeholder in place with the
    // real full-frame om-s (the other children stay synthetic, skipped
    // on write, exactly as AE leaves them).
    const chunks = this._tdgp.chunks;
    const foundAt = chunks.findIndex(
      (c) =>
        c.chunkType === "tdmn" &&
        "value" in c && c.value === "ADBE Mask Shape" &&
        c.synthetic,
    );
    const insertAt = foundAt >= 0 ? foundAt : chunks.length;
    if (foundAt >= 0) {
      chunks.splice(foundAt, 2);
    }
    chunks.splice(insertAt, 0, tdmn);
    chunks.splice(insertAt + 1, 0, oms);

    // Rebind the Mask Path child to the inserted om-s via the canonical
    // parser, so its value and tdsb reflect the materialized path.
    const parsed = _property.parseProperties(
      [["ADBE Mask Shape", [tdmn, oms]]],
      this.propertyDepth + 1,
      new Map(),
      comp,
      layer,
    );
    const maskPath = parsed[0];
    maskPath._parentProperty = this;
    // Transplant the freshly parsed state onto the EXISTING Mask Shape
    // child rather than swapping in a new object, so a handle a caller
    // fetched before materialization keeps pointing at the live chunks.
    // A plain swap would orphan that handle - its backing placeholder
    // chunks were deleted above, so later writes through it would never
    // reach the saved file.
    const existing = this._properties.find((c) => c.matchName === "ADBE Mask Shape") ?? null;
    if (existing != null) {
      // `existing.__dict__ = mask_path.__dict__`: replace, not merge - a key
      // the parsed property leaves to its class default must not keep the
      // placeholder's value. Plain own attributes, plus the `instanceDict`
      // Map (non-enumerable, so Object.assign alone would skip it).
      for (const k of Object.keys(existing)) {
        if (!Object.prototype.hasOwnProperty.call(maskPath, k)) Reflect.deleteProperty(existing, k);
      }
      Object.assign(existing, maskPath);
      const existingDict = instanceDict(existing);
      existingDict.clear();
      for (const [k, v] of instanceDict(maskPath)) existingDict.set(k, v);
      if (!(existing instanceof _propertyModel.Property)) throw new AttributeError("_linkKeyframes");
      existing._linkKeyframes();
    } else {
      this._properties.splice(0, 0, maskPath);
    }
    const tdbs = findByListType(oms.chunks, "tdbs");
    this._maskShapeTdsb = findByType(tdbs.chunks, "tdsb");
  }

  _isMaskGroup(): this is MaskPropertyGroup {
    return true;
  }

  static {
    // Descriptors for the `declare`d fields above.
    descriptor(this, "color", new ChunkField("_mkif", "color", { validate: validateRgbColor }));
    descriptor(this, "inverted", ChunkField.bool("_mkif", "inverted"));
    descriptor(this, "locked", ChunkField.bool("_mkif", "locked"));
    descriptor(this, "maskFeatherFalloff", ChunkField.enum(MaskFeatherFalloff, "_mkif", "maskFeatherFalloff"));
    descriptor(this, "maskMode", ChunkField.enum(MaskMode, "_mkif", "mode"));
    descriptor(this, "maskMotionBlur", ChunkField.enum(MaskMotionBlur, "_mkif", "maskMotionBlur"));
  }
}

Object.assign(late, { MaskPropertyGroup });
