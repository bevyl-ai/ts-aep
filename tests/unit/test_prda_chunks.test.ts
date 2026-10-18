/** Tests for the prda renderer-option chunk variants. */

import { describe, expect, test } from "bun:test";

import { ByteStream, Bytes, valueEquals } from "../../src/pyrt/index.ts";

import "../../src/py_aep/binary/_register.ts";
import { asInstance } from "../helpers.ts";
import {
  AdvancedPrdaChunk,
  Cinema4DPrdaChunk,
  ClassicPrdaChunk,
  PrdaChunk,
  RayTracedPrdaChunk,
} from "../../src/py_aep/binary/misc_chunks.ts";
import { approx } from "../support/pytest.ts";

const PRDA_CLASSIC_DEFAULT = Bytes.fromHex("000000010000000000000000");
// big-endian head: version, renderer tag, quality 8, two reserved words
// little-endian tail: resolution 1, smoothness 3, size 1.0 x3, centre 0.0 x3
const PRDA_ADVANCED_DEFAULT = Bytes.fromHex(
  "0000000100000003000000080000000100000000" + "01000000030000000000803f0000803f0000803f000000000000000000000000",
);
const PRDA_CINEMA_DEFAULT = Bytes.fromHex("0000000100000001000000190000000100000000");
// obsolete renderer, removed in AE 2020 (17.0)
const PRDA_RAYTRACED = Bytes.fromHex("00000001000000000000000300000001");

const PRDA_CLASSIC_SET = Bytes.fromHex("000000010000000000000003");
const PRDA_ADVANCED_SET = Bytes.fromHex(
  "00000001000000030000003d0000000100000000" + "02000000060000000000a03e0000a03e0000a03e565595be408e633d555555bd",
);
const PRDA_CINEMA_SET = Bytes.fromHex("00000001000000010000002c0000000100000000");

describe("TestPrdaVariants", () => {
  test.each<[Uint8Array, string, typeof PrdaChunk]>([
    [PRDA_CLASSIC_DEFAULT, "ADBE Escher", ClassicPrdaChunk],
    [PRDA_RAYTRACED, "ADBE Picasso", RayTracedPrdaChunk],
    [PRDA_CINEMA_DEFAULT, "ADBE Ernst", Cinema4DPrdaChunk],
    [PRDA_ADVANCED_DEFAULT, "ADBE Calder", AdvancedPrdaChunk],
  ])("test_dispatch_by_renderer[%#]", (body, matchName, expectedCls) => {
    /** Dispatch keys off the sibling prin chunk's match name. */
    const chunk = PrdaChunk.frombytes(body, {
      chunkType: "prda",
      rendererMatchName: matchName,
    });
    expect(chunk.constructor).toBe(expectedCls);
  });

  test.each<[Uint8Array, string]>([
    [PRDA_CLASSIC_DEFAULT, "ADBE Escher"],
    [PRDA_CLASSIC_SET, "ADBE Escher"],
    [PRDA_RAYTRACED, "ADBE Picasso"],
    [PRDA_CINEMA_DEFAULT, "ADBE Ernst"],
    [PRDA_CINEMA_SET, "ADBE Ernst"],
    [PRDA_ADVANCED_DEFAULT, "ADBE Calder"],
    [PRDA_ADVANCED_SET, "ADBE Calder"],
  ])("test_roundtrip_byte_exact[%#]", (body, matchName) => {
    const chunk = PrdaChunk.frombytes(body, {
      chunkType: "prda",
      rendererMatchName: matchName,
    });
    const buf = new ByteStream();
    chunk.write(buf);
    expect(valueEquals(buf.toBytes(), body)).toBe(true);
  });

  test("test_classic_shadow_map_resolution", () => {
    const chunk = asInstance(
      PrdaChunk.frombytes(PRDA_CLASSIC_SET, {
        chunkType: "prda",
        rendererMatchName: "ADBE Escher",
      }),
      ClassicPrdaChunk,
    );
    expect(chunk.shadowMapResolution).toBe(3);
  });

  test("test_cinema_quality", () => {
    const chunk = asInstance(
      PrdaChunk.frombytes(PRDA_CINEMA_SET, {
        chunkType: "prda",
        rendererMatchName: "ADBE Ernst",
      }),
      Cinema4DPrdaChunk,
    );
    expect(chunk.quality).toBe(44);
  });

  test("test_advanced_fields_mixed_endian", () => {
    /** Head is big-endian, the tail from offset 20 little-endian. */
    const chunk = asInstance(
      PrdaChunk.frombytes(PRDA_ADVANCED_SET, {
        chunkType: "prda",
        rendererMatchName: "ADBE Calder",
      }),
      AdvancedPrdaChunk,
    );
    expect(chunk.quality).toBe(61);
    expect(chunk.resolution).toBe(2);
    expect(chunk.smoothness).toBe(6);
    expect(approx(chunk.castingBoxSizeX, 0.3125)).toBe(true);
    expect(approx(chunk.castingBoxSizeY, 0.3125)).toBe(true);
    expect(approx(chunk.castingBoxSizeZ, 0.3125)).toBe(true);
    expect(approx(chunk.castingBoxCenterX, -0.2916667)).toBe(true);
    expect(approx(chunk.castingBoxCenterY, 0.0555556)).toBe(true);
    expect(approx(chunk.castingBoxCenterZ, -0.0520833)).toBe(true);
  });

  test.each<[typeof PrdaChunk, Uint8Array]>([
    [ClassicPrdaChunk, PRDA_CLASSIC_DEFAULT],
    [RayTracedPrdaChunk, PRDA_RAYTRACED],
    [Cinema4DPrdaChunk, PRDA_CINEMA_DEFAULT],
    [AdvancedPrdaChunk, PRDA_ADVANCED_DEFAULT],
  ])("test_defaults_match_after_effects[%#]", (cls, expected) => {
    /** A default-constructed variant equals AE's own default blob. */
    const buf = new ByteStream();
    new cls().write(buf);
    expect(valueEquals(buf.toBytes(), expected)).toBe(true);
  });

  test.each<[Uint8Array, string]>([
    // A renderer we do not know about must not corrupt the file.
    [Bytes.fromHex("00112233445566"), "ADBE Future"],
    // A known renderer whose body size changed must
    // fall back to raw bytes rather than misparse.
    [PRDA_CLASSIC_DEFAULT, "ADBE Calder"],
    // No prin sibling resolved at all.
    [PRDA_CLASSIC_DEFAULT, ""],
  ])("test_unrecognised_prda_falls_back_to_raw[%#]", (body, matchName) => {
    const chunk = PrdaChunk.frombytes(body, {
      chunkType: "prda",
      rendererMatchName: matchName,
    });
    expect(chunk.constructor).toBe(PrdaChunk);
    const buf = new ByteStream();
    chunk.write(buf);
    expect(valueEquals(buf.toBytes(), body)).toBe(true);
  });
});
