/**
 * Parse COS (Carousel Object Structure) text data into text models.
 *
 * Transforms the Map returned by {@link CosParser | CosParser} for a
 * `btdk` chunk into {@link TextDocument | TextDocument} and
 * {@link FontObject | FontObject} instances.
 *
 * The COS data layout follows the structure documented in the
 * `lottie-docs AEP reference <https://github.com/nickt/lottie-docs/blob/main/docs/aep.md#list-btdk>`_.
 *
 * Fonts
 * -----
 * `data["0"]["1"]["0"]` contains an array of available fonts.  Each entry
 * carries a `CoolTypeFont` marker and exposes PostScript name, version, and
 * a flag at well-known sub-keys.
 *
 * Text documents
 * --------------
 * `data["1"]["1"]` is an array of text documents (one per keyframe).  Inside
 * each document:
 *
 * * `doc["0"]["0"]` - the text string
 * * `doc["0"]["5"]["0"]` - array of paragraph style runs
 * * `doc["0"]["6"]["0"]` - array of character style runs
 *
 * Default styles live at `data["1"]["2"]` (character) and
 * `data["1"]["3"]` (paragraph).
 */

import { pyBool, warn } from "../../pyrt/index.ts";
import { cosGet } from "../cos/index.ts";
import type { CosDict, CosNode } from "../cos/cos.ts";
import { FontObject } from "../models/text/font_object.ts";
import { TextDocument } from "../models/text/text_document.ts";
import type { ListChunk } from "../binary/chunk.ts";

// `logging.getLogger(__name__)`: this module logs nothing today, so only the
// warning path is wired to pyrt `warn`.
export const logger = {
  debug() {},
  info() {},
  warning: (m: string) => warn(m),
};

// ---------------------------------------------------------------------------
// Font parsing
// ---------------------------------------------------------------------------

/**
 * Parse font entries from COS data.
 *
 * Reads the font array at `cos_data["0"]["1"]["0"]`.  Each font entry
 * is a Map with structure::
 *
 *     entry["0"]["0"]["0"]  -\> PostScript name (str)
 *     entry["0"]["0"]["5"]  -\> version string (optional)
 *     entry["0"]["99"]      -\> "CoolTypeFont" marker
 *
 * @param cosData - The parsed COS Map from a `btdk` chunk.
 * @returns Array of {@link FontObject} instances in the same order as the COS
 *   array (the index is referenced by character styles).
 */
export function parseFonts(cosData: CosDict): FontObject[] {
  const fontArray = cosGet(cosData, "0", "1", "0");
  if (!pyBool(fontArray) || !Array.isArray(fontArray)) {
    return [];
  }

  const fonts: FontObject[] = [];
  for (const entry of fontArray) {
    const fontData = cosGet(entry, "0", "0");
    if (fontData == null || !(fontData instanceof Map)) {
      continue;
    }
    const fontEntry = cosGet(entry, "0");
    const font = new FontObject({
      _fontData: fontData,
      _fontEntry: fontEntry instanceof Map ? fontEntry : null,
    });
    fonts.push(font);
  }

  return fonts;
}

// ---------------------------------------------------------------------------
// Text document sub-Map extraction
// ---------------------------------------------------------------------------

/**
 * Return the first character style Map from a text document entry.
 *
 * Path: `doc["0"]["6"]["0"][0]["0"]["0"]["6"]`
 */
export function _getFirstCharStyle(doc: CosNode): CosDict | null {
  const result = cosGet(doc, "0", "6", "0", 0, "0", "0", "6");
  if (result instanceof Map) {
    return result;
  }
  return null;
}

/**
 * Return the first paragraph style Map from a text document entry.
 *
 * Path: `doc["0"]["5"]["0"][0]["0"]["0"]["5"]`
 */
export function _getFirstParaStyle(doc: CosNode): CosDict | null {
  const result = cosGet(doc, "0", "5", "0", 0, "0", "0", "5");
  if (result instanceof Map) {
    return result;
  }
  return null;
}

/**
 * Parse text documents from COS data.
 *
 * Reads the document array at `cos_data["1"]["1"]`.  Each entry's COS
 * sub-Maps are passed directly to {@link TextDocument} which lazily
 * extracts values via CosField descriptors.
 *
 * @param cosData - The parsed COS Map from a `btdk` chunk.
 * @param fonts - The array of {@link FontObject} parsed by
 *   {@link parseFonts} (font indices reference this array).
 * @param btdkBody - The btdk chunk body for COS write-back.
 * @returns Array of {@link TextDocument} instances (one per keyframe).
 */
export function parseTextDocuments(
  cosData: CosDict,
  fonts: FontObject[],
  btdkBody: ListChunk,
): TextDocument[] {
  const docArray = cosGet(cosData, "1", "1");
  if (!pyBool(docArray) || !Array.isArray(docArray)) {
    return [];
  }

  const documents: TextDocument[] = [];

  for (const docEntry of docArray) {
    const charStyle = _getFirstCharStyle(docEntry);
    const paraStyle = _getFirstParaStyle(docEntry);

    documents.push(
      TextDocument._fromBinary({
        _charStyle: charStyle,
        _paraStyle: paraStyle,
        _doc: docEntry,
        _fonts: fonts,
        _cosData: cosData,
        _btdkBody: btdkBody,
      }),
    );
  }

  // Frame-level writes (box meta, orientation) live in the shared
  // cos_data and change composition for every keyframe's document,
  // so each wrapper knows its siblings to dirty-mark them together.
  for (const document of documents) {
    document._siblings = documents;
  }

  return documents;
}

// ---------------------------------------------------------------------------
// High-level entry point
// ---------------------------------------------------------------------------

/**
 * Parse a btdk COS Map into text documents and fonts.
 *
 * This is the main entry point called by
 * {@link py_aep.parsers.property.parse_text_document | parse_text_document}.
 *
 * @param cosData - The parsed COS Map from a `btdk` chunk (the return
 *   value of {@link CosParser.parse | CosParser.parse}).
 * @param btdkBody - The btdk chunk body for COS write-back.
 * @returns A tuple `(text_documents, fonts)` where `textDocuments` is a
 *   array of {@link TextDocument} (one per keyframe) and `fonts` is
 *   the array of {@link FontObject} referenced by the documents.
 */
export function parseBtdkCos(
  cosData: CosDict,
  btdkBody: ListChunk,
): [TextDocument[], FontObject[]] {
  const fonts = parseFonts(cosData);
  const documents = parseTextDocuments(cosData, fonts, btdkBody);
  return [documents, fonts];
}
