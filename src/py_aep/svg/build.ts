/**
 * Build a shape layer's Contents from parsed SVG drawables.
 *
 * Translates {@link SvgDrawable | SvgDrawable}s into After Effects
 * shape groups through the public `addProperty` API - one `ADBE Vector Group` per drawable, in reverse document order (AE Contents index 0
 * renders on top, matching SVG's last-painted-on-top), each holding the
 * path(s), stroke, and fill. Solid paints become Fill/Stroke; gradient
 * paints become Gradient Fill/Stroke (G-Fill/G-Stroke) with the start/end
 * points, type, and color stops AE writes for an SVG import.
 */

import { max, min, valueEquals, zip } from "../../pyrt/index.ts";
import { toF4 } from "../binary/bin_utils.ts";
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
export function _leaf<K extends _LeafName>(group: PropertyGroup, matchName: K): MatchNameTypes[K] {
  return group.property(matchName);
}

/** Narrow an `addProperty` / child result to `PropertyGroup`. */
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
export function buildShapeLayerContents(
  contents: PropertyGroup,
  drawables: SvgDrawable[],
): void {
  for (const drawable of [...drawables].reverse()) {
    _addDrawable(contents, drawable);
  }
}

export function _addDrawable(contents: PropertyGroup, drawable: SvgDrawable): void {
  const group = _grp(contents.addProperty("ADBE Vector Group"));
  const inner = _grp(group.property("ADBE Vectors Group"));

  // AE stores each group's vertices centred on the box of their vertices
  // and tangent handles and puts the offset in the group's Vector Position
  // (verified against AE's own SVG import). Mirror that so the output
  // matches AE byte-for-byte.
  const [cx, cy] = _bboxCenter(drawable);
  for (const subpath of drawable.subpaths) {
    const pathGroup = _grp(inner.addProperty("ADBE Vector Shape - Group"));
    _leaf(pathGroup, "ADBE Vector Shape").value = new Shape(
      subpath.vertices.map((v) => [v[0] - cx, v[1] - cy]),
      subpath.inTangents.map((t) => [...t]),
      subpath.outTangents.map((t) => [...t]),
      { closed: subpath.closed },
    );
  }

  // A compound path (one SVG `<path>` with several subpaths) needs a Merge
  // Paths op so overlapping subpaths cut holes via the nonzero winding rule;
  // without it AE fills each subpath solid and the holes disappear. AE adds
  // one (Merge Type 1 = "Merge", the default) after the paths, before paint.
  if (drawable.subpaths.length > 1) {
    inner.addProperty("ADBE Vector Filter - Merge");
  }

  // Stroke is listed before fill so it renders on top (SVG paint order).
  // AE flattens an SVG group/element opacity into the paint's Fill/Stroke
  // Opacity (verified against AE's own import), so pass it through.
  if (drawable.stroke != null) {
    _addStroke(inner, drawable.stroke, cx, cy, drawable.opacity);
  }
  if (drawable.fill != null) {
    _addFill(inner, drawable.fill, cx, cy, drawable.opacity);
  }

  const transform = _grp(group.property("ADBE Vector Transform Group"));
  _leaf(transform, "ADBE Vector Position").value = [cx, cy];
}

/** Centre of the box of all the drawable's vertices and tangent handles. */
export function _bboxCenter(drawable: SvgDrawable): [number, number] {
  const points: [number, number][] = [];
  for (const sp of drawable.subpaths) {
    for (const [v, tIn, tOut] of zip(sp.vertices, sp.inTangents, sp.outTangents)) {
      for (const t of [[0.0, 0.0], tIn, tOut]) {
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
export function _opacityPct(alpha: number): number | null {
  const a8 = Math.floor(toF4(alpha) * 255.0 + 0.5);
  if (a8 >= 255) {
    return null;
  }
  return toF4((a8 / 255.0) * 100.0);
}

/**
 * Gradient Fill/Stroke Opacity percentage for a 0-1 group opacity.
 *
 * Unlike a solid paint (`_opacityPct`), a gradient fill/stroke stores the
 * group/element opacity as the RAW percentage, NOT 8-bit-quantized: AE 2026
 * writes `0.5 -> 50.0` and `0.3 -> 30.0` (vs `50.196` / `30.196` for solids,
 * which route opacity through the 8-bit colour alpha). The gradient's own
 * per-stop alpha stays in Grad Colors. Returns `null` when fully opaque,
 * since AE leaves the default 100%.
 *
 * AE reads the SVG opacity as float32 before scaling, so quantize to f4
 * first to match its exact byte (e.g. `0.3 -> 30.000001907`, not `30.0`).
 */
export function _gradOpacityPct(opacity: number): number | null {
  if (opacity >= 1.0) {
    return null;
  }
  return toF4(toF4(opacity) * 100.0);
}

export function _addFill(
  inner: PropertyGroup,
  paint: SolidPaint | GradientPaint,
  cx: number,
  cy: number,
  opacity: number,
): void {
  _applyPaint(inner, paint, "Fill", cx, cy, opacity);
}

export function _addStroke(
  inner: PropertyGroup,
  stroke: StrokeStyle,
  cx: number,
  cy: number,
  opacity: number,
): void {
  const sg = _applyPaint(inner, stroke.paint, "Stroke", cx, cy, opacity);
  _leaf(sg, "ADBE Vector Stroke Width").value = stroke.width;
  _applyStrokeStyle(sg, stroke);
}

/**
 * Add a paint group ("Fill"/"Stroke" match-name stem `kind`) and set
 * its gradient-or-solid color and opacity. Returns the added group.
 */
export function _applyPaint(
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
    grp = _grp(inner.addProperty(`ADBE Vector Graphic - G-${kind}`));
    _applyGradient(grp, paint, cx, cy);
    pct = _gradOpacityPct(opacity);
  } else {
    grp = _grp(inner.addProperty(`ADBE Vector Graphic - ${kind}`));
    const c = paint.color;
    _leaf(grp, `ADBE Vector ${kind} Color`).value = [c[0], c[1], c[2], 1.0];
    pct = _opacityPct(c[3] * opacity);
  }
  if (pct != null) {
    _leaf(grp, `ADBE Vector ${kind} Opacity`).value = pct;
  }
  return grp;
}

export function _applyStrokeStyle(sg: PropertyGroup, stroke: StrokeStyle): void {
  _setOptional(sg, "ADBE Vector Stroke Line Cap", stroke.cap, 1.0);
  _setOptional(sg, "ADBE Vector Stroke Line Join", stroke.join, 1.0);
  _setOptional(sg, "ADBE Vector Stroke Miter Limit", stroke.miterLimit, 4.0);
}

/**
 * Configure a G-Fill/G-Stroke group from a gradient paint.
 *
 * Start/end points are stored relative to the group centre `(cx, cy)`,
 * matching the centred vertex encoding.
 */
export function _applyGradient(
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
  _leaf(group, "ADBE Vector Grad Colors").value = _gradientValue(paint);
  // A radial gradientTransform's vertical stretch and rotation live in Grad
  // Scale / Grad Rotation (the start/end points only encode the x-radius);
  // AE writes a 360-degree baseline rotation on every radial gradient. These
  // leaves are AE 2026-only, so they are absent when importing into an
  // older project - in which case AE itself can only render the circular
  // approximation, so skipping them matches AE's pre-2026 behaviour.
  if (!valueEquals(paint.scale, [100.0, 100.0])) {
    _setIfPresent(group, "ADBE Vector Grad Scale", [paint.scale[0], paint.scale[1]]);
  }
  if (paint.rotation !== 0) {
    _setIfPresent(group, "ADBE Vector Grad Rotation", paint.rotation);
  }
}

/** Convert reader gradient stops to an AE `Gradient` (color + alpha). */
export function _gradientValue(paint: GradientPaint): Gradient {
  const stops = paint.stops?.length > 0 ? paint.stops : [];
  if (!stops?.length) {
    return new Gradient();
  }
  const colorStops = stops.map(
    (s) => new GradientColorStop(s.offset, 0.5, [s.color[0], s.color[1], s.color[2]]),
  );
  // AE writes one alpha stop for consecutive stops sharing offset and
  // opacity (it keeps every colour stop).
  const alphaStops: GradientAlphaStop[] = [];
  for (const s of stops) {
    const prev = alphaStops.length ? alphaStops.at(-1) : null;
    if (prev == null || !valueEquals([prev.offset, prev.alpha], [s.offset, s.color[3]])) {
      alphaStops.push(new GradientAlphaStop(s.offset, 0.5, s.color[3]));
    }
  }
  return new Gradient(colorStops, alphaStops);
}

/**
 * Set a leaf only when it differs from its AE default (keeps the
 * output minimal, matching AE which writes only non-defaults).
 */
export function _setOptional<K extends _LeafName>(
  group: PropertyGroup,
  matchName: K,
  value: number,
  default_: number,
): void {
  if (value !== default_) {
    _leaf(group, matchName).value = value;
  }
}

/**
 * Set a leaf only if the group actually has it.
 *
 * Some leaves (e.g. the AE 2026 Grad Scale / Grad Rotation) are absent
 * when importing into an older project; skip them rather than raise.
 */
export function _setIfPresent<K extends _LeafName>(
  group: PropertyGroup,
  matchName: K,
  value: _LeafValue<K>,
): void {
  if (group.properties.some((p) => p.matchName === matchName)) {
    const leaf: Property = _leaf(group, matchName);
    leaf.value = value;
  }
}
