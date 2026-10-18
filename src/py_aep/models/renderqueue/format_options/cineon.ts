// `from __future__ import annotations` and the `typing` imports are dropped:
// annotations are TypeScript types only.
import { descriptor } from "../../../../pyrt/index.ts";
import { CineonFileFormat } from "../../../enums/index.ts";
import { ChunkField } from "../../descriptors.ts";
import { _validateNumber, validateOneOf, validateU2 } from "../../validators.ts";
import { FormatOptionsBase } from "./base.ts";
import type { RoptChunk } from "../../../binary/render_chunks.ts";

/**
 * Cineon/DPX format-specific render options.
 *
 * These settings correspond to the Cineon Settings dialog in After Effects,
 * accessible when the output format is set to Cineon Sequence or DPX
 * Sequence.
 *
 * @example
 * ```ts
 * import { CineonFormatOptions, parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const om = app.project.renderQueue.items[0].outputModules[0];
 * if (om.formatOptions instanceof CineonFormatOptions) {
 *   console.log(om.formatOptions.fileFormat);
 * }
 * ```
 */
export class CineonFormatOptions extends FormatOptionsBase {
  declare _body: RoptChunk;

  constructor(kw: { _body: RoptChunk }) {
    super();
    const { _body } = kw;
    this._body = _body;
  }

  /**
   * The 10-bit black point value (0-1023). Defines the code value that
   * maps to the black point on a logarithmic scale. Read / Write.
   */
  declare tenBitBlackPoint: number;

  /**
   * The 10-bit white point value (0-1023). Defines the code value that
   * maps to the white point on a logarithmic scale. Read / Write.
   */
  declare tenBitWhitePoint: number;

  /**
   * The converted black point value, normalized to the 0.0-1.0 range.
   * This is the linear-light equivalent of the 10-bit black point. Read / Write.
   */
  declare convertedBlackPoint: number;

  /**
   * The converted white point value, normalized to the 0.0-1.0 range.
   * This is the linear-light equivalent of the 10-bit white point. Read / Write.
   */
  declare convertedWhitePoint: number;

  /** The gamma value applied during the Cineon/DPX conversion. Read / Write. */
  declare currentGamma: number;

  /** The highlight expansion value. Read / Write. */
  declare highlightExpansion: number;

  /** Whether logarithmic conversion is enabled. Read / Write. */
  declare logarithmicConversion: boolean;

  /**
   * The file format for the Cineon output. See {@link CineonFileFormat} for
   * possible values. An out-of-enum stored value reads back as a raw
   * `number` (the binary is trusted). Read / Write.
   */
  declare fileFormat: CineonFileFormat | number;

  /**
   * The bit depth per channel (8, 10, 12, or 16). Read / Write.
   *
   * Only meaningful when `fileFormat` is `CineonFileFormat.DPX`. For
   * FIDO/Cineon 4.5 the output is always 10-bit and AE hides the Bit
   * Depth dropdown; the stored byte is inert and keeps whatever the last
   * DPX selection was (AE-observed), so reads may return a stale value.
   */
  declare bitDepth: number;
}

descriptor(
  CineonFormatOptions,
  "tenBitBlackPoint",
  new ChunkField("_body", "tenBitBlackPoint", {
    validate: _validateNumber({ min: 0, max: 1023, integer: true }),
  }),
);

descriptor(
  CineonFormatOptions,
  "tenBitWhitePoint",
  new ChunkField("_body", "tenBitWhitePoint", {
    validate: _validateNumber({ min: 0, max: 1023, integer: true }),
  }),
);

descriptor(
  CineonFormatOptions,
  "convertedBlackPoint",
  new ChunkField("_body", "convertedBlackPoint", {
    validate: _validateNumber(),
  }),
);

descriptor(
  CineonFormatOptions,
  "convertedWhitePoint",
  new ChunkField("_body", "convertedWhitePoint", {
    validate: _validateNumber(),
  }),
);

descriptor(
  CineonFormatOptions,
  "currentGamma",
  new ChunkField("_body", "currentGamma", {
    validate: _validateNumber(),
  }),
);

descriptor(
  CineonFormatOptions,
  "highlightExpansion",
  // Backed by a u2 field: an out-of-range value overflows `struct`
  // and crashes save() mid-write, leaving a partial .aep on disk.
  new ChunkField("_body", "highlightExpansion", { validate: validateU2 }),
);

descriptor(
  CineonFormatOptions,
  "logarithmicConversion",
  ChunkField.bool("_body", "logarithmicConversion"),
);

descriptor(
  CineonFormatOptions,
  "fileFormat",
  ChunkField.enum(CineonFileFormat, "_body", "fileFormat", {
    allowOutOfEnumValues: true,
  }),
);

descriptor(
  CineonFormatOptions,
  "bitDepth",
  new ChunkField("_body", "bitDepth", {
    validate: validateOneOf([8, 10, 12, 16]),
  }),
);
