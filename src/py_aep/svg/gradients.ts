/**
 * Gradient definitions and resolution to absolute `GradientPaint`.
 *
 * `collectGradients` indexes `<linearGradient>` / `<radialGradient>`
 * elements by id (following `href` inheritance for stops and geometry).
 * `resolveGradient` maps a referenced gradient into absolute viewBox
 * coordinates given the referencing element's bounding box and transform.
 *
 * **Note:** the mapping of a `GradientPaint` onto After Effects' gradient-fill
 * chunks is the import builder's concern and is not yet AE-validated; this
 * module only produces the geometric/stop representation.
 */

import { getOrInsert, degrees, hypot } from "../../pyrt/index.ts";
import { LengthContext, localName, parseLength, parseRatio } from "./_util.ts";
import { parseColor } from "./colors.ts";
import { _splitDeclarations } from "./style.ts";
import { Affine, parseTransform } from "./transform.ts";
import { GradientPaint, GradientStop } from "./types.ts";

import type { Element } from "../../pyrt/etree.ts";
export type { Element };

function _href(elem: Element): string | null {
  for (const key of ["href", "{http://www.w3.org/1999/xlink}href"]) {
    const ref = elem.get(key);
    if (ref) {
      return ref.startsWith("#") ? ref.slice(1) : ref;
    }
  }
  return null;
}

export class GradientDef {
  declare elem: Element;
  declare kind: string;
  declare attrs: Map<string, string>;
  declare stops: GradientStop[];
  declare href: string | null;

  /** Raw gradient element plus its (href-resolved) stops and attrs. */
  constructor(elem: Element) {
    this.elem = elem;
    this.kind = localName(elem.tag) === "radialGradient" ? "radial" : "linear";
    this.attrs = new Map<string, string>(elem.attrib);
    this.stops = _parseStops(elem);
    this.href = _href(elem);
  }

  attr(name: string, default_: string): string {
    return this.attrs.get(name) ?? default_;
  }
}

/**
 * Index every gradient in the document by id, resolving `href`
 * inheritance of stops and geometry attributes.
 */
export function collectGradients(root: Element): Map<string, GradientDef> {
  const defs = new Map<string, GradientDef>();
  for (const elem of root.iter()) {
    if (["linearGradient", "radialGradient"].includes(localName(elem.tag))) {
      const gid = elem.get("id");
      if (gid) {
        defs.set(gid, new GradientDef(elem));
      }
    }
  }
  // Resolve href inheritance (stops + missing geometry attrs).
  for (const gd of defs.values()) {
    const seen = new Set<string>();
    // `ref` is reassigned while walking the href chain, so it stays a `let`.
    let ref = gd.href;
    while (ref && !seen.has(ref)) {
      const parent = defs.get(ref);
      if (parent === undefined) {
        break;
      }
      seen.add(ref);
      if (!gd.stops?.length) {
        gd.stops = [...parent.stops];
      }
      for (const [k, v] of parent.attrs) {
        getOrInsert(gd.attrs, k, v);
      }
      ref = parent.href;
    }
  }
  return defs;
}

function _parseStops(elem: Element): GradientStop[] {
  const stops: GradientStop[] = [];
  for (const child of elem) {
    if (localName(child.tag) !== "stop") {
      continue;
    }
    // SVG spec clamps stop offsets to [0, 1] (offsets > 100% round down),
    // and a stop below an earlier one moves up to it (stops keep their
    // document order; AE 2026 imports `0.6 red, 0.3 blue` as red then a
    // hard switch to blue at 0.6).
    const parsedOffset = parseRatio(child.get("offset"), 0.0);
    const offset = stops.length > 0 ? Math.max(parsedOffset, stops[stops.length - 1].offset) : parsedOffset;
    const style = _stopStyle(child);
    const color = parseColor(style.get("stop-color") ?? "#000000") ?? [0.0, 0.0, 0.0, 1.0];
    const opacity = parseRatio(style.get("stop-opacity") ?? null, 1.0);
    stops.push(new GradientStop(offset, [color[0], color[1], color[2], color[3] * opacity]));
  }
  return stops;
}

const _STOP_PROPS = ["stop-color", "stop-opacity"];

function _stopStyle(elem: Element): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of elem.attrib) {
    if (_STOP_PROPS.includes(k)) {
      out.set(k, v);
    }
  }
  for (const [k, v] of _splitDeclarations(elem.get("style", ""), _STOP_PROPS)[0]) {
    out.set(k, v);
  }
  return out;
}

/**
 * A gradient coordinate or radius in gradient space; a percentage is a
 * fraction of `span` (1.0 under objectBoundingBox, where `50%` and `0.5`
 * are the same fraction of the bounding box).
 */
function _coord(text: string, span: number): number {
  return parseLength(text, 0.0, span);
}

/**
 * Resolve a gradient to absolute viewBox geometry.
 *
 * @param gd - The gradient definition.
 * @param bbox - The referencing element's absolute bounding box
 *   `(min_x, min_y, max_x, max_y)`.
 * @param ctm - The element's current transform (applied for
 *   `userSpaceOnUse`; for `objectBoundingBox` the bbox is already
 *   absolute so only `gradientTransform` is applied).
 * @param viewport - The viewBox `(width, height)` - the reference for
 *   percentage coordinates under `userSpaceOnUse`.
 * @returns A `GradientPaint` with absolute `start`/`end` points and stops.
 */
export function resolveGradient(
  gd: GradientDef,
  bbox: [number, number, number, number],
  ctm: Affine,
  viewport: [number, number],
): GradientPaint {
  const units = gd.attr("gradientUnits", "objectBoundingBox");
  const objectBbox = units !== "userSpaceOnUse";
  const [minX, minY, maxX, maxY] = bbox;
  const bw = maxX - minX,
    bh = maxY - minY;
  const [vpW, vpH] = viewport;
  const gt = parseTransform(gd.attr("gradientTransform", ""));
  let base: Affine;
  let spanX: number, spanY: number, spanR: number;
  if (objectBbox) {
    // Coordinates are fractions of the (already absolute) bounding box,
    // and gradientTransform applies in that unit space (SVG 1.1 13.2):
    // absolute = bbox . gradientTransform . point. AE 2026 maps them so
    // (`rotate(90)` turns a left-to-right gradient top-to-bottom, and
    // `r="0.25"` on an 80 x 40 box is a 20 x 10 ellipse).
    base = new Affine(bw, undefined, undefined, bh, minX, minY).multiply(gt);
    spanX = spanY = spanR = 1.0;
  } else {
    // The CTM maps user coordinates to absolute; percentages refer to
    // the viewport (a radius to its normalized diagonal).
    base = ctm.multiply(gt);
    spanX = vpW;
    spanY = vpH;
    spanR = new LengthContext(vpW, vpH).diagonal;
  }

  if (gd.kind === "linear") {
    const x1 = _coord(gd.attr("x1", "0%"), spanX);
    const y1 = _coord(gd.attr("y1", "0%"), spanY);
    const x2 = _coord(gd.attr("x2", "100%"), spanX);
    const y2 = _coord(gd.attr("y2", "0%"), spanY);
    const start = base.apply(x1, y1);
    const end = base.apply(x2, y2);
    return new GradientPaint(gd.kind, gd.stops, start, end);
  }

  const cx = _coord(gd.attr("cx", "50%"), spanX);
  const cy = _coord(gd.attr("cy", "50%"), spanY);
  const r = _coord(gd.attr("r", "50%"), spanR);
  const start = base.apply(cx, cy);
  const end = base.apply(cx + r, cy);
  // `start`/`end` only carry the x-radius, so a `gradientTransform` that
  // stretches the gradient vertically (e.g. `matrix(1 0 0 4 ...)`, common
  // for SVG wing/petal gradients) would collapse to a circle. Recover the
  // ellipse: AE stores the y/x aspect ratio in Grad Scale and the x-axis
  // angle in Grad Rotation, as 360 minus the clockwise screen angle (AE
  // 2026 imports an axis at 0 / 30 / -60 degrees as 360 / 330 / 420).
  const edgeY = base.apply(cx, cy + r);
  const xRadius = hypot(end[0] - start[0], end[1] - start[1]);
  const yRadius = hypot(edgeY[0] - start[0], edgeY[1] - start[1]);
  // Python truthiness of a float: NaN is truthy, so use py_bool, not `?:`.
  const scaleY = xRadius !== 0 ? (100.0 * yRadius) / xRadius : 100.0;
  const angle = degrees(Math.atan2(end[1] - start[1], end[0] - start[0]));
  const rotation = 360.0 - angle;
  return new GradientPaint(gd.kind, gd.stops, start, end, [100.0, scaleY], rotation);
}
