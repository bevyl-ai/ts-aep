/**
 * Build a shape layer's Contents from parsed SVG drawables.
 *
 * Translates {@link SvgDrawable | SvgDrawable}s into After Effects
 * shape groups through the public `add_property` API - one `ADBE Vector Group` per drawable, in reverse document order (AE Contents index 0
 * renders on top, matching SVG's last-painted-on-top), each holding the
 * path(s), stroke, and fill. Solid paints become Fill/Stroke; gradient
 * paints become Gradient Fill/Stroke (G-Fill/G-Stroke) with the start/end
 * points, type, and color stops AE writes for an SVG import.
 */

import { max, min, py_eq, zip } from "../../pyrt/index.ts";
import { to_f4 } from "../binary/bin_utils.ts";
import { Gradient, GradientAlphaStop, GradientColorStop } from "../models/properties/gradient.ts";
import { Shape } from "../models/properties/shape.ts";
import { GradientPaint, type SolidPaint, type StrokeStyle, type SvgDrawable } from "./types.ts";
import type { MatchNameTypes } from "../models/properties/match_name_types.ts";
import type { Property } from "../models/properties/property.ts";
import type { PropertyGroup } from "../models/properties/property_group.ts";

type _LeafName = {
  [K in keyof MatchNameTypes]: MatchNameTypes[K] extends Property<infer _V> ? K : never;
}[keyof MatchNameTypes];

type _LeafValue<K extends _LeafName> = MatchNameTypes[K] extends Property<infer V> ? V : never;

export const _GRAD_TYPE = new Map<string, number>([
  ["linear", 1.0],
  ["radial", 2.0],
]);

/** Return a child leaf property (narrowed from `Property | PropertyGroup`). */
export function _leaf<K extends _LeafName>(group: PropertyGroup, match_name: K): MatchNameTypes[K] {
  return group.property(match_name);
}

/** Narrow an `add_property` / child result to `PropertyGroup`. */
export function _grp(prop: PropertyGroup): PropertyGroup {
  return prop;
}

/**
 * Populate a shape layer's Root Vectors Group from SVG drawables.
 *
 * @param contents - The layer's `ADBE Root Vectors Group` property group.
 * @param drawables - Drawables in SVG document order; added in reverse so
 *     the document's last-painted shape ends up on top.
 */
export function build_shape_layer_contents(
  contents: PropertyGroup,
  drawables: SvgDrawable[],
): void {
  for (const drawable of [...drawables].reverse()) {
    _add_drawable(contents, drawable);
  }
}

export function _add_drawable(contents: PropertyGroup, drawable: SvgDrawable): void {
  const group = _grp(contents.add_property("ADBE Vector Group"));
  const inner = _grp(group.property("ADBE Vectors Group"));

  // AE stores each group's vertices centred on the box of their vertices
  // and tangent handles and puts the offset in the group's Vector Position
  // (verified against AE's own SVG import). Mirror that so the output
  // matches AE byte-for-byte.
  const [cx, cy] = _bbox_center(drawable);
  for (const subpath of drawable.subpaths) {
    const path_group = _grp(inner.add_property("ADBE Vector Shape - Group"));
    _leaf(path_group, "ADBE Vector Shape").value = new Shape(
      subpath.vertices.map((v) => [v[0] - cx, v[1] - cy]),
      subpath.in_tangents.map((t) => [...t]),
      subpath.out_tangents.map((t) => [...t]),
      { closed: subpath.closed },
    );
  }

  // A compound path (one SVG `<path>` with several subpaths) needs a Merge
  // Paths op so overlapping subpaths cut holes via the nonzero winding rule;
  // without it AE fills each subpath solid and the holes disappear. AE adds
  // one (Merge Type 1 = "Merge", the default) after the paths, before paint.
  if (drawable.subpaths.length > 1) {
    inner.add_property("ADBE Vector Filter - Merge");
  }

  // Stroke is listed before fill so it renders on top (SVG paint order).
  // AE flattens an SVG group/element opacity into the paint's Fill/Stroke
  // Opacity (verified against AE's own import), so pass it through.
  if (drawable.stroke != null) {
    _add_stroke(inner, drawable.stroke, cx, cy, drawable.opacity);
  }
  if (drawable.fill != null) {
    _add_fill(inner, drawable.fill, cx, cy, drawable.opacity);
  }

  const transform = _grp(group.property("ADBE Vector Transform Group"));
  _leaf(transform, "ADBE Vector Position").value = [cx, cy];
}

/** Centre of the box of all the drawable's vertices and tangent handles. */
export function _bbox_center(drawable: SvgDrawable): [number, number] {
  const points: [number, number][] = [];
  for (const sp of drawable.subpaths) {
    for (const [v, t_in, t_out] of zip(sp.vertices, sp.in_tangents, sp.out_tangents)) {
      for (const t of [[0.0, 0.0], t_in, t_out]) {
        points.push([v[0] + t[0], v[1] + t[1]]);
      }
    }
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  if (xs.length === 0) {
    return [0.0, 0.0];
  }
  return [(min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0];
}

/**
 * AE's 8-bit-quantized Fill/Stroke Opacity percentage for a 0-1 alpha.
 *
 * AE stores opacity as an 8-bit value, so `0.3` becomes
 * `round(0.3*255)=77` -\> `77/255*100` = 30.196% (as float32), not 30.0%
 * (verified against AE 2026's SVG import: group opacity 0.3 -\> 30.196,
 * 0.5 -\> 50.196). Returns `null` when fully opaque, since AE omits the
 * default 100%.
 */
export function _opacity_pct(alpha: number): number | null {
  const a8 = Math.floor(to_f4(alpha) * 255.0 + 0.5);
  if (a8 >= 255) {
    return null;
  }
  return to_f4((a8 / 255.0) * 100.0);
}

/**
 * Gradient Fill/Stroke Opacity percentage for a 0-1 group opacity.
 *
 * Unlike a solid paint (`_opacity_pct`), a gradient fill/stroke stores the
 * group/element opacity as the RAW percentage, NOT 8-bit-quantized: AE 2026
 * writes `0.5 -> 50.0` and `0.3 -> 30.0` (vs `50.196` / `30.196` for solids,
 * which route opacity through the 8-bit colour alpha). The gradient's own
 * per-stop alpha stays in Grad Colors. Returns `null` when fully opaque,
 * since AE leaves the default 100%.
 *
 * AE reads the SVG opacity as float32 before scaling, so quantize to f4
 * first to match its exact byte (e.g. `0.3 -> 30.000001907`, not `30.0`).
 */
export function _grad_opacity_pct(opacity: number): number | null {
  if (opacity >= 1.0) {
    return null;
  }
  return to_f4(to_f4(opacity) * 100.0);
}

export function _add_fill(
  inner: PropertyGroup,
  paint: SolidPaint | GradientPaint,
  cx: number,
  cy: number,
  opacity: number,
): void {
  _apply_paint(inner, paint, "Fill", cx, cy, opacity);
}

export function _add_stroke(
  inner: PropertyGroup,
  stroke: StrokeStyle,
  cx: number,
  cy: number,
  opacity: number,
): void {
  const sg = _apply_paint(inner, stroke.paint, "Stroke", cx, cy, opacity);
  _leaf(sg, "ADBE Vector Stroke Width").value = stroke.width;
  _apply_stroke_style(sg, stroke);
}

/**
 * Add a paint group ("Fill"/"Stroke" match-name stem `kind`) and set
 * its gradient-or-solid color and opacity. Returns the added group.
 */
export function _apply_paint(
  inner: PropertyGroup,
  paint: SolidPaint | GradientPaint,
  kind: "Fill" | "Stroke",
  cx: number,
  cy: number,
  opacity: number,
): PropertyGroup {
  let grp: PropertyGroup;
  let pct: number | null;
  if (paint instanceof GradientPaint) {
    grp = _grp(inner.add_property(`ADBE Vector Graphic - G-${kind}`));
    _apply_gradient(grp, paint, cx, cy);
    pct = _grad_opacity_pct(opacity);
  } else {
    grp = _grp(inner.add_property(`ADBE Vector Graphic - ${kind}`));
    const c = paint.color;
    _leaf(grp, `ADBE Vector ${kind} Color`).value = [c[0], c[1], c[2], 1.0];
    pct = _opacity_pct(c[3] * opacity);
  }
  if (pct != null) {
    _leaf(grp, `ADBE Vector ${kind} Opacity`).value = pct;
  }
  return grp;
}

export function _apply_stroke_style(sg: PropertyGroup, stroke: StrokeStyle): void {
  _set_optional(sg, "ADBE Vector Stroke Line Cap", stroke.cap, 1.0);
  _set_optional(sg, "ADBE Vector Stroke Line Join", stroke.join, 1.0);
  _set_optional(sg, "ADBE Vector Stroke Miter Limit", stroke.miter_limit, 4.0);
}

/**
 * Configure a G-Fill/G-Stroke group from a gradient paint.
 *
 * Start/end points are stored relative to the group centre `(cx, cy)`,
 * matching the centred vertex encoding.
 */
export function _apply_gradient(
  group: PropertyGroup,
  paint: GradientPaint,
  cx: number,
  cy: number,
): void {
  _leaf(group, "ADBE Vector Grad Type").value = _GRAD_TYPE.get(paint.kind) ?? 1.0;
  _leaf(group, "ADBE Vector Grad Start Pt").value = [
    paint.start[0] - cx,
    paint.start[1] - cy,
  ];
  _leaf(group, "ADBE Vector Grad End Pt").value = [
    paint.end[0] - cx,
    paint.end[1] - cy,
  ];
  _leaf(group, "ADBE Vector Grad Colors").value = _gradient_value(paint);
  // A radial gradientTransform's vertical stretch and rotation live in Grad
  // Scale / Grad Rotation (the start/end points only encode the x-radius);
  // AE writes a 360-degree baseline rotation on every radial gradient. These
  // leaves are AE 2026-only, so they are absent when importing into an
  // older project - in which case AE itself can only render the circular
  // approximation, so skipping them matches AE's pre-2026 behaviour.
  if (!py_eq(paint.scale, [100.0, 100.0])) {
    _set_if_present(group, "ADBE Vector Grad Scale", [paint.scale[0], paint.scale[1]]);
  }
  if (paint.rotation !== 0) {
    _set_if_present(group, "ADBE Vector Grad Rotation", paint.rotation);
  }
}

/** Convert reader gradient stops to an AE `Gradient` (color + alpha). */
export function _gradient_value(paint: GradientPaint): Gradient {
  const stops = paint.stops?.length > 0 ? paint.stops : [];
  if (!stops?.length) {
    return new Gradient();
  }
  const color_stops = stops.map(
    (s) => new GradientColorStop(s.offset, 0.5, [s.color[0], s.color[1], s.color[2]]),
  );
  // AE writes one alpha stop for consecutive stops sharing offset and
  // opacity (it keeps every colour stop).
  const alpha_stops: GradientAlphaStop[] = [];
  for (const s of stops) {
    const prev = alpha_stops.length ? alpha_stops.at(-1) : null;
    if (prev == null || !py_eq([prev.offset, prev.alpha], [s.offset, s.color[3]])) {
      alpha_stops.push(new GradientAlphaStop(s.offset, 0.5, s.color[3]));
    }
  }
  return new Gradient(color_stops, alpha_stops);
}

/**
 * Set a leaf only when it differs from its AE default (keeps the
 * output minimal, matching AE which writes only non-defaults).
 */
export function _set_optional<K extends _LeafName>(
  group: PropertyGroup,
  match_name: K,
  value: number,
  default_: number,
): void {
  if (value !== default_) {
    _leaf(group, match_name).value = value;
  }
}

/**
 * Set a leaf only if the group actually has it.
 *
 * Some leaves (e.g. the AE 2026 Grad Scale / Grad Rotation) are absent
 * when importing into an older project; skip them rather than raise.
 */
export function _set_if_present<K extends _LeafName>(
  group: PropertyGroup,
  match_name: K,
  value: _LeafValue<K>,
): void {
  if (group.properties.some((p) => p.match_name === match_name)) {
    const leaf: Property = _leaf(group, match_name);
    leaf.value = value;
  }
}
