// `from __future__ import annotations` and the `typing` imports are dropped:
// annotations are TypeScript types only.
import { descriptor } from "../../../../pyrt/index.ts";
import { JpegFormatType } from "../../../enums/index.ts";
import { ChunkField } from "../../descriptors.ts";
import { _validate_number, validate_one_of } from "../../validators.ts";
import { FormatOptionsBase } from "./base.ts";
import type { RoptChunk } from "../../../binary/render_chunks.ts";

/**
 * JPEG format-specific render options.
 *
 * These settings correspond to the JPEG Options dialog in After Effects,
 * accessible when the output format is set to JPEG Sequence.
 *
 * @example
 * ```ts
 * import { JpegFormatOptions, parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const om = app.project.renderQueue.items[0].outputModules[0];
 * if (om.formatOptions instanceof JpegFormatOptions) {
 *   console.log(om.formatOptions.quality);
 * }
 * ```
 */
export class JpegFormatOptions extends FormatOptionsBase {
  declare _body: RoptChunk;

  constructor(kw: { _body: RoptChunk }) {
    super();
    const { _body } = kw;
    this._body = _body;
  }

  /**
   * JPEG quality level, from 0 (Smaller File) to 10 (Bigger File). Read / Write.
   */
  declare quality: number;

  /**
   * JPEG format option type: Baseline (Standard), Baseline Optimized,
   * or Progressive. An out-of-enum stored value reads back as a raw
   * `int` (the binary is trusted). Read / Write.
   */
  declare formatType: JpegFormatType | number;

  /**
   * Number of progressive scans (3, 4, or 5). Only relevant when
   * `format_type` is `JpegFormatType.PROGRESSIVE`. Read / Write.
   */
  declare scans: number;
}

descriptor(
  JpegFormatOptions,
  "quality",
  new ChunkField("_body", "quality", {
    validate: _validate_number({ min: 0, max: 10, integer: true }),
  }),
);

descriptor(
  JpegFormatOptions,
  "formatType",
  ChunkField.enum(JpegFormatType, "_body", "format_type", {
    allow_out_of_enum_values: true,
  }),
);

descriptor(
  JpegFormatOptions,
  "scans",
  new ChunkField("_body", "scans", {
    transform: (x: number) => x + 2,
    reverse: (x: number) => x - 2,
    validate: validate_one_of([3, 4, 5]),
  }),
);
