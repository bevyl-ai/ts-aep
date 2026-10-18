/** SVG root parsing: canvas size and the viewBox origin transform. */

import { float, min, max, pyEq, split } from "../../pyrt/index.ts";
import { NUMBER_RE, parseLength } from "./_util.ts";
import { Affine } from "./transform.ts";

import type { Element } from "../../pyrt/etree.ts";
export type { Element };

// TYPE_CHECKING-only alias in Python.
export type ViewBox = readonly [number, number, number, number];

/**
 * The `(min_x, min_y, width, height)` of a viewBox attribute, or `null`
 * when it is absent or invalid (not four finite numbers, or a size that is
 * not positive: SVG treats those as an error / no viewBox).
 */
export function _viewBox(value: string | null): ViewBox | null {
  if (!value) return null;
  const nums = Array.from(value.matchAll(NUMBER_RE), (n) => float(n[0]));
  if (nums.length !== 4 || !nums.every((n) => Number.isFinite(n))) return null;
  if (nums[2] <= 0 || nums[3] <= 0) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

/**
 * Return `(width, height, root_transform)` for the SVG root.
 *
 * After Effects sizes the comp from the viewBox dimensions (falling
 * back to the `width`/`height` attributes). The root transform shifts
 * a non-zero viewBox origin to `(0, 0)` so geometry lands in comp
 * space.
 */
export function canvas(root: Element): [number, number, Affine] {
  const viewBox = _viewBox(root.get("viewBox"));
  if (viewBox != null) {
    const [minX, minY, vbW, vbH] = viewBox;
    // AE 2026 sizes the comp from the viewBox dimensions and only
    // shifts geometry by the viewBox origin (verified on the sample
    // SVG). Where width/height differ from the viewBox, AE also scales
    // the geometry by them while keeping the viewBox-sized comp;
    // py_aep keeps the drawing in viewBox units, so it fills the comp.
    return [vbW, vbH, new Affine(undefined, undefined, undefined, undefined, -minX, -minY)];
  }
  const width = parseLength(root.get("width"));
  const height = parseLength(root.get("height"));
  if (!(Number.isFinite(width) && Number.isFinite(height))) {
    return [0.0, 0.0, new Affine()];
  }
  return [width, height, new Affine()];
}

/**
 * Map a nested viewport's content onto its `x / y / width / height`
 * box (SVG 1.1 7.7-7.9).
 *
 * Returns the transform from the viewport's user space to its parent's
 * and the viewport size its percentages resolve against (the viewBox
 * size when there is one).
 */
export function viewportTransform(
  viewBox: string | null,
  preserveAspectRatio: string | null,
  x: number,
  y: number,
  width: number,
  height: number,
): [Affine, [number, number]] {
  const vb = _viewBox(viewBox);
  if (vb == null) {
    return [new Affine(undefined, undefined, undefined, undefined, x, y), [width, height]];
  }
  const [minX, minY, vbW, vbH] = vb;
  let sx = width / vbW;
  let sy = height / vbH;
  const tokens = split(preserveAspectRatio || "").filter((t) => t !== "defer");
  const align = tokens.length > 0 ? tokens[0] : "xMidYMid";
  if (align !== "none") {
    const s = pyEq(tokens.slice(1, 2), ["slice"]) ? max([sx, sy]) : min([sx, sy]);
    sx = sy = s;
    const ax = (new Map<string, number>([["xMin", 0.0], ["xMid", 0.5], ["xMax", 1.0]])).get(align.slice(0, 4)) ?? 0.5;
    const ay = (new Map<string, number>([["YMin", 0.0], ["YMid", 0.5], ["YMax", 1.0]])).get(align.slice(4)) ?? 0.5;
    x += (width - vbW * s) * ax;
    y += (height - vbH * s) * ay;
  }
  return [new Affine(sx, undefined, undefined, sy, x - minX * sx, y - minY * sy), [vbW, vbH]];
}
