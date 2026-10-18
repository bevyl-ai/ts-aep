/** Tests for the Photoshop vector-mask path-record decoder. */

import { describe, expect, test } from "bun:test";

import {
  AssertionError_,
  Path,
  bytes_,
  len,
  pyAssert,
  pyEq,
  repr,
} from "../../src/pyrt/index.ts";
import { PsdLayer, readPsdLayers } from "../../src/py_aep/resolvers/psd_layers.ts";
import { parseVectorMask } from "../../src/py_aep/resolvers/psd_paths.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance } from "../helpers.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / "assets"
const ASSETS = new Path(import.meta.path).parent.parent.parent.div("samples", "assets");

function _vectorMask(psd: string, layer: string): Uint8Array {
  for (const node of readPsdLayers(ASSETS.div(psd))) {
    if (node.name === layer) {
      const mask = asInstance(node, PsdLayer).vectorMask;
      pyAssert(mask != null);
      return mask;
    }
  }
  throw new AssertionError_(`layer ${repr(layer)} not found`);
}

describe("TestParseVectorMask", () => {
  test("test_rectangle", () => {
    // Corner knots: anchors in canvas pixels, zero tangents.
    const shapes = parseVectorMask(
      _vectorMask("psd_vector_mask.psd", "vector masked"),
      64,
      64,
    );
    expect(len(shapes)).toBe(1);
    const shape = shapes[0];
    expect(shape.closed).toBe(true);
    expect(
      pyEq(shape.vertices, [
        [20.0, 12.0],
        [52.0, 12.0],
        [52.0, 44.0],
        [20.0, 44.0],
      ]),
    ).toBe(true);
    expect(
      pyEq(
        shape.inTangents,
        Array.from({ length: 4 }, () => [0.0, 0.0]),
      ),
    ).toBe(true);
  });

  test("test_smooth_knots_match_ae_tangents", () => {
    // The record's first point is the AE in-tangent handle (pinned by
    // the psd_vector_mask_curves fixture: identical values).
    const shapes = parseVectorMask(
      _vectorMask("psd_vector_mask_curves.psd", "curved"),
      64,
      64,
    );
    const shape = shapes[0];
    expect(
      pyEq(shape.vertices, [
        [32.0, 8.0],
        [56.0, 32.0],
        [32.0, 56.0],
        [8.0, 32.0],
      ]),
    ).toBe(true);
    expect(
      pyEq(shape.inTangents, [
        [12.0, 0.0],
        [0.0, 12.0],
        [-12.0, 0.0],
        [0.0, -12.0],
      ]),
    ).toBe(true);
    expect(
      pyEq(shape.outTangents, [
        [-12.0, 0.0],
        [0.0, -12.0],
        [12.0, 0.0],
        [0.0, 12.0],
      ]),
    ).toBe(true);
  });

  test("test_multiple_subpaths", () => {
    const shapes = parseVectorMask(
      _vectorMask("psd_vector_mask_multi.psd", "two rects"),
      64,
      64,
    );
    expect(len(shapes)).toBe(2);
    expect(pyEq(shapes[0].vertices[0], [6.0, 6.0])).toBe(true);
    expect(pyEq(shapes[1].vertices[0], [38.0, 38.0])).toBe(true);
  });

  test("test_truncated_block_returns_decoded_prefix", () => {
    const block = _vectorMask("psd_vector_mask.psd", "vector masked");
    const shapes = parseVectorMask(bytes_.slice(block, null, 8 + 26 * 4), 64, 64);
    // Fill rule + initial fill + length record + one knot survive.
    expect(len(shapes)).toBe(1);
    expect(len(shapes[0].vertices)).toBe(1);
  });
});
