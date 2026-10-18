/** Unit regression tests for the v9 fuzz findings on keyframes and bounds. */

import { describe, expect, test } from "bun:test";

import { TdumChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { _timebaseUnits } from "../../src/py_aep/models/properties/keyframe.ts";
import { BytesIO, struct, pyEq } from "../../src/pyrt/index.ts";

// AE 2026's frame grid: the rate to the thousandth as p/q, q * 2**k
// units a frame (12.3456 fps -> 24692 units a second, 2000 a frame).
test.each([
  [12.3456, 24692.0],
  [3.3333, 26664.0],
  [29.97, 23976.0],
  [24.0, 24576.0],
])("test_timebase_units_follow_frame_grid[%#]", (fps: number, units: number) => {
  expect(_timebaseUnits(fps)).toBe(units);
});

describe("TestIntegerFlaggedBounds", () => {
  /**
   * An integer-flagged tdum/tduM AE writes holds a double (all 47652 in
   * the sample corpus are 8 bytes); read as a u4 its high word turned 100.0
   * into 1079574528.
   */

  test("test_eight_byte_body_is_a_double", () => {
    const raw = struct.pack(">d", 100.0);
    const chunk = TdumChunk.read(new BytesIO(raw), 8, { chunkType: "tduM", isInteger: true });
    expect(pyEq(chunk.values, [100.0])).toBe(true);
    const out = new BytesIO();
    chunk.write(out);
    expect(pyEq(out.getvalue(), raw)).toBe(true);
  });
});
