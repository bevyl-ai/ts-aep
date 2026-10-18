/**
 * Channel decoding behind the PSD layer-mask crop (`PsdLayer.mask_box`).
 */

import { describe, expect, test } from "bun:test";
import * as zlib from "node:zlib";

import {
  b,
  bytes_,
  concat,
  int,
  len,
  pyEq,
  range,
  struct,
  zip,
} from "../../src/pyrt/index.ts";
import { _channelFlags } from "../../src/py_aep/resolvers/psd_layers.ts";

function _delta(data: Uint8Array): Uint8Array {
  return Uint8Array.from(
    zip(Array.from(concat(b("\x00"), data)), Array.from(data)),
    ([a, b_]) => (b_ - a) & 0xff,
  );
}

/**
 * Encode rows as Photoshop's zlib-with-prediction channel data: 16-bit
 * samples delta-coded per sample, 32-bit ones split into byte planes and
 * delta-coded per byte (the layout of the 16 / 32-bit sample assets).
 */
function _zipPredicted(rows: number[][], depth: number): Uint8Array {
  let out: Uint8Array = b("");
  for (const row of rows) {
    if (depth === 16) {
      const values = row.map((v) => int(v));
      const deltas = zip([0, ...values], values).map(([a, b_]) => (b_ - a) & 0xffff);
      out = concat(out, struct.pack(`>${len(row)}H`, ...deltas));
    } else {
      const raw = struct.pack(`>${len(row)}f`, ...row);
      const planes = bytes_.join(
        Array.from(range(4), (k) => raw.filter((_, i) => i % 4 === k)),
      );
      out = concat(out, _delta(planes));
    }
  }
  return concat(struct.pack(">H", 3), zlib.deflateSync(out));
}

describe("TestChannelFlags", () => {
  test("test_raw_8bit", () => {
    const chunk = concat(struct.pack(">H", 0), new Uint8Array([0, 7, 0, 255, 0, 0]));
    expect(
      pyEq(_channelFlags(chunk, 3, 2, 8, false), [
        b("\x00\x01\x00"),
        b("\x01\x00\x00"),
      ]),
    ).toBe(true);
  });

  test("test_rle_8bit", () => {
    // Row 1: a 3-byte repeat run; row 2: a literal run.
    const row1 = new Uint8Array([256 - 2, 9]);
    const row2 = new Uint8Array([2, 0, 4, 0]);
    const chunk = concat(struct.pack(">HHH", 1, len(row1), len(row2)), row1, row2);
    expect(
      pyEq(_channelFlags(chunk, 3, 2, 8, false), [
        b("\x01\x01\x01"),
        b("\x00\x01\x00"),
      ]),
    ).toBe(true);
  });

  test("test_zip_predicted_16bit", () => {
    const rows = [
      [0, 300, 0, 65535],
      [256, 0, 0, 1],
    ];
    const chunk = _zipPredicted(rows, 16);
    expect(
      pyEq(_channelFlags(chunk, 4, 2, 16, false), [
        b("\x00\x01\x00\x01"),
        b("\x01\x00\x00\x01"),
      ]),
    ).toBe(true);
  });

  test("test_zip_predicted_32bit", () => {
    const rows = [
      [0.0, 0.5, 0.0, 1.0],
      [2.0, 0.0, 1e-30, 0.0],
    ];
    const chunk = _zipPredicted(rows, 32);
    expect(
      pyEq(_channelFlags(chunk, 4, 2, 32, false), [
        b("\x00\x01\x00\x01"),
        b("\x01\x00\x01\x00"),
      ]),
    ).toBe(true);
  });

  test("test_zip_predicted_8bit", () => {
    const chunk = concat(
      struct.pack(">H", 3),
      zlib.deflateSync(_delta(new Uint8Array([0, 5, 5, 0]))),
    );
    expect(
      pyEq(_channelFlags(chunk, 4, 1, 8, false), [b("\x00\x01\x01\x00")]),
    ).toBe(true);
  });
});
