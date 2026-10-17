/** PDFDocEncoding - the default character set of a PDF text string.
 *
 * A PDF text string that does not open with a UTF-16 byte-order mark is
 * encoded in PDFDocEncoding (PDF 32000-1:2008, Annex D.2), which is Latin-1
 * with the C0/C1 control ranges replaced by typographic characters. Probed
 * against After Effects 2026, which decodes `.ai` layer names this way:
 * `0x80` imports as U+2022 BULLET (not the Windows-1252 euro sign), `0x18`
 * as U+02D8 BREVE, `0xA0` as U+20AC EURO, and the code points the table
 * leaves undefined (`0x7F`, `0x9F`, `0xAD`) as U+FFFD.
 *
 * The overrides are written as code points rather than character literals
 * so the table cannot be mangled by an editor or formatter.
 */

import { decode } from "../../pyrt/index.ts";
import { CosString } from "./cos.ts";

export const _UNDEFINED = 0xfffd;

/** byte -\> unicode code point, for every byte Latin-1 does not already cover. */
export const _OVERRIDES: Map<number, number> = new Map<number, number>([
  [0x18, 0x02d8], // breve
  [0x19, 0x02c7], // caron
  [0x1a, 0x02c6], // circumflex
  [0x1b, 0x02d9], // dotaccent
  [0x1c, 0x02dd], // hungarumlaut
  [0x1d, 0x02db], // ogonek
  [0x1e, 0x02da], // ring
  [0x1f, 0x02dc], // tilde
  [0x7f, _UNDEFINED],
  [0x80, 0x2022], // bullet
  [0x81, 0x2020], // dagger
  [0x82, 0x2021], // daggerdbl
  [0x83, 0x2026], // ellipsis
  [0x84, 0x2014], // emdash
  [0x85, 0x2013], // endash
  [0x86, 0x0192], // florin
  [0x87, 0x2044], // fraction
  [0x88, 0x2039], // guilsinglleft
  [0x89, 0x203a], // guilsinglright
  [0x8a, 0x2212], // minus
  [0x8b, 0x2030], // perthousand
  [0x8c, 0x201e], // quotedblbase
  [0x8d, 0x201c], // quotedblleft
  [0x8e, 0x201d], // quotedblright
  [0x8f, 0x2018], // quoteleft
  [0x90, 0x2019], // quoteright
  [0x91, 0x201a], // quotesinglbase
  [0x92, 0x2122], // trademark
  [0x93, 0xfb01], // fi ligature
  [0x94, 0xfb02], // fl ligature
  [0x95, 0x0141], // Lslash
  [0x96, 0x0152], // OE
  [0x97, 0x0160], // Scaron
  [0x98, 0x0178], // Ydieresis
  [0x99, 0x017d], // Zcaron
  [0x9a, 0x0131], // dotlessi
  [0x9b, 0x0142], // lslash
  [0x9c, 0x0153], // oe
  [0x9d, 0x0161], // scaron
  [0x9e, 0x017e], // zcaron
  [0x9f, _UNDEFINED],
  [0xa0, 0x20ac], // Euro
  [0xad, _UNDEFINED],
]);

/**
 * Decode a PDF text string.
 *
 * A BOM-prefixed literal (UTF-16 either way, or UTF-8) is decoded by the
 * COS lexer already and passes through. Everything else is
 * PDFDocEncoding, and reaches this function one of two ways: as raw
 * bytes the lexer could not decode at all, or - when the bytes happen to
 * form valid UTF-8 - as a `CosString` the lexer decoded speculatively
 * but kept the original bytes on, as `cos_raw`.
 *
 * Probed on AE 2026, which imports `.ai` / `.pdf` layer names strictly
 * this way: `(caf\\xc3\\xa9)` with no BOM becomes `caf` + U+00C3 U+00A9,
 * NOT the UTF-8 reading `café`.
 *
 * @param raw - The string object read from the PDF.
 */
export function decode_pdf_text_string(raw: Uint8Array | string | CosString): string {
  if (raw instanceof Uint8Array) {
    return _from_bytes(raw);
  }
  if (raw instanceof CosString && raw.cos_raw != null) {
    return _from_bytes(raw.cos_raw);
  }
  // A decoded CosString passes through with its text.
  return String(raw);
}

export function _from_bytes(raw: Uint8Array): string {
  // Latin-1 maps every byte to the same code point, and `str.translate`
  // leaves the ones absent from the table alone - which is exactly the
  // passthrough the other 215 bytes need.
  return _translate(decode(raw, "latin-1"), _OVERRIDES);
}

export function _translate(text: string, table: Map<number, number>): string {
  let out = "";
  for (const ch of text) {
    const mapped = table.get(ch.codePointAt(0) ?? -1);
    out += mapped === undefined ? ch : String.fromCodePoint(mapped);
  }
  return out;
}
