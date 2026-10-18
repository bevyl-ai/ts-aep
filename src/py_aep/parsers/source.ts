import { findByListTypeOrNull, findByType, findByTypeOrNull } from "../binary/utils.ts";
import { FileSource } from "../models/sources/file.ts";
import { PlaceholderSource } from "../models/sources/placeholder.ts";
import { SolidSource } from "../models/sources/solid.ts";
import { getattr, hasattr, pyBool } from "../../pyrt/index.ts";
import type { ListChunk } from "../binary/chunk.ts";

/**
 * Parse a `LIST:Pin` chunk into a footage source.
 *
 * @param pinChunk - A `LIST:Pin` chunk containing sspc + opti sub-chunks.
 */
export function parseSource(
  pinChunk: ListChunk,
): FileSource | SolidSource | PlaceholderSource {
  const pinChildChunks = pinChunk.chunks;
  const sspcChunk = findByType(pinChildChunks, "sspc");
  const optiChunk = findByType(pinChildChunks, "opti");

  const clrs = findByListTypeOrNull(pinChildChunks, "CLRS");
  const linl = clrs === null ? null : findByTypeOrNull(clrs.chunks, "linl");

  const assetType = getattr(optiChunk, "assetType", "");

  if (!pyBool(assetType) && hasattr(optiChunk, "placeholderName")) {
    return new PlaceholderSource({
      _sspc: sspcChunk,
      _opti: optiChunk,
      _clrs: clrs,
      _linl: linl,
    });
  }
  if (assetType.startsWith("Soli")) {
    return new SolidSource({ _sspc: sspcChunk, _opti: optiChunk, _clrs: clrs, _linl: linl });
  }
  return new FileSource({
    _pin: pinChunk,
    _sspc: sspcChunk,
    _opti: optiChunk,
    _linl: linl,
    _clrs: clrs,
  });
}
