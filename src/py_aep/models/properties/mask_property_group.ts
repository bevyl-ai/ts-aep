import { get_ae_version_major } from "../../ae_version.ts";
import { ListChunk } from "../../binary/chunk.ts";
import { MkifChunk } from "../../binary/misc_chunks.ts";
import { build_default_mask_shape } from "../../binary/mutations.ts";
import { TdmnChunk, TdsbChunk, TdsnChunk } from "../../binary/property_chunks.ts";
import { find_by_list_type, find_by_type } from "../../binary/utils.ts";
import { MaskFeatherFalloff, MaskMode, MaskMotionBlur } from "../../enums/index.ts";
import { keyframe_tensions } from "../../resolvers/roto_bezier.ts";
import { ChunkField } from "../descriptors.ts";
import { validate_bool, validate_rgb_color } from "../validators.ts";
// NOTE(port): property_group.ts reaches this module only through `deferred(...)` (the
// port of Python's in-method import), so `extends PropertyGroup` evaluates after it.
import { PropertyGroup, _insert_before_group_end } from "./property_group.ts";
import { AttributeError, deferred, descriptor, mod, py_assert, instance_dict } from "../../../pyrt/index.ts";
import type { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import type { Property } from "./property.ts";
import type { Shape } from "./shape.ts";

const _property = deferred<typeof import("../../parsers/property.ts")>("py_aep/parsers/property");
const _property_model = deferred<typeof import("./property.ts")>("py_aep/models/properties/property");
const _av_layer = deferred<typeof import("../layers/av_layer.ts")>("py_aep/models/layers/av_layer");

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
  declare mask_feather_falloff: MaskFeatherFalloff;

  /**
   * The blending mode for the mask. Controls how the mask interacts with
   * other masks and with the layer below. Read / Write.
   */
  declare mask_mode: MaskMode;

  /** How motion blur is applied to this mask. Read / Write. */
  declare mask_motion_blur: MaskMotionBlur;

  declare _mkif: MkifChunk;
  declare _mask_shape_tdsb: TdsbChunk | null;

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
   * (`resolvers.roto_bezier`), not the stored direction handles.
   *
   * As in After Effects, switching it on keeps every vertex without
   * direction handles a corner (tension 1) and smooths the others
   * (tension 1/3), and switching it off keeps the drawn tangents as the
   * handles. A path value assigned while it is on draws straight
   * segments (tension 1 at every vertex) unless it is a value read from
   * a RotoBezier mask, which keeps its own tensions.
   */
  get roto_bezier(): boolean {
    const tdsb = this._mask_shape_tdsb;
    return tdsb != null ? !!tdsb.roto_bezier : false;
  }

  set roto_bezier(value: boolean) {
    validate_bool(value);
    if (this._mask_shape_tdsb == null) {
      if (!value) {
        // Already the default; AE writes no Mask Shape for this state.
        return;
      }
      // The default path carries tension 1 per vertex, as AE writes it.
      this._materialize_mask_shape({ roto_bezier: true });
      return;
    }
    if (!!this._mask_shape_tdsb.roto_bezier === value) {
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
        keyframe_tensions([], s._stored_tangents(-1), s._stored_tangents(1)),
      );
      this._mask_shape_tdsb.roto_bezier = true;
      for (const [i, shape] of shapes.entries()) {
        shape._set_tensions(tensions[i]);
        shape._write_geometry(shape.vertices, shape.in_tangents, shape.out_tangents);
      }
    } else {
      // Switching it off (AE 2026) keeps the drawn tangents as the
      // handles and drops the tensions.
      const drawn = shapes.map((s) => [s.in_tangents, s.out_tangents] as const);
      this._mask_shape_tdsb.roto_bezier = false;
      for (const [i, shape] of shapes.entries()) {
        const [ins, outs] = drawn[i];
        shape._set_tensions([]);
        shape._write_geometry(shape.vertices, ins, outs);
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
   * @param parent_property - The Masks parade group to add the atom to.
   * @param property_depth - The depth of the mask atom in the tree.
   * @param kw - Options:
   * - `name`: The display name, stored in the `tdsn` (AE bakes the positional `Mask N` name at
   *     creation).
   * - `mask_id`: 1-based creation id, stored in the `mkif` and used to pick the outline color from
   *     the cycle palette.
   */
  static _new(
    parent_property: PropertyGroup,
    property_depth: number,
    kw: { name: string; mask_id: number },
  ): MaskPropertyGroup;
  static _new(...args: never[]): never;
  static _new(
    parent_property: PropertyGroup,
    property_depth: number,
    kw: { name: string; mask_id: number },
  ): MaskPropertyGroup {
    const { name, mask_id } = kw;
    const color = _MASK_COLOR_CYCLE[mod(mask_id - 1, _MASK_COLOR_CYCLE.length)];
    const _tdmn = new TdmnChunk({ value: "ADBE Mask Atom" });
    const _mkif = new MkifChunk({
      mode: 1, // binary PF_MaskMode for MaskMode.ADD
      mask_id: mask_id,
      color_r: color[0],
      color_g: color[1],
      color_b: color[2],
    });
    const _tdsb = new TdsbChunk();
    const tdsn = TdsnChunk.new_(name);
    const name_utf8 = tdsn.utf8;
    const group_end = new TdmnChunk({ value: "ADBE Group End" });
    const _tdgp = new ListChunk({ list_type: "tdgp", chunks: [_tdsb, tdsn, group_end] });

    const parent_tdgp = parent_property._tdgp;
    py_assert(parent_tdgp != null);
    _insert_before_group_end(parent_tdgp, _tdmn);
    _insert_before_group_end(parent_tdgp, _mkif);
    _insert_before_group_end(parent_tdgp, _tdgp);

    const mask = new this({
      _tdmn,
      _tdgp,
      _tdsb,
      _mkif,
      _mask_shape_tdsb: null,
      _name_utf8: name_utf8,
      match_name: "ADBE Mask Atom",
      property_depth,
      auto_name: name,
      properties: [],
    });
    mask._parent_property = parent_property;
    mask._is_mask = true;
    // Children are filled from _MASK_ATOM_SPECS on first access.
    mask._deferred_ae_major = get_ae_version_major(parent_property._containing_layer);
    return mask;
  }

  constructor(kw: {
    _tdmn: TdmnChunk;
    _tdgp: ListChunk;
    _tdsb: TdsbChunk | null;
    _mkif: MkifChunk;
    _mask_shape_tdsb: TdsbChunk | null;
    _name_utf8?: Utf8Chunk | null;
    match_name: string;
    property_depth: number;
    auto_name?: string | null;
    properties: (Property | PropertyGroup)[];
  }) {
    const {
      _tdmn,
      _tdgp,
      _tdsb,
      _mkif,
      _mask_shape_tdsb,
      _name_utf8 = null,
      match_name,
      property_depth,
      auto_name = null,
      properties,
    } = kw;
    super({
      _tdmn,
      _tdgp,
      _tdsb,
      _name_utf8,
      match_name,
      auto_name,
      property_depth,
      properties,
    });
    this._mkif = _mkif;
    this._mask_shape_tdsb = _mask_shape_tdsb;
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
  _materialize_mask_shape(kw: { roto_bezier?: boolean } = {}): void {
    const { roto_bezier = false } = kw;
    this._ensure_materialized();
    this._ensure_children_synthesized();
    py_assert(this._tdgp != null);
    const layer = this._containing_layer;
    const comp = layer.containing_comp;
    if (!(layer instanceof _av_layer().AVLayer)) throw new AttributeError("_mask_scale");
    const [width, height] = layer._mask_scale;
    const source = layer.source;
    // AE stamps the mask space's display aspect, so a non-square source
    // pixel aspect counts (measured on AE-saved projects). Headless AE
    // 2026 writes 1.0 instead on a layer it loaded from disk, whatever
    // the first write (path, key, expression, RotoBezier), yet the
    // aspect on one created in the same session. RotoBezier tangents are
    // measured in this space, so 1.0 would bend them: keep the aspect.
    const pixel_aspect = source != null ? source.pixel_aspect : 1.0;
    const [tdmn, oms] = build_default_mask_shape(comp._cdta.internal_timebase, {
      aspect: (width * pixel_aspect) / height,
      roto_bezier,
    });

    // Synthesis inserts a bare synthetic `tdmn + tdbs` placeholder for
    // every child; replace the Mask Shape placeholder in place with the
    // real full-frame om-s (the other children stay synthetic, skipped
    // on write, exactly as AE leaves them).
    const chunks = this._tdgp.chunks;
    const found_at = chunks.findIndex(
      (c) =>
        c.chunk_type === "tdmn" &&
        "value" in c && c.value === "ADBE Mask Shape" &&
        c.synthetic,
    );
    const insert_at = found_at >= 0 ? found_at : chunks.length;
    if (found_at >= 0) {
      chunks.splice(found_at, 2);
    }
    chunks.splice(insert_at, 0, tdmn);
    chunks.splice(insert_at + 1, 0, oms);

    // Rebind the Mask Path child to the inserted om-s via the canonical
    // parser, so its value and tdsb reflect the materialized path.
    const parsed = _property().parse_properties(
      [["ADBE Mask Shape", [tdmn, oms]]],
      this.property_depth + 1,
      new Map(),
      comp,
      layer,
    );
    const mask_path = parsed[0];
    mask_path._parent_property = this;
    // Transplant the freshly parsed state onto the EXISTING Mask Shape
    // child rather than swapping in a new object, so a handle a caller
    // fetched before materialization keeps pointing at the live chunks.
    // A plain swap would orphan that handle - its backing placeholder
    // chunks were deleted above, so later writes through it would never
    // reach the saved file.
    const existing = this._properties.find((c) => c.match_name === "ADBE Mask Shape") ?? null;
    if (existing != null) {
      // `existing.__dict__.update(mask_path.__dict__)`: plain own attributes, plus the
      // `instance_dict` Map (non-enumerable, so Object.assign alone would skip it).
      Object.assign(existing, mask_path);
      for (const [k, v] of instance_dict(mask_path)) instance_dict(existing).set(k, v);
      if (!(existing instanceof _property_model().Property)) throw new AttributeError("_link_keyframes");
      existing._link_keyframes();
    } else {
      this._properties.splice(0, 0, mask_path);
    }
    const tdbs = find_by_list_type(oms.chunks, "tdbs");
    this._mask_shape_tdsb = find_by_type(tdbs.chunks, "tdsb");
  }
}

// Python class attributes built from ChunkField descriptors. `declare` above keeps
// them out of the emitted class body; `descriptor` installs the accessors after it.
descriptor(
  MaskPropertyGroup,
  "color",
  new ChunkField("_mkif", "color", { validate: validate_rgb_color }),
);
descriptor(MaskPropertyGroup, "inverted", ChunkField.bool("_mkif", "inverted"));
descriptor(MaskPropertyGroup, "locked", ChunkField.bool("_mkif", "locked"));
descriptor(
  MaskPropertyGroup,
  "mask_feather_falloff",
  ChunkField.enum(MaskFeatherFalloff, "_mkif", "mask_feather_falloff"),
);
descriptor(MaskPropertyGroup, "mask_mode", ChunkField.enum(MaskMode, "_mkif", "mode"));
descriptor(
  MaskPropertyGroup,
  "mask_motion_blur",
  ChunkField.enum(MaskMotionBlur, "_mkif", "mask_motion_blur"),
);
