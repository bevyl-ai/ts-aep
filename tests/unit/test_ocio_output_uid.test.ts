/**
 * The OCIO output-color-space UID = MurmurHash3-128 of a color-profile envelope.
 *
 * Every expected id below is the value After Effects itself stored in the matching
 * sample under
 * `samples/unused/output_module/output_color_space_ocio/` (AE ground truth).
 */

import { expect, test } from "bun:test";

import { Path, ValueError, b, bytes_, pyEq } from "../../src/pyrt/index.ts";
import { raises } from "../../src/pyrt/pytest.ts";
import { GUID_SEED, murmurhash3X64128 } from "../../src/py_aep/color/murmur3.ts";
import { ocioColorSpaceForProfileId, ocioOutputProfileId } from "../../src/py_aep/color/ocio.ts";

// `Path(__file__).parent.parent.parent`: tests/unit/<file> -> repo root.
const CONFIG = new Path(import.meta.dir)
  .parent.parent.div("samples/models/output_module/output_color_space_ocio/sergb.ocio");

test("test_murmurhash3_empty_is_zero", () => {
  // Standard MurmurHash3_x64_128 of an empty input with seed 0 is all zeros.
  expect(pyEq(murmurhash3X64128(b(""), 0), bytes_.repeat(b("\x00"), 16))).toBe(true);
});

test("test_guid_seed", () => {
  expect(GUID_SEED).toBe(0xc29de5b8264cd69en);
});

const ocioOutputProfileIdRows: [string, string][] = [
  // direct color space (family "ACES")
  ["ACEScg yo", "cd772629527fa64b21927794e61262e1"],
  // display color space (family "Display")
  ["sRGB yo", "0c6d240a9d763d2280efa009c82bc004"],
  // utility color space
  ["Linear Rec.709 yo", "97fa2ab73be1a7374957664d0f908212"],
  // role resolving to an alias (why 8 aliases -> 8 distinct ids)
  ["color_picking", "9be73db21a1cd0aa789806cda2cc211c"],
  // role resolving to a display color space
  ["cie_xyz_d65_interchange", "e20c1e9c43eb3902e8e0bb2df1208fbb"],
  // display + view pair
  ["sRGB yo/Un-tone-mapped yo", "57046209b3a07b687fa241e6f4bae3b4"],
];

test.each(ocioOutputProfileIdRows)(
  "test_ocio_output_profile_id_matches_ae[%#]",
  (colorSpace: string, expected: string) => {
    expect(bytes_.hex(ocioOutputProfileId(CONFIG, colorSpace))).toBe(expected);
  },
);

test("test_ocio_output_profile_id_unknown_raises", () => {
  raises(ValueError, () => ocioOutputProfileId(CONFIG, "Not A Color Space In This Config"), "not a color space");
});

test("test_reverse_map_round_trips", () => {
  for (const colorSpace of ["ACEScg yo", "sRGB yo", "sRGB yo/Un-tone-mapped yo"]) {
    const profileId = ocioOutputProfileId(CONFIG, colorSpace);
    expect(ocioColorSpaceForProfileId(CONFIG, profileId)).toBe(colorSpace);
  }
});

test("test_reverse_map_unknown_id_is_none", () => {
  expect(ocioColorSpaceForProfileId(CONFIG, bytes_.repeat(b("\x00"), 16))).toBe(null);
});
