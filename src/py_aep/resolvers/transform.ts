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

import { INSPECT, describe } from "../../pyrt/index.ts";
import { AutoOrientType, LayerType, LightType } from "../enums/index.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { AVLayer } from "../models/layers/av_layer.ts";
import type { Layer } from "../models/layers/layer.ts";
import type { LightLayer } from "../models/layers/light_layer.ts";
import type { MatchNameTypes } from "../models/properties/match_name_types.ts";
import type { Property } from "../models/properties/property.ts";
import type { PropertyGroup } from "../models/properties/property_group.ts";
import { AttributeError, NotImplementedError, ValueError, degrees, typeName, literal } from "../../pyrt/index.ts";

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

  row(row: number): number[] {
    return this._rows[row];
  }

  /** Matrix product `this × other`. */
  multiply(other: Mat4): Mat4 {
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
  transformPoint(v: number[]): number[] {
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
  transformVector(v: number[]): number[] {
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
      for (let c = 0; c < 4; c++) s.push(this.row(r)[c]);
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
    const absVals: number[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) absVals.push(Math.abs(s[r * 4 + c]));
    }
    // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
    const scale = Math.max(...absVals);
    if (det === 0.0 || Math.abs(det) <= _EPSILON * 1e-2 * scale ** 3) {
      throw new ValueError("Singular matrix, cannot invert.");
    }

    const invDet = 1.0 / det;

    return new Mat4([
      [
        (s[5] * c5 - s[6] * c4 + s[7] * c3) * invDet,
        (-s[1] * c5 + s[2] * c4 - s[3] * c3) * invDet,
        (s[13] * s5 - s[14] * s4 + s[15] * s3) * invDet,
        (-s[9] * s5 + s[10] * s4 - s[11] * s3) * invDet,
      ],
      [
        (-s[4] * c5 + s[6] * c2 - s[7] * c1) * invDet,
        (s[0] * c5 - s[2] * c2 + s[3] * c1) * invDet,
        (-s[12] * s5 + s[14] * s2 - s[15] * s1) * invDet,
        (s[8] * s5 - s[10] * s2 + s[11] * s1) * invDet,
      ],
      [
        (s[4] * c4 - s[5] * c2 + s[7] * c0) * invDet,
        (-s[0] * c4 + s[1] * c2 - s[3] * c0) * invDet,
        (s[12] * s4 - s[13] * s2 + s[15] * s0) * invDet,
        (-s[8] * s4 + s[9] * s2 - s[11] * s0) * invDet,
      ],
      [
        (-s[4] * c3 + s[5] * c1 - s[6] * c0) * invDet,
        (s[0] * c3 - s[1] * c1 + s[2] * c0) * invDet,
        (-s[12] * s3 + s[13] * s1 - s[14] * s0) * invDet,
        (s[8] * s3 - s[9] * s1 + s[10] * s0) * invDet,
      ],
    ]);
  }

  [INSPECT](): string {
    return describe("Mat4", { rows: this._rows });
  }
}

// ------------------------------------------------------------------
// Elementary transform matrices
// ------------------------------------------------------------------

export function _translation(x: number, y: number, z: number): Mat4 {
  const m = Mat4.identity();
  m.row(0)[3] = x;
  m.row(1)[3] = y;
  m.row(2)[3] = z;
  return m;
}

export function _scale(sx: number, sy: number, sz: number): Mat4 {
  const m = Mat4.identity();
  m.row(0)[0] = sx;
  m.row(1)[1] = sy;
  m.row(2)[2] = sz;
  return m;
}

export function _rotateX(deg: number): Mat4 {
  const r = deg * _DEG2RAD;
  // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = Mat4.identity();
  m.row(1)[1] = c;
  m.row(1)[2] = -s;
  m.row(2)[1] = s;
  m.row(2)[2] = c;
  return m;
}

export function _rotateY(deg: number): Mat4 {
  const r = deg * _DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = Mat4.identity();
  m.row(0)[0] = c;
  m.row(0)[2] = s;
  m.row(2)[0] = -s;
  m.row(2)[2] = c;
  return m;
}

export function _rotateZ(deg: number): Mat4 {
  const r = deg * _DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = Mat4.identity();
  m.row(0)[0] = c;
  m.row(0)[1] = -s;
  m.row(1)[0] = s;
  m.row(1)[1] = c;
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
 * @param scalePct - `[sx, sy, sz]` scale as percentages (100 = 1x).
 * @param rotationZ - Z-axis rotation in degrees.
 * @param kw - Keyword arguments:
 * - `orientation`: `[ox, oy, oz]` orientation angles in degrees (3D layers only).
 * - `rotateX`: X-axis rotation in degrees (3D layers only).
 * - `rotateY`: Y-axis rotation in degrees (3D layers only).
 * - `autoRotation`: A 3D layer's auto-orientation, applied after its own rotations (before the
 *     translation).
 * - `sourceAspect`: The pixel aspect of the layer's own pixels (`Sl`).
 * - `spaceAspect`: The pixel aspect of the space the layer's Position lives in (`Sp`).
 * @returns A 4x4 matrix representing the layer's local transform.
 */
export function buildLocalMatrix(
  position: number[],
  anchor: number[],
  scalePct: number[],
  rotationZ: number,
  kw: {
    orientation?: number[] | null;
    rotateX?: number;
    rotateY?: number;
    autoRotation?: Mat4 | null;
    sourceAspect?: number;
    spaceAspect?: number;
  } = {},
): Mat4 {
  const {
    orientation = null,
    rotateX = 0.0,
    rotateY = 0.0,
    autoRotation = null,
    sourceAspect = 1.0,
    spaceAspect = 1.0,
  } = kw;

  const sx = scalePct[0] / 100.0;
  const sy = scalePct[1] / 100.0;
  const sz = scalePct.length > 2 ? scalePct[2] / 100.0 : 1.0;

  // Start from right: T(-anchor)
  let m = _translation(-anchor[0], -anchor[1], anchor.length > 2 ? -anchor[2] : 0.0);
  if (sourceAspect !== 1.0) m = _scale(sourceAspect, 1.0, 1.0).multiply(m);

  // Scale
  m = _scale(sx, sy, sz).multiply(m);

  // Per-axis rotations: Rz * Ry * Rx (applied right-to-left)
  m = _rotateZ(rotationZ).multiply(m);
  m = _rotateY(rotateY).multiply(m);
  m = _rotateX(rotateX).multiply(m);

  // Orientation: Rz(oz) * Ry(oy) * Rx(ox)
  if (orientation != null) {
    const ox = orientation[0];
    const oy = orientation[1];
    const oz = orientation[2];
    m = _rotateZ(oz).multiply(m);
    m = _rotateY(oy).multiply(m);
    m = _rotateX(ox).multiply(m);
  }

  if (autoRotation != null) m = autoRotation.multiply(m);

  if (spaceAspect !== 1.0) m = _scale(1.0 / spaceAspect, 1.0, 1.0).multiply(m);

  // Position
  const px = position[0];
  const py = position[1];
  const pz = position.length > 2 ? position[2] : 0.0;
  m = _translation(px, py, pz).multiply(m);

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
 * @param flatten2d - Drop the out-of-plane terms (see `_layerLocalMatrix`).
 * @param kw - Keyword arguments:
 * - `asParent`: Treat `layer` itself as a parent too - a camera or light then contributes its rig.
 * - `autoOrient`: Apply the layers' auto-orientation (needs `time`).
 * @throws {@link NotImplementedError} With `autoOrient`, for an orientation the math does not
 *   model (see `_autoRotation`).
 */
export function buildWorldMatrix(
  layer: Layer,
  time: number | null = null,
  flatten2d = false,
  kw: { asParent?: boolean; autoOrient?: boolean } = {},
): Mat4 {
  const { asParent = false, autoOrient = false } = kw;

  const chain: Layer[] = [];
  let current: Layer | null = layer;
  while (current != null) {
    chain.push(current);
    current = current.parent;
  }

  // Compose from root (last in chain) down to the layer itself. Each
  // Position lives in its parent's pixels (the comp's for the root).
  let m = Mat4.identity();
  const comp = layer.containingComp;
  let spaceAspect = comp.pixelAspect;
  for (const lyr of chain.reverse()) {
    if ((lyr !== layer || asParent) && _RIG_TYPES.has(lyr._ldta.layerType)) {
      if (flatten2d) {
        // Under a 2D layer a rig acts as a 2D layer anchored on the
        // comp centre, turned by Rotate Z alone (AE 2026: children
        // of a camera, a spot and a point light all fit
        // `T(pos.xy) . Rz . T(-w/2, -h/2)` exactly).
        const position = _propValue(lyr.transform, "ADBE Position", time);
        const rz = _propValue(lyr.transform, "ADBE Rotate Z", time);
        m = m.multiply(
          _translation(position[0], position[1], 0.0)
            .multiply(_rotateZ(rz))
            .multiply(_translation(-comp.width / 2.0, -comp.height / 2.0, 0.0)),
        );
      } else {
        m = m.multiply(_rigMatrix(lyr, time, spaceAspect));
      }
      spaceAspect = 1.0;
    } else {
      const sourceAspect = layerSourceAspect(lyr);
      m = m.multiply(
        _layerLocalMatrix(lyr, time, flatten2d, autoOrient, sourceAspect, spaceAspect),
      );
      spaceAspect = sourceAspect;
    }
  }
  return m;
}

/** Pixel aspect of a layer's own pixels: its source's, else square. */
export function layerSourceAspect(layer: Layer): number {
  const source = layer._sourceItem;
  const aspect = source != null && "pixelAspect" in source ? source.pixelAspect : null;
  return aspect != null && aspect !== 0 ? aspect : 1.0;
}

/**
 * Pixel aspect of the space a child of `parent` keeps its Position in:
 * the comp's at the root, square under a camera or light.
 */
export function positionSpaceAspect(parent: Layer | null, comp: CompItem): number {
  if (parent == null) return comp.pixelAspect;
  if (_RIG_TYPES.has(parent._ldta.layerType)) return 1.0;
  return layerSourceAspect(parent);
}

/** `diag(aspect, 1, 1)`: widens pixels of that aspect to square ones. */
export function aspectScale(aspect: number): Mat4 {
  return _scale(aspect, 1.0, 1.0);
}

/**
 * A world matrix from a `spaceAspect` space into comp pixels, made to
 * map square pixels to square pixels (so its rotation can be read).
 */
export function squarePixels(matrix: Mat4, compAspect: number, spaceAspect: number): Mat4 {
  return aspectScale(compAspect).multiply(matrix).multiply(aspectScale(1.0 / spaceAspect));
}

/**
 * Evaluate `group[match_name]`: static `value` when `time` is `null`,
 * else `value_at_time(time)`.
 */
export function _propValue<K extends _PropertyName>(
  group: PropertyGroup,
  matchName: K,
  time: number | null,
): _PropertyValueOf<K>;
export function _propValue(group: PropertyGroup, matchName: _PropertyName, time: number | null) {
  const prop = group.property(matchName);
  if (time == null) return prop.value;
  return prop.valueAtTime(time);
}

/**
 * Build the local matrix for a single layer from its properties.
 *
 * With `flatten2d`, the out-of-plane terms are dropped - X/Y rotation,
 * the whole Orientation and the Z translation. That is how After Effects
 * places a 2D layer under 3D ancestors, for its point conversions as well
 * as when compensating a reparent: a 2D layer parented to a null rotated
 * 20/-35/30 gets exactly the compensation of a null rotated 0/0/30, and
 * a parent's Orientation does not turn it at all (measured on AE 2026: a
 * parent with Orientation [0, 0, 30] leaves the child's Rotate Z at 0).
 */
export function _layerLocalMatrix(
  layer: Layer,
  time: number | null = null,
  flatten2d = false,
  autoOrient = false,
  sourceAspect = 1.0,
  spaceAspect = 1.0,
): Mat4 {
  const transform = layer.transform;

  const value = <K extends _PropertyName>(matchName: K): _PropertyValueOf<K> => _propValue(transform, matchName, time);

  let position: number[] = value("ADBE Position");
  const anchor: number[] = value("ADBE Anchor Point");
  const scalePct: number[] = value("ADBE Scale");
  let rz: number = value("ADBE Rotate Z");
  let orientation: number[] = value("ADBE Orientation");
  let rx: number = value("ADBE Rotate X");
  let ry: number = value("ADBE Rotate Y");

  if (flatten2d) {
    position = [...position.slice(0, 2), 0.0];
    rx = 0.0;
    ry = 0.0;
    orientation = [0.0, 0.0, 0.0];
  }

  let autoRotation: Mat4 | null = null;
  if (autoOrient && time != null) {
    const [rot, autoRz] = _autoRotation(layer, time, position);
    autoRotation = rot;
    rz += autoRz;
  }

  const is3d = rx !== 0.0 || ry !== 0.0 || orientation.some((v) => v !== 0.0);

  return buildLocalMatrix(position, anchor, scalePct, rz, {
    orientation: is3d ? orientation : null,
    rotateX: rx,
    rotateY: ry,
    autoRotation,
    sourceAspect,
    spaceAspect,
  });
}

// Layer types (`ldta.layerType`) a child parents to as a rig: light, camera.
export const _RIG_TYPES: ReadonlySet<number> = new Set<number>([LayerType.LIGHT, LayerType.CAMERA]);
export const _AIMED_LIGHTS: ReadonlySet<number> = new Set<number>([LightType.SPOT, LightType.PARALLEL]);

/**
 * Whether a camera or light layer is a two-node rig that looks at its
 * point of interest: a camera, spot or parallel light orienting towards it
 * (a point light keeps the flag but AE applies no look-at).
 */
/** A light layer: the only layer kind with a `lightType`. */
function _isLight(layer: Layer): layer is LightLayer {
  return "lightType" in layer;
}

/** An AV layer: the only layer kind that resolves its comp's active camera. */
function _isAvLayer(layer: Layer): layer is AVLayer {
  return "_activeCameraAt" in layer;
}

export function rigAimsAtPoi(layer: Layer): boolean {
  const layerType = layer._ldta.layerType;
  if (!_RIG_TYPES.has(layerType)) return false;
  const aims =
    layerType === LayerType.CAMERA || (_isLight(layer) && _AIMED_LIGHTS.has(layer.lightType));
  return aims && layer.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
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
export function _rigRotation(layer: Layer, time: number | null, spaceAspect: number): Mat4 {
  const transform = layer.transform;

  const value = <K extends _PropertyName>(matchName: K): _PropertyValueOf<K> => _propValue(transform, matchName, time);

  let rotation = Mat4.identity();
  if (rigAimsAtPoi(layer)) {
    const eye: number[] = [...value("ADBE Position")];
    const target: number[] = [...value("ADBE Anchor Point")];
    eye[0] *= spaceAspect;
    target[0] *= spaceAspect;
    rotation = _lookAtRotation(eye, target);
  }
  const orientation: number[] = value("ADBE Orientation");
  return rotation
    .multiply(_rotateX(orientation[0]))
    .multiply(_rotateY(orientation[1]))
    .multiply(_rotateZ(orientation[2]))
    .multiply(_rotateX(value("ADBE Rotate X")))
    .multiply(_rotateY(value("ADBE Rotate Y")))
    .multiply(_rotateZ(value("ADBE Rotate Z")));
}

/**
 * A camera or light's rig, turning in square pixels like a layer (see
 * `buildLocalMatrix`).
 */
export function _rigMatrix(layer: Layer, time: number | null, spaceAspect: number): Mat4 {
  const position = _propValue(layer.transform, "ADBE Position", time);
  let m = _rigRotation(layer, time, spaceAspect);
  if (spaceAspect !== 1.0) m = _scale(1.0 / spaceAspect, 1.0, 1.0).multiply(m);
  return _translation(position[0], position[1], position[2]).multiply(m);
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
export function _autoRotation(layer: Layer, time: number, position: number[]): [Mat4 | null, number] {
  const mode = layer.autoOrient;
  const threeD = !!layer._ldta.threeDLayer;
  if (mode === AutoOrientType.ALONG_PATH) {
    const prop = layer.transform.property("ADBE Position");
    if (prop.dimensionsSeparated) {
      throw new NotImplementedError(
        `layer ${literal(layer.name)} auto-orients along a path with separated ` +
          "Position dimensions, which the transform math does not model",
      );
    }
    const direction = prop._motionDirectionAt(time);
    if (direction == null) return [null, 0.0];
    if (threeD) {
      const forward = [...direction, 0.0, 0.0].slice(0, 3);
      return [_lookAtRotation([0.0, 0.0, 0.0], forward), 0.0];
    }
    return [null, degrees(Math.atan2(direction[1], direction[0]))];
  }
  if (mode === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST && threeD) {
    if (layer.parent != null) {
      throw new NotImplementedError(
        `layer ${literal(layer.name)} is parented and turned towards the ` +
          "camera, which the transform math does not model",
      );
    }
    return [_lookAtRotation(_cameraPosition(layer, time), position), 0.0];
  }
  if (mode === AutoOrientType.CHARACTERS_TOWARD_CAMERA) {
    throw new NotImplementedError(
      `layer ${literal(layer.name)} turns its characters towards the camera, ` +
        "which the transform math does not model",
    );
  }
  return [null, 0.0];
}

/**
 * World position of the camera active at `time` in `layer`'s comp:
 * the front-most enabled camera layer, else the comp's default camera.
 */
export function _cameraPosition(layer: Layer, time: number): number[] {
  const comp = layer.containingComp;
  // Python `cast("AVLayer", layer)._active_camera_at(time)`.
  if (!_isAvLayer(layer)) {
    throw new AttributeError(`'${typeName(layer)}' object has no attribute '_active_camera_at'`);
  }
  const camera = layer._activeCameraAt(time);
  if (camera != null) {
    const world = buildWorldMatrix(camera, time, undefined, { asParent: true });
    return world.transformPoint([0.0, 0.0, 0.0]);
  }
  const zoom = defaultCameraZoom(comp.width, comp.pixelAspect);
  return [comp.width / 2.0, comp.height / 2.0, -zoom];
}

// ------------------------------------------------------------------
// Matrix decomposition
// ------------------------------------------------------------------

export function _vec3Norm(v: number[]): number {
  // hypot, not sqrt(x*x + y*y + z*z): squaring overflows to inf above ~1.34e154
  // and the norm then poisons every value derived from it. Nested 2-argument
  // calls because hypot only takes 3 arguments from Python 3.8.
  return Math.hypot(Math.hypot(v[0], v[1]), v[2]);
}

/** Determinant of the upper-left 3x3 of a 4x4 matrix. */
export function _mat3Det(m: Mat4): number {
  return (
    m.row(0)[0] *
      (m.row(1)[1] * m.row(2)[2] - m.row(1)[2] * m.row(2)[1]) -
    m.row(0)[1] *
      (m.row(1)[0] * m.row(2)[2] - m.row(1)[2] * m.row(2)[0]) +
    m.row(0)[2] *
      (m.row(1)[0] * m.row(2)[1] - m.row(1)[1] * m.row(2)[0])
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
export function rotationPart(matrix: Mat4): Mat4 {
  const rows: number[][] = Array.from({ length: 4 }, () => [0.0, 0.0, 0.0, 0.0]);
  rows[3][3] = 1.0;
  for (let column = 0; column < 3; column++) {
    const axis = [0, 1, 2].map((row) => matrix.row(row)[column]);
    const norm = _vec3Norm(axis);
    const length = norm !== 0 ? norm : 1.0;
    for (let row = 0; row < 3; row++) rows[row][column] = axis[row] / length;
  }
  const normalized = new Mat4(rows);
  if (_mat3Det(normalized) < 0) {
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
export function composeOrientation(orientation: number[], delta: Mat4): number[] {
  const current = _rotateX(orientation[0])
    .multiply(_rotateY(orientation[1]))
    .multiply(_rotateZ(orientation[2]));
  const combined = delta.multiply(current);
  const angles = _eulerXyz(
    combined.row(0)[0],
    combined.row(0)[1],
    combined.row(0)[2],
    combined.row(1)[0],
    combined.row(1)[1],
    combined.row(1)[2],
    combined.row(2)[2],
  );
  return angles.map((angle) => ((angle % 360.0) + 360.0) % 360.0);
}

/**
 * `matrix` with a layer's Orientation divided out of its 3x3 block.
 *
 * `buildLocalMatrix` composes `T(pos) . O . R . S . T(-anchor)`, so the
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
export function stripOrientation(matrix: Mat4, orientation: number[]): Mat4 {
  const ox = orientation[0];
  const oy = orientation[1];
  const oz = orientation[2];
  const inverse = _rotateZ(-oz).multiply(_rotateY(-oy)).multiply(_rotateX(-ox));
  const rotated = inverse.multiply(matrix);
  const rows = [0, 1, 2, 3].map((r) => [...matrix.row(r)]);
  for (let r = 0; r < 3; r++) {
    rows[r][0] = rotated.row(r)[0];
    rows[r][1] = rotated.row(r)[1];
    rows[r][2] = rotated.row(r)[2];
  }
  return new Mat4(rows);
}

/**
 * Decompose a 4x4 matrix into AE transform components.
 *
 * Given a matrix `M` and a fixed anchor point, extracts the
 * Position, Scale, and Rotation values that would produce `M`
 * via `buildLocalMatrix`.
 *
 * Orientation is assumed to be `[0, 0, 0]` - i.e. any orientation
 * contribution must already be factored out before calling this.
 *
 * @param matrix - The 4x4 transform matrix to decompose.
 * @param anchor - `[ax, ay, az]` anchor point (held constant).
 * @returns A tuple of `(position, scale_pct, rotation_z, rotate_x, rotate_y)` where `scalePct` is
 *   in percentage units (100 = 1x).
 */
export function decomposeTransform(
  matrix: Mat4,
  anchor: number[],
): [number[], number[], number, number, number] {
  const ax = anchor[0];
  const ay = anchor[1];
  const az = anchor.length > 2 ? anchor[2] : 0.0;

  // Q = M @ T(anchor) - factors out the anchor translation.
  // This gives Q = T(pos) * R * S, which is straightforward to
  // decompose.
  const tAnchor = _translation(ax, ay, az);
  const q = matrix.multiply(tAnchor);

  // Position is in the last column.
  const pos = [q.row(0)[3], q.row(1)[3], q.row(2)[3]];

  // Extract 3x3 upper-left (contains R * S).
  const col0 = [q.row(0)[0], q.row(1)[0], q.row(2)[0]];
  const col1 = [q.row(0)[1], q.row(1)[1], q.row(2)[1]];
  const col2 = [q.row(0)[2], q.row(1)[2], q.row(2)[2]];

  let sx = _vec3Norm(col0);
  let sy = _vec3Norm(col1);
  let sz = _vec3Norm(col2);

  // Flip detection: if determinant is negative, one scale axis is
  // flipped. Convention: negate sx.
  if (_mat3Det(q) < 0) sx = -sx;

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

  const [rxDeg, ryDeg, rzDeg] = _eulerXyz(r00, r01, r02, r10, r11, r12, r22);

  const scalePct = [sx * 100.0, sy * 100.0, sz * 100.0];
  return [pos, scalePct, rzDeg, rxDeg, ryDeg];
}

/**
 * Extract intrinsic X-Y-Z Euler angles (degrees) from R = Rx*Ry*Rz.
 *
 * R = | cb*cg       -cb*sg        sb    |
 *     | sa*sb*cg+ca*sg  -sa*sb*sg+ca*cg  -sa*cb |
 *     | -ca*sb*cg+sa*sg  ca*sb*sg+sa*cg   ca*cb |
 */
export function _eulerXyz(
  r00: number,
  r01: number,
  r02: number,
  r10: number,
  r11: number,
  r12: number,
  r22: number,
): [number, number, number] {
  // Clamp to [-1, 1] for asin safety.
  const sinBeta = Math.max(-1.0, Math.min(1.0, r02));
  // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
  const beta = Math.asin(sinBeta);
  // cos(beta) straight off the matrix. Going through `cos(asin(r02))`
  // loses most of its digits as r02 approaches 1, which matters because
  // an orientation slerping towards a 90-degree Y passes near the pole
  // on almost every frame without ever reaching it.
  const cosBeta = Math.hypot(r00, r01);

  let rxDeg: number;
  let ryDeg: number;
  let rzDeg: number;
  if (Math.abs(cosBeta) > _EPSILON) {
    // Normal case: no gimbal lock.
    rxDeg = Math.atan2(-r12, r22) * _RAD2DEG;
    ryDeg = beta * _RAD2DEG;
    rzDeg = Math.atan2(-r01, r00) * _RAD2DEG;
  } else {
    // Gimbal lock: beta = +/-90 deg, where X and Z turn about the same
    // line and only their combination is recoverable. AE puts all of it
    // on Z and leaves X at zero - measured on AE 2026 by reparenting a
    // 3D child at orientation [0, 0, g] under a parent rotated Y = +/-90,
    // which AE writes back as [0, 270, g] / [0, 90, g] for g across a
    // full turn. Solving the same relation for X instead (the previous
    // behavior) does not even reconstruct the rotation at beta = -90.
    rxDeg = 0.0;
    rzDeg = Math.atan2(r10, r11) * _RAD2DEG;
    ryDeg = beta * _RAD2DEG;
  }
  return [rxDeg, ryDeg, rzDeg];
}

// ------------------------------------------------------------------
// Vector helpers
// ------------------------------------------------------------------

export function _vec3Cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function _vec3Normalize(v: number[]): number[] {
  const n = _vec3Norm(v);
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
 * @param topLeft - `[x, y, z]` comp-space position of the source's top-left.
 * @param topRight - `[x, y, z]` position of the source's top-right.
 * @param bottomLeft - `[x, y, z]` position of the source's bottom-left.
 * @param width - Layer source width in pixels.
 * @param height - Layer source height in pixels.
 * @returns An object with `anchorPoint`, `position`, `x_rotation`, `y_rotation`, `z_rotation` and
 *   `scale` keys, matching the transform property values AE's `calculateTransformFromPoints()`
 *   returns.
 * @throws {@link ValueError} If the points are coincident or collinear.
 */
export function transformFromPoints(
  topLeft: number[],
  topRight: number[],
  bottomLeft: number[],
  width: number,
  height: number,
): Record<string, number | number[]> {
  const xAxis = [0, 1, 2].map((i) => topRight[i] - topLeft[i]);
  const yAxis = [0, 1, 2].map((i) => bottomLeft[i] - topLeft[i]);
  const xLen = _vec3Norm(xAxis);
  const yLen = _vec3Norm(yAxis);
  if (xLen < _EPSILON || yLen < _EPSILON) {
    throw new ValueError("transform points must not be coincident");
  }
  const xHat = xAxis.map((c) => c / xLen);
  const yRawHat = yAxis.map((c) => c / yLen);

  // Shear is absorbed into the z scale: 100 * sin(angle between x and y).
  const sinTheta = _vec3Norm(_vec3Cross(xHat, yRawHat));

  const xDotY = [0, 1, 2].map((i) => xHat[i] * yAxis[i]).reduce((total, x) => total + x, 0);
  const yOrtho = [0, 1, 2].map((i) => yAxis[i] - xDotY * xHat[i]);
  const yOrthoLen = _vec3Norm(yOrtho);
  if (yOrthoLen < _EPSILON) throw new ValueError("transform points must not be collinear");
  const yHat = yOrtho.map((c) => c / yOrthoLen);
  const zHat = _vec3Cross(xHat, yHat);

  const [rxDeg, ryDeg, rzDeg] = _eulerXyz(
    xHat[0],
    yHat[0],
    zHat[0],
    xHat[1],
    yHat[1],
    zHat[1],
    zHat[2],
  );

  return {
    anchor_point: [0.0, 0.0, 0.0],
    position: [topLeft[0], topLeft[1], topLeft[2]],
    x_rotation: rxDeg,
    y_rotation: ryDeg,
    z_rotation: rzDeg,
    scale: [(xLen / width) * 100.0, (yOrthoLen / height) * 100.0, sinTheta * 100.0],
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
export function defaultCameraZoom(compWidth: number, pixelAspect: number): number {
  return (compWidth * pixelAspect) / 0.72;
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
export function projectToComp(
  worldPoint: number[],
  compWidth: number,
  compHeight: number,
  pixelAspect: number,
): number[] {
  const zoom = defaultCameraZoom(compWidth, pixelAspect);
  const cx = compWidth / 2.0;
  const cy = compHeight / 2.0;
  const factor = zoom / (zoom + worldPoint[2]);
  return [cx + (worldPoint[0] - cx) * factor, cy + (worldPoint[1] - cy) * factor];
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
export function _lookAtRotation(eye: number[], target: number[]): Mat4 {
  const delta = [0, 1, 2].map((i) => target[i] - eye[i]);
  let forward: number[];
  if (_vec3Norm(delta) < _EPSILON) {
    forward = [0.0, 0.0, 1.0];
  } else {
    forward = _vec3Normalize(delta);
  }
  const up = [0.0, 1.0, 0.0];
  const cross = _vec3Cross(up, forward);
  let xAxis: number[];
  if (_vec3Norm(cross) < _EPSILON) {
    xAxis = [1.0, 0.0, 0.0];
  } else {
    xAxis = _vec3Normalize(cross);
  }
  const yAxis = _vec3Cross(forward, xAxis);
  const m = Mat4.identity();
  for (let row = 0; row < 3; row++) {
    m.row(row)[0] = xAxis[row];
    m.row(row)[1] = yAxis[row];
    m.row(row)[2] = forward[row];
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
export function cameraRay(
  camera: Layer | null,
  compPoint: number[],
  compWidth: number,
  compHeight: number,
  pixelAspect: number,
  time: number | null = null,
): [number[], number[]] {
  const cx = compWidth / 2.0;
  const cy = compHeight / 2.0;

  if (camera == null) {
    const zoom = defaultCameraZoom(compWidth, pixelAspect);
    const origin = [cx, cy, -zoom];
    const direction = [compPoint[0] - cx, compPoint[1] - cy, zoom];
    return [origin, direction];
  }

  // The camera's whole parent chain places it (AE 2026: a camera parented
  // to a turned null casts its rays from where the null carries it).
  const world = buildWorldMatrix(camera, time, undefined, { asParent: true });
  const position = world.transformPoint([0.0, 0.0, 0.0]);

  const cameraOptions = camera.property("ADBE Camera Options Group");
  const zoom = _propValue(cameraOptions, "ADBE Camera Zoom", time);

  // The image plane is in square pixels; the rig matrix narrows the ray
  // back into comp pixels (see `buildLocalMatrix`).
  const direction = world.transformVector([
    (compPoint[0] - cx) * pixelAspect,
    compPoint[1] - cy,
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
export function intersectLayerPlane(world: Mat4, origin: number[], direction: number[]): number[] {
  const axisU = [0, 1, 2].map((r) => world.row(r)[0]);
  const axisV = [0, 1, 2].map((r) => world.row(r)[1]);
  const rhs = [0, 1, 2].map((r) => origin[r] - world.row(r)[3]);
  const negD = [0, 1, 2].map((r) => -direction[r]);
  const normal = _vec3Cross(axisU, axisV);
  const normalLen = _vec3Norm(normal);
  if (normalLen === 0.0) throw new ValueError("the layer plane is degenerate");
  const det = _det3(axisU, axisV, negD);
  if (Math.abs(det) <= _EPSILON * normalLen * _vec3Norm(direction)) {
    throw new ValueError("ray is parallel to the layer plane");
  }
  const t = _det3(axisU, axisV, rhs) / det;
  if (t <= 0.0) throw new ValueError("the layer plane is not in front of the camera");
  return [_det3(rhs, axisV, negD) / det, _det3(axisU, rhs, negD) / det];
}

/** Determinant of the 3x3 matrix with columns `a`, `b`, `c`. */
export function _det3(a: number[], b: number[], c: number[]): number {
  const cross = _vec3Cross(b, c);
  return a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2];
}
