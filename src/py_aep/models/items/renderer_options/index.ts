/**
 * Per-renderer 3D render options.
 *
 * One wrapper class per renderer, selected from the `prda` chunk variant dispatch.
 */

import {
  AdvancedPrdaChunk,
  Cinema4DPrdaChunk,
  ClassicPrdaChunk,
  RayTracedPrdaChunk,
} from "../../../binary/misc_chunks.ts";
import { AdvancedRendererOptions } from "./advanced.ts";
import { Cinema4DRendererOptions } from "./cinema_4d.ts";
import { ClassicRendererOptions } from "./classic.ts";
import { RayTracedRendererOptions } from "./ray_traced.ts";
import { RendererOptionsBase } from "./renderer_options_base.ts";
import type { Chunk } from "../../../binary/chunk.ts";
import type { CompItem } from "../composition.ts";

export type RendererOptions =
  | AdvancedRendererOptions
  | Cinema4DRendererOptions
  | ClassicRendererOptions
  | RayTracedRendererOptions
  // Unrecognised prda variants fall back to the empty base wrapper.
  | RendererOptionsBase;

// NOTE(port): Python builds _WRAPPERS at import time too, so the evaluation-time reads of the imported classes match.
const _WRAPPERS: Map<Function, typeof RendererOptionsBase> = new Map<Function, typeof RendererOptionsBase>([
  [ClassicPrdaChunk, ClassicRendererOptions],
  [AdvancedPrdaChunk, AdvancedRendererOptions],
  [Cinema4DPrdaChunk, Cinema4DRendererOptions],
  [RayTracedPrdaChunk, RayTracedRendererOptions],
]);

/**
 * Wrapper for a comp's `prda` chunk.
 *
 * Falls back to an empty `RendererOptionsBase` for an unrecognised chunk,
 * so a future renderer reads as "no options exposed" rather than raising.
 */
export function rendererOptionsFor(body: Chunk, comp: CompItem): RendererOptions {
  const wrapperCls = _WRAPPERS.get(body.constructor) ?? RendererOptionsBase;
  return new wrapperCls({ body, comp });
}

export {
  AdvancedRendererOptions,
  Cinema4DRendererOptions,
  ClassicRendererOptions,
  RayTracedRendererOptions,
  RendererOptionsBase,
};
