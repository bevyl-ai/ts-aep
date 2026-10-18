/** Classic 3D (`ADBE Escher`) render options. */

import { ShadowMapResolution } from "../../../enums/index.ts";
import { ChunkField } from "../../descriptors.ts";
import { RendererOptionsBase } from "./renderer_options_base.ts";
import { descriptor } from "../../../../pyrt/index.ts";
import type { ClassicPrdaChunk } from "../../../binary/misc_chunks.ts";

/** Options for the Classic 3D renderer. */
export class ClassicRendererOptions extends RendererOptionsBase {
  declare _body: ClassicPrdaChunk;

  static _SPEC: Map<string, [string, typeof ShadowMapResolution]> = new Map<string, [string, typeof ShadowMapResolution]>([
    ["Shadow Map Resolution", ["shadowMapResolution", ShadowMapResolution]],
  ]);

  /**
   * Resolution of the shadow map, as set in the Classic 3D Options dialog.
   * Read / Write.
   */
  declare shadowMapResolution: ShadowMapResolution;
}

// Descriptors assigned in the class body: `declare` above, installed here.

/**
 * Resolution of the shadow map, as set in the Classic 3D Options dialog.
 * Read / Write.
 */
descriptor(
  ClassicRendererOptions,
  "shadowMapResolution",
  ChunkField.enum(ShadowMapResolution, "_body", "shadow_map_resolution"),
);
