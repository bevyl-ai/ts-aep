/**
 * 4x4 affine transform utilities for After Effects layer transforms.
 *
 * Provides matrix composition and decomposition matching AE's internal
 * transform pipeline.  Pure Python with no external dependencies.
 *
 * **AE transform order** (column-vector convention, right-to-left)::
 *
 *     2D:  T(pos) * Rz(rz) * S(scale) * T(-anchor)
 *     3D:  T(pos) * Rx(ox)*Ry(oy)*Rz(oz) * Rx(rx)*Ry(ry)*Rz(rz)
 *          * S(scale) * T(-anchor)
 *
 * where `o{x,y,z}` are Orientation angles and `r{x,y,z}` are
 * per-axis Rotation angles, all in degrees.
 *
 * Coordinate system: left-handed, Y-down (X right, Y down, Z into screen).
 * Standard rotation matrices apply without sign flips.
 */

import { AutoOrientType, LayerType, LightType } from "../enums/index.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { AVLayer } from "../models/layers/av_layer.ts";
import type { Layer } from "../models/layers/layer.ts";
import type { LightLayer } from "../models/layers/light_layer.ts";
import type { MatchNameTypes } from "../models/properties/match_name_types.ts";
import type { Property } from "../models/properties/property.ts";
import type { PropertyGroup } from "../models/properties/property_group.ts";
import { AttributeError, NotImplementedError, ValueError, degrees, type_name, float_repr, hasattr, max, min, mod, repr, sum, hypot } from "../../pyrt/index.ts";

type _PropertyName = {
  [K in keyof MatchNameTypes]: MatchNameTypes[K] extends Property<infer _V> ? K : never;
}[keyof MatchNameTypes];

type _PropertyValueOf<K extends _PropertyName> = MatchNameTypes[K] extends Property<infer V> ? V : never;

export const _DEG2RAD = Math.PI / 180.0;
export const _RAD2DEG = 180.0 / Math.PI;
export const _EPSILON = 1e-10;

/** 4x4 matrix stored row-major: `m{@link col | row}`. */
export class Mat4 {
  declare _rows: number[][];

  constructor(rows: number[][]) {
    this._rows = rows;
  }

  __getitem__(row: number): number[] {
    return this._rows[row];
  }

  /** Python `self @ other` (matrix product, left-associative at every call site). */
  __matmul__(other: Mat4): Mat4 {
    const rows: number[][] = Array.from({ length: 4 }, () => [0.0, 0.0, 0.0, 0.0]);
    for (let i = 0; i < 4; i++) {
      const ai = this._rows[i];
      const ri = rows[i];
      const ob = other._rows;
      for (let j = 0; j < 4; j++) {
        ri[j] = ai[0] * ob[0][j] + ai[1] * ob[1][j] + ai[2] * ob[2][j] + ai[3] * ob[3][j];
      }
    }
    return new Mat4(rows);
  }

  __imatmul__(other: Mat4): Mat4 {
    return this.__matmul__(other);
  }

  /** Return a 4x4 identity matrix. */
  static identity(): Mat4 {
    return new this([
      [1.0, 0.0, 0.0, 0.0],
      [0.0, 1.0, 0.0, 0.0],
      [0.0, 0.0, 1.0, 0.0],
      [0.0, 0.0, 0.0, 1.0],
    ]);
  }

  /** Transform a 3D point (translation applied). */
  transform_point(v: number[]): number[] {
    const x = v[0];
    const y = v[1];
    const z = v.length > 2 ? v[2] : 0.0;
    const r = this._rows;
    return [
      r[0][0] * x + r[0][1] * y + r[0][2] * z + r[0][3],
      r[1][0] * x + r[1][1] * y + r[1][2] * z + r[1][3],
      r[2][0] * x + r[2][1] * y + r[2][2] * z + r[2][3],
    ];
  }

  /** Transform a 3D direction vector (translation ignored). */
  transform_vector(v: number[]): number[] {
    const x = v[0];
    const y = v[1];
    const z = v.length > 2 ? v[2] : 0.0;
    const r = this._rows;
    return [
      r[0][0] * x + r[0][1] * y + r[0][2] * z,
      r[1][0] * x + r[1][1] * y + r[1][2] * z,
      r[2][0] * x + r[2][1] * y + r[2][2] * z,
    ];
  }

  /**
   * Compute the inverse using cofactor expansion.
   *
   * Raises `ValueError` if the matrix is singular (determinant ~ 0).
   */
  inverse(): Mat4 {
    // Flatten for easier indexing.
    const s: number[] = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) s.push(this.__getitem__(r)[c]);
    }

    // 2x2 sub-determinants (Laplace expansion)
    const s0 = s[0] * s[5] - s[1] * s[4];
    const s1 = s[0] * s[6] - s[2] * s[4];
    const s2 = s[0] * s[7] - s[3] * s[4];
    const s3 = s[1] * s[6] - s[2] * s[5];
    const s4 = s[1] * s[7] - s[3] * s[5];
    const s5 = s[2] * s[7] - s[3] * s[6];

    const c5 = s[10] * s[15] - s[11] * s[14];
    const c4 = s[9] * s[15] - s[11] * s[13];
    const c3 = s[9] * s[14] - s[10] * s[13];
    const c2 = s[8] * s[15] - s[11] * s[12];
    const c1 = s[8] * s[14] - s[10] * s[12];
    const c0 = s[8] * s[13] - s[9] * s[12];

    const det = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
    // Relative to the linear part's magnitude: a layer uniformly scaled
    // to 0.03 % has a determinant of 2.7e-11 and is perfectly invertible
    // (AE 2026 compensates a parent that small).
    const abs_vals: number[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) abs_vals.push(Math.abs(s[r * 4 + c]));
    }
    // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
    const scale = max(abs_vals);
    if (det === 0.0 || Math.abs(det) <= _EPSILON * 1e-2 * scale ** 3) {
      throw new ValueError("Singular matrix, cannot invert.");
    }

    const inv_det = 1.0 / det;

    return new Mat4([
      [
        (s[5] * c5 - s[6] * c4 + s[7] * c3) * inv_det,
        (-s[1] * c5 + s[2] * c4 - s[3] * c3) * inv_det,
        (s[13] * s5 - s[14] * s4 + s[15] * s3) * inv_det,
        (-s[9] * s5 + s[10] * s4 - s[11] * s3) * inv_det,
      ],
      [
        (-s[4] * c5 + s[6] * c2 - s[7] * c1) * inv_det,
        (s[0] * c5 - s[2] * c2 + s[3] * c1) * inv_det,
        (-s[12] * s5 + s[14] * s2 - s[15] * s1) * inv_det,
        (s[8] * s5 - s[10] * s2 + s[11] * s1) * inv_det,
      ],
      [
        (s[4] * c4 - s[5] * c2 + s[7] * c0) * inv_det,
        (-s[0] * c4 + s[1] * c2 - s[3] * c0) * inv_det,
        (s[12] * s4 - s[13] * s2 + s[15] * s0) * inv_det,
        (-s[8] * s4 + s[9] * s2 - s[11] * s0) * inv_det,
      ],
      [
        (-s[4] * c3 + s[5] * c1 - s[6] * c0) * inv_det,
        (s[0] * c3 - s[1] * c1 + s[2] * c0) * inv_det,
        (-s[12] * s3 + s[13] * s1 - s[14] * s0) * inv_det,
        (s[8] * s3 - s[9] * s1 + s[10] * s0) * inv_det,
      ],
    ]);
  }

  __repr__(): string {
    // rows hold floats: render each through float_repr so 1 prints as "1.0" like Python
    return `Mat4([${this._rows.map((row) => `[${row.map((x) => float_repr(x)).join(", ")}]`).join(", ")}])`;
  }
}

// ------------------------------------------------------------------
// Elementary transform matrices
// ------------------------------------------------------------------

export function _translation(x: number, y: number, z: number): Mat4 {
  const m = Mat4.identity();
  m.__getitem__(0)[3] = x;
  m.__getitem__(1)[3] = y;
  m.__getitem__(2)[3] = z;
  return m;
}

export function _scale(sx: number, sy: number, sz: number): Mat4 {
  const m = Mat4.identity();
  m.__getitem__(0)[0] = sx;
  m.__getitem__(1)[1] = sy;
  m.__getitem__(2)[2] = sz;
  return m;
}

export function _rotate_x(deg: number): Mat4 {
  const r = deg * _DEG2RAD;
  // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = Mat4.identity();
  m.__getitem__(1)[1] = c;
  m.__getitem__(1)[2] = -s;
  m.__getitem__(2)[1] = s;
  m.__getitem__(2)[2] = c;
  return m;
}

export function _rotate_y(deg: number): Mat4 {
  const r = deg * _DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = Mat4.identity();
  m.__getitem__(0)[0] = c;
  m.__getitem__(0)[2] = s;
  m.__getitem__(2)[0] = -s;
  m.__getitem__(2)[2] = c;
  return m;
}

export function _rotate_z(deg: number): Mat4 {
  const r = deg * _DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = Mat4.identity();
  m.__getitem__(0)[0] = c;
  m.__getitem__(0)[1] = -s;
  m.__getitem__(1)[0] = s;
  m.__getitem__(1)[1] = c;
  return m;
}

// ------------------------------------------------------------------
// AE local transform matrix
// ------------------------------------------------------------------

/**
 * Build the local transform matrix for an AE layer.
 *
 * After Effects scales and rotates in square pixels: a layer's own
 * pixels are widened by its source's pixel aspect first, and the result
 * narrowed by the pixel aspect of the space its Position lives in (its
 * parent's source, or the composition) - `T(pos) . Sp^-1 . R . S . Sl . T(-anchor)` (measured on AE 2026 in a 2:1 pixel-aspect comp).
 *
 * @param position - `[x, y, z]` position in pixels.
 * @param anchor - `[x, y, z]` anchor point in pixels.
 * @param scale_pct - `[sx, sy, sz]` scale as percentages (100 = 1x).
 * @param rotation_z - Z-axis rotation in degrees.
 * @param kw - Keyword arguments:
 * - `orientation`: `[ox, oy, oz]` orientation angles in degrees (3D layers only).
 * - `rotate_x`: X-axis rotation in degrees (3D layers only).
 * - `rotate_y`: Y-axis rotation in degrees (3D layers only).
 * - `auto_rotation`: A 3D layer's auto-orientation, applied after its own rotations (before the
 *     translation).
 * - `source_aspect`: The pixel aspect of the layer's own pixels (`Sl`).
 * - `space_aspect`: The pixel aspect of the space the layer's Position lives in (`Sp`).
 * @returns A 4x4 matrix representing the layer's local transform.
 */
export function build_local_matrix(
  position: number[],
  anchor: number[],
  scale_pct: number[],
  rotation_z: number,
  kw: {
    orientation?: number[] | null;
    rotate_x?: number;
    rotate_y?: number;
    auto_rotation?: Mat4 | null;
    source_aspect?: number;
    space_aspect?: number;
  } = {},
): Mat4 {
  const {
    orientation = null,
    rotate_x = 0.0,
    rotate_y = 0.0,
    auto_rotation = null,
    source_aspect = 1.0,
    space_aspect = 1.0,
  } = kw;

  const sx = scale_pct[0] / 100.0;
  const sy = scale_pct[1] / 100.0;
  const sz = scale_pct.length > 2 ? scale_pct[2] / 100.0 : 1.0;

  // Start from right: T(-anchor)
  let m = _translation(-anchor[0], -anchor[1], anchor.length > 2 ? -anchor[2] : 0.0);
  if (source_aspect !== 1.0) m = _scale(source_aspect, 1.0, 1.0).__matmul__(m);

  // Scale
  m = _scale(sx, sy, sz).__matmul__(m);

  // Per-axis rotations: Rz * Ry * Rx (applied right-to-left)
  m = _rotate_z(rotation_z).__matmul__(m);
  m = _rotate_y(rotate_y).__matmul__(m);
  m = _rotate_x(rotate_x).__matmul__(m);

  // Orientation: Rz(oz) * Ry(oy) * Rx(ox)
  if (orientation != null) {
    const ox = orientation[0];
    const oy = orientation[1];
    const oz = orientation[2];
    m = _rotate_z(oz).__matmul__(m);
    m = _rotate_y(oy).__matmul__(m);
    m = _rotate_x(ox).__matmul__(m);
  }

  if (auto_rotation != null) m = auto_rotation.__matmul__(m);

  if (space_aspect !== 1.0) m = _scale(1.0 / space_aspect, 1.0, 1.0).__matmul__(m);

  // Position
  const px = position[0];
  const py = position[1];
  const pz = position.length > 2 ? position[2] : 0.0;
  m = _translation(px, py, pz).__matmul__(m);

  return m;
}

// ------------------------------------------------------------------
// World matrix (walks parent chain)
// ------------------------------------------------------------------

/**
 * Build the world transform matrix by composing the parent chain.
 *
 * Traverses `layer.parent` upward, composing local matrices so that::
 *
 *     world = root_local \@ ... \@ parent_local \@ layer_local
 *
 * A camera or light ancestor contributes its rig: its position and
 * rotations (a two-node rig's look-at toward its point of interest
 * first), with no anchor point or scale - what After Effects parents to
 * (measured on AE 2026).
 *
 * @param layer - The layer whose world matrix to build.
 * @param time - Composition time in seconds to evaluate animated transform properties at; `null`
 *   uses each property's static `value`.
 * @param flatten_2d - Drop the out-of-plane terms (see `_layer_local_matrix`).
 * @param kw - Keyword arguments:
 * - `as_parent`: Treat `layer` itself as a parent too - a camera or light then contributes its rig.
 * - `auto_orient`: Apply the layers' auto-orientation (needs `time`).
 * @throws {@link NotImplementedError} With `auto_orient`, for an orientation the math does not
 *   model (see `_auto_rotation`).
 */
export function build_world_matrix(
  layer: Layer,
  time: number | null = null,
  flatten_2d = false,
  kw: { as_parent?: boolean; auto_orient?: boolean } = {},
): Mat4 {
  const { as_parent = false, auto_orient = false } = kw;

  const chain: Layer[] = [];
  let current: Layer | null = layer;
  while (current != null) {
    chain.push(current);
    current = current.parent;
  }

  // Compose from root (last in chain) down to the layer itself. Each
  // Position lives in its parent's pixels (the comp's for the root).
  let m = Mat4.identity();
  const comp = layer.containing_comp;
  let space_aspect = comp.pixel_aspect;
  for (const lyr of chain.reverse()) {
    if ((lyr !== layer || as_parent) && _RIG_TYPES.has(lyr._ldta.layer_type)) {
      if (flatten_2d) {
        // Under a 2D layer a rig acts as a 2D layer anchored on the
        // comp centre, turned by Rotate Z alone (AE 2026: children
        // of a camera, a spot and a point light all fit
        // `T(pos.xy) . Rz . T(-w/2, -h/2)` exactly).
        const position = _prop_value(lyr.transform, "ADBE Position", time);
        const rz = _prop_value(lyr.transform, "ADBE Rotate Z", time);
        m = m.__matmul__(
          _translation(position[0], position[1], 0.0)
            .__matmul__(_rotate_z(rz))
            .__matmul__(_translation(-comp.width / 2.0, -comp.height / 2.0, 0.0)),
        );
      } else {
        m = m.__matmul__(_rig_matrix(lyr, time, space_aspect));
      }
      space_aspect = 1.0;
    } else {
      const source_aspect = layer_source_aspect(lyr);
      m = m.__matmul__(
        _layer_local_matrix(lyr, time, flatten_2d, auto_orient, source_aspect, space_aspect),
      );
      space_aspect = source_aspect;
    }
  }
  return m;
}

/** Pixel aspect of a layer's own pixels: its source's, else square. */
export function layer_source_aspect(layer: Layer): number {
  const source = _is_av_layer(layer) && hasattr(layer, "source") ? layer.source : null;
  const aspect = source != null && "pixel_aspect" in source ? source.pixel_aspect : null;
  return aspect != null && aspect !== 0 ? aspect : 1.0;
}

/**
 * Pixel aspect of the space a child of `parent` keeps its Position in:
 * the comp's at the root, square under a camera or light.
 */
export function position_space_aspect(parent: Layer | null, comp: CompItem): number {
  if (parent == null) return comp.pixel_aspect;
  if (_RIG_TYPES.has(parent._ldta.layer_type)) return 1.0;
  return layer_source_aspect(parent);
}

/** `diag(aspect, 1, 1)`: widens pixels of that aspect to square ones. */
export function aspect_scale(aspect: number): Mat4 {
  return _scale(aspect, 1.0, 1.0);
}

/**
 * A world matrix from a `space_aspect` space into comp pixels, made to
 * map square pixels to square pixels (so its rotation can be read).
 */
export function square_pixels(matrix: Mat4, comp_aspect: number, space_aspect: number): Mat4 {
  return aspect_scale(comp_aspect).__matmul__(matrix).__matmul__(aspect_scale(1.0 / space_aspect));
}

/**
 * Evaluate `group[match_name]`: static `value` when `time` is `null`,
 * else `value_at_time(time)`.
 */
export function _prop_value<K extends _PropertyName>(
  group: PropertyGroup,
  match_name: K,
  time: number | null,
): _PropertyValueOf<K>;
export function _prop_value(group: PropertyGroup, match_name: _PropertyName, time: number | null) {
  const prop = group.property(match_name);
  if (time == null) return prop.value;
  return prop.value_at_time(time);
}

/**
 * Build the local matrix for a single layer from its properties.
 *
 * With `flatten_2d`, the out-of-plane terms are dropped - X/Y rotation,
 * the whole Orientation and the Z translation. That is how After Effects
 * places a 2D layer under 3D ancestors, for its point conversions as well
 * as when compensating a reparent: a 2D layer parented to a null rotated
 * 20/-35/30 gets exactly the compensation of a null rotated 0/0/30, and
 * a parent's Orientation does not turn it at all (measured on AE 2026: a
 * parent with Orientation [0, 0, 30] leaves the child's Rotate Z at 0).
 */
export function _layer_local_matrix(
  layer: Layer,
  time: number | null = null,
  flatten_2d = false,
  auto_orient = false,
  source_aspect = 1.0,
  space_aspect = 1.0,
): Mat4 {
  const transform = layer.transform;

  const value = <K extends _PropertyName>(match_name: K): _PropertyValueOf<K> => _prop_value(transform, match_name, time);

  let position: number[] = value("ADBE Position");
  const anchor: number[] = value("ADBE Anchor Point");
  const scale_pct: number[] = value("ADBE Scale");
  let rz: number = value("ADBE Rotate Z");
  let orientation: number[] = value("ADBE Orientation");
  let rx: number = value("ADBE Rotate X");
  let ry: number = value("ADBE Rotate Y");

  if (flatten_2d) {
    position = [...position.slice(0, 2), 0.0];
    rx = 0.0;
    ry = 0.0;
    orientation = [0.0, 0.0, 0.0];
  }

  let auto_rotation: Mat4 | null = null;
  if (auto_orient && time != null) {
    const [rot, auto_rz] = _auto_rotation(layer, time, position);
    auto_rotation = rot;
    rz += auto_rz;
  }

  const is_3d = rx !== 0.0 || ry !== 0.0 || orientation.some((v) => v !== 0.0);

  return build_local_matrix(position, anchor, scale_pct, rz, {
    orientation: is_3d ? orientation : null,
    rotate_x: rx,
    rotate_y: ry,
    auto_rotation,
    source_aspect,
    space_aspect,
  });
}

// Layer types (`ldta.layer_type`) a child parents to as a rig: light, camera.
export const _RIG_TYPES: ReadonlySet<number> = new Set<number>([LayerType.LIGHT, LayerType.CAMERA]);
export const _AIMED_LIGHTS: ReadonlySet<number> = new Set<number>([LightType.SPOT, LightType.PARALLEL]);

/**
 * Whether a camera or light layer is a two-node rig that looks at its
 * point of interest: a camera, spot or parallel light orienting towards it
 * (a point light keeps the flag but AE applies no look-at).
 */
/** A light layer: the only layer kind with a `light_type`. */
function _is_light(layer: Layer): layer is LightLayer {
  return "light_type" in layer;
}

/** An AV layer: the only layer kind that resolves its comp's active camera. */
function _is_av_layer(layer: Layer): layer is AVLayer {
  return "_active_camera_at" in layer;
}

export function rig_aims_at_poi(layer: Layer): boolean {
  const layer_type = layer._ldta.layer_type;
  if (!_RIG_TYPES.has(layer_type)) return false;
  const aims =
    layer_type === LayerType.CAMERA || (_is_light(layer) && _AIMED_LIGHTS.has(layer.light_type));
  return aims && layer.auto_orient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
}

/**
 * A camera or light's rotation: the two-node look-at toward its point of interest
 * (stored in the anchor-point slot), then Orientation and the per-axis
 * rotations.
 *
 * Only a camera and a light that aims (spot, parallel) look at their
 * point of interest: a point light keeps the auto-orient flag and a point
 * of interest but After Effects applies no look-at (measured on AE 2026).
 * The look-at aims in square pixels, its Position and point of interest
 * widened by the pixel aspect of the space they live in.
 */
export function _rig_rotation(layer: Layer, time: number | null, space_aspect: number): Mat4 {
  const transform = layer.transform;

  const value = <K extends _PropertyName>(match_name: K): _PropertyValueOf<K> => _prop_value(transform, match_name, time);

  let rotation = Mat4.identity();
  if (rig_aims_at_poi(layer)) {
    const eye: number[] = [...value("ADBE Position")];
    const target: number[] = [...value("ADBE Anchor Point")];
    eye[0] *= space_aspect;
    target[0] *= space_aspect;
    rotation = _look_at_rotation(eye, target);
  }
  const orientation: number[] = value("ADBE Orientation");
  return rotation
    .__matmul__(_rotate_x(orientation[0]))
    .__matmul__(_rotate_y(orientation[1]))
    .__matmul__(_rotate_z(orientation[2]))
    .__matmul__(_rotate_x(value("ADBE Rotate X")))
    .__matmul__(_rotate_y(value("ADBE Rotate Y")))
    .__matmul__(_rotate_z(value("ADBE Rotate Z")));
}

/**
 * A camera or light's rig, turning in square pixels like a layer (see
 * `build_local_matrix`).
 */
export function _rig_matrix(layer: Layer, time: number | null, space_aspect: number): Mat4 {
  const position = _prop_value(layer.transform, "ADBE Position", time);
  let m = _rig_rotation(layer, time, space_aspect);
  if (space_aspect !== 1.0) m = _scale(1.0 / space_aspect, 1.0, 1.0).__matmul__(m);
  return _translation(position[0], position[1], position[2]).__matmul__(m);
}

/**
 * A layer's auto-orientation at comp `time`: `(3D rotation, 2D Rotate Z increment)`, measured on AE 2026.
 *
 * - Along its path, a 2D layer turns its X axis to the motion direction;
 *   a 3D layer aims its Z axis along it (a two-node camera's look-at).
 *   A layer whose Position is not animated does not turn.
 * - Towards the camera, a 3D layer aims its Z axis away from the active
 *   camera (the comp's default camera without one).
 *
 * @throws {@link NotImplementedError} For separated Position dimensions along a path, a parented
 *   layer turned towards the camera, and characters turned towards the camera.
 */
export function _auto_rotation(layer: Layer, time: number, position: number[]): [Mat4 | null, number] {
  const mode = layer.auto_orient;
  const three_d = !!layer._ldta.three_d_layer;
  if (mode === AutoOrientType.ALONG_PATH) {
    const prop = layer.transform.property("ADBE Position");
    if (prop.dimensions_separated) {
      throw new NotImplementedError(
        `layer ${repr(layer.name)} auto-orients along a path with separated ` +
          "Position dimensions, which the transform math does not model",
      );
    }
    const direction = prop._motion_direction_at(time);
    if (direction == null) return [null, 0.0];
    if (three_d) {
      const forward = [...direction, 0.0, 0.0].slice(0, 3);
      return [_look_at_rotation([0.0, 0.0, 0.0], forward), 0.0];
    }
    return [null, degrees(Math.atan2(direction[1], direction[0]))];
  }
  if (mode === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST && three_d) {
    if (layer.parent != null) {
      throw new NotImplementedError(
        `layer ${repr(layer.name)} is parented and turned towards the ` +
          "camera, which the transform math does not model",
      );
    }
    return [_look_at_rotation(_camera_position(layer, time), position), 0.0];
  }
  if (mode === AutoOrientType.CHARACTERS_TOWARD_CAMERA) {
    throw new NotImplementedError(
      `layer ${repr(layer.name)} turns its characters towards the camera, ` +
        "which the transform math does not model",
    );
  }
  return [null, 0.0];
}

/**
 * World position of the camera active at `time` in `layer`'s comp:
 * the front-most enabled camera layer, else the comp's default camera.
 */
export function _camera_position(layer: Layer, time: number): number[] {
  const comp = layer.containing_comp;
  // Python `cast("AVLayer", layer)._active_camera_at(time)`.
  if (!_is_av_layer(layer)) {
    throw new AttributeError(`'${type_name(layer)}' object has no attribute '_active_camera_at'`);
  }
  const camera = layer._active_camera_at(time);
  if (camera != null) {
    const world = build_world_matrix(camera, time, undefined, { as_parent: true });
    return world.transform_point([0.0, 0.0, 0.0]);
  }
  const zoom = default_camera_zoom(comp.width, comp.pixel_aspect);
  return [comp.width / 2.0, comp.height / 2.0, -zoom];
}

// ------------------------------------------------------------------
// Matrix decomposition
// ------------------------------------------------------------------

export function _vec3_norm(v: number[]): number {
  // hypot, not sqrt(x*x + y*y + z*z): squaring overflows to inf above ~1.34e154
  // and the norm then poisons every value derived from it. Nested 2-argument
  // calls because hypot only takes 3 arguments from Python 3.8.
  return hypot(hypot(v[0], v[1]), v[2]);
}

/** Determinant of the upper-left 3x3 of a 4x4 matrix. */
export function _mat3_det(m: Mat4): number {
  return (
    m.__getitem__(0)[0] *
      (m.__getitem__(1)[1] * m.__getitem__(2)[2] - m.__getitem__(1)[2] * m.__getitem__(2)[1]) -
    m.__getitem__(0)[1] *
      (m.__getitem__(1)[0] * m.__getitem__(2)[2] - m.__getitem__(1)[2] * m.__getitem__(2)[0]) +
    m.__getitem__(0)[2] *
      (m.__getitem__(1)[0] * m.__getitem__(2)[1] - m.__getitem__(1)[1] * m.__getitem__(2)[0])
  );
}

/**
 * The rotation of `matrix`, with translation and scale divided out.
 *
 * Column-normalizes the 3x3 block, then negates all three columns when the
 * result is a reflection, so what comes back is always a proper rotation.
 * That mirrors AE, which keeps the rotation proper and pushes the flip into
 * the scale as an all-negative triple: a parent scaled `[-100, 100, 100]`
 * leaves the child at scale `[-100, -100, -100]` with Orientation
 * `[180, 0, 0]`, not at a mirrored rotation.
 *
 * Exact for a rotation composed with a uniform scale. A non-uniform parent
 * scale combined with a rotation that is not axis-aligned shears the block,
 * and no rotation represents it - the case where AE's own reparenting jumps
 * too.
 */
export function rotation_part(matrix: Mat4): Mat4 {
  const rows: number[][] = Array.from({ length: 4 }, () => [0.0, 0.0, 0.0, 0.0]);
  rows[3][3] = 1.0;
  for (let column = 0; column < 3; column++) {
    const axis = [0, 1, 2].map((row) => matrix.__getitem__(row)[column]);
    const norm = _vec3_norm(axis);
    const length = norm !== 0 ? norm : 1.0;
    for (let row = 0; row < 3; row++) rows[row][column] = axis[row] / length;
  }
  const normalized = new Mat4(rows);
  if (_mat3_det(normalized) < 0) {
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) rows[row][column] = -rows[row][column];
    }
  }
  return new Mat4(rows);
}

/**
 * Euler angles for `delta` applied on top of `orientation`.
 *
 * After Effects compensates a reparent of a 3D layer through Orientation
 * rather than through Rotate X/Y/Z: `O_new = parent_rotation^-1 . O_old`,
 * with the rotations left exactly as they were. Verified on AE 2026 across
 * ten cases to 0.01 degrees, including a child carrying its own non-zero
 * rotations - those cancel out of the relation, which is why the answer
 * does not depend on them.
 */
export function compose_orientation(orientation: number[], delta: Mat4): number[] {
  const current = _rotate_x(orientation[0])
    .__matmul__(_rotate_y(orientation[1]))
    .__matmul__(_rotate_z(orientation[2]));
  const combined = delta.__matmul__(current);
  const angles = _euler_xyz(
    combined.__getitem__(0)[0],
    combined.__getitem__(0)[1],
    combined.__getitem__(0)[2],
    combined.__getitem__(1)[0],
    combined.__getitem__(1)[1],
    combined.__getitem__(1)[2],
    combined.__getitem__(2)[2],
  );
  return angles.map((angle) => mod(angle, 360.0));
}

/**
 * `matrix` with a layer's Orientation divided out of its 3x3 block.
 *
 * `build_local_matrix` composes `T(pos) . O . R . S . T(-anchor)`, so the
 * rotation After Effects would store for a given local matrix is `O^-1`
 * times its 3x3 part - and AE leaves Orientation itself untouched when
 * reparenting (measured on AE 2026: an oriented child under a translating
 * parent gets a new Position and nothing else).
 *
 * Only the 3x3 is divided. Orientation sits *inside* the position
 * translation, so left-multiplying the whole 4x4 by `O^-1` would rotate the
 * compensated position as well; the position decomposes from
 * `M[:,3] + M3 . anchor`, which the orientation never enters.
 */
export function strip_orientation(matrix: Mat4, orientation: number[]): Mat4 {
  const ox = orientation[0];
  const oy = orientation[1];
  const oz = orientation[2];
  const inverse = _rotate_z(-oz).__matmul__(_rotate_y(-oy)).__matmul__(_rotate_x(-ox));
  const rotated = inverse.__matmul__(matrix);
  const rows = [0, 1, 2, 3].map((r) => [...matrix.__getitem__(r)]);
  for (let r = 0; r < 3; r++) {
    rows[r][0] = rotated.__getitem__(r)[0];
    rows[r][1] = rotated.__getitem__(r)[1];
    rows[r][2] = rotated.__getitem__(r)[2];
  }
  return new Mat4(rows);
}

/**
 * Decompose a 4x4 matrix into AE transform components.
 *
 * Given a matrix `M` and a fixed anchor point, extracts the
 * Position, Scale, and Rotation values that would produce `M`
 * via `build_local_matrix`.
 *
 * Orientation is assumed to be `[0, 0, 0]` - i.e. any orientation
 * contribution must already be factored out before calling this.
 *
 * @param matrix - The 4x4 transform matrix to decompose.
 * @param anchor - `[ax, ay, az]` anchor point (held constant).
 * @returns A tuple of `(position, scale_pct, rotation_z, rotate_x, rotate_y)` where `scale_pct` is
 *   in percentage units (100 = 1x).
 */
export function decompose_transform(
  matrix: Mat4,
  anchor: number[],
): [number[], number[], number, number, number] {
  const ax = anchor[0];
  const ay = anchor[1];
  const az = anchor.length > 2 ? anchor[2] : 0.0;

  // Q = M @ T(anchor) - factors out the anchor translation.
  // This gives Q = T(pos) * R * S, which is straightforward to
  // decompose.
  const t_anchor = _translation(ax, ay, az);
  const q = matrix.__matmul__(t_anchor);

  // Position is in the last column.
  const pos = [q.__getitem__(0)[3], q.__getitem__(1)[3], q.__getitem__(2)[3]];

  // Extract 3x3 upper-left (contains R * S).
  const col0 = [q.__getitem__(0)[0], q.__getitem__(1)[0], q.__getitem__(2)[0]];
  const col1 = [q.__getitem__(0)[1], q.__getitem__(1)[1], q.__getitem__(2)[1]];
  const col2 = [q.__getitem__(0)[2], q.__getitem__(1)[2], q.__getitem__(2)[2]];

  let sx = _vec3_norm(col0);
  let sy = _vec3_norm(col1);
  let sz = _vec3_norm(col2);

  // Flip detection: if determinant is negative, one scale axis is
  // flipped. Convention: negate sx.
  if (_mat3_det(q) < 0) sx = -sx;

  // Clamp near-zero scales to avoid division by zero.
  if (Math.abs(sx) < _EPSILON) sx = sx >= 0 ? _EPSILON : -_EPSILON;
  if (Math.abs(sy) < _EPSILON) sy = sy >= 0 ? _EPSILON : -_EPSILON;
  if (Math.abs(sz) < _EPSILON) sz = sz >= 0 ? _EPSILON : -_EPSILON;

  // Rotation matrix = Q3 * diag(1/sx, 1/sy, 1/sz)
  const r00 = col0[0] / sx;
  const r10 = col0[1] / sx;
  const r01 = col1[0] / sy;
  const r11 = col1[1] / sy;
  const r02 = col2[0] / sz;
  const r12 = col2[1] / sz;
  const r22 = col2[2] / sz;

  const [rx_deg, ry_deg, rz_deg] = _euler_xyz(r00, r01, r02, r10, r11, r12, r22);

  const scale_pct = [sx * 100.0, sy * 100.0, sz * 100.0];
  return [pos, scale_pct, rz_deg, rx_deg, ry_deg];
}

/**
 * Extract intrinsic X-Y-Z Euler angles (degrees) from R = Rx*Ry*Rz.
 *
 * R = | cb*cg       -cb*sg        sb    |
 *     | sa*sb*cg+ca*sg  -sa*sb*sg+ca*cg  -sa*cb |
 *     | -ca*sb*cg+sa*sg  ca*sb*sg+sa*cg   ca*cb |
 */
export function _euler_xyz(
  r00: number,
  r01: number,
  r02: number,
  r10: number,
  r11: number,
  r12: number,
  r22: number,
): [number, number, number] {
  // Clamp to [-1, 1] for asin safety.
  const sin_beta = max([-1.0, min([1.0, r02])]);
  // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
  const beta = Math.asin(sin_beta);
  // cos(beta) straight off the matrix. Going through `cos(asin(r02))`
  // loses most of its digits as r02 approaches 1, which matters because
  // an orientation slerping towards a 90-degree Y passes near the pole
  // on almost every frame without ever reaching it.
  const cos_beta = hypot(r00, r01);

  let rx_deg: number;
  let ry_deg: number;
  let rz_deg: number;
  if (Math.abs(cos_beta) > _EPSILON) {
    // Normal case: no gimbal lock.
    rx_deg = Math.atan2(-r12, r22) * _RAD2DEG;
    ry_deg = beta * _RAD2DEG;
    rz_deg = Math.atan2(-r01, r00) * _RAD2DEG;
  } else {
    // Gimbal lock: beta = +/-90 deg, where X and Z turn about the same
    // line and only their combination is recoverable. AE puts all of it
    // on Z and leaves X at zero - measured on AE 2026 by reparenting a
    // 3D child at orientation [0, 0, g] under a parent rotated Y = +/-90,
    // which AE writes back as [0, 270, g] / [0, 90, g] for g across a
    // full turn. Solving the same relation for X instead (the previous
    // behavior) does not even reconstruct the rotation at beta = -90.
    rx_deg = 0.0;
    rz_deg = Math.atan2(r10, r11) * _RAD2DEG;
    ry_deg = beta * _RAD2DEG;
  }
  return [rx_deg, ry_deg, rz_deg];
}

// ------------------------------------------------------------------
// Vector helpers
// ------------------------------------------------------------------

export function _vec3_cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function _vec3_normalize(v: number[]): number[] {
  const n = _vec3_norm(v);
  if (n < _EPSILON) throw new ValueError("cannot normalize a zero-length vector");
  return [v[0] / n, v[1] / n, v[2] / n];
}

// ------------------------------------------------------------------
// calculateTransformFromPoints
// ------------------------------------------------------------------

/**
 * Compute AE transform values mapping a layer source onto three points.
 *
 * Pure function of the three points and the layer's SOURCE dimensions
 * (verified against AE 2026: the layer's current transform is ignored,
 * and 2D and 3D layers return identical results). The y axis is
 * Gram-Schmidt-orthogonalized against x, absorbing any shear into
 * `scale[2] = 100 * sin(angle(x, y))`; reflections come out as 180-degree
 * rotation combinations, never negative scale.
 *
 * @param top_left - `[x, y, z]` comp-space position of the source's top-left.
 * @param top_right - `[x, y, z]` position of the source's top-right.
 * @param bottom_left - `[x, y, z]` position of the source's bottom-left.
 * @param width - Layer source width in pixels.
 * @param height - Layer source height in pixels.
 * @returns An object with `anchor_point`, `position`, `x_rotation`, `y_rotation`, `z_rotation` and
 *   `scale` keys, matching the transform property values AE's `calculateTransformFromPoints()`
 *   returns.
 * @throws {@link ValueError} If the points are coincident or collinear.
 */
export function transform_from_points(
  top_left: number[],
  top_right: number[],
  bottom_left: number[],
  width: number,
  height: number,
): Record<string, number | number[]> {
  const x_axis = [0, 1, 2].map((i) => top_right[i] - top_left[i]);
  const y_axis = [0, 1, 2].map((i) => bottom_left[i] - top_left[i]);
  const x_len = _vec3_norm(x_axis);
  const y_len = _vec3_norm(y_axis);
  if (x_len < _EPSILON || y_len < _EPSILON) {
    throw new ValueError("transform points must not be coincident");
  }
  const x_hat = x_axis.map((c) => c / x_len);
  const y_raw_hat = y_axis.map((c) => c / y_len);

  // Shear is absorbed into the z scale: 100 * sin(angle between x and y).
  const sin_theta = _vec3_norm(_vec3_cross(x_hat, y_raw_hat));

  const x_dot_y = sum([0, 1, 2].map((i) => x_hat[i] * y_axis[i]));
  const y_ortho = [0, 1, 2].map((i) => y_axis[i] - x_dot_y * x_hat[i]);
  const y_ortho_len = _vec3_norm(y_ortho);
  if (y_ortho_len < _EPSILON) throw new ValueError("transform points must not be collinear");
  const y_hat = y_ortho.map((c) => c / y_ortho_len);
  const z_hat = _vec3_cross(x_hat, y_hat);

  const [rx_deg, ry_deg, rz_deg] = _euler_xyz(
    x_hat[0],
    y_hat[0],
    z_hat[0],
    x_hat[1],
    y_hat[1],
    z_hat[1],
    z_hat[2],
  );

  return {
    anchor_point: [0.0, 0.0, 0.0],
    position: [top_left[0], top_left[1], top_left[2]],
    x_rotation: rx_deg,
    y_rotation: ry_deg,
    z_rotation: rz_deg,
    scale: [(x_len / width) * 100.0, (y_ortho_len / height) * 100.0, sin_theta * 100.0],
  };
}

// ------------------------------------------------------------------
// Camera projection (sourcePointToComp / compPointToSource)
// ------------------------------------------------------------------

/**
 * AE's default comp camera zoom in pixels: `width * pixel_aspect / 0.72`
 * (the 50mm preset; 2 * tan(fov/2) held at the exact 0.72 ratio).
 *
 * The zoom is in SQUARE pixels, so a non-square-pixel comp scales the
 * width by its pixel aspect ratio first (verified against AE 2026 at
 * pixel aspects 0.5 / 1.0 / 1.21212).
 */
export function default_camera_zoom(comp_width: number, pixel_aspect: number): number {
  return (comp_width * pixel_aspect) / 0.72;
}

/**
 * Project a world-space point to comp coordinates.
 *
 * Always uses AE's DEFAULT comp camera: `sourcePointToComp()` is
 * camera-independent (verified against AE 2026 - one-node, two-node and
 * keyframed-zoom rigs all return the values of the default camera). For
 * a point in the z=0 plane the projection is the identity, so 2D layers
 * fall out naturally.
 */
export function project_to_comp(
  world_point: number[],
  comp_width: number,
  comp_height: number,
  pixel_aspect: number,
): number[] {
  const zoom = default_camera_zoom(comp_width, pixel_aspect);
  const cx = comp_width / 2.0;
  const cy = comp_height / 2.0;
  const factor = zoom / (zoom + world_point[2]);
  return [cx + (world_point[0] - cx) * factor, cy + (world_point[1] - cy) * factor];
}

/**
 * Rotation orienting a camera at `eye` toward `target` (AE two-node
 * rig): the camera z axis points at the target, roll referenced to +Y.
 *
 * Both degenerate inputs resolve the way AE does, rather than raising
 * (probed AE 2026 over a 116-point elevation x azimuth sweep, both
 * poles, three radii):
 *
 * - `eye == target`: AE applies no look-at at all, leaving its neutral
 *   +Z heading.
 * - view direction parallel to +Y (a plain top-down or bottom-up
 *   camera, where `cross(up, forward)` vanishes): AE resolves the roll
 *   as if the azimuth were 0. Away from the poles AE is smooth and
 *   azimuth-dependent down to at least 1e-7 degrees - it does NOT snap
 *   within a tolerance band - so the fallback must apply only where the
 *   cross product is genuinely zero, which `_EPSILON` already separates
 *   (|cross| is ~1.7e-9 at 1e-7 degrees off vertical, vs ~6e-17 or an
 *   exact 0 at the pole).
 */
export function _look_at_rotation(eye: number[], target: number[]): Mat4 {
  const delta = [0, 1, 2].map((i) => target[i] - eye[i]);
  let forward: number[];
  if (_vec3_norm(delta) < _EPSILON) {
    forward = [0.0, 0.0, 1.0];
  } else {
    forward = _vec3_normalize(delta);
  }
  const up = [0.0, 1.0, 0.0];
  const cross = _vec3_cross(up, forward);
  let x_axis: number[];
  if (_vec3_norm(cross) < _EPSILON) {
    x_axis = [1.0, 0.0, 0.0];
  } else {
    x_axis = _vec3_normalize(cross);
  }
  const y_axis = _vec3_cross(forward, x_axis);
  const m = Mat4.identity();
  for (let row = 0; row < 3; row++) {
    m.__getitem__(row)[0] = x_axis[row];
    m.__getitem__(row)[1] = y_axis[row];
    m.__getitem__(row)[2] = forward[row];
  }
  return m;
}

/**
 * Build the world-space ray a comp-space point casts from a camera.
 *
 * With no camera, uses AE's default comp camera (centered at
 * `(w/2, h/2, -zoom)`, unrotated). With a camera layer, the ray starts at
 * the camera position and passes through the comp point on the image
 * plane at the camera's zoom distance; a two-node camera derives its
 * rotation from the look-at toward its point of interest (stored in the
 * anchor-point slot), then applies Orientation and the per-axis
 * rotations on top.
 *
 * @returns `(origin, direction)` in world space.
 */
export function camera_ray(
  camera: Layer | null,
  comp_point: number[],
  comp_width: number,
  comp_height: number,
  pixel_aspect: number,
  time: number | null = null,
): [number[], number[]] {
  const cx = comp_width / 2.0;
  const cy = comp_height / 2.0;

  if (camera == null) {
    const zoom = default_camera_zoom(comp_width, pixel_aspect);
    const origin = [cx, cy, -zoom];
    const direction = [comp_point[0] - cx, comp_point[1] - cy, zoom];
    return [origin, direction];
  }

  // The camera's whole parent chain places it (AE 2026: a camera parented
  // to a turned null casts its rays from where the null carries it).
  const world = build_world_matrix(camera, time, undefined, { as_parent: true });
  const position = world.transform_point([0.0, 0.0, 0.0]);

  const camera_options = camera.property("ADBE Camera Options Group");
  const zoom = _prop_value(camera_options, "ADBE Camera Zoom", time);

  // The image plane is in square pixels; the rig matrix narrows the ray
  // back into comp pixels (see `build_local_matrix`).
  const direction = world.transform_vector([
    (comp_point[0] - cx) * pixel_aspect,
    comp_point[1] - cy,
    zoom,
  ]);
  return [[...position], direction];
}

/**
 * Intersect a world-space ray with a layer's source plane.
 *
 * Solves `origin + t * direction = world(u, v, 0)` for the layer
 * coordinates `(u, v)` directly, without inverting `world`: the plane
 * only needs the layer's X and Y axes, so a layer whose Z scale is 0
 * still resolves (AE 2026 answers for one).
 *
 * Only the FORWARD ray counts, like AE: a plane at or behind the ray's
 * origin is not hit. Probed AE 2026 over a sub-0.001-unit sweep through
 * `t = 0` and a dedicated parallel-ray rig - the boundary is inclusive
 * (`t == 0` already misses), and a parallel ray is the same case rather
 * than a special one.
 *
 * Where this raises, AE returns a literal `[0, 0]`. That is NOT mirrored:
 * the sentinel is type- and range-indistinguishable from a real answer
 * (a rig whose genuine intersection IS the layer origin returns the same
 * `[0, 0]`), the AE Scripting Guide does not document it, and a caller
 * that cannot tell a miss from a hit will use the miss as a coordinate.
 *
 * @throws {@link ValueError} If the forward ray does not meet the layer plane - it is parallel to
 *   the plane, or the plane is at or behind the ray origin - or if the layer plane is degenerate
 *   (an X or Y scale of 0).
 */
export function intersect_layer_plane(world: Mat4, origin: number[], direction: number[]): number[] {
  const axis_u = [0, 1, 2].map((r) => world.__getitem__(r)[0]);
  const axis_v = [0, 1, 2].map((r) => world.__getitem__(r)[1]);
  const rhs = [0, 1, 2].map((r) => origin[r] - world.__getitem__(r)[3]);
  const neg_d = [0, 1, 2].map((r) => -direction[r]);
  const normal = _vec3_cross(axis_u, axis_v);
  const normal_len = _vec3_norm(normal);
  if (normal_len === 0.0) throw new ValueError("the layer plane is degenerate");
  const det = _det3(axis_u, axis_v, neg_d);
  if (Math.abs(det) <= _EPSILON * normal_len * _vec3_norm(direction)) {
    throw new ValueError("ray is parallel to the layer plane");
  }
  const t = _det3(axis_u, axis_v, rhs) / det;
  if (t <= 0.0) throw new ValueError("the layer plane is not in front of the camera");
  return [_det3(rhs, axis_v, neg_d) / det, _det3(axis_u, rhs, neg_d) / det];
}

/** Determinant of the 3x3 matrix with columns `a`, `b`, `c`. */
export function _det3(a: number[], b: number[], c: number[]): number {
  const cross = _vec3_cross(b, c);
  return a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2];
}
