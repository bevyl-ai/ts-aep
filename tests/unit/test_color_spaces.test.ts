/**
 * Byte-exact tests for the color-profile envelope format.
 *
 * Verbatim envelope strings captured from AE 2026 samples (the build functions
 * must reproduce them byte-for-byte for round-trip fidelity):
 * - working space: samples/models/property/gradient_animated.aep
 * - display space: samples/models/project/display_color_space_ACES_sRGB.aep
 */

import { describe, expect, test } from "bun:test";

import { PROFILE_TYPE_ICC, PROFILE_TYPE_OCIO, buildIccEnvelope, buildOcioColorspaceEnvelope, buildOcioDisplayEnvelope, parseEnvelope } from "../../src/py_aep/color/envelope.ts";
import { b, concat, pyEq, range } from "../../src/pyrt/index.ts";

// Verbatim AE output.
const WORKING_ACESCG =
  '{"baseColorProfile":{"colorProfileData":' +
  '"eyJjb2xvclNwYWNlMSI6IkFDRVNjZyIsIm9jaW9Db2xvclNwYWNlVHlwZSI6Mn0=",' +
  '"colorProfileName":"ACEScg"},"baseProfileType":3}';
const DISPLAY_ACES_SRGB =
  '{"baseColorProfile":{"colorProfileData":' +
  '"eyJjb2xvclNwYWNlMSI6IkFDRVMiLCJjb2xvclNwYWNlMiI6InNSR0IiLCJvY2lvQ29sb3JTcGFjZVR5cGUiOjF9",' +
  '"colorProfileName":"ACES/sRGB"},"baseProfileType":3}';

describe("TestByteExact", () => {
  /** The builders must reproduce AE's bytes exactly. */

  test("test_ocio_working_space", () => {
    expect(buildOcioColorspaceEnvelope("ACEScg")).toBe(WORKING_ACESCG);
  });

  test("test_ocio_display_space", () => {
    expect(buildOcioDisplayEnvelope("ACES", "sRGB")).toBe(DISPLAY_ACES_SRGB);
  });

  test("test_display_name_is_display_slash_view", () => {
    const prof = parseEnvelope(buildOcioDisplayEnvelope("sRGB - Display", "Raw"));
    expect(prof.name).toBe("sRGB - Display/Raw");
  });
});

describe("TestRoundTrip", () => {
  /** build -> parse -> build is stable for every variant. */

  test("test_ocio_colorspace_round_trip", () => {
    const env = buildOcioColorspaceEnvelope("ACEScg");
    const prof = parseEnvelope(env);
    expect(prof.name).toBe("ACEScg");
    expect(prof.profile_type).toBe(PROFILE_TYPE_OCIO);
    expect(prof.is_ocio).toBe(true);
    expect(pyEq(prof.ocio_color_spaces, ["ACEScg"])).toBe(true);
    expect(buildOcioColorspaceEnvelope(prof.name)).toBe(env);
  });

  test("test_ocio_display_round_trip", () => {
    const env = buildOcioDisplayEnvelope("ACES", "sRGB");
    const prof = parseEnvelope(env);
    expect(prof.name).toBe("ACES/sRGB");
    expect(pyEq(prof.ocio_color_spaces, ["ACES", "sRGB"])).toBe(true);
    const [display, view] = prof.ocio_color_spaces;
    expect(buildOcioDisplayEnvelope(display, view)).toBe(env);
  });

  test("test_icc_round_trip", () => {
    const icc = concat(b("\x00\x00\x02(fake-icc-payload"), Uint8Array.from(range(40)));
    const env = buildIccEnvelope("ProPhoto RGB", icc);
    const prof = parseEnvelope(env);
    expect(prof.name).toBe("ProPhoto RGB");
    expect(prof.profile_type).toBe(PROFILE_TYPE_ICC);
    expect(prof.is_icc).toBe(true);
    expect(prof.is_ocio).toBe(false);
    expect(pyEq(prof.data, icc)).toBe(true);
    expect(pyEq(prof.ocio_color_spaces, [])).toBe(true);
  });
});

describe("TestKeyOrderAndSeparators", () => {
  /** Pin the exact key order and compact separators (no whitespace). */

  test("test_icc_envelope_structure", () => {
    // base64("AA==") == b"\x00"; checks outer key order + compact separators.
    const env = buildIccEnvelope("X", b("\x00"));
    expect(env).toBe(
      '{"baseColorProfile":{"colorProfileData":"AA==",' +
        '"colorProfileName":"X"},"baseProfileType":2}',
    );
  });

  test("test_no_whitespace_in_inner_json", () => {
    const env = buildOcioColorspaceEnvelope("ACEScg");
    expect(env.includes(", ") || env.includes(": ")).toBe(false);
  });

  test("test_special_characters_in_name", () => {
    // Names with spaces/parens/slashes must survive both layers intact.
    const name = "sRGB Encoded Rec.709 (sRGB)";
    const prof = parseEnvelope(buildOcioColorspaceEnvelope(name));
    expect(prof.name).toBe(name);
    expect(pyEq(prof.ocio_color_spaces, [name])).toBe(true);
  });
});
