/**
 * The content box of a Photoshop layer's footage on a layered import.
 *
 * After Effects sizes each per-layer footage item of a layered PSD/PSB import
 * (and a single layer imported at Layer Size) to the layer's content box: the
 * `opti` stores it, the footage's data size follows it, and a
 * `COMP_CROPPED_LAYERS` import crops the layer to it. Rules measured on After
 * Effects 2026 with byte-patched PSDs:
 *
 * - A raster layer's content is its record bounds (its pixels are not
 *   trimmed to their alpha); a fill layer's (solid color, gradient, pattern:
 *   shape layers) is the whole canvas.
 * - An enabled raster layer mask crops the content to the pixels where the
 *   layer's alpha and the mask are both non-zero (`PsdLayer.mask_box`), in
 *   either Layer Options mode.
 * - Merging (`layer_styles="merge"`) also bakes an enabled, non-inverted
 *   vector mask: the content is cut to the path's extent - its curves' true
 *   extrema, rounded out to whole pixels after snapping inward to a 1/64 px
 *   grid (an edge reaching 1/64 px into a pixel column counts, less does
 *   not). A fill layer takes the path's extent whole, even past the canvas.
 *   Editable mode keeps the vector mask as an AE mask and leaves the content
 *   alone.
 * - Merged layer styles then grow the content box
 *   (`psd_styles.merged_styles_bounds`).
 */

import { and, bytes_, max, min, OverflowError, struct, ValueError } from "../../pyrt/index.ts";
import { parseVectorMask } from "./psd_paths.ts";
import { mergedStylesBounds } from "./psd_styles.ts";
import { cubicRange } from "./shape_bounds.ts";
import type { PsdLayer } from "./psd_layers.ts";

export type _Box = [number, number, number, number];

// AE measures a vector mask's extent on a 1/64 px grid.
export const _SUBPIXEL = 64;

/**
 * The `(left, top, right, bottom)` content box AE gives `layer`'s
 * footage, in canvas pixels (see the module rules).
 *
 * @param layer - The Photoshop layer.
 * @param canvasW - Document width in pixels.
 * @param canvasH - Document height in pixels.
 * @param layerStyles - The Layer Options choice: `"merge"`, `"editable"` or `"ignore"`. Only
 *   merging bakes vector masks and styles.
 * @param globalAngle - The document's global light angle, for merged styles.
 * @throws {@link NotImplementedError} For merged styles whose rasterized bounds are not known (see
 *   `psd_styles.merged_styles_bounds`).
 */
export function psdLayerBox(
  layer: PsdLayer,
  canvasW: number,
  canvasH: number,
  layerStyles: string,
  globalAngle: number,
): _Box {
  const merge = layerStyles === "merge";
  const path = merge ? _pathBox(layer, canvasW, canvasH) : null;
  let box: _Box;
  if (layer.isFill) {
    box = path != null ? path : [0, 0, canvasW, canvasH];
    if (layer.maskBox != null) {
      box = _intersect(box, layer.maskBox);
    }
  } else {
    box = layer.maskBox != null ? layer.maskBox : layer.bounds;
    if (path != null) {
      box = _intersect(box, path);
    }
  }
  if (merge && box[2] > box[0] && box[3] > box[1]) {
    // Merged styles are rasterized into the footage, whose content box
    // grows to hold them, from the masked content.
    box = mergedStylesBounds(layer._replace({ bounds: box }), globalAngle);
  }
  return box;
}

/** The pixel extent of an enabled, non-inverted vector mask, or `null`. */
export function _pathBox(layer: PsdLayer, canvasW: number, canvasH: number): _Box | null {
  const block = layer.vectorMask;
  if (block == null || block.length < 8) {
    return null;
  }
  const flags = struct.unpack(">I", bytes_.slice(block, 4, 8))[0];
  if (and(flags, 0x05)) {
    // Inverted (bit 0) or disabled (bit 2): nothing is cut away.
    return null;
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const shape of parseVectorMask(block, canvasW, canvasH)) {
    const vertices = shape.vertices;
    const count = vertices.length;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const p0 = vertices[i];
      const p3 = vertices[j];
      let p1: number[];
      let p2: number[];
      if (j === 0 && !shape.closed) {
        // Filling closes an open subpath with a straight edge.
        p1 = p0;
        p2 = p3;
      } else {
        const out = shape.outTangents[i];
        const in_ = shape.inTangents[j];
        p1 = [p0[0] + out[0], p0[1] + out[1]];
        p2 = [p3[0] + in_[0], p3[1] + in_[1]];
      }
      xs.push(...cubicRange(p0[0], p1[0], p2[0], p3[0]));
      ys.push(...cubicRange(p0[1], p1[1], p2[1], p3[1]));
    }
  }
  if (xs.length === 0) {
    return null;
  }
  return [
    _floorEdge(min(xs)),
    _floorEdge(min(ys)),
    _ceilEdge(max(xs)),
    _ceilEdge(max(ys)),
  ];
}

/** math.floor/math.ceil raise on inf/NaN. */
function _finite(value: number): number {
  if (Number.isNaN(value)) {
    throw new ValueError("cannot convert float NaN to integer");
  }
  if (!Number.isFinite(value)) {
    throw new OverflowError("cannot convert float infinity to integer");
  }
  return value;
}

export function _floorEdge(value: number): number {
  return Math.floor(_finite(Math.ceil(_finite(value * _SUBPIXEL))) / _SUBPIXEL);
}

export function _ceilEdge(value: number): number {
  return Math.ceil(_finite(Math.floor(_finite(value * _SUBPIXEL))) / _SUBPIXEL);
}

export function _intersect(a: _Box, b: _Box): _Box {
  const box: _Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  if (box[2] <= box[0] || box[3] <= box[1]) {
    return [0, 0, 0, 0];
  }
  return box;
}
