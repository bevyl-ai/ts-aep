/** Tests for the Curves effect's value (ADBE CurvesCustom-0001). */

import { expect, test } from "bun:test";
import { b, bytes_, dictGet, float, getitem, isclose, len, pyEq, range, struct, ValueError } from "../../src/pyrt/index.ts";
import { raises } from "../../src/pyrt/pytest.ts";
// Python's `import py_aep.binary.chunk` loads the whole package, which registers every chunk type.
import "../../src/py_aep/binary/_register.ts";
import { Chunk } from "../../src/py_aep/binary/chunk.ts";
import { CurvesArbpChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { toDict, type Dict } from "../../src/py_aep/cli/validate.ts";
import { CURVES_CHANNELS, Curves } from "../../src/py_aep/models/properties/curves.ts";

/** A Curves aRbp as After Effects writes it, the maps left identity. */
function _blob(
  points: Map<string, number[][]>,
  mode = 1,
  stale = false,
  selected = -1,
): Uint8Array {
  const out = new Uint8Array(4 + 5 * 256 + 5 * 72);
  struct.packInto(">HH", out, 0, 1, mode);
  for (const [c, name] of CURVES_CHANNELS.entries()) {
    const pts = dictGet(points, name, [[0, 0], [255, 255]]);
    out.set(Uint8Array.from(range(256)), 4 + 256 * c);
    const offset = 4 + 5 * 256 + 72 * c;
    for (const [i, [x, y]] of pts.entries()) {
      struct.packInto(">hh", out, offset + 4 * i, x, y);
    }
    if (stale) {
      // After Effects leaves old points past the count.
      struct.packInto(">hh", out, offset + 4 * len(pts), 5440, 8193);
    }
    struct.packInto(">Ii", out, offset + 64, len(pts), selected);
  }
  return new Uint8Array(out);
}

function _curves(data: Uint8Array): Curves {
  const arbp = new Chunk({ chunk_type: "aRbp", data });
  return Curves._from_binary(CurvesArbpChunk.from_arbp(arbp));
}

test("test_decodes_points_in_channel_order", () => {
  const curves = _curves(
    _blob(new Map([["rgb", [[0, 0], [168, 93], [255, 246]]]]), 1, true),
  );
  expect(curves.usesPoints).toBe(true);
  expect(pyEq(getitem(curves.channels, "rgb").points, [[0, 0], [168, 93], [255, 246]])).toBe(true);
  expect(pyEq(getitem(curves.channels, "red").points, [[0, 0], [255, 255]])).toBe(true);
  expect(getitem(curves.channels, "red").isIdentity).toBe(true);
  expect(getitem(curves.channels, "rgb").isIdentity).toBe(false);
  expect(curves.isIdentity).toBe(false);
});

test("test_untouched_curves_are_identity", () => {
  expect(_curves(_blob(new Map())).isIdentity).toBe(true);
});

test("test_natural_spline_goes_through_the_points", () => {
  const points: [number, number][] = [[0, 0], [41, 30], [129, 149], [191, 211], [255, 255]];
  const curves = _curves(_blob(new Map([["rgb", points]])));
  for (const [x, y] of getitem(curves.channels, "rgb").points) {
    expect(isclose(curves.evaluate("rgb", x / 255.0), y / 255.0, undefined, 1e-9)).toBe(true);
  }
});

test("test_two_points_are_a_straight_line", () => {
  const curves = _curves(_blob(new Map([["green", [[0, 51], [255, 204]]]])));
  expect(isclose(curves.evaluate("green", 0.5), 0.5, undefined, 1e-9)).toBe(true);
});

test("test_duplicate_inputs_keep_the_last_output", () => {
  const curves = _curves(
    _blob(new Map([["rgb", [[0, 0], [128, 64], [128, 192], [255, 255]]]])),
  );
  expect(isclose(curves.evaluate("rgb", 128 / 255.0), 192 / 255.0)).toBe(true);
});

test("test_overshoot_is_clamped_unless_asked", () => {
  // Grayscale 4: the spline dips below 0 near black.
  const curves = _curves(
    _blob(new Map([["rgb", [[0, 0], [62, 18], [193, 238], [255, 255]]]])),
  );
  expect(curves.evaluate("rgb", 0.05)).toBe(0.0);
  expect(curves.evaluate("rgb", 0.05, false) < 0.0).toBe(true);
});

test("test_pencil_mode_reads_the_maps", () => {
  const blob = new Uint8Array(_blob(new Map(), 0));
  blob.set(Uint8Array.from(range(256), (i) => 255 - i), 4);
  const curves = _curves(new Uint8Array(blob));
  expect(curves.usesPoints).toBe(false);
  expect(isclose(curves.evaluate("rgb", 0.0), 1.0)).toBe(true);
  expect(isclose(curves.evaluate("rgb", 1.0), 0.0)).toBe(true);
});

test("test_to_dict_emits_the_curves", () => {
  const data = toDict(_curves(_blob(new Map([["rgb", [[0, 0], [168, 93], [255, 246]]]]))));
  expect(getitem(data, "mode")).toBe(1);
  expect(getitem(data, "version")).toBe(1);
  expect(getitem(data, "isIdentity")).toBe(false);
  const channels: Dict = getitem(data, "channels");
  const rgb: Dict = getitem(channels, "rgb");
  expect(pyEq(getitem(rgb, "points"), [[0, 0], [168, 93], [255, 246]])).toBe(true);
  expect(pyEq(getitem(rgb, "map"), [...range(256)])).toBe(true);
  expect<number>(getitem(rgb, "selected")).toBe(-1);
});

test("test_junk_selected_point_reads_as_none", () => {
  // AE leaves junk here at times: 0x9200FF with 3 points.
  let curves = _curves(
    _blob(new Map([["rgb", [[0, 0], [128, 90], [255, 255]]]]), undefined, undefined, 0x9200ff),
  );
  expect(getitem(curves.channels, "rgb").selected).toBe(-1);
  curves = _curves(
    _blob(new Map([["rgb", [[0, 0], [128, 90], [255, 255]]]]), undefined, undefined, 1),
  );
  expect(getitem(curves.channels, "rgb").selected).toBe(1);
});

test("test_pencil_identity_map_with_stale_points_is_identity", () => {
  // Drawn with the pencil, only the map counts; the points are stale.
  const curves = _curves(
    _blob(new Map([["rgb", [[0, 0], [128, 40], [255, 255]]]]), 0),
  );
  expect(getitem(curves.channels, "rgb").isIdentity).toBe(true);
  expect(curves.isIdentity).toBe(true);
});

test("test_same_curves_compares_points_not_bytes", () => {
  const edited = new Map([["rgb", [[0, 0], [128, 90], [255, 255]]]]);
  const stale = _curves(_blob(edited, undefined, true));
  expect(stale._same_curves(_curves(_blob(edited)))).toBe(true);
  expect(stale._same_curves(_curves(_blob(new Map())))).toBe(false);
});

const evaluateRejectsRows: [string, number][] = [
  ["luma", 0.5],
  ["rgb", float("nan")],
  ["rgb", float("inf")],
];

test.each(evaluateRejectsRows)("test_evaluate_rejects_bad_input[%#]", (channel, x) => {
  raises(ValueError, () => _curves(_blob(new Map())).evaluate(channel, x));
});

test("test_rejects_other_sizes", () => {
  raises(ValueError, () =>
    CurvesArbpChunk.from_arbp(new Chunk({ chunk_type: "aRbp", data: bytes_.repeat(b("\x00"), 16) })),
  );
});
