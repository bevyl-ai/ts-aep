/**
 * Decode Photoshop vector-mask path records into AE mask shapes.
 *
 * A `vmsk`/`vsms` block body is a 4-byte version (3) + 4-byte flags + a run of
 * 26-byte path records. Knot coordinates are signed 8.24 fixed-point fractions
 * of the CANVAS dimensions, vertical first. After Effects converts them to
 * layer-pixel bezier vertices with tangents relative to the anchor (pinned by
 * the psd_vector_mask/psd_shape_layer fixtures).
 */

import { struct } from "../../pyrt/index.ts";
import { Shape } from "../models/properties/shape.ts";

// Path record selectors (PSD spec "Path resource format").
export const _CLOSED_LENGTH = 0;
export const _OPEN_LENGTH = 3;
export const _KNOT_SELECTORS: ReadonlySet<number> = new Set([1, 2, 4, 5]);

/** Decode a knot record to `[in_point, anchor, out_point]` pixel coords. */
export function _knot(record: Uint8Array, canvasW: number, canvasH: number): number[][] {
  const points: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const [vert, horiz] = struct.unpack(">ii", record.slice(2 + i * 8, 10 + i * 8));
    points.push([(horiz / 0x1000000) * canvasW, (vert / 0x1000000) * canvasH]);
  }
  return points;
}

/**
 * Decode a `vmsk`/`vsms` block into one {@link Shape} per subpath.
 *
 * @param block - The raw tagged-block body (version + flags + path records).
 * @param canvasW - Document canvas width in pixels.
 * @param canvasH - Document canvas height in pixels.
 * @returns The subpaths in file order (usually one). A malformed block yields
 *   the subpaths decoded so far.
 */
export function parseVectorMask(block: Uint8Array, canvasW: number, canvasH: number): Shape[] {
  const shapes: Shape[] = [];
  const vertices: number[][] = [];
  const inTangents: number[][] = [];
  const outTangents: number[][] = [];
  let closed = true;

  const flush = (): void => {
    if (vertices.length) {
      shapes.push(
        new Shape([...vertices], [...inTangents], [...outTangents], {
          closed,
        }),
      );
      vertices.splice(0, vertices.length);
      inTangents.splice(0, inTangents.length);
      outTangents.splice(0, outTangents.length);
    }
  };

  let pos = 8; // version (3) + flags
  while (pos + 26 <= block.length) {
    const record = block.slice(pos, pos + 26);
    const selector = struct.unpack(">H", record.slice(0, 2))[0];
    if (selector === _CLOSED_LENGTH || selector === _OPEN_LENGTH) {
      flush();
      closed = selector === _CLOSED_LENGTH;
    } else if (_KNOT_SELECTORS.has(selector)) {
      const [inPoint, anchor, outPoint] = _knot(record, canvasW, canvasH);
      vertices.push(anchor);
      inTangents.push([inPoint[0] - anchor[0], inPoint[1] - anchor[1]]);
      outTangents.push([outPoint[0] - anchor[0], outPoint[1] - anchor[1]]);
    }
    pos += 26;
  }
  flush();
  return shapes;
}
