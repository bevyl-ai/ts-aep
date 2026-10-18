/** Parsers for format-specific render options (Ropt chunk). */

import type { Chunk } from "../binary/chunk.ts";
import { OpenExrRoptChunk, PngRoptChunk } from "../binary/render_chunks.ts";
import { findByTypeOrNull } from "../binary/utils.ts";
import { CineonFormatOptions, JpegFormatOptions, OpenExrFormatOptions, PngFormatOptions, TargaFormatOptions, TiffFormatOptions, XmlFormatOptions } from "../models/renderqueue/format_options/index.ts";

export type FormatOptions =
  | CineonFormatOptions
  | JpegFormatOptions
  | OpenExrFormatOptions
  | PngFormatOptions
  | TargaFormatOptions
  | TiffFormatOptions
  | XmlFormatOptions;

// Format codes that use XML-based PremiereData options
export const _XML_FORMAT_CODES: ReadonlySet<string> = new Set([".AVI", "H264", "Mp3 ", "MooV", "wao_"]);

/**
 * Parse format-specific options from the Ropt chunk, if present.
 *
 * @param chunks - List of chunks belonging to an output module.
 * @returns A format-specific options object, or `null` when the Ropt chunk is absent or the format
 *   is not yet supported.
 */
export function parseFormatOptions(chunks: Chunk[]): FormatOptions | null {
  const roptChunk = findByTypeOrNull(chunks, "Ropt");
  if (roptChunk === null) return null;

  const formatCode = roptChunk.formatCode;

  if (formatCode === "sDPX") {
    return new CineonFormatOptions({ _body: roptChunk });
  }
  if (formatCode === "JPEG") {
    return new JpegFormatOptions({ _body: roptChunk });
  }
  if (formatCode === "TPIC") {
    return new TargaFormatOptions({ _body: roptChunk });
  }
  if (formatCode === "TIF ") {
    return new TiffFormatOptions({ _body: roptChunk });
  }
  if (formatCode === "oEXR" && roptChunk instanceof OpenExrRoptChunk) {
    return new OpenExrFormatOptions({ _body: roptChunk });
  }
  if (formatCode === "png!" && roptChunk instanceof PngRoptChunk) {
    const hdr10Utf8 = findByTypeOrNull(chunks, "Utf8");
    return new PngFormatOptions({
      _body: roptChunk,
      _hdr10Utf8: hdr10Utf8,
    });
  }
  if (_XML_FORMAT_CODES.has(formatCode)) {
    return new XmlFormatOptions({ _body: roptChunk });
  }

  return null;
}
