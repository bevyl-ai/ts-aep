/** Shape value model for mask and shape path properties. */

import {
  AttributeError,
  ValueError,
  TypeError_,
  deferred,
  mod,
  py_assert,
  floordiv,
  min,
  max,
  descriptor,
  truediv,
} from "../../../pyrt/index.ts";
import { ShapePoint } from "../../binary/ldat_chunks.ts";
import { ShphChunk, TensionItem } from "../../binary/misc_chunks.ts";
import type { FeatherPointItem, OmtnChunk } from "../../binary/misc_chunks.ts";
import { DEFAULT_TENSION, roto_bezier_tangents } from "../../resolvers/roto_bezier.ts";
import { ChunkField } from "../descriptors.ts";
import { validate_bool, validate_f4_point, validate_normalized_float, validate_positive_int } from "../validators.ts";
import type { Layer } from "../layers/layer.ts";
import type { Property } from "./property.ts";

const _av_layer = deferred<typeof import("../layers/av_layer.ts")>("py_aep/models/layers/av_layer");
const _mask_property_group = deferred<typeof import("./mask_property_group.ts")>("py_aep/models/properties/mask_property_group");

export function _interp_transform(raw: number): number {
  /** Map binary interpolation (0=non-Hold, 2=Hold) to ExtendScript (0/1). */
  return raw === 2 ? 1 : 0;
}

export function _interp_reverse(value: number): number {
  /** Map ExtendScript interpolation (0/1) back to binary (0/2). */
  return value === 1 ? 2 : 0;
}

/**
 * A single variable-width mask feather point.
 *
 * Feather points can be placed anywhere along a closed mask path to vary
 * the feather radius at different positions. Reference a specific feather
 * point by the number of the mask path segment (portion of the path
 * between adjacent vertices) where it appears.
 *
 * Tip:
 *     The feather points on a mask are listed in an array in the order
 *     that they were created.
 */
export class FeatherPoint {
  /**
   * Mask path segment number where this feather point is located
   * (0-based, segments are portions of the path between vertices).
   * Read / Write.
   */
  declare seg_loc: number;

  /**
   * Relative position on the segment, from 0.0 (at the starting
   * vertex) to 1.0 (at the next vertex). Read / Write.
   */
  declare rel_seg_loc: number;

  /**
   * Feather radius (amount). Negative values indicate inner feather
   * points; positive values indicate outer feather. Read / Write.
   */
  declare radius: number;

  /**
   * Radius interpolation type: 0 for non-Hold feather points,
   * 1 for Hold feather points. Read / Write.
   */
  declare interp: number;

  /** Feather tension amount, from 0.0 (0%) to 1.0 (100%). Read / Write. */
  declare tension: number;

  /**
   * Relative angle percentage between the two normals on either side
   * of a curved outer feather boundary at a corner on a mask path.
   * The angle value is 0% for feather points not at corners.
   * Read / Write.
   */
  declare rel_corner_angle: number;

  declare _fp: FeatherPointItem;

  constructor(kw: { _fp: FeatherPointItem }) {
    const { _fp } = kw;
    this._fp = _fp;
  }

  /**
   * Feather point direction: 0 (outer feather point) or
   * 1 (inner feather point). Read-only.
   */
  get type(): number {
    return this.radius < 0 ? 1 : 0;
  }
}

descriptor(FeatherPoint, "seg_loc", new ChunkField("_fp", "seg_loc", { validate: validate_positive_int }));
descriptor(FeatherPoint, "rel_seg_loc", new ChunkField("_fp", "rel_seg_loc", { validate: validate_normalized_float }));
descriptor(FeatherPoint, "radius", new ChunkField("_fp", "radius"));
descriptor(
  FeatherPoint,
  "interp",
  new ChunkField("_fp", "interp_raw", { transform: _interp_transform, reverse: _interp_reverse }),
);
descriptor(FeatherPoint, "tension", new ChunkField("_fp", "tension", { validate: validate_normalized_float }));
descriptor(FeatherPoint, "rel_corner_angle", new ChunkField("_fp", "corner_angle"));

/**
 * The Shape object encapsulates information describing a shape in a shape layer, or
 * the outline shape of a Mask. It is the value of the "Mask Path" AE properties, and
 * of the "Path" AE property of a shape layer.
 *
 * A shape has a set of anchor points, or vertices, and a pair of direction handles, or
 * tangent vectors, for each anchor point. A tangent vector (in a non-roto_bezier mask)
 * determines the direction of the line that is drawn to or from an anchor point. There
 * is one incoming tangent vector and one outgoing tangent vector associated with each
 * `vertex` in the shape.
 *
 * A tangent value is a pair of x,y coordinates specified relative to the associated
 * `vertex`. For example, a tangent of [-1,-1] is located above and to the left of the
 * `vertex` and has a 45 degree slope, regardless of the actual location of the
 * `vertex`. The longer a handle is, the greater its influence; for example, an
 * incoming shape segment stays closer to the vector for an `in_tangent` of [-2,-2]
 * than it does for an `in_tangent` of [-1,-1], even though both of these come toward
 * the `vertex` from the same direction.
 *
 * If a shape is not closed, the `in_tangent` for the first `vertex` and the
 * `out_tangent` for the final `vertex` are ignored. If the shape is closed, these two
 * vectors specify the direction handles of the final connecting segment out of the
 * final `vertex` and back into the first `vertex`.
 *
 * roto_bezier masks calculate their tangents automatically
 * (see MaskPropertyGroup.roto_bezier). If a shape is used in a roto_bezier mask, the
 * tangent values are ignored.
 *
 * For closed mask shapes, variable-width mask feather points can exist anywhere along
 * the mask path. Feather points are part of the Mask Path property. Reference a
 * specific feather point by the number of the mask path segment (portion of the path
 * between adjacent vertices) where it appears.
 *
 * Tip:
 *     The feather points on a mask are listed in an array in the order that they were
 *     created.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const shape_layer = comp.shape_layers[0];
 * const shape_prop = shape_layer.property("ADBE Root Vectors Group").property("ADBE Vector Shape - Group").property("ADBE Vector Shape");
 * console.log(shape_prop.value.vertices);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/other/shape/
 */
export class Shape {
  declare _shph: ShphChunk | null;
  declare _is_mask: boolean;
  declare _layer: Layer | null;
  declare _omtn: OmtnChunk | null;
  declare _mask_path: Property | null;
  declare _tensions: number[] | null;
  declare _closed_fallback: boolean;
  declare _detached: boolean;
  declare _points: ShapePoint[] | null;

  /** Array of variable-width mask feather points. */
  declare feather_points: FeatherPoint[];

  /**
   * Create a shape from scratch.
   *
   * Coordinates are absolute (pixel-space), matching a shape-layer
   * path. When this shape is later assigned to a mask property, the
   * property normalizes the coordinates to the layer.
   *
   * @param vertices - Anchor points as `[x, y]` pairs.
   * @param in_tangents - Incoming tangent offsets relative to each vertex, same length as
   *   `vertices`. Defaults to `[0, 0]` (straight line in) for every vertex.
   * @param out_tangents - Outgoing tangent offsets relative to each vertex, same length as
   *   `vertices`. Defaults to `[0, 0]` (straight line out) for every vertex.
   * @param kw - Keyword arguments:
   * - `closed`: When `true`, the first and last vertices are connected.
   * - `feather_points`: Variable-width mask feather points.
   * @throws {@link ValueError} If the tangent arrays do not match the vertices, or a coordinate (or
   *   a vertex plus its tangent) is not a finite float32: paths are stored as single-precision
   *   floats.
   */
  constructor(
    vertices: number[][] | null = null,
    in_tangents: number[][] | null = null,
    out_tangents: number[][] | null = null,
    kw: { closed?: boolean; feather_points?: FeatherPoint[] | null } = {},
  ) {
    const { closed = true, feather_points = null } = kw;
    validate_bool(closed);
    if (
      feather_points != null &&
      !(Array.isArray(feather_points) && feather_points.every((fp) => fp instanceof FeatherPoint))
    ) {
      throw new TypeError_("feather_points must be a list of FeatherPoint");
    }
    this._shph = new ShphChunk();
    this._shph.open = !closed;
    this._is_mask = false;
    this._layer = null;
    this._omtn = null;
    this._mask_path = null;
    this._tensions = null;
    this._closed_fallback = closed;
    // A shape built here owns its points, so a different vertex count
    // can rebuild them; a parsed one shares them with its file chunks.
    this._detached = true;
    this.feather_points = feather_points ?? [];
    /** Array of variable-width mask feather points. */

    const verts = vertices ?? [];
    const n = verts.length;
    const in_t = in_tangents ?? new Array<number[]>(n).fill([0.0, 0.0]);
    const out_t = out_tangents ?? new Array<number[]>(n).fill([0.0, 0.0]);
    // Three points per vertex: vertex, out-tangent, in-tangent-of-next.
    this._points = [];
    this._write_geometry(verts, in_t, out_t);
  }

  _write_geometry(vertices: number[][], in_tangents: number[][], out_tangents: number[][]): void {
    /**
     * Store `vertices` (absolute) and their relative tangents.
     *
     * The points are stored normalized to a bounding box spanning every
     * control point, so the box is recomputed from the whole new geometry:
     * a box kept from an earlier geometry cannot hold a coordinate along
     * an axis it has no extent in (a flat or single-point path would keep
     * its old values). Everything is validated before anything is written.
     */
    for (const coords of [vertices, in_tangents, out_tangents]) {
      if (!Array.isArray(coords)) {
        throw new ValueError("vertices and tangents must be lists of [x, y] pairs");
      }
      for (const pt of coords) {
        validate_f4_point(pt);
      }
    }
    const count = vertices.length;
    if (in_tangents.length !== count || out_tangents.length !== count) {
      throw new ValueError("in_tangents and out_tangents must match the number of vertices");
    }
    py_assert(this._shph != null && this._points != null);
    if (3 * count !== this._points.length && !this._detached) {
      throw new ValueError(
        `this path has ${floordiv(this._points.length, 3)} vertices; to change ` +
          "the vertex count assign a new Shape to the property",
      );
    }
    const mask_size = this._is_mask ? this._comp_size : null;
    const [sx, sy] = mask_size ?? [1.0, 1.0];
    const verts = vertices.map(([x, y]) => [truediv(x, sx), truediv(y, sy)]);
    const ins = verts.map(([vx, vy], i) => {
      const [x, y] = in_tangents[i];
      return [vx + truediv(x, sx), vy + truediv(y, sy)];
    });
    const outs = verts.map(([vx, vy], i) => {
      const [x, y] = out_tangents[i];
      return [vx + truediv(x, sx), vy + truediv(y, sy)];
    });
    for (const pt of [...ins, ...outs]) {
      // A vertex plus its tangent can overflow even when both fit.
      validate_f4_point(pt);
    }
    if (3 * count !== this._points.length) {
      this._points.splice(0, this._points.length, ...Array.from({ length: 3 * count }, () => new ShapePoint()));
    }
    if (!count) return;
    const all = [...verts, ...ins, ...outs];
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const shph = this._shph;
    shph.top_left_x = min(xs);
    shph.top_left_y = min(ys);
    shph.bottom_right_x = max(xs);
    shph.bottom_right_y = max(ys);
    const total = this._points.length;
    for (let j = 0; j < count; j++) {
      const i = 3 * j;
      const targets: [number, number[]][] = [
        [i, verts[j]],
        [i + 1, outs[j]],
        [(i - 1 + total) % total, ins[j]],
      ];
      for (const [index, [x, y]] of targets) {
        const [nx, ny] = this._normalize_point(x, y);
        this._points[index].x = nx;
        this._points[index].y = ny;
      }
    }
  }

  static _from_binary(kw: {
    _shph: ShphChunk;
    _points: ShapePoint[];
    _is_mask?: boolean;
    _layer?: Layer | null;
    _omtn?: OmtnChunk | null;
    _mask_path?: Property | null;
    feather_points?: FeatherPoint[] | null;
  }): Shape {
    /**
     * Wrap parsed shape chunks as a `Shape` view.
     *
     * `_mask_path` is the owning Mask Path: its mask's RotoBezier switch
     * decides which tangents the shape reports.
     */
    const {
      _shph,
      _points,
      _is_mask = false,
      _layer = null,
      _omtn = null,
      _mask_path = null,
      feather_points = null,
    } = kw;
    const obj: Shape = Object.create(this.prototype);
    obj._shph = _shph;
    obj._points = _points;
    obj._is_mask = _is_mask;
    obj._layer = _layer;
    obj._omtn = _omtn;
    obj._mask_path = _mask_path;
    obj._tensions = null;
    obj._detached = false;
    obj.feather_points = feather_points ?? [];
    return obj;
  }

  _is_roto_bezier(): boolean {
    /** Whether this is the path of a mask whose RotoBezier switch is on. */
    const prop = this._mask_path;
    if (prop == null || prop._tdb4 == null) return false;
    const mask = prop._parent_property;
    return mask != null && mask._is_mask && mask instanceof _mask_property_group().MaskPropertyGroup && mask.roto_bezier;
  }

  _roto_tangents(): [number[][], number[][]] | null {
    /**
     * The tangents AE draws the path with when its mask is RotoBezier
     * (`resolvers.roto_bezier`), or `null` for any other shape.
     */
    const prop = this._mask_path;
    if (prop == null || !this._is_roto_bezier()) return null;
    const layer = prop._containing_layer;
    if (!(layer instanceof _av_layer().AVLayer)) throw new AttributeError("_mask_scale");
    const [width, height] = layer._mask_scale;
    const vertices = this.vertices;
    let tensions = this._tensions;
    if (tensions == null || tensions.length !== vertices.length) {
      tensions = this._own_tensions();
      if (tensions.length !== vertices.length) {
        tensions = new Array<number>(vertices.length).fill(DEFAULT_TENSION);
      }
    }
    return roto_bezier_tangents(
      vertices,
      this.closed,
      tensions,
      truediv(prop._tdb4.pixel_aspect, width),
      truediv(1.0, height),
    );
  }

  _own_tensions(): number[] {
    /** The tensions stored with this shape value (the `omtn` chunk). */
    if (this._omtn == null) return [];
    return this._omtn.tensions.map((item) => item.value);
  }

  _set_tensions(tensions: number[]): void {
    /** Store per-vertex RotoBezier tensions in this value's `omtn`. */
    if (this._omtn != null) {
      this._omtn.tensions = tensions.map((t) => new TensionItem({ value: t }));
    }
  }

  /**
   * Mask-shape denormalization size, read lazily.
   *
   * Mask space is LAYER space, so this is the owning layer's source
   * size (pinned by the psd_vector_mask_cropped fixture: a 56 px layer
   * in a 64 px comp), or 1 x 1 on a text or shape layer (see
   * `AVLayer._mask_scale`). Read on demand rather than snapshotted at
   * parse time, so it follows the layer if its source is later replaced.
   */
  get _comp_size(): [number, number] | null {
    if (this._layer == null) return null;
    if (!(this._layer instanceof _av_layer().AVLayer)) throw new AttributeError("_mask_scale");
    return this._layer._mask_scale;
  }

  _denormalize_point(pt: ShapePoint): number[] {
    /** Convert a normalized [0,1] shape point to absolute coordinates. */
    const shph = this._shph;
    py_assert(shph != null);
    const x = shph.top_left_x * (1 - pt.x) + shph.bottom_right_x * pt.x;
    const y = shph.top_left_y * (1 - pt.y) + shph.bottom_right_y * pt.y;
    return [x, y];
  }

  _normalize_point(x: number, y: number): [number, number] {
    /** Convert absolute coordinates back to normalized [0,1]. */
    const shph = this._shph;
    py_assert(shph != null);
    const dx = shph.bottom_right_x - shph.top_left_x;
    const dy = shph.bottom_right_y - shph.top_left_y;
    const nx = dx !== 0 ? truediv(x - shph.top_left_x, dx) : 0.0;
    const ny = dy !== 0 ? truediv(y - shph.top_left_y, dy) : 0.0;
    return [nx, ny];
  }

  /**
   * The anchor points of the shape. Specify each point as an array of two
   * floating-point values, and collect the point pairs into an array for the
   * complete set of points.
   *
   * Moving the vertices keeps each tangent relative to its vertex. A
   * shape built with `Shape()` can take a different number of vertices
   * (its tangents then reset to `[0, 0]`); one read from a project keeps
   * its vertex count, so assign a new `Shape` to the property instead.
   */
  get vertices(): number[][] {
    if (this._points == null || this._shph == null) return [];
    let result: number[][] = [];
    for (let i = 0; i < this._points.length; i += 3) {
      result.push(this._denormalize_point(this._points[i]));
    }
    const mask_size = this._is_mask ? this._comp_size : null;
    if (mask_size != null) {
      const [w, h] = mask_size;
      result = result.map(([x, y]) => [x * w, y * h]);
    }
    return result;
  }

  set vertices(value: number[][]) {
    if (this._points == null || this._shph == null) return;
    if (!Array.isArray(value)) {
      throw new ValueError("vertices must be a list of [x,y] pairs");
    }
    if (!value?.length) {
      // AE 2026 refuses it too: "Value array does not have at least 1
      // element(s)".
      throw new ValueError("vertices needs at least one [x, y] pair");
    }
    let in_t: number[][];
    let out_t: number[][];
    if (value.length === floordiv(this._points.length, 3)) {
      in_t = this._stored_tangents(-1);
      out_t = this._stored_tangents(1);
    } else {
      // A new vertex count: the old tangents belonged to other vertices.
      in_t = out_t = new Array<number[]>(value.length).fill([0.0, 0.0]);
    }
    this._write_geometry([...value], in_t, out_t);
  }

  /**
   * The incoming tangent vectors, or direction handles, associated with the vertices
   * of the shape. Specify each vector as an array of two floating-point values, and
   * collect the vectors into an array the same length as the vertices array.
   *
   * Each tangent value defaults to [0,0]. When the mask shape is not roto_bezier,
   * this results in a straight line segment.
   *
   * If the shape is in a roto_bezier mask, all tangent values are ignored and the
   * tangents are automatically calculated.
   */
  get in_tangents(): number[][] {
    const roto = this._roto_tangents();
    return roto !== null ? roto[0] : this._stored_tangents(-1);
  }

  set in_tangents(value: number[][]) {
    if (this._points == null || this._shph == null) return;
    if (!Array.isArray(value)) {
      throw new ValueError("in_tangents must be a list of [x,y] pairs");
    }
    this._write_geometry(this.vertices, [...value], this._stored_tangents(1));
  }

  _stored_tangents(offset: number): number[][] {
    /**
     * The stored handles (which a RotoBezier mask ignores): the
     * incoming ones for `offset` -1, the outgoing ones for +1 (each handle
     * point sits beside its vertex in `_points`).
     */
    if (this._points == null || this._shph == null) return [];
    let result: number[][] = [];
    for (let i = 0; i < this._points.length; i += 3) {
      const v = this._denormalize_point(this._points[i]);
      const t = this._denormalize_point(this._points[mod(i + offset, this._points.length)]);
      result.push([t[0] - v[0], t[1] - v[1]]);
    }
    const mask_size = this._is_mask ? this._comp_size : null;
    if (mask_size != null) {
      const [w, h] = mask_size;
      result = result.map(([x, y]) => [x * w, y * h]);
    }
    return result;
  }

  /**
   * The outgoing tangent vectors, or direction handles, associated with the vertices
   * of the shape. Specify each vector as an array of two floating-point values, and
   * collect the vectors into an array the same length as the vertices array.
   *
   * Each tangent value defaults to [0,0]. When the mask shape is not roto_bezier,
   * this results in a straight line segment.
   *
   * If the shape is in a roto_bezier mask, all tangent values are ignored and the
   * tangents are automatically calculated.
   */
  get out_tangents(): number[][] {
    const roto = this._roto_tangents();
    return roto !== null ? roto[1] : this._stored_tangents(1);
  }

  set out_tangents(value: number[][]) {
    if (this._points == null || this._shph == null) return;
    if (!Array.isArray(value)) {
      throw new ValueError("out_tangents must be a list of [x,y] pairs");
    }
    this._write_geometry(this.vertices, this._stored_tangents(-1), [...value]);
  }

  /**
   * When `true`, the first and last vertices are connected to form a closed
   * curve. When `false`, the closing segment is not drawn.
   */
  get closed(): boolean {
    if (this._shph != null) return !this._shph.open;
    return this._closed_fallback;
  }

  set closed(value: boolean) {
    validate_bool(value);
    if (this._shph != null) {
      this._shph.open = !value;
    } else {
      this._closed_fallback = value;
    }
  }
}
