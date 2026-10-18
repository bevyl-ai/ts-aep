/** Shape value model for mask and shape path properties. */

import { AttributeError, ValueError, assert, descriptor, truediv } from "../../../pyrt/index.ts";
import { ShapePoint } from "../../binary/ldat_chunks.ts";
import { ShphChunk, TensionItem } from "../../binary/misc_chunks.ts";
import type { FeatherPointItem, OmtnChunk } from "../../binary/misc_chunks.ts";
import { DEFAULT_TENSION, rotoBezierTangents } from "../../resolvers/roto_bezier.ts";
import { ChunkField } from "../descriptors.ts";
import { validateBool, validateF4Point, validateNormalizedFloat, validatePositiveInt } from "../validators.ts";
import type { Layer } from "../layers/layer.ts";
import type { Property } from "./property.ts";

/** Map binary interpolation (0=non-Hold, 2=Hold) to ExtendScript (0/1). */
export function _interpTransform(raw: number): number {
  return raw === 2 ? 1 : 0;
}

/** Map ExtendScript interpolation (0/1) back to binary (0/2). */
export function _interpReverse(value: number): number {
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
  declare segLoc: number;

  /**
   * Relative position on the segment, from 0.0 (at the starting
   * vertex) to 1.0 (at the next vertex). Read / Write.
   */
  declare relSegLoc: number;

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
  declare relCornerAngle: number;

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

  static {
    descriptor(this, "segLoc", new ChunkField("_fp", "segLoc", { validate: validatePositiveInt }));
    descriptor(this, "relSegLoc", new ChunkField("_fp", "relSegLoc", { validate: validateNormalizedFloat }));
    descriptor(this, "radius", new ChunkField("_fp", "radius"));
    descriptor(
      this,
      "interp",
      new ChunkField("_fp", "interpRaw", { transform: _interpTransform, reverse: _interpReverse }),
    );
    descriptor(this, "tension", new ChunkField("_fp", "tension", { validate: validateNormalizedFloat }));
    descriptor(this, "relCornerAngle", new ChunkField("_fp", "cornerAngle"));
  }
}

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
 * incoming shape segment stays closer to the vector for an `inTangent` of [-2,-2]
 * than it does for an `inTangent` of [-1,-1], even though both of these come toward
 * the `vertex` from the same direction.
 *
 * If a shape is not closed, the `inTangent` for the first `vertex` and the
 * `outTangent` for the final `vertex` are ignored. If the shape is closed, these two
 * vectors specify the direction handles of the final connecting segment out of the
 * final `vertex` and back into the first `vertex`.
 *
 * roto_bezier masks calculate their tangents automatically
 * (see MaskPropertyGroup.rotoBezier). If a shape is used in a roto_bezier mask, the
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
 * const shapeLayer = comp.shapeLayers[0];
 * const shapeProp = shapeLayer.property("ADBE Root Vectors Group").property("ADBE Vector Shape - Group").property("ADBE Vector Shape");
 * console.log(shapeProp.value.vertices);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/other/shape/
 */
export class Shape {
  declare _shph: ShphChunk | null;
  declare _isMask: boolean;
  declare _layer: Layer | null;
  declare _omtn: OmtnChunk | null;
  declare _maskPath: Property | null;
  declare _tensions: number[] | null;
  declare _closedFallback: boolean;
  declare _detached: boolean;
  declare _points: ShapePoint[] | null;

  /** Array of variable-width mask feather points. */
  declare featherPoints: FeatherPoint[];

  /**
   * Create a shape from scratch.
   *
   * Coordinates are absolute (pixel-space), matching a shape-layer
   * path. When this shape is later assigned to a mask property, the
   * property normalizes the coordinates to the layer.
   *
   * @param vertices - Anchor points as `[x, y]` pairs.
   * @param inTangents - Incoming tangent offsets relative to each vertex, same length as
   *   `vertices`. Defaults to `[0, 0]` (straight line in) for every vertex.
   * @param outTangents - Outgoing tangent offsets relative to each vertex, same length as
   *   `vertices`. Defaults to `[0, 0]` (straight line out) for every vertex.
   * @param kw - Keyword arguments:
   * - `closed`: When `true`, the first and last vertices are connected.
   * - `featherPoints`: Variable-width mask feather points.
   * @throws {@link ValueError} If the tangent arrays do not match the vertices, or a coordinate (or
   *   a vertex plus its tangent) is not a finite float32: paths are stored as single-precision
   *   floats.
   */
  constructor(
    vertices: number[][] | null = null,
    inTangents: number[][] | null = null,
    outTangents: number[][] | null = null,
    kw: { closed?: boolean; featherPoints?: FeatherPoint[] | null } = {},
  ) {
    const { closed = true, featherPoints = null } = kw;
    validateBool(closed);
    if (
      featherPoints != null &&
      !(Array.isArray(featherPoints) && featherPoints.every((fp) => fp instanceof FeatherPoint))
    ) {
      throw new TypeError("featherPoints must be a list of FeatherPoint");
    }
    this._shph = new ShphChunk();
    this._shph.open = !closed;
    this._isMask = false;
    this._layer = null;
    this._omtn = null;
    this._maskPath = null;
    this._tensions = null;
    this._closedFallback = closed;
    // A shape built here owns its points, so a different vertex count
    // can rebuild them; a parsed one shares them with its file chunks.
    this._detached = true;
    this.featherPoints = featherPoints ?? [];
    /** Array of variable-width mask feather points. */

    const verts = vertices ?? [];
    const n = verts.length;
    const inT = inTangents ?? new Array<number[]>(n).fill([0.0, 0.0]);
    const outT = outTangents ?? new Array<number[]>(n).fill([0.0, 0.0]);
    // Three points per vertex: vertex, out-tangent, in-tangent-of-next.
    this._points = [];
    this._writeGeometry(verts, inT, outT);
  }

  /**
   * Store `vertices` (absolute) and their relative tangents.
   *
   * The points are stored normalized to a bounding box spanning every
   * control point, so the box is recomputed from the whole new geometry:
   * a box kept from an earlier geometry cannot hold a coordinate along
   * an axis it has no extent in (a flat or single-point path would keep
   * its old values). Everything is validated before anything is written.
   */
  _writeGeometry(vertices: number[][], inTangents: number[][], outTangents: number[][]): void {
    for (const coords of [vertices, inTangents, outTangents]) {
      if (!Array.isArray(coords)) {
        throw new ValueError("vertices and tangents must be lists of [x, y] pairs");
      }
      for (const pt of coords) {
        validateF4Point(pt);
      }
    }
    const count = vertices.length;
    if (inTangents.length !== count || outTangents.length !== count) {
      throw new ValueError("inTangents and outTangents must match the number of vertices");
    }
    assert(this._shph != null && this._points != null);
    if (3 * count !== this._points.length && !this._detached) {
      throw new ValueError(
        `this path has ${Math.floor(this._points.length / 3)} vertices; to change ` +
          "the vertex count assign a new Shape to the property",
      );
    }
    const maskSize = this._isMask ? this._compSize : null;
    const [sx, sy] = maskSize ?? [1.0, 1.0];
    const verts = vertices.map(([x, y]) => [truediv(x, sx), truediv(y, sy)]);
    const ins = verts.map(([vx, vy], i) => {
      const [x, y] = inTangents[i];
      return [vx + truediv(x, sx), vy + truediv(y, sy)];
    });
    const outs = verts.map(([vx, vy], i) => {
      const [x, y] = outTangents[i];
      return [vx + truediv(x, sx), vy + truediv(y, sy)];
    });
    for (const pt of [...ins, ...outs]) {
      // A vertex plus its tangent can overflow even when both fit.
      validateF4Point(pt);
    }
    if (3 * count !== this._points.length) {
      this._points.splice(0, this._points.length, ...Array.from({ length: 3 * count }, () => new ShapePoint()));
    }
    if (!count) return;
    const all = [...verts, ...ins, ...outs];
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const shph = this._shph;
    shph.topLeftX = Math.min(...xs);
    shph.topLeftY = Math.min(...ys);
    shph.bottomRightX = Math.max(...xs);
    shph.bottomRightY = Math.max(...ys);
    const total = this._points.length;
    for (let j = 0; j < count; j++) {
      const i = 3 * j;
      const targets: [number, number[]][] = [
        [i, verts[j]],
        [i + 1, outs[j]],
        [(i - 1 + total) % total, ins[j]],
      ];
      for (const [index, [x, y]] of targets) {
        const [nx, ny] = this._normalizePoint(x, y);
        this._points[index].x = nx;
        this._points[index].y = ny;
      }
    }
  }

  /**
   * Wrap parsed shape chunks as a `Shape` view.
   *
   * `_maskPath` is the owning Mask Path: its mask's RotoBezier switch
   * decides which tangents the shape reports.
   */
  static _fromBinary(kw: {
    _shph: ShphChunk;
    _points: ShapePoint[];
    _isMask?: boolean;
    _layer?: Layer | null;
    _omtn?: OmtnChunk | null;
    _maskPath?: Property | null;
    featherPoints?: FeatherPoint[] | null;
  }): Shape {
    const { _shph, _points, _isMask = false, _layer = null, _omtn = null, _maskPath = null, featherPoints = null } = kw;
    const obj: Shape = Object.create(this.prototype);
    obj._shph = _shph;
    obj._points = _points;
    obj._isMask = _isMask;
    obj._layer = _layer;
    obj._omtn = _omtn;
    obj._maskPath = _maskPath;
    obj._tensions = null;
    obj._detached = false;
    obj.featherPoints = featherPoints ?? [];
    return obj;
  }

  /** Whether this is the path of a mask whose RotoBezier switch is on. */
  _isRotoBezier(): boolean {
    const prop = this._maskPath;
    if (prop == null || prop._tdb4 == null) return false;
    const mask = prop._parentProperty;
    return mask != null && mask._isMask && mask._isMaskGroup() && mask.rotoBezier;
  }

  /**
   * The tangents AE draws the path with when its mask is RotoBezier
   * (`resolvers.rotoBezier`), or `null` for any other shape.
   */
  private _rotoTangents(): [number[][], number[][]] | null {
    const prop = this._maskPath;
    if (prop == null || !this._isRotoBezier()) return null;
    const layer = prop._containingLayer;
    if (!layer._isAVLayer()) throw new AttributeError("_maskScale");
    const [width, height] = layer._maskScale;
    const vertices = this.vertices;
    let tensions = this._tensions;
    if (tensions == null || tensions.length !== vertices.length) {
      tensions = this._ownTensions();
      if (tensions.length !== vertices.length) {
        tensions = new Array<number>(vertices.length).fill(DEFAULT_TENSION);
      }
    }
    return rotoBezierTangents(
      vertices,
      this.closed,
      tensions,
      truediv(prop._tdb4.pixelAspect, width),
      truediv(1.0, height),
    );
  }

  /** The tensions stored with this shape value (the `omtn` chunk). */
  _ownTensions(): number[] {
    if (this._omtn == null) return [];
    return this._omtn.tensions.map((item) => item.value);
  }

  /** Store per-vertex RotoBezier tensions in this value's `omtn`. */
  _setTensions(tensions: number[]): void {
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
  get _compSize(): [number, number] | null {
    if (this._layer == null) return null;
    if (!this._layer._isAVLayer()) throw new AttributeError("_maskScale");
    return this._layer._maskScale;
  }

  /** Convert a normalized [0,1] shape point to absolute coordinates. */
  private _denormalizePoint(pt: ShapePoint): number[] {
    const shph = this._shph;
    assert(shph != null);
    const x = shph.topLeftX * (1 - pt.x) + shph.bottomRightX * pt.x;
    const y = shph.topLeftY * (1 - pt.y) + shph.bottomRightY * pt.y;
    return [x, y];
  }

  /** Convert absolute coordinates back to normalized [0,1]. */
  private _normalizePoint(x: number, y: number): [number, number] {
    const shph = this._shph;
    assert(shph != null);
    const dx = shph.bottomRightX - shph.topLeftX;
    const dy = shph.bottomRightY - shph.topLeftY;
    const nx = dx !== 0 ? truediv(x - shph.topLeftX, dx) : 0.0;
    const ny = dy !== 0 ? truediv(y - shph.topLeftY, dy) : 0.0;
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
      result.push(this._denormalizePoint(this._points[i]));
    }
    const maskSize = this._isMask ? this._compSize : null;
    if (maskSize != null) {
      const [w, h] = maskSize;
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
    let inT: number[][];
    let outT: number[][];
    if (value.length === Math.floor(this._points.length / 3)) {
      inT = this._storedTangents(-1);
      outT = this._storedTangents(1);
    } else {
      // A new vertex count: the old tangents belonged to other vertices.
      inT = outT = new Array<number[]>(value.length).fill([0.0, 0.0]);
    }
    this._writeGeometry([...value], inT, outT);
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
  get inTangents(): number[][] {
    const roto = this._rotoTangents();
    return roto !== null ? roto[0] : this._storedTangents(-1);
  }

  set inTangents(value: number[][]) {
    if (this._points == null || this._shph == null) return;
    if (!Array.isArray(value)) {
      throw new ValueError("inTangents must be a list of [x,y] pairs");
    }
    this._writeGeometry(this.vertices, [...value], this._storedTangents(1));
  }

  /**
   * The stored handles (which a RotoBezier mask ignores): the
   * incoming ones for `offset` -1, the outgoing ones for +1 (each handle
   * point sits beside its vertex in `_points`).
   */
  _storedTangents(offset: number): number[][] {
    if (this._points == null || this._shph == null) return [];
    let result: number[][] = [];
    for (let i = 0; i < this._points.length; i += 3) {
      const v = this._denormalizePoint(this._points[i]);
      const t = this._denormalizePoint(this._points[(i + offset + this._points.length) % this._points.length]);
      result.push([t[0] - v[0], t[1] - v[1]]);
    }
    const maskSize = this._isMask ? this._compSize : null;
    if (maskSize != null) {
      const [w, h] = maskSize;
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
  get outTangents(): number[][] {
    const roto = this._rotoTangents();
    return roto !== null ? roto[1] : this._storedTangents(1);
  }

  set outTangents(value: number[][]) {
    if (this._points == null || this._shph == null) return;
    if (!Array.isArray(value)) {
      throw new ValueError("outTangents must be a list of [x,y] pairs");
    }
    this._writeGeometry(this.vertices, this._storedTangents(-1), [...value]);
  }

  /**
   * When `true`, the first and last vertices are connected to form a closed
   * curve. When `false`, the closing segment is not drawn.
   */
  get closed(): boolean {
    if (this._shph != null) return !this._shph.open;
    return this._closedFallback;
  }

  set closed(value: boolean) {
    validateBool(value);
    if (this._shph != null) {
      this._shph.open = !value;
    } else {
      this._closedFallback = value;
    }
  }
}
