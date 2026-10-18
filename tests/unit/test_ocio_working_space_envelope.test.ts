/**
 * The OCIO working-space envelope is per-selection-KIND, not per-AE-version.
 *
 * Every expected string below is the exact `PwCs` `Utf8` value After Effects
 * itself stored in the matching sample - the same four selection kinds the
 * output color space uses.
 *
 * The AE25/AE26 pair is the controlled experiment: the same scene, the same
 * pick, two AE versions, byte-identical envelopes. `aces_acescg_yo.aep` is AE
 * 25.6 too, yet stores the OTHER shape - so the shape follows the SELECTION,
 * not the writer's version.
 */

import { describe, expect, test } from "bun:test";

import { parseEnvelope } from "../../src/py_aep/color/envelope.ts";
import { ocioColorProfileEnvelope, resolveOcioConfig } from "../../src/py_aep/color/ocio.ts";
import { decode, Path, ValueError } from "../../src/pyrt/index.ts";
import { raises, skip } from "../support/pytest.ts";

const ROOT = new Path(import.meta.path).parent.parent.parent;
const CONFIG = ROOT.div("samples/models/output_module/output_color_space_ocio/sergb.ocio");

// Verbatim AE output.
const DIRECT_ACESCG =
  '{"baseColorProfile":{"colorProfileData":"eyJjb2xvclNwYWNlMSI6IkFDRVNjZyB5byJ9",' +
  '"colorProfileName":"ACES/ACEScg yo"},"baseProfileType":3}';
const ROLE_MARI_INT16 =
  '{"baseColorProfile":{"colorProfileData":' +
  '"eyJjb2xvclNwYWNlMSI6InNSR0IgKG1hcmlfaW50MTYpIiwib2Npb0NvbG9yU3BhY2VUeXBlIjoyfQ==",' +
  '"colorProfileName":"sRGB (mari_int16)"},"baseProfileType":3}';

describe("TestByteExactAgainstAE", () => {
  test("test_direct_colorspace", () => {
    // family/name, and NO ocioColorSpaceType key.
    expect(ocioColorProfileEnvelope(CONFIG, "ACEScg yo")).toBe(DIRECT_ACESCG);
  });

  test("test_role", () => {
    // The role's TARGET name, with ocioColorSpaceType 2 and no family.
    expect(ocioColorProfileEnvelope(CONFIG, "mari_int16")).toBe(ROLE_MARI_INT16);
  });

  test("test_direct_and_role_shapes_differ", () => {
    // The bug this pins: the role/alias shape was applied to every kind.
    expect(_decoded(DIRECT_ACESCG)).toBe('{"colorSpace1":"ACEScg yo"}');
    expect(_decoded(ROLE_MARI_INT16)).toBe('{"colorSpace1":"sRGB (mari_int16)","ocioColorSpaceType":2}');
  });
});

describe("TestQualifiedNameRoundTrips", () => {
  test("test_family_qualified_name_is_accepted", () => {
    // `Project.workingSpace` reads back the qualified name, so assigning
    // it straight back must not raise.
    expect(ocioColorProfileEnvelope(CONFIG, "ACES/ACEScg yo")).toBe(DIRECT_ACESCG);
  });

  test("test_display_view_pair", () => {
    const env = ocioColorProfileEnvelope(CONFIG, "sRGB yo/Raw");
    expect(env.includes('"colorProfileName":"sRGB yo/Raw"')).toBe(true);
    expect(_decoded(env).includes('"ocioColorSpaceType":1')).toBe(true);
  });

  test("test_unknown_name_raises", () => {
    raises(ValueError, () => ocioColorProfileEnvelope(CONFIG, "NotAColorSpace"), "not a color space");
  });

  test("test_bogus_family_prefix_raises", () => {
    raises(ValueError, () => ocioColorProfileEnvelope(CONFIG, "Nope/ACEScg yo"), "not a color space");
  });
});

describe("TestFamilyNamedLikeADisplay", () => {
  /**
   * A family can share a display's name; `family/name` must still win.
   *
   * ACES 1.2's ONLY display is `ACES`, which is also the family of
   * `ACES - ACEScg`. Matching a `display/view` on the display alone claimed
   * the qualified `ACES/ACES - ACEScg` the getters return and silently wrote a
   * display+view envelope (`ocioColorSpaceType: 1`) instead of a direct pick.
   * `sergb.ocio` has no display called `ACES`, so this only shows up here.
   */

  const ACES12 = resolveOcioConfig("ACES 1.2");

  // Python autouse fixture `_require_aces12`, inlined as a per-test guard.
  test("test_family_qualified_name_is_a_direct_pick", () => {
    if (ACES12 == null) return skip("AE's bundled ACES 1.2 config is not installed");
    const env = ocioColorProfileEnvelope(ACES12, "ACES/ACES - ACEScg");
    expect(_decoded(env)).toBe('{"colorSpace1":"ACES - ACEScg"}');
    expect(env.includes('"colorProfileName":"ACES/ACES - ACEScg"')).toBe(true);
  });

  test("test_bare_name_gives_the_same_envelope", () => {
    if (ACES12 == null) return skip("AE's bundled ACES 1.2 config is not installed");
    expect(ocioColorProfileEnvelope(ACES12, "ACES - ACEScg")).toBe(
      ocioColorProfileEnvelope(ACES12, "ACES/ACES - ACEScg"),
    );
  });

  test("test_real_display_view_pair_still_resolves", () => {
    if (ACES12 == null) return skip("AE's bundled ACES 1.2 config is not installed");
    // `sRGB` IS a view of the `ACES` display - this must stay type 1.
    const env = ocioColorProfileEnvelope(ACES12, "ACES/sRGB");
    expect(_decoded(env).includes('"ocioColorSpaceType":1')).toBe(true);
    expect(_decoded(env).includes('"colorSpace1":"ACES"')).toBe(true);
  });

  test("test_display_prefix_with_a_non_view_raises", () => {
    if (ACES12 == null) return skip("AE's bundled ACES 1.2 config is not installed");
    raises(ValueError, () => ocioColorProfileEnvelope(ACES12, "ACES/NotAView"), "not a color space");
  });
});

/** Decode the envelope's `Utf8` payload back to its JSON text. */
function _decoded(envelope: string): string {
  return decode(parseEnvelope(envelope).data, "utf-8");
}
