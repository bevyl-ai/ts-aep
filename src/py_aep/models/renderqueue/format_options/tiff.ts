// `from __future__ import annotations` and the `typing` imports are dropped:
// annotations are TypeScript types only.
import { descriptor } from "../../../../pyrt/index.ts";
import { ChunkField } from "../../descriptors.ts";
import { FormatOptionsBase } from "./base.ts";
import type { RoptChunk } from "../../../binary/render_chunks.ts";

/**
 * TIFF format-specific render options.
 *
 * These settings correspond to the TIFF Options dialog in After Effects,
 * accessible when the output format is set to TIFF Sequence.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 * import { TiffFormatOptions } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const om = app.project.renderQueue.items[0].outputModules[0];
 * if (om.formatOptions instanceof TiffFormatOptions) {
 *   console.log(om.formatOptions.lzwCompression);
 * }
 * ```
 */
export class TiffFormatOptions extends FormatOptionsBase {
  declare _body: RoptChunk;

  constructor(kw: { _body: RoptChunk }) {
    super();
    const { _body } = kw;
    this._body = _body;
  }

  /** Whether LZW compression is enabled. Read / Write. */
  declare lzwCompression: boolean;

  /** Whether IBM PC byte order (little-endian) is used. Read / Write. */
  declare ibmPcByteOrder: boolean;
}

descriptor(TiffFormatOptions, "lzwCompression", ChunkField.bool("_body", "lzwCompression"));

descriptor(TiffFormatOptions, "ibmPcByteOrder", ChunkField.bool("_body", "ibmPcByteOrder"));
