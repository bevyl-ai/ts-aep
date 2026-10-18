/**
 * Tests for the ICC profile discovery provider.
 */

import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  ColorProfileNotFoundError,
  IccProfileLibrary,
  defaultIccDirectories,
  iccProfileId,
} from "../../src/py_aep/color/icc.ts";
import { _ICC_PROFILE_MAPPING, profileIdForName } from "../../src/py_aep/enums/mappings.ts";
import { b, Bytes, valueEquals } from "../../src/pyrt/index.ts";
import { raises } from "../support/pytest.ts";
import { range } from "../support/python.ts";

/** Name -> 16-byte ID inversion of the catalogue. */
describe("TestProfileIdForName", () => {
  test("test_known_name", () => {
    expect(valueEquals(profileIdForName("sRGB IEC61966-2.1"), Bytes.fromHex("1d3fda2edb4a89ab60a23c5f7c7d81dd"))).toBe(
      true,
    );
  });

  test("test_unknown_name_returns_none", () => {
    expect(profileIdForName("Not A Real Profile")).toBe(null);
    expect(profileIdForName("ACEScg")).toBe(null); // OCIO name, not ICC
  });

  test("test_inversion_is_total_and_consistent", () => {
    for (const [uidHex, name] of _ICC_PROFILE_MAPPING) {
      expect(valueEquals(profileIdForName(name), Bytes.fromHex(uidHex))).toBe(true);
    }
  });
});

/** The masked-MD5 ID algorithm. */
describe("TestIccProfileId", () => {
  test("test_masks_flag_intent_and_id_fields", () => {
    const data = Uint8Array.from(range(256));
    const expected = new Uint8Array(data);
    expected.set(Bytes.repeat(b("\x00"), 4), 44);
    expected.set(Bytes.repeat(b("\x00"), 4), 64);
    expected.set(Bytes.repeat(b("\x00"), 16), 84);
    expect(valueEquals(iccProfileId(data), new Uint8Array(createHash("md5").update(expected).digest()))).toBe(true);
    expect(iccProfileId(data).length).toBe(16);
  });

  test("test_rendering_intent_byte_does_not_change_id", () => {
    // Two profiles differing only in the masked rendering-intent region
    // must hash identically (the reason the masking exists).
    const a = Uint8Array.from(range(256));
    const bb = Uint8Array.from(range(256));
    bb.set(b("\xde\xad\xbe\xef"), 64);
    expect(valueEquals(iccProfileId(a), iccProfileId(bb))).toBe(true);
  });
});

describe("TestLibraryErrors", () => {
  test("test_missing_profile_raises_with_context", () => {
    const lib = new IccProfileLibrary([]); // nothing to scan
    const exc = raises(ColorProfileNotFoundError, () => lib.bytesFor("ProPhoto RGB"));
    expect(exc.message.includes("ProPhoto RGB")).toBe(true);
    expect(exc.profileName).toBe("ProPhoto RGB");
  });

  test("test_hash_for_uses_catalogue_without_disk", () => {
    // Even with no directories, a catalogued name resolves via the mapping.
    const lib = new IccProfileLibrary([]);
    expect(valueEquals(lib.hashFor("Apple RGB"), Bytes.fromHex("47ae2b5f4c143df9d07b5dc78036b5a8"))).toBe(true);
  });

  test("test_hash_for_unknown_raises", () => {
    const lib = new IccProfileLibrary([]);
    raises(ColorProfileNotFoundError, () => {
      lib.hashFor("Definitely Not Catalogued XYZ");
    });
  });
});

// Disk discovery depends on an Adobe installation; skip cleanly when absent.
const _DISCOVERABLE = defaultIccDirectories().some((d) => d.isDir());

// skipif reason: "Adobe Color dirs not installed"
describe.skipIf(!_DISCOVERABLE)("TestDiscovery", () => {
  test("test_discovered_bytes_hash_to_catalogued_id", () => {
    const lib = new IccProfileLibrary();
    const data = lib.bytesFor("sRGB IEC61966-2.1");
    expect(valueEquals(Bytes.slice(data, 36, 40), b("acsp"))).toBe(true);
    expect(valueEquals(iccProfileId(data), profileIdForName("sRGB IEC61966-2.1"))).toBe(true);
  });
});

// The `* wsRGB`/`* wscRGB` WCS profiles are cached in the per-user Adobe Color
// directory only after AE generates them at runtime, and those cached bytes are
// machine-specific: their masked-MD5 IDs do not match the catalogued reference
// IDs, so a discovery round-trip cannot be asserted in a machine-independent
// way. There is no fixture to pin here, so the gap is left uncovered by design.
