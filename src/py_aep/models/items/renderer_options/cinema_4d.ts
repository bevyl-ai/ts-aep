/** Cinema 4D (`ADBE Ernst`) render options. */

import { descriptor } from "../../../../pyrt/index.ts";
import { ChunkField } from "../../descriptors.ts";
import { validateCinema4dQuality } from "../../validators.ts";
import { RendererOptionsBase } from "./renderer_options_base.ts";
import type { Cinema4DPrdaChunk } from "../../../binary/misc_chunks.ts";
import type { SettingsSpec } from "../../renderqueue/settings.ts";

/** Options for the Cinema 4D renderer. */
export class Cinema4DRendererOptions extends RendererOptionsBase {
  declare _body: Cinema4DPrdaChunk;

  static _SPEC: SettingsSpec = new Map([["Quality", ["quality", null]]]);

  /** Renderer quality, `1` to `99`. Read / Write. */
  declare quality: number;

  static {
    descriptor(this, "quality", new ChunkField("_body", "quality", { validate: validateCinema4dQuality }));
  }
}
