/**
 * Enumerate the layers of an Illustrator/PDF file (PDF Optional Content Groups).
 *
 * After Effects imports a layered `.ai`/`.pdf` as a composition with one footage
 * layer per Illustrator layer. The layers map to PDF Optional Content Groups
 * (OCGs); the default configuration's `/D` `/Order` lists them top layer first,
 * so its reverse is the document order (bottom layer first). Illustrator writes
 * `/OCGs` as the exact reverse of `/Order`, but other PDF writers need not.
 * Only PDF-compatible files expose OCGs;
 * Illustrator files saved without PDF compatibility store their artwork in a
 * compressed PGF block and are not supported.
 */

import * as zlib from "../../pyrt/zlib.ts";
import {
  BytesIO,
  Path,
  ValueError,
  getOrThrow,
  b,
  bytes_,
  bytesEq,
  int,
  type PathLike,
} from "../../pyrt/index.ts";
import { CosParser, IndirectObject, IndirectReference, decodePdfTextString } from "../cos/index.ts";
import { type CosDict, type CosNode, type CosString } from "../cos/cos.ts";
import { is, pyStr } from "../cos/kinds.ts";

/** Raised when a `.ai`/`.pdf` file's layers cannot be enumerated. */
export class UnsupportedAiLayersError extends ValueError {}

/** One Illustrator/PDF layer (Optional Content Group). */
export class AiLayer {
  constructor(
    /** The OCG's PDF indirect-object number. */
    readonly objectNumber: number,
    /** The layer name. */
    readonly name: string,
    /**
     * `false` when the default configuration hides the layer (the OCG is
     * listed in `/D` `/OFF`). After Effects records this in the per-layer
     * `opti` and gives the imported comp layer its video switch off.
     */
    readonly visible: boolean,
  ) {}

  *[Symbol.iterator](): Generator<number | string | boolean> {
    yield this.objectNumber;
    yield this.name;
    yield this.visible;
  }
}

// The leading `\b` skips every `endobj`: a header needs whitespace before
// the keyword anyway.
export const _OBJ_KEYWORD_RE = /\bobj\b/g;
export const _OBJ_HEADER_RE = /(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+$/;
// How far before an `obj` keyword its `N G` header may start: far longer
// than any header a PDF writer emits.
export const _OBJ_HEADER_WINDOW = 64;

/**
 * Latin-1 text with one character per byte, so regex match offsets are the
 * byte offsets of the Python `bytes` patterns (`rb"..."`).
 */
export function latin1(data: Uint8Array): string {
  return bytes_.latin1Str(data);
}

// TODO(port): Python's RecursionError (CPython limit 1000 frames) maps to V8's stack-overflow RangeError, which fires at an engine/stack-size dependent depth; PDF objects nested between the two limits parse in one runtime and are reported malformed (or not) in the other. No pyrt RecursionError exists and V8 gives no fixed depth to emulate.
export function isMalformed(exc: unknown): boolean {
  return (
    exc instanceof SyntaxError ||
    (exc instanceof RangeError && /call stack/.test(exc.message))
  );
}

/** Map each indirect object number to its byte offset (last definition wins).
 *
 * Finds each `obj` keyword and matches its header just before it: a
 * pattern led by the header's digits would be tried at every digit in the
 * file's content streams, tens of times slower on a large document.
 */
export function _objectOffsets(data: Uint8Array): Map<number, number> {
  const offsets = new Map<number, number>();
  const text = latin1(data);
  for (const keyword of text.matchAll(_OBJ_KEYWORD_RE)) {
    const end = keyword.index;
    const windowStart = Math.max(0, end - _OBJ_HEADER_WINDOW);
    // `search(data, pos, endpos)` with `\Z` at `endpos`: match within the slice.
    const header = _OBJ_HEADER_RE.exec(text.slice(windowStart, end));
    if (header != null) {
      offsets.set(int(header[1]), windowStart + header.index);
    }
  }
  return offsets;
}

/**
 * Parse the single indirect object starting at `offset`, returning its value.
 *
 * @throws {@link UnsupportedAiLayersError} If the object is malformed or truncated.
 */
export function _parseObjectAt(data: Uint8Array, offset: number): CosNode {
  const parser = new CosParser(new BytesIO(bytes_.slice(data, offset)));
  try {
    parser.lex();
    const value = parser.parseValue();
    return value instanceof IndirectObject ? value.data : value;
  } catch (exc) {
    if (!isMalformed(exc)) throw exc;
    throw Object.assign(
      new UnsupportedAiLayersError(`malformed PDF object at byte ${offset}`),
      { cause: exc },
    );
  }
}

/** Follow an indirect reference to its object; pass other values through. */
export function _resolve(value: CosNode, data: Uint8Array, offsets: Map<number, number>): CosNode {
  if (value instanceof IndirectReference) {
    const offset = offsets.get(value.objectNumber) ?? null;
    return offset == null ? null : _parseObjectAt(data, offset);
  }
  return value;
}

/** Collect the OCG object numbers a `/D` `/Order` (or `/OFF`) tree
 * references, depth first, each once.
 */
export function _orderObjectNumbers(value: CosNode, out: number[]): number[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      _orderObjectNumbers(entry, out);
    }
  } else if (value instanceof IndirectReference && !out.includes(value.objectNumber)) {
    out.push(value.objectNumber);
  }
  return out;
}

/**
 * Return one `AiLayer` per layer, in document order (bottom layer first).
 *
 * The default configuration's `/Order` decides both which groups are layers
 * and their order. Illustrator can leave the optional content groups of
 * earlier revisions of the artwork behind in `/OCGs`: one 2019-vintage file
 * lists 65 groups for the 25 layers it has, the stale 40 first. The
 * leftovers are exactly the groups `/Order` omits, and that is the set After
 * Effects imports - checked against an AE-authored project whose footage
 * layer indices only line up with the `/Order` members. After Effects stacks
 * the layers top-down in `/Order` sequence and counts each footage's layer
 * index from the bottom of that stack (AE 2026, PDFs whose `/Order` is
 * neither `/OCGs` nor its reverse). Without an `/Order`, `/OCGs` gives the
 * order.
 *
 * @param file - Path to a `.ai` or `.pdf` file.
 * @param data - The file's bytes, if the caller already read them.
 *
 * @throws UnsupportedAiLayersError If the file is not a PDF-compatible document
 *     or has no Optional Content Groups (layers).
 */
export function readAiLayerOcgs(
  file: PathLike,
  data: Uint8Array | null = null,
): AiLayer[] {
  const name = new Path(file).name;
  if (data == null) data = new Path(file).readBytes();
  if (!bytes_.startswith(data, b("%PDF"))) {
    throw new UnsupportedAiLayersError(
      `${name}: not a PDF-compatible file; layered import requires an ` +
        "Illustrator/PDF file saved with PDF compatibility.",
    );
  }
  const marker = bytes_.find(data, b("/OCProperties"));
  if (marker < 0) {
    throw new UnsupportedAiLayersError(
      `${name}: no layers (the file has no PDF Optional Content Groups).`,
    );
  }
  const offsets = _objectOffsets(data);
  const layers: AiLayer[] = [];
  // The COS lexer reports malformed or truncated objects as SyntaxError (and
  // a pathologically nested one as RecursionError); either means the layers
  // cannot be read, which callers handle as this module's own error.
  try {
    const parser = new CosParser(
      new BytesIO(bytes_.slice(data, marker + b("/OCProperties").length)),
    );
    parser.lex();
    const ocProperties = _resolve(parser.parseValue(), data, offsets);
    if (!(ocProperties instanceof Map)) {
      throw new UnsupportedAiLayersError(`${name}: unreadable /OCProperties.`);
    }
    const configRef = _resolve(ocProperties.get("D") ?? null, data, offsets);
    const config: CosDict = configRef instanceof Map ? configRef : new Map();
    const order = _orderObjectNumbers(
      _resolve(config.get("Order") ?? null, data, offsets),
      [],
    );
    const hidden = new Set(
      _orderObjectNumbers(_resolve(config.get("OFF") ?? null, data, offsets), []),
    );
    const ocgs = _resolve(ocProperties.get("OCGs") ?? null, data, offsets);
    const listed = new Map<number, IndirectReference>();
    for (const ref of Array.isArray(ocgs) ? ocgs : []) {
      if (ref instanceof IndirectReference) listed.set(ref.objectNumber, ref);
    }
    const refs: IndirectReference[] = order.length > 0
      ? [...order]
          .reverse()
          .filter((n) => listed.has(n))
          .map((n) => getOrThrow(listed, n))
      : [...listed.values()];
    for (const ref of refs) {
      const ocg = _resolve(ref, data, offsets);
      if (!(ocg instanceof Map)) continue;
      const layerName = ocg.get("Name");
      if (isStrOrBytes(layerName)) {
        layers.push(
          new AiLayer(
            ref.objectNumber,
            decodePdfTextString(layerName),
            !hidden.has(ref.objectNumber),
          ),
        );
      }
    }
  } catch (exc) {
    if (!isMalformed(exc)) throw exc;
    throw Object.assign(
      new UnsupportedAiLayersError(`${name}: malformed PDF objects.`),
      { cause: exc },
    );
  }
  if (layers.length === 0) {
    throw new UnsupportedAiLayersError(`${name}: no named layers found.`);
  }
  return layers;
}

/** `isinstance(x, (str, bytes))`. A `CosString` is a `str` subclass in Python,
 * so it is a `String` object here, not a primitive.
 */
export function isStrOrBytes(x: CosNode | undefined): x is string | CosString | Uint8Array {
  return is(pyStr, x) || x instanceof Uint8Array;
}

/**
 * Return the Illustrator/PDF layer names in document order.
 *
 * @param file - Path to a `.ai` or `.pdf` file.
 * @param data - The file's bytes, if the caller already read them.
 *
 * @returns Layer names in document (OCG) order, bottom layer first.
 *
 * @throws UnsupportedAiLayersError If the file is not a PDF-compatible
 *     document or has no Optional Content Groups (layers).
 */
export function readAiLayers(
  file: PathLike,
  data: Uint8Array | null = null,
): string[] {
  return readAiLayerOcgs(file, data).map((layer) => layer.name);
}

export const _STREAM_RE = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

export function inflateOrNull(body: string): Uint8Array | null {
  try {
    return zlib.decompress(bytes_.latin1Bytes(body));
  } catch (e) {
    if (e instanceof zlib.error) return null;
    throw e;
  }
}

/** Return the embedded ICC profile body from a PDF-compatible file.
 *
 * Inflates each deflate stream and returns the first one that is an ICC
 * profile (`acsp` signature at offset 36). `null` when the file is not
 * PDF-compatible or has no embedded profile.
 */
export function _findAiIcc(file: PathLike, data: Uint8Array | null = null): Uint8Array | null {
  if (data == null) data = new Path(file).readBytes();
  if (!bytes_.startswith(data, b("%PDF"))) return null;
  for (const match of latin1(data).matchAll(_STREAM_RE)) {
    const body = match[1];
    if (body.length > 8_000_000) continue;
    const profile = inflateOrNull(body);
    if (profile == null) continue;
    if (profile.length >= 132 && bytesEq(bytes_.slice(profile, 36, 40), b("acsp"))) {
      return profile;
    }
  }
  return null;
}
