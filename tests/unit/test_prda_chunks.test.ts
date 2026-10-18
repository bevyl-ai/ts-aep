/** Tests for the prda renderer-option chunk variants. */

import { describe, expect, test } from "bun:test";

import { BytesIO, bytes_, py_eq } from "../../src/pyrt/index.ts";
import { approx } from "../../src/pyrt/pytest.ts";
import "../../src/py_aep/binary/_register.ts";
import { as_instance } from "../helpers.ts";
import { AdvancedPrdaChunk, Cinema4DPrdaChunk, ClassicPrdaChunk, PrdaChunk, RayTracedPrdaChunk } from "../../src/py_aep/binary/misc_chunks.ts";

const PRDA_CLASSIC_DEFAULT = bytes_.fromhex("000000010000000000000000");
// big-endian head: version, renderer tag, quality 8, two reserved words
// little-endian tail: resolution 1, smoothness 3, size 1.0 x3, centre 0.0 x3
const PRDA_ADVANCED_DEFAULT = bytes_.fromhex(
  "0000000100000003000000080000000100000000" +
    "01000000030000000000803f0000803f0000803f000000000000000000000000",
);
const PRDA_CINEMA_DEFAULT = bytes_.fromhex("0000000100000001000000190000000100000000");
// obsolete renderer, removed in AE 2020 (17.0)
const PRDA_RAYTRACED = bytes_.fromhex("00000001000000000000000300000001");

const PRDA_CLASSIC_SET = bytes_.fromhex("000000010000000000000003");
const PRDA_ADVANCED_SET = bytes_.fromhex(
  "00000001000000030000003d0000000100000000" +
    "02000000060000000000a03e0000a03e0000a03e565595be408e633d555555bd",
);
const PRDA_CINEMA_SET = bytes_.fromhex("00000001000000010000002c0000000100000000");

describe("TestPrdaVariants", () => {
  test.each<[Uint8Array, string, typeof PrdaChunk]>([
    [PRDA_CLASSIC_DEFAULT, "ADBE Escher", ClassicPrdaChunk],
    [PRDA_RAYTRACED, "ADBE Picasso", RayTracedPrdaChunk],
    [PRDA_CINEMA_DEFAULT, "ADBE Ernst", Cinema4DPrdaChunk],
    [PRDA_ADVANCED_DEFAULT, "ADBE Calder", AdvancedPrdaChunk],
  ])("test_dispatch_by_renderer[%#]", (body, match_name, expected_cls) => {
    /** Dispatch keys off the sibling prin chunk's match name. */
    const chunk = PrdaChunk.frombytes(body, {
      chunk_type: "prda",
      renderer_match_name: match_name,
    });
    expect(chunk.constructor).toBe(expected_cls);
  });

  test.each<[Uint8Array, string]>([
    [PRDA_CLASSIC_DEFAULT, "ADBE Escher"],
    [PRDA_CLASSIC_SET, "ADBE Escher"],
    [PRDA_RAYTRACED, "ADBE Picasso"],
    [PRDA_CINEMA_DEFAULT, "ADBE Ernst"],
    [PRDA_CINEMA_SET, "ADBE Ernst"],
    [PRDA_ADVANCED_DEFAULT, "ADBE Calder"],
    [PRDA_ADVANCED_SET, "ADBE Calder"],
  ])("test_roundtrip_byte_exact[%#]", (body, match_name) => {
    const chunk = PrdaChunk.frombytes(body, {
      chunk_type: "prda",
      renderer_match_name: match_name,
    });
    const buf = new BytesIO();
    chunk.write(buf);
    expect(py_eq(buf.getvalue(), body)).toBe(true);
  });

  test("test_classic_shadow_map_resolution", () => {
    const chunk = as_instance(
      PrdaChunk.frombytes(PRDA_CLASSIC_SET, {
        chunk_type: "prda",
        renderer_match_name: "ADBE Escher",
      }),
      ClassicPrdaChunk,
    );
    expect(chunk.shadow_map_resolution).toBe(3);
  });

  test("test_cinema_quality", () => {
    const chunk = as_instance(
      PrdaChunk.frombytes(PRDA_CINEMA_SET, {
        chunk_type: "prda",
        renderer_match_name: "ADBE Ernst",
      }),
      Cinema4DPrdaChunk,
    );
    expect(chunk.quality).toBe(44);
  });

  test("test_advanced_fields_mixed_endian", () => {
    /** Head is big-endian, the tail from offset 20 little-endian. */
    const chunk = as_instance(
      PrdaChunk.frombytes(PRDA_ADVANCED_SET, {
        chunk_type: "prda",
        renderer_match_name: "ADBE Calder",
      }),
      AdvancedPrdaChunk,
    );
    expect(chunk.quality).toBe(61);
    expect(chunk.resolution).toBe(2);
    expect(chunk.smoothness).toBe(6);
    expect(approx(chunk.casting_box_size_x, 0.3125)).toBe(true);
    expect(approx(chunk.casting_box_size_y, 0.3125)).toBe(true);
    expect(approx(chunk.casting_box_size_z, 0.3125)).toBe(true);
    expect(approx(chunk.casting_box_center_x, -0.2916667)).toBe(true);
    expect(approx(chunk.casting_box_center_y, 0.0555556)).toBe(true);
    expect(approx(chunk.casting_box_center_z, -0.0520833)).toBe(true);
  });

  test.each<[typeof PrdaChunk, Uint8Array]>([
    [ClassicPrdaChunk, PRDA_CLASSIC_DEFAULT],
    [RayTracedPrdaChunk, PRDA_RAYTRACED],
    [Cinema4DPrdaChunk, PRDA_CINEMA_DEFAULT],
    [AdvancedPrdaChunk, PRDA_ADVANCED_DEFAULT],
  ])("test_defaults_match_after_effects[%#]", (cls, expected) => {
    /** A default-constructed variant equals AE's own default blob. */
    const buf = new BytesIO();
    new cls().write(buf);
    expect(py_eq(buf.getvalue(), expected)).toBe(true);
  });

  test.each<[Uint8Array, string]>([
    // A renderer we do not know about must not corrupt the file.
    [bytes_.fromhex("00112233445566"), "ADBE Future"],
    // A known renderer whose body size changed must
    // fall back to raw bytes rather than misparse.
    [PRDA_CLASSIC_DEFAULT, "ADBE Calder"],
    // No prin sibling resolved at all.
    [PRDA_CLASSIC_DEFAULT, ""],
  ])("test_unrecognised_prda_falls_back_to_raw[%#]", (body, match_name) => {
    const chunk = PrdaChunk.frombytes(body, {
      chunk_type: "prda",
      renderer_match_name: match_name,
    });
    expect(chunk.constructor).toBe(PrdaChunk);
    const buf = new BytesIO();
    chunk.write(buf);
    expect(py_eq(buf.getvalue(), body)).toBe(true);
  });
});
