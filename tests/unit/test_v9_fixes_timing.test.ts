/**
 * Composition timebase, frame numbers and 16.16 rate fields (v9 fuzz fixes).
 *
 * Expected values are After Effects 2026 measurements: the internal timebase
 * AE stored for compositions made with `addComp` at each rate, and the
 * `displayStartFrame` / `frameTime` AE reported for stored comp times.
 */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { CdtaChunk, frameGrid, layerTimebase } from "../../src/py_aep/binary/composition_chunks.ts";
import { SspcChunk } from "../../src/py_aep/binary/footage_chunks.ts";
import { LdtaChunk } from "../../src/py_aep/binary/layer_chunks.ts";
import { RenderSettingsItem, RouuChunk } from "../../src/py_aep/binary/render_chunks.ts";
import { _frameNumber } from "../../src/py_aep/models/items/composition.ts";
import { Fraction, getOrThrow, valueEquals, truthy, sorted, struct } from "../../src/pyrt/index.ts";
import { approx } from "../../src/pyrt/pytest.ts";
import { asInstance } from "../helpers.ts";

// rate -> (internal timebase, timebase units per frame), AE 2026 addComp.
const _AE_TIMEBASES = new Map<number, [number, number]>([
  [1, [32768, 32768]],
  [7.3, [37376, 5120]],
  [8.33, [26656, 3200]],
  [12.3456, [24692, 2000]],
  [19.5, [39936, 2048]],
  [23.976, [23976, 1000]],
  [23.98, [38368, 1600]],
  [24, [24576, 1024]],
  [29.97, [23976, 800]],
  [29.98, [23984, 800]],
  [37, [37888, 1024]],
  [39.0625, [39063, 1000]],
  [44.1, [28224, 640]],
  [59.94, [23976, 400]],
  [66.666, [33333, 500]],
  [77, [39424, 512]],
  [78.125, [20000, 256]],
  [99.123, [99123, 1000]],
  [99.99, [39996, 400]],
  [119.88, [23976, 200]],
  [120.5, [30848, 256]],
  [3.3333, [26664, 8000]],
  [998.5, [31952, 32]],
  [999, [31968, 32]],
  // Past 115200 at k = 0: units per frame halved, timebase rounded down.
  [112.501, [112501, 1000]],
  [115.199, [115199, 1000]],
  [115.201, [57600, 500]],
  [116.001, [58000, 500]],
  [118.001, [59000, 500]],
  [119.999, [59999, 500]],
  [120.001, [60000, 500]],
  [120.003, [60001, 500]],
  [120.005, [24001, 200]],
  [121.003, [60501, 500]],
  [250.003, [62500, 250]],
  [333.333, [83333, 250]],
  [500.001, [62500, 125]],
  [750.001, [93750, 125]],
  [998.999, [62437, 62]],
]);

describe("TestTimebaseRule", () => {
  test.each(sorted(Array.from(_AE_TIMEBASES.keys())).map((rate) => [rate]))(
    "test_timebase_matches_after_effects[%#]",
    (rate: number) => {
      const [timebase, unitsPerFrame] = getOrThrow(_AE_TIMEBASES, rate);
      expect(valueEquals(frameGrid(rate), [timebase, unitsPerFrame])).toBe(true);
      const cdta = new CdtaChunk();
      cdta.frameRate = rate;
      expect(cdta.internalTimebase).toBe(timebase);
      expect(cdta.timeScale * 256).toBe(unitsPerFrame);
    },
  );
});

/** The float32 time ratio AE stores for `displayStartTime = value`. */
function _f32Ratio(value: number): [number, number] {
  const frac = new Fraction(struct.unpack(">f", struct.pack(">f", value))[0]);
  return [frac.numerator, frac.denominator];
}

function _cdta(rate: number): CdtaChunk {
  const cdta = new CdtaChunk();
  cdta.frameRate = rate;
  return cdta;
}

/** `displayStartFrame` / `frameTime` as AE 2026 reports them. */
describe("TestFrameNumber", () => {
  test.each([
    [29.97, 246],
    [29.97, 1221],
    [29.97, 107892],
    [59.94, 246],
    [29.97, -1244],
  ])("test_whole_frames_in_timebase_units[%#]", (rate: number, frames: number) => {
    // The frames AE's displayStartFrame setter stores (units / timebase).
    const [timebase, unitsPerFrame] = frameGrid(rate);
    expect(_frameNumber(_cdta(rate), frames * unitsPerFrame, timebase)).toBe(frames);
  });

  test.each([
    [24, 1 / 24, 2], // stored 0.0416666679: a hair past frame 1
    [24, 12.00001 / 24, 13],
    [24, 0.51, 13],
    [24, -0.51, -13],
    [24, 1531 / 24, 1532],
    [29.97, 52 / 29.97, 52],
    [29.97, 1221 / 29.97, 1221],
    [29.97, -41.5081748415082, -1244],
    [59.94, 1221 / 29.97, 2442],
    [7.3, 13 / 7.3, 14],
  ])("test_float32_display_starts[%#]", (rate: number, seconds: number, expected: number) => {
    const cdta = _cdta(rate);
    expect(_frameNumber(cdta, ..._f32Ratio(seconds))).toBe(expected);
  });
});

describe("TestFrameGridFollowsTheRate", () => {
  test("test_stored_timebase_disagreeing_with_the_rate", () => {
    // Old py_aep files stored a 24 fps comp on the 29.97 grid (23976 /
    // time scale 3.125); AE derives the grid from the rate on open and
    // reported displayStartFrame 120 for a 5 s start there.
    const cdta = _cdta(24);
    cdta.internalTimebase = 23976;
    cdta.timeScaleInteger = 3;
    cdta.timeScaleFractional = 32;
    expect(_frameNumber(cdta, 5 * 23976, 23976)).toBe(120);
  });
});

/**
 * A rate whose 16.16 fraction rounds up to 65536 carries into the
 * integer part instead of overflowing the u2 (save used to raise).
 */
describe("TestFixedPointRates", () => {
  test("test_cdta", () => {
    const cdta = new CdtaChunk();
    cdta.frameRate = 23.99999999;
    expect(valueEquals([cdta.frameRateInteger, cdta.frameRateFractional], [24, 0])).toBe(true);
    expect(cdta.tobytes().length).toBe(new CdtaChunk().tobytes().length);
  });

  test("test_render_settings", () => {
    const item = new RenderSettingsItem();
    item.frameRate = 29.9999999;
    expect(valueEquals([item.frameRateInteger, item.frameRateFractional], [30, 0])).toBe(true);
  });

  test("test_output_module", () => {
    const roou = new RouuChunk();
    roou.frameRate = 1.99999999;
    expect(valueEquals([roou.frameRateInteger, roou.frameRateFractional], [2, 0])).toBe(true);
  });

  test("test_footage_rates", () => {
    const sspc = new SspcChunk();
    sspc.nativeFrameRate = 23.99999999;
    sspc.conformFrameRate = 29.9999999;
    expect(sspc.nativeFrameRate).toBe(24.0);
    expect(sspc.conformFrameRate).toBe(30.0);
    expect(sspc.displayFrameRate).toBe(30.0);
    expect(truthy(sspc.tobytes())).toBe(true);
  });
});

describe("TestSignedWorkAreaStart", () => {
  test("test_negative_start_reads_signed", () => {
    // AE 2026 stores -1 frame (-1024/24576) for a zero-length comp.
    const cdta = new CdtaChunk();
    cdta.workAreaStartDividend = -1024;
    cdta.workAreaStartDivisor = 24576;
    const again = asInstance(CdtaChunk.frombytes(cdta.tobytes()), CdtaChunk);
    expect(again instanceof CdtaChunk).toBe(true);
    expect(approx(again.workAreaStart, -1 / 24)).toBe(true);
  });
});

describe("TestLayerTimebase", () => {
  // (comp timebase, stretch / 100) -> the tdb4 time base AE 2026 stored.
  test.each([
    [24576, 1.0, 24576],
    [24576, 0.5, 24576],
    [77777, -1.0, 77777],
    [24576, 1.5, 36864],
    [24576, -1.5, 36864],
    [23976, 1.5, 35964],
    [24576, 1.3333, 32767],
    [32768, 1.3333, 43689],
    [30720, 1.16, 35635],
    // 16.16 stretch: the exact 1.16 would give 114982.
    [99123, 1.16, 114983],
    [77777, 1.48, 115109],
    // Capped at 115200.
    [24576, 4.5, 110592],
    [24576, 5.0, 115200],
    [24576, -5.0, 115200],
    [24576, 99.0, 115200],
    [77777, 1.5, 115200],
    [30720, 4.0, 115200],
  ])("test_matches_ae[%#]", (compTimebase: number, stretch: number, expected: number) => {
    expect(layerTimebase(compTimebase, stretch)).toBe(expected);
  });
});

describe("TestStretchEncoding", () => {
  // The ldta ratio AE 2026 stored for `layer.stretch = percent`.
  test.each<[number, [number, number]]>([
    [133.33, [11184531, 8388608]],
    [33.333, [11184699, 33554432]],
    [1.0, [5368709, 536870912]],
    [9900.0, [99, 1]],
    [-9900.0, [-99, 1]],
    [-150.0, [-3, 2]],
    [100.0, [1, 1]],
  ])("test_float32_ratio[%#]", (percent: number, ratio: [number, number]) => {
    const ldta = new LdtaChunk();
    ldta.stretch = percent;
    expect(valueEquals([ldta.stretchDividend, ldta.stretchDivisor], ratio)).toBe(true);
  });
});
