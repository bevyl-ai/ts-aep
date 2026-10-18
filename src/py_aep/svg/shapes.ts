/**
 * Convert SVG shape elements to cubic subpaths and to AE Shape form.
 *
 * `elementSubpaths` turns a basic shape (`rect`, `circle`, `ellipse`,
 * `line`, `polyline`, `polygon`) or a `path` into untransformed cubic
 * {@link RawSubpath | RawSubpath}s. `cubicsToSubpath`
 * applies the accumulated transform and extracts After Effects vertices +
 * in/out tangents.
 */

import { NUMBER_RE, parseLength } from "./_util.ts";
import type { LengthContext } from "./_util.ts";
import { UnsupportedSVGError } from "./errors.ts";
import { RawSubpath, parsePath } from "./path_data.ts";
import type { CubicSeg } from "./path_data.ts";
import type { Affine } from "./transform.ts";
import { Subpath } from "./types.ts";
import { getMember, valueEquals, pySlice, zip } from "../../pyrt/index.ts";

// Control-point distance for a 90-degree circular arc as a cubic bezier.
export const _KAPPA = 0.5522847498307936;

// The viewport dimension (`LengthContext` attribute) a percentage of each
// geometry attribute refers to (SVG 1.1 7.10): the width, the height, or the
// normalized diagonal.
export const _PERCENT_AXIS: Record<string, string> = {
  x: "width",
  width: "width",
  cx: "width",
  rx: "width",
  x1: "width",
  x2: "width",
  y: "height",
  height: "height",
  cy: "height",
  ry: "height",
  y1: "height",
  y2: "height",
  r: "diagonal",
};

/**
 * A geometry attribute in user units: units converted and a percentage
 * resolved against `ctx` (kept as the bare number without one).
 */
export function _f(attrs: Map<string, string>, key: string, ctx: LengthContext | null, default_: number = 0.0): number {
  if (ctx == null) return parseLength(attrs.get(key) ?? null, default_);
  const ref = getMember(ctx, _PERCENT_AXIS[key]);
  return parseLength(attrs.get(key) ?? null, default_, ref, ctx.fontSize);
}

/** An absent or `auto` corner radius, which takes the other radius. */
export function _isAuto(raw: string | null): boolean {
  return raw == null || ["", "auto"].includes(raw.trim());
}

/**
 * Return untransformed cubic subpaths for a drawable element.
 *
 * @param tag - Local element name (no namespace), e.g. `rect`, `path`.
 * @param attrs - Element attributes.
 * @param ctx - The viewport and font size percentage and `em` lengths
 *   resolve against.
 *
 * @throws UnsupportedSVGError For an element that is not a basic shape.
 */
export function elementSubpaths(
  tag: string,
  attrs: Map<string, string>,
  ctx: LengthContext | null = null,
): RawSubpath[] {
  if (tag === "path") {
    return parsePath(attrs.get("d") ?? "");
  }
  if (tag === "rect") {
    return _rect(attrs, ctx);
  }
  if (["circle", "ellipse"].includes(tag)) {
    return _ellipse(tag, attrs, ctx);
  }
  if (tag === "line") {
    const [x1, y1] = [_f(attrs, "x1", ctx), _f(attrs, "y1", ctx)];
    const [x2, y2] = [_f(attrs, "x2", ctx), _f(attrs, "y2", ctx)];
    return [new RawSubpath([[x1, y1, x1, y1, x2, y2, x2, y2]], false)];
  }
  if (["polyline", "polygon"].includes(tag)) {
    return _poly(attrs, tag === "polygon");
  }
  throw new UnsupportedSVGError(`Unsupported drawable element: <${tag}>`);
}

export function _rect(attrs: Map<string, string>, ctx: LengthContext | null): RawSubpath[] {
  const [x, y] = [_f(attrs, "x", ctx), _f(attrs, "y", ctx)];
  const [w, h] = [_f(attrs, "width", ctx), _f(attrs, "height", ctx)];
  if (w <= 0 || h <= 0) {
    return [];
  }
  let rx = _f(attrs, "rx", ctx);
  let ry = _f(attrs, "ry", ctx);
  if (_isAuto(attrs.get("rx") ?? null)) {
    rx = ry;
  }
  if (_isAuto(attrs.get("ry") ?? null)) {
    ry = rx;
  }
  rx = Math.min(Math.max(rx, 0.0), w / 2.0);
  ry = Math.min(Math.max(ry, 0.0), h / 2.0);
  if (rx === 0 || ry === 0) {
    // Sharp corners: 4 straight segments.
    const pts: [number, number][] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
    const segs: CubicSeg[] = [];
    for (let i = 0; i < 4; i++) {
      const p0 = pts[i];
      const p3 = pts[(i + 1) % 4];
      segs.push([p0[0], p0[1], p0[0], p0[1], p3[0], p3[1], p3[0], p3[1]]);
    }
    return [new RawSubpath(segs, true)];
  }
  // Rounded rect: straight edges + quarter-ellipse corners (clockwise
  // from the top edge, starting after the top-left corner).
  const cxK = rx * _KAPPA;
  const cyK = ry * _KAPPA;
  const x2 = x + w;
  const y2 = y + h;
  const segs: CubicSeg[] = [];

  type Pt = [number, number];

  function line(p0: Pt, p3: Pt): void {
    segs.push([p0[0], p0[1], p0[0], p0[1], p3[0], p3[1], p3[0], p3[1]]);
  }

  function arc(p0: Pt, c1: Pt, c2: Pt, p3: Pt): void {
    segs.push([p0[0], p0[1], c1[0], c1[1], c2[0], c2[1], p3[0], p3[1]]);
  }

  line([x + rx, y], [x2 - rx, y]);
  arc([x2 - rx, y], [x2 - rx + cxK, y], [x2, y + ry - cyK], [x2, y + ry]);
  line([x2, y + ry], [x2, y2 - ry]);
  arc([x2, y2 - ry], [x2, y2 - ry + cyK], [x2 - rx + cxK, y2], [x2 - rx, y2]);
  line([x2 - rx, y2], [x + rx, y2]);
  arc([x + rx, y2], [x + rx - cxK, y2], [x, y2 - ry + cyK], [x, y2 - ry]);
  line([x, y2 - ry], [x, y + ry]);
  arc([x, y + ry], [x, y + ry - cyK], [x + rx - cxK, y], [x + rx, y]);
  return [new RawSubpath(segs, true)];
}

export function _ellipse(tag: string, attrs: Map<string, string>, ctx: LengthContext | null): RawSubpath[] {
  const cx = _f(attrs, "cx", ctx);
  const cy = _f(attrs, "cy", ctx);
  let rx: number;
  let ry: number;
  if (tag === "circle") {
    const r = _f(attrs, "r", ctx);
    rx = r;
    ry = r;
  } else {
    rx = _f(attrs, "rx", ctx);
    ry = _f(attrs, "ry", ctx);
    // `auto` takes the other radius (SVG 2). AE 2026 reads it as 0 and
    // imports `rx="auto" ry="20"` as a zero-width ellipse.
    if ((attrs.get("rx") || "").trim() === "auto") {
      rx = ry;
    } else if ((attrs.get("ry") || "").trim() === "auto") {
      ry = rx;
    }
  }
  if (rx <= 0 || ry <= 0) {
    return [];
  }
  const kx = rx * _KAPPA;
  const ky = ry * _KAPPA;
  // Top, right, bottom, left (clockwise): AE 2026 starts an imported
  // circle/ellipse at the top vertex.
  const right: [number, number] = [cx + rx, cy];
  const bottom: [number, number] = [cx, cy + ry];
  const left: [number, number] = [cx - rx, cy];
  const top: [number, number] = [cx, cy - ry];
  const segs: CubicSeg[] = [
    [top[0], top[1], cx + kx, cy - ry, cx + rx, cy - ky, right[0], right[1]],
    [right[0], right[1], cx + rx, cy + ky, cx + kx, cy + ry, bottom[0], bottom[1]],
    [bottom[0], bottom[1], cx - kx, cy + ry, cx - rx, cy + ky, left[0], left[1]],
    [left[0], left[1], cx - rx, cy - ky, cx - kx, cy - ry, top[0], top[1]],
  ];
  return [new RawSubpath(segs, true)];
}

export function _poly(attrs: Map<string, string>, closed: boolean): RawSubpath[] {
  const nums = Array.from((attrs.get("points") ?? "").matchAll(NUMBER_RE), (n) => Number(n[0]));
  const pts = zip(pySlice(nums, 0, null, 2), pySlice(nums, 1, null, 2));
  if (pts.length < 2) {
    return [];
  }
  const segs: CubicSeg[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p3 = pts[i + 1];
    segs.push([p0[0], p0[1], p0[0], p0[1], p3[0], p3[1], p3[0], p3[1]]);
  }
  if (closed) {
    const p0 = pts[pts.length - 1];
    const p3 = pts[0];
    if (!valueEquals(p0, p3)) {
      segs.push([p0[0], p0[1], p0[0], p0[1], p3[0], p3[1], p3[0], p3[1]]);
    }
  }
  return [new RawSubpath(segs, closed)];
}

/**
 * Apply `transform` to a raw subpath and extract AE vertices/tangents.
 *
 * Returns `null` for an empty subpath.
 */
export function cubicsToSubpath(raw: RawSubpath, transform: Affine): Subpath | null {
  const segs = raw.segments;
  if (!segs?.length) {
    return null;
  }
  // Transform every control point of every segment.
  const tsegs: CubicSeg[] = [];
  for (const [x0, y0, c1x, c1y, c2x, c2y, x3, y3] of segs) {
    const p0 = transform.apply(x0, y0);
    const c1 = transform.apply(c1x, c1y);
    const c2 = transform.apply(c2x, c2y);
    const p3 = transform.apply(x3, y3);
    tsegs.push([p0[0], p0[1], c1[0], c1[1], c2[0], c2[1], p3[0], p3[1]]);
  }

  const vertices: number[][] = [];
  const inT: number[][] = [];
  const outT: number[][] = [];

  if (raw.closed) {
    const n = tsegs.length;
    for (let i = 0; i < n; i++) {
      const vx = tsegs[i][0];
      const vy = tsegs[i][1];
      vertices.push([vx, vy]);
      outT.push([tsegs[i][2] - vx, tsegs[i][3] - vy]);
      const prev = tsegs[i === 0 ? n - 1 : i - 1];
      inT.push([prev[4] - vx, prev[5] - vy]);
    }
  } else {
    // N segments -> N+1 vertices.
    const first = tsegs[0];
    vertices.push([first[0], first[1]]);
    outT.push([first[2] - first[0], first[3] - first[1]]);
    inT.push([0.0, 0.0]);
    for (const [i, seg] of tsegs.entries()) {
      const vx = seg[6];
      const vy = seg[7];
      vertices.push([vx, vy]);
      inT.push([seg[4] - vx, seg[5] - vy]);
      if (i + 1 < tsegs.length) {
        const nxt = tsegs[i + 1];
        outT.push([nxt[2] - vx, nxt[3] - vy]);
      } else {
        outT.push([0.0, 0.0]);
      }
    }
  }
  return new Subpath(vertices, inT, outT, raw.closed);
}
