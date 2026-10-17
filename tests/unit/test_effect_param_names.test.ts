/**
 * Effect parameter names in the project's code page.
 *
 * Projects saved before AE 26 store `pard` names in the system code page: AE
 * reads Set Channels' "Set Red To Source 1's" from a Windows project with a
 * U+2019 apostrophe, byte 0x92 in Windows-1252. Characters are written as
 * code points so the test does not depend on its own encoding.
 */

import { expect, test } from "bun:test";

import { b, decode } from "../../src/pyrt/index.ts";
import { _decode_pard_name } from "../../src/py_aep/parsers/effect.ts";

const _APOSTROPHE = String.fromCodePoint(0x2019);

test.each<[Uint8Array, number, string]>([
  [b("Set Red To Source 1\x92s"), 1252, `Set Red To Source 1${_APOSTROPHE}s`],
  [b("Set Red To Source 1\xd5s"), 0x0100, `Set Red To Source 1${_APOSTROPHE}s`],
  // Valid UTF-8 (AE 26 projects) is kept, whatever the code page.
  [b("Caf\xc3\xa9"), 1252, "Caf" + String.fromCodePoint(0xe9)],
  [b("Blur"), 1252, "Blur"],
  // A code page there is no codec for: kept as read.
  [b("a\x92"), 99999, "a" + String.fromCharCode(0xdc92)],
])("test_decodes_in_the_project_code_page[%#]", (raw, code_page, expected) => {
  // As the pard chunk reads it: UTF-8, other bytes kept as surrogates.
  const name = decode(raw, "utf-8", "surrogateescape");
  expect(_decode_pard_name(name, code_page)).toBe(expected);
});
