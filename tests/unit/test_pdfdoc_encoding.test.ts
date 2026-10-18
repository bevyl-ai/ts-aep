/** PDFDocEncoding decoding of PDF text strings.

  Expected characters are AE 2026's own, read back from the layer names it
  gives a hand-built `.ai` whose OCG names carry these bytes. They are
  written as code points so the test does not depend on its own encoding.
*/

import { expect, test } from "bun:test";

import { BytesIO, b, concat, pyAssert, pyEq } from "../../src/pyrt/index.ts";
import { CosParser, decodePdfTextString } from "../../src/py_aep/cos/index.ts";
import { CosString } from "../../src/py_aep/cos/cos.ts";

const _REPLACEMENT = String.fromCodePoint(0xfffd);

test.each([
  // Latin-1 range: unchanged (the reported German layer names).
  [b("L\xf6sung"), "L" + String.fromCodePoint(0xf6) + "sung"],
  [b("Gl\xe4nzen"), "Gl" + String.fromCodePoint(0xe4) + "nzen"],
  [b("100% K\xf6rper Stroke"), "100% K" + String.fromCodePoint(0xf6) + "rper Stroke"],
  // C1 range: typographic characters, NOT Windows-1252. 0x80 is a
  // bullet here, where cp1252 would give a euro sign.
  [b("\x80"), String.fromCodePoint(0x2022)],
  [b("\x92"), String.fromCodePoint(0x2122)],
  [b("\x96"), String.fromCodePoint(0x0152)],
  // C0 range 0x18-0x1F: accents.
  [b("\x18"), String.fromCodePoint(0x02d8)],
  [b("\x1f"), String.fromCodePoint(0x02dc)],
  // 0xA0 is the euro sign, where Latin-1 has a non-breaking space.
  [b("\xa0"), String.fromCodePoint(0x20ac)],
  // Undefined code points.
  [b("\x7f"), _REPLACEMENT],
  [b("\x9f"), _REPLACEMENT],
  [b("\xad"), _REPLACEMENT],
  // ASCII passes through.
  [b("Layer 1"), "Layer 1"],
  [b(""), ""],
])("test_decodes_like_after_effects[%#]", (raw: Uint8Array, expected: string) => {
  expect(decodePdfTextString(raw)).toBe(expected);
});

test("test_already_decoded_strings_pass_through", () => {
  // The COS lexer decodes a BOM-prefixed UTF-16 string itself.
  const already = String.fromCodePoint(0xdc) + "n" + String.fromCodePoint(0xef) + "code";
  expect(decodePdfTextString(already)).toBe(already);
});

test.each([
  // Invalid UTF-8: the lexer gives up and hands over raw bytes.
  [b("a_\xf6"), "a_" + String.fromCodePoint(0xf6)],
  [b("b_\x80"), "b_" + String.fromCodePoint(0x2022)],
  // Valid UTF-8 AND meaningful PDFDocEncoding. With no BOM the PDF
  // spec says PDFDocEncoding, and so does AE: these four are the
  // exact layer names AE 2026 imported this file's OCGs as, where
  // the UTF-8 reading would give U+00E9 / U+00A0 / U+20AC / U+00C0.
  [b("c_\xc3\xa9"), "c_" + String.fromCodePoint(0x00c3) + String.fromCodePoint(0x00a9)],
  [b("d_\xc2\xa0"), "d_" + String.fromCodePoint(0x00c2) + String.fromCodePoint(0x20ac)],
  [
    b("e_\xe2\x82\xac"),
    "e_" + String.fromCodePoint(0x00e2) + String.fromCodePoint(0x2021) + String.fromCodePoint(0x00ac),
  ],
  [b("f_\xc3\x80"), "f_" + String.fromCodePoint(0x00c3) + String.fromCodePoint(0x2022)],
  // A BOM means what it says, and is left alone.
  [b("\xfe\xff\x00g\x00_\x00o\x00k"), "g_ok"],
  [b("\xef\xbb\xbfh_\xc3\xa9"), "h_" + String.fromCodePoint(0x00e9)],
  [b("Layer 1"), "Layer 1"],
])(
  "test_decodes_lexer_output_like_after_effects[%#]",
  (literal: Uint8Array, expected: string) => {
    /** The whole path: a COS string literal as it sits in the file.

    Feeding raw bytes straight in cannot catch a regression here - the
    lexer decodes anything that is valid UTF-8 before this function ever
    sees it, so only a literal exercises the case that matters.
    */
    const token = new CosParser(new BytesIO(concat(literal, b(")")))).lex_string();
    const value = token.value;
    pyAssert(value instanceof Uint8Array || value instanceof CosString);
    expect(pyEq(decodePdfTextString(value), expected)).toBe(true);
  },
);
