/**
 * Content bounds of a shape layer, for `AVLayer.source_rect_at_time`.
 *
 * Rules measured on After Effects 2026 (`sourceRectAtTime` on shape layers
 * built by script, covering every shape type, stroke join and cap, group
 * transform and nesting case below):
 *
 * - Only painted paths count: a Fill, Stroke, Gradient Fill or Gradient
 *   Stroke paints the paths above it in its group, nested groups included.
 *   A path with no paint below it adds nothing, and a layer with no painted
 *   path measures `0, 0, 0, 0`. Disabled items are skipped.
 * - The geometry box is the tight bounds of the painted paths in layer
 *   space, curves included (the extremes of each cubic, not its control
 *   points).
 * - `extents` adds, for every stroke, the tight bounds of its paths in the
 *   stroke's own group space grown on each side by `width / 2`, times
 *   `miter limit + 1` for a Miter join, times `sqrt(2)` for a Projecting
 *   (square) cap - even on a closed path - and mapped to layer space as a
 *   box. Dashes do not change it; the widest stroke wins.
 * - Parametric shapes are the paths After Effects draws: an ellipse is four
 *   cubic arcs with the circle constant `4/3 * (sqrt(2) - 1)`, a polystar
 *   vertex's roundness handle is `radius * roundness% * kappa * sin(pi / points)` long. A rectangle's rounded corners stay inside it.
 * - A group maps its content to its parent by `translate(position) * rotate * skew * scale * translate(-anchor)`, the skew shearing by
 *   `-tan(skew)` along the skew axis.
 * - Trim Paths and Repeater leave the box unchanged; Offset Paths grows it
 *   (and the other path operations were not measured), so those raise
 *   `NotImplementedError`.
 *
 * Expressions are not evaluated: values are read before any expression, as
 * `Property.value_at_time` reads them.
 */

import { Affine, IDENTITY } from "../svg/transform.ts";
import {
  NotImplementedError,
  ZeroDivisionError,
  deferred,
  float_repr,
  int,
  max,
  min,
  radians,
  repr,
} from "../../pyrt/index.ts";
import type { MatchNameTypes } from "../models/properties/match_name_types.ts";
import type { Property } from "../models/properties/property.ts";
import type { PropertyGroup } from "../models/properties/property_group.ts";

const _property_group = deferred<typeof import("../models/properties/property_group.ts")>("py_aep/models/properties/property_group");

declare module "../models/properties/match_name_types.ts" {
  interface MatchNameTypes {
    "ADBE Vector Anchor": Property<number[]>;
    "ADBE Vector Position": Property<number[]>;
    "ADBE Vector Scale": Property<number[]>;
    "ADBE Vector Skew": Property<number>;
    "ADBE Vector Skew Axis": Property<number>;
    "ADBE Vector Rotation": Property<number>;
    "ADBE Vector Rect Size": Property<number[]>;
    "ADBE Vector Rect Position": Property<number[]>;
    "ADBE Vector Rect Roundness": Property<number>;
    "ADBE Vector Ellipse Size": Property<number[]>;
    "ADBE Vector Ellipse Position": Property<number[]>;
    "ADBE Vector Star Points": Property<number>;
    "ADBE Vector Star Type": Property<number>;
    "ADBE Vector Star Position": Property<number[]>;
    "ADBE Vector Star Outer Radius": Property<number>;
    "ADBE Vector Star Outer Roundess": Property<number>;
    "ADBE Vector Star Inner Radius": Property<number>;
    "ADBE Vector Star Inner Roundess": Property<number>;
    "ADBE Vector Star Rotation": Property<number>;
    "ADBE Vector Stroke Width": Property<number>;
    "ADBE Vector Stroke Line Join": Property<number>;
    "ADBE Vector Stroke Miter Limit": Property<number>;
    "ADBE Vector Stroke Line Cap": Property<number>;
    "ADBE Vector Shape - Rect": PropertyGroup;
    "ADBE Vector Shape - Ellipse": PropertyGroup;
    "ADBE Vector Shape - Star": PropertyGroup;
    "ADBE Vector Graphic - G-Fill": PropertyGroup;
    "ADBE Vector Graphic - G-Stroke": PropertyGroup;
    "ADBE Vector Fill Color": Property<number[]>;
    "ADBE Vector Stroke Color": Property<number[]>;
    "ADBE Vector Fill Opacity": Property<number>;
    "ADBE Vector Stroke Opacity": Property<number>;
    "ADBE Vector Grad Type": Property<number>;
    "ADBE Vector Grad Start Pt": Property<number[]>;
    "ADBE Vector Grad End Pt": Property<number[]>;
    "ADBE Vector Grad Scale": Property<number[]>;
    "ADBE Vector Grad Rotation": Property<number>;
  }
}

type _VectorProp = {
  [K in keyof MatchNameTypes]: MatchNameTypes[K] extends Property<infer V> ? (V extends number | number[] ? K : never) : never;
}[keyof MatchNameTypes];

export type _Point = [number, number];
export type _Segment = [_Point, _Point, _Point, _Point];
export type _Path = _Segment[];

export const _KAPPA = (4 / 3) * (Math.sqrt(2) - 1);

export const _FILLS: ReadonlySet<string> = new Set([
  "ADBE Vector Graphic - Fill",
  "ADBE Vector Graphic - G-Fill",
]);
export const _STROKES: ReadonlySet<string> = new Set([
  "ADBE Vector Graphic - Stroke",
  "ADBE Vector Graphic - G-Stroke",
]);
// Path operations whose presence leaves the measured box unchanged.
export const _BOX_NEUTRAL_FILTERS: ReadonlySet<string> = new Set([
  "ADBE Vector Filter - Trim",
  "ADBE Vector Filter - Repeater",
]);
export const _MITER_JOIN = 1;
export const _SQUARE_CAP = 3;

/** A growing `(left, top, right, bottom)` accumulator. */
export class BoxAccumulator {
  declare left: number;
  declare top: number;
  declare right: number;
  declare bottom: number;

  constructor() {
    this.left = this.top = Infinity;
    this.right = this.bottom = -Infinity;
  }

  add(left: number, top: number, right: number, bottom: number): void {
    this.left = min([this.left, left]);
    this.top = min([this.top, top]);
    this.right = max([this.right, right]);
    this.bottom = max([this.bottom, bottom]);
  }

  add_box(other: BoxAccumulator): void {
    if (other.left <= other.right) {
      this.add(other.left, other.top, other.right, other.bottom);
    }
  }

  rect(): { top: number; left: number; width: number; height: number } {
    if (this.left > this.right) {
      return { top: 0.0, left: 0.0, width: 0.0, height: 0.0 };
    }
    return {
      top: this.top,
      left: this.left,
      width: this.right - this.left,
      height: this.bottom - this.top,
    };
  }
}

export function _value<K extends _VectorProp>(
  group: PropertyGroup,
  match_name: K,
  time: number,
): MatchNameTypes[K] extends Property<infer V> ? V : never;
export function _value(group: PropertyGroup, match_name: _VectorProp, time: number) {
  return group.property(match_name).value_at_time(time);
}

// ---------------------------------------------------------------------------
// Affine maps (`svg.transform.Affine`: x' = a*x + c*y + e, y' = b*x + d*y + f)
// ---------------------------------------------------------------------------

export function _rotation(degrees: number): Affine {
  const r = radians(degrees);
  return new Affine(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0.0, 0.0);
}

export function _map_path(m: Affine, path: _Path): _Path {
  return path.map(([p0, p1, p2, p3]): _Segment => [
    m.apply(...p0),
    m.apply(...p1),
    m.apply(...p2),
    m.apply(...p3),
  ]);
}

export function _group_matrix(transform: PropertyGroup, time: number): Affine {
  const anchor = _value(transform, "ADBE Vector Anchor", time);
  const position = _value(transform, "ADBE Vector Position", time);
  const scale = _value(transform, "ADBE Vector Scale", time);
  const skew = Math.tan(radians(_value(transform, "ADBE Vector Skew", time)));
  const axis = _value(transform, "ADBE Vector Skew Axis", time);
  const shear = _rotation(-axis).multiply(
    new Affine(1.0, 0.0, -skew, 1.0, 0.0, 0.0).multiply(_rotation(axis)),
  );
  let m = new Affine(1.0, 0.0, 0.0, 1.0, -anchor[0], -anchor[1]);
  m = new Affine(scale[0] / 100, 0.0, 0.0, scale[1] / 100, 0.0, 0.0).multiply(m);
  m = shear.multiply(m);
  m = _rotation(_value(transform, "ADBE Vector Rotation", time)).multiply(m);
  return new Affine(1.0, 0.0, 0.0, 1.0, position[0], position[1]).multiply(m);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Cubic segments from vertices and handles relative to them. */
export function _closed_path(
  vertices: _Point[],
  ins: _Point[],
  outs: _Point[],
  closed: boolean,
): _Path {
  const count = vertices.length;
  const path: _Path = [];
  const n = closed ? count : count - 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % count;
    const [x0, y0] = vertices[i];
    const [x3, y3] = vertices[j];
    path.push([
      [x0, y0],
      [x0 + outs[i][0], y0 + outs[i][1]],
      [x3 + ins[j][0], y3 + ins[j][1]],
      [x3, y3],
    ]);
  }
  return path;
}

export function _rect_path(item: PropertyGroup, time: number): _Path {
  const [w, h] = _value(item, "ADBE Vector Rect Size", time);
  const [x, y] = _value(item, "ADBE Vector Rect Position", time);
  const r = min([
    max([_value(item, "ADBE Vector Rect Roundness", time), 0.0]),
    Math.abs(w) / 2,
    Math.abs(h) / 2,
  ]);
  const left = x - w / 2,
    top = y - h / 2,
    right = x + w / 2,
    bottom = y + h / 2;
  if (r === 0) {
    const corners: _Point[] = [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ];
    const zero: _Point[] = [
      [0.0, 0.0],
      [0.0, 0.0],
      [0.0, 0.0],
      [0.0, 0.0],
    ];
    return _closed_path(corners, zero, zero, true);
  }
  const k = r * _KAPPA;
  const vertices: _Point[] = [
    [left + r, top], [right - r, top],
    [right, top + r], [right, bottom - r],
    [right - r, bottom], [left + r, bottom],
    [left, bottom - r], [left, top + r],
  ]; // fmt: skip
  const outs: _Point[] = [[0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k]];
  const ins: _Point[] = [[-k, 0], [0, 0], [0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0]];
  return _closed_path(vertices, ins, outs, true);
}

export function _ellipse_path(item: PropertyGroup, time: number): _Path {
  const [w, h] = _value(item, "ADBE Vector Ellipse Size", time);
  const [x, y] = _value(item, "ADBE Vector Ellipse Position", time);
  const rx = w / 2,
    ry = h / 2;
  const kx = rx * _KAPPA,
    ky = ry * _KAPPA;
  const vertices: _Point[] = [
    [x, y - ry],
    [x + rx, y],
    [x, y + ry],
    [x - rx, y],
  ];
  const outs: _Point[] = [
    [kx, 0.0],
    [0.0, ky],
    [-kx, 0.0],
    [0.0, -ky],
  ];
  const ins: _Point[] = [
    [-kx, 0.0],
    [0.0, -ky],
    [kx, 0.0],
    [0.0, ky],
  ];
  return _closed_path(vertices, ins, outs, true);
}

export function _polystar_path(item: PropertyGroup, time: number): _Path {
  let points = _value(item, "ADBE Vector Star Points", time);
  if (points !== int(points)) {
    throw new NotImplementedError(
      "source_rect_at_time does not model a polystar with a fractional " +
        `number of points (${float_repr(points)})`,
    );
  }
  points = int(points);
  const star = _value(item, "ADBE Vector Star Type", time) === 1;
  const [x, y] = _value(item, "ADBE Vector Star Position", time);
  const outer = _value(item, "ADBE Vector Star Outer Radius", time);
  const outer_round = _value(item, "ADBE Vector Star Outer Roundess", time) / 100;
  const inner = star ? _value(item, "ADBE Vector Star Inner Radius", time) : outer;
  const inner_round = star
    ? _value(item, "ADBE Vector Star Inner Roundess", time) / 100
    : outer_round;
  const count = star ? points * 2 : points;
  if (points === 0) {
    throw new ZeroDivisionError("float division by zero");
  }
  const handle = _KAPPA * Math.sin(Math.PI / points);
  let angle = -Math.PI / 2 + radians(_value(item, "ADBE Vector Star Rotation", time));
  const vertices: _Point[] = [];
  const ins: _Point[] = [];
  const outs: _Point[] = [];
  for (let i = 0; i < count; i++) {
    const [radius, roundness] =
      i % 2 === 0 || !star ? [outer, outer_round] : [inner, inner_round];
    const cos = Math.cos(angle),
      sin = Math.sin(angle);
    const length = radius * roundness * handle;
    vertices.push([x + radius * cos, y + radius * sin]);
    // The handles run along the circle's tangent at the vertex.
    ins.push([sin * length, -cos * length]);
    outs.push([-sin * length, cos * length]);
    angle += (2 * Math.PI) / count;
  }
  return _closed_path(vertices, ins, outs, true);
}

export function _bezier_path(item: PropertyGroup, time: number): _Path {
  const shape = item.property("ADBE Vector Shape").value_at_time(
    time,
  );
  const vertices: _Point[] = shape.vertices.map((v): _Point => [v[0], v[1]]);
  if (vertices.length === 0) {
    return [];
  }
  return _closed_path(
    vertices,
    shape.in_tangents.map((t): _Point => [t[0], t[1]]),
    shape.out_tangents.map((t): _Point => [t[0], t[1]]),
    shape.closed,
  );
}

export const _PATH_BUILDERS = new Map<string, (item: PropertyGroup, time: number) => _Path>([
  ["ADBE Vector Shape - Rect", _rect_path],
  ["ADBE Vector Shape - Ellipse", _ellipse_path],
  ["ADBE Vector Shape - Star", _polystar_path],
  ["ADBE Vector Shape - Group", _bezier_path],
]);

/** The exact range of one cubic coordinate over `t` in `[0, 1]`. */
export function cubic_range(a: number, b: number, c: number, d: number): [number, number] {
  let low = min([a, d]),
    high = max([a, d]);
  const qa = -a + 3 * b - 3 * c + d;
  const qb = 2 * (a - 2 * b + c);
  const qc = b - a;
  let roots: number[];
  if (Math.abs(qa) < 1e-12) {
    roots = Math.abs(qb) > 1e-12 ? [-qc / qb] : [];
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) {
      roots = [];
    } else {
      const root = Math.sqrt(disc);
      roots = [(-qb + root) / (2 * qa), (-qb - root) / (2 * qa)];
    }
  }
  for (const t of roots) {
    if (0 < t && t < 1) {
      const mt = 1 - t;
      const v = mt ** 3 * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t ** 3 * d;
      low = min([low, v]);
      high = max([high, v]);
    }
  }
  return [low, high];
}

export function _path_box(path: _Path): BoxAccumulator {
  const box = new BoxAccumulator();
  for (const [p0, p1, p2, p3] of path) {
    const [left, right] = cubic_range(p0[0], p1[0], p2[0], p3[0]);
    const [top, bottom] = cubic_range(p0[1], p1[1], p2[1], p3[1]);
    box.add(left, top, right, bottom);
  }
  return box;
}

export function _stroke_reach(item: PropertyGroup, time: number): number {
  let reach = _value(item, "ADBE Vector Stroke Width", time) / 2;
  if (_value(item, "ADBE Vector Stroke Line Join", time) === _MITER_JOIN) {
    reach *= _value(item, "ADBE Vector Stroke Miter Limit", time) + 1;
  }
  if (_value(item, "ADBE Vector Stroke Line Cap", time) === _SQUARE_CAP) {
    reach *= Math.sqrt(2);
  }
  return reach;
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/** Paint `contents`' paths into the boxes; return its paths in its space. */
export function _walk(
  contents: PropertyGroup,
  time: number,
  to_layer: Affine,
  geometry: BoxAccumulator,
  extents: BoxAccumulator,
): _Path[] {
  const pending: _Path[] = [];
  // The geometry box is a union, so a path painted again adds nothing: only
  // the paths after the last paint are measured into it.
  let painted = 0;
  for (const item of contents.properties) {
    if (!item.enabled) {
      continue;
    }
    const match_name = item.match_name;
    // Every match name dispatched below names a group (see MatchNameTypes).
    const group = item instanceof _property_group().PropertyGroup ? item : null;
    const path_builder = _PATH_BUILDERS.get(match_name);
    if (match_name === "ADBE Vector Group" && group != null) {
      const local = _group_matrix(
        group.property("ADBE Vector Transform Group"),
        time,
      );
      const children = _walk(
        group.property("ADBE Vectors Group"),
        time,
        to_layer.multiply(local),
        geometry,
        extents,
      );
      for (const path of children) {
        pending.push(_map_path(local, path));
      }
    } else if (path_builder !== undefined && group != null) {
      pending.push(path_builder(group, time));
    } else if (_FILLS.has(match_name) || _STROKES.has(match_name)) {
      const reach = _STROKES.has(match_name) && group != null
        ? _stroke_reach(group, time)
        : null;
      for (const path of pending.slice(painted)) {
        if (path?.length > 0) {
          geometry.add_box(_path_box(_map_path(to_layer, path)));
        }
      }
      painted = pending.length;
      if (reach == null) {
        continue;
      }
      for (const path of pending) {
        if (path?.length > 0) {
          const local_box = _path_box(path);
          const corners: _Point[] = [
            [local_box.left - reach, local_box.top - reach],
            [local_box.right + reach, local_box.top - reach],
            [local_box.right + reach, local_box.bottom + reach],
            [local_box.left - reach, local_box.bottom + reach],
          ];
          const mapped = corners.map((corner) => to_layer.apply(...corner));
          extents.add(
            min(mapped.map((p) => p[0])),
            min(mapped.map((p) => p[1])),
            max(mapped.map((p) => p[0])),
            max(mapped.map((p) => p[1])),
          );
        }
      }
    } else if (match_name.startsWith("ADBE Vector Filter") && !_BOX_NEUTRAL_FILTERS.has(match_name)) {
      throw new NotImplementedError(
        `source_rect_at_time does not model the ${repr(item.name)} path operation`,
      );
    }
  }
  return pending;
}

/**
 * `sourceRectAtTime` of a shape layer's `ADBE Root Vectors Group`.
 *
 * @param root - The layer's contents group.
 * @param time - Composition time in seconds.
 * @param extents - `true` to include the stroke extents.
 * @returns An object with `top`, `left`, `width` and `height` keys.
 * @throws NotImplementedError For a path operation other than Trim Paths
 *   and Repeater, or a polystar with a fractional number of points.
 */
export function shape_layer_rect(
  root: PropertyGroup,
  time: number,
  extents: boolean,
): { top: number; left: number; width: number; height: number } {
  const geometry = new BoxAccumulator();
  const stroke_boxes = new BoxAccumulator();
  _walk(root, time, IDENTITY, geometry, stroke_boxes);
  if (extents) {
    geometry.add_box(stroke_boxes);
  }
  return geometry.rect();
}
