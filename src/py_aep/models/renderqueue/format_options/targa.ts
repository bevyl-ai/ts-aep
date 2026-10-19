import { descriptor } from "../../../../pyrt/index.ts";
import { ChunkField } from "../../descriptors.ts";
import { validateOneOf } from "../../validators.ts";
import { FormatOptionsBase } from "./base.ts";
import type { RoptChunk } from "../../../binary/render_chunks.ts";

/**
 * Targa (TGA) format-specific render options.
 *
 * These settings correspond to the Targa Options dialog in After Effects,
 * accessible when the output format is set to Targa Sequence.
 *
 * @example
 * ```ts
 * import { parse, TargaFormatOptions } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const om = app.project.renderQueue.items[0].outputModules[0];
 * if (om.formatOptions instanceof TargaFormatOptions) {
 *   console.log(om.formatOptions.bitsPerPixel);
 * }
 * ```
 */
export class TargaFormatOptions extends FormatOptionsBase {
  declare _body: RoptChunk;

  constructor(kw: { _body: RoptChunk }) {
    super();
    const { _body } = kw;
    this._body = _body;
  }

  /**
   * Color depth in bits per pixel (24 or 32). Read / Write.
   *
   * Not coupled to the module's `Channels` setting in the binary: AE
   * only rewrites this byte when the Targa Options dialog is visited,
   * so AE-saved files hold RGB with 32 bpp and RGB+Alpha with 24 bpp.
   * This value, not the module's `Depth`, decides the rendered file: AE
   * 2026 renders a 32-bpp TGA with 8 alpha bits for an RGB module whose
   * value is 32, and a 24-bpp TGA once it is 24.
   */
  declare bitsPerPixel: number;

  /** Whether RLE compression is enabled. Read / Write. */
  declare rleCompression: boolean;

  static {
    descriptor(this, "bitsPerPixel", new ChunkField("_body", "bitsPerPixel", { validate: validateOneOf([24, 32]) }));
    descriptor(this, "rleCompression", ChunkField.bool("_body", "rleCompression"));
  }
}
